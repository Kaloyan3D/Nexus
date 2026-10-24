//! A5.5 `repo-inspect`: the bounded, durable, read-only agentic loop.
//!
//! Runs on the issuer identity inside the broker, as the Controller of this
//! workflow. Every authority call is an EXISTING one; this module only
//! sequences them and adds the deterministic gate between "the model said"
//! and "the Kernel authorizes":
//!
//! ```text
//! per model turn (its own Controller attempt, command and sealed grant):
//!   shadow intent -> kernel intent (commits to the workspace digest)
//!   -> publish(scope repo-inspect) -> accept -> workspace-bind
//!   -> dispatch-authorize -> run_inspect_turn   (ONE provider request)
//! per tool call the response proposed (UNTRUSTED model output):
//!   name -> fixed three-tool catalog ; args -> strict native parser ;
//!   limits ; then daemon `tool-execute` (Kernel authorize_tool, which
//!   independently requires a dispatched repo-inspect command, read scope and
//!   the committed workspace) -> existing native fs tool -> bounded result
//!   -> back to the model as a function_call_output
//! ```
//!
//! Nothing here reads a workspace file, builds a path, opens a provider
//! connection or holds an arbitrary-execution primitive. A restart never
//! resumes a run (recovery marks it terminal), so no tool or provider call can
//! be repeated by a reconnect.

use crate::code::{ApprovalOutcome, CodePolicy, CodeProposal, Kind};
use crate::pipeline::{bridge, daemon, se, str_of, StepError};
use crate::server::Broker;
use nexus_client::intent_client::{IntentRun, ToolActivity};
use nexus_client::{
    InputItem, InspectBasics, InspectSession, InspectTurn, ModelRunOptions, ModelRunRequest,
    TurnEnd, TurnOutput,
};
use nexus_contracts::intent::NexusIntentV1;
use nexus_tools::{ToolArgs, ToolId};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Policy defaults (the intent can only tighten them).
pub const DEFAULT_MAX_TURNS: u32 = 5;
pub const DEFAULT_MAX_TOOL_CALLS: u32 = 10;
pub const DEFAULT_MAX_RESULT_BYTES: u64 = 256 * 1024;
pub const DEFAULT_MAX_RUNTIME_SECS: u64 = 300;
pub const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 2048;
/// Largest single result handed to the model.
pub const PER_RESULT_BYTES: usize = 24 * 1024;
/// Consecutive refused/invalid proposals tolerated before the run stops.
pub const MAX_CONSECUTIVE_REFUSALS: u32 = 3;
/// Largest multiple of the per-turn output cap a truncated turn may be re-asked with.
pub const OUTPUT_ESCALATION_FACTOR: u64 = 2;
/// Consecutive truncated turns tolerated before the run stops.
pub const MAX_TRUNCATIONS_IN_A_ROW: u32 = 2;
/// Retained tool-activity entries in the run view.
pub const MAX_ACTIVITY: usize = 64;

/// Resolved, bounded limits for one run.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub turns: u32,
    pub tool_calls: u32,
    pub result_bytes: u64,
    pub runtime: Duration,
    pub output_tokens: Option<u64>,
}

pub fn resolve_limits(intent: &NexusIntentV1) -> Limits {
    let l = &intent.limits;
    let code = intent.intent_type == nexus_contracts::intent::INTENT_REPO_CODE;
    Limits {
        turns: l.max_turns.unwrap_or(if code {
            crate::code::DEFAULT_CODE_TURNS
        } else {
            DEFAULT_MAX_TURNS
        }),
        tool_calls: l.max_tool_calls.unwrap_or(if code {
            crate::code::DEFAULT_CODE_TOOL_CALLS
        } else {
            DEFAULT_MAX_TOOL_CALLS
        }),
        result_bytes: l.max_tool_result_bytes.unwrap_or(if code {
            crate::code::DEFAULT_CODE_RESULT_BYTES
        } else {
            DEFAULT_MAX_RESULT_BYTES
        }),
        runtime: Duration::from_secs(l.max_runtime_secs.unwrap_or(if code {
            crate::code::DEFAULT_CODE_RUNTIME_SECS
        } else {
            DEFAULT_MAX_RUNTIME_SECS
        })),
        output_tokens: l.max_output_tokens,
    }
}

/// Which agentic workflow a run is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A5.5: read-only tools.
    Inspect,
    /// A5.6: read tools plus approved edits and sandboxed commands.
    Code,
}

impl Mode {
    pub fn of(intent: &NexusIntentV1) -> Self {
        if intent.intent_type == nexus_contracts::intent::INTENT_REPO_CODE {
            Self::Code
        } else {
            Self::Inspect
        }
    }
    fn scope(self) -> &'static str {
        match self {
            Self::Inspect => "repo-inspect",
            Self::Code => "repo-code",
        }
    }
    fn publish(self) -> &'static str {
        match self {
            Self::Inspect => "publish-inspect",
            Self::Code => "publish-code",
        }
    }
}

/// Validate operator workspaces at broker start. A workspace may never
/// contain (or sit inside) Nexus runtime state: the read tools must not be
/// able to reach the issuer capability, credentials, transcripts, ledgers or
/// run records even by an allowed path.
pub fn validate_workspaces(cfg: &crate::BrokerConfig) -> Result<Vec<crate::WorkspaceSpec>, String> {
    let mut out = Vec::new();
    let canon_of =
        |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    // Directories of runtime state: the workspace may be neither inside nor
    // above them. Single files/sockets: the workspace may not contain them.
    let runtime_dirs: Vec<std::path::PathBuf> = [
        &cfg.state_dir,
        &cfg.transcript_dir,
        &cfg.ledger_workspace,
        &cfg.registry_data_root,
    ]
    .iter()
    .map(|p| canon_of(p))
    .collect();
    let runtime_files: Vec<std::path::PathBuf> = [
        &cfg.cap_path,
        &cfg.credentials_path,
        &cfg.daemon_socket,
        &cfg.socket_path,
    ]
    .iter()
    .map(|p| {
        // The file may not exist yet (sockets): canonicalize its parent.
        match (p.parent(), p.file_name()) {
            (Some(d), Some(n)) => canon_of(d).join(n),
            _ => p.to_path_buf(),
        }
    })
    .collect();
    let all: Vec<&crate::WorkspaceSpec> = cfg
        .workspaces
        .iter()
        .chain(cfg.code_sources.iter())
        .collect();
    let mut seen_ids: Vec<&str> = Vec::new();
    for w in &all {
        if seen_ids.contains(&w.id.as_str()) {
            return Err(format!(
                "id '{}' is used by both an inspect workspace and a code source (or twice)",
                w.id
            ));
        }
        seen_ids.push(&w.id);
    }
    for w in all {
        let id_ok = !w.id.is_empty()
            && w.id.len() <= 64
            && w.id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
        if !id_ok {
            return Err(format!("workspace id '{}' is invalid", w.id));
        }
        if !w.root.is_absolute() {
            return Err(format!("workspace '{}' root must be absolute", w.id));
        }
        let canon = std::fs::canonicalize(&w.root)
            .map_err(|_| format!("workspace '{}' root does not exist", w.id))?;
        if canon == std::path::Path::new("/") || canon.parent().is_none() {
            return Err(format!(
                "workspace '{}' may not be the filesystem root",
                w.id
            ));
        }
        let md = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
        if !md.is_dir() {
            return Err(format!("workspace '{}' root is not a directory", w.id));
        }
        for rt in runtime_dirs.iter().chain(runtime_files.iter()) {
            let is_dir = runtime_dirs.contains(rt);
            if rt.starts_with(&canon) || (is_dir && canon.starts_with(rt)) {
                return Err(format!(
                    "workspace '{}' overlaps Nexus runtime state ({}); refused",
                    w.id,
                    rt.display()
                ));
            }
        }
        let mut w2 = w.clone();
        w2.root = canon;
        out.push(w2);
    }
    Ok(out)
}

/// Same validation for the coding sources; returns the canonicalized list.
pub fn validate_code_sources(
    cfg: &crate::BrokerConfig,
) -> Result<(Vec<crate::WorkspaceSpec>, Vec<crate::WorkspaceSpec>), String> {
    let all = validate_workspaces(cfg)?;
    let n = cfg.workspaces.len();
    let (a, b) = all.split_at(n);
    Ok((a.to_vec(), b.to_vec()))
}

/// Code sources this client may select, by identity only.
pub fn code_sources_for(cfg: &crate::BrokerConfig, client: &str) -> Vec<String> {
    let uid = uid_of(client);
    cfg.effective_code_sources()
        .iter()
        .filter(|w| {
            w.allowed_uids.is_empty() || uid.map(|u| w.allowed_uids.contains(&u)).unwrap_or(false)
        })
        .map(|w| w.id.clone())
        .collect()
}

fn uid_of(client: &str) -> Option<u32> {
    client.strip_prefix("uid:").and_then(|s| s.parse().ok())
}

