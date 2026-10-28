//! Unprivileged intent-broker client (A5.3).
//!
//! The ONE client path for user intents: `nexus intent ...` (CLI), the
//! Tauri backend (Nexus Desktop) and any future external consumer all use
//! these functions, which speak the narrow broker protocol over a local
//! Unix socket. Nothing here reads an issuer capability or a provider
//! credential, signs a frame, or can name a daemon command: the broker
//! socket accepts only the intent verbs below.

use crate::error::{ClientError, ExitCode};
use nexus_contracts::intent::NexusIntentV1;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const BROKER_PROTOCOL_VERSION: u32 = 1;
/// Schema tag on every CLI JSON envelope.
pub const CLI_SCHEMA: &str = "nexus.intent.cli/v1";

/// Default broker socket: `NEXUS_BROKER_SOCKET`, else the interactive profile's
/// `$NEXUS_HOME/broker.sock` (A6.1.4), else `$XDG_DATA_HOME/nexus/broker.sock` when
/// that runtime exists, else `~/.nexus/broker.sock`.
pub fn default_broker_socket() -> PathBuf {
    if let Ok(p) = std::env::var("NEXUS_BROKER_SOCKET") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(h) = std::env::var("NEXUS_HOME") {
        if !h.is_empty() {
            return PathBuf::from(h).join("broker.sock");
        }
    }
    let xdg = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    if let Some(x) = xdg.map(|b| b.join("nexus").join("broker.sock")) {
        if x.exists() {
            return x;
        }
    }
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => PathBuf::from(h).join(".nexus").join("broker.sock"),
        _ => PathBuf::from("/tmp/nexus-broker.sock"),
    }
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Server-assigned view of one run. Identity fields (`clientId`, ids) are
/// authoritative broker/Controller values, never client input.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntentRun {
    pub run_id: String,
    pub request_id: String,
    /// `uid:<n>`: derived from the connection's OS peer credentials.
    pub client_id: String,
    /// received | preparing | authorized | executing | request-started |
    /// streaming | completed | cancelled | timed-out | provider-failed |
    /// uncertain | refused | failed | rejected | abandoned
    pub state: String,
    pub terminal: bool,
    pub intent_type: String,
    pub response_mode: String,
    pub task_id: Option<String>,
    pub task_instance_id: Option<String>,
    pub attempt_id: Option<String>,
    pub command_id: Option<String>,
    pub conversation_id: Option<String>,
    pub provider_id: Option<String>,
    pub remote_model_id: Option<String>,
    pub logical_model_id: Option<String>,
    /// R-NATIVE-2: resolved target identity bound to this run (identity only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limit_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_limit_tokens: Option<u64>,
    /// `provider` | `loopback-test-double`
    pub endpoint_kind: Option<String>,
    pub request_digest: Option<String>,
    pub http_status: Option<u16>,
    pub usage_input_tokens: Option<u64>,
    pub usage_output_tokens: Option<u64>,
    pub finish_reason: Option<String>,
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub first_token_ms: Option<u64>,
    #[serde(default)]
    pub provider_request_id: Option<String>,
    #[serde(default)]
    pub provider_response_id: Option<String>,
    /// Machine-readable classification of a non-success end.
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub cancel_requested: bool,
    /// First 160 characters of the user's own prompt (owner-only view).
    #[serde(default)]
    pub prompt_preview: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    // ---- A5.5 repo-inspect progress (absent/zero for model-only runs) ----
    /// Server-managed workspace identity (never a path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Provider calls (model turns) started so far, and the limit the person chose (absent = no limit).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub turn: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    /// Tool calls proposed so far, and the limit the person chose (absent = no limit).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub tool_calls: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<u32>,
    /// Bytes of tool results returned to the model so far.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub tool_result_bytes: u64,
    /// Which policy limit ended the run cleanly (`max-turns`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// repo-code: edit operations applied so far (a count, never a quota).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub edits_used: u32,
    /// repo-code: commands run so far (a count, never a quota).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub tests_used: u32,
    /// A6.1.4: turns whose conversation was shortened to stay inside the context budget.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub context_compactions: u32,
    /// Provider interruptions the broker recovered from by itself (nothing was lost).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub recoveries: u32,
    /// This run continues an interrupted one (its work was carried into this run's copy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation_of: Option<String>,
    /// Trusted workspace mode: what happened when the finished task's patch was applied to
    /// the user's folder by itself (files applied, or why it was not).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_adopt: Option<String>,
    /// This run was continued by another run after it was interrupted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued_as: Option<String>,
    /// What the last recovery was about, for display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_recovery: Option<String>,
    /// repo-code: `pass` / `fail` of the most recent test execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_test_verification: Option<String>,
    /// repo-code: verification commands whose latest result is a failure (the same command passing
    /// later clears it, a different one does not). Counted over the whole run, not the bounded
    /// activity list.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub unresolved_failed_checks: u32,
    /// repo-code: the operation waiting for an independent approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_approval: Option<PendingApproval>,
    /// repo-code (A6.1.1): what the RUNTIME verified, derived on read from the
    /// recorded tool receipts. Independent of the lifecycle `state` and of
    /// anything the model said. Absent on other run types.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coding_outcome: Option<CodingOutcome>,
    /// repo-code: commit the isolated working copy was made from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_commit: Option<String>,
    /// repo-code: final change set (summary; the diff text is `intent diff`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_files: Vec<ChangedFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_digest: Option<String>,
    /// A7.1: the conversation this run belongs to (absent on runs started without one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// A7.1: the request was read-only: the run could not change a file (enforced by the
    /// broker's proposal gate, not by the model's instructions).
    #[serde(default, skip_serializing_if = "is_false")]
    pub read_only: bool,
    /// A7.1: how the working copy relates to earlier runs of the conversation:
    /// `fresh` | `continued` | `rebased` | `fresh-by-choice`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_relation: Option<String>,
    /// A7.1: plain-language detail of that relation (files carried, already applied, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_note: Option<String>,
    /// Direct Workspace: `"direct"` when this run edits the project's real folder in place (absent =
    /// an isolated working copy, as before). Fixed at submission; never changes during a run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_kind: Option<String>,
    /// True In-Place Execution: `"workspace"` when this run's commands write its isolated working copy
    /// in place (reported by the daemon that made the copy; absent = the throw-away-copy behaviour).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exec_scope: Option<String>,
    /// A7.1: the earlier run whose working copy this run started from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_from: Option<String>,
    /// How the end of a coding run relates to what was asked, from the request and the
    /// execution receipts (never from the model's claim): `fulfilled` | `no-change-verified`
    /// | `no-change-reported` | `incomplete`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<String>,
    /// Plain-language reason shown with an `incomplete` run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_note: Option<String>,
    /// The latest tool calls of the run (a bounded window, so the run record stays small). Every call is kept
    /// in the run's durable activity log: `activity_total` says how many there are, `activity_page` reads them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_activity: Vec<ToolActivity>,
    /// Every tool call the run has recorded (`tool_activity` is the latest of them).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub activity_total: u32,
    /// `path:line[-line]` references in the final answer that the Controller
    /// could match against bytes the tools actually returned in this run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub citations_verified: Vec<String>,
    /// References the model made that no tool result in this run supports.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub citations_unverified: Vec<String>,
}

