//! Trusted client verbs for the acceptance contract.
//!
//! These are the ONLY way an authoritative requirement or a trusted coverage binding comes to exist.
//! They are reachable only by an authenticated broker client (OS peer credentials, like every other
//! verb); the model has no verb, and its tool (see `tool`) is a different code path with a fixed,
//! lower provenance. Ownership is checked: a client can only touch runs it owns and projects it may use.

use super::contract::Scope;
use super::store::{self, Anchor, Refusal};
use super::{contract::State, evaluate};
use crate::server::Broker;
use crate::verification::evidence;
use serde_json::{json, Value};

pub type CmdResult = Result<Value, (&'static str, String)>;

fn refuse(r: Refusal) -> (&'static str, String) {
    let msg = match &r {
        Refusal::Unavailable(m) => m.clone(),
        other => other.code().to_owned(),
    };
    (r.code(), msg)
}

fn s<'a>(p: &'a Value, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str).filter(|v| !v.is_empty())
}

/// What a verb targets: one owned run's task, or a project the client may use.
enum Target {
    Task { run_id: String, anchor: Anchor },
    Project { anchor: Anchor },
}

impl Target {
    fn scope(&self) -> Scope {
        match self {
            Self::Task { .. } => Scope::Task,
            Self::Project { .. } => Scope::Project,
        }
    }
    fn anchor(&self) -> &Anchor {
        match self {
            Self::Task { anchor, .. } | Self::Project { anchor } => anchor,
        }
    }
}

fn target(b: &Broker, client: &str, p: &Value) -> Result<Target, (&'static str, String)> {
    match (s(p, "runId"), s(p, "projectId")) {
        (Some(_), Some(_)) | (None, None) => Err((
            "bad-request",
            "name exactly one of runId (this task) or projectId (the project's standing policy)"
                .into(),
        )),
        (Some(run_id), None) => {
            // same answer for "absent" and "someone else's": no existence leak
            let rec = b
                .store
                .load(run_id)
                .filter(|r| r.run.client_id == client)
                .ok_or(("not-found", "no such run".to_owned()))?;
            let anchor = store::anchor_for_run(&b.store, &rec.run.run_id).ok_or((
                "bad-request",
                "this run belongs to no project; it has no task contract".to_owned(),
            ))?;
            Ok(Target::Task {
                run_id: run_id.to_owned(),
                anchor,
            })
        }
        (None, Some(project)) => {
            if !crate::inspect::code_sources_for(&b.cfg, client)
                .iter()
                .any(|w| w == project)
            {
                return Err(("not-found", "no such project".into()));
            }
            Ok(Target::Project {
                anchor: Anchor {
                    project_id: project.to_owned(),
                    anchor: "project".into(),
                    root_run_id: String::new(),
                    source_request_digest: String::new(),
                },
            })
        }
    }
}

pub fn add(b: &Broker, client: &str, p: &Value) -> CmdResult {
    let t = target(b, client, p)?;
    let description =
        s(p, "description").ok_or(("bad-request", "description is required".to_owned()))?;
    let out = store::add_trusted(
        &b.cfg.state_dir,
        t.scope(),
        t.anchor(),
        client,
        description,
        s(p, "supersedes"),
    )
    .map_err(refuse)?;
    if let Target::Task { run_id, anchor } = &t {
        store::bind_run(&b.cfg.state_dir, anchor, run_id); // informational: which runs worked on it
    }
    Ok(json!({ "requirementId": out.id, "duplicate": out.duplicate }))
}

pub fn withdraw(b: &Broker, client: &str, p: &Value) -> CmdResult {
    let t = target(b, client, p)?;
    let id =
        s(p, "requirementId").ok_or(("bad-request", "requirementId is required".to_owned()))?;
    store::withdraw_trusted(&b.cfg.state_dir, t.scope(), t.anchor(), client, id).map_err(refuse)?;
    Ok(json!({ "withdrawn": id }))
}

pub fn bind(b: &Broker, client: &str, p: &Value) -> CmdResult {
    let t = target(b, client, p)?;
    let id =
        s(p, "requirementId").ok_or(("bad-request", "requirementId is required".to_owned()))?;
    let c = p
        .get("check")
        .ok_or(("bad-request", "check is required".to_owned()))?;
    let args = json!({
        "program": c.get("program").cloned().unwrap_or(Value::Null),
        "args": c.get("args").cloned().unwrap_or(json!([])),
        "cwd": c.get("cwd").cloned().unwrap_or(Value::Null),
    });
    // a binding names a check the Core can actually recognize; anything else could never be evidence
    if !matches!(
        evidence::classify_command(&args),
        evidence::Recognition::Recognized { .. }
    ) {
        return Err((
            "check-not-recognized",
            "that command is not a recognized check (for example `node --test <file>`, `cargo test <name>`, `npm test`)".into(),
        ));
    }
    let digest = evidence::check_digest(&args).ok_or((
        "bad-request",
        "the check could not be identified".to_owned(),
    ))?;
    let label = s(p, "name").map(str::to_owned).unwrap_or_else(|| {
        let words: Vec<&str> = std::iter::once(args["program"].as_str().unwrap_or(""))
            .chain(
                args["args"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str),
            )
            .collect();
        words.join(" ")
    });
    let link = store::bind_trusted(
        &b.cfg.state_dir,
        t.scope(),
        t.anchor(),
        client,
        id,
        &digest,
        &label,
    )
    .map_err(refuse)?;
    Ok(json!({ "linkId": link, "checkDigest": digest }))
}

/// The contract's full history plus the evaluation against the run's evidence.
pub fn get(b: &Broker, client: &str, p: &Value) -> CmdResult {
    let run_id = s(p, "runId").ok_or(("bad-request", "runId is required".to_owned()))?;
    let rec = b
        .store
        .load(run_id)
        .filter(|r| r.run.client_id == client)
        .ok_or(("not-found", "no such run".to_owned()))?;
    let anchor = store::anchor_for_run(&b.store, run_id);
    let project = rec.run.workspace_id.clone().unwrap_or_default();
    let summary = evaluate::evaluate(&b.cfg.state_dir, &project, anchor.as_ref(), run_id);
    let history = anchor
        .as_ref()
        .and_then(|a| store::load(&b.cfg.state_dir, &store::task_key(a)))
        .map(|c| {
            json!({
                "contractId": c.contract_id, "revision": c.revision, "intact": c.intact(), "runs": c.runs,
                "requirements": c.requirements.iter().map(|r| json!({
                    "id": r.id, "description": r.description, "origin": r.provenance.label(),
                    "revision": r.revision, "supersedes": r.supersedes,
                    "state": match &r.state { State::Active => json!("active"), State::Superseded { by } => json!({"superseded": by}) },
                })).collect::<Vec<_>>(),
            })
        });
    Ok(json!({ "acceptance": summary, "history": history }))
}
