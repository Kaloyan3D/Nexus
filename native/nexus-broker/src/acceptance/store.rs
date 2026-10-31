//! Durable acceptance journals and the only ways to change them.
//!
//! * Task identity: a contract belongs to a TASK, found from a run by following its continuation
//!   chain (`continuation_of`, `seed_from`) to the root run, or by its conversation (`thread_id`);
//!   and to a PROJECT. Both are part of the contract key, so one project's requirements can never be
//!   read by another's task. The original request is referenced by the root run's payload digest.
//! * Writes are serialized, validated, deduplicated (deterministic event ids) and made durable
//!   with one fsynced append. A write that fails changes nothing and is reported; nothing is ever
//!   promoted to a newer revision on an uncertain write because every read comes from the file.
//! * The trusted verbs call [`add_trusted`], [`supersede_trusted`] and [`bind_trusted`]; the model
//!   tool calls [`propose_model`] and [`claim_model`]. They are different functions with different
//!   fixed provenance: there is no parameter through which a caller names its own authority.

use super::contract::*;
use crate::verification::persistence;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Mutex;

static WRITE: Mutex<()> = Mutex::new(());

/// Where a run's task contract lives, and what it is bound to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub project_id: String,
    /// `thread:<id>` or `task:<root run id>`.
    pub anchor: String,
    pub root_run_id: String,
    pub source_request_digest: String,
}

fn h(parts: &[&str]) -> String {
    let mut s = Sha256::new();
    for p in parts {
        s.update(p.as_bytes());
        s.update([0]);
    }
    hex::encode(s.finalize())[..32].to_owned()
}

pub fn task_key(a: &Anchor) -> String {
    format!(
        "ac_{}",
        h(&["nexus.acceptance.task.v1", &a.project_id, &a.anchor])
    )
}

pub fn project_key(project_id: &str) -> String {
    format!("ap_{}", h(&["nexus.acceptance.project.v1", project_id]))
}

/// Resolve a run's task anchor from the broker's run records.
pub fn anchor_for_run(store: &crate::store::Store, run_id: &str) -> Option<Anchor> {
    let me = store.load(run_id)?;
    let project_id = me.run.workspace_id.clone()?;
    let mut root = me.clone();
    for _ in 0..256 {
        let next = root
            .run
            .continuation_of
            .clone()
            .or_else(|| root.run.seed_from.clone())
            .and_then(|id| store.load(&id));
        match next {
            Some(n) => root = n,
            None => break,
        }
    }
    let task_anchor = format!("task:{}", root.run.run_id);
    let anchor = match &me.run.thread_id {
        // A run recorded before conversations existed is given a conversation when the broker
        // restarts; a contract already kept under its task identity stays its contract.
        Some(t) => {
            let thread_anchor = format!("thread:{t}");
            let key_of = |anchor: &str| {
                task_key(&Anchor {
                    project_id: project_id.clone(),
                    anchor: anchor.to_owned(),
                    root_run_id: String::new(),
                    source_request_digest: String::new(),
                })
            };
            let has = |k: String| persistence::exists_suffix(store.dir(), &k, SUFFIX);
            if !has(key_of(&thread_anchor)) && has(key_of(&task_anchor)) {
                task_anchor
            } else {
                thread_anchor
            }
        }
        None => task_anchor,
    };
    Some(Anchor {
        project_id,
        anchor,
        root_run_id: root.run.run_id.clone(),
        source_request_digest: root.payload_digest.clone(),
    })
}

