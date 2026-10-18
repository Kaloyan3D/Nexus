//! A5.6 `repo-code`: policy, proposal validation and the approval wait.
//!
//! The model may *propose* `fs_write`, `fs_edit` and `proc_run`; it can never
//! authorize them. This module is the deterministic Controller-side gate in
//! front of the daemon: it validates a proposal against the operator's coding
//! policy, then asks the daemon (issuer-authenticated) to create a
//! transaction-scoped approval for the EXACT operation and waits for an
//! independent principal to decide it. The daemon (not this module) authors
//! the reviewed preview, binds the approval to the args/budget/workspace/task
//! digests and consumes it exactly once when the tool is executed. A denied,
//! expired, revoked or cancelled approval executes nothing.
//!
//! Nothing here reads or writes the working copy, runs a process, or holds an
//! approver credential.

use crate::inspect::{validate_proposal, Refusal, ValidProposal};
use crate::pipeline::{daemon, StepError};
use crate::server::Broker;
use nexus_client::intent_client::PendingApproval;
use nexus_contracts::intent::NexusIntentV1;
use nexus_tools::{ToolArgs, ToolId};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const DEFAULT_CODE_TURNS: u32 = 12;
pub const DEFAULT_CODE_TOOL_CALLS: u32 = 30;
pub const DEFAULT_CODE_RUNTIME_SECS: u64 = 1800;
pub const DEFAULT_CODE_RESULT_BYTES: u64 = 512 * 1024;
pub const DEFAULT_MAX_EDITS: u32 = 5;
pub const DEFAULT_MAX_TESTS: u32 = 5;
/// Aggregate bytes the agent may publish across all approved writes.
pub const MAX_TOTAL_WRITE_BYTES: u64 = 128 * 1024;
/// How long one approval request lives (the human decides within this).
pub const APPROVAL_TTL_MS: i64 = 300_000;
/// Sandbox wall-clock for one test/build execution.
pub const PROC_WALL_MS: u64 = 120_000;
/// Longest we wait for the reviewer, even with a long approval TTL.
pub const APPROVAL_POLL: Duration = Duration::from_millis(150);

#[derive(Debug, Clone)]
pub struct CodePolicy {
    pub max_edits: u32,
    pub max_tests: u32,
    pub max_total_write_bytes: u64,
    /// Operator-configured write scope for this source (A6.1). Empty = the
    /// whole project (minus the always-protected files). Entries ending in
    /// `/` are directory prefixes, anything else is one exact file.
    pub write_allow: Vec<String>,
    /// A7.1: the request was read-only: every write proposal is refused by the broker.
    pub read_only: bool,
}

pub fn resolve_policy(intent: &NexusIntentV1, write_allow: &[String]) -> CodePolicy {
    CodePolicy {
        max_edits: intent.limits.max_edits.unwrap_or(DEFAULT_MAX_EDITS),
        max_tests: intent.limits.max_tests.unwrap_or(DEFAULT_MAX_TESTS),
        max_total_write_bytes: MAX_TOTAL_WRITE_BYTES,
        write_allow: write_allow.to_vec(),
        read_only: false,
    }
}