fn is_false(v: &bool) -> bool {
    !*v
}
fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}
fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

/// One model-proposed tool call and what became of it. Everything here is a
/// summary or a digest: result bytes stay in the durable transcript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub index: u32,
    pub turn: u32,
    /// Provider `call_id` (as supplied; sanitized).
    pub call_id: String,
    /// Model-visible name (`fs_list`, ...), or what it asked for.
    pub tool: String,
    /// Short, redaction-safe argument summary (path, line range; never a
    /// search query's text, only its length).
    pub args_summary: String,
    /// `executed` | `refused` | `failed` | `cancelled`
    pub status: String,
    pub error_code: Option<String>,
    pub result_bytes: u64,
    pub result_digest: Option<String>,
    pub truncated: bool,
    pub execution_id: Option<String>,
    pub journal_seq: Option<i64>,
    pub args_digest: Option<String>,
    // ---- A5.6 repo-code (absent for read-only tools) ----
    /// The independent approval this mutation/process ran under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    /// `approved` | `denied` | `expired` | `revoked` | `cancelled` | `timed-out`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_outcome: Option<String>,
    /// Who decided the approval: `automated-policy` (daemon workspace policy, never a
    /// human) or absent for a human decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_actor: Option<String>,
    /// Write/edit: sha256 of the file before and after (receipt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_sha256: Option<String>,
    /// Process: exit code and `pass`/`fail`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<String>,
    /// Process: files the command created, changed or deleted in its throw-away copy of the project
    /// (lock files excepted) that were NOT saved to the project. Absent when there were none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsaved_files: Option<u32>,
    /// Release 1: for a `job_start`, the development-server ports the model asked to expose (plain
    /// port numbers; a request, never an authorization). Lets the Desktop offer the owner a
    /// scoped "allow previews on this port" action. Absent for every other tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_ports: Option<Vec<u16>>,
}

/// An operation waiting for an independent human approval (A5.6). The
/// reviewer uses the separate approver tool; nothing here can approve.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub approval_id: String,
    pub tool: String,
    pub summary: String,
    pub request_digest: Option<String>,
    pub expires_at_ms: Option<u64>,
    /// `edit` | `write` | `command` (A6.1: what the reviewer will be asked about).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// File path inside the working copy, or the executable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Bounded text of the MODEL'S proposal (changed lines / argv). The
    /// authoritative, daemon-derived diff is only shown to the approver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<String>,
    /// Fixed, human-readable restrictions that apply to this operation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub restrictions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
}

/// What the runtime actually verified about a coding run (A6.1.1). Derived
/// ONLY from execution receipts in the run's tool activity (approval outcome,
/// execution status, write post-image hashes, command verdicts), never from
/// model text, and never defaulting to success: missing evidence is
/// `not-yet-verified`, `no-test-executed` or `uncertain`.
///
/// The run's lifecycle (`state`: completed, failed, cancelled, ...) is a
/// separate concept: a run is `completed` when the model stopped answering,
/// whatever became of its proposed edits and commands.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodingOutcome {
    /// `verified-passed` | `verified-mixed` (the last check passed but another failed and was never
    /// re-run successfully) | `verified-failed` | `blocked-by-approval` |
    /// `no-test-executed` | `not-yet-verified` | `uncertain`
    pub verification: String,
    /// `none-proposed` | `pending-approval` | `applied` | `partially-applied` |
    /// `not-applied` | `uncertain`
    pub change: String,
    /// Edits/writes that executed AND returned a post-image receipt.
    pub edits_applied: u32,
    /// Proposed edits/writes that did not execute (denied, expired, revoked,
    /// cancelled, timed out, refused, failed).
    pub edits_not_applied: u32,
    /// Commands that executed and returned a verdict.
    pub tests_executed: u32,
    /// Proposed commands that did not execute.
    pub tests_not_executed: u32,
    /// Operations (edit or command) that an approval decision/expiry stopped.
    pub blocked_by_approval: u32,
    /// Exit code of the last executed command, when it exited.
    pub last_exit_code: Option<i64>,
    /// The last executed command ran BEFORE the last applied edit, so it does
    /// not verify the current state of the working copy.
    pub stale_after_edit: bool,
    /// Number of operations whose recorded evidence is inconsistent or missing
    /// (e.g. an edit reported executed without a post-image hash).
    pub uncertain_operations: u32,
    /// Verification commands whose latest result is a failure and that were not re-run
    /// successfully (a pass of the SAME command clears it; a narrower command does not).
    #[serde(default)]
    pub checks_failed_unresolved: u32,
    /// Commands that ran but whose verdict proved nothing (a pipeline without pipefail, or cut off
    /// by SIGPIPE): neither passed nor failed.
    #[serde(default)]
    pub checks_unverified: u32,
    /// Files the last passing check wrote into ITS OWN throw-away copy of the project that were not saved
    /// to the project: what it verified is then not the project as it is. 0 = none.
    #[serde(default)]
    pub last_check_unsaved_files: u32,
}

