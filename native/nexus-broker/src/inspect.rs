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
        let eff = b.cfg.code_caps.effective();
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
        let eff = b.cfg.code_caps.effective();
        policy.max_edits = policy.max_edits.min(eff.max_edits);
        policy.max_tests = policy.max_tests.min(eff.max_tests);
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
            && on("requireHumanApproval"))
        {
            return Err(se(
                "code-not-available",
                "the daemon is not configured for autonomous coding (repo-code, writes, processes and mandatory human approval must all be enabled)",
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
    let issued = bridge(
        b,
        "issue",
        &[&repo, &data, &task_instance, &session_id],
        None,
    )?;
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
    if let Some(m) = &intent.model {
        if m.provider_id != provider_id || m.remote_model_id != remote_model_id {
            return Err(se(
                "model-not-available",
                "the Registry target differs from the requested provider/model; no substitution",
            ));
        }
    }
    let out_tokens = limits.output_tokens.or(Some(DEFAULT_MAX_OUTPUT_TOKENS));
    // The sealed output limit is a ceiling the request may only lower.
    let sealed_out = extension
        .get("outputLimitTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let out_tokens = out_tokens.map(|n| if sealed_out > 0 { n.min(sealed_out) } else { n });

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
                "this broker process predates the installed nexus-broker binary; restart it (nothing sent, authorization kept)",
            )));
        }
        crate::live_auth::consume_session(
            &b.cfg.state_dir,
            &crate::live_auth::SessionAttempt {
                intent_type: mode.scope(),
                provider_id: &provider_id,
                remote_model_id: &remote_model_id,
                workspace_id: &workspace_id,
                prompt: &intent.content,
                max_turns: limits.turns,
                max_tool_calls: limits.tool_calls,
                max_output_tokens: limits.output_tokens,
                max_tool_result_bytes: limits.result_bytes,
            },
        )
        .map_err(|(c, m)| discard(se(c, m)))?;
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
    b.update(run_id, |r| {
        r.conversation_id = Some(conv.clone());
        r.provider_id = Some(provider_id.clone());
        r.remote_model_id = Some(remote_model_id.clone());
        r.logical_model_id = Some(logical_model_id.clone());
        r.endpoint_kind = Some(session.endpoint_kind().to_owned());
    });
    if flag.load(Ordering::SeqCst) {
        let _ = nexus_client::request_model_cancel(&cfg, &conv);
    }

    // From here a conversation exists: every exit records a terminal state.
    let mut loop_state = LoopState {
        mode_code: mode == Mode::Code,
        ..Default::default()
    };
    let result = turn_loop(
        &ctx,
        &mut session,
        &opts,
        &limits,
        out_tokens,
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
        },
        &mut loop_state,
    );
    finalize(&ctx, &mut session, &cfg, &loop_state, result);
    Ok(())
}

struct Shared<'a> {
    mode: Mode,
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
}

#[derive(Default)]
struct LoopState {
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
    mode_code: bool,
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

#[allow(clippy::too_many_arguments)]
fn turn_loop(
    ctx: &Ctx<'_>,
    session: &mut InspectSession,
    opts: &ModelRunOptions,
    limits: &Limits,
    out_tokens: Option<u64>,
    started: &Instant,
    sh: &Shared<'_>,
    ls: &mut LoopState,
) -> Result<LoopEnd, StepError> {
    let b = ctx.b;
    let ledger = b.cfg.ledger_workspace.to_string_lossy().into_owned();
    let mut items: Vec<InputItem> = vec![InputItem::Message {
        role: "user".into(),
        content: sh.intent.content.clone(),
    }];
    let mut evidence = Evidence::default();
    let mut seen_calls: Vec<String> = Vec::new();
    let mut refusals_in_a_row = 0u32;
    let mut attempt_id = b
        .store
        .load(ctx.run_id)
        .and_then(|r| r.run.attempt_id)
        .unwrap_or_default();

    for turn in 1..=limits.turns {
        if ctx.stop() {
            return Ok(LoopEnd::Cancelled);
        }
        if started.elapsed() >= limits.runtime {
            return Ok(LoopEnd::Limit("max-runtime"));
        }
        // Each model turn is its own Controller attempt of the same task.
        if turn > 1 {
            let _g = b.bridge_lock.lock().unwrap_or_else(|p| p.into_inner());
            let a = bridge(
                b,
                "attempt-add",
                &[&ledger, sh.task_id, sh.task_instance],
                None,
            )?;
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
            max_output_tokens: out_tokens,
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
        session.begin_turn(turn, &attempt_id, &command_id, &prepared.request_digest);
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
        )
        .map_err(|e| se(e.code, e.message))?;
        let out = match end {
            TurnEnd::Output(o) => *o,
            TurnEnd::Ended { .. } => return Ok(LoopEnd::Recorded),
        };
        if let Some((i, o)) = out.usage {
            ls.usage_in += i;
            ls.usage_out += o;
            ls.saw_usage = true;
            session.set_usage(ls.usage_in, ls.usage_out);
        }
        ls.final_text = out.text.clone();
        ls.last_output = Some(out.clone());
        let proposals = out.tool_calls.clone();
        if proposals.is_empty() {
            if out.finish_reason.starts_with("incomplete:") {
                return Ok(LoopEnd::Limit("output-limit"));
            }
            let (v, u) = check_citations(&out.text, &evidence);
            ls.citations_verified = v;
            ls.citations_unverified = u;
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
                &if sh.mode == Mode::Code {
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
                Mode::Code => {
                    crate::code::validate_code_proposal(&call.name, &call.arguments, &ls.last_sha)
                }
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
                            "budgets": budgets_for(cp.kind),
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
                                Err(e) => {
                                    let code = e
                                        .code
                                        .strip_prefix("daemon-")
                                        .unwrap_or(&e.code)
                                        .to_owned();
                                    // A lost answer to a WRITE or PROCESS is not a failure
                                    // we may assume: the operation may have happened. Stop,
                                    // keep the copy, and require explicit reconciliation.
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
            if refusals_in_a_row >= MAX_CONSECUTIVE_REFUSALS {
                return Ok(LoopEnd::Failed(
                    "too-many-refused-tool-calls".into(),
                    "the model kept proposing refused or invalid tool calls; the run was stopped"
                        .into(),
                ));
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
            if ls.edits_used >= pol.max_edits {
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
fn budgets_for(kind: Kind) -> Value {
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
    let ms = if long {
        crate::code::PROC_WALL_MS + 30_000
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
        }
        "proc_run" => {
            act.exit_code = out.get("exitCode").and_then(|v| v.as_i64());
            act.verification = out
                .get("verification")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            ls.last_test = act.verification.clone();
        }
        _ => {}
    }
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
            "status": if out.get("verification").and_then(|v| v.as_str()) == Some("pass") { "ok" } else { "failed" },
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
            let _ = session.state(S::Failed, &format!("Failed: {msg}"), Some(&code));
        }
        LoopEnd::Uncertain(code, msg) => {
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
    let (edits_used, tests_used, last_test) = (ls.edits_used, ls.tests_used, ls.last_test.clone());
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
        }
        r.stop_reason = stop_reason;
        r.updated_at_ms = now_ms();
    });
}

#[cfg(test)]
mod tests {
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
            ("fs_read", json!({"path": "a", "maxLines": 401})),
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
            ("fs_search", json!({"query": "a", "maxMatches": 51})),
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