/// Is `path` (already normalized, relative) inside the operator's write scope?
pub fn in_write_scope(path: &str, allow: &[String]) -> bool {
    allow.is_empty()
        || allow.iter().any(|a| {
            if a.ends_with('/') {
                path.starts_with(a.as_str())
            } else {
                path == a
            }
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Read,
    Write,
    Process,
}

/// A proposal that passed the broker's deterministic checks (the Kernel and
/// the daemon re-check everything independently).
#[derive(Debug, Clone)]
pub struct CodeProposal {
    pub inner: ValidProposal,
    pub kind: Kind,
    /// Normalized target path for write/edit.
    pub path: Option<String>,
    /// Bytes this operation would publish (aggregate budget).
    pub bytes: u64,
    /// Short, human-readable summary for the approval list.
    pub summary: String,
}

fn refusal(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        message: message.into(),
    }
}

/// The programs the strict (independently approved) profile lets a model name.
const STRICT_PROGRAMS: [&str; 5] = ["cargo", "npm", "tsc", "python3", "node"];

fn norm(p: &str) -> String {
    p.trim_start_matches("./").to_owned()
}

/// The write path rules shared with the daemon's automated workspace policy
/// (`nexus_tools::protect`), applied here so a hostile proposal never even
/// reaches the Kernel.
fn write_path_ok(path: &str, workbench: bool) -> Result<(), Refusal> {
    if workbench {
        nexus_tools::protect::workbench_path_check(path)
    } else {
        nexus_tools::protect::write_path_check(path)
    }
    .map_err(|(code, why)| refusal(code, why))
}

/// Validate one proposal against the full catalog. `last_sha` is the
/// `fileSha256` a tool returned for a path earlier in THIS run (read result or
/// the post-image of an approved edit): it pins every edit to the bytes the
/// model actually saw.
pub fn validate_code_proposal(
    name: &str,
    arguments: &Value,
    last_sha: &BTreeMap<String, String>,
) -> Result<CodeProposal, Refusal> {
    validate_code_proposal_in(name, arguments, last_sha, false)
}

/// `workbench` = the interactive (project-level trust) profile's relaxed write-path rule.
pub fn validate_code_proposal_in(
    name: &str,
    arguments: &Value,
    last_sha: &BTreeMap<String, String>,
    workbench: bool,
) -> Result<CodeProposal, Refusal> {
    use nexus_model::repo_tools as rt;
    let Some(id) = rt::tool_id_for_profile(nexus_model::ToolProfile::RepoCodeV1, name) else {
        return Err(refusal(
            "unknown-tool",
            "that tool is not available; available tools: fs_list, fs_read, fs_search, fs_write, fs_edit, proc_run",
        ));
    };
    let tool = ToolId::parse(id).ok_or_else(|| refusal("unknown-tool", "unknown tool"))?;
    if !tool.is_mutating() && !tool.is_process() {
        let v = validate_proposal(name, arguments)?;
        return Ok(CodeProposal {
            summary: String::new(),
            inner: v,
            kind: Kind::Read,
            path: None,
            bytes: 0,
        });
    }
    let model_name = rt::CODE_EXTRA
        .iter()
        .find(|t| t.model_name == name)
        .map(|t| t.model_name)
        .ok_or_else(|| refusal("unknown-tool", "unknown tool"))?;
    let Some(obj) = arguments.as_object() else {
        return Err(refusal(
            "invalid-arguments",
            "arguments must be a JSON object",
        ));
    };
    // The model-visible schema is narrower than the native tool contract
    // (e.g. no file mode): any key the model was not offered is refused.
    let allowed: &[&str] = match name {
        "fs_write" => &["path", "content", "mode", "expectedSha256"],
        "fs_edit" => &["path", "expectedSha256", "edits"],
        _ => &["program", "args", "cwd"],
    };
    if let Some(k) = obj.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(refusal(
            "invalid-arguments",
            format!("unexpected argument {k:?}"),
        ));
    }
    let mut args = Value::Object(obj.clone());
    if name == "fs_write" && args.get("content").is_none() {
        // delete carries no content; create/replace without it fail validation downstream
        if args.get("mode").and_then(|v| v.as_str()) == Some("delete") {
            args["content"] = Value::String(String::new());
        }
    }
    let (kind, path, bytes, summary) = if tool.is_process() {
        let program = obj.get("program").and_then(|v| v.as_str()).unwrap_or("");
        if !rt::MODEL_PROGRAMS.contains(&program)
            || (!workbench && !STRICT_PROGRAMS.contains(&program))
        {
            return Err(refusal(
                "invalid-arguments",
                if workbench {
                    "program is not one of the available development programs"
                } else {
                    "program must be one of cargo, npm, tsc, python3, node"
                },
            ));
        }
        if let Some(cwd) = obj.get("cwd").and_then(|v| v.as_str()) {
            crate::inspect::path_ok_pub(cwd)?;
        }
        let argv: Vec<String> = obj
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        if argv.len() > if workbench { 64 } else { 12 } {
            return Err(refusal("invalid-arguments", "too many arguments"));
        }
        (
            Kind::Process,
            None,
            0u64,
            format!("{} {}", program, argv.join(" "))
                .chars()
                .take(120)
                .collect::<String>(),
        )
    } else {
        let path = obj
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| refusal("invalid-arguments", "path is required"))?
            .to_owned();
        crate::inspect::path_ok_pub(&path)?;
        let path = norm(&path);
        write_path_ok(&path, workbench)?;
        // Pin the edit to the bytes the model saw (never a guess).
        let needs_sha = match name {
            "fs_edit" => true,
            "fs_write" => matches!(
                obj.get("mode").and_then(|v| v.as_str()),
                Some("replace" | "delete")
            ),
            _ => false,
        };
        if needs_sha {
            if let Some(sha) = last_sha.get(&path) {
                args["expectedSha256"] = Value::String(sha.clone());
            }
        }
        let bytes = match name {
            "fs_write" => {
                let c = obj.get("content").and_then(|v| v.as_str()).unwrap_or("");
                if c.len() > rt::MODEL_MAX_WRITE_CHARS {
                    return Err(refusal(
                        "invalid-arguments",
                        format!("content may not exceed {} bytes", rt::MODEL_MAX_WRITE_CHARS),
                    ));
                }
                c.len() as u64
            }
            _ => {
                let edits = obj.get("edits").and_then(|v| v.as_array());
                let n = edits.map(Vec::len).unwrap_or(0);
                if n == 0 || n > rt::MODEL_MAX_EDITS {
                    return Err(refusal(
                        "invalid-arguments",
                        format!("edits must contain 1..={} operations", rt::MODEL_MAX_EDITS),
                    ));
                }
                edits
                    .map(|e| {
                        e.iter()
                            .map(|x| {
                                x.get("newText")
                                    .and_then(|v| v.as_str())
                                    .map(str::len)
                                    .unwrap_or(0) as u64
                            })
                            .sum::<u64>()
                    })
                    .unwrap_or(0)
            }
        };
        let verb = if name == "fs_edit" { "edit" } else { "write" };
        (
            Kind::Write,
            Some(path.clone()),
            bytes,
            format!("{verb} {path}"),
        )
    };
    // Strict typed parse with the native contract (deny_unknown_fields).
    let parsed = ToolArgs::parse(tool, &args).map_err(|e| {
        refusal(
            "invalid-arguments",
            format!("arguments rejected: {}", e.message),
        )
    })?;
    Ok(CodeProposal {
        inner: ValidProposal {
            tool_id: tool,
            model_name,
            args,
            args_digest: parsed.digest(),
        },
        kind,
        path,
        bytes,
        summary,
    })
}