/// Derive the verified coding outcome of a `repo-code` run from its receipts.
/// Returns `None` for any other run type.
pub fn derive_coding_outcome(run: &IntentRun) -> Option<CodingOutcome> {
    if run.intent_type != "repo-code" {
        return None;
    }
    let mut o = CodingOutcome::default();
    let mut last_test: Option<(u32, bool, Option<i64>, u32)> = None; // (index, passed, exit, unsaved files)
    let mut failed: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut last_applied_edit: Option<u32> = None;
    let mut cmd_blocked = false;
    let mut mut_proposed = false;
    for (ai, a) in run.tool_activity.iter().enumerate() {
        let is_edit = a.tool == "fs_edit" || a.tool == "fs_write";
        // A failed attempt that the agent later redid successfully (same tool, same target)
        // is iteration, not an unapplied change.
        let superseded = matches!(a.status.as_str(), "failed" | "refused")
            && run.tool_activity[ai + 1..].iter().any(|b| {
                b.tool == a.tool && b.args_summary == a.args_summary && b.status == "executed"
            });
        if superseded {
            continue;
        }
        let is_cmd = a.tool == "proc_run";
        if !is_edit && !is_cmd {
            continue;
        }
        let executed = a.status == "executed";
        // Stopped AT the approval boundary: an approver or the policy said no (or the approval timed out). A
        // request refused BEFORE any approval existed (the folder is missing, the file changed, a protected
        // path) is a failed operation with its own error code, not a decision about approval.
        let stopped_by_approval = !executed
            && a.approval_outcome.as_deref().is_some_and(|x| {
                x != "approved"
                    && (x != "refused" || a.error_code.as_deref() == Some("policy-refused"))
            });
        if stopped_by_approval {
            o.blocked_by_approval += 1;
        }
        if a.status == "uncertain" {
            o.uncertain_operations += 1;
            if is_edit {
                mut_proposed = true;
            }
            continue;
        }
        if is_edit {
            mut_proposed = true;
            if executed {
                if a.post_sha256.is_some() {
                    o.edits_applied += 1;
                    last_applied_edit = Some(a.index);
                } else {
                    o.uncertain_operations += 1; // "executed" without a receipt is not an applied change
                }
            } else {
                o.edits_not_applied += 1;
            }
        } else {
            if executed {
                match a.verification.as_deref() {
                    Some("pass") => {
                        o.tests_executed += 1;
                        last_test =
                            Some((a.index, true, a.exit_code, a.unsaved_files.unwrap_or(0)));
                        failed.remove(
                            &a.args_digest
                                .clone()
                                .unwrap_or_else(|| a.args_summary.clone()),
                        );
                    }
                    Some("fail") => {
                        o.tests_executed += 1;
                        last_test =
                            Some((a.index, false, a.exit_code, a.unsaved_files.unwrap_or(0)));
                        failed.insert(
                            a.args_digest
                                .clone()
                                .unwrap_or_else(|| a.args_summary.clone()),
                        );
                    }
                    // a pipeline whose status proves nothing: not a pass, not a failure
                    Some("unverified") => o.checks_unverified += 1,
                    // a command that ran but verifies nothing (install, listing, script)
                    Some("run-pass" | "run-fail") => {}
                    _ => o.uncertain_operations += 1, // no verdict recorded: never assume a pass
                }
            } else {
                o.tests_not_executed += 1;
                if stopped_by_approval {
                    cmd_blocked = true;
                }
            }
        }
    }
    o.last_exit_code = last_test.and_then(|t| t.2);
    o.last_check_unsaved_files = last_test.map(|t| t.3).unwrap_or(0);
    // the run's own count covers failures that left the bounded activity list
    o.checks_failed_unresolved = (failed.len() as u32).max(run.unresolved_failed_checks);
    let run_uncertain =
        run.state == "uncertain" || run.error_code.as_deref() == Some("tool-outcome-uncertain");
    let uncertain = run_uncertain || o.uncertain_operations > 0;
    o.stale_after_edit = match (last_test, last_applied_edit) {
        (Some((ti, _, _, _)), Some(ei)) => ei > ti,
        _ => false,
    };
    o.change = if uncertain {
        "uncertain"
    } else if run
        .pending_approval
        .as_ref()
        .is_some_and(|p| p.operation.as_deref() != Some("command"))
    {
        "pending-approval"
    } else if o.edits_applied > 0 && o.edits_not_applied > 0 {
        "partially-applied"
    } else if o.edits_applied > 0 {
        "applied"
    } else if mut_proposed {
        "not-applied"
    } else if run.continuation_of.is_some() && !run.changed_files.is_empty() {
        // a continuation starts from the work of the run it continues: its copy already
        // holds those changes even though this run made none itself
        "applied"
    } else {
        "none-proposed"
    }
    .to_owned();
    o.verification = if uncertain {
        "uncertain"
    } else if let Some((_, passed, _, _)) = last_test {
        if o.stale_after_edit {
            "not-yet-verified"
        } else if passed && o.checks_failed_unresolved > 0 {
            "verified-mixed"
        } else if passed && o.last_check_unsaved_files > 0 {
            // it passed, but over files that exist only in its own scratch copy
            "verified-scratch"
        } else if passed {
            "verified-passed"
        } else {
            "verified-failed"
        }
    } else if cmd_blocked {
        "blocked-by-approval"
    } else if run.terminal {
        "no-test-executed"
    } else {
        "not-yet-verified"
    }
    .to_owned();
    Some(o)
}