/// Workspaces this client may select, by identity only.
pub fn workspaces_for(cfg: &crate::BrokerConfig, client: &str) -> Vec<String> {
    let uid = uid_of(client);
    cfg.workspaces
        .iter()
        .filter(|w| {
            w.allowed_uids.is_empty() || uid.map(|u| w.allowed_uids.contains(&u)).unwrap_or(false)
        })
        .map(|w| w.id.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// Proposal validation (deterministic; independent of any system prompt).

/// A model proposal that passed validation and may be sent to the Kernel.
#[derive(Debug, Clone)]
pub struct ValidProposal {
    pub tool_id: ToolId,
    pub model_name: &'static str,
    pub args: Value,
    pub args_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

fn refusal(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        message: message.into(),
    }
}

/// Validate one proposed call. Pure. The model controls only `name` and
/// `arguments`; both are checked against the fixed catalog and the native
/// tools' own strict (deny-unknown-fields) argument parser, and the
/// model-facing size caps are enforced BEFORE anything reaches the Kernel.
pub fn validate_proposal(name: &str, arguments: &Value) -> Result<ValidProposal, Refusal> {
    let Some(id) = nexus_model::repo_tools::tool_id_for(name) else {
        return Err(refusal(
            "unknown-tool",
            "that tool is not available; available tools: fs_list, fs_read, fs_search",
        ));
    };
    let model_name = nexus_model::repo_tools::CATALOG
        .iter()
        .find(|t| t.model_name == name)
        .map(|t| t.model_name)
        .unwrap_or("fs_list");
    let tool = ToolId::parse(id).ok_or_else(|| refusal("unknown-tool", "unknown tool"))?;
    // Read-only by construction; belt and braces against catalog drift.
    if tool.is_mutating() || tool.is_process() {
        return Err(refusal("unknown-tool", "that tool is not available"));
    }
    if !arguments.is_object() {
        return Err(refusal(
            "invalid-arguments",
            "arguments must be a JSON object",
        ));
    }
    let parsed = ToolArgs::parse(tool, arguments).map_err(|e| {
        refusal(
            "invalid-arguments",
            format!("arguments rejected: {}", e.message),
        )
    })?;
    match &parsed {
        ToolArgs::List(a) => path_ok(&a.path)?,
        ToolArgs::Read(a) => {
            path_ok(&a.path)?;
            if let Some(n) = a.max_lines {
                if n > nexus_model::repo_tools::MODEL_MAX_READ_LINES {
                    return Err(refusal(
                        "invalid-arguments",
                        format!(
                            "maxLines may not exceed {}",
                            nexus_model::repo_tools::MODEL_MAX_READ_LINES
                        ),
                    ));
                }
            }
        }
        ToolArgs::Search(a) => {
            path_ok(&a.path)?;
            if let Some(n) = a.max_matches {
                if n > nexus_model::repo_tools::MODEL_MAX_SEARCH_MATCHES {
                    return Err(refusal(
                        "invalid-arguments",
                        format!(
                            "maxMatches may not exceed {}",
                            nexus_model::repo_tools::MODEL_MAX_SEARCH_MATCHES
                        ),
                    ));
                }
            }
        }
        _ => return Err(refusal("unknown-tool", "that tool is not available")),
    }
    Ok(ValidProposal {
        tool_id: tool,
        model_name,
        args: arguments.clone(),
        args_digest: parsed.digest(),
    })
}

pub(crate) fn path_ok_pub(p: &str) -> Result<(), Refusal> {
    path_ok(p)
}

fn path_ok(p: &str) -> Result<(), Refusal> {
    // Cheap early refusal for the obviously hostile; the native workspace
    // boundary (descriptor-relative, O_NOFOLLOW) remains the real control.
    if p.len() > 1024 || p.contains('\0') || p.starts_with('/') || p.split('/').any(|c| c == "..") {
        return Err(refusal(
            "invalid-arguments",
            "paths must be relative to the repository root and may not contain '..'",
        ));
    }
    Ok(())
}

fn safe_id(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
        .take(80)
        .collect()
}

fn args_summary(p: &ValidProposal) -> String {
    let s = match &p.args {
        Value::Object(o) => {
            let g = |k: &str| o.get(k).and_then(|v| v.as_str()).unwrap_or(".");
            match p.model_name {
                "fs_list" => format!("path={}", g("path")),
                "fs_read" => format!(
                    "path={} start={} max={}",
                    o.get("path").and_then(|v| v.as_str()).unwrap_or(""),
                    o.get("startLine").and_then(|v| v.as_u64()).unwrap_or(1),
                    o.get("maxLines")
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "default".into()),
                ),
                _ => format!(
                    "query(len={}) path={}",
                    o.get("query")
                        .and_then(|v| v.as_str())
                        .map(str::len)
                        .unwrap_or(0),
                    g("path")
                ),
            }
        }
        _ => String::new(),
    };
    s.chars().take(200).collect()
}

fn fallback_summary(name: &str, args: &Value) -> String {
    let n: String = name
        .chars()
        .filter(|c| c.is_ascii_graphic())
        .take(40)
        .collect();
    format!("{} ({} bytes of arguments)", n, args.to_string().len())
}

// ---------------------------------------------------------------------------
// Result rendering (what the model sees). Always bounded; always labeled as
// untrusted repository data; secrets were already redacted by the native tool.

#[derive(Debug, Clone)]
pub struct Rendered {
    pub text: String,
    pub is_error: bool,
    pub truncated: bool,
    pub digest: String,
}

fn digest_of(s: &str) -> String {
    nexus_contracts::sha256_hex(s)
}

pub fn render_error(tool: &str, code: &str, message: &str) -> Rendered {
    let msg: String = message.chars().take(300).collect();
    let text = nexus_contracts::canonical_json(&serde_json::json!({
        "tool": tool, "status": "error", "errorCode": code, "message": msg,
    }));
    Rendered {
        digest: digest_of(&text),
        text,
        is_error: true,
        truncated: false,
    }
}

/// Render a native `ToolResultV1` (as JSON) for the model.
pub fn render_result(tool: &str, result: &Value, cap: usize) -> Rendered {
    let status = result
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("error");
    if status == "error" || result.get("output").map(|o| o.is_null()).unwrap_or(true) {
        let code = result
            .pointer("/error/code")
            .and_then(|v| v.as_str())
            .unwrap_or("tool-error");
        let message = result
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("the tool failed");
        return render_error(tool, code, message);
    }
    let mut out = result.get("output").cloned().unwrap_or(Value::Null);
    // Line-numbered content makes citations reliable.
    if tool == "fs_read" {
        let start = out.get("startLine").and_then(|v| v.as_u64()).unwrap_or(1);
        if let Some(content) = out.get("content").and_then(|v| v.as_str()) {
            let numbered: String = content
                .split('\n')
                .enumerate()
                .map(|(i, l)| format!("{}: {}", start + i as u64, l))
                .collect::<Vec<_>>()
                .join("\n");
            out["content"] = Value::String(numbered);
            out["numbering"] =
                Value::String("each line is prefixed 'N: ' with its 1-based line number".into());
        }
    }
    let mut truncated = result
        .pointer("/truncation/truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut env = serde_json::json!({
        "tool": tool,
        "status": if truncated { "truncated" } else { "ok" },
        "untrustedRepositoryContent": true,
        "redacted": result.pointer("/redaction/redacted").and_then(|v| v.as_bool()).unwrap_or(false),
        "truncationReasons": result.pointer("/truncation/reasons").cloned().unwrap_or(Value::Array(vec![])),
        "result": out,
    });
    // Fit to the cap by shrinking the large collections, never by cutting
    // JSON mid-token.
    loop {
        let text = nexus_contracts::canonical_json(&env);
        if text.len() <= cap {
            if truncated {
                env["status"] = Value::String("truncated".into());
            }
            let text = nexus_contracts::canonical_json(&env);
            return Rendered {
                digest: digest_of(&text),
                text,
                is_error: false,
                truncated,
            };
        }
        truncated = true;
        let r = &mut env["result"];
        let shrunk = if let Some(a) = r.get_mut("entries").and_then(|v| v.as_array_mut()) {
            let n = a.len() / 2;
            a.truncate(n);
            true
        } else if let Some(a) = r.get_mut("matches").and_then(|v| v.as_array_mut()) {
            let n = a.len() / 2;
            a.truncate(n);
            true
        } else if let Some(c) = r
            .get_mut("content")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
        {
            let keep = c.len() / 2;
            let mut cut = keep;
            while cut > 0 && !c.is_char_boundary(cut) {
                cut -= 1;
            }
            let cut_at = c[..cut].rfind('\n').unwrap_or(cut);
            r["content"] = Value::String(c[..cut_at].to_owned());
            r["eof"] = Value::Bool(false);
            true
        } else {
            false
        };
        if !shrunk {
            return render_error(tool, "result-too-large", "the result could not be bounded");
        }
        env["status"] = Value::String("truncated".into());
        let reasons = env["truncationReasons"].as_array_mut();
        if let Some(rs) = reasons {
            if !rs.iter().any(|x| x == "broker-result-cap") {
                rs.push(Value::String("broker-result-cap".into()));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Evidence + citation checking (never fabricate provenance).

#[derive(Default)]
struct Evidence {
    ranges: BTreeMap<String, Vec<(u64, u64)>>,
}

impl Evidence {
    fn norm(p: &str) -> String {
        p.trim_start_matches("./").to_owned()
    }
    fn add_read(&mut self, path: &str, start: u64, lines: u64) {
        if lines > 0 {
            self.ranges
                .entry(Self::norm(path))
                .or_default()
                .push((start, start + lines - 1));
        }
    }
    fn add_line(&mut self, path: &str, line: u64) {
        self.ranges
            .entry(Self::norm(path))
            .or_default()
            .push((line, line));
    }
    fn covers(&self, path: &str, lo: u64, hi: u64) -> bool {
        let Some(rs) = self.ranges.get(&Self::norm(path)) else {
            return false;
        };
        // every line of lo..=hi must lie inside some returned range
        (lo..=hi.min(lo + 2000)).all(|l| rs.iter().any(|(a, b)| *a <= l && l <= *b))
    }
}

/// Split `path:line[-line]` references in model text into verified and
/// unverified, against only the bytes tools actually returned in this run.
fn check_citations(text: &str, ev: &Evidence) -> (Vec<String>, Vec<String>) {
    let mut verified = Vec::new();
    let mut unverified = Vec::new();
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        // find ':' followed by digits, preceded by a path-like token
        if b[i] == b':' && i + 1 < b.len() && b[i + 1].is_ascii_digit() {
            let mut s = i;
            while s > 0
                && (b[s - 1].is_ascii_alphanumeric()
                    || matches!(b[s - 1], b'_' | b'-' | b'.' | b'/'))
            {
                s -= 1;
            }
            let path = &text[s..i];
            let mut e = i + 1;
            while e < b.len() && b[e].is_ascii_digit() {
                e += 1;
            }
            let lo: u64 = text[i + 1..e].parse().unwrap_or(0);
            let mut hi = lo;
            let mut end = e;
            if end + 1 < b.len() && matches!(b[end], b'-' | b'\xe2') {
                let mut k = end;
                if b[k] == b'-' {
                    k += 1;
                    let st = k;
                    while k < b.len() && b[k].is_ascii_digit() {
                        k += 1;
                    }
                    if k > st {
                        hi = text[st..k].parse().unwrap_or(lo);
                        end = k;
                    }
                }
            }
            if path.contains('.') && path.len() >= 3 && lo > 0 {
                let label = if hi > lo {
                    format!("{path}:{lo}-{hi}")
                } else {
                    format!("{path}:{lo}")
                };
                let list = if hi >= lo && ev.covers(path, lo, hi) {
                    &mut verified
                } else {
                    &mut unverified
                };
                if !list.contains(&label) && list.len() < 40 {
                    list.push(label);
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    (verified, unverified)
}

// ---------------------------------------------------------------------------
// The loop.

struct Ctx<'a> {
    b: &'a Arc<Broker>,
    run_id: &'a str,
    flag: &'a Arc<AtomicBool>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Daemon failure codes that mean "the AUTHORITY is gone or inconsistent":
/// they end the run (fail closed) instead of being reported to the model.
fn is_authority_failure(code: &str) -> bool {
    matches!(
        code,
        "authorization-refused"
            | "revoked"
            | "scope-refused"
            | "delivery-invalid"
            | "intent-fenced"
            | "intent-unknown"
            | "binding-mismatch"
            | "store-corrupt"
            | "reconciliation-required"
            | "rollback-detected"
            | "witness-required"
            | "forged-issuer"
            | "stale-lease"
            | "workspace-invalid"
            | "workspace-mismatch"
            | "peer-unauthorized"
            | "unauthorized"
            | "unreachable"
            | "unknown-command"
            | "unreadable"
    ) || code.starts_with("unreachable")
}

pub(crate) fn run(
    b: &Arc<Broker>,
    run_id: &str,
    intent: &NexusIntentV1,
    flag: &Arc<AtomicBool>,
) -> Result<(), StepError> {
    let ctx = Ctx { b, run_id, flag };
    let started = Instant::now();
    let mode = Mode::of(intent);
    let mut limits = resolve_limits(intent);
    if mode == Mode::Code {
        // A6.1.3: operator caps only ever lower what the client asked for.
        let eff = b
            .cfg
            .code_caps
            .with_user_limits(&b.cfg.state_dir)
            .effective(b.cfg.interactive);
        limits.turns = limits.turns.min(eff.max_turns);
        limits.tool_calls = limits.tool_calls.min(eff.max_tool_calls);
        limits.runtime = limits
            .runtime
            .min(Duration::from_secs(eff.max_runtime_secs));
    }
    let workspace_id = intent
        .workspace_id
        .clone()
        .ok_or_else(|| se("bad-intent", "this intent requires a workspace"))?;
    let client = b
        .store
        .load(run_id)
        .map(|r| r.run.client_id)
        .unwrap_or_default();
    // A6.1.4: a project opened from the Desktop starts every NEW task from its current
    // files (re-snapshot when the folder changed); already-running tasks keep their copy.
    // A direct run edits the folder itself, so there is nothing to refresh for it.
    let direct_kind = b
        .store
        .load(run_id)
        .is_some_and(|r| r.run.workspace_kind.as_deref() == Some("direct"));
    if mode == Mode::Code && !direct_kind {
        if let Some(env) = b.cfg.project_env() {
            crate::projects::ensure_fresh(&env, &workspace_id);
        }
    }
    // Resolved ONCE here: a registry change after this point cannot alter this run.
    let pool = match mode {
        Mode::Inspect => b.cfg.workspaces.clone(),
        Mode::Code => b.cfg.effective_code_sources(),
    };
    let ws = pool
        .iter()
        .find(|w| w.id == workspace_id)
        .filter(|w| {
            w.allowed_uids.is_empty()
                || uid_of(&client)
                    .map(|u| w.allowed_uids.contains(&u))
                    .unwrap_or(false)
        })
        .ok_or_else(|| {
            se(
                "workspace-not-allowed",
                "that workspace is not available to this client",
            )
        })?
        .clone();
    let mut policy = crate::code::resolve_policy(intent, &ws.write_allow);
    if mode == Mode::Code {
        let eff = b
            .cfg
            .code_caps
            .with_user_limits(&b.cfg.state_dir)
            .effective(b.cfg.interactive);
        policy.max_edits = policy.max_edits.min(eff.max_edits);
        policy.max_tests = policy.max_tests.min(eff.max_tests);
        // A7.1: a read-only request cannot change a file: the gate refuses every write.
        policy.read_only = b.store.load(run_id).is_some_and(|r| r.run.read_only);
        if policy.read_only {
            policy.max_edits = 0;
        }
    }
    b.update(run_id, |r| {
        r.state = "preparing".into();
        r.workspace_id = Some(workspace_id.clone());
        r.max_turns = limits.turns;
        r.max_tool_calls = limits.tool_calls;
        if mode == Mode::Code {
            r.max_edits = policy.max_edits;
            r.max_tests = policy.max_tests;
        }
    });
    if ctx.stop() {
        crate::pipeline::cancelled_before_submission(b, run_id);
        return Ok(());
    }
    // repo-code needs every daemon-side lock; check before creating anything.
    if mode == Mode::Code {
        let st = daemon(b, "status", serde_json::json!({}))?;
        let on = |k: &str| st.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
        if !(on("repoCodeEnabled")
            && on("writesEnabled")
            && on("processEnabled")
            && (on("approvalGated") || on("requireHumanApproval")))
        {
            return Err(se(
                "code-not-available",
                "the daemon is not configured for autonomous coding (repo-code, writes, processes and mandatory per-operation approval, human or automated policy, must all be enabled)",
            ));
        }
    }

    // 1. Controller task (kind repo-inspect) + Registry issuance, once.
    let ledger = b.cfg.ledger_workspace.to_string_lossy().into_owned();
    let task = {
        let _g = b.bridge_lock.lock().unwrap_or_else(|p| p.into_inner());
        bridge(b, "task-create", &[&ledger, mode.scope()], None)?
    };
    let (task_id, task_instance, attempt1, session_id) = (
        str_of(&task, "taskId")?,
        str_of(&task, "taskInstanceId")?,
        str_of(&task, "attemptId")?,
        str_of(&task, "sessionId")?,
    );
    b.update(run_id, |r| {
        r.task_id = Some(task_id.clone());
        r.task_instance_id = Some(task_instance.clone());
        r.attempt_id = Some(attempt1.clone());
    });
    let repo = b.cfg.repo_root.to_string_lossy().into_owned();
    let data = b.cfg.registry_data_root.to_string_lossy().into_owned();
    // R-NATIVE-2: the run's resolved target travels as the in-memory-only
    // bridge selection (route identity), so coding runs use the same target
    // as model-only runs; no silent fallback to the default.
    let mut issue_args: Vec<&str> = vec![&repo, &data, &task_instance, &session_id];
    let selection_json;
    if let Some(m) = &intent.model {
        let mut sel = serde_json::json!({
            "logicalModelId": m.logical_model_id.clone().unwrap_or_default(),
            "routeId": m.route_id.clone().unwrap_or_default(),
        });
        // EM-04C2 S4: an Engineering Mode choice, only when the client made one; the Registry
        // judges it against its closed table of reviewed modes
        if let Some(mode) = &m.mode_id {
            sel["modeId"] = serde_json::Value::String(mode.clone());
        }
        selection_json = serde_json::to_string(&sel).unwrap_or_default();
        issue_args.push(&selection_json);
    }
    let issued = bridge(b, "issue", &issue_args, None)?;
    let resolution = issued.get("resolution").cloned().unwrap_or_default();
    // EM-01: the Engineering Mode extension comes from the Registry resolution of this run -
    // the typed content whose digest is its issuanceId, i.e. exactly what the Kernel seals below
    // and binds every attempt to. An engine this runtime does not have, or one that differs from
    // the engine of the run this one continues, fails closed here, before any working copy,
    // grant or provider request exists.
    // EM-02: a continuation keeps the task binding of the run it continues (model, route,
    // provider, connection, endpoint, credential, mode, engine, default effort, request budget and
    // - EM-04C2 - the slot's reasoning policy) or fails closed. EM-04C2 S4: this is judged BEFORE
    // the engine is selected, so a continuation that changed mode (and therefore engine) is a
    // `task-binding-mismatch`, never an `engine-unavailable` that would hide the mode change.
    task_binding_continuity(b, run_id, &issued)?;
    let engine = engine_for_run(b, run_id, &resolution)?;
    // EM-03: the interrupted run's engine state is examined (authenticated, same engine, mode,
    // contract and schema) before this continuation creates anything; refused = nothing exists.
    if let Some(pred) = predecessor_of(b, run_id) {
        let mode = resolution
            .pointer("/target/modeId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        crate::engine_state::EngineStateStore::open(&b.cfg.state_dir)
            .and_then(|store| {
                crate::engine_state::examine_predecessor(&store, engine, mode, Some(pred))
            })
            .map_err(|e| se(e.code, e.message))?;
    }
    let extension = issued.get("extension").cloned().unwrap_or_default();
    let origin = extension
        .pointer("/endpoint/origin")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let provider_id = issued
        .pointer("/core/providerId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let remote_model_id = issued
        .pointer("/core/remoteModelId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let logical_model_id = issued
        .pointer("/core/logicalModelId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    // R-NATIVE-2: the bound target is checked against the issued target
    // every run; resolved route identity must match exactly.
    if let Some(m) = &intent.model {
        // the issued route identity lives in the compiled core (and resolution target), not in
        // the sealed extension
        let issued_route = issued
            .pointer("/core/routeId")
            .and_then(|v| v.as_str())
            .or_else(|| {
                issued
                    .pointer("/resolution/target/routeId")
                    .and_then(|v| v.as_str())
            })
            .unwrap_or("");
        let want_route = m.route_id.as_deref().unwrap_or("");
        let route_ok = want_route.is_empty() || want_route == issued_route;
        if m.provider_id != provider_id || m.remote_model_id != remote_model_id || !route_ok {
            return Err(se(
                "model-not-available",
                "the Registry target differs from the requested provider/model; no substitution",
            ));
        }
    }
    let sealed_out = extension
        .get("outputLimitTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let out_tokens = match (limits.output_tokens, sealed_out) {
        (_, 0) => limits.output_tokens.or(Some(DEFAULT_MAX_OUTPUT_TOKENS)),
        (r, l) => Some(crate::resolution::effective_output_cap(r, l).unwrap_or(l)),
    };
    let out_tokens = out_tokens.map(|n| if sealed_out > 0 { n.min(sealed_out) } else { n });
    // A6.1.4: a turn that ends at the output limit (reasoning tokens count against it)
    // may be re-asked with a larger cap, up to this ceiling. The interactive
    // authorization covers the ceiling; a strict (manual-record) run has none.
    let out_ceiling = if b.cfg.interactive {
        out_tokens.map(|n| {
            let c = n
                .saturating_mul(OUTPUT_ESCALATION_FACTOR)
                .min(crate::consent::MAX_OUTPUT_TOKENS);
            if sealed_out > 0 {
                c.min(sealed_out)
            } else {
                c
            }
        })
    } else {
        out_tokens
    };

    // 1b. repo-code: the isolated working copy, created by the daemon (trusted
    //     native code), BEFORE any authorization can be spent so that a dirty
    //     or ambiguous source repository burns nothing. The model never names
    //     this path; the Controller commits to its digest.
    let mut root = ws.root.to_string_lossy().into_owned();
    let mut created_worktree = false;
    // Direct Workspace: the kind was fixed on the run at submission (the project's durable choice then).
    let run_direct = mode == Mode::Code
        && b.store
            .load(run_id)
            .is_some_and(|r| r.run.workspace_kind.as_deref() == Some("direct"));
    if run_direct {
        // The task edits the project's REAL folder. The daemon names it from the trusted registry (we
        // pass a project id, never a path), re-validates it, records the task's identity outside the
        // folder and prepares the store that keeps every original before it is changed.
        let from_task = b
            .store
            .load(run_id)
            .and_then(|r| r.run.continuation_of)
            .and_then(|old| b.store.load(&old))
            .and_then(|o| o.run.task_instance_id);
        let mut params = serde_json::json!({ "taskInstanceId": task_instance, "projectId": ws.id });
        if let Some(f) = &from_task {
            params["fromTaskInstanceId"] = serde_json::json!(f);
        }
        let d = daemon(b, "direct-open", params)?;
        root = d
            .pointer("/direct/path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| se("daemon-shape", "direct-open returned no path"))?
            .to_owned();
        created_worktree = true;
        let external: Vec<String> = d
            .pointer("/direct/externalChanges")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let note = if external.is_empty() {
            "Edits go directly to your project folder; they are on disk as soon as each one is made."
                .to_owned()
        } else {
            format!(
                "Edits go directly to your project folder. {} file(s) the earlier run wrote were changed outside Nexus since ({}); this run reads their current content.",
                external.len(),
                external.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
            )
        };
        b.update(run_id, |r| {
            r.workspace_relation = Some("direct".into());
            r.workspace_note = Some(note);
        });
    } else if mode == Mode::Code {
        let registry_managed = b.cfg.project_registry.is_some();
        let wt = daemon(
            b,
            "worktree-create",
            match &ws.pinned_commit {
                Some(c) if registry_managed => {
                    serde_json::json!({ "taskInstanceId": task_instance, "projectId": ws.id, "expectedCommit": c })
                }
                Some(c) => {
                    serde_json::json!({ "taskInstanceId": task_instance, "sourceRoot": root, "expectedCommit": c })
                }
                None => serde_json::json!({ "taskInstanceId": task_instance, "sourceRoot": root }),
            },
        )?;
        root = wt
            .pointer("/worktree/path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| se("daemon-shape", "worktree-create returned no path"))?
            .to_owned();
        let commit = wt
            .pointer("/worktree/sourceCommit")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        created_worktree = true;
        b.update(run_id, |r| r.worktree_commit = commit);
        // A continuation of an interrupted task, or a follow-up in a conversation, starts from
        // the work already done (A7.1: even when the project's files moved on in between).
        let me = b.store.load(run_id).map(|r| r.run);
        let from_rec = me
            .as_ref()
            .and_then(|r| r.continuation_of.clone().or_else(|| r.seed_from.clone()))
            .and_then(|old| b.store.load(&old));
        let thread_follow = me.as_ref().is_some_and(|r| r.seed_from.is_some());
        let from = from_rec
            .as_ref()
            .and_then(|o| o.run.task_instance_id.clone());
        let from_n = me.as_ref().and_then(|r| {
            let (t, f) = (r.thread_id.as_ref()?, from_rec.as_ref()?);
            crate::threads::run_number(b, t, &f.run.run_id)
        });
        let mut relation: Option<(String, String)> = None;
        if let Some(from) = from {
            let seeded = daemon(
                b,
                "worktree-seed",
                serde_json::json!({ "taskInstanceId": task_instance, "fromTaskInstanceId": from, "rebase": true }),
            );
            match seeded {
                Ok(v) => {
                    let n = v.get("seeded").and_then(|x| x.as_u64()).unwrap_or(0);
                    let already = v
                        .get("alreadyApplied")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0);
                    let rel = v
                        .get("relation")
                        .and_then(|x| x.as_str())
                        .unwrap_or("continued");
                    let src = from_n
                        .map(|n| format!("run {n}"))
                        .unwrap_or_else(|| "the earlier run".into());
                    let note = if rel == "rebased" {
                        format!("Your project changed since {src}: {n} file(s) of its work were carried over, {already} were already in your folder.")
                    } else {
                        format!("Started from the working copy of {src}: {n} file(s) carried over.")
                    };
                    relation = Some((rel.to_owned(), note));
                }
                Err(e) => {
                    let had_changes = from_rec.as_ref().is_some_and(|o| {
                        !o.run.changed_files.is_empty()
                            || nexus_client::intent_client::derive_coding_outcome(&o.run)
                                .is_some_and(|c| c.edits_applied > 0)
                    });
                    // daemon refusals arrive as `daemon-<code>`
                    let code = e.code.strip_prefix("daemon-").unwrap_or(&e.code).to_owned();
                    if code == "not-found" && thread_follow && !had_changes {
                        // the earlier copy is gone but held no changes: nothing is lost
                        relation = Some((
                            "fresh".into(),
                            "The earlier working copy was no longer available; it held no changes, so this run starts from your project's current files.".into(),
                        ));
                    } else {
                        let _ = daemon(
                            b,
                            "worktree-remove",
                            serde_json::json!({ "taskInstanceId": task_instance }),
                        );
                        return Err(match code.as_str() {
                            "workspace-conflict" => se("workspace-conflict", e.message),
                            "not-found" => se(
                                "workspace-missing",
                                "the working copy holding this conversation's earlier changes is no longer available",
                            ),
                            _ => se(
                                "seed-failed",
                                format!("the earlier work could not be carried over: {}", e.message),
                            ),
                        });
                    }
                }
            }
        }
        if let Some((rel, note)) = relation {
            b.update(run_id, |r| {
                r.workspace_relation = Some(rel);
                r.workspace_note = Some(note);
            });
        } else if me
            .as_ref()
            .and_then(|r| r.workspace_relation.as_deref())
            .is_none()
        {
            b.update(run_id, |r| r.workspace_relation = Some("fresh".into()));
        }
    }
    let ws_digest = nexus_contracts::sha256_hex(&root);
    // Until a conversation exists nothing worth keeping has happened: a
    // failure removes the empty copy (afterwards it is retained for review).
    let discard = |why: StepError| -> StepError {
        if created_worktree {
            let _ = daemon(
                b,
                "worktree-remove",
                serde_json::json!({ "taskInstanceId": task_instance }),
            );
        }
        why
    };

    // 2. A real (https, production-transport) provider needs a bounded,
    //    operator-created SESSION authorization, consumed before any grant.
    if b.cfg.transport.is_none() && origin.starts_with("https://") {
        if crate::identity::self_stale() {
            return Err(discard(se(
                "broker-stale",
                "this broker process predates the installed nexus-broker binary; Nexus restarts it automatically when no task is running, then send again (nothing was sent, authorization kept)",
            )));
        }
        let attempt = crate::live_auth::SessionAttempt {
            intent_type: mode.scope(),
            provider_id: &provider_id,
            remote_model_id: &remote_model_id,
            workspace_id: &workspace_id,
            prompt: &intent.content,
            max_turns: limits.turns,
            max_tool_calls: limits.tool_calls,
            max_output_tokens: if b.cfg.interactive {
                out_ceiling
            } else {
                limits.output_tokens
            },
            max_tool_result_bytes: limits.result_bytes,
            direct: run_direct,
        };
        if b.cfg.interactive {
            // A6.1.4: issued by the broker from the standing user consent, per run, audited.
            crate::consent::authorize_run(&b.cfg.state_dir, &attempt, run_id)
                .map(|_| ())
                .map_err(|(c, m)| discard(se(c, m)))?;
        } else {
            crate::live_auth::consume_session(&b.cfg.state_dir, &attempt)
                .map(|_| ())
                .map_err(|(c, m)| discard(se(c, m)))?;
        }
    }
    if ctx.stop() {
        let _ = discard(se("cancelled", "cancelled"));
        crate::pipeline::cancelled_before_submission(b, run_id);
        return Ok(());
    }

    // 3. Kernel lease + seals, once for the whole task.
    let acquired = daemon(
        b,
        "acquire",
        serde_json::json!({ "taskInstanceId": task_instance, "backend": "native" }),
    )
    .map_err(discard)?;
    let lease_epoch = acquired
        .pointer("/lease/leaseEpoch")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| se("daemon-shape", "acquire returned no lease epoch"))?;
    let incarnation = acquired
        .pointer("/lease/storeIncarnation")
        .and_then(|v| v.as_str())
        .ok_or_else(|| se("daemon-shape", "acquire returned no store incarnation"))?
        .to_owned();
    daemon(b, "seal", serde_json::json!({ "resolution": resolution })).map_err(discard)?;
    let sealed = daemon(
        b,
        "seal-extension",
        serde_json::json!({ "extension": extension }),
    )
    .map_err(discard)?;
    let extension_digest = str_of(&sealed, "extensionDigest")?;
    // EM-02: the task's immutable binding, sealed by the Kernel before any attempt exists. Every
    // attempt's target is checked against it (Kernel publish/accept, executor dispatch).
    let task_target = crate::attempt_target::TaskTarget::seal(b, &issued, &extension_digest)
        .map_err(|e| discard(e.into()))?;
    if !b.bind_task_target(
        run_id,
        &task_target.binding_digest,
        &task_target.identity_digest(),
        crate::attempt_target::IDENTITY_VERSION,
    ) {
        return Err(discard(se(
            "task-binding-unrecorded",
            "the run's task binding could not be recorded; nothing was sent",
        )));
    }
    // EM-03: the run's durable, task-owned engine state, created before any attempt exists. A
    // continuation carries the interrupted run's lineage (and, for an inheriting engine, its
    // validated payload); anything unauthenticated or foreign fails closed here.
    #[cfg(feature = "test-engines")]
    crate::engine::test_faults::bind(&intent.idempotency_key, &task_instance);
    let predecessor = predecessor_of(b, run_id);
    // EM-04C2 S10: a crash here leaves a run that is bound to its engine but has no engine state yet
    #[cfg(feature = "test-engines")]
    crate::engine::test_faults::crash(&intent.idempotency_key, "before-engine-state");
    let bound_mode = task_target
        .binding
        .target
        .get("modeId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let mut engine_run = crate::engine_state::EngineStateStore::open(&b.cfg.state_dir)
        .and_then(|store| {
            crate::engine_state::EngineRun::start(
                store,
                engine,
                run_id,
                &task_instance,
                &bound_mode,
                &task_target.binding_digest,
                task_target.default_effort(),
                predecessor,
            )
        })
        .map_err(|e| discard(se(e.code, e.message)))?;
    if !b.mark_engine_state_started(run_id) {
        return Err(discard(se(
            "engine-state-unpersisted",
            "the run's engine state could not be recorded as started; nothing was sent",
        )));
    }
    // EM-04A: only the shadow Governor engines are lent the historical Muse policy (a bounded,
    // pure Node bridge); every other engine runs exactly as in EM-03.
    // EM-04B: only the experimental signals engine, in a coding run, offers the signals tool.
    let mut worker_lease: Option<crate::engine::worker_bridge::WorkerLease> = None;
    // EM-04C1: the catalog follows the sealed engine identity and nothing else; this build must
    // offer exactly that catalog's frozen bytes, and the run records which one it was offered.
    let catalog_profile =
        crate::engine::tool_catalog_profile(engine.descriptor().engine_id, mode == Mode::Code);
    if !nexus_model::repo_tools::verify_catalog(catalog_profile) {
        return Err(discard(se(
            "tool-catalog-mismatch",
            "this build's tool catalog is not the frozen one for the run's engine; nothing was sent",
        )));
    }
    if !b.bind_tool_catalog(
        run_id,
        nexus_model::repo_tools::frozen_catalog_digest(catalog_profile),
    ) {
        return Err(discard(se(
            "tool-catalog-mismatch",
            "the run is already bound to another tool catalog, or the binding could not be recorded; nothing was sent",
        )));
    }
    let signals_run = catalog_profile == nexus_model::ToolProfile::RepoCodeMuseSignalsV1;
    if [
        crate::engine::muse_v1::ENGINE_ID,
        crate::engine::muse_v1::SIGNALS_ENGINE_ID,
        crate::engine::muse_v1::ACTIVE_ENGINE_ID,
    ]
    .contains(&engine.descriptor().engine_id)
    {
        // EM-04C1: ONE supervised, persistent worker owned by this run (scope = the task
        // generation, cancelled with the run, killed when the lease below drops). Logically
        // stateless: the engine state, not the worker, is the ledger.
        // EM-04C2 S1: the worker count is bounded by this broker's `max_active` (never above 16)
        // and the process is started under Node's deny-all permission mode, proven at hand-shake.
        let worker = std::sync::Arc::new(
            crate::engine::worker_bridge::WorkerGovernorBridge::with_config(
                crate::engine::worker_bridge::WorkerConfig::new(b.node_abs.clone())
                    .with_slots(std::sync::Arc::clone(&b.worker_slots)),
                task_instance.clone(),
                std::sync::Arc::clone(flag),
            ),
        );
        worker_lease = Some(crate::engine::worker_bridge::WorkerLease::new(
            std::sync::Arc::clone(&worker),
        ));
        engine_run.env.governor = Some(worker);
    }

    let opts = ModelRunOptions {
        cap_path: b.cfg.cap_path.clone(),
        credentials_path: b.cfg.credentials_path.clone(),
        limits: b.cfg.limits,
        transport: b.cfg.transport.clone(),
    };
    let cfg = b.client_config();
    let mut session = InspectSession::begin(
        &cfg,
        &task_instance,
        &intent.content,
        &InspectBasics {
            mode: mode.scope(),
            provider_id: provider_id.clone(),
            remote_model_id: remote_model_id.clone(),
            logical_model_id: logical_model_id.clone(),
            endpoint_origin: origin.clone(),
            workspace_id: workspace_id.clone(),
        },
    )
    .map_err(|e| discard(se(e.code, e.message)))?;
    let conv = session.conversation_id().to_owned();
    let bound_route = intent.model.as_ref().and_then(|m| m.route_id.clone());
    let bound_conn = b
        .store
        .load(run_id)
        .and_then(|r| r.run.connection_id.clone());
    let bound_ctx = extension.get("contextLimitTokens").and_then(|v| v.as_u64());
    let bound_out = extension.get("outputLimitTokens").and_then(|v| v.as_u64());
    b.update(run_id, |r| {
        r.conversation_id = Some(conv.clone());
        r.provider_id = Some(provider_id.clone());
        r.remote_model_id = Some(remote_model_id.clone());
        r.logical_model_id = Some(logical_model_id.clone());
        if r.route_id.is_none() {
            r.route_id = bound_route.clone();
        }
        if r.connection_id.is_none() {
            r.connection_id = bound_conn.clone();
        }
        if r.context_limit_tokens.is_none() {
            r.context_limit_tokens = bound_ctx;
        }
        if r.output_limit_tokens.is_none() {
            r.output_limit_tokens = bound_out;
        }
        r.endpoint_kind = Some(session.endpoint_kind().to_owned());
    });
    if flag.load(Ordering::SeqCst) {
        let _ = nexus_client::request_model_cancel(&cfg, &conv);
    }

    // From here a conversation exists: every exit records a terminal state.
    let me = b.store.load(run_id).map(|r| r.run);
    let read_only = me.as_ref().is_some_and(|r| r.read_only);
    let carried_work = me
        .as_ref()
        .and_then(|r| r.continuation_of.clone().or_else(|| r.seed_from.clone()))
        .and_then(|id| b.store.load(&id))
        .is_some_and(|o| !o.run.changed_files.is_empty());
    let mut loop_state = LoopState {
        mode_code: mode == Mode::Code,
        carried_work,
        expects_change: mode == Mode::Code
            && b.cfg.interactive
            && !read_only
            && (crate::completion::expects_change(&intent.content)
                || (crate::completion::is_continuation(&intent.content)
                    && crate::threads::continued_request_expects_change(b, run_id))),
        ..Default::default()
    };
    let bound_ctx_u64 = extension
        .get("contextLimitTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let expected = intent.model.as_ref().map(|m| nexus_client::ExpectedTarget {
        provider_id: m.provider_id.clone(),
        remote_model_id: m.remote_model_id.clone(),
    });
    let ctx_budget = crate::resolution::effective_context_budget(
        b.cfg
            .context_budget_bytes
            .unwrap_or(crate::context::COMPACT_BYTES),
        bound_ctx_u64,
    );
    let _ = ctx_budget;
    let bound_out_cap = crate::resolution::effective_output_cap(None, sealed_out);
    let _ = bound_out_cap;
    let result = turn_loop(
        &ctx,
        &mut session,
        &opts,
        &limits,
        out_tokens,
        out_ceiling,
        &started,
        &Shared {
            mode,
            policy,
            intent,
            task_id: &task_id,
            task_instance: &task_instance,
            session_id: &session_id,
            issued: &issued,
            task_target: &task_target,
            lease_epoch,
            incarnation: &incarnation,
            ws_digest: &ws_digest,
            root: &root,
            direct: run_direct,
            expected: expected.clone(),
            ctx_budget,
            signals: signals_run,
            profile: catalog_profile,
        },
        &mut loop_state,
        &mut engine_run,
    );
    // EM-03: the run's end is part of its durable engine state
    let how = match &result {
        Ok(LoopEnd::Completed) => "completed".to_owned(),
        Ok(LoopEnd::Limit(l)) => format!("limit {l}"),
        Ok(LoopEnd::Cancelled) => "cancelled".to_owned(),
        Ok(LoopEnd::Recorded) => "ended by the executor".to_owned(),
        Ok(LoopEnd::Failed(c, _)) => format!("failed {c}"),
        Ok(LoopEnd::Uncertain(c, _)) => format!("uncertain {c}"),
        Err(e) => format!("error {}", e.code),
    };
    // The run record (written by `finalize`) holds the authoritative completion verdict; the
    // engine record's end is written AFTER it, so engine state can never claim an end the run
    // record does not have. If that last write fails, the record simply lacks its end (the last
    // attempt then reads as unresolved, never re-sent); the verdict is unaffected.
    finalize(&ctx, &mut session, &cfg, &loop_state, result);
    #[cfg(feature = "test-engines")]
    crate::engine::test_faults::crash(&intent.idempotency_key, "after-finalize");
    if let Err(e) = engine_run.finish(&how) {
        eprintln!(
            "[broker] run {run_id}: the engine state could not record the end of the run ({}): {}",
            e.code, e.message
        );
    }
    // EM-04C1: the run's Governor worker ends with the run, after its last durable write
    drop(worker_lease);
    Ok(())
}

struct Shared<'a> {
    mode: Mode,
    #[allow(dead_code)]
    policy: CodePolicy,
    intent: &'a NexusIntentV1,
    task_id: &'a str,
    task_instance: &'a str,
    session_id: &'a str,
    issued: &'a Value,
    /// EM-02: the task binding and the task's own target; every attempt's target comes from it.
    task_target: &'a crate::attempt_target::TaskTarget,
    lease_epoch: u64,
    incarnation: &'a str,
    ws_digest: &'a str,
    root: &'a str,
    /// Direct Workspace: `root` is the project's real folder (the bind names the direct task).
    direct: bool,
    #[allow(dead_code)]
    expected: Option<nexus_client::ExpectedTarget>,
    ctx_budget: usize,
    /// EM-04B: the run's engine takes reasoning signals (the experimental `muse-v1-signals`
    /// engine in a coding run); its catalog then carries the signals tool.
    signals: bool,
    /// The tool catalog every request of this run offers.
    profile: nexus_model::ToolProfile,
}

#[derive(Default)]
struct LoopState {
    /// Turns whose conversation was shortened by the context manager (A6.1.4).
    compactions: u32,
    /// Provider interruptions recovered from (autonomy-first refactor).
    recoveries: u32,
    activity: Vec<ToolActivity>,
    /// EM-04A: trusted activity observations derived from `activity` receipts (engine feed).
    observations: Vec<crate::engine::ActivityObservation>,
    /// EM-04B: validated reasoning signals (model claims; kept apart from `observations`).
    signals: Vec<crate::engine::SignalObservation>,
    turns: u32,
    tool_calls: u32,
    result_bytes: u64,
    usage_in: u64,
    usage_out: u64,
    saw_usage: bool,
    final_text: String,
    last_output: Option<TurnOutput>,
    citations_verified: Vec<String>,
    citations_unverified: Vec<String>,
    // ---- repo-code ----
    /// Latest whole-file sha256 a tool reported per path (read result or the
    /// post-image of an approved edit): the pre-image the next edit is pinned to.
    last_sha: BTreeMap<String, String>,
    edits_used: u32,
    tests_used: u32,
    write_bytes: u64,
    last_test: Option<String>,
    /// A file was changed after the last verification command (or none ran yet).
    dirty_since_test: bool,
    /// Files this run created and has not deleted (to catch scratch files left behind).
    created: std::collections::BTreeSet<String>,
    mode_code: bool,
    /// The request asks for an implementation (decided from its text, read-only runs never).
    expects_change: bool,
    /// The copy already holds changes of earlier runs (a continuation / follow-up): a run that
    /// only verifies them is legitimately edit-free and tool-free.
    carried_work: bool,
    /// Verification commands (by `completion::check_identity`) whose latest result is a failure, with the
    /// command line for the model's feedback. A later pass of the SAME check clears it (the same command, or
    /// one differing only in output flags); a pass of a different or narrower command does not.
    failed_checks: std::collections::BTreeMap<String, String>,
    /// Distinct checks (identity -> command line) that passed since the last file change.
    passed_checks: std::collections::BTreeMap<String, String>,
    /// Failures resolved so far: a pass whose identity matched a recorded failure.
    resolved_checks: u32,
    completion: Option<&'static str>,
    /// A turn was spent asking the model to write its working memory; its answer is that memory.
    memory_requested: bool,
    memory_tries: u32,
    memories: u32,
}

/// How the loop ended (a terminal state is ALWAYS recorded by `finalize`).
enum LoopEnd {
    Completed,
    Limit(&'static str),
    Cancelled,
    /// The executor already recorded the terminal state.
    Recorded,
    Failed(String, String),
    /// A write/process may or may not have happened (lost answer).
    Uncertain(String, String),
}

impl Ctx<'_> {
    fn stop(&self) -> bool {
        self.flag.load(Ordering::SeqCst) || self.b.shutdown.load(Ordering::SeqCst)
    }
    fn progress(&self, ls: &LoopState, state: &str) {
        let activity = ls.activity.clone();
        self.b.update(self.run_id, |r| {
            r.state = state.to_owned();
            r.turn = ls.turns;
            r.tool_calls = ls.tool_calls;
            r.tool_result_bytes = ls.result_bytes;
            let skip = activity.len().saturating_sub(MAX_ACTIVITY);
            r.tool_activity = activity.into_iter().skip(skip).collect();
        });
    }
}

/// The Controller refused another attempt of this task (its bound on provider requests).
pub(crate) fn is_attempt_limit(code: &str) -> bool {
    code == "too-many-attempts" || code.ends_with("too-many-attempts")
}

/// What the runtime itself recorded so far (never model text): files changed and the last
/// command with its verdict. Used when old steps are dropped from the conversation.
pub(crate) fn receipts_summary(activity: &[ToolActivity]) -> String {
    let mut files: Vec<String> = Vec::new();
    let mut last_cmd: Option<String> = None;
    let mut refused = 0;
    for a in activity {
        match (a.tool.as_str(), a.status.as_str()) {
            ("fs_edit" | "fs_write", "executed") => {
                let f = a
                    .args_summary
                    .split_whitespace()
                    .last()
                    .unwrap_or("?")
                    .to_owned();
                if !files.contains(&f) {
                    files.push(f);
                }
            }
            ("proc_run", "executed") => {
                last_cmd = Some(format!(
                    "{} -> {}",
                    a.args_summary,
                    a.verification.as_deref().unwrap_or("no verdict")
                ));
            }
            (_, "refused") => refused += 1,
            _ => {}
        }
    }
    let mut s = String::new();
    if files.is_empty() {
        s.push_str("no file has been changed yet; ");
    } else {
        s.push_str(&format!("files changed so far: {}; ", files.join(", ")));
    }
    match last_cmd {
        Some(c) => s.push_str(&format!("last command: {c}; ")),
        None => s.push_str("no command has run yet; "),
    }
    if refused > 0 {
        s.push_str(&format!("{refused} proposed operation(s) were refused; "));
    }
    s.trim_end().to_owned() + "."
}

/// EM-01: the run's engine, from its Registry resolution, and bound to the run record.
///
/// * The identity is read from the TYPED resolution, only after its content digest was checked
///   against its issuanceId (the Kernel seals that issuanceId and refuses any attempt whose
///   intent disagrees with it), so the engine is the one the Registry issued and the Kernel seals.
/// * A continuation (after an interruption or a broker restart) is a new run with a fresh
///   issuance; it must resolve to the SAME engine as the run it continues. Records written before
///   EM-01 carry no engine: they ran the inline loop that `muse-v0` reproduces exactly (see the
///   EM-01 parity evidence), so they continue only as `muse-v0`.
/// * The identity is recorded once, before anything is sent; if it cannot be recorded, or a
///   different one is already recorded, the run fails closed.
fn engine_for_run(
    b: &Broker,
    run_id: &str,
    resolution: &Value,
) -> Result<&'static dyn crate::engine::EngineExtension, StepError> {
    let (engine, mode_id) =
        crate::engine::resolve_issued(resolution).map_err(|r| se(r.code, r.message))?;
    let id = engine.descriptor().engine_id;
    // EM-04C2 S6: an engine whose mode needs a Registry-sealed request-size budget (the adaptive
    // engine) never dispatches without one. Judged from the SEALED resolution, before the run is
    // bound to the engine, before any Kernel lease, engine state, working copy or request exists.
    if engine.requires_sealed_request_budget()
        && !resolution
            .pointer("/target/requestBudgetBytes")
            .and_then(|v| v.as_u64())
            .is_some_and(|n| n > 0 && n <= crate::request_budget::MAX_REQUIRED_SEALED_BUDGET_BYTES)
    {
        return Err(se(
            "engine-budget-required",
            format!(
                "mode '{mode_id}' runs engine '{id}', which must not dispatch without a Registry-sealed request-size budget of 1 to 450000 bytes, and this resolution carries none (or one outside that range); nothing was sent"
            ),
        ));
    }
    let me = b.store.load(run_id);
    if let Some(prev) = me
        .as_ref()
        .and_then(|r| r.run.continuation_of.clone())
        .and_then(|old| b.store.load(&old))
    {
        let was = prev
            .engine_id
            .as_deref()
            .unwrap_or(crate::engine::LEGACY_NATIVE_ENGINE);
        let was_mode = prev.engine_mode_id.as_deref().unwrap_or(&mode_id);
        if was != id || was_mode != mode_id {
            return Err(se(
                "engine-continuity-mismatch",
                format!(
                    "this run continues one that ran under another Engineering Mode engine than the one the Registry now selects ('{id}'); nothing was sent"
                ),
            ));
        }
    }
    if let Some(have) = me.as_ref().and_then(|r| r.engine_id.as_deref()) {
        if have != id {
            return Err(se(
                "engine-continuity-mismatch",
                "this run is already bound to another engine; nothing was sent",
            ));
        }
    }
    if !b.bind_engine(run_id, &mode_id, id) {
        return Err(se(
            "engine-binding-unrecorded",
            "the run's engine binding could not be recorded; nothing was sent",
        ));
    }
    Ok(engine)
}

/// EM-04C2 S10 (SEC-1): whether a run record shows any sign that a model attempt may have been
/// dispatched. Deliberately conservative: only a record that never got past `executing`, with no
/// turn (the turn counter is persisted BEFORE the request leaves, `ctx.progress`), HTTP status,
/// provider id or usage, is proven undispatched. The pipeline's own request digest is set before
/// the engine exists and is therefore no evidence either way. Broker-owned facts only; nothing the
/// model wrote is consulted.
fn may_have_dispatched(r: &crate::store::RunRecord) -> bool {
    let run = &r.run;
    let quiet_state = matches!(
        run.state.as_str(),
        "received" | "preparing" | "authorized" | "executing" | "rejected" | "refused"
    );
    !(quiet_state
        && run.turn == 0
        && run.http_status.is_none()
        && run.provider_request_id.is_none()
        && run.provider_response_id.is_none()
        && run.usage_input_tokens.is_none()
        && run.usage_output_tokens.is_none())
}

fn predecessor_node(r: &crate::store::RunRecord) -> crate::engine_state::Predecessor {
    crate::engine_state::Predecessor {
        run_id: r.run.run_id.clone(),
        task_instance_id: r.run.task_instance_id.clone(),
        bound_engine: r.engine_id.clone(),
        // spent-or-unknown: a dispatch sign, an engine state that existed (and is now gone), or a
        // record that predates the marker (`None`) and so cannot say
        may_have_dispatched: may_have_dispatched(r) || r.engine_state_started != Some(false),
        ancestors: Vec::new(),
        chain_complete: true,
    }
}

/// EM-03: the run this one continues (after an interruption or a restart), if any, with (SEC-1) the
/// bounded chain of older runs behind it, so a continuation can prove that a missing engine record
/// means "nothing was ever spent" rather than "the record was lost".
fn predecessor_of(b: &Broker, run_id: &str) -> Option<crate::engine_state::Predecessor> {
    let mut next = b.store.load(run_id).and_then(|r| r.run.continuation_of)?;
    let mut nodes: Vec<crate::engine_state::Predecessor> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    seen.insert(run_id.to_owned());
    let mut complete = true;
    loop {
        if !seen.insert(next.clone()) || nodes.len() >= crate::engine_state::MAX_CHAIN_DEPTH {
            complete = false; // a cycle or an over-long chain is never "empty history"
            break;
        }
        match b.store.load(&next) {
            Some(rec) => {
                let up = rec.run.continuation_of.clone();
                nodes.push(predecessor_node(&rec));
                match up {
                    Some(u) => next = u,
                    None => break,
                }
            }
            None => {
                // the run record itself is gone: unknown, not empty
                nodes.push(crate::engine_state::Predecessor::new(next.clone(), None));
                complete = false;
                break;
            }
        }
    }
    let mut it = nodes.into_iter();
    let mut head = it.next()?;
    head.ancestors = it.collect();
    head.chain_complete = complete;
    Some(head)
}

/// EM-02: a continuation (after an interruption or a broker restart) is a new task generation
/// with a fresh issuance; it must keep the binding identity of the run it continues. Records
/// written before EM-02 carry no identity: their recorded model, route, provider and connection
/// must all be present and equal, or the continuation fails closed.
fn task_binding_continuity(b: &Broker, run_id: &str, issued: &Value) -> Result<(), StepError> {
    let binding: nexus_contracts::TaskBindingV1 = serde_json::from_value(
        issued.get("taskBinding").cloned().unwrap_or_default(),
    )
    .map_err(|_| {
        se(
            "task-binding-unavailable",
            "the Registry issued no valid task binding; nothing was sent",
        )
    })?;
    let Some(prev) = b
        .store
        .load(run_id)
        .and_then(|r| r.run.continuation_of)
        .and_then(|old| b.store.load(&old))
    else {
        return Ok(());
    };
    let refuse = || {
        se(
            "task-binding-mismatch",
            "this run continues one that was bound to another model, route, connection or effort; nothing was sent",
        )
    };
    match prev.task_binding_identity.as_deref() {
        Some(id) => {
            if !crate::attempt_target::identity_matches(
                id,
                prev.task_binding_identity_version,
                &binding,
            ) {
                return Err(refuse());
            }
        }
        None => {
            let t = &binding.target;
            let same = |recorded: &Option<String>, key: &str| {
                recorded
                    .as_deref()
                    .is_some_and(|r| t.get(key).and_then(|v| v.as_str()) == Some(r))
            };
            if !(same(&prev.run.provider_id, "providerId")
                && same(&prev.run.remote_model_id, "remoteModelId")
                && same(&prev.run.logical_model_id, "logicalModelId")
                && same(&prev.run.route_id, "routeId")
                && same(&prev.run.connection_id, "connectionId"))
            {
                return Err(refuse());
            }
        }
    }
    Ok(())
}

/// The read-only facts an Engineering Mode extension may see at a hook: the runtime's receipts
/// and the Controller's classification of the request. No handle, grant, credential, target or
/// path beyond the names of files this run created.
fn engine_snapshot(
    ls: &LoopState,
    sh: &Shared<'_>,
    er: &crate::engine_state::EngineRun,
    dispatches: u32,
    interactive: bool,
    turn: u32,
    response_text: &str,
) -> crate::engine::EngineSnapshot {
    crate::engine::EngineSnapshot {
        kind: Some(match sh.mode {
            Mode::Code => crate::engine::RunKind::Code,
            Mode::Inspect => crate::engine::RunKind::Inspect,
        }),
        interactive,
        turn,
        tool_calls: ls.tool_calls,
        edits_used: ls.edits_used,
        tests_used: ls.tests_used,
        applied_edits: applied_edits(ls),
        last_test: ls.last_test.clone(),
        dirty_since_test: ls.dirty_since_test,
        failed_checks: ls.failed_checks.len() as u32,
        resolved_checks: ls.resolved_checks,
        unresolved_checks: ls.failed_checks.values().take(8).cloned().collect(),
        passed_checks: ls.passed_checks.values().take(8).cloned().collect(),
        created_files: ls.created.iter().cloned().collect(),
        expects_change: ls.expects_change,
        carried_work: ls.carried_work,
        response_text: response_text.to_owned(),
        attempts_dispatched: dispatches,
        current_effort: er
            .host
            .effort_for_attempt(dispatches + 1)
            .unwrap_or(sh.task_target.default_effort())
            .to_owned(),
        authorized_efforts: sh.task_target.binding.supported_reasoning.clone(),
        generation: sh.task_instance.to_owned(),
        activity: ls.observations.clone(),
        signals: ls.signals.clone(),
    }
}

/// EM-04B: one call of the reasoning-signals tool (broker-handled control-plane input, never a
/// Kernel tool). Strict historical validation first; a refused signal records nothing. A valid one
/// becomes a `SignalObservation` with the Core's own identity facts, the engine applies it through
/// the historical path, the host validates the transition and the new state is committed DURABLY
/// before the acknowledgement is returned to the model. A failed acceptance fails the run closed.
#[allow(clippy::too_many_arguments)]
fn signal_call(
    sh: &Shared<'_>,
    ls: &mut LoopState,
    er: &mut crate::engine_state::EngineRun,
    act: &mut ToolActivity,
    args: &Value,
    args_len: usize,
    attempt: u32,
    interactive: bool,
    turn: u32,
) -> Result<Rendered, LoopEnd> {
    let tool = crate::signals::TOOL;
    act.tool = tool.to_owned();
    if let Err(r) = crate::signals::validate(args, args_len) {
        act.status = "refused".into();
        act.error_code = Some(r.code.to_owned());
        act.args_summary = "invalid signal".into();
        return Ok(render_error(tool, r.code, &r.message));
    }
    act.args_summary = crate::signals::summary(args);
    ls.signals.push(crate::engine::SignalObservation {
        seq: act.index,
        attempt,
        generation: sh.task_instance.to_owned(),
        call_id: act.call_id.clone(),
        dispatch_key: crate::signals::dispatch_key(sh.task_instance, attempt, &act.call_id, args),
        signal: args.clone(),
    });
    fault(sh, "before-signal-accept");
    let snap = engine_snapshot(ls, sh, er, attempt, interactive, turn, "");
    let ack = er
        .consult_signal(&snap)
        .map_err(|e| LoopEnd::Failed(e.code.into(), e.message))?;
    fault(sh, "after-signal-accept");
    let ack: Value = serde_json::from_str(&ack).unwrap_or(Value::Null);
    if ack["ok"] != true {
        act.status = "failed".into();
        let code = ack["code"]
            .as_str()
            .unwrap_or("signal-not-recorded")
            .to_owned();
        act.error_code = Some(code.clone());
        return Ok(render_error(
            tool,
            &code,
            "the reasoning signal was not recorded; nothing changed",
        ));
    }
    act.status = "executed".into();
    let text = crate::signals::render_ack(&ack);
    Ok(Rendered {
        digest: digest_of(&text),
        text,
        is_error: false,
        truncated: false,
    })
}

/// EM-04A: the trusted observation an executed tool call yields, from the Core's own receipt
/// (status, Kernel execution id, Native verification verdict) - never from model text. Refused,
/// failed, uncertain or cancelled calls, reads and non-verification commands yield none.
pub(crate) fn observe(
    act: &ToolActivity,
    verification_command: bool,
    attempt: u32,
    generation: &str,
) -> Option<crate::engine::ActivityObservation> {
    use crate::engine::{ObservationKind, VerificationOutcome};
    if act.status != "executed" {
        return None;
    }
    let execution_id = act.execution_id.clone().filter(|e| !e.is_empty())?;
    let kind = match act.tool.as_str() {
        "fs_write" | "fs_edit" => ObservationKind::Mutation,
        "proc_run" if verification_command => ObservationKind::Verification {
            outcome: match act.verification.as_deref() {
                Some("pass") => VerificationOutcome::Passed,
                Some("fail") => VerificationOutcome::Failed,
                Some("unverified") => VerificationOutcome::Started,
                _ => return None,
            },
            family: act
                .args_summary
                .split_whitespace()
                .next()
                .unwrap_or("")
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                .take(32)
                .collect(),
        },
        _ => return None,
    };
    Some(crate::engine::ActivityObservation {
        seq: act.index,
        attempt,
        generation: generation.to_owned(),
        execution_id,
        kind,
    })
}

/// EM-03 TEST-ONLY crash point (feature `test-engines`; a no-op in production builds).
#[allow(unused_variables)]
fn fault(sh: &Shared<'_>, point: &str) {
    #[cfg(feature = "test-engines")]
    crate::engine::test_faults::crash(&sh.intent.idempotency_key, point);
}

/// Edits and writes that really executed in this run (receipts, not proposals).
fn applied_edits(ls: &LoopState) -> u32 {
    ls.activity
        .iter()
        .filter(|a| matches!(a.tool.as_str(), "fs_edit" | "fs_write") && a.status == "executed")
        .count() as u32
}

/// Reasoning items replayed at most (the latest ones; older ones are dropped first).
pub const REASONING_REPLAY_ITEMS: usize = 12;

/// The model's own reasoning from its latest responses goes back with the next request, before
/// that response's messages and calls - as DSH's adapter does. Without it the model loses its
/// chain of thought at every tool call and re-derives it (CCv2 RC1 incident on this route). Only
/// the most recent items are kept: a long run would otherwise carry megabytes of opaque data.
fn push_model_reasoning(items: &mut Vec<InputItem>, out: &nexus_client::TurnOutput) {
    for r in &out.reasoning {
        items.push(InputItem::Reasoning { item: r.clone() });
    }
    let mut extra = items
        .iter()
        .filter(|i| matches!(i, InputItem::Reasoning { .. }))
        .count()
        .saturating_sub(REASONING_REPLAY_ITEMS);
    items.retain(|i| {
        if extra > 0 && matches!(i, InputItem::Reasoning { .. }) {
            extra -= 1;
            return false;
        }
        true
    });
}

/// Characters of one response's text that are replayed to the model.
pub const REPLAYED_TEXT_CHARS: usize = 8 * 1024;

/// Replay the model's own text exactly as the provider labelled it. A phase-aware model
/// (`phase: commentary` on the short preamble before a tool call) reads an UNLABELLED assistant
/// message as a final answer; replaying its preambles that way taught it to stop after an
/// announcement (R-NATIVE-3 run 14: 14 of 20 replays of the real history stalled with the labels
/// dropped, 0 of 20 with them kept). Text the provider did not label stays a plain assistant
/// message, as before. The replayed text keeps the same total bound as before.
fn push_model_text(items: &mut Vec<InputItem>, out: &nexus_client::TurnOutput) {
    let labelled = out.messages.iter().any(|m| m.phase.is_some());
    if !labelled {
        if !out.text.trim().is_empty() {
            items.push(InputItem::Message {
                role: "assistant".into(),
                content: out.text.chars().take(REPLAYED_TEXT_CHARS).collect(),
            });
        }
        return;
    }
    let mut left = REPLAYED_TEXT_CHARS;
    for m in &out.messages {
        if left == 0 {
            break;
        }
        if m.text.trim().is_empty() {
            continue;
        }
        let content: String = m.text.chars().take(left).collect();
        left -= content.chars().count();
        items.push(match &m.phase {
            Some(phase) => InputItem::AssistantPhase {
                phase: phase.clone(),
                content,
            },
            None => InputItem::Message {
                role: "assistant".into(),
                content,
            },
        });
    }
}

/// TEST ONLY: `NEXUS_FAULT_INJECT_DISPATCHES=3,7` loses the answer of the 3rd and 7th
/// provider request of a run (after the provider really answered).
fn fault_injected(dispatch: u32) -> bool {
    std::env::var("NEXUS_FAULT_INJECT_DISPATCHES")
        .ok()
        .is_some_and(|v| {
            v.split(',')
                .filter_map(|x| x.trim().parse::<u32>().ok())
                .any(|n| n == dispatch)
        })
}

/// A provider interruption in the interactive profile: record it, wait with bounded
/// backoff (cancellable) and let the caller ask again. `Some(end)` = stop the run.
fn recover_wait(
    ctx: &Ctx<'_>,
    session: &mut InspectSession,
    ls: &mut LoopState,
    failures: u32,
    code: &str,
    why: &str,
) -> Result<Option<LoopEnd>, StepError> {
    if failures >= crate::recovery::BREAKER_AFTER {
        return Ok(Some(LoopEnd::Failed(
            "provider-unavailable".into(),
            format!(
                "the provider failed {failures} times in a row (last: {code}); the work so far is kept in the working copy and the transcript"
            ),
        )));
    }
    let wait = crate::recovery::backoff(failures);
    ls.recoveries += 1;
    let (n, msg) = (
        ls.recoveries,
        format!("{code}: {}", why.chars().take(320).collect::<String>()),
    );
    ctx.b.update(ctx.run_id, |r| {
        r.recoveries = n;
        r.last_recovery = Some(msg.clone());
    });
    let _ = session.state(
        nexus_client::model_run::ModelRunState::ToolRunning,
        &format!(
            "The provider connection was interrupted ({code}). Everything done so far is kept; asking again in {}s (recovery {n}).",
            wait.as_secs()
        ),
        None,
    );
    let end = Instant::now() + wait;
    while Instant::now() < end {
        if ctx.stop() {
            return Ok(Some(LoopEnd::Cancelled));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Ok(None)
}

/// Wait (bounded, cancellable) until the tool daemon answers again.
fn wait_for_daemon(ctx: &Ctx<'_>, max_secs: u64) -> bool {
    let end = Instant::now() + std::time::Duration::from_secs(max_secs);
    while Instant::now() < end {
        if ctx.stop() {
            return false;
        }
        if daemon(ctx.b, "status", serde_json::json!({})).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
    false
}

#[allow(clippy::too_many_arguments)]
fn turn_loop(
    ctx: &Ctx<'_>,
    session: &mut InspectSession,
    opts: &ModelRunOptions,
    limits: &Limits,
    out_tokens: Option<u64>,
    out_ceiling: Option<u64>,
    started: &Instant,
    sh: &Shared<'_>,
    ls: &mut LoopState,
    er: &mut crate::engine_state::EngineRun,
) -> Result<LoopEnd, StepError> {
    let b = ctx.b;
    let ledger = b.cfg.ledger_workspace.to_string_lossy().into_owned();
    // A6.1.4: harness context + detected project kinds travel with the first user turn
    // (the task text itself, recorded and digest-bound, is unchanged).
    let first_content = if sh.mode == Mode::Code && b.cfg.interactive {
        let kinds: Vec<String> = b
            .cfg
            .project_registry
            .as_ref()
            .and_then(|(dir, trust)| nexus_tools::registry::load(dir, trust).ok())
            .and_then(|f| {
                sh.intent
                    .workspace_id
                    .as_deref()
                    .and_then(|w| f.get(w).map(|p| p.kinds.clone()))
            })
            .unwrap_or_default();
        let ro = b.store.load(ctx.run_id).is_some_and(|r| r.run.read_only);
        let direct_run = b
            .store
            .load(ctx.run_id)
            .is_some_and(|r| r.run.workspace_kind.as_deref() == Some("direct"));
        let pre = crate::guidance::code_preamble_body_for(&kinds, true, direct_run);
        let ro_note = if ro {
            "[READ-ONLY REQUEST] The user asked for no changes. fs_edit and fs_write are refused by the runtime for this request; use fs_list, fs_search and fs_read (and proc_run only to inspect or verify) and answer in text.\n\n"
        } else {
            ""
        };
        // A7.1: the conversation's earlier requests, answers, findings and runtime evidence
        // travel with the first turn of every follow-up run. The whole first message must fit
        // the transport's per-message bound, so the conversation gets what the harness text
        // and the user's request leave over (a 31 KB context once made a follow-up fail with
        // "message content is empty or oversized").
        let reserve = pre.len() + ro_note.len() + sh.intent.content.len() + 256;
        let prior = crate::threads::context_for_run(b, ctx.run_id, reserve);
        let mut c = pre;
        if let Some(p) = &prior {
            c.push('\n');
            c.push_str(p);
        } else {
            c.push_str("\nTask from the user:\n");
        }
        c.push_str(ro_note);
        c.push_str(&sh.intent.content);
        c
    } else {
        sh.intent.content.clone()
    };
    let mut items: Vec<InputItem> = vec![InputItem::Message {
        role: "user".into(),
        content: first_content,
    }];
    let mut evidence = Evidence::default();
    let mut seen_calls: Vec<String> = Vec::new();
    let mut refusals_in_a_row = 0u32;
    let mut turn_cap = out_tokens;
    let mut truncations_in_a_row = 0u32;
    let mut attempt_id = b
        .store
        .load(ctx.run_id)
        .and_then(|r| r.run.attempt_id)
        .unwrap_or_default();

    // Provider requests made so far (a recovered turn is asked again as a NEW attempt).
    let mut dispatches = 0u32;
    let mut failures_in_a_row = 0u32;
    let mut turn = 0u32;
    // EM-01/EM-03: this run's Engineering Mode extension lives in `er` (host + durable state,
    // never shared). Registry-authorized targets of non-default efforts, per effort (they are
    // content-addressed per task, so one authorization serves every attempt of that effort; the
    // Kernel still accepts each attempt on its own).
    let mut attempt_targets: std::collections::HashMap<
        String,
        crate::attempt_target::AttemptTarget,
    > = std::collections::HashMap::new();
    loop {
        turn += 1;
        if turn > limits.turns {
            break;
        }
        if ctx.stop() {
            return Ok(LoopEnd::Cancelled);
        }
        if started.elapsed() >= limits.runtime {
            return Ok(LoopEnd::Limit("max-runtime"));
        }
        // Each model turn is its own Controller attempt of the same task.
        if dispatches > 0 {
            let _g = b.bridge_lock.lock().unwrap_or_else(|p| p.into_inner());
            let a = match bridge(
                b,
                "attempt-add",
                &[&ledger, sh.task_id, sh.task_instance],
                None,
            ) {
                Ok(a) => a,
                // The Controller's per-task bound on provider requests is a policy limit, not
                // a malfunction: end cleanly with the work kept (a self-development task died
                // here as an opaque "failed" at 96 attempts).
                Err(e) if is_attempt_limit(&e.code) => return Ok(LoopEnd::Limit("max-attempts")),
                Err(e) => return Err(e),
            };
            attempt_id = str_of(&a, "attemptId")?;
        }
        let shadow = bridge(
            b,
            "shadow",
            &[&ledger, sh.task_id, &attempt_id, sh.task_instance],
            None,
        )?;
        let shadow_intent = shadow.get("intent").cloned().unwrap_or_default();
        let command_id = str_of(&shadow_intent, "commandId")?;
        let kernel_intent = bridge(
            b,
            "kernel-intent",
            &[],
            Some(&serde_json::json!({
                "shadowIntent": shadow_intent,
                "issuance": {
                    "modeId": sh.issued.get("modeId"), "role": sh.issued.get("role"),
                    "modeConfigRevision": sh.issued.get("modeConfigRevision"),
                    "modeConfigDigest": sh.issued.get("modeConfigDigest"),
                },
                "workspaceRootDigest": sh.ws_digest,
            })),
        )?;
        let kintent = kernel_intent.get("intent").cloned().unwrap_or_default();
        // Long tasks: before the oldest steps are dropped, this turn also asks the model to write
        // down what it has learned (found live: a 270-turn task forgot what it had read every few
        // turns and re-read the same files for half an hour).
        // the same target-derived budget as the compaction below (R-NATIVE-2 item 5)
        let ctx_budget = sh.ctx_budget;
        if sh.mode == Mode::Code
            && b.cfg.interactive
            && !ls.memory_requested
            && ls.memory_tries < 2
            && crate::context::wants_memory(&items, ctx_budget)
        {
            ls.memory_requested = true;
            ls.memory_tries += 1;
            items.push(InputItem::Message {
                role: "user".into(),
                content: crate::context::MEMORY_PROMPT.to_owned(),
            });
            let _ = session.state(
                nexus_client::model_run::ModelRunState::ToolRunning,
                "The conversation is long: asking the model to write its working memory before older steps are shortened.",
                None,
            );
        }
        // R-NATIVE-2: every turn uses the same issued target; the bound
        // selection rides along and is checked each turn. Context budget
        // comes from the target's window (min with the configured budget).
        let ctx_budget =
            (sh.ctx_budget as f64 * crate::recovery::context_scale(failures_in_a_row)) as usize;
        if sh.mode == Mode::Code
            && !ls.memory_requested
            && crate::context::compact(&mut items, &receipts_summary(&ls.activity), ctx_budget)
        {
            ls.compactions += 1;
            let n = ls.compactions;
            b.update(ctx.run_id, |r| r.context_compactions = n);
        }
        fault(sh, "before-accept");
        // EM-01: the engine is consulted before every request. Contract v1 admits only
        // `Continue` with the pinned effort: nothing about the request can change here.
        if let Err(r) = er.consult(
            crate::engine::Hook::BeforeRequest,
            &engine_snapshot(ls, sh, er, dispatches, b.cfg.interactive, turn, ""),
        ) {
            return Ok(LoopEnd::Failed(r.code.into(), r.message));
        }
        fault(sh, "after-accept");
        // EM-02/EM-03: the target of THIS attempt: the task's pinned target, unless an accepted
        // (and already durable) effort selection is in force for it; then the Registry issues
        // and the Kernel seals that effort's target under the task binding.
        let ordinal = dispatches + 1;
        let attempt_target = match er.host.effort_for_attempt(ordinal).map(str::to_owned) {
            None => sh
                .task_target
                .for_attempt(b, crate::attempt_target::EffortRequest::Pinned)
                .map_err(StepError::from)?,
            Some(e) => match attempt_targets.get(&e) {
                Some(t) => t.clone(),
                None => {
                    let t = sh
                        .task_target
                        .for_attempt(b, crate::attempt_target::EffortRequest::Authorized(&e))
                        .map_err(StepError::from)?;
                    attempt_targets.insert(e, t.clone());
                    t
                }
            },
        };
        fault(sh, "after-authorize");
        let req = ModelRunRequest {
            user_initiated: true,
            prompt: sh.intent.content.clone(),
            task_instance_id: sh.task_instance.to_owned(),
            command_id: command_id.clone(),
            attempt_id: attempt_id.clone(),
            lease_epoch: sh.lease_epoch,
            store_incarnation: sh.incarnation.to_owned(),
            intent_digest: str_of(&kintent, "intentDigest")?,
            resolution: attempt_target.resolution.clone(),
            snapshot: sh.issued.get("snapshot").cloned().unwrap_or_default(),
            core: attempt_target.core(),
            extension: attempt_target.extension.clone(),
            expected: sh
                .intent
                .model
                .as_ref()
                .map(|m| nexus_client::ExpectedTarget {
                    provider_id: m.provider_id.clone(),
                    remote_model_id: m.remote_model_id.clone(),
                }),
            max_output_tokens: turn_cap,
        };
        let mut prepared = nexus_client::prepare_inspect_turn(&req, &items, sh.profile)
            .map_err(|e| se("prepare-refused", e.message))?;
        // EM-04A RequestBudgetV1 (opt-in; never configured in production): the EXACT serialized
        // request must fit the budget minus the engine's measured reserve. Reduced only at safe
        // item boundaries, re-prepared and re-checked; otherwise nothing is sent.
        // EM-04C1: the budget is Registry policy, sealed with the task binding. This attempt's own
        // issuance must carry the same value (a different one is refused, nothing is sent); a
        // broker-level `request_budget_bytes` can only TIGHTEN it (test seam, `None` in production).
        let sealed_budget = sh.task_target.request_budget_bytes();
        if attempt_target
            .resolution
            .pointer("/target/requestBudgetBytes")
            .and_then(|v| v.as_u64())
            != sealed_budget.map(|b| b as u64)
        {
            return Ok(LoopEnd::Failed(
                "request-budget-mismatch".into(),
                "the attempt's request budget differs from the task's sealed budget; nothing was sent"
                    .into(),
            ));
        }
        let effective_budget = match (sealed_budget, b.cfg.request_budget_bytes) {
            (Some(s), Some(c)) => Some(s.min(c)),
            (s, c) => s.or(c),
        };
        if let Some(target_bytes) = effective_budget {
            let budget = crate::request_budget::RequestBudget {
                target_bytes,
                reserve_bytes: er.host.extension().descriptor().request_reserve_bytes,
            };
            let Some(limit) = budget.limit() else {
                return Ok(LoopEnd::Failed(
                    "request-budget-exceeded".into(),
                    "the engine's reserved request bytes exceed the request budget; nothing was sent".into(),
                ));
            };
            match crate::request_budget::fit(&mut items, prepared.request_bytes, limit) {
                Err(e) => {
                    return Ok(LoopEnd::Failed(
                        "request-budget-exceeded".into(),
                        e.message(),
                    ))
                }
                Ok(report) if report.changed() => {
                    prepared = nexus_client::prepare_inspect_turn(&req, &items, sh.profile)
                        .map_err(|e| se("prepare-refused", e.message))?;
                    if prepared.request_bytes != report.request_bytes_after
                        || prepared.request_bytes > limit
                    {
                        return Ok(LoopEnd::Failed(
                            "request-budget-exceeded".into(),
                            format!(
                                "the reduced request measured {} bytes (budget {limit}); nothing was sent",
                                prepared.request_bytes
                            ),
                        ));
                    }
                    ls.compactions += 1;
                    let n = ls.compactions;
                    b.update(ctx.run_id, |r| r.context_compactions = n);
                }
                Ok(_) => {}
            }
        }
        // EM-03 write-ahead: the attempt -> target association (and every accepted proposal
        // so far) is durable BEFORE the attempt is published and dispatched.
        let issuance_id = attempt_target
            .resolution
            .pointer("/provenance/issuanceId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        if let Err(e) = er.bind_attempt(
            ordinal,
            &attempt_id,
            &attempt_target.effort,
            &issuance_id,
            &attempt_target.extension_digest,
        ) {
            return Ok(LoopEnd::Failed(e.code.into(), e.message));
        }
        fault(sh, "after-bind");
        let bundle = bridge(
            b,
            sh.mode.publish(),
            &[],
            Some(&serde_json::json!({
                "shadowIntent": shadow_intent,
                "lease": { "epoch": sh.lease_epoch, "storeIncarnation": sh.incarnation },
                "role": sh.issued.get("role"),
                "issuance": { "taskInstanceId": sh.task_instance, "resolution": attempt_target.resolution },
                "extensionDigest": attempt_target.extension_digest,
                "requestDigest": prepared.request_digest,
                "sessionId": sh.session_id,
            })),
        )?;
        daemon(
            b,
            "intent-publish",
            serde_json::json!({ "intent": bundle.get("bundle").cloned().unwrap_or_default() }),
        )?;
        daemon(
            b,
            "accept",
            serde_json::json!({
                "intent": kintent, "resolution": attempt_target.resolution,
                "snapshot": sh.issued.get("snapshot").cloned().unwrap_or_default(),
                "lease": { "epoch": sh.lease_epoch, "storeIncarnation": sh.incarnation },
            }),
        )?;
        // The Kernel binds the workspace itself and only if the accepted
        // Controller intent committed to exactly this root digest.
        daemon(
            b,
            "workspace-bind",
            if sh.direct {
                serde_json::json!({ "commandId": command_id, "root": sh.root, "directTask": sh.task_instance })
            } else {
                serde_json::json!({ "commandId": command_id, "root": sh.root })
            },
        )?;
        if ctx.stop() {
            return Ok(LoopEnd::Cancelled);
        }
        let auth = daemon(
            b,
            "dispatch-authorize",
            serde_json::json!({
                "commandId": command_id, "requestDigest": prepared.request_digest,
                "scope": sh.mode.scope(), "endpointOrigin": prepared.endpoint_origin,
                "credentialRef": prepared.credential_ref,
            }),
        )?;
        let grant = auth.get("grant").cloned().unwrap_or_default();
        dispatches += 1;
        session.begin_turn(
            dispatches,
            &attempt_id,
            &command_id,
            &prepared.request_digest,
        );
        ls.turns = turn;
        b.update(ctx.run_id, |r| r.attempt_id = Some(attempt_id.clone()));
        ctx.progress(ls, "executing");

        // ---- exactly one provider request --------------------------------
        let end = nexus_client::run_inspect_turn(
            &b.client_config(),
            opts,
            session,
            &InspectTurn {
                profile: sh.profile,
                request: &req,
                items: items.clone(),
                grant: &grant,
            },
            ctx.flag,
            &mut |_t| {},
        );
        let end = match end {
            Ok(TurnEnd::Output(o)) if b.cfg.interactive && fault_injected(dispatches) => {
                // TEST ONLY (NEXUS_FAULT_INJECT_DISPATCHES): the provider really answered and
                // the answer is discarded, exactly like a connection lost after the send.
                drop(o);
                Ok(TurnEnd::Ended {
                    state: nexus_client::model_run::ModelRunState::Uncertain,
                    code: "send-uncertain".to_owned(),
                    message: "[injected] the provider answered but the response was lost"
                        .to_owned(),
                    latency_ms: 0,
                })
            }
            other => other,
        };
        let end = match end {
            Err(e) if b.cfg.interactive && e.code == "disconnected" => Ok(TurnEnd::Ended {
                state: nexus_client::model_run::ModelRunState::Failed,
                code: "disconnected".to_owned(),
                message: e.message,
                latency_ms: 0,
            }),
            other => other.map_err(|e| se(e.code, e.message)),
        }?;
        er.attempt_outcome(
            ordinal,
            match &end {
                TurnEnd::Output(_) => "answered",
                TurnEnd::Truncated(_) => "truncated",
                TurnEnd::Ended {
                    state: nexus_client::model_run::ModelRunState::Uncertain,
                    ..
                } => "uncertain",
                TurnEnd::Ended { .. } => "failed",
            },
        );
        fault(sh, "after-answer");
        let out = match end {
            TurnEnd::Output(o) => {
                truncations_in_a_row = 0;
                failures_in_a_row = 0;
                turn_cap = out_tokens;
                *o
            }
            TurnEnd::Ended { code, message, .. } => {
                if b.cfg.interactive && crate::recovery::is_recoverable(&code) {
                    failures_in_a_row += 1;
                    if let Some(end) =
                        recover_wait(ctx, session, ls, failures_in_a_row, &code, &message)?
                    {
                        return Ok(end);
                    }
                    // the same turn is asked again as a fresh attempt: all completed tool
                    // results stay in `items`, nothing local is re-run
                    turn -= 1;
                    continue;
                }
                return Ok(LoopEnd::Recorded);
            }
            TurnEnd::Truncated(o) => {
                // Nothing from this turn executes (the client discarded any partial tool
                // call). The provider request is NOT repeated silently: the next loop
                // iteration is a fresh Controller attempt and Kernel authorization with a
                // larger output cap, shown in the timeline, bounded, and counted as a turn.
                if let Some((i, u)) = o.usage {
                    ls.usage_in += i;
                    ls.usage_out += u;
                    ls.saw_usage = true;
                    session.set_usage(ls.usage_in, ls.usage_out);
                }
                truncations_in_a_row += 1;
                let cur = turn_cap.unwrap_or(0);
                let next = out_ceiling
                    .filter(|c| *c > cur)
                    .map(|c| (cur.saturating_mul(OUTPUT_ESCALATION_FACTOR)).min(c));
                match next {
                    Some(n) if truncations_in_a_row <= MAX_TRUNCATIONS_IN_A_ROW => {
                        session
                            .state(
                                nexus_client::model_run::ModelRunState::ToolRunning,
                                &format!(
                                    "The model's response was cut off at the output limit ({cur} tokens, reasoning included). Nothing from it was executed; asking again with a larger limit ({n} tokens)."
                                ),
                                None,
                            )
                            .map_err(|e| se(e.code, e.message))?;
                        turn_cap = Some(n);
                        continue;
                    }
                    _ if !b.cfg.interactive => {
                        // strict profile: no escalation exists; keep the established semantics
                        return Ok(if o.partial_tool {
                            LoopEnd::Failed(
                                "incomplete-tool-turn".into(),
                                "the provider ended the response early while proposing a tool; nothing was executed".into(),
                            )
                        } else {
                            LoopEnd::Limit("output-limit")
                        });
                    }
                    _ => {
                        return Ok(LoopEnd::Failed(
                            "output-limit".into(),
                            "the provider ended the response at the output limit even after enlarging it; nothing from that response was executed".into(),
                        ))
                    }
                }
            }
        };
        if let Some((i, o)) = out.usage {
            ls.usage_in += i;
            ls.usage_out += o;
            ls.saw_usage = true;
            session.set_usage(ls.usage_in, ls.usage_out);
        }
        if ls.memory_requested {
            ls.memory_requested = false;
            let mem = out.text.trim().to_owned();
            if out.tool_calls.is_empty() {
                // a memory (or an unusable answer: then plain shortening takes over next turn);
                // either way this reply is NOT the end of the task
                let folded = mem.len() >= 200
                    && crate::context::fold_into_memory(
                        &mut items,
                        &mem,
                        &receipts_summary(&ls.activity),
                    );
                if !folded
                    && matches!(items.last(), Some(InputItem::Message { content, .. }) if content == crate::context::MEMORY_PROMPT)
                {
                    items.pop();
                }
                if folded {
                    ls.memories += 1;
                    ls.compactions += 1;
                    ls.memory_tries = 0;
                    let n = ls.compactions;
                    b.update(ctx.run_id, |r| r.context_compactions = n);
                    let _ = session.state(
                        nexus_client::model_run::ModelRunState::ToolRunning,
                        &format!("Older steps were replaced by the model's working memory ({} characters).", mem.len()),
                        None,
                    );
                }
                continue;
            }
            // it called tools (or said nothing useful) instead: that turn is handled as a normal
            // one below; the request is withdrawn and will be repeated once, then the plain
            // shortening takes over
            if matches!(items.last(), Some(InputItem::Message { content, .. }) if content == crate::context::MEMORY_PROMPT)
            {
                items.pop();
            }
        }
        ls.final_text = out.text.clone();
        ls.last_output = Some(out.clone());
        let proposals = out.tool_calls.clone();
        if proposals.is_empty() {
            if out.finish_reason.starts_with("incomplete:") {
                return Ok(LoopEnd::Limit("output-limit"));
            }
            // EM-01: the Engineering Mode decides whether a reply without a tool call ends the
            // turn or the model is asked to carry on; completion itself stays the Controller's
            // (`decide_run` below, from receipts).
            match er.consult(
                crate::engine::Hook::FinalResponse,
                &engine_snapshot(ls, sh, er, dispatches, b.cfg.interactive, turn, &out.text),
            ) {
                Err(r) => return Ok(LoopEnd::Failed(r.code.into(), r.message)),
                Ok(crate::engine::EngineDecision::Guide(g)) => {
                    let _ = session.state(
                        nexus_client::model_run::ModelRunState::ToolRunning,
                        &format!(
                            "The model stopped early; asking it to continue ({}): {}",
                            g.ordinal, g.reason
                        ),
                        None,
                    );
                    push_model_reasoning(&mut items, &out);
                    push_model_text(&mut items, &out);
                    items.push(InputItem::Message {
                        role: "user".into(),
                        content: g.message,
                    });
                    continue;
                }
                Ok(_) => {}
            }
            let (v, u) = check_citations(&out.text, &evidence);
            ls.citations_verified = v;
            ls.citations_unverified = u;
            // A provider "stop" is not task completion: classify it from the request and the
            // receipts. An implementation task that ended on a plan is incomplete, not done.
            let c = crate::completion::decide_run(
                ls.expects_change,
                applied_edits(ls),
                ls.last_test.as_deref(),
                &out.text,
                ls.failed_checks.len() as u32,
            );
            ls.completion = Some(c.as_str());
            if c == crate::completion::Completion::Incomplete {
                return Ok(LoopEnd::Limit("no-implementation"));
            }
            return Ok(LoopEnd::Completed);
        }
        // A response that was cut off must never trigger a tool.
        if out.finish_reason.starts_with("incomplete:") {
            return Ok(LoopEnd::Failed(
                "incomplete-tool-turn".into(),
                "the provider ended the response early while proposing a tool; nothing was executed".into(),
            ));
        }
        if turn == limits.turns {
            return Ok(LoopEnd::Limit("max-turns"));
        }

        // ---- tool phase ---------------------------------------------------
        session
            .state(
                nexus_client::model_run::ModelRunState::ToolRunning,
                &if sh.mode == Mode::Code && b.cfg.interactive {
                    format!(
                        "Model proposed {} tool call(s); edits and commands run under the automated workspace policy; validating.",
                        proposals.len()
                    )
                } else if sh.mode == Mode::Code {
                    format!(
                        "Model proposed {} tool call(s); every edit and command still needs an independent approval; validating.",
                        proposals.len()
                    )
                } else {
                    format!(
                        "Model proposed {} read-only tool call(s); validating.",
                        proposals.len()
                    )
                },
                None,
            )
            .map_err(|e| se(e.code, e.message))?;
        ctx.progress(ls, "tool-running");
        push_model_reasoning(&mut items, &out);
        push_model_text(&mut items, &out);
        for call in proposals {
            if ctx.stop() {
                return Ok(LoopEnd::Cancelled);
            }
            if started.elapsed() >= limits.runtime {
                return Ok(LoopEnd::Limit("max-runtime"));
            }
            let call_id = safe_id(&call.call_id);
            if call_id.is_empty() || call_id != call.call_id {
                return Ok(LoopEnd::Failed(
                    "tool-call-id-invalid".into(),
                    "the provider supplied no usable call_id; a result cannot be returned to the model".into(),
                ));
            }
            if seen_calls.contains(&call_id) {
                return Ok(LoopEnd::Failed(
                    "tool-call-duplicate".into(),
                    "the provider repeated a call_id; refusing to execute it twice".into(),
                ));
            }
            seen_calls.push(call_id.clone());
            if ls.tool_calls >= limits.tool_calls {
                return Ok(LoopEnd::Limit("max-tool-calls"));
            }
            if ls.result_bytes >= limits.result_bytes {
                return Ok(LoopEnd::Limit("max-tool-result-bytes"));
            }
            ls.tool_calls += 1;
            let idx = ls.tool_calls;
            let args_text = call.arguments.to_string();
            let args_echo = if args_text.len() > 8 * 1024 {
                "{}".to_owned()
            } else {
                args_text.clone()
            };
            let mut pending_observation = None;
            let mut act = ToolActivity {
                index: idx,
                turn,
                call_id: call_id.clone(),
                tool: call
                    .name
                    .chars()
                    .filter(|c| c.is_ascii_graphic())
                    .take(40)
                    .collect(),
                args_summary: fallback_summary(&call.name, &call.arguments),
                ..Default::default()
            };
            // EM-04B: the reasoning-signals tool is answered by the broker (experimental engine only)
            let signals_call = sh.signals && call.name == crate::signals::TOOL;
            let rendered = if signals_call {
                match signal_call(
                    sh,
                    ls,
                    er,
                    &mut act,
                    &call.arguments,
                    args_text.len(),
                    dispatches,
                    b.cfg.interactive,
                    turn,
                ) {
                    Ok(r) => {
                        let _ = session.tool_call(
                            idx,
                            &call_id,
                            crate::signals::TOOL,
                            &args_echo,
                            if r.is_error { "refused" } else { "executed" },
                            r.is_error,
                        );
                        r
                    }
                    Err(end) => {
                        ls.activity.push(act);
                        return Ok(end);
                    }
                }
            } else {
                // 1. deterministic validation (the catalog depends on the mode)
                let validated = match sh.mode {
                    Mode::Code => crate::code::validate_code_proposal_in(
                        &call.name,
                        &call.arguments,
                        &ls.last_sha,
                        b.cfg.interactive,
                    ),
                    Mode::Inspect => {
                        validate_proposal(&call.name, &call.arguments).map(|v| CodeProposal {
                            summary: String::new(),
                            inner: v,
                            kind: Kind::Read,
                            path: None,
                            bytes: 0,
                        })
                    }
                };
                // 1b. operator write scope (A6.1): refused before any approval exists
                let validated = validated.and_then(|cp| {
                if cp.kind == Kind::Write {
                    if let Some(path) = &cp.path {
                        if !crate::code::in_write_scope(path, &sh.policy.write_allow) {
                            return Err(Refusal {
                                code: "path-not-in-scope",
                                message: "that path is outside the files the operator allowed for this source; propose a change inside the allowed scope".to_owned(),
                            });
                        }
                    }
                }
                Ok(cp)
            });
                match validated {
                    Err(r) => {
                        act.status = "refused".into();
                        act.error_code = Some(r.code.to_owned());
                        let _ = session
                            .tool_call(idx, &call_id, &act.tool, &args_echo, "refused", true);
                        refusals_in_a_row += 1;
                        render_error(&act.tool, r.code, &r.message)
                    }
                    Ok(cp) => {
                        let p = &cp.inner;
                        act.tool = p.model_name.to_owned();
                        act.args_summary = match cp.kind {
                            Kind::Read => args_summary(p),
                            _ => cp.summary.clone(),
                        };
                        act.args_digest = Some(p.args_digest.clone());
                        // Per-run budgets for mutations and commands.
                        if let Some(msg) = budget_refusal(&cp, ls, &sh.policy) {
                            act.status = "refused".into();
                            act.error_code = Some("budget-exhausted".into());
                            let _ = session.tool_call(
                                idx,
                                &call_id,
                                p.model_name,
                                &args_echo,
                                "refused",
                                true,
                            );
                            refusals_in_a_row += 1;
                            render_error(p.model_name, "budget-exhausted", msg)
                        } else {
                            let _ = session.tool_call(
                                idx,
                                &call_id,
                                p.model_name,
                                &args_echo,
                                if cp.kind == Kind::Read {
                                    "authorizing"
                                } else {
                                    "awaiting-approval"
                                },
                                false,
                            );
                            let rid = format!("ri-{}-t{}-c{}", &ctx.run_id[4..16], turn, idx);
                            let origin_tag = format!(
                                "{}/{}",
                                safe_id(out.response_id.as_deref().unwrap_or("noresp")),
                                call_id
                            );
                            let params = serde_json::json!({
                                "requestId": rid, "cancellationId": rid,
                                "taskInstanceId": sh.task_instance, "attemptId": attempt_id,
                                "commandId": command_id, "leaseEpoch": sh.lease_epoch,
                                "storeIncarnation": sh.incarnation,
                                "toolId": p.tool_id.as_str(), "toolVersion": nexus_tools::TOOL_VERSION,
                                "args": p.args,
                                "budgets": budgets_for(cp.kind, b.cfg.interactive),
                            });
                            // 2. Mutations and commands first need an independent
                            //    approval of this exact operation.
                            let mut proceed = true;
                            let mut denial: Option<Rendered> = None;
                            if cp.kind != Kind::Read {
                                match cp.kind {
                                    Kind::Write => ls.edits_used += 1,
                                    _ => ls.tests_used += 1,
                                }
                                ls.write_bytes += cp.bytes;
                                let (e, t) = (ls.edits_used, ls.tests_used);
                                b.update(ctx.run_id, |r| {
                                    r.edits_used = e;
                                    r.tests_used = t;
                                });
                                let outcome = crate::code::request_and_wait(
                                    b,
                                    ctx.run_id,
                                    ctx.flag,
                                    *started + limits.runtime,
                                    &params,
                                    &origin_tag,
                                    p.model_name,
                                    &crate::code::proposal_view(&cp),
                                );
                                act.approval_id = outcome.approval_id().map(str::to_owned);
                                act.approval_outcome = Some(outcome.label().to_owned());
                                if let ApprovalOutcome::Approved {
                                    automated: true, ..
                                } = &outcome
                                {
                                    act.approval_actor = Some("automated-policy".into());
                                }
                                match outcome {
                                    ApprovalOutcome::Approved { .. } => {}
                                    ApprovalOutcome::Refused { code, message } => {
                                        proceed = false;
                                        if is_authority_failure(&code) {
                                            act.status = "refused".into();
                                            act.error_code = Some(code.clone());
                                            ls.activity.push(act);
                                            return Ok(LoopEnd::Failed(
                                            "tool-authority-refused".into(),
                                            format!("the daemon refused to create the approval ({code}); the run was stopped (fail closed)"),
                                        ));
                                        }
                                        act.status = "refused".into();
                                        act.error_code = Some(code.clone());
                                        refusals_in_a_row += 1;
                                        denial = Some(render_error(p.model_name, &code, &message));
                                    }
                                    ApprovalOutcome::Cancelled { .. } => {
                                        act.status = "cancelled".into();
                                        ls.activity.push(act);
                                        return Ok(LoopEnd::Cancelled);
                                    }
                                    ApprovalOutcome::TimedOut { .. } => {
                                        act.status = "cancelled".into();
                                        ls.activity.push(act);
                                        return Ok(LoopEnd::Limit("max-runtime"));
                                    }
                                    other => {
                                        proceed = false;
                                        let code = format!("approval-{}", other.label());
                                        act.status = "refused".into();
                                        act.error_code = Some(code.clone());
                                        denial = Some(render_error(
                                        p.model_name,
                                        &code,
                                        "the independent approver did not approve this operation; it was not run",
                                    ));
                                    }
                                }
                            }
                            if !proceed {
                                denial.unwrap_or_else(|| {
                                    render_error(
                                        p.model_name,
                                        "refused",
                                        "the operation was not run",
                                    )
                                })
                            } else {
                                // 3. Kernel-mediated execution via the existing tool path.
                                let mut exec = params.clone();
                                exec["aiOrigin"] = serde_json::json!(origin_tag);
                                let resp =
                                    exec_with_cancel(b, ctx.flag, &exec, command_id.as_str());
                                match resp {
                                    Ok(v) => {
                                        refusals_in_a_row = 0;
                                        let result = v.get("result").cloned().unwrap_or_default();
                                        let r = if p.model_name == "proc_run" {
                                            render_process(&result, PER_RESULT_BYTES)
                                        } else {
                                            render_result(p.model_name, &result, PER_RESULT_BYTES)
                                        };
                                        act.status =
                                            if r.is_error { "failed" } else { "executed" }.into();
                                        act.execution_id = v
                                            .pointer("/execution/executionId")
                                            .and_then(|x| x.as_str())
                                            .map(str::to_owned);
                                        act.journal_seq = v
                                            .pointer("/execution/journalSeq")
                                            .and_then(|x| x.as_i64());
                                        if r.is_error {
                                            act.error_code = result
                                                .pointer("/error/code")
                                                .and_then(|x| x.as_str())
                                                .map(str::to_owned);
                                        }
                                        record_evidence(
                                            &mut evidence,
                                            p.model_name,
                                            &p.args,
                                            &result,
                                        );
                                        record_receipts(ls, &mut act, &cp, &result);
                                        pending_observation = observe(
                                            &act,
                                            p.model_name == "proc_run"
                                                && is_verification_command(&p.args),
                                            dispatches,
                                            sh.task_instance,
                                        );
                                        r
                                    }
                                    Err(e) => 'arm: {
                                        let code = e
                                            .code
                                            .strip_prefix("daemon-")
                                            .unwrap_or(&e.code)
                                            .to_owned();
                                        // A lost answer to a WRITE or PROCESS is not a failure
                                        // we may assume: the operation may have happened. Stop,
                                        // keep the copy, and require explicit reconciliation.
                                        if e.code == "daemon-unreachable"
                                            && b.cfg.interactive
                                            && !ctx.stop()
                                        {
                                            // Autonomy-first: the tool runtime restarting is not the
                                            // end of the task. Wait for it (bounded), tell the model
                                            // plainly that THIS operation's outcome is unknown and let
                                            // it reconcile by reading state. Commands run in a hermetic
                                            // sandbox without write-back, so asking again is safe.
                                            act.status = "uncertain".into();
                                            act.error_code = Some("tool-outcome-uncertain".into());
                                            let back = wait_for_daemon(ctx, 300);
                                            if ctx.stop() {
                                                ls.activity.push(act);
                                                return Ok(LoopEnd::Cancelled);
                                            }
                                            if !back {
                                                ls.activity.push(act);
                                                return Ok(LoopEnd::Uncertain(
                                                "tool-outcome-uncertain".into(),
                                                "the tool runtime did not come back within five minutes while a step was running; its effect is unknown. Nothing was repeated. Review the working copy diff".into(),
                                            ));
                                            }
                                            ls.recoveries += 1;
                                            let n = ls.recoveries;
                                            b.update(ctx.run_id, |r| {
                                                r.recoveries = n;
                                                r.last_recovery =
                                                    Some("the tool runtime restarted".into());
                                            });
                                            break 'arm render_error(
                                                p.model_name,
                                                "outcome-unknown",
                                                if cp.kind == crate::code::Kind::Write {
                                                    "The connection to the tool runtime was lost while this file change ran; whether it was applied is unknown. Read the file again and compare with what you intended before continuing."
                                                } else {
                                                    "The connection to the tool runtime was lost while this operation ran. It left no trace in the working copy; run it again if you still need its output."
                                                },
                                            );
                                        }
                                        if e.code == "daemon-unreachable"
                                            && cp.kind != crate::code::Kind::Read
                                        {
                                            act.status = "uncertain".into();
                                            act.error_code = Some("tool-outcome-uncertain".into());
                                            ls.activity.push(act);
                                            return Ok(LoopEnd::Uncertain(
                                            "tool-outcome-uncertain".into(),
                                            "the daemon did not answer while a write or command was running; its effect is unknown. Nothing was repeated. Review the working copy diff before trusting it".into(),
                                        ));
                                        }
                                        if is_authority_failure(&code) {
                                            act.status = "refused".into();
                                            act.error_code = Some(code.clone());
                                            ls.activity.push(act);
                                            return Ok(LoopEnd::Failed(
                                            "tool-authority-refused".into(),
                                            format!("the Kernel refused the tool call ({code}); the run was stopped (fail closed)"),
                                        ));
                                        }
                                        // An ordinary tool failure (not-found, sensitive
                                        // path, conflict, ...) is data for the model.
                                        act.status = "failed".into();
                                        act.error_code = Some(code.clone());
                                        if matches!(
                                            code.as_str(),
                                            "sensitive-path-refused"
                                                | "hidden-path-refused"
                                                | "symlink-refused"
                                                | "special-file-refused"
                                                | "hardlink-refused"
                                                | "path-invalid"
                                                | "invalid-arguments"
                                                | "unsupported-tool"
                                                | "command-refused"
                                        ) {
                                            refusals_in_a_row += 1;
                                        } else {
                                            refusals_in_a_row = 0;
                                        }
                                        render_error(p.model_name, &code, &e.message)
                                    }
                                }
                            }
                        }
                    }
                }
            };
            act.result_bytes = rendered.text.len() as u64;
            act.result_digest = Some(rendered.digest.clone());
            act.truncated = rendered.truncated;
            ls.result_bytes += rendered.text.len() as u64;
            let provenance = serde_json::json!({
                "status": act.status, "errorCode": act.error_code, "argsDigest": act.args_digest,
                "resultDigest": act.result_digest, "resultBytes": act.result_bytes,
                "truncated": act.truncated, "executionId": act.execution_id,
                "journalSeq": act.journal_seq, "turn": turn,
                "approvalId": act.approval_id, "approvalOutcome": act.approval_outcome,
                "preSha256": act.pre_sha256, "postSha256": act.post_sha256,
                "exitCode": act.exit_code, "verification": act.verification,
            })
            .to_string();
            let _ = session.tool_result(
                idx,
                &call_id,
                &act.tool,
                &rendered.text,
                &provenance,
                rendered.is_error,
            );
            // The model sees its own call and the (bounded) result, nothing else.
            items.push(InputItem::FunctionCall {
                call_id: call_id.clone(),
                name: call.name.clone(),
                arguments: if args_text.len() <= 8 * 1024 {
                    args_text
                } else {
                    "{}".into()
                },
            });
            items.push(InputItem::FunctionCallOutput {
                call_id: call_id.clone(),
                output: rendered.text.clone(),
            });
            ls.observations.extend(pending_observation);
            ls.activity.push(act);
            ctx.progress(ls, "tool-running");
            if refusals_in_a_row
                >= if b.cfg.interactive {
                    25
                } else {
                    MAX_CONSECUTIVE_REFUSALS
                }
            {
                return Ok(LoopEnd::Failed(
                    "too-many-refused-tool-calls".into(),
                    "the model kept proposing refused or invalid tool calls; the run was stopped"
                        .into(),
                ));
            }
        }
        // EM-01: after the tool phase the Engineering Mode may add bounded guidance (muse-v0: the
        // "start implementing" reminder for an implementation task that keeps reading).
        match er.consult(
            crate::engine::Hook::AfterToolPhase,
            &engine_snapshot(ls, sh, er, dispatches, b.cfg.interactive, turn, &out.text),
        ) {
            Err(r) => return Ok(LoopEnd::Failed(r.code.into(), r.message)),
            Ok(crate::engine::EngineDecision::Guide(g)) => {
                let n = ls.tool_calls;
                let _ = session.state(
                    nexus_client::model_run::ModelRunState::ToolRunning,
                    &format!(
                        "{n} tool calls and no change yet; asking the model to start implementing (reminder {}).",
                        g.ordinal
                    ),
                    None,
                );
                items.push(InputItem::Message {
                    role: "user".into(),
                    content: g.message,
                });
            }
            Ok(_) => {}
        }
    }
    Ok(LoopEnd::Limit("max-turns"))
}

/// Per-run budgets for mutations and commands (None = allowed).
fn budget_refusal(cp: &CodeProposal, ls: &LoopState, pol: &CodePolicy) -> Option<&'static str> {
    match cp.kind {
        Kind::Read => None,
        Kind::Write => {
            if pol.read_only {
                Some("this request is READ-ONLY: the user asked you not to change any file, so every edit and write is refused. Investigate with fs_list, fs_search and fs_read and answer in text; if a change would help, describe it instead of making it")
            } else if ls.edits_used >= pol.max_edits {
                Some("the edit budget for this run is exhausted; summarize your work and finish")
            } else if ls.write_bytes + cp.bytes > pol.max_total_write_bytes {
                Some("the total write-size budget for this run is exhausted")
            } else {
                None
            }
        }
        Kind::Process => {
            if ls.tests_used >= pol.max_tests {
                Some("the command budget for this run is exhausted; summarize your work and finish")
            } else {
                None
            }
        }
    }
}

/// Tool budgets sealed into the Kernel grant (and the approval) per kind.
fn budgets_for(kind: Kind, workbench: bool) -> Value {
    if workbench {
        // project-level trust: budgets sized for real repositories (the Kernel still clamps
        // every field to its own ceiling)
        return match kind {
            Kind::Read => serde_json::json!({
                "maxOutputBytes": 64 * 1024u64, "maxFileBytes": 1024 * 1024u64,
                "maxMatches": nexus_model::repo_tools::MODEL_MAX_SEARCH_MATCHES,
                "maxEntries": 2000u32, "maxDepth": 12u32, "deadlineMs": 20_000u64,
            }),
            Kind::Write => serde_json::json!({
                "maxFileBytes": 1024 * 1024u64, "maxWriteBytes": 512 * 1024u64, "deadlineMs": 20_000u64,
            }),
            Kind::Process => serde_json::json!({
                "procWallMs": 900_000u64, "procCpuSecs": 900u64,
                "procMemoryBytes": 4u64 * 1024 * 1024 * 1024, "procMaxProcs": 512u64,
                "procOutputBytes": 256 * 1024u64, "procScratchBytes": 1024u64 * 1024 * 1024,
                "stageMaxFiles": 100_000u64, "stageMaxBytes": 1024u64 * 1024 * 1024,
                "deadlineMs": 20_000u64,
            }),
        };
    }
    match kind {
        Kind::Read => serde_json::json!({
            "maxOutputBytes": 32 * 1024u64, "maxFileBytes": 512 * 1024u64,
            "maxMatches": nexus_model::repo_tools::MODEL_MAX_SEARCH_MATCHES,
            "maxEntries": 500u32, "maxDepth": 8u32, "deadlineMs": 10_000u64,
        }),
        Kind::Write => serde_json::json!({
            "maxFileBytes": 512 * 1024u64, "maxWriteBytes": 64 * 1024u64, "deadlineMs": 10_000u64,
        }),
        Kind::Process => serde_json::json!({
            "procWallMs": crate::code::PROC_WALL_MS, "procOutputBytes": 64 * 1024u64,
            "deadlineMs": 10_000u64,
        }),
    }
}

/// `tool-execute` with cancellation: while the daemon runs the tool, a
/// watcher turns the user's cancel into a Kernel `tool-revoke` of this
/// command, which fences the write/kills the sandboxed process tree. The
/// outcome of an interrupted operation is whatever the daemon's lifecycle
/// recorded (never assumed).
fn exec_with_cancel(
    b: &Arc<Broker>,
    flag: &Arc<AtomicBool>,
    params: &Value,
    command_id: &str,
) -> Result<Value, StepError> {
    let done = Arc::new(AtomicBool::new(false));
    let watcher = {
        let (b, flag, done) = (Arc::clone(b), Arc::clone(flag), Arc::clone(&done));
        let cmd = command_id.to_owned();
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if flag.load(Ordering::SeqCst) || b.shutdown.load(Ordering::SeqCst) {
                    // Keep trying until the revocation is accepted or the
                    // call ends: a single lost attempt must not leave a
                    // cancelled command running.
                    match daemon(
                        &b,
                        "tool-revoke",
                        serde_json::json!({ "commandId": cmd, "reason": "run-cancelled" }),
                    ) {
                        Ok(_) => return,
                        Err(e) => {
                            eprintln!(
                                "[broker] tool-revoke failed ({}): {}; retrying",
                                e.code, e.message
                            );
                            std::thread::sleep(Duration::from_millis(200));
                            continue;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        })
    };
    // A sandboxed process may run for its full wall budget; the IPC read must
    // outlast it so a timeout can only mean "daemon gone".
    let long = params.get("toolId").and_then(|t| t.as_str()) == Some("proc.run");
    // (the wall budget is the one sealed into THIS request: the interactive workbench allows
    // 15 minutes for installs and builds; a shorter read timeout made a slow `npm ci` look like
    // a lost daemon and its outcome "uncertain" - found by the A7.1 live acceptance)
    let ms = if long {
        params
            .pointer("/budgets/procWallMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(crate::code::PROC_WALL_MS)
            .max(crate::code::PROC_WALL_MS)
            + 30_000
    } else {
        30_000
    };
    let r = crate::pipeline::daemon_timeout(b, "tool-execute", params.clone(), ms);
    done.store(true, Ordering::SeqCst);
    let _ = watcher.join();
    r
}

/// Receipts and evidence from a finished tool call (authoritative values
/// from the native tool's own result, never from the model).
fn record_receipts(ls: &mut LoopState, act: &mut ToolActivity, cp: &CodeProposal, result: &Value) {
    let out = match result.get("output") {
        Some(o) if !o.is_null() => o,
        _ => return,
    };
    match cp.inner.model_name {
        "fs_read" => {
            if let (Some(p), Some(h)) = (
                out.get("path").and_then(|v| v.as_str()),
                out.get("fileSha256").and_then(|v| v.as_str()),
            ) {
                ls.last_sha.insert(p.to_owned(), h.to_owned());
            }
        }
        "fs_write" | "fs_edit" => {
            ls.dirty_since_test = true;
            ls.passed_checks.clear();
            act.pre_sha256 = out
                .get("preSha256")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            act.post_sha256 = out
                .get("postSha256")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            if let (Some(p), Some(h)) = (
                out.get("path").and_then(|v| v.as_str()),
                out.get("postSha256").and_then(|v| v.as_str()),
            ) {
                ls.last_sha.insert(p.to_owned(), h.to_owned());
            }
            if let Some(p) = out.get("path").and_then(|v| v.as_str()) {
                match out.get("operation").and_then(|v| v.as_str()) {
                    Some("create") => {
                        ls.created.insert(p.to_owned());
                    }
                    Some("delete") => {
                        ls.created.remove(p);
                        ls.last_sha.remove(p);
                    }
                    _ => {}
                }
            }
        }
        "proc_run" => {
            act.exit_code = out.get("exitCode").and_then(|v| v.as_i64());
            act.unsaved_files = out
                .pointer("/scratchEffects/unsavedFiles")
                .and_then(|v| v.as_u64())
                .filter(|n| *n > 0)
                .map(|n| n as u32);
            act.verification = out
                .get("verification")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            // only build/test/check-like commands verify anything; installs and `ls` do not
            if act.verification.as_deref() == Some("unverified") {
                // a pipeline whose status proves nothing (no pipefail, or a stage cut off by
                // SIGPIPE): neither a pass nor a failure - the work stays unverified
            } else if is_verification_command(&cp.inner.args) {
                ls.last_test = act.verification.clone();
                ls.dirty_since_test = false;
                let exact = act
                    .args_digest
                    .clone()
                    .unwrap_or_else(|| act.args_summary.clone());
                let key = crate::completion::check_identity(&cp.inner.args, &exact);
                let line: String = act.args_summary.chars().take(160).collect();
                match act.verification.as_deref() {
                    Some("pass") => {
                        if ls.failed_checks.remove(&key).is_some() {
                            ls.resolved_checks += 1;
                        }
                        if ls.passed_checks.len() < 16 {
                            ls.passed_checks.insert(key, line);
                        }
                    }
                    Some("fail") => {
                        ls.passed_checks.remove(&key);
                        ls.failed_checks.insert(key, line);
                    }
                    _ => {}
                }
            } else {
                // an install, a listing, a one-off script: it ran, but verifies nothing
                act.verification = act.verification.take().map(|v| format!("run-{v}"));
            }
        }
        _ => {}
    }
}

/// Does this `proc_run` verify the work (tests, type-check, build, lint) rather than merely run?
pub(crate) fn is_verification_command(args: &Value) -> bool {
    let prog = args.get("program").and_then(|v| v.as_str()).unwrap_or("");
    let argv: Vec<&str> = args
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    // `sh -c "<script>"`: judge each command of the script, not the words of its arguments
    // (found live: `sh -c "grep -n check ... Tests.cjs"` was recorded as a passing check and let an
    // unfinished run end as fulfilled). Text after a heredoc marker is data.
    let shell = matches!(prog, "sh" | "bash" | "zsh" | "dash");
    let script = argv
        .iter()
        .position(|a| *a == "-c" || *a == "-lc")
        .and_then(|i| argv.get(i + 1))
        .filter(|_| shell);
    if let Some(script) = script {
        let script = script.split("<<").next().unwrap_or("");
        return shell_segments(script)
            .iter()
            .any(|seg| segment_verifies(seg.trim()));
    }
    segment_verifies(&format!("{prog} {}", argv.join(" ")))
}

/// The commands of a shell script, split at `; & | newline` outside quotes.
fn shell_segments(script: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote) = (Vec::new(), String::new(), None::<char>);
    let mut chars = script.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == '\\' && q == '"' {
                    cur.push(c);
                    if let Some(n) = chars.next() {
                        cur.push(n);
                    }
                    continue;
                }
                if c == q {
                    quote = None;
                }
                cur.push(c);
            }
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    cur.push(c);
                }
                ';' | '&' | '|' | '\n' => out.push(std::mem::take(&mut cur)),
                _ => cur.push(c),
            },
        }
    }
    out.push(cur);
    out
}

/// Programs that only read, search or print: whatever words their arguments hold, they verify nothing.
const INSPECTORS: [&str; 22] = [
    "grep", "egrep", "rg", "cat", "sed", "awk", "head", "tail", "ls", "find", "echo", "printf",
    "git", "wc", "diff", "sort", "cut", "tr", "stat", "file", "less", "tee",
];

fn segment_verifies(seg: &str) -> bool {
    let line = seg.to_ascii_lowercase();
    let first = line
        .split_whitespace()
        .find(|w| !w.contains('='))
        .unwrap_or("");
    let first = first.rsplit('/').next().unwrap_or(first);
    if INSPECTORS.contains(&first) {
        return false;
    }
    const INSTALL: [&str; 9] = [
        "npm ci",
        "npm install",
        "npm i ",
        "pip install",
        "pnpm install",
        "yarn install",
        "go mod download",
        "dotnet restore",
        "cargo fetch",
    ];
    if INSTALL
        .iter()
        .any(|i| line.starts_with(i) || line.contains(&format!(" {i}")))
        && !line.contains(" test")
    {
        return false;
    }
    const WORDS: [&str; 16] = [
        "test",
        "tests",
        "build",
        "check",
        "clippy",
        "lint",
        "tsc",
        "vitest",
        "jest",
        "pytest",
        "unittest",
        "compileall",
        "mypy",
        "vet",
        "compile",
        "typecheck",
    ];
    line.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|w| WORDS.contains(&w))
}

/// What the model sees of a finished command: exit status and the TAIL of
/// each stream (compiler/test failures are at the end), bounded.
pub fn render_process(result: &Value, cap: usize) -> Rendered {
    let status = result
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("error");
    let Some(out) = result.get("output").filter(|o| !o.is_null()) else {
        let code = result
            .pointer("/error/code")
            .and_then(|v| v.as_str())
            .unwrap_or("tool-error");
        let msg = result
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("the command failed");
        return render_error("proc_run", code, msg);
    };
    let _ = status;
    let tail = |s: &str, n: usize| -> String {
        if s.len() <= n {
            return s.to_owned();
        }
        let mut cut = s.len() - n;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        let from = s[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(cut);
        format!("[... earlier output omitted ...]\n{}", &s[from..])
    };
    let mut keep = (cap / 2).saturating_sub(512);
    loop {
        let env = serde_json::json!({
            "tool": "proc_run",
            "status": match out.get("verification").and_then(|v| v.as_str()) {
                Some("pass") => "ok",
                Some("unverified") => "unverified",
                _ => "failed",
            },
            "pipefail": out.get("pipefail").cloned().unwrap_or(Value::Null),
            "untrustedOutput": true,
            "reason": out.get("reason").cloned().unwrap_or(Value::Null),
            "exitCode": out.get("exitCode").cloned().unwrap_or(Value::Null),
            "signal": out.get("signal").cloned().unwrap_or(Value::Null),
            "verification": out.get("verification").cloned().unwrap_or(Value::Null),
            "wallMs": out.get("wallMs").cloned().unwrap_or(Value::Null),
            "stdoutTruncatedByTool": out.get("stdoutTruncated").cloned().unwrap_or(Value::Null),
            "stderrTruncatedByTool": out.get("stderrTruncated").cloned().unwrap_or(Value::Null),
            "stdoutTail": tail(out.get("stdout").and_then(|v| v.as_str()).unwrap_or(""), keep),
            "stderrTail": tail(out.get("stderr").and_then(|v| v.as_str()).unwrap_or(""), keep),
        });
        let mut env = env;
        // what the command did to ITS scratch copy: shown to the model so a pass over files that exist only
        // there is never taken for a pass of the project
        if let (Some(se), Some(o)) = (out.get("scratchEffects"), env.as_object_mut()) {
            let short = |k: &str| -> Value {
                Value::Array(
                    se.get(k)
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().take(20).cloned().collect())
                        .unwrap_or_default(),
                )
            };
            o.insert(
                "scratchEffects".into(),
                serde_json::json!({
                    "savedToProject": false,
                    "note": "These changes exist ONLY in this command's throw-away copy and were NOT saved to the project: they are gone now. Make real changes with fs_write/fs_edit (fs_write create also makes missing folders), then run the check again so it runs over what is really in the project.",
                    "created": short("created"), "modified": short("modified"),
                    "deleted": short("deleted"), "createdFolders": short("createdDirs"),
                }),
            );
        }
        let text = nexus_contracts::canonical_json(&env);
        if text.len() <= cap || keep < 256 {
            let truncated = out.get("stdoutTruncated") == Some(&Value::Bool(true))
                || out.get("stderrTruncated") == Some(&Value::Bool(true))
                || text.contains("earlier output omitted");
            return Rendered {
                digest: digest_of(&text),
                text,
                is_error: false,
                truncated,
            };
        }
        keep /= 2;
    }
}

fn record_evidence(ev: &mut Evidence, tool: &str, args: &Value, result: &Value) {
    let out = match result.get("output") {
        Some(o) if !o.is_null() => o,
        _ => return,
    };
    match tool {
        "fs_read" => {
            let path = out
                .get("path")
                .and_then(|v| v.as_str())
                .or_else(|| args.get("path").and_then(|v| v.as_str()))
                .unwrap_or("");
            let start = out.get("startLine").and_then(|v| v.as_u64()).unwrap_or(1);
            let n = out
                .get("linesReturned")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            ev.add_read(path, start, n);
        }
        "fs_search" => {
            if let Some(ms) = out.get("matches").and_then(|v| v.as_array()) {
                for m in ms {
                    if let (Some(p), Some(l)) = (
                        m.get("path").and_then(|v| v.as_str()),
                        m.get("line").and_then(|v| v.as_u64()),
                    ) {
                        ev.add_line(p, l);
                    }
                }
            }
        }
        _ => {}
    }
}

/// Record the terminal state and publish it to the run view.
fn finalize(
    ctx: &Ctx<'_>,
    session: &mut InspectSession,
    cfg: &nexus_client::ClientConfig,
    ls: &LoopState,
    result: Result<LoopEnd, StepError>,
) {
    use nexus_client::model_run::ModelRunState as S;
    let end = match result {
        Ok(e) => e,
        Err(e) => LoopEnd::Failed(e.code, e.message),
    };
    let mut stop_reason: Option<String> = None;
    // the real reason of a failure (the status only knows "failed")
    let mut failure: Option<String> = None;
    match end {
        LoopEnd::Recorded => {}
        LoopEnd::Completed => {
            let last = ls
                .last_output
                .as_ref()
                .map(|o| {
                    format!(
                        " Turn {}: provider response {} ({}).",
                        ls.turns,
                        o.response_id.as_deref().unwrap_or("id not supplied"),
                        match o.usage {
                            Some((i, x)) => format!("usage {i} in / {x} out, provider-reported"),
                            None => "usage not reported".to_owned(),
                        }
                    )
                })
                .unwrap_or_default();
            let _ = session.state(
                S::Completed,
                &format!("Completed (final answer).{last}"),
                None,
            );
        }
        LoopEnd::Limit("no-implementation") => {
            stop_reason = Some("no-implementation".to_owned());
            let _ = session.state(
                S::LimitReached,
                &format!(
                    "Incomplete: {}",
                    crate::completion::incomplete_note(ls.edits_used, ls.last_test.as_deref())
                ),
                Some("no-implementation"),
            );
        }
        LoopEnd::Limit(why) => {
            stop_reason = Some(why.to_owned());
            let _ = session.state(
                S::LimitReached,
                &format!("Stopped cleanly at a policy limit ({why}). Findings so far are kept."),
                Some(why),
            );
        }
        LoopEnd::Cancelled => {
            let _ = session.state(
                S::Cancelled,
                "Cancelled by the user between steps. No provider request was in flight; nothing was re-sent.",
                Some("cancelled"),
            );
        }
        LoopEnd::Failed(code, msg) => {
            failure = Some(msg.clone());
            let _ = session.state(S::Failed, &format!("Failed: {msg}"), Some(&code));
        }
        LoopEnd::Uncertain(code, msg) => {
            failure = Some(msg.clone());
            let _ = session.state(S::Uncertain, &format!("Uncertain: {msg}"), Some(&code));
        }
    }
    let conv = session.conversation_id().to_owned();
    let status = nexus_client::model_run_status(cfg, &conv);
    // repo-code: the reviewable change set, read by the daemon from the
    // isolated working copy (kept for review whatever the outcome).
    let mut changed: Vec<nexus_client::intent_client::ChangedFile> = Vec::new();
    let mut diff_digest: Option<String> = None;
    if ls.mode_code {
        if let Some(t) = ctx
            .b
            .store
            .load(ctx.run_id)
            .and_then(|r| r.run.task_instance_id)
        {
            if let Ok(resp) = daemon(
                ctx.b,
                "worktree-diff",
                serde_json::json!({ "taskInstanceId": t }),
            ) {
                if let Some(files) = resp.pointer("/diff/files").and_then(|v| v.as_array()) {
                    changed = files
                        .iter()
                        .filter_map(|f| serde_json::from_value(f.clone()).ok())
                        .collect();
                }
                diff_digest = resp
                    .pointer("/diff/diffDigest")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
            }
        }
    }
    let completion = ls.completion;
    let (edits_used, tests_used, last_test) = (ls.edits_used, ls.tests_used, ls.last_test.clone());
    let unresolved_failed_checks = ls.failed_checks.len() as u32;
    let verified = ls.citations_verified.clone();
    let unverified = ls.citations_unverified.clone();
    let activity = ls.activity.clone();
    let (turns, calls, bytes) = (ls.turns, ls.tool_calls, ls.result_bytes);
    ctx.b.update(ctx.run_id, |r: &mut IntentRun| {
        if let Ok(s) = &status {
            crate::pipeline::apply_status(r, s);
        } else {
            r.state = "failed".into();
            r.terminal = true;
            r.error_code = Some("transcript-unreadable".into());
        }
        r.turn = turns;
        r.tool_calls = calls;
        r.tool_result_bytes = bytes;
        let skip = activity.len().saturating_sub(MAX_ACTIVITY);
        r.tool_activity = activity.into_iter().skip(skip).collect();
        r.citations_verified = verified;
        r.citations_unverified = unverified;
        r.pending_approval = None;
        if !changed.is_empty() || diff_digest.is_some() {
            r.changed_files = changed;
            r.diff_digest = diff_digest;
        }
        if r.max_edits > 0 {
            r.edits_used = edits_used;
            r.tests_used = tests_used;
            r.last_test_verification = last_test;
            r.unresolved_failed_checks = unresolved_failed_checks;
        }
        r.stop_reason = stop_reason;
        r.completion = completion.map(str::to_owned);
        if r.completion.as_deref() == Some("failing-checks") {
            r.completion_note = Some(crate::completion::failing_checks_note(
                unresolved_failed_checks,
            ));
        }
        if r.completion.as_deref() == Some("incomplete") {
            r.completion_note = Some(crate::completion::incomplete_note(
                edits_used,
                r.last_test_verification.as_deref(),
            ));
        }
        if let Some(m) = failure {
            r.error_message = Some(m.chars().take(300).collect());
        }
        r.updated_at_ms = now_ms();
    });
    // A7.1: the answer and the runtime's evidence become part of the conversation (the run
    // record is final now; the loop still holds the complete activity list and answer).
    crate::threads::sync_run(
        ctx.b,
        ctx.run_id,
        Some(crate::threads::RunFacts {
            final_text: ls.final_text.clone(),
            activity: ls.activity.clone(),
        }),
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_build_test_and_check_commands_count_as_verification() {
        let v =
            |prog: &str, a: &[&str]| is_verification_command(&json!({"program": prog, "args": a}));
        for (p, a) in [
            ("npm", &["test"][..]),
            ("npx", &["vitest", "run"]),
            ("cargo", &["test"]),
            ("cargo", &["clippy"]),
            ("python3", &["-m", "pytest", "-q"]),
            ("npx", &["tsc", "--noEmit"]),
            ("npm", &["run", "build"]),
            ("sh", &["-c", "npm test 2>&1 | tail"]),
            (
                "sh",
                &[
                    "-c",
                    "cd native && cargo test --offline -p nexus-client 2>&1 | tail -5",
                ],
            ),
            ("node", &["tests/NativeRegistryCatalog.Tests.cjs"]),
            ("go", &["vet", "./..."]),
            ("dotnet", &["build"]),
        ] {
            assert!(v(p, a), "{p} {a:?}");
        }
        for (p, a) in [
            ("npm", &["ci"][..]),
            ("npm", &["install", "--legacy-peer-deps"]),
            ("pip", &["install", "-r", "requirements.txt"]),
            ("node", &["--version"]),
            ("sh", &["-c", "ls node_modules/.bin"]),
            // words inside file names / patterns of read-only commands verify nothing
            ("sh", &["-c", "grep -n \"check\\|test\" config/registry/resolver.cjs | head; echo ---; sed -n 1,5p tests/NativeRegistryCatalog.Tests.cjs"]),
            ("sh", &["-c", "cat > /tmp/dbg.cjs <<'EOF'\nconst r = require('./check')\nEOF"]),
            ("git", &["diff", "--stat", "tests/"]),
            ("cargo", &["fetch"]),
            ("python3", &["-m", "pip", "install", "x"]),
        ] {
            assert!(!v(p, a), "{p} {a:?}");
        }
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_three_read_tools_are_proposable() {
        for (name, args) in [
            ("fs_list", json!({})),
            ("fs_list", json!({"path": "src"})),
            (
                "fs_read",
                json!({"path": "src/a.rs", "startLine": 3, "maxLines": 40}),
            ),
            (
                "fs_search",
                json!({"query": "needle", "maxMatches": 10, "caseInsensitive": true}),
            ),
        ] {
            assert!(validate_proposal(name, &args).is_ok(), "{name} {args}");
        }
        for name in [
            "fs_write",
            "fs_edit",
            "proc_run",
            "fs.read",
            "fs.write",
            "proc.run",
            "shell",
            "bash",
            "daemon",
            "tool-execute",
            "model-redeem",
            "",
            "FS_READ",
            "fs_read ",
            "fs_read\0",
        ] {
            let r = validate_proposal(name, &json!({"path": "x"})).unwrap_err();
            assert_eq!(r.code, "unknown-tool", "{name:?}");
        }
    }

    #[test]
    fn arguments_are_strict_and_bounded_before_the_kernel_sees_them() {
        let bad: Vec<(&str, Value)> = vec![
            ("fs_read", json!({})),
            ("fs_read", json!({"path": "a", "write": true})),
            ("fs_read", json!({"path": "a", "startLine": 0})),
            ("fs_read", json!({"path": "a", "maxLines": 801})),
            ("fs_read", json!({"path": "../etc/passwd"})),
            ("fs_read", json!({"path": "a/../../b"})),
            ("fs_read", json!({"path": "/etc/passwd"})),
            ("fs_read", json!({"path": "a\u{0}b"})),
            ("fs_read", json!({"path": "x".repeat(2000)})),
            ("fs_read", json!([1, 2])),
            ("fs_read", json!("path")),
            ("fs_list", json!({"path": 5})),
            ("fs_list", json!({"path": ".", "recursive": true})),
            ("fs_search", json!({"query": ""})),
            ("fs_search", json!({"query": "x".repeat(257)})),
            ("fs_search", json!({"query": "a", "maxMatches": 101})),
            ("fs_search", json!({"query": "a", "maxMatches": 0})),
            ("fs_search", json!({"query": "a", "regex": true})),
        ];
        for (n, a) in bad {
            let r = validate_proposal(n, &a).unwrap_err();
            assert_eq!(r.code, "invalid-arguments", "{n} {a}");
        }
    }

    #[test]
    fn rendered_results_are_bounded_labeled_and_line_numbered() {
        let result = json!({
            "status": "ok", "toolId": "fs.read",
            "output": {"path": "a.rs", "content": "alpha\nbeta\ngamma", "startLine": 10, "linesReturned": 3, "eof": true},
            "truncation": {"truncated": false, "reasons": []},
            "redaction": {"redacted": false, "count": 0, "kinds": []},
        });
        let r = render_result("fs_read", &result, PER_RESULT_BYTES);
        let v: Value = serde_json::from_str(&r.text).unwrap();
        assert_eq!(v["untrustedRepositoryContent"], json!(true));
        assert_eq!(
            v["result"]["content"],
            json!("10: alpha\n11: beta\n12: gamma")
        );
        // oversized collections shrink to fit, honestly flagged
        let many: Vec<Value> = (0..5000)
            .map(|i| json!({"name": format!("file_{i}.rs"), "kind": "file"}))
            .collect();
        let list = json!({"status": "ok", "output": {"path": ".", "entries": many},
            "truncation": {"truncated": false, "reasons": []}, "redaction": {"redacted": false}});
        let r = render_result("fs_list", &list, 4096);
        assert!(r.text.len() <= 4096 && r.truncated);
        let v: Value = serde_json::from_str(&r.text).unwrap();
        assert_eq!(v["status"], json!("truncated"));
        assert!(v["truncationReasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x == "broker-result-cap"));
        // errors never carry tool output
        let e = render_result(
            "fs_read",
            &json!({"status": "error", "error": {"code": "not-found", "message": "x"}}),
            4096,
        );
        assert!(e.is_error && e.text.contains("not-found"));
    }

    #[test]
    fn citations_are_matched_only_against_bytes_a_tool_returned() {
        let mut ev = Evidence::default();
        ev.add_read("src/auth.rs", 4, 11); // 4..=14
        ev.add_line("src/dispatch.rs", 10);
        let (v, u) = check_citations(
            "See src/auth.rs:5-13 and src/dispatch.rs:10, also src/auth.rs:99 and src/ghost.rs:1-3 (src/auth.rs:12-20).",
            &ev,
        );
        assert_eq!(v, ["src/auth.rs:5-13", "src/dispatch.rs:10"]);
        assert_eq!(
            u,
            ["src/auth.rs:99", "src/ghost.rs:1-3", "src/auth.rs:12-20"]
        );
    }

    #[test]
    fn limits_default_and_only_tighten() {
        let mut i = NexusIntentV1::parse(&json!({
            "schemaVersion": 1, "requestId": "r1", "idempotencyKey": "idem-0001",
            "intentType": "repo-inspect", "content": "x", "workspaceId": "w",
        }))
        .unwrap();
        let l = resolve_limits(&i);
        assert_eq!(
            (l.turns, l.tool_calls),
            (DEFAULT_MAX_TURNS, DEFAULT_MAX_TOOL_CALLS)
        );
        i.limits.max_turns = Some(2);
        assert_eq!(resolve_limits(&i).turns, 2);
    }

    #[test]
    fn the_controllers_attempt_bound_is_a_clean_limit_not_a_failure() {
        assert!(is_attempt_limit("too-many-attempts"));
        assert!(is_attempt_limit("bridge-too-many-attempts"));
        assert!(!is_attempt_limit("bridge-error"));
    }

    #[test]
    fn authority_failures_end_the_run_while_tool_errors_go_to_the_model() {
        for c in [
            "scope-refused",
            "intent-fenced",
            "revoked",
            "binding-mismatch",
            "stale-lease",
            "unreachable",
        ] {
            assert!(is_authority_failure(c), "{c}");
        }
        for c in [
            "not-found",
            "sensitive-path-refused",
            "file-too-large",
            "binary-file",
            "symlink-refused",
        ] {
            assert!(!is_authority_failure(c), "{c}");
        }
    }

    fn output_with(text: &str, messages: Vec<(Option<&str>, &str)>) -> nexus_client::TurnOutput {
        nexus_client::TurnOutput {
            text: text.to_owned(),
            messages: messages
                .into_iter()
                .map(|(p, t)| nexus_model::AssembledMessage {
                    item_id: String::new(),
                    phase: p.map(str::to_owned),
                    text: t.to_owned(),
                })
                .collect(),
            reasoning: Vec::new(),
            tool_calls: Vec::new(),
            usage: None,
            response_id: None,
            finish_reason: "stop".into(),
            http_status: Some(200),
            provider_request_id: None,
            first_token_ms: None,
            latency_ms: 0,
            request_digest: String::new(),
            partial_tool: false,
        }
    }

    #[test]
    fn the_models_preambles_go_back_with_their_phase_and_unlabelled_text_stays_plain() {
        // labelled: one item per message, phase intact, in wire order
        let mut items = Vec::new();
        push_model_text(
            &mut items,
            &output_with(
                "Reading the file.Done reading.",
                vec![
                    (Some("commentary"), "Reading the file."),
                    (None, "Done reading."),
                ],
            ),
        );
        assert_eq!(
            items,
            vec![
                InputItem::AssistantPhase {
                    phase: "commentary".into(),
                    content: "Reading the file.".into()
                },
                InputItem::Message {
                    role: "assistant".into(),
                    content: "Done reading.".into()
                },
            ]
        );
        // no phase anywhere (older providers, the test fixtures): exactly the old behaviour
        let mut items = Vec::new();
        push_model_text(
            &mut items,
            &output_with("plain narration", vec![(None, "plain narration")]),
        );
        assert_eq!(
            items,
            vec![InputItem::Message {
                role: "assistant".into(),
                content: "plain narration".into()
            }]
        );
        let mut items = Vec::new();
        push_model_text(&mut items, &output_with("from deltas only", vec![]));
        assert_eq!(items.len(), 1);
        // nothing to replay
        let mut items = Vec::new();
        push_model_text(
            &mut items,
            &output_with("  ", vec![(Some("commentary"), " ")]),
        );
        assert!(items.is_empty());
    }

    #[test]
    fn replayed_text_keeps_the_old_total_bound_across_labelled_items() {
        let a = "a".repeat(6 * 1024);
        let b = "b".repeat(6 * 1024);
        let mut items = Vec::new();
        push_model_text(
            &mut items,
            &output_with("", vec![(Some("commentary"), &a), (Some("commentary"), &b)]),
        );
        let total: usize = items
            .iter()
            .map(|i| match i {
                InputItem::AssistantPhase { content, .. } => content.chars().count(),
                _ => 0,
            })
            .sum();
        assert_eq!(total, REPLAYED_TEXT_CHARS);
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn the_models_reasoning_goes_back_before_its_text_and_only_the_latest_items_are_kept() {
        let item = |n: usize| {
            nexus_model::sse::replayable_reasoning(&serde_json::json!({
                "type": "reasoning", "id": format!("rs_{n}"), "encrypted_content": "AAAA", "summary": []
            }))
            .unwrap()
        };
        let mut items = vec![InputItem::Message {
            role: "user".into(),
            content: "task".into(),
        }];
        for n in 0..(REASONING_REPLAY_ITEMS + 3) {
            let mut out = output_with("Reading.", vec![(Some("commentary"), "Reading.")]);
            out.reasoning = vec![item(n)];
            push_model_reasoning(&mut items, &out);
            push_model_text(&mut items, &out);
        }
        let kept: Vec<&String> = items
            .iter()
            .filter_map(|i| match i {
                InputItem::Reasoning { item } => Some(item),
                _ => None,
            })
            .collect();
        assert_eq!(kept.len(), REASONING_REPLAY_ITEMS);
        assert!(
            kept[0].contains("rs_3")
                && kept
                    .last()
                    .unwrap()
                    .contains(&format!("rs_{}", REASONING_REPLAY_ITEMS + 2))
        );
        // every kept reasoning item directly precedes its own response's preamble
        for (i, it) in items.iter().enumerate() {
            if matches!(it, InputItem::Reasoning { .. }) {
                assert!(matches!(items[i + 1], InputItem::AssistantPhase { .. }));
            }
        }
        // the task message is never touched
        assert!(matches!(&items[0], InputItem::Message { content, .. } if content == "task"));
    }
}