/// What the Desktop/CLI may show about a pending approval. Built from the
/// model's own validated proposal; never from the approver's review.
#[derive(Debug, Clone, Default)]
pub struct ProposalView {
    pub summary: String,
    pub operation: &'static str,
    pub target: String,
    pub proposal: String,
    pub restrictions: Vec<String>,
}

const PROPOSAL_MAX: usize = 4096;

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!(
        "{}\n[... {} more bytes not shown]",
        &s[..cut],
        s.len() - cut
    )
}

fn prefixed(prefix: &str, text: &str) -> String {
    text.lines()
        .map(|l| format!("{prefix}{l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn proposal_view(cp: &CodeProposal) -> ProposalView {
    let args = &cp.inner.args;
    let isolated = vec![
        "changes are made only in the throw-away working copy, never in your repository".to_owned(),
        "the path is confined to the project (no hidden, credential or build-steering files)"
            .to_owned(),
        "nothing is committed, pushed or merged".to_owned(),
    ];
    match cp.inner.model_name {
        "fs_edit" => {
            let mut out = String::new();
            for (i, e) in args
                .get("edits")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
                .iter()
                .enumerate()
            {
                let old = e.get("oldText").and_then(|v| v.as_str()).unwrap_or("");
                let new = e.get("newText").and_then(|v| v.as_str()).unwrap_or("");
                out.push_str(&format!(
                    "@@ edit {} @@\n{}\n{}\n",
                    i + 1,
                    prefixed("- ", old),
                    prefixed("+ ", new)
                ));
            }
            ProposalView {
                summary: cp.summary.clone(),
                operation: "edit",
                target: cp.path.clone().unwrap_or_default(),
                proposal: clip(&out, PROPOSAL_MAX),
                restrictions: isolated,
            }
        }
        "fs_write" => {
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let mode = args
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("create");
            ProposalView {
                summary: cp.summary.clone(),
                operation: "write",
                target: cp.path.clone().unwrap_or_default(),
                proposal: clip(
                    &format!(
                        "{mode} file ({} bytes)\n{}",
                        content.len(),
                        prefixed("+ ", content)
                    ),
                    PROPOSAL_MAX,
                ),
                restrictions: isolated,
            }
        }
        _ => {
            let program = args.get("program").and_then(|v| v.as_str()).unwrap_or("");
            let argv: Vec<&str> = args
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                .unwrap_or_default();
            let cwd = args.get("cwd").and_then(|v| v.as_str()).unwrap_or(".");
            ProposalView {
                summary: cp.summary.clone(),
                operation: "command",
                target: program.to_owned(),
                proposal: clip(
                    &format!("{} {}\n(working directory: {cwd})", program, argv.join(" ")),
                    PROPOSAL_MAX,
                ),
                restrictions: vec![
                    "network access is disabled".to_owned(),
                    "runs over a read-only snapshot of the working copy; nothing it writes is kept"
                        .to_owned(),
                    "no host paths and no ambient credentials; environment is an allowlist"
                        .to_owned(),
                    "CPU, memory, process count, output and wall time are bounded".to_owned(),
                    "only cargo check|test|build|fmt, npm test|run build and tsc --noEmit exist"
                        .to_owned(),
                ],
            }
        }
    }
}

/// How an approval request ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalOutcome {
    /// The independent approver approved this exact operation.
    Approved {
        approval_id: String,
        /// Decided by the daemon's automated workspace policy, not by a human.
        automated: bool,
    },
    Denied {
        approval_id: String,
    },
    Expired {
        approval_id: String,
    },
    Revoked {
        approval_id: String,
    },
    /// The user cancelled the run while the approval was pending (revoked).
    Cancelled {
        approval_id: String,
    },
    /// The run's own time budget ended first (revoked).
    TimedOut {
        approval_id: String,
    },
    /// The daemon refused to create the approval (tool-level or authority).
    Refused {
        code: String,
        message: String,
    },
}

impl ApprovalOutcome {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Approved { .. } => "approved",
            Self::Denied { .. } => "denied",
            Self::Expired { .. } => "expired",
            Self::Revoked { .. } => "revoked",
            Self::Cancelled { .. } => "cancelled",
            Self::TimedOut { .. } => "timed-out",
            Self::Refused { .. } => "refused",
        }
    }
    pub fn approval_id(&self) -> Option<&str> {
        match self {
            Self::Approved { approval_id, .. }
            | Self::Denied { approval_id }
            | Self::Expired { approval_id }
            | Self::Revoked { approval_id }
            | Self::Cancelled { approval_id }
            | Self::TimedOut { approval_id } => Some(approval_id),
            Self::Refused { .. } => None,
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn strip(e: &StepError) -> String {
    e.code.strip_prefix("daemon-").unwrap_or(&e.code).to_owned()
}

/// Create the approval for exactly `params` (the very parameters the later
/// `tool-execute` will carry) and wait for the independent decision.
///
/// While waiting, the run shows `approval-pending` with the operation's
/// summary; the reviewer uses the separate approver tool. This function can
/// only observe the decision: the issuer credential cannot read the review or
/// decide.
#[allow(clippy::too_many_arguments)]
pub fn request_and_wait(
    b: &Broker,
    run_id: &str,
    flag: &AtomicBool,
    deadline: Instant,
    params: &Value,
    ai_origin: &str,
    tool_label: &str,
    view: &ProposalView,
) -> ApprovalOutcome {
    let mut p = params.clone();
    let ttl = b
        .cfg
        .approval_ttl_ms
        .unwrap_or(APPROVAL_TTL_MS)
        .clamp(1_000, APPROVAL_TTL_MS)
        .min(
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as i64,
        );
    if ttl < 1_000 {
        return ApprovalOutcome::Refused {
            code: "max-runtime".into(),
            message: "no time left in the run for an approval".into(),
        };
    }
    p["ttlMs"] = serde_json::json!(ttl);
    p["aiOrigin"] = serde_json::json!(ai_origin);
    let created = match daemon(b, "approval-request", p) {
        Ok(v) => v,
        Err(e) => {
            return ApprovalOutcome::Refused {
                code: strip(&e),
                message: e.message.chars().take(300).collect(),
            }
        }
    };
    let id = created
        .pointer("/approval/approvalId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    if id.is_empty() {
        return ApprovalOutcome::Refused {
            code: "daemon-shape".into(),
            message: "approval-request returned no approval id".into(),
        };
    }
    // A6.1.4: the daemon's automated workspace policy already decided (never a human):
    // nothing to wait for and nothing for a person to review.
    if created.pointer("/approval/state").and_then(|v| v.as_str()) == Some("approved")
        && created
            .pointer("/approval/decisionKind")
            .and_then(|v| v.as_str())
            == Some("automated-policy")
    {
        return ApprovalOutcome::Approved {
            approval_id: id,
            automated: true,
        };
    }
    let digest = created
        .pointer("/approval/requestDigest")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let expires = created
        .pointer("/approval/expiresMs")
        .and_then(|v| v.as_u64())
        .or_else(|| Some(now_ms() + ttl as u64));
    b.update(run_id, |r| {
        r.state = "approval-pending".into();
        r.pending_approval = Some(PendingApproval {
            approval_id: id.clone(),
            tool: tool_label.to_owned(),
            summary: view.summary.chars().take(160).collect(),
            request_digest: digest.clone(),
            expires_at_ms: expires,
            operation: Some(view.operation.to_owned()),
            target: Some(view.target.clone()),
            proposal: Some(view.proposal.clone()),
            restrictions: view.restrictions.clone(),
            created_at_ms: Some(now_ms()),
        });
    });
    let clear = |b: &Broker| {
        b.update(run_id, |r| {
            r.pending_approval = None;
            r.state = "tool-running".into();
        });
    };
    let revoke = |reason: &str| {
        let _ = daemon(
            b,
            "approval-revoke",
            serde_json::json!({ "approvalId": id, "reason": reason }),
        );
    };
    loop {
        if flag.load(Ordering::SeqCst) || b.shutdown.load(Ordering::SeqCst) {
            revoke("run-cancelled");
            clear(b);
            return ApprovalOutcome::Cancelled { approval_id: id };
        }
        if Instant::now() >= deadline {
            revoke("run-time-budget");
            clear(b);
            return ApprovalOutcome::TimedOut { approval_id: id };
        }
        let state = daemon(b, "approval-list", serde_json::json!({ "approvalId": id }))
            .ok()
            .and_then(|v| {
                v.pointer("/approval/state")
                    .and_then(|s| s.as_str())
                    .map(str::to_owned)
            });
        match state.as_deref() {
            Some("approved") => {
                clear(b);
                return ApprovalOutcome::Approved {
                    approval_id: id,
                    automated: false,
                };
            }
            Some("denied") => {
                clear(b);
                return ApprovalOutcome::Denied { approval_id: id };
            }
            Some("expired") => {
                clear(b);
                return ApprovalOutcome::Expired { approval_id: id };
            }
            Some("revoked") | Some("consumed") => {
                clear(b);
                return ApprovalOutcome::Revoked { approval_id: id };
            }
            _ => {}
        }
        std::thread::sleep(APPROVAL_POLL);
    }
}

/// What restart-recovery found for one interrupted repo-code run.
#[derive(Debug, Default)]
pub struct CodeRecovery {
    /// Pending approvals revoked so a dead run's approval can never be used.
    pub revoked: u32,
    /// `toolId` of every write/process that STARTED but has no recorded end.
    /// Their outcome is unknown and is never assumed.
    pub uncertain: Vec<String>,
}

/// Close out the daemon-side leftovers of a repo-code run the broker lost:
/// revoke its open approvals and find writes/processes whose outcome the
/// journal cannot show. Best effort and read-mostly; it never re-executes
/// anything and never resubmits a provider call.
pub fn recover_code_run(
    b: &Broker,
    task_id: Option<&str>,
    task_instance: &str,
    turns: u32,
) -> CodeRecovery {
    let mut out = CodeRecovery::default();
    if let Ok(v) = daemon(
        b,
        "approval-list",
        serde_json::json!({ "taskInstanceId": task_instance, "limit": 200 }),
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
            // `approved` but not yet consumed is just as dangerous as pending.
            if (state == "pending" || state == "approved")
                && daemon(
                    b,
                    "approval-revoke",
                    serde_json::json!({ "approvalId": id, "reason": "broker-restarted" }),
                )
                .is_ok()
            {
                out.revoked += 1;
            }
        }
    }
    let Some(task_id) = task_id else { return out };
    for turn in 1..=turns.saturating_add(1) {
        let Ok(v) = daemon(
            b,
            "tool-events",
            serde_json::json!({ "taskInstanceId": task_instance, "attemptId": format!("{task_id}-A{turn}"), "limit": 200 }),
        ) else {
            continue;
        };
        let recs = v
            .get("records")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default();
        out.uncertain.extend(uncertain_tools(&recs));
    }
    out
}

/// `toolId` of every write/process execution whose journal does not end in a
/// clean terminal phase. Clean terminals: reads `completed`; writes
/// `verified`; processes `exited`; any execution `failed`/`refused`/
/// `cancelled`/`aborted`. Everything else - `started`, `planned`, `prepared`,
/// `applied`, `running` and the daemon's own `interrupted` marker - means the
/// effect is unknown and is reported, never assumed.
pub fn uncertain_tools(recs: &[Value]) -> Vec<String> {
    const CLEAN: [&str; 7] = [
        "completed",
        "verified",
        "exited",
        "failed",
        "refused",
        "cancelled",
        "aborted",
    ];
    let field = |r: &Value, k: &str| r.get(k).and_then(|p| p.as_str()).map(str::to_owned);
    let mut order: Vec<String> = Vec::new();
    for r in recs {
        if let Some(e) = field(r, "executionId") {
            if !order.contains(&e) {
                order.push(e);
            }
        }
    }
    let mut out = Vec::new();
    for id in order {
        let mine: Vec<&Value> = recs
            .iter()
            .filter(|r| field(r, "executionId").as_deref() == Some(id.as_str()))
            .collect();
        let tool = mine
            .iter()
            .find_map(|r| field(r, "toolId"))
            .unwrap_or_default();
        if !matches!(tool.as_str(), "fs.write" | "fs.edit" | "proc.run") {
            continue;
        }
        if !mine
            .iter()
            .any(|r| field(r, "phase").as_deref() == Some("started"))
        {
            continue; // authorized only: nothing began
        }
        let clean = mine
            .iter()
            .any(|r| field(r, "phase").is_some_and(|p| CLEAN.contains(&p.as_str())));
        let interrupted = mine
            .iter()
            .any(|r| field(r, "phase").as_deref() == Some("interrupted"));
        if !clean || interrupted {
            out.push(tool);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(name: &str, a: Value) -> Result<CodeProposal, Refusal> {
        validate_code_proposal(name, &a, &BTreeMap::new())
    }

    #[test]
    fn a_started_write_or_process_without_an_end_is_uncertain_never_assumed() {
        let rec = |phase: &str, exec: &str, tool: Option<&str>| {
            let mut v = json!({"phase": phase, "executionId": exec});
            if let Some(t) = tool {
                v["toolId"] = json!(t);
            }
            v
        };
        // authorized only: nothing began, nothing uncertain
        assert!(uncertain_tools(&[rec("authorized", "e0", Some("fs.write"))]).is_empty());
        // started, no end: uncertain
        let recs = vec![
            rec("authorized", "e1", Some("fs.write")),
            rec("started", "e1", None),
        ];
        assert_eq!(uncertain_tools(&recs), ["fs.write"]);
        // every real write phase before the end is still uncertain
        for p in ["planned", "prepared", "applied"] {
            let mut r = recs.clone();
            r.push(rec(p, "e1", None));
            assert_eq!(uncertain_tools(&r), ["fs.write"], "{p}");
        }
        // clean write end = verified
        let mut done = recs.clone();
        done.push(rec("verified", "e1", None));
        assert!(uncertain_tools(&done).is_empty());
        // daemon recovery marker after a verified-looking history is still uncertain
        done.push(rec("interrupted", "e1", None));
        assert_eq!(uncertain_tools(&done), ["fs.write"]);
        // process: running without exit is uncertain; exited is clean
        let p = vec![
            rec("authorized", "p1", Some("proc.run")),
            rec("started", "p1", None),
            rec("prepared", "p1", None),
            rec("running", "p1", None),
        ];
        assert_eq!(uncertain_tools(&p), ["proc.run"]);
        let mut pe = p.clone();
        pe.push(rec("exited", "p1", None));
        assert!(uncertain_tools(&pe).is_empty());
        // an unfinished READ never needs reconciliation
        let r = vec![
            rec("authorized", "e2", Some("fs.read")),
            rec("started", "e2", None),
        ];
        assert!(uncertain_tools(&r).is_empty());
        // only the unfinished one is reported
        let mut mixed = done[..3].to_vec();
        mixed.push(rec("verified", "e1", None));
        mixed.extend(p);
        assert_eq!(uncertain_tools(&mixed), ["proc.run"]);
    }

    #[test]
    fn the_operator_write_scope_is_exact_on_directories_and_files() {
        let a = vec![
            "native/nexus-client/src/".to_owned(),
            "native/nexus-client/Cargo.toml".to_owned(),
        ];
        for ok in [
            "native/nexus-client/src/lib.rs",
            "native/nexus-client/src/a/b.rs",
            "native/nexus-client/Cargo.toml",
        ] {
            assert!(in_write_scope(ok, &a), "{ok}");
        }
        for bad in [
            "native/nexus-client/srcx/lib.rs",
            "native/nexus-client/Cargo.toml.bak",
            "native/nexus-kernel/src/lib.rs",
            "native/nexus-client/src",
            "README.md",
            "native/nexus-client/tests/x.rs",
        ] {
            assert!(!in_write_scope(bad, &a), "{bad}");
        }
        assert!(
            in_write_scope("anything/at/all.rs", &[]),
            "no scope configured = whole project"
        );
    }

    #[test]
    fn the_catalog_is_exactly_the_three_read_tools_plus_write_edit_and_run() {
        assert!(v("fs_read", json!({"path": "src/a.rs"})).is_ok());
        assert_eq!(
            v("fs_read", json!({"path": "src/a.rs"})).unwrap().kind,
            Kind::Read
        );
        assert_eq!(
            v(
                "fs_write",
                json!({"path": "src/a.rs", "content": "x", "mode": "create"})
            )
            .unwrap()
            .kind,
            Kind::Write
        );
        assert_eq!(
            v(
                "proc_run",
                json!({"program": "cargo", "args": ["test", "--offline"]})
            )
            .unwrap()
            .kind,
            Kind::Process
        );
        for bad in [
            "fs.write",
            "fs.edit",
            "proc.run",
            "git",
            "git_commit",
            "git_push",
            "shell",
            "bash",
            "sh",
            "exec",
            "fs_delete",
            "fs_move",
            "fs_chmod",
            "fs_symlink",
            "daemon",
            "approve",
            "approval_decide",
            "tool-execute",
            "",
            "FS_WRITE",
        ] {
            assert_eq!(
                v(bad, json!({"path": "a"})).unwrap_err().code,
                "unknown-tool",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn write_paths_exclude_protected_hidden_credential_and_build_steering_files() {
        for p in [
            ".env",
            ".git/config",
            ".gitignore",
            ".github/workflows/ci.yml",
            "config/id_rsa",
            "secrets.yaml",
            "src/../../x",
            "/etc/passwd",
            "../x",
            "a//b",
            "./",
            "",
            ".",
            "build.rs",
            "crates/x/build.rs",
            "Cargo.lock",
            "rust-toolchain.toml",
            "package-lock.json",
            "target/x.rs",
            "node_modules/a/b.js",
            "x/.hidden/y.rs",
            "live-authorization.json",
            "provider-credentials.json",
            "issuer.cap",
        ] {
            let r = v(
                "fs_write",
                json!({"path": p, "content": "x", "mode": "create"}),
            );
            assert!(r.is_err(), "write to {p:?} must be refused");
        }
        for p in [
            "src/lib.rs",
            "tests/it.rs",
            "README.md",
            "Cargo.toml",
            "src/a/b/c.rs",
        ] {
            assert!(
                v(
                    "fs_write",
                    json!({"path": p, "content": "x", "mode": "create"})
                )
                .is_ok(),
                "{p}"
            );
        }
    }

    #[test]
    fn arguments_are_strict_and_bounded_for_mutating_tools() {
        let bad: Vec<(&str, Value)> = vec![
            ("fs_write", json!({"path": "a.rs", "content": "x"})),
            (
                "fs_write",
                json!({"path": "a.rs", "content": "x", "mode": "append"}),
            ),
            (
                "fs_write",
                json!({"path": "a.rs", "content": "x", "mode": "create", "fileMode": "777"}),
            ),
            (
                "fs_write",
                json!({"path": "a.rs", "content": "x".repeat(100_000), "mode": "create"}),
            ),
            (
                "fs_write",
                json!({"path": "a.rs", "content": "x", "mode": "create", "extra": 1}),
            ),
            (
                "fs_write",
                json!({"path": "a.rs", "content": "x", "mode": "replace"}),
            ),
            ("fs_edit", json!({"path": "a.rs", "edits": []})),
            (
                "fs_edit",
                json!({"path": "a.rs", "edits": [{"oldText": "", "newText": "x"}], "expectedSha256": "a".repeat(64)}),
            ),
            (
                "fs_edit",
                json!({"path": "a.rs", "expectedSha256": "nothex", "edits": [{"oldText": "a", "newText": "b"}]}),
            ),
            (
                "fs_edit",
                json!({"path": "a.rs", "expectedSha256": "a".repeat(64), "edits": (0..17).map(|_| json!({"oldText": "a", "newText": "b"})).collect::<Vec<_>>()}),
            ),
            ("proc_run", json!({"program": "sh", "args": ["-c", "id"]})),
            ("proc_run", json!({"program": "/bin/sh", "args": []})),
            ("proc_run", json!({"program": "git", "args": ["push"]})),
            (
                "proc_run",
                json!({"program": "cargo", "args": (0..13).map(|i| i.to_string()).collect::<Vec<_>>()}),
            ),
            (
                "proc_run",
                json!({"program": "cargo", "args": ["test"], "cwd": "../.."}),
            ),
            (
                "proc_run",
                json!({"program": "cargo", "args": ["test"], "env": {"A": "b"}}),
            ),
            ("proc_run", json!([])),
        ];
        for (n, a) in bad {
            assert!(v(n, a.clone()).is_err(), "{n} {a}");
        }
    }

    #[test]
    fn edits_are_pinned_to_the_bytes_the_model_saw() {
        let sha = "a".repeat(64);
        let mut seen = BTreeMap::new();
        seen.insert("src/lib.rs".to_owned(), sha.clone());
        let p = validate_code_proposal(
            "fs_edit",
            &json!({"path": "./src/lib.rs", "edits": [{"oldText": "a - b", "newText": "a + b"}]}),
            &seen,
        )
        .expect("sha filled from evidence");
        assert_eq!(p.inner.args["expectedSha256"], json!(sha));
        assert_eq!(p.path.as_deref(), Some("src/lib.rs"));
        assert_eq!(p.bytes, 5);
        // the model's own (possibly hallucinated) hash never overrides evidence
        let p = validate_code_proposal(
            "fs_edit",
            &json!({"path": "src/lib.rs", "expectedSha256": "b".repeat(64), "edits": [{"oldText": "a", "newText": "b"}]}),
            &seen,
        )
        .unwrap();
        assert_eq!(p.inner.args["expectedSha256"], json!(sha));
        // without evidence an edit has no pre-image and is refused by the typed parser
        assert!(v(
            "fs_edit",
            json!({"path": "src/lib.rs", "edits": [{"oldText": "a", "newText": "b"}]})
        )
        .is_err());
        // a create never carries a pre-image
        assert!(validate_code_proposal(
            "fs_write",
            &json!({"path": "src/new.rs", "content": "x", "mode": "create"}),
            &seen
        )
        .is_ok());
    }

    #[test]
    fn policy_defaults_only_tighten() {
        let i = NexusIntentV1::parse(&json!({
            "schemaVersion": 1, "requestId": "r1", "idempotencyKey": "idem-0001",
            "intentType": "repo-code", "content": "x", "workspaceId": "w",
            "limits": {"maxEdits": 2, "maxTests": 3},
        }))
        .unwrap();
        let p = resolve_policy(&i, &[]);
        assert_eq!((p.max_edits, p.max_tests), (2, 3));
        assert_eq!(p.max_total_write_bytes, MAX_TOTAL_WRITE_BYTES);
    }
}
