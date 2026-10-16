//! Single-use live-provider authorization (A5.4).
//!
//! A real provider call bills money and discloses the prompt. Neither a
//! credential file, a Registry route, a passing mock run nor a client request
//! authorizes one. Only an operator-created, issuer-private record does, and
//! it is consumed atomically BEFORE the Kernel grant is issued:
//!
//! * names the exact provider and remote model;
//! * binds the exact prompt by SHA-256 (the prompt itself is not stored);
//! * states the output-token ceiling the run may use (the intent must carry
//!   an explicit `limits.maxOutputTokens` not above it);
//! * covers exactly one attempt and expires;
//! * records the operator's acknowledgement that the call is billable.
//!
//! Absent, malformed, mismatched, expired or already-consumed records refuse
//! the run with nothing sent. The gate applies whenever the broker uses the
//! production HTTPS transport (no injected test transport) and the endpoint is
//! https; loopback test doubles and fixture builds cannot bill anyone.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const RECORD_FILE: &str = "live-authorization.json";
pub const MAX_TTL_SECS: u64 = 3600;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveAuthorization {
    pub provider_id: String,
    pub remote_model_id: String,
    pub prompt_sha256: String,
    pub max_output_tokens: u64,
    pub max_attempts: u32,
    pub billable_acknowledged: bool,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn prompt_digest(prompt: &str) -> String {
    hex::encode(Sha256::digest(prompt.as_bytes()))
}

pub fn record_path(state_dir: &Path) -> PathBuf {
    state_dir.join(RECORD_FILE)
}

/// Operator command: write the record (0600, create-new; never overwrites).
pub fn write_record(
    state_dir: &Path,
    provider_id: &str,
    remote_model_id: &str,
    prompt: &str,
    max_output_tokens: u64,
    ttl_secs: u64,
    acknowledged: bool,
) -> Result<LiveAuthorization, String> {
    if !acknowledged {
        return Err("--acknowledge-billable is required: a live call bills the account".into());
    }
    if provider_id.is_empty() || remote_model_id.is_empty() || prompt.trim().is_empty() {
        return Err("provider, model and a non-empty prompt are required".into());
    }
    if max_output_tokens == 0 || max_output_tokens > 4096 {
        return Err("--max-output-tokens must be 1..4096 for a live attempt".into());
    }
    if ttl_secs == 0 || ttl_secs > MAX_TTL_SECS {
        return Err(format!("--expires-in-secs must be 1..{MAX_TTL_SECS}"));
    }
    let rec = LiveAuthorization {
        provider_id: provider_id.to_owned(),
        remote_model_id: remote_model_id.to_owned(),
        prompt_sha256: prompt_digest(prompt),
        max_output_tokens,
        max_attempts: 1,
        billable_acknowledged: true,
        created_at_ms: now_ms(),
        expires_at_ms: now_ms() + ttl_secs * 1000,
    };
    let path = record_path(state_dir);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| {
            format!(
                "cannot create {}: {e} (an unconsumed record already exists?)",
                path.display()
            )
        })?;
    f.write_all(
        serde_json::to_string_pretty(&rec)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(rec)
}

/// What the run is about to do, as computed by the broker (not the client).
pub struct Attempt<'a> {
    pub provider_id: &'a str,
    pub remote_model_id: &'a str,
    pub prompt: &'a str,
    pub requested_max_output: Option<u64>,
}