/// What a `repo-code` run is given per MODEL CALL. Only the output ceiling of one provider request lives
/// here: it is a parameter of that request (the provider enforces and bills it; it includes the model's
/// reasoning tokens), not a quota on the work. There is no ceiling on edits, written bytes, commands,
/// tool calls, model turns or elapsed time: those exist only if the person chose them (`UserLimits`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCodeLimits {
    pub max_output_tokens: u64,
}

/// The strict operator profile's per-call output ceiling (kept byte-identical for the provider-body
/// baselines).
pub const DESKTOP_CODE_LIMITS: DesktopCodeLimits = DesktopCodeLimits {
    max_output_tokens: 1024,
};

/// The interactive (Desktop) profile's per-call output ceiling. It is per model turn and INCLUDES reasoning
/// tokens (measured 738-1793 of 1024-2048 at effort `low`); 32768 leaves room for a whole file.
pub const INTERACTIVE_CODE_LIMITS: DesktopCodeLimits = DesktopCodeLimits {
    max_output_tokens: 32_768,
};

impl DesktopCodeLimits {
    pub fn to_intent_limits(self) -> nexus_contracts::intent::IntentLimits {
        nexus_contracts::intent::IntentLimits {
            max_output_tokens: Some(self.max_output_tokens),
            ..Default::default()
        }
    }
}

/// Limits the PERSON chose (Settings) to bound their own cost or time. Every field is optional and the default
/// is none: Nexus applies no ceiling of its own.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_runtime_secs: Option<u64>,
}

impl UserLimits {
    /// The run limits to send with a task: the per-call output ceiling plus whatever the person chose.
    pub fn to_intent_limits(
        self,
        per_call: DesktopCodeLimits,
    ) -> nexus_contracts::intent::IntentLimits {
        nexus_contracts::intent::IntentLimits {
            max_output_tokens: Some(per_call.max_output_tokens),
            max_turns: self.max_turns,
            max_tool_calls: self.max_tool_calls,
            max_runtime_secs: self.max_runtime_secs,
            ..Default::default()
        }
    }
}

/// One file of the final reviewable change set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

/// A source repository this client may ask Nexus to modify (identity only).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AllowedCodeSource {
    pub source_id: String,
    /// The exact commit the operator pinned this source to, if any (read-only display).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_commit: Option<String>,
    /// Files/directories (`dir/`) the model may propose writes to; empty = whole project.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write_allow: Vec<String>,
    /// A6.1.4: display name and detected kinds of a project opened from the Desktop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub managed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kinds: Vec<String>,
}

/// The reviewable result of a repo-code run, from the isolated working copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffReply {
    pub run: IntentRun,
    pub base_commit: String,
    pub files: Vec<ChangedFile>,
    pub files_truncated: bool,
    pub diff: String,
    pub diff_digest: String,
    pub diff_truncated: bool,
}

/// Read-only facts about a run's retained working copy (A6.1.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyInfo {
    pub retained: bool,
    pub active: bool,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub base_commit: Option<String>,
    #[serde(default)]
    pub age_ms: Option<u64>,
    #[serde(default)]
    pub approx_bytes: Option<u64>,
}

/// A workspace this client may select (identity only, never a path).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AllowedWorkspace {
    pub workspace_id: String,
}

/// Allowed (Registry-issued) model the client may select.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AllowedModel {
    pub provider_id: String,
    pub remote_model_id: String,
    pub logical_model_id: String,
    pub endpoint_kind: String,
    pub output_limit_tokens: u64,
}

