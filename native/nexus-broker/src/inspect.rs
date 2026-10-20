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
    fn profile(self) -> nexus_model::ToolProfile {
        match self {
            Self::Inspect => nexus_model::ToolProfile::RepoInspectV1,
            Self::Code => nexus_model::ToolProfile::RepoCodeV1,
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
    if mode == Mode::Code {
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
        let sel = serde_json::json!({
            "logicalModelId": m.logical_model_id.clone().unwrap_or_default(),
            "routeId": m.route_id.clone().unwrap_or_default(),
        });
        selection_json = serde_json::to_string(&sel).unwrap_or_default();
        issue_args.push(&selection_json);
    }
    let issued = bridge(b, "issue", &issue_args, None)?;
    let resolution = issued.get("resolution").cloned().unwrap_or_default();
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
    if mode == Mode::Code {
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
            resolution: &resolution,
            extension: &extension,
            extension_digest: &extension_digest,
            lease_epoch,
            incarnation: &incarnation,
            ws_digest: &ws_digest,
            root: &root,
            expected: expected.clone(),
            ctx_budget,
        },
        &mut loop_state,
    );
    finalize(&ctx, &mut session, &cfg, &loop_state, result);
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
    resolution: &'a Value,
    extension: &'a Value,
    extension_digest: &'a str,
    lease_epoch: u64,
    incarnation: &'a str,
    ws_digest: &'a str,
    root: &'a str,
    #[allow(dead_code)]
    expected: Option<nexus_client::ExpectedTarget>,
    ctx_budget: usize,
}