/// Read and fold a journal. A missing journal is `None`.
pub fn load(state_dir: &Path, key: &str) -> Option<Contract> {
    if !persistence::exists_suffix(state_dir, key, SUFFIX) {
        return None;
    }
    let (bodies, bad) = persistence::read_bodies(state_dir, key, SUFFIX);
    let mut recs = Vec::new();
    let mut unreadable = bad;
    for b in &bodies {
        match serde_json::from_str::<Record>(b) {
            Ok(r) => recs.push(r),
            Err(_) => unreadable += 1,
        }
    }
    Some(Contract::fold(&recs, unreadable))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Invalid(&'static str),
    NotFound(&'static str),
    /// The journal could not be read completely or could not be written.
    Unavailable(String),
    /// A caller tried to change what it has no authority to change.
    NotAllowed(&'static str),
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(c) | Self::NotFound(c) | Self::NotAllowed(c) => c,
            Self::Unavailable(_) => "contract-unavailable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Added {
    pub id: String,
    /// The requirement already existed (a replay or a duplicate proposal): nothing was written.
    pub duplicate: bool,
}

fn open_event(kind: Scope, a: &Anchor, contract_id: &str) -> Event {
    Event::Opened {
        schema: SCHEMA_VERSION,
        contract_id: contract_id.to_owned(),
        scope: kind,
        project_id: a.project_id.clone(),
        anchor: a.anchor.clone(),
        source_request_digest: (kind == Scope::Task).then(|| a.source_request_digest.clone()),
        root_run_id: (kind == Scope::Task).then(|| a.root_run_id.clone()),
    }
}

/// Load (creating on first use) the journal for `key`, run `f` over the folded contract to produce
/// the new events, and append them durably. All under the process-wide write lock.
fn mutate<T>(
    state_dir: &Path,
    key: &str,
    scope: Scope,
    anchor: &Anchor,
    f: impl FnOnce(&Contract) -> Result<(Vec<Event>, T), Refusal>,
) -> Result<T, Refusal> {
    let _g = WRITE.lock().unwrap_or_else(|p| p.into_inner());
    let existing = load(state_dir, key);
    if existing.as_ref().is_some_and(|c| !c.intact()) {
        return Err(Refusal::Unavailable(
            "the contract journal is damaged; nothing is changed until it is repaired".into(),
        ));
    }
    let mut recs: Vec<Record> = Vec::new();
    let c = match existing {
        Some(c) => c,
        None => {
            recs.push(Record::new(key, open_event(scope, anchor, key)));
            Contract::fold(&recs, 0)
        }
    };
    let (events, out) = f(&c)?;
    recs.extend(events.into_iter().map(|e| Record::new(key, e)));
    let bodies: Vec<String> = recs
        .iter()
        .filter_map(|r| serde_json::to_string(r).ok())
        .collect();
    if !bodies.is_empty() {
        persistence::append_bodies(state_dir, key, SUFFIX, &bodies)
            .map_err(|e| Refusal::Unavailable(e.to_string()))?;
    }
    Ok(out)
}

fn next_id(c: &Contract, scope: Scope) -> String {
    let n = c.requirements.len() + 1;
    match scope {
        Scope::Task => format!("R{n}"),
        Scope::Project => format!("P{n}"),
    }
}

#[allow(clippy::too_many_arguments)]
fn add(
    state_dir: &Path,
    key: &str,
    scope: Scope,
    anchor: &Anchor,
    description: &str,
    provenance: Provenance,
    by: Actor,
    supersedes: Option<&str>,
) -> Result<Added, Refusal> {
    let description = clean_description(description).map_err(Refusal::Invalid)?;
    let digest = desc_digest(&description);
    mutate(state_dir, key, scope, anchor, |c| {
        if c.requirements.len() >= MAX_REQUIREMENTS {
            return Err(Refusal::Invalid("too-many-requirements"));
        }
        // an identical ACTIVE requirement of the same standing is a duplicate, not a new one
        // A proposal (non-authoritative) that restates ANY active requirement is that requirement:
        // it adds nothing and cannot change it. An authoritative restatement of an equally
        // authoritative requirement is a duplicate too.
        if let Some(r) = c.active().find(|r| {
            r.desc_digest == digest && (r.provenance == provenance || !provenance.authoritative())
        }) {
            if supersedes.is_none() {
                return Ok((
                    vec![],
                    Added {
                        id: r.id.clone(),
                        duplicate: true,
                    },
                ));
            }
        }
        // A trusted party restating, word for word, an ACTIVE criterion the model proposed makes it
        // authoritative by REPLACING it (new requirement, old one superseded): authority is never
        // inherited by carrying a model proposal forward, and there is no double obligation. Only
        // exact equality of the normalized text is used.
        let implied = if provenance.authoritative() && supersedes.is_none() {
            c.active()
                .find(|r| r.desc_digest == digest && !r.provenance.authoritative())
                .map(|r| r.id.clone())
        } else {
            None
        };
        let supersedes = supersedes.map(str::to_owned).or(implied);
        let supersedes = supersedes.as_deref();
        if let Some(old) = supersedes {
            match c.requirements.iter().find(|r| r.id == old) {
                None => return Err(Refusal::NotFound("no-such-requirement")),
                Some(r) if r.state != State::Active => {
                    return Err(Refusal::Invalid("requirement-already-superseded"))
                }
                Some(_) => {}
            }
        }
        let id = next_id(c, scope);
        let mut events = vec![Event::Requirement {
            id: id.clone(),
            description: description.clone(),
            desc_digest: digest.clone(),
            provenance,
            by: by.clone(),
            supersedes: supersedes.map(str::to_owned),
        }];
        if let Some(old) = supersedes {
            events.push(Event::Superseded {
                id: old.to_owned(),
                by_requirement: Some(id.clone()),
                by,
            });
        }
        Ok((
            events,
            Added {
                id,
                duplicate: false,
            },
        ))
    })
}

/// A requirement set by an authenticated client. `scope` and `provenance` follow from the verb:
/// a task requirement is `UserExplicit`, a project one `ProjectPolicy`.
pub fn add_trusted(
    state_dir: &Path,
    scope: Scope,
    anchor: &Anchor,
    client: &str,
    description: &str,
    supersedes: Option<&str>,
) -> Result<Added, Refusal> {
    let (key, prov) = match scope {
        Scope::Task => (task_key(anchor), Provenance::UserExplicit),
        Scope::Project => (project_key(&anchor.project_id), Provenance::ProjectPolicy),
    };
    add(
        state_dir,
        &key,
        scope,
        anchor,
        description,
        prov,
        Actor::Trusted {
            client: client.to_owned(),
        },
        supersedes,
    )
}

/// Retire a requirement without replacing it (trusted only).
pub fn withdraw_trusted(
    state_dir: &Path,
    scope: Scope,
    anchor: &Anchor,
    client: &str,
    id: &str,
) -> Result<(), Refusal> {
    let key = match scope {
        Scope::Task => task_key(anchor),
        Scope::Project => project_key(&anchor.project_id),
    };
    mutate(state_dir, &key, scope, anchor, |c| {
        match c.requirements.iter().find(|r| r.id == id) {
            None => Err(Refusal::NotFound("no-such-requirement")),
            Some(r) if r.state != State::Active => Ok((vec![], ())),
            Some(_) => Ok((
                vec![Event::Superseded {
                    id: id.to_owned(),
                    by_requirement: None,
                    by: Actor::Trusted {
                        client: client.to_owned(),
                    },
                }],
                (),
            )),
        }
    })
}

/// A trusted party declares that `check` covers requirement `id` (the acceptance test).
pub fn bind_trusted(
    state_dir: &Path,
    scope: Scope,
    anchor: &Anchor,
    client: &str,
    id: &str,
    check_digest: &str,
    label: &str,
) -> Result<String, Refusal> {
    let key = match scope {
        Scope::Task => task_key(anchor),
        Scope::Project => project_key(&anchor.project_id),
    };
    let label: String = label.chars().filter(|c| !c.is_control()).take(80).collect();
    mutate(state_dir, &key, scope, anchor, |c| {
        match c.requirements.iter().find(|r| r.id == id) {
            None => return Err(Refusal::NotFound("no-such-requirement")),
            Some(r) if r.state != State::Active => {
                return Err(Refusal::Invalid("requirement-is-superseded"))
            }
            Some(_) => {}
        }
        let link_id = format!("L{}", h(&[&key, id, "check", check_digest]));
        if c.links.iter().any(|l| l.link_id == link_id) {
            return Ok((vec![], link_id));
        }
        Ok((
            vec![Event::Link {
                link_id: link_id.clone(),
                requirement_id: id.to_owned(),
                origin: LinkOrigin::TrustedBinding {
                    by: client.to_owned(),
                },
                target: LinkTarget::Check {
                    digest: check_digest.to_owned(),
                    label,
                },
            }],
            link_id,
        ))
    })
}

/// A criterion proposed by the active model. Provenance is FIXED here: `ModelProposed`, or
/// `Assumption` when the model flagged it as one. There is no way to ask for more.
pub fn propose_model(
    state_dir: &Path,
    anchor: &Anchor,
    run_id: &str,
    call_index: u32,
    description: &str,
    assumption: bool,
) -> Result<Added, Refusal> {
    add(
        state_dir,
        &task_key(anchor),
        Scope::Task,
        anchor,
        description,
        if assumption {
            Provenance::Assumption
        } else {
            Provenance::ModelProposed
        },
        Actor::Model {
            run_id: run_id.to_owned(),
            call_index,
        },
        None,
    )
}

/// The model's claim that recorded evidence covers one of its (or any active) requirements.
/// Advisory: stored with its origin, never counted.
pub fn claim_model(
    state_dir: &Path,
    anchor: &Anchor,
    run_id: &str,
    call_index: u32,
    requirement_id: &str,
    evidence_id: &str,
) -> Result<(), Refusal> {
    let key = task_key(anchor);
    mutate(state_dir, &key, Scope::Task, anchor, |c| {
        if c.requirements.iter().all(|r| r.id != requirement_id) {
            return Err(Refusal::NotFound("no-such-requirement"));
        }
        let link_id = format!(
            "L{}",
            h(&[&key, requirement_id, "evidence", run_id, evidence_id])
        );
        if c.links.iter().any(|l| l.link_id == link_id) {
            return Ok((vec![], ()));
        }
        Ok((
            vec![Event::Link {
                link_id,
                requirement_id: requirement_id.to_owned(),
                origin: LinkOrigin::ModelAsserted {
                    run_id: run_id.to_owned(),
                    call_index,
                },
                target: LinkTarget::Evidence {
                    run_id: run_id.to_owned(),
                    evidence_id: evidence_id.to_owned(),
                },
            }],
            (),
        ))
    })
}

/// Record that a run worked on a task contract (idempotent).
pub fn bind_run(state_dir: &Path, anchor: &Anchor, run_id: &str) {
    let key = task_key(anchor);
    if load(state_dir, &key).is_none() {
        return; // never create a contract merely because a run exists
    }
    let _ = mutate(state_dir, &key, Scope::Task, anchor, |c| {
        if c.runs.iter().any(|r| r == run_id) {
            Ok((vec![], ()))
        } else {
            Ok((
                vec![Event::RunBound {
                    run_id: run_id.to_owned(),
                }],
                (),
            ))
        }
    });
}