/// R-NATIVE-1 read-only Registry target (serde camelCase). The broker's
/// `intent-models` reply carries these alongside every existing
/// `AllowedModel` field; extra fields are optional so older clients keep
/// working. Never carries a credential value, reference or path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryTarget {
    pub provider_id: String,
    pub logical_model_id: String,
    pub remote_model_id: String,
    pub route_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub connection_status: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub context_limit_tokens: u64,
    #[serde(default)]
    pub output_limit_tokens: u64,
    #[serde(default)]
    pub billing_tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_use: Option<String>,
    #[serde(default)]
    pub issuable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitReply {
    pub run: IntentRun,
    /// True when the idempotency key matched an existing run (no new attempt).
    pub replay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultReply {
    pub run: IntentRun,
    /// Untrusted model output (possibly partial when the run did not complete).
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowReply {
    pub run: IntentRun,
    pub text_delta: String,
    pub next_offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelReply {
    pub run: IntentRun,
    /// `requested` | `already-requested` | `already-terminal`
    pub outcome: String,
}

fn next_id() -> String {
    crate::model_run::urandom_hex(8).unwrap_or_else(|_| "00000000".to_owned())
}

fn broker_error(resp: &serde_json::Value) -> ClientError {
    let code = resp
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("broker-error");
    let message = resp
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("the broker refused the request");
    let (static_code, exit) = match code {
        "unauthorized" | "peer-unauthorized" => ("unauthorized", ExitCode::Unauthorized),
        "pilot-disabled" | "broker-shutting-down" | "internal" => {
            (leak_code(code), ExitCode::Internal)
        }
        other => (leak_code(other), ExitCode::Usage),
    };
    ClientError::new(static_code, exit, message)
}

/// Map a wire code onto a `&'static str` without allocating per call: the
/// set is closed (anything else becomes `broker-error`).
fn leak_code(code: &str) -> &'static str {
    const KNOWN: &[&str] = &[
        "bad-intent",
        "unsupported-intent-type",
        "unsupported-schema",
        "content-too-large",
        "bad-request",
        "unknown-command",
        "model-not-available",
        "model-not-allowed",
        "workspace-not-allowed",
        "code-not-available",
        "live-not-authorized",
        "idempotency-conflict",
        "bad-offset",
        "not-terminal",
        "not-found",
        "busy",
        "thread-busy",
        "thread-closed",
        "workspace-conflict",
        "workspace-missing",
        "project-mismatch",
        "rate-limited",
        "pilot-disabled",
        "broker-shutting-down",
        "internal",
    ];
    KNOWN
        .iter()
        .find(|k| **k == code)
        .copied()
        .unwrap_or("broker-error")
}

fn call(
    socket: &Path,
    cmd: &str,
    params: serde_json::Value,
    timeout_ms: u64,
) -> Result<serde_json::Value, ClientError> {
    let frame = serde_json::json!({
        "protocol": BROKER_PROTOCOL_VERSION,
        "id": format!("c-{}", next_id()),
        "cmd": cmd,
        "params": params,
    });
    let resp = crate::transport::ipc_roundtrip(socket, &frame, timeout_ms)?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(resp
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    } else {
        Err(broker_error(&resp))
    }
}

fn decode<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<T, ClientError> {
    serde_json::from_value(v).map_err(|e| ClientError::internal(format!("broker reply shape: {e}")))
}

/// Registry-issued models this client may select.
pub fn models(socket: &Path) -> Result<Vec<AllowedModel>, ClientError> {
    let v = call(socket, "intent-models", serde_json::json!({}), 20_000)?;
    decode(v.get("models").cloned().unwrap_or_default())
}

/// R-NATIVE-1 read-only Registry target catalog (extra `targets` field on
/// the `intent-models` reply; existing `models` are unchanged).
pub fn registry_targets(socket: &Path) -> Result<Vec<RegistryTarget>, ClientError> {
    let v = call(socket, "intent-models", serde_json::json!({}), 20_000)?;
    decode(v.get("targets").cloned().unwrap_or_default())
}

/// Submit one intent. The intent is validated locally first (fail fast) and
/// again by the broker (authoritative).
pub fn submit(socket: &Path, intent: &NexusIntentV1) -> Result<SubmitReply, ClientError> {
    intent
        .validate()
        .map_err(|e| ClientError::usage(format!("{}: {}", e.code, e.message)))?;
    let v = call(
        socket,
        "intent-submit",
        serde_json::json!({ "intent": intent }),
        60_000,
    )?;
    decode(v)
}

pub fn status(socket: &Path, run_id: &str) -> Result<IntentRun, ClientError> {
    let v = call(
        socket,
        "intent-status",
        serde_json::json!({ "runId": run_id }),
        10_000,
    )?;
    decode(v.get("run").cloned().unwrap_or_default())
}

pub fn result(socket: &Path, run_id: &str) -> Result<ResultReply, ClientError> {
    decode(call(
        socket,
        "intent-result",
        serde_json::json!({ "runId": run_id }),
        10_000,
    )?)
}

/// Long-poll for progress: returns when new text exists, the state changed
/// from `state_seen`, the run is terminal, or `wait_ms` (<= 2000) elapsed.
pub fn follow(
    socket: &Path,
    run_id: &str,
    offset: u64,
    state_seen: Option<&str>,
    wait_ms: u64,
) -> Result<FollowReply, ClientError> {
    decode(call(
        socket,
        "intent-follow",
        serde_json::json!({
            "runId": run_id, "offset": offset, "stateSeen": state_seen, "waitMs": wait_ms.min(2_000),
        }),
        10_000,
    )?)
}

/// Continue an interrupted coding run (a new run that starts from its work).
pub fn resume(socket: &Path, run_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "intent-resume",
        serde_json::json!({ "runId": run_id }),
        30_000,
    )
}

pub fn cancel(socket: &Path, run_id: &str) -> Result<CancelReply, ClientError> {
    decode(call(
        socket,
        "intent-cancel",
        serde_json::json!({ "runId": run_id }),
        10_000,
    )?)
}

/// Workspaces this client may select for `repo-inspect`.
pub fn workspaces(socket: &Path) -> Result<Vec<AllowedWorkspace>, ClientError> {
    let v = call(socket, "intent-workspaces", serde_json::json!({}), 10_000)?;
    decode(v.get("workspaces").cloned().unwrap_or_default())
}

/// Operator-approved CODING sources (A5.6) this client may select. Distinct
/// from read-only workspaces: a right to inspect never implies a right to edit.
pub fn code_sources(socket: &Path) -> Result<Vec<AllowedCodeSource>, ClientError> {
    let v = call(socket, "intent-code-sources", serde_json::json!({}), 10_000)?;
    decode(v.get("sources").cloned().unwrap_or_default())
}

/// The reviewable change set of one of THIS client's repo-code runs.
/// Phase 2: what the run's engine durably recorded (engine, mode, per-attempt efforts, effort events),
/// read from the broker's authenticated engine-state record.
pub fn engine_summary(socket: &Path, run_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "intent-engine",
        serde_json::json!({ "runId": run_id }),
        20_000,
    )
}

/// Whether the broker would accept `intent-resume` for this run right now, with the broker's own reason when not.
pub fn resumable(socket: &Path, run_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "intent-resumable",
        serde_json::json!({ "runId": run_id }),
        10_000,
    )
}

pub fn diff(socket: &Path, run_id: &str) -> Result<DiffReply, ClientError> {
    decode(call(
        socket,
        "intent-diff",
        serde_json::json!({ "runId": run_id }),
        30_000,
    )?)
}