#[derive(Default)]
struct LoopState {
    /// Turns whose conversation was shortened by the context manager (A6.1.4).
    compactions: u32,
    /// Provider interruptions recovered from (autonomy-first refactor).
    recoveries: u32,
    activity: Vec<ToolActivity>,
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
    tidy_nudges: u32,
    /// Times the harness asked the model to continue instead of accepting its reply.
    nudges: u32,
    verify_nudges: u32,
    fail_nudges: u32,
    report_nudges: u32,
    mode_code: bool,
    /// The request asks for an implementation (decided from its text, read-only runs never).
    expects_change: bool,
    /// The copy already holds changes of earlier runs (a continuation / follow-up): a run that
    /// only verifies them is legitimately edit-free and tool-free.
    carried_work: bool,
    plan_nudges: u32,
    /// Verification commands (by arguments digest) whose latest result is a failure. A later pass of
    /// the SAME command clears it; a pass of a different, narrower command does not.
    failed_checks: std::collections::BTreeSet<String>,
    /// edits + checks at the last stall-budget refresh (see `refresh_stall_budget`)
    progress_mark: u32,
    steers: u32,
    /// Normalized progress sentences of the last turns (a narration loop shows here).
    recent_narration: Vec<String>,
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

#[allow(clippy::too_many_arguments)]
/// Times the harness will ask a model that stopped early to carry on.
pub const MAX_NUDGES: u32 = 7;

/// A reply that has the shape of a finished written report (long and structured).
fn looks_like_report(t: &str) -> bool {
    t.len() >= 1500
        && t.lines().any(|l| {
            let l = l.trim_start();
            l.starts_with('#')
                || l.starts_with("**")
                || l.starts_with("- ")
                || l.starts_with("* ")
                || l.split_once('.')
                    .is_some_and(|(n, _)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
}

/// Edits and writes that really executed in this run (receipts, not proposals).
fn applied_edits(ls: &LoopState) -> u32 {
    ls.activity
        .iter()
        .filter(|a| matches!(a.tool.as_str(), "fs_edit" | "fs_write") && a.status == "executed")
        .count() as u32
}

/// The nudge budgets bound CONSECUTIVE stalls, not the length of a run. Found live: a productive
/// run (20 edits, 7 files, 4 test runs) ended "incomplete" at turn 120 because the model's habit of
/// ending turns on "Next: ..." had used the run-wide budget of 5 over those 120 turns. A real edit or
/// check since the last refresh proves the earlier stalls were overcome, so the budgets start over.
fn refresh_stall_budget(ls: &mut LoopState) {
    let progress = ls.edits_used + ls.tests_used;
    if progress > ls.progress_mark {
        ls.progress_mark = progress;
        ls.nudges = 0;
        ls.plan_nudges = 0;
        ls.report_nudges = 0;
        ls.verify_nudges = 0;
        ls.fail_nudges = 0;
    }
}

/// Should the harness refuse to accept this reply as the end of the task? Returns the
/// message to send the model and a short reason for the timeline. The check is about the
/// SHAPE of the stop (work visibly unfinished), never about the quality of the answer.
fn premature_stop(ls: &mut LoopState, text: &str) -> Option<(&'static str, &'static str)> {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    // 0. an implementation was asked for, nothing was changed and nothing was verified, yet
    //    the model ended on a plan or on tool calls written as prose (found live: a 40 KB
    //    planning ramble was accepted as the finished task)
    if ls.expects_change
        && applied_edits(ls) == 0
        && ls.last_test.as_deref() != Some("pass")
        && ls.plan_nudges < crate::completion::MAX_PLAN_NUDGES
    {
        if crate::completion::text_tool_calls(t) {
            ls.plan_nudges += 1;
            return Some((
                crate::completion::MSG_TEXT_CALLS,
                "tool calls written as text",
            ));
        }
        if crate::completion::plan_like(t)
            || t.is_empty()
            || (ls.tool_calls == 0 && !ls.carried_work)
        {
            ls.plan_nudges += 1;
            return Some((crate::completion::MSG_PLAN, "a plan instead of the work"));
        }
    }
    // 0b. changes exist, but the model stopped on "now the next step" (found live: five edits,
    //     then a one-line announcement was accepted as the end of the task)
    if ls.expects_change
        && ls.plan_nudges < crate::completion::MAX_PLAN_NUDGES
        && crate::completion::announcement(t)
    {
        ls.plan_nudges += 1;
        return Some((
            crate::completion::MSG_ANNOUNCE,
            "an announcement instead of the step",
        ));
    }
    // 1. an announcement of the next step instead of the step
    const MIDFLIGHT: [&str; 10] = [
        "re-issuing",
        "reissuing",
        "let me ",
        "i'll ",
        "i will ",
        "now i",
        "next, i",
        "continuing",
        "going to ",
        "proceeding",
    ];
    if ls.tool_calls > 0
        && t.len() < 700
        && (t.is_empty() || MIDFLIGHT.iter().any(|m| lower.contains(m)))
    {
        return Some((
            "You ended your turn without making the next tool call or writing the final answer. Continue the work now: call the tools you need, or if you are finished, write the complete final answer (for a review, the full report with evidence).",
            "no tool call and no final answer",
        ));
    }
    // 1b. a long investigation that ends without a written report
    if ls.edits_used == 0
        && ls.last_test.is_none()
        && ls.tool_calls >= 8
        && ls.report_nudges < 3
        && !looks_like_report(t)
    {
        ls.report_nudges += 1;
        return Some((
            "Your last message is not a finished report. Do not plan or narrate further. If you still need evidence, make the tool calls now (one call per step is fine). Otherwise write the COMPLETE final report now as your reply: headings, each finding with severity, the file path and line numbers you actually read, why it matters and a recommended fix, then a prioritized summary and what you did not inspect.",
            "no finished report yet",
        ));
    }
    // 1c. scratch files left in the project
    if ls.tidy_nudges < 1 {
        let junk: Vec<&String> = ls
            .created
            .iter()
            .filter(|p| {
                let l = p.to_ascii_lowercase();
                [".new", ".bak", ".orig", ".tmp", ".old", "~"]
                    .iter()
                    .any(|e| l.ends_with(e))
            })
            .collect();
        if !junk.is_empty() {
            ls.tidy_nudges += 1;
            return Some((
                "You left scratch files in the project that are not part of the change. Delete them now with fs_write mode \"delete\" (and only them), then give your final answer.",
                "scratch files left behind",
            ));
        }
    }
    // 2. changes that were never verified
    if ls.edits_used > 0
        && ls.dirty_since_test
        && ls.verify_nudges < if ls.expects_change { 3 } else { 1 }
    {
        ls.verify_nudges += 1;
        return Some((
            "You changed files but no build, test or type-check has run since your last change. Run the project's verification now (install dependencies first if they are missing) and fix anything that fails. Only then give your final answer.",
            "changes not verified",
        ));
    }
    // 3a. verification commands are still failing although the LAST one passed (a narrower command
    //     hides them; found live: five unresolved failures and a closing 15 KB narration)
    if ls.last_test.as_deref() != Some("fail")
        && !ls.failed_checks.is_empty()
        && ls.edits_used > 0
        && ls.fail_nudges < 2
    {
        ls.fail_nudges += 1;
        return Some((
            crate::completion::MSG_UNRESOLVED_CHECKS,
            "failed checks never re-run successfully",
        ));
    }
    // 3. the last verification failed
    if ls.last_test.as_deref() == Some("fail") && ls.edits_used > 0 && ls.fail_nudges < 2 {
        ls.fail_nudges += 1;
        return Some((
            "Your last verification command failed. Read its output. If your change caused it, fix the cause and run it again. If the failure was already there and is unrelated to the task, do not widen the task to fix it: say so explicitly in your final answer with the evidence.",
            "last verification failed",
        ));
    }
    None
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
        let pre = crate::guidance::code_preamble_body(&kinds, true);
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
        let req = ModelRunRequest {
            user_initiated: true,
            prompt: sh.intent.content.clone(),
            task_instance_id: sh.task_instance.to_owned(),
            command_id: command_id.clone(),
            attempt_id: attempt_id.clone(),
            lease_epoch: sh.lease_epoch,
            store_incarnation: sh.incarnation.to_owned(),
            intent_digest: str_of(&kintent, "intentDigest")?,
            resolution: sh.resolution.clone(),
            snapshot: sh.issued.get("snapshot").cloned().unwrap_or_default(),
            core: sh.issued.get("core").cloned().unwrap_or_default(),
            extension: sh.extension.clone(),
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
        let prepared = nexus_client::prepare_inspect_turn(&req, &items, sh.mode.profile())
            .map_err(|e| se("prepare-refused", e.message))?;
        let bundle = bridge(
            b,
            sh.mode.publish(),
            &[],
            Some(&serde_json::json!({
                "shadowIntent": shadow_intent,
                "lease": { "epoch": sh.lease_epoch, "storeIncarnation": sh.incarnation },
                "role": sh.issued.get("role"),
                "issuance": { "taskInstanceId": sh.task_instance, "resolution": sh.resolution },
                "extensionDigest": sh.extension_digest,
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
                "intent": kintent, "resolution": sh.resolution,
                "snapshot": sh.issued.get("snapshot").cloned().unwrap_or_default(),
                "lease": { "epoch": sh.lease_epoch, "storeIncarnation": sh.incarnation },
            }),
        )?;
        // The Kernel binds the workspace itself and only if the accepted
        // Controller intent committed to exactly this root digest.
        daemon(
            b,
            "workspace-bind",
            serde_json::json!({ "commandId": command_id, "root": sh.root }),
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
                profile: sh.mode.profile(),
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
            refresh_stall_budget(ls);
            if b.cfg.interactive && sh.mode == Mode::Code && ls.nudges < MAX_NUDGES {
                if let Some(msg) = premature_stop(ls, &out.text) {
                    ls.nudges += 1;
                    let n = ls.nudges;
                    let _ = session.state(
                        nexus_client::model_run::ModelRunState::ToolRunning,
                        &format!(
                            "The model stopped early; asking it to continue ({n}): {}",
                            msg.1
                        ),
                        None,
                    );
                    if !out.text.trim().is_empty() {
                        items.push(InputItem::Message {
                            role: "assistant".into(),
                            content: out.text.chars().take(8 * 1024).collect(),
                        });
                    }
                    items.push(InputItem::Message {
                        role: "user".into(),
                        content: msg.0.to_owned(),
                    });
                    continue;
                }
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
        ls.recent_narration
            .push(crate::completion::normalize_narration(&out.text));
        if ls.recent_narration.len() > 4 {
            ls.recent_narration.remove(0);
        }
        if !out.text.trim().is_empty() {
            items.push(InputItem::Message {
                role: "assistant".into(),
                content: out.text.chars().take(8 * 1024).collect(),
            });
        }
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
            let rendered = match validated {
                Err(r) => {
                    act.status = "refused".into();
                    act.error_code = Some(r.code.to_owned());
                    let _ =
                        session.tool_call(idx, &call_id, &act.tool, &args_echo, "refused", true);
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
                                render_error(p.model_name, "refused", "the operation was not run")
                            })
                        } else {
                            // 3. Kernel-mediated execution via the existing tool path.
                            let mut exec = params.clone();
                            exec["aiOrigin"] = serde_json::json!(origin_tag);
                            let resp = exec_with_cancel(b, ctx.flag, &exec, command_id.as_str());
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
                                    act.journal_seq =
                                        v.pointer("/execution/journalSeq").and_then(|x| x.as_i64());
                                    if r.is_error {
                                        act.error_code = result
                                            .pointer("/error/code")
                                            .and_then(|x| x.as_str())
                                            .map(str::to_owned);
                                    }
                                    record_evidence(&mut evidence, p.model_name, &p.args, &result);
                                    record_receipts(ls, &mut act, &cp, &result);
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
        // An implementation task that keeps reading: after a block of tool calls with no change
        // (or the same progress sentence three turns running) tell the model to start. Bounded;
        // it creates no side effect and does not stop the run.
        if ls.expects_change && applied_edits(ls) == 0 && ls.steers < crate::completion::MAX_STEERS
        {
            let due = ls.tool_calls >= crate::completion::STEER_EVERY * (ls.steers + 1);
            if due || crate::completion::repeated_narration(&ls.recent_narration) {
                ls.steers += 1;
                let n = ls.tool_calls;
                let _ = session.state(
                    nexus_client::model_run::ModelRunState::ToolRunning,
                    &format!("{n} tool calls and no change yet; asking the model to start implementing (reminder {}).", ls.steers),
                    None,
                );
                items.push(InputItem::Message {
                    role: "user".into(),
                    content: crate::completion::steer_message(n),
                });
                ls.recent_narration.clear();
            }
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
                let key = act
                    .args_digest
                    .clone()
                    .unwrap_or_else(|| act.args_summary.clone());
                match act.verification.as_deref() {
                    Some("pass") => {
                        ls.failed_checks.remove(&key);
                    }
                    Some("fail") => {
                        ls.failed_checks.insert(key);
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
fn is_verification_command(args: &Value) -> bool {
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

    #[test]
    #[allow(clippy::field_reassign_with_default)]
    fn the_harness_does_not_accept_an_announcement_or_an_unverified_change_as_the_end() {
        let mut ls = LoopState::default();
        ls.tool_calls = 12;
        // announcing the next step instead of taking it
        assert!(premature_stop(&mut ls, "Let me check the remaining files now.").is_some());
        // a long investigation that never wrote a report
        let mut ls = LoopState::default();
        ls.tool_calls = 30;
        let narr = "Collecting evidence and validating findings. ".repeat(10);
        assert!(premature_stop(&mut ls, &narr).is_some());
        // a finished, structured report is accepted
        let report = format!(
            "# Report\n\n- finding one\n- finding two\n\n{}",
            "Evidence and analysis. ".repeat(100)
        );
        let mut ls = LoopState::default();
        ls.tool_calls = 30;
        assert!(premature_stop(&mut ls, &report).is_none());
        // changed files with no verification since: asked once, then accepted
        let mut ls = LoopState::default();
        ls.tool_calls = 5;
        ls.edits_used = 2;
        ls.dirty_since_test = true;
        let done = "Implemented the change in two files and added tests.";
        assert!(premature_stop(&mut ls, done).is_some());
        assert!(premature_stop(&mut ls, done).is_none(), "asked only once");
        // a failing last verification is questioned (twice at most)
        let mut ls = LoopState::default();
        ls.tool_calls = 5;
        ls.edits_used = 1;
        ls.last_test = Some("fail".into());
        assert!(premature_stop(&mut ls, done).is_some());
        assert!(premature_stop(&mut ls, done).is_some());
        assert!(premature_stop(&mut ls, done).is_none());
        // a short answer after verified work is fine
        let mut ls = LoopState::default();
        ls.tool_calls = 9;
        ls.edits_used = 1;
        ls.last_test = Some("pass".into());
        assert!(premature_stop(&mut ls, done).is_none());
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

    const INCIDENT: &str = include_str!("../tests/fixtures/planning-loop-final-answer.txt");

    #[test]
    #[allow(clippy::field_reassign_with_default)]
    fn a_planning_ramble_is_no_longer_accepted_as_the_finished_task() {
        // the mechanism of the incident: after 40 read-only calls the 40 KB ramble LOOKS like a report
        assert!(looks_like_report(INCIDENT));
        let mut ls = LoopState::default();
        ls.tool_calls = 40;
        // an old-style run (no implementation intent) would have been accepted
        assert!(premature_stop(&mut ls, INCIDENT).is_none());
        // an implementation task with nothing changed and nothing verified is redirected, three times
        let mut ls = LoopState::default();
        ls.tool_calls = 40;
        ls.expects_change = true;
        for _ in 0..3 {
            let (msg, why) = premature_stop(&mut ls, INCIDENT).expect("nudged");
            assert!(
                msg.contains("IMPLEMENT") || msg.contains("plain text"),
                "{msg}"
            );
            assert!(why.contains("plan") || why.contains("text"), "{why}");
        }
        assert_eq!(ls.plan_nudges, 3);
        // an applied edit or a passing check changes the picture: no plan nudge
        let mut ls = LoopState::default();
        ls.tool_calls = 40;
        ls.expects_change = true;
        ls.last_test = Some("pass".into());
        assert!(premature_stop(&mut ls, INCIDENT).is_none());
        assert_eq!(ls.plan_nudges, 0);
        // a read-only / non-implementation run is never nudged by this rule
        let mut ls = LoopState::default();
        ls.tool_calls = 40;
        assert_eq!(ls.plan_nudges, 0);
        let _ = premature_stop(&mut ls, INCIDENT);
        assert_eq!(ls.plan_nudges, 0);
    }

    #[test]
    #[allow(clippy::field_reassign_with_default)]
    fn stall_budgets_start_over_when_the_run_makes_progress() {
        // found live: 20 edits over 120 turns, ended "incomplete" because the run-wide budget of
        // announcement nudges was spent
        let mut ls = LoopState::default();
        ls.expects_change = true;
        ls.tool_calls = 30;
        ls.edits_used = 1;
        ls.activity.push(ToolActivity {
            tool: "fs_edit".into(),
            status: "executed".into(),
            ..Default::default()
        });
        // the caller's gate, as in the run loop
        let stop = |ls: &mut LoopState| -> u32 {
            let mut nudged = 0;
            loop {
                refresh_stall_budget(ls);
                if ls.nudges < MAX_NUDGES
                    && premature_stop(ls, "Next: inspect the stub. Proceeding.").is_some()
                {
                    ls.nudges += 1;
                    nudged += 1;
                } else {
                    return nudged;
                }
            }
        };
        let first = stop(&mut ls);
        assert!((1..=MAX_NUDGES).contains(&first), "bounded: {first}");
        // no progress: the next stop is final
        assert_eq!(stop(&mut ls), 0);
        // every further edit or check is progress: the model is asked again, many times over
        for _ in 0..6 {
            ls.edits_used += 1;
            assert!(stop(&mut ls) >= 1);
            assert_eq!(stop(&mut ls), 0);
        }
    }

    #[test]
    #[allow(clippy::field_reassign_with_default)]
    fn unresolved_failed_checks_are_asked_about_whatever_the_length_of_the_closing_text() {
        // run 14 of the R-NATIVE-3 acceptance: edits made, the LAST check passed, five checks failed and
        // were never re-run, and the closing message was 15 KB of narration (every length-capped gate
        // in premature_stop looked past it)
        let text = include_str!("../tests/fixtures/run14-terminal-response.txt");
        let mut ls = LoopState::default();
        ls.expects_change = true;
        ls.tool_calls = 184;
        ls.edits_used = 41;
        ls.last_test = Some("pass".into());
        // no unresolved failure: nothing to ask (the earlier blind spot, documented)
        assert!(premature_stop(&mut ls, text).is_none());
        for k in ["a", "b", "c", "d", "e"] {
            ls.failed_checks.insert(k.into());
        }
        let (msg, why) = premature_stop(&mut ls, text).expect("asked about the failed checks");
        assert!(msg.contains("were never re-run successfully"), "{msg}");
        assert!(why.contains("failed checks"), "{why}");
        // bounded: asked twice, then the run ends (as `failing-checks`, not `fulfilled`)
        assert!(premature_stop(&mut ls, text).is_some());
        assert!(premature_stop(&mut ls, text).is_none());
        // a short text is asked about just the same
        let mut ls2 = LoopState::default();
        ls2.expects_change = true;
        ls2.tool_calls = 10;
        ls2.edits_used = 3;
        ls2.last_test = Some("pass".into());
        ls2.failed_checks.insert("x".into());
        assert!(premature_stop(&mut ls2, "All done.").is_some());
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
}
