//! M4.5 unified permission modes: the broker's gate in front of every command.
//!
//! The run's mode (`ask` | `auto-safe` | `full`) decides whether a command waits for the person. The gate
//! sits BEFORE the existing daemon approval: whatever it lets through still goes through the daemon's
//! frozen-grant policy (filesystem scope, network scope, sandbox), so a mode never widens what a command can
//! do, it only chooses between "run" and "ask first".
//!
//! * The operation is classified by `nexus_tools::permission::classify`, which uses the daemon's own command
//!   resolver for the install network class; a shell wrapper therefore cannot turn an install into a safe
//!   command, and it cannot obtain the install network either.
//! * A request names the exact program, arguments and directory that will run and carries a digest of them with
//!   the run and request ids. A decision must repeat the request id and digest, is single use, and the command
//!   that then executes is the very `params` the digest was computed from.
//! * The decision arrives from the person's authenticated local client (the desktop app's native confirmation);
//!   the model has no tool that can call it.
//! * Downgrades take effect on the next command; upgrades need a single-use token the client obtains with
//!   `prepare_upgrade` (and shows to the person) before `set_mode` accepts them.

use crate::server::Broker;
use nexus_client::intent_client::{
    DependencyRecord, IntentRun, PendingPermission, PermissionEvent,
};
use nexus_tools::contract::ProcessArgs;
use nexus_tools::permission::{
    classify, gate, Gate, InstallPlan, OpClass, Package, PermissionMode,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long the person has to decide one request.
pub const PERMISSION_TTL_MS: u64 = 600_000;
const POLL: Duration = Duration::from_millis(150);
/// Audit trail bound (oldest entries are dropped).
const EVENTS_MAX: usize = 200;
const DEPS_MAX: usize = 200;
const UPGRADE_TOKEN_TTL: Duration = Duration::from_secs(120);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn rand_hex(n: usize) -> String {
    use std::io::Read;
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    hex::encode(b)
}

/// The mode a run is in (`ask` for display when none was set).
pub fn mode_of(r: &IntentRun) -> PermissionMode {
    PermissionMode::parse(&r.permission_mode).unwrap_or_default()
}

/// A run submitted with no permission mode (CLI, scripts, runs that predate modes): no mode gate at all; the
/// project's frozen standing grant alone decides, exactly as before modes existed. The Desktop always names a
/// mode (its default is Ask for Approval), so a person using the app never gets this.
pub fn is_grant_only(r: &IntentRun) -> bool {
    r.permission_mode.is_empty()
}

fn rank_of(r: &IntentRun) -> u8 {
    if is_grant_only(r) {
        PermissionMode::Full.rank()
    } else {
        mode_of(r).rank()
    }
}

fn event(r: &mut IntentRun, kind: &str, request_id: &str, digest: &str, detail: &str) {
    r.permission_events.push(PermissionEvent {
        at_ms: now_ms(),
        kind: kind.to_owned(),
        mode: if is_grant_only(r) {
            "grant".to_owned()
        } else {
            mode_of(r).as_str().to_owned()
        },
        request_id: request_id.to_owned(),
        digest: digest.to_owned(),
        detail: detail.chars().take(300).collect(),
    });
    if r.permission_events.len() > EVENTS_MAX {
        let drop = r.permission_events.len() - EVENTS_MAX;
        r.permission_events.drain(..drop);
    }
}

/// Set the mode a run starts in (called once, when the run is created).
pub fn init_mode(r: &mut IntentRun, mode: Option<PermissionMode>) {
    match mode {
        Some(m) => {
            r.permission_mode = m.as_str().to_owned();
            event(r, "mode-set", "", "", "run started in this mode");
        }
        None => event(
            r,
            "mode-set",
            "",
            "",
            "no mode requested: the project's standing grant alone decides",
        ),
    }
}

pub fn request_digest(run_id: &str, request_id: &str, kind: &str, args: &Value) -> String {
    let canon = json!({
        "runId": run_id, "requestId": request_id, "kind": kind,
        "program": args["program"], "args": args["args"], "cwd": args["cwd"],
    });
    hex::encode(Sha256::digest(canon.to_string().as_bytes()))
}

/// What the gate decided about one command.
#[derive(Debug)]
pub enum GateOutcome {
    /// Run it. `decision` is recorded on the activity; `install` is the plan to account for afterwards.
    Proceed {
        decision: &'static str,
        class: &'static str,
        mode: &'static str,
        install: Option<InstallPlan>,
    },
    /// Do not run it; the model gets this explicit result.
    Denied {
        code: &'static str,
        message: String,
        class: &'static str,
        mode: &'static str,
        decision: &'static str,
    },
    Cancelled,
    TimedOut,
}

fn process_args(a: &Value) -> ProcessArgs {
    ProcessArgs {
        program: a["program"].as_str().unwrap_or_default().to_owned(),
        args: a["args"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        cwd: a["cwd"].as_str().unwrap_or(".").to_owned(),
    }
}

fn kind_of(c: &OpClass) -> &'static str {
    match c {
        OpClass::Install(_) => "dependency-install",
        OpClass::Delete => "delete",
        OpClass::BulkDelete => "bulk-delete",
        OpClass::Safe => "safe",
    }
}

/// Gate one `proc_run` (`proc_args` is the exact `args` object the daemon will execute).
pub fn run_gate(
    b: &Broker,
    run_id: &str,
    flag: &AtomicBool,
    deadline: Option<Instant>,
    proc_args: &Value,
    purpose: &str,
) -> GateOutcome {
    let pa = process_args(proc_args);
    let class = classify(&pa);
    let rec = match b.store.load(run_id) {
        Some(r) => r,
        None => return GateOutcome::Cancelled,
    };
    let mode = mode_of(&rec.run);
    let label = class.label();
    if is_grant_only(&rec.run) {
        let install = match &class {
            OpClass::Install(p) => Some(p.clone()),
            _ => None,
        };
        return GateOutcome::Proceed {
            decision: "auto",
            class: label,
            mode: "grant",
            install,
        };
    }
    let install = match &class {
        OpClass::Install(p) => {
            let mut p = p.clone();
            if p.from_manifest && p.packages.is_empty() {
                // what the model last wrote to the project's manifest in this run (display only)
                p.packages = manifest_packages(run_id, &p.manager, &pa.cwd);
            }
            Some(p)
        }
        _ => None,
    };
    if gate(mode, &class) == Gate::Run {
        let decision = if mode == PermissionMode::Full && class != OpClass::Safe {
            "auto-full-access"
        } else {
            "auto"
        };
        if class != OpClass::Safe {
            b.update(run_id, |r| {
                event(
                    r,
                    "auto",
                    "",
                    "",
                    &format!("{label}: runs without asking in this mode"),
                )
            });
        }
        return GateOutcome::Proceed {
            decision,
            class: label,
            mode: mode.as_str(),
            install,
        };
    }

    // an identical installation that the person already approved in this run is covered by that approval;
    // a materially different one (other packages, options, manager, directory) is not
    let fp = install.as_ref().map(|p| install_fingerprint(&pa, p));
    if let Some(fp) = &fp {
        if covered()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
            .is_some_and(|s| s.contains(fp))
        {
            b.update(run_id, |r| {
                event(
                    r,
                    "auto",
                    "",
                    "",
                    "dependency-install: the same installation was approved earlier in this run",
                )
            });
            return GateOutcome::Proceed {
                decision: "approved-earlier",
                class: label,
                mode: mode.as_str(),
                install,
            };
        }
    }
    // ---- the person must decide ----
    let request_id = format!("pr-{}-{}", &run_id[4.min(run_id.len())..], rand_hex(6));
    let kind = kind_of(&class);
    let digest = request_digest(run_id, &request_id, kind, proc_args);
    let created = now_ms();
    let req = PendingPermission {
        request_id: request_id.clone(),
        kind: kind.to_owned(),
        digest: digest.clone(),
        program: pa.program.clone(),
        args: pa.args.iter().take(64).cloned().collect(),
        cwd: pa.cwd.clone(),
        plan: install.as_ref().map(|p| {
            json!({
                "manager": p.manager, "verb": p.verb, "packages": p.packages,
                "options": p.options, "fromManifest": p.from_manifest,
            })
        }),
        purpose: purpose.chars().take(200).collect(),
        mode: mode.as_str().to_owned(),
        created_at_ms: created,
        expires_at_ms: created + PERMISSION_TTL_MS,
        decision: None,
    };
    b.update(run_id, |r| {
        r.state = "permission-pending".into();
        r.pending_permission = Some(req.clone());
        event(r, "requested", &request_id, &digest, kind);
    });
    let finish = |b: &Broker, kind_ev: &str, detail: &str, back_to_running: bool| {
        b.update(run_id, |r| {
            r.pending_permission = None;
            if back_to_running {
                r.state = "tool-running".into();
            }
            event(r, kind_ev, &request_id, &digest, detail);
        });
    };
    let outcome = |dec: &'static str, code: &'static str, msg: String| GateOutcome::Denied {
        code,
        message: msg,
        class: label,
        mode: mode.as_str(),
        decision: dec,
    };
    loop {
        if flag.load(Ordering::SeqCst) || b.shutdown.load(Ordering::SeqCst) {
            finish(b, "cancelled", "run cancelled while waiting", false);
            record_dependency(
                b,
                run_id,
                install.as_ref(),
                &pa,
                mode,
                "cancelled",
                "not-run",
                None,
            );
            return GateOutcome::Cancelled;
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            finish(b, "expired", "run time budget ended while waiting", false);
            return GateOutcome::TimedOut;
        }
        let Some(cur) = b.store.load(run_id) else {
            return GateOutcome::Cancelled;
        };
        let now_mode = mode_of(&cur.run);
        let pending = cur.run.pending_permission.clone();
        match pending {
            None => {
                // the request was withdrawn by the broker (restart recovery); nothing was decided
                return outcome(
                    "denied",
                    "permission-withdrawn",
                    "the permission request was withdrawn; the command was not run".into(),
                );
            }
            Some(p) if p.request_id != request_id => {
                return outcome(
                    "denied",
                    "permission-withdrawn",
                    "the permission request was replaced; the command was not run".into(),
                );
            }
            Some(p) => {
                if let Some(d) = p.decision.as_deref() {
                    if d == "approve" {
                        // a downgrade that happened after the decision still wins only if it forbids this class
                        finish(b, "approved", "approved once by the person", true);
                        if let Some(fp) = &fp {
                            covered()
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .entry(run_id.to_owned())
                                .or_default()
                                .insert(fp.clone());
                        }
                        return GateOutcome::Proceed {
                            decision: "approved-once",
                            class: label,
                            mode: now_mode.as_str(),
                            install,
                        };
                    }
                    finish(b, "denied", "denied by the person", true);
                    record_dependency(
                        b,
                        run_id,
                        install.as_ref(),
                        &pa,
                        mode,
                        "denied",
                        "not-run",
                        None,
                    );
                    return outcome("denied", "permission-denied", denial_text(kind));
                }
                if now_mode == PermissionMode::Full {
                    // the person upgraded the run to Full Access (confirmed) while this was waiting
                    finish(
                        b,
                        "approved",
                        "released by the confirmed move to Full Access",
                        true,
                    );
                    return GateOutcome::Proceed {
                        decision: "auto-full-access",
                        class: label,
                        mode: now_mode.as_str(),
                        install,
                    };
                }
                if now_ms() >= p.expires_at_ms {
                    finish(b, "expired", "no decision within the allowed time", true);
                    record_dependency(
                        b,
                        run_id,
                        install.as_ref(),
                        &pa,
                        mode,
                        "expired",
                        "not-run",
                        None,
                    );
                    return outcome(
                        "expired",
                        "permission-expired",
                        "no decision was made in time, so the command was not run. Do not retry it unprompted; continue with what is available or tell the person what you need.".into(),
                    );
                }
            }
        }
        std::thread::sleep(POLL);
    }
}

fn denial_text(kind: &str) -> String {
    match kind {
        "dependency-install" => "the person denied this dependency installation. Nothing was installed and the command was not run. Do not retry the same installation; continue without these dependencies, use what is already available, or explain plainly what cannot be done without them.".to_owned(),
        _ => "the person denied this operation. It was not run. Do not retry it; choose another approach or explain what is needed.".to_owned(),
    }
}

/// Record a dependency acquisition (decision and, once known, outcome) in the run.
#[allow(clippy::too_many_arguments)]
pub fn record_dependency(
    b: &Broker,
    run_id: &str,
    plan: Option<&InstallPlan>,
    pa: &ProcessArgs,
    mode: PermissionMode,
    decision: &str,
    outcome: &str,
    exit_code: Option<i64>,
) {
    let Some(plan) = plan else { return };
    let rec = DependencyRecord {
        at_ms: now_ms(),
        manager: plan.manager.clone(),
        verb: plan.verb.clone(),
        packages: plan
            .packages
            .iter()
            .map(|p| {
                if p.constraint.is_empty() {
                    p.name.clone()
                } else {
                    format!("{}@{}", p.name, p.constraint)
                }
            })
            .collect(),
        command: std::iter::once(pa.program.as_str())
            .chain(pa.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(400)
            .collect(),
        mode: mode.as_str().to_owned(),
        decision: decision.to_owned(),
        outcome: outcome.to_owned(),
        exit_code,
    };
    b.update(run_id, |r| {
        r.dependencies.push(rec);
        if r.dependencies.len() > DEPS_MAX {
            let drop = r.dependencies.len() - DEPS_MAX;
            r.dependencies.drain(..drop);
        }
    });
}

/// After an install-class command ran: record how it ended.
pub fn record_install_outcome(
    b: &Broker,
    run_id: &str,
    proc_args: &Value,
    plan: Option<&InstallPlan>,
    decision: &str,
    exit_code: Option<i64>,
    executed: bool,
) {
    let mode = b
        .store
        .load(run_id)
        .map(|r| mode_of(&r.run))
        .unwrap_or_default();
    let outcome = match (executed, exit_code) {
        (true, Some(0)) => "installed",
        (true, _) => "failed",
        _ => "not-run",
    };
    record_dependency(
        b,
        run_id,
        plan,
        &process_args(proc_args),
        mode,
        decision,
        outcome,
        exit_code,
    );
}

// ------------------------------------------------------------------ verbs

type VerbResult = Result<Value, (&'static str, String)>;

/// The person's decision on the pending request. Single use, bound to the request id and digest.
pub fn decide(
    b: &Broker,
    run_id: &str,
    request_id: &str,
    digest: &str,
    decision: &str,
) -> VerbResult {
    if decision != "approve" && decision != "deny" {
        return Err(("bad-request", "decision must be approve or deny".into()));
    }
    let mut result: VerbResult = Err(("not-found", "no such permission request".into()));
    b.update(run_id, |r| {
        let replay = r.permission_events.iter().any(|e| {
            e.request_id == request_id
                && matches!(
                    e.kind.as_str(),
                    "approved" | "denied" | "expired" | "cancelled"
                )
        });
        match r.pending_permission.as_mut() {
            Some(p) if p.request_id == request_id => {
                if p.digest != digest {
                    result = Err((
                        "digest-mismatch",
                        "the decision names a different operation than the one waiting".into(),
                    ));
                } else if p.decision.is_some() {
                    result = Err((
                        "already-decided",
                        "this request already has a decision".into(),
                    ));
                } else if now_ms() >= p.expires_at_ms {
                    result = Err(("expired", "this request expired".into()));
                } else {
                    p.decision = Some(decision.to_owned());
                    result = Ok(
                        json!({ "requestId": request_id, "decision": decision, "recorded": true }),
                    );
                }
            }
            _ if replay => {
                result = Err((
                    "already-decided",
                    "this request was already decided; a decision cannot be replayed".into(),
                ));
            }
            _ => {}
        }
    });
    result
}

type CoverMap = Mutex<HashMap<String, HashSet<String>>>;

fn covered() -> &'static CoverMap {
    static C: OnceLock<CoverMap> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What makes two installations "the same": manager, operation, packages with constraints, options, the exact
/// command and its directory.
fn install_fingerprint(pa: &ProcessArgs, p: &InstallPlan) -> String {
    let mut pk: Vec<String> = p
        .packages
        .iter()
        .map(|x| format!("{}@{}", x.name, x.constraint))
        .collect();
    pk.sort();
    let mut op = p.options.clone();
    op.sort();
    let canon = json!({"manager": p.manager, "verb": p.verb, "packages": pk, "options": op, "program": pa.program, "args": pa.args, "cwd": pa.cwd});
    hex::encode(Sha256::digest(canon.to_string().as_bytes()))
}

type TokenMap = Mutex<HashMap<String, (String, String, Instant)>>;

fn upgrade_tokens() -> &'static TokenMap {
    static T: OnceLock<TokenMap> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The text the person is shown for a move to `to`, and the single-use token that releases it.
pub fn prepare_upgrade(b: &Broker, run_id: &str, to: &str) -> VerbResult {
    let to_mode =
        PermissionMode::parse(to).ok_or(("bad-request", "unknown permission mode".to_owned()))?;
    let rec = b
        .store
        .load(run_id)
        .ok_or(("not-found", "no such run".to_owned()))?;
    if rec.run.terminal {
        return Err(("run-ended", "this run has ended".into()));
    }
    let cur = mode_of(&rec.run);
    if to_mode.rank() <= rank_of(&rec.run) {
        return Err((
            "not-an-upgrade",
            "that is not a more autonomous mode; no confirmation is needed".into(),
        ));
    }
    let text = upgrade_text(to_mode);
    let token = rand_hex(16);
    upgrade_tokens()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            run_id.to_owned(),
            (
                token.clone(),
                to_mode.as_str().to_owned(),
                Instant::now() + UPGRADE_TOKEN_TTL,
            ),
        );
    Ok(json!({ "mode": to_mode.as_str(), "text": text, "token": token, "from": cur.as_str() }))
}

pub fn upgrade_text(to: PermissionMode) -> String {
    match to {
        PermissionMode::Full => "Full Access\n\nWhile this run is in Full Access, Nexus may run commands, install packages, use the network that dependency installation needs, and create, change or delete files in this project's working copy WITHOUT asking you again.\n\nIt stays inside this project's permissions and the Linux sandbox: it cannot reach other folders on your Mac, your secrets or system settings. Every command is still recorded, and you can stop the run or lower the mode at any time.".to_owned(),
        PermissionMode::AutoSafe => "Auto Approve Safe Operations\n\nNexus will run ordinary workspace edits, builds, tests and single-file deletions without asking. It will still ask before installing dependencies and before bulk deletions.".to_owned(),
        PermissionMode::Ask => "Ask for Approval".to_owned(),
    }
}

/// Change the mode. Downgrades apply at once; upgrades need the token from `prepare_upgrade`.
pub fn set_mode(b: &Broker, run_id: &str, mode: &str, token: Option<&str>) -> VerbResult {
    let to =
        PermissionMode::parse(mode).ok_or(("bad-request", "unknown permission mode".to_owned()))?;
    let rec = b
        .store
        .load(run_id)
        .ok_or(("not-found", "no such run".to_owned()))?;
    if rec.run.terminal {
        return Err(("run-ended", "this run has ended".into()));
    }
    let cur = mode_of(&rec.run);
    if !is_grant_only(&rec.run) && to == cur {
        return Ok(json!({ "mode": to.as_str(), "changed": false }));
    }
    let upgrade = to.rank() > rank_of(&rec.run);
    if upgrade {
        let ok = {
            let mut t = upgrade_tokens().lock().unwrap_or_else(|p| p.into_inner());
            match t.remove(run_id) {
                Some((tok, m, exp)) => {
                    token == Some(tok.as_str()) && m == to.as_str() && Instant::now() < exp
                }
                None => false,
            }
        };
        if !ok {
            return Err((
                "confirmation-required",
                "moving to a more autonomous mode needs the person's confirmation".into(),
            ));
        }
    }
    let task = rec.run.task_instance_id.clone();
    // a mode change ends every earlier approval's coverage: the next installation is decided afresh
    covered()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(run_id);
    b.update(run_id, |r| {
        r.permission_mode = to.as_str().to_owned();
        event(
            r,
            if upgrade {
                "mode-upgrade-confirmed"
            } else {
                "mode-downgrade"
            },
            "",
            "",
            &format!(
                "{} -> {}",
                if is_grant_only(&rec.run) {
                    "grant"
                } else {
                    cur.as_str()
                },
                to.as_str()
            ),
        );
    });
    let mut revoked = 0u32;
    if !upgrade {
        // revoke what was approved but never used: a daemon approval created for an operation that has not run
        if let Some(t) = task {
            revoked = revoke_unused(b, &t);
        }
        b.update(run_id, |r| {
            event(
                r,
                "revoked-unused",
                "",
                "",
                &format!("{revoked} unused approval(s) revoked on downgrade"),
            )
        });
    }
    Ok(
        json!({ "mode": to.as_str(), "changed": true, "upgrade": upgrade, "revokedUnused": revoked }),
    )
}

/// Revoke daemon approvals of this task that are pending or approved-but-unconsumed.
fn revoke_unused(b: &Broker, task_instance: &str) -> u32 {
    let mut n = 0;
    if let Ok(v) = crate::pipeline::daemon(
        b,
        "approval-list",
        json!({ "taskInstanceId": task_instance, "limit": 200 }),
    ) {
        for a in v
            .get("approvals")
            .and_then(|a| a.as_array())
            .cloned()
            .unwrap_or_default()
        {
            let (Some(id), Some(state)) = (
                a.get("approvalId").and_then(|x| x.as_str()),
                a.get("state").and_then(|x| x.as_str()),
            ) else {
                continue;
            };
            if (state == "pending" || state == "approved")
                && crate::pipeline::daemon(
                    b,
                    "approval-revoke",
                    json!({ "approvalId": id, "reason": "permission-mode-downgrade" }),
                )
                .is_ok()
            {
                n += 1;
            }
        }
    }
    n
}

/// A run that ends (or is recovered) must not leave a request open.
pub fn withdraw_pending(b: &Broker, run_id: &str) {
    b.update(run_id, |r| {
        if let Some(p) = r.pending_permission.take() {
            let (id, d) = (p.request_id, p.digest);
            event(r, "cancelled", &id, &d, "withdrawn when the run ended");
        }
    });
}

// ------------------------------------------------------- manifests (display of manifest-driven installs)

type ManifestMap = Mutex<HashMap<String, HashMap<String, String>>>;

fn manifests() -> &'static ManifestMap {
    static M: OnceLock<ManifestMap> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

const MANIFEST_MAX: usize = 64 * 1024;

/// Remember the content of a manifest the model wrote (after the write succeeded), so that a later
/// `cargo fetch` / `npm install` / `pip install -r` can show which packages it will fetch. Display only.
pub fn note_write(run_id: &str, path: &str, args: &Value) {
    let base = path.rsplit('/').next().unwrap_or(path);
    if !matches!(base, "Cargo.toml" | "package.json" | "requirements.txt") {
        return;
    }
    let Some(content) = args.get("content").and_then(|v| v.as_str()) else {
        return;
    };
    if content.len() > MANIFEST_MAX {
        return;
    }
    let mut m = manifests().lock().unwrap_or_else(|p| p.into_inner());
    if m.len() > 256 {
        m.clear();
    }
    m.entry(run_id.to_owned())
        .or_default()
        .insert(path.to_owned(), content.to_owned());
}

pub fn forget_manifests(run_id: &str) {
    manifests()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(run_id);
}

fn manifest_packages(run_id: &str, manager: &str, cwd: &str) -> Vec<Package> {
    let want = match manager {
        "cargo" => "Cargo.toml",
        "npm" | "pnpm" | "yarn" => "package.json",
        "pip" => "requirements.txt",
        _ => return Vec::new(),
    };
    let m = manifests().lock().unwrap_or_else(|p| p.into_inner());
    let Some(files) = m.get(run_id) else {
        return Vec::new();
    };
    let dir = cwd.trim_matches('/').trim_start_matches("./");
    let key = |f: &str| {
        if dir.is_empty() || dir == "." {
            f.to_owned()
        } else {
            format!("{dir}/{f}")
        }
    };
    let Some(content) = files.get(&key(want)).or_else(|| files.get(want)) else {
        return Vec::new();
    };
    match want {
        "Cargo.toml" => cargo_deps(content),
        "package.json" => npm_deps(content),
        _ => content
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('-'))
            .map(|l| {
                let name_end = l
                    .find(['<', '>', '=', '!', '~', ';', ' '])
                    .unwrap_or(l.len());
                Package {
                    name: l[..name_end].to_owned(),
                    constraint: l[name_end..].trim().to_owned(),
                }
            })
            .collect(),
    }
}

fn cargo_deps(toml: &str) -> Vec<Package> {
    let mut out = Vec::new();
    let mut in_deps = false;
    let mut table_dep: Option<String> = None;
    for raw in toml.lines() {
        let l = raw.trim();
        if l.starts_with('[') {
            let h = l.trim_matches(|c| c == '[' || c == ']').trim();
            in_deps = matches!(
                h,
                "dependencies" | "dev-dependencies" | "build-dependencies"
            );
            table_dep = ["dependencies.", "dev-dependencies.", "build-dependencies."]
                .iter()
                .find_map(|p| h.strip_prefix(p))
                .map(str::to_owned);
            if let Some(n) = &table_dep {
                out.push(Package {
                    name: n.clone(),
                    constraint: String::new(),
                });
            }
            continue;
        }
        if let Some(n) = &table_dep {
            if let Some(v) = l.strip_prefix("version").and_then(|r| r.split('"').nth(1)) {
                if let Some(p) = out.iter_mut().rev().find(|p| &p.name == n) {
                    p.constraint = v.to_owned();
                }
            }
            continue;
        }
        if !in_deps || l.is_empty() || l.starts_with('#') {
            continue;
        }
        let Some((name, rest)) = l.split_once('=') else {
            continue;
        };
        let rest = rest.trim();
        let version = if rest.starts_with('"') {
            rest.split('"').nth(1).unwrap_or("").to_owned()
        } else {
            rest.split("version")
                .nth(1)
                .and_then(|r| r.split('"').nth(1))
                .unwrap_or("")
                .to_owned()
        };
        out.push(Package {
            name: name.trim().to_owned(),
            constraint: version,
        });
    }
    out
}

fn npm_deps(json_text: &str) -> Vec<Package> {
    let Ok(v) = serde_json::from_str::<Value>(json_text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for k in ["dependencies", "devDependencies", "optionalDependencies"] {
        if let Some(o) = v.get(k).and_then(|x| x.as_object()) {
            for (n, c) in o {
                out.push(Package {
                    name: n.clone(),
                    constraint: c.as_str().unwrap_or("").to_owned(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_manifests_list_their_dependencies_with_versions() {
        let t = "[package]\nname = \"todo\"\n\n[dependencies]\nclap = { version = \"4\", features = [\"derive\"] }\nrusqlite = \"0.31\"\n# c\n\n[dev-dependencies.tempfile]\nversion = \"3\"\n\n[profile.release]\nopt-level = 3\n";
        let d = cargo_deps(t);
        assert_eq!(
            d.iter()
                .map(|p| (p.name.as_str(), p.constraint.as_str()))
                .collect::<Vec<_>>(),
            vec![("clap", "4"), ("rusqlite", "0.31"), ("tempfile", "3")]
        );
    }

    #[test]
    fn package_json_lists_runtime_and_dev_dependencies() {
        let d = npm_deps(
            r#"{"dependencies":{"left-pad":"^1.3.0"},"devDependencies":{"typescript":"5"}}"#,
        );
        assert_eq!(d.len(), 2);
        assert_eq!(
            (d[0].name.as_str(), d[0].constraint.as_str()),
            ("left-pad", "^1.3.0")
        );
    }

    #[test]
    fn only_manifests_are_remembered_and_forgotten_with_the_run() {
        note_write("run_t", "src/notes.txt", &json!({"content": "x"}));
        note_write(
            "run_t",
            "Cargo.toml",
            &json!({"content": "[dependencies]\nserde = \"1\"\n"}),
        );
        assert_eq!(manifest_packages("run_t", "cargo", ".")[0].name, "serde");
        assert!(manifest_packages("run_t", "npm", ".").is_empty());
        forget_manifests("run_t");
        assert!(manifest_packages("run_t", "cargo", ".").is_empty());
    }
}