/// Verify and CONSUME the record. The rename is the single-use point: two
/// racing runs cannot both win it, and a refusal after the rename still
/// leaves the record consumed (a new authorization is then required).
pub fn consume(state_dir: &Path, a: &Attempt<'_>) -> Result<LiveAuthorization, (String, String)> {
    let refuse = |m: &str| Err(("live-not-authorized".to_owned(), m.to_owned()));
    let path = record_path(state_dir);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => {
            return refuse("live provider use is not authorized: no operator authorization record")
        }
    };
    if !meta.file_type().is_file()
        || meta.permissions().mode() & 0o077 != 0
        || meta.uid() != unsafe { libc::geteuid() }
    {
        return refuse(
            "live authorization record is not a private file owned by the issuer identity",
        );
    }
    let consumed = state_dir.join(format!("live-authorization.consumed-{}.json", now_ms()));
    if std::fs::rename(&path, &consumed).is_err() {
        return refuse("live authorization was consumed by another run");
    }
    let rec: LiveAuthorization = match std::fs::read_to_string(&consumed)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(r) => r,
        None => return refuse("live authorization record is malformed"),
    };
    if !rec.billable_acknowledged || rec.max_attempts != 1 {
        return refuse(
            "live authorization lacks the billable acknowledgement or single-attempt bound",
        );
    }
    if now_ms() > rec.expires_at_ms {
        return refuse("live authorization has expired");
    }
    if rec.provider_id != a.provider_id || rec.remote_model_id != a.remote_model_id {
        return refuse("live authorization names a different provider or model");
    }
    if rec.prompt_sha256 != prompt_digest(a.prompt) {
        return refuse("live authorization was issued for a different prompt");
    }
    match a.requested_max_output {
        Some(n) if n >= 1 && n <= rec.max_output_tokens => {}
        Some(_) => return refuse("requested output limit exceeds the authorized budget"),
        None => return refuse("a live run must state limits.maxOutputTokens explicitly"),
    }
    Ok(rec)
}

use std::os::unix::fs::MetadataExt;

// ---------------------------------------------------------------------------
// A5.5: multi-call live SESSION authorization.
//
// A repo-inspect run makes several provider requests whose later bodies
// (tool results) cannot be known when the operator authorizes. The record is
// therefore a bounded SESSION BUDGET, never a reusable per-call token: it
// names the provider, model, workspace and the exact initial task text
// (SHA-256), and caps provider calls (turns), tool calls, output tokens per
// call and total tool-result bytes. It is consumed once, atomically, before
// the first grant is minted; the run can only be tighter than it, a restart
// never resumes (and so never re-spends) it, and an A5.4 single-call record
// is a different file with a different shape that can never satisfy it.

pub const SESSION_FILE: &str = "live-session-authorization.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveSessionAuthorization {
    /// `repo-inspect` (A5.5 records, the default when absent) or `repo-code`
    /// (A5.6). A record for one can never satisfy the other.
    #[serde(default = "default_intent_type")]
    pub intent_type: String,
    pub provider_id: String,
    pub remote_model_id: String,
    pub workspace_id: String,
    pub prompt_sha256: String,
    /// Maximum provider calls (one per model turn) in the session.
    pub max_turns: u32,
    pub max_tool_calls: u32,
    /// Output-token ceiling for EACH provider call.
    pub max_output_tokens: u64,
    pub max_tool_result_bytes: u64,
    pub billable_acknowledged: bool,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

fn default_intent_type() -> String {
    "repo-inspect".to_owned()
}

pub fn session_record_path(state_dir: &Path) -> PathBuf {
    state_dir.join(SESSION_FILE)
}