/// The limits a repo-code run will really get: only what the person (or the operator) chose, nothing built in
/// (A6.1.3), and how long an approval stays decidable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeConfig {
    pub limits: UserLimits,
    pub approval_lifetime_secs: u64,
    /// Output ceiling of ONE model call under this broker's profile (a request parameter, not a quota).
    pub max_output_tokens: u64,
}

impl CodeConfig {
    /// The limits to send with a task under this broker: its per-call output ceiling plus the person's own limits.
    pub fn intent_limits(&self) -> nexus_contracts::intent::IntentLimits {
        self.limits.to_intent_limits(DesktopCodeLimits {
            max_output_tokens: self.max_output_tokens,
        })
    }
}

/// Save the user's own limits; fields left out are cleared (no limit).
pub fn limits_set(
    socket: &Path,
    limits: &serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "intent-limits-set",
        serde_json::Value::Object(limits.clone()),
        10_000,
    )
}

pub fn code_config(socket: &Path) -> Result<CodeConfig, ClientError> {
    decode(call(
        socket,
        "intent-code-config",
        serde_json::json!({}),
        10_000,
    )?)
}

/// One page of EVERY tool call of one of THIS client's runs, oldest first (the run view only carries the latest).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub total: u32,
    pub offset: u32,
    pub activity: Vec<ToolActivity>,
}

pub fn activity_page(
    socket: &Path,
    run_id: &str,
    offset: u32,
    limit: u32,
) -> Result<ActivityPage, ClientError> {
    decode(call(
        socket,
        "intent-activity",
        serde_json::json!({ "runId": run_id, "offset": offset, "limit": limit }),
        15_000,
    )?)
}

/// Facts about the retained working copy of one of THIS client's repo-code runs.
pub fn copy_info(socket: &Path, run_id: &str) -> Result<CopyInfo, ClientError> {
    decode(call(
        socket,
        "intent-copy",
        serde_json::json!({ "runId": run_id }),
        15_000,
    )?)
}

pub fn list(socket: &Path, limit: u32) -> Result<Vec<IntentRun>, ClientError> {
    let v = call(
        socket,
        "intent-list",
        serde_json::json!({ "limit": limit }),
        10_000,
    )?;
    decode(v.get("runs").cloned().unwrap_or_default())
}

/// Read-only conversation page for one of THIS client's runs (the broker
/// authorizes by run ownership; the transcript file stays issuer-private).
/// Returns the same JSON shape as a native `ConversationView`.
pub fn conversation(
    socket: &Path,
    conversation_id: &str,
    after_seq: Option<u64>,
    before_seq: Option<u64>,
    limit: Option<u32>,
) -> Result<serde_json::Value, ClientError> {
    let v = call(
        socket,
        "intent-conversation",
        serde_json::json!({
            "conversationId": conversation_id, "afterSeq": after_seq,
            "beforeSeq": before_seq, "limit": limit,
        }),
        15_000,
    )?;
    Ok(v.get("view").cloned().unwrap_or(serde_json::Value::Null))
}

/// Look up the run owning a conversation (Desktop cancel helper).
pub fn run_for_conversation(
    socket: &Path,
    conversation_id: &str,
) -> Result<Option<IntentRun>, ClientError> {
    Ok(list(socket, 100)?
        .into_iter()
        .find(|r| r.conversation_id.as_deref() == Some(conversation_id)))
}

/// Fresh idempotency key (unique per call; callers that want retry safety
/// must pass their own stable key).
pub fn fresh_key(prefix: &str) -> String {
    format!("{prefix}-{}", next_id())
}

// ---- A6.1.4 interactive profile: projects and provider consent ------------------

/// Open a folder (chosen in the native picker) as a managed project.
pub fn project_open(socket: &Path, path: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-open",
        serde_json::json!({ "path": path }),
        180_000,
    )
}

/// Open a folder as a project, choosing where its tasks edit: `"direct"` (the real folder) or
/// `"isolated"` (a throw-away copy). `None` keeps the broker's default (isolated for a new project).
pub fn project_open_with(
    socket: &Path,
    path: &str,
    workspace: Option<&str>,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-open",
        serde_json::json!({ "path": path, "workspace": workspace }),
        180_000,
    )
}

/// The durable, project-level workspace choice for NEW tasks (`"direct"` | `"isolated"`).
pub fn project_set_workspace(
    socket: &Path,
    project_id: &str,
    workspace: &str,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-workspace",
        serde_json::json!({ "projectId": project_id, "workspace": workspace }),
        30_000,
    )
}

pub fn project_list(socket: &Path, with_changes: bool) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-list",
        serde_json::json!({ "changes": with_changes }),
        60_000,
    )
}

/// Standing grants (permissions): the exact consent text for these choices (and the refusal, if the choice
/// cannot be stored). Changes nothing.
pub fn project_grant_preview(
    socket: &Path,
    project_id: &str,
    fs: &str,
    net: &str,
    approval: &str,
    expires_in_secs: Option<u64>,
) -> Result<serde_json::Value, ClientError> {
    project_grant_preview_with(socket, project_id, fs, net, approval, expires_in_secs, None)
}

/// As [`project_grant_preview`], with the in-place recovery choices `(checkpoint, hardLinks)`.
pub fn project_grant_preview_with(
    socket: &Path,
    project_id: &str,
    fs: &str,
    net: &str,
    approval: &str,
    expires_in_secs: Option<u64>,
    exec: Option<(&str, &str)>,
) -> Result<serde_json::Value, ClientError> {
    let mut p = serde_json::json!({ "projectId": project_id, "fs": fs, "net": net, "approval": approval, "expiresInSecs": expires_in_secs });
    if let Some((c, h)) = exec {
        p["checkpoint"] = c.into();
        p["hardLinks"] = h.into();
    }
    call(socket, "project-grant-preview", p, 30_000)
}