#[allow(clippy::too_many_arguments)]
pub fn write_session_record(
    state_dir: &Path,
    provider_id: &str,
    remote_model_id: &str,
    workspace_id: &str,
    prompt: &str,
    max_turns: u32,
    max_tool_calls: u32,
    max_output_tokens: u64,
    max_tool_result_bytes: u64,
    ttl_secs: u64,
    acknowledged: bool,
) -> Result<LiveSessionAuthorization, String> {
    write_session_record_for(
        "repo-inspect",
        state_dir,
        provider_id,
        remote_model_id,
        workspace_id,
        prompt,
        max_turns,
        max_tool_calls,
        max_output_tokens,
        max_tool_result_bytes,
        ttl_secs,
        acknowledged,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn write_session_record_for(
    intent_type: &str,
    state_dir: &Path,
    provider_id: &str,
    remote_model_id: &str,
    workspace_id: &str,
    prompt: &str,
    max_turns: u32,
    max_tool_calls: u32,
    max_output_tokens: u64,
    max_tool_result_bytes: u64,
    ttl_secs: u64,
    acknowledged: bool,
) -> Result<LiveSessionAuthorization, String> {
    if !acknowledged {
        return Err(
            "--acknowledge-billable is required: every turn is a billable provider call".into(),
        );
    }
    if provider_id.is_empty()
        || remote_model_id.is_empty()
        || workspace_id.is_empty()
        || prompt.trim().is_empty()
    {
        return Err("provider, model, workspace and a non-empty prompt are required".into());
    }
    if intent_type != "repo-inspect" && intent_type != "repo-code" {
        return Err("a session record is only for repo-inspect or repo-code".into());
    }
    let (turn_cap, call_cap) = if intent_type == "repo-code" {
        (24, 80)
    } else {
        (12, 40)
    };
    if !(1..=turn_cap).contains(&max_turns) {
        return Err(format!("--max-turns must be 1..{turn_cap}"));
    }
    if !(1..=call_cap).contains(&max_tool_calls) {
        return Err(format!("--max-tool-calls must be 1..{call_cap}"));
    }
    if !(16..=8192).contains(&max_output_tokens) {
        return Err("--max-output-tokens must be 16..8192 per call".into());
    }
    if !(1024..=2 * 1024 * 1024).contains(&max_tool_result_bytes) {
        return Err("--max-tool-result-bytes must be 1024..2097152".into());
    }
    if ttl_secs == 0 || ttl_secs > MAX_TTL_SECS {
        return Err(format!("--expires-in-secs must be 1..{MAX_TTL_SECS}"));
    }
    let rec = LiveSessionAuthorization {
        intent_type: intent_type.to_owned(),
        provider_id: provider_id.to_owned(),
        remote_model_id: remote_model_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
        prompt_sha256: prompt_digest(prompt),
        max_turns,
        max_tool_calls,
        max_output_tokens,
        max_tool_result_bytes,
        billable_acknowledged: true,
        created_at_ms: now_ms(),
        expires_at_ms: now_ms() + ttl_secs * 1000,
    };
    let path = session_record_path(state_dir);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| {
            format!(
                "cannot create {}: {e} (an unconsumed record already exists?)",
                path.display()
            )
        })?;
    f.write_all(
        serde_json::to_string_pretty(&rec)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(rec)
}

/// What a repo-inspect run is about to do (computed by the broker).
pub struct SessionAttempt<'a> {
    pub intent_type: &'a str,
    pub provider_id: &'a str,
    pub remote_model_id: &'a str,
    pub workspace_id: &'a str,
    pub prompt: &'a str,
    pub max_turns: u32,
    pub max_tool_calls: u32,
    pub max_output_tokens: Option<u64>,
    pub max_tool_result_bytes: u64,
}

/// Verify and CONSUME the session record (rename = the single-use point).
pub fn consume_session(
    state_dir: &Path,
    a: &SessionAttempt<'_>,
) -> Result<LiveSessionAuthorization, (String, String)> {
    let refuse = |m: &str| Err(("live-not-authorized".to_owned(), m.to_owned()));
    let path = session_record_path(state_dir);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => {
            return refuse(
                "live agentic use is not authorized: no operator session authorization record",
            )
        }
    };
    if !meta.file_type().is_file()
        || meta.permissions().mode() & 0o077 != 0
        || meta.uid() != unsafe { libc::geteuid() }
    {
        return refuse(
            "live session authorization is not a private file owned by the issuer identity",
        );
    }
    let consumed = state_dir.join(format!(
        "live-session-authorization.consumed-{}.json",
        now_ms()
    ));
    if std::fs::rename(&path, &consumed).is_err() {
        return refuse("live session authorization was consumed by another run");
    }
    let rec: LiveSessionAuthorization = match std::fs::read_to_string(&consumed)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(r) => r,
        None => return refuse("live session authorization record is malformed"),
    };
    if !rec.billable_acknowledged {
        return refuse("live session authorization lacks the billable acknowledgement");
    }
    if now_ms() > rec.expires_at_ms {
        return refuse("live session authorization has expired");
    }
    if rec.intent_type != a.intent_type {
        return refuse("live session authorization was issued for a different kind of run");
    }
    if rec.provider_id != a.provider_id || rec.remote_model_id != a.remote_model_id {
        return refuse("live session authorization names a different provider or model");
    }
    if rec.workspace_id != a.workspace_id {
        return refuse("live session authorization names a different workspace");
    }
    if rec.prompt_sha256 != prompt_digest(a.prompt) {
        return refuse("live session authorization was issued for a different task text");
    }
    if a.max_turns == 0 || a.max_turns > rec.max_turns {
        return refuse("requested turn limit exceeds the authorized session budget");
    }
    if a.max_tool_calls > rec.max_tool_calls {
        return refuse("requested tool-call limit exceeds the authorized session budget");
    }
    if a.max_tool_result_bytes > rec.max_tool_result_bytes {
        return refuse("requested tool-result byte limit exceeds the authorized session budget");
    }
    match a.max_output_tokens {
        Some(n) if (1..=rec.max_output_tokens).contains(&n) => {}
        Some(_) => return refuse("requested output limit exceeds the authorized per-call budget"),
        None => return refuse("a live run must state limits.maxOutputTokens explicitly"),
    }
    Ok(rec)
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "opencode-go-native";
    const M: &str = "muse-spark-1.3-contributor";

    fn att<'a>(prompt: &'a str, max: Option<u64>) -> Attempt<'a> {
        Attempt {
            provider_id: P,
            remote_model_id: M,
            prompt,
            requested_max_output: max,
        }
    }
    fn auth(d: &Path, prompt: &str) {
        write_record(d, P, M, prompt, 64, 600, true).unwrap();
    }

    #[test]
    fn absent_record_refuses() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(
            consume(d.path(), &att("hi", Some(8))).unwrap_err().0,
            "live-not-authorized"
        );
    }

    #[test]
    fn record_requires_acknowledgement_and_bounds() {
        let d = tempfile::tempdir().unwrap();
        assert!(write_record(d.path(), P, M, "hi", 64, 600, false).is_err());
        assert!(write_record(d.path(), P, M, "hi", 0, 600, true).is_err());
        assert!(write_record(d.path(), P, M, "hi", 5000, 600, true).is_err());
        assert!(write_record(d.path(), P, M, "hi", 64, 0, true).is_err());
        assert!(write_record(d.path(), P, M, "hi", 64, MAX_TTL_SECS + 1, true).is_err());
        assert!(write_record(d.path(), P, M, "  ", 64, 600, true).is_err());
        assert!(!record_path(d.path()).exists());
    }

    #[test]
    fn exact_match_is_single_use_and_stores_no_prompt() {
        let d = tempfile::tempdir().unwrap();
        auth(d.path(), "say pong");
        let raw = std::fs::read_to_string(record_path(d.path())).unwrap();
        assert!(!raw.contains("say pong"));
        assert_eq!(
            std::fs::metadata(record_path(d.path()))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        consume(d.path(), &att("say pong", Some(64))).expect("authorized");
        assert_eq!(
            consume(d.path(), &att("say pong", Some(64))).unwrap_err().0,
            "live-not-authorized"
        );
    }

    #[test]
    fn mismatches_refuse_and_still_consume() {
        for (prompt, max, prov, model) in [
            ("other prompt", Some(8), P, M),
            ("say pong", Some(65), P, M),
            ("say pong", None, P, M),
            ("say pong", Some(0), P, M),
            ("say pong", Some(8), "opencode-go", M),
            ("say pong", Some(8), P, "other-model"),
        ] {
            let d = tempfile::tempdir().unwrap();
            auth(d.path(), "say pong");
            let a = Attempt {
                provider_id: prov,
                remote_model_id: model,
                prompt,
                requested_max_output: max,
            };
            assert!(
                consume(d.path(), &a).is_err(),
                "{prompt} {max:?} {prov} {model}"
            );
            // the record is gone: a retry needs a new authorization
            assert!(consume(d.path(), &att("say pong", Some(8))).is_err());
        }
    }

    #[test]
    fn expired_or_loose_records_refuse() {
        let d = tempfile::tempdir().unwrap();
        let mut rec = write_record(d.path(), P, M, "hi", 64, 600, true).unwrap();
        rec.expires_at_ms = 1;
        std::fs::write(record_path(d.path()), serde_json::to_string(&rec).unwrap()).unwrap();
        assert!(consume(d.path(), &att("hi", Some(8)))
            .unwrap_err()
            .1
            .contains("expired"));

        let d = tempfile::tempdir().unwrap();
        auth(d.path(), "hi");
        std::fs::set_permissions(
            record_path(d.path()),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(consume(d.path(), &att("hi", Some(8))).is_err());

        let d = tempfile::tempdir().unwrap();
        std::fs::write(record_path(d.path()), r#"{"providerId":"x","extra":1}"#).unwrap();
        std::fs::set_permissions(
            record_path(d.path()),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(consume(d.path(), &att("hi", Some(8)))
            .unwrap_err()
            .1
            .contains("malformed"));
    }

    fn sess(d: &Path, prompt: &str) {
        write_session_record(d, P, M, "demo", prompt, 5, 10, 512, 65536, 600, true).unwrap();
    }
    fn sa<'a>(prompt: &'a str) -> SessionAttempt<'a> {
        SessionAttempt {
            intent_type: "repo-inspect",
            provider_id: P,
            remote_model_id: M,
            workspace_id: "demo",
            prompt,
            max_turns: 5,
            max_tool_calls: 10,
            max_output_tokens: Some(512),
            max_tool_result_bytes: 65536,
        }
    }

    #[test]
    fn session_budget_is_single_use_exact_and_never_satisfied_by_an_a54_record() {
        let d = tempfile::tempdir().unwrap();
        // an A5.4 single-call record does not satisfy a session
        auth(d.path(), "task");
        assert_eq!(
            consume_session(d.path(), &sa("task")).unwrap_err().0,
            "live-not-authorized"
        );
        assert!(
            record_path(d.path()).exists(),
            "the A5.4 record is untouched"
        );
        let d = tempfile::tempdir().unwrap();
        sess(d.path(), "task");
        assert!(!std::fs::read_to_string(session_record_path(d.path()))
            .unwrap()
            .contains("task"));
        consume_session(d.path(), &sa("task")).expect("exact match");
        assert!(
            consume_session(d.path(), &sa("task")).is_err(),
            "single use"
        );
        // and a session record is not an A5.4 record
        let d = tempfile::tempdir().unwrap();
        sess(d.path(), "task");
        assert!(consume(d.path(), &att("task", Some(8))).is_err());
        assert!(session_record_path(d.path()).exists());
    }

    #[test]
    fn session_mismatches_and_over_budget_requests_refuse_and_consume() {
        type Mut = Box<dyn Fn(&mut SessionAttempt<'static>)>;
        let cases: Vec<(&str, Mut)> = vec![
            ("turns", Box::new(|a| a.max_turns = 6)),
            ("zero turns", Box::new(|a| a.max_turns = 0)),
            ("tools", Box::new(|a| a.max_tool_calls = 11)),
            ("bytes", Box::new(|a| a.max_tool_result_bytes = 65537)),
            ("tokens", Box::new(|a| a.max_output_tokens = Some(513))),
            ("no tokens", Box::new(|a| a.max_output_tokens = None)),
            ("workspace", Box::new(|a| a.workspace_id = "other")),
            ("provider", Box::new(|a| a.provider_id = "opencode-go")),
            ("model", Box::new(|a| a.remote_model_id = "x")),
            ("prompt", Box::new(|a| a.prompt = "different task")),
        ];
        for (name, m) in cases {
            let d = tempfile::tempdir().unwrap();
            sess(d.path(), "task");
            let mut a = sa("task");
            m(&mut a);
            assert!(consume_session(d.path(), &a).is_err(), "{name}");
            assert!(
                consume_session(d.path(), &sa("task")).is_err(),
                "{name}: consumed"
            );
        }
    }

    #[test]
    fn a_repo_inspect_session_record_never_authorizes_repo_code_and_vice_versa() {
        let d = tempfile::tempdir().unwrap();
        write_session_record(d.path(), P, M, "demo", "task", 5, 10, 512, 65536, 600, true).unwrap();
        let mut a = sa("task");
        a.intent_type = "repo-code";
        assert!(consume_session(d.path(), &a)
            .unwrap_err()
            .1
            .contains("different kind"));
        // and a code record needs the code type
        write_session_record_for(
            "repo-code",
            d.path(),
            P,
            M,
            "demo",
            "task",
            12,
            30,
            1024,
            262144,
            600,
            true,
        )
        .unwrap();
        let mut ok = sa("task");
        ok.max_turns = 12;
        ok.max_tool_calls = 30;
        ok.max_output_tokens = Some(1024);
        ok.max_tool_result_bytes = 262144;
        assert!(
            consume_session(d.path(), &ok).is_err(),
            "inspect type presented to a code record"
        );
        write_session_record_for(
            "repo-code",
            d.path(),
            P,
            M,
            "demo",
            "task",
            12,
            30,
            1024,
            262144,
            600,
            true,
        )
        .unwrap();
        ok.intent_type = "repo-code";
        assert!(consume_session(d.path(), &ok).is_ok());
        assert!(write_session_record_for(
            "model-only",
            d.path(),
            P,
            M,
            "demo",
            "t",
            1,
            1,
            64,
            2048,
            60,
            true
        )
        .is_err());
        // the A5.5 on-disk shape (no intentType) is read as repo-inspect
        let legacy = r#"{"providerId":"opencode-go-native","remoteModelId":"m","workspaceId":"w","promptSha256":"x","maxTurns":1,"maxToolCalls":1,"maxOutputTokens":64,"maxToolResultBytes":2048,"billableAcknowledged":true,"createdAtMs":1,"expiresAtMs":2}"#;
        assert_eq!(
            serde_json::from_str::<LiveSessionAuthorization>(legacy)
                .unwrap()
                .intent_type,
            "repo-inspect"
        );
    }

    #[test]
    fn session_record_bounds_and_expiry() {
        let d = tempfile::tempdir().unwrap();
        for bad in [
            (0u32, 10u32, 512u64, 65536u64),
            (13, 10, 512, 65536),
            (5, 0, 512, 65536),
            (5, 41, 512, 65536),
            (5, 10, 8, 65536),
            (5, 10, 9000, 65536),
            (5, 10, 512, 10),
        ] {
            assert!(
                write_session_record(
                    d.path(),
                    P,
                    M,
                    "demo",
                    "t",
                    bad.0,
                    bad.1,
                    bad.2,
                    bad.3,
                    600,
                    true
                )
                .is_err(),
                "{bad:?}"
            );
        }
        assert!(
            write_session_record(d.path(), P, M, "demo", "t", 5, 10, 512, 65536, 600, false)
                .is_err()
        );
        let mut rec =
            write_session_record(d.path(), P, M, "demo", "t", 5, 10, 512, 65536, 600, true)
                .unwrap();
        rec.expires_at_ms = 1;
        std::fs::write(
            session_record_path(d.path()),
            serde_json::to_string(&rec).unwrap(),
        )
        .unwrap();
        assert!(consume_session(d.path(), &sa("t"))
            .unwrap_err()
            .1
            .contains("expired"));
    }

    #[test]
    fn existing_record_is_never_overwritten() {
        let d = tempfile::tempdir().unwrap();
        auth(d.path(), "one");
        assert!(write_record(d.path(), P, M, "two", 64, 600, true).is_err());
    }
}