/// Store a standing grant. `text_sha256` must be the digest of the text the user confirmed (from the preview).
#[allow(clippy::too_many_arguments)]
pub fn project_grant_set(
    socket: &Path,
    project_id: &str,
    fs: &str,
    net: &str,
    approval: &str,
    expires_in_secs: Option<u64>,
    text_sha256: &str,
    surface: &str,
) -> Result<serde_json::Value, ClientError> {
    project_grant_set_with(
        socket,
        project_id,
        fs,
        net,
        approval,
        expires_in_secs,
        text_sha256,
        surface,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn project_grant_set_with(
    socket: &Path,
    project_id: &str,
    fs: &str,
    net: &str,
    approval: &str,
    expires_in_secs: Option<u64>,
    text_sha256: &str,
    surface: &str,
    exec: Option<(&str, &str)>,
) -> Result<serde_json::Value, ClientError> {
    let mut p = serde_json::json!({ "projectId": project_id, "fs": fs, "net": net, "approval": approval, "expiresInSecs": expires_in_secs, "textSha256": text_sha256, "surface": surface });
    if let Some((c, h)) = exec {
        p["checkpoint"] = c.into();
        p["hardLinks"] = h.into();
    }
    call(socket, "project-grant", p, 30_000)
}

/// Destinations of a Controlled Internet grant (`net: controlled`): presets, `host[:port,port]` rules and
/// ports of services on the user's own machine. `git_write` rides along (M6B): the owner's explicit
/// Git-write choice, carried to the broker as `gitWrite` and sealed into the grant digest there.
#[derive(Debug, Clone, Default)]
pub struct NetChoice {
    pub presets: Vec<String>,
    pub hosts: Vec<String>,
    pub local_ports: Vec<u16>,
    pub git_write: bool,
    /// M7C: development-server ports the owner allows on host loopback (`devPorts`).
    pub dev_ports: Vec<u16>,
}

impl NetChoice {
    fn add_to(&self, p: &mut serde_json::Value) {
        if !self.presets.is_empty() {
            p["netPreset"] = serde_json::json!(self.presets);
        }
        if !self.hosts.is_empty() {
            p["allowHosts"] = serde_json::json!(self.hosts);
        }
        if !self.local_ports.is_empty() {
            p["allowLocalPorts"] = serde_json::json!(self.local_ports);
        }
        if self.git_write {
            p["gitWrite"] = serde_json::json!(true);
        }
        if !self.dev_ports.is_empty() {
            p["devPorts"] = serde_json::json!(self.dev_ports);
        }
    }
}

/// As [`project_grant_preview_with`], additionally naming Controlled Internet destinations.
#[allow(clippy::too_many_arguments)]
pub fn project_grant_preview_net(
    socket: &Path,
    project_id: &str,
    fs: &str,
    net: &str,
    approval: &str,
    expires_in_secs: Option<u64>,
    exec: Option<(&str, &str)>,
    dest: &NetChoice,
) -> Result<serde_json::Value, ClientError> {
    let mut p = serde_json::json!({ "projectId": project_id, "fs": fs, "net": net, "approval": approval, "expiresInSecs": expires_in_secs });
    if let Some((c, h)) = exec {
        p["checkpoint"] = c.into();
        p["hardLinks"] = h.into();
    }
    dest.add_to(&mut p);
    call(socket, "project-grant-preview", p, 30_000)
}

#[allow(clippy::too_many_arguments)]
pub fn project_grant_set_net(
    socket: &Path,
    project_id: &str,
    fs: &str,
    net: &str,
    approval: &str,
    expires_in_secs: Option<u64>,
    text_sha256: &str,
    surface: &str,
    exec: Option<(&str, &str)>,
    dest: &NetChoice,
) -> Result<serde_json::Value, ClientError> {
    let mut p = serde_json::json!({ "projectId": project_id, "fs": fs, "net": net, "approval": approval, "expiresInSecs": expires_in_secs, "textSha256": text_sha256, "surface": surface });
    if let Some((c, h)) = exec {
        p["checkpoint"] = c.into();
        p["hardLinks"] = h.into();
    }
    dest.add_to(&mut p);
    call(socket, "project-grant", p, 30_000)
}

/// The persisted effects record of an in-place execution.
pub fn exec_effects(socket: &Path, execution_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "exec-effects",
        serde_json::json!({ "executionId": execution_id }),
        30_000,
    )
}

/// Preview of a guarded restore (changes nothing); the answer carries the `confirmDigest` to apply it.
pub fn exec_restore_preview(
    socket: &Path,
    execution_id: &str,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "exec-restore-preview",
        serde_json::json!({ "executionId": execution_id }),
        120_000,
    )
}

/// Apply a guarded restore; `confirm` must be the digest of a preview taken against the current state.
pub fn exec_restore_apply(
    socket: &Path,
    execution_id: &str,
    confirm: &str,
    surface: &str,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "exec-restore",
        serde_json::json!({ "executionId": execution_id, "confirm": confirm, "surface": surface }),
        600_000,
    )
}

/// Release 1: preview of restoring the files a finished run's edit tools wrote in the project folder.
/// Changes nothing; the answer carries the `confirmDigest` that binds an apply to exactly this preview.
pub fn direct_restore_preview(
    socket: &Path,
    run_id: &str,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "direct-restore-preview",
        serde_json::json!({ "runId": run_id }),
        120_000,
    )
}

/// Apply that restore; `confirm` must be the digest of a preview taken against the current state.
pub fn direct_restore_apply(
    socket: &Path,
    run_id: &str,
    confirm: &str,
    surface: &str,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "direct-restore",
        serde_json::json!({ "runId": run_id, "confirm": confirm, "surface": surface }),
        600_000,
    )
}

pub fn project_grant_revoke(
    socket: &Path,
    project_id: &str,
    surface: &str,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-grant-revoke",
        serde_json::json!({ "projectId": project_id, "surface": surface }),
        30_000,
    )
}

pub fn project_grant_clear(
    socket: &Path,
    project_id: &str,
    surface: &str,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-grant-clear",
        serde_json::json!({ "projectId": project_id, "surface": surface }),
        30_000,
    )
}

pub fn project_refresh(socket: &Path, project_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-refresh",
        serde_json::json!({ "projectId": project_id }),
        180_000,
    )
}

/// Allow or forbid dependency installation for an opened project.
pub fn project_policy(
    socket: &Path,
    project_id: &str,
    installs: Option<bool>,
    trusted: Option<bool>,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-policy",
        serde_json::json!({ "projectId": project_id, "installs": installs, "trusted": trusted }),
        30_000,
    )
}

pub fn project_forget(socket: &Path, project_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-forget",
        serde_json::json!({ "projectId": project_id }),
        60_000,
    )
}

/// The consent state plus the exact text a new consent must present.
pub fn consent_status(socket: &Path) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "provider-consent-status",
        serde_json::json!({}),
        15_000,
    )
}

pub fn consent_grant(
    socket: &Path,
    provider_id: &str,
    remote_model_id: &str,
    text_sha256: &str,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "provider-consent-grant",
        serde_json::json!({
            "providerId": provider_id, "remoteModelId": remote_model_id,
            "textSha256": text_sha256, "intentTypes": ["repo-code", "repo-inspect"],
        }),
        15_000,
    )
}

pub fn consent_revoke(socket: &Path) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "provider-consent-revoke",
        serde_json::json!({}),
        15_000,
    )
}

/// Apply a finished run's patch to the user's original folder (after the native
/// backend's own confirmation). All-or-nothing; refused if the folder changed.
pub fn project_adopt(socket: &Path, run_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "project-adopt",
        serde_json::json!({ "runId": run_id }),
        60_000,
    )
}

// ---- A7.1 conversations ----------------------------------------------------------

/// Conversations (newest activity first), optionally of one project.
pub fn thread_list(
    socket: &Path,
    project_id: Option<&str>,
    include_archived: bool,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "thread-list",
        serde_json::json!({ "projectId": project_id, "includeArchived": include_archived }),
        30_000,
    )
}

/// One conversation: ordered messages, runs with their verified evidence, findings, the
/// workspace head. `after_seq` returns only messages newer than that.
pub fn thread_get(
    socket: &Path,
    thread_id: &str,
    after_seq: Option<u64>,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "thread-get",
        serde_json::json!({ "threadId": thread_id, "afterSeq": after_seq }),
        30_000,
    )
}

/// Parameters of one message sent into a conversation (or into a new one).
#[derive(Debug, Clone, Default)]
pub struct ThreadSend<'a> {
    pub thread_id: Option<&'a str>,
    pub project_id: &'a str,
    pub content: &'a str,
    /// `auto` | `review` | `edit`
    pub mode: &'a str,
    /// `continue` | `fresh`
    pub workspace: &'a str,
    pub idempotency_key: &'a str,
    /// Optional model selection `providerId/remoteModelId`, optionally with
    /// `/logicalModelId` or a bare `routeId`; bound to the conversation.
    pub model: Option<&'a str>,
    /// Optional route identity: exact catalog `routeId`.
    pub route: Option<&'a str>,
    /// Optional Engineering Mode id (e.g. `engineering-v2-adaptive`); needs an explicit model
    /// selection and is bound to the conversation. Absent = the default mode.
    pub mode_id: Option<&'a str>,
}

pub fn thread_send(socket: &Path, s: &ThreadSend<'_>) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "thread-send",
        serde_json::json!({
            "threadId": s.thread_id, "projectId": s.project_id, "content": s.content,
            "mode": if s.mode.is_empty() { "auto" } else { s.mode },
            "workspace": if s.workspace.is_empty() { "continue" } else { s.workspace },
            "idempotencyKey": s.idempotency_key,
            "model": s.model, "route": s.route, "modeId": s.mode_id,
        }),
        90_000,
    )
}

/// An empty conversation for a project ("New conversation").
pub fn thread_create(
    socket: &Path,
    project_id: &str,
    title: Option<&str>,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "thread-create",
        serde_json::json!({ "projectId": project_id, "title": title }),
        15_000,
    )
}

/// Rename and/or archive a conversation. Nothing is ever deleted.
pub fn thread_update(
    socket: &Path,
    thread_id: &str,
    title: Option<&str>,
    archived: Option<bool>,
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "thread-update",
        serde_json::json!({ "threadId": thread_id, "title": title, "archived": archived }),
        15_000,
    )
}

// ---- M7D background jobs (broker-owned JobManager; uid-gated user surface) ------------------

/// Start a background job (dev server, watcher) in a Direct project's real folder.
pub fn job_start(
    socket: &Path,
    project_id: &str,
    program: &str,
    args: &[String],
    expose_ports: &[u16],
) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "job-start",
        serde_json::json!({"projectId": project_id, "program": program, "args": args, "exposePorts": expose_ports}),
        60_000,
    )
}

pub fn job_status(socket: &Path, job_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "job-status",
        serde_json::json!({"jobId": job_id}),
        15_000,
    )
}

pub fn job_logs(socket: &Path, job_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "job-logs",
        serde_json::json!({"jobId": job_id}),
        15_000,
    )
}

pub fn job_stop(socket: &Path, job_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "job-stop",
        serde_json::json!({"jobId": job_id}),
        30_000,
    )
}

pub fn job_list(socket: &Path) -> Result<serde_json::Value, ClientError> {
    call(socket, "job-list", serde_json::json!({}), 15_000)
}

/// The background jobs of one project only.
pub fn job_list_for(socket: &Path, project_id: &str) -> Result<serde_json::Value, ClientError> {
    call(
        socket,
        "job-list",
        serde_json::json!({ "projectId": project_id }),
        15_000,
    )
}
