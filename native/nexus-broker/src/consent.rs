//! A6.1.4 interactive profile: one-time provider consent and internally issued,
//! run-scoped authorization.
//!
//! Strict mode keeps the operator's manual single-use record (`live_auth`). The
//! interactive profile replaces the per-run ceremony with:
//!
//! 1. a durable **consent** the user gives once (the Desktop backend shows the
//!    exact text in a native dialog; the broker only accepts a consent whose
//!    `textSha256` equals the digest of the text IT serves), naming provider, model
//!    and run kinds, revocable at any time; and
//! 2. for every run, an **authorization decision** made by the broker itself, bound
//!    to that run's provider/model/workspace/prompt digest and limits, appended to
//!    an audit log. It is not a file a model or a client can write, it never
//!    outlives its run, and it can only be as large as the interactive ceilings.
//!
//! Nothing here is reachable by a model: it has no broker verb; the broker verbs
//! are gated by OS peer credentials like every other verb.

use crate::live_auth::{prompt_digest, LiveSessionAuthorization, SessionAttempt};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const CONSENT_FILE: &str = "provider-consent.json";
pub const AUDIT_FILE: &str = "live-auth-audit.jsonl";

/// Interactive ceilings (per run). The user never sets these per task.
pub const MAX_TURNS: u32 = 2000;
pub const MAX_TOOL_CALLS: u32 = 10_000;
pub const MAX_OUTPUT_TOKENS: u64 = 131_072;
pub const MAX_TOOL_RESULT_BYTES: u64 = 512 * 1024 * 1024;
/// A consent older than this must be given again.
pub const CONSENT_TTL_MS: u64 = 90 * 24 * 3600 * 1000;

/// The exact text the user consents to. Served by the broker so the dialog and
/// the stored digest can never diverge.
pub fn consent_text(provider_id: &str, remote_model_id: &str) -> String {
    format!(
        "Allow Nexus to work autonomously on your projects using {provider_id} ({remote_model_id}).\n\n\
         • Your task text, project files the model reads, and the output of build/test commands are sent to this provider. Provider use is billable.\n\
         • The model may edit files and run build/test commands only inside an isolated copy of your project, without asking you for each operation. Every such grant is recorded as an automated workspace-policy grant, not as your approval.\n\
         • Your original project is never modified, committed, pushed or deployed by Nexus; you review the resulting patch and decide.\n\
         • You can revoke this in Settings at any time."
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConsent {
    pub consent_id: String,
    pub provider_id: String,
    pub remote_model_id: String,
    pub intent_types: Vec<String>,
    pub text_sha256: String,
    pub granted_by_client: String,
    pub granted_at_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn private_file_ok(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| {
            m.file_type().is_file()
                && m.permissions().mode() & 0o077 == 0
                && m.uid() == unsafe { libc::geteuid() }
        })
        .unwrap_or(false)
}

pub fn consent_path(state_dir: &Path) -> PathBuf {
    state_dir.join(CONSENT_FILE)
}

/// The current consent, if one exists, is private/owned and has not expired.
pub fn status(state_dir: &Path) -> Option<ProviderConsent> {
    let p = consent_path(state_dir);
    if !private_file_ok(&p) {
        return None;
    }
    let c: ProviderConsent = serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()?;
    (now_ms() <= c.granted_at_ms.saturating_add(CONSENT_TTL_MS)).then_some(c)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    if let Some(d) = path.parent() {
        let _ = std::fs::File::open(d).and_then(|f| f.sync_all());
    }
    Ok(())
}

pub fn audit(state_dir: &Path, line: serde_json::Value) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(state_dir.join(AUDIT_FILE))
    {
        let _ = writeln!(f, "{line}");
        let _ = f.sync_all();
    }
}

/// Record a consent. The caller must present the digest of the text the broker
/// serves for this provider/model; anything else is refused.
pub fn grant(
    state_dir: &Path,
    provider_id: &str,
    remote_model_id: &str,
    intent_types: &[String],
    presented_text_sha256: &str,
    client: &str,
) -> Result<ProviderConsent, String> {
    if provider_id.is_empty() || remote_model_id.is_empty() {
        return Err("provider and model are required".into());
    }
    if intent_types.is_empty()
        || intent_types
            .iter()
            .any(|t| t != "repo-code" && t != "repo-inspect")
    {
        return Err("consent covers repo-code and/or repo-inspect only".into());
    }
    let want = prompt_digest(&consent_text(provider_id, remote_model_id));
    if presented_text_sha256 != want {
        return Err("the consent text presented does not match the text the broker serves".into());
    }
    let mut id_bytes = [0u8; 8];
    let _ = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut id_bytes));
    let c = ProviderConsent {
        consent_id: format!("consent-{}", hex::encode(id_bytes)),
        provider_id: provider_id.to_owned(),
        remote_model_id: remote_model_id.to_owned(),
        intent_types: intent_types.to_vec(),
        text_sha256: want,
        granted_by_client: client.to_owned(),
        granted_at_ms: now_ms(),
    };
    atomic_write(
        &consent_path(state_dir),
        serde_json::to_string_pretty(&c)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| format!("cannot store the consent: {e}"))?;
    audit(
        state_dir,
        serde_json::json!({"atMs": now_ms(), "kind": "consent-granted", "consentId": c.consent_id,
            "provider": provider_id, "model": remote_model_id, "intentTypes": intent_types,
            "textSha256": c.text_sha256, "client": client}),
    );
    Ok(c)
}

pub fn revoke(state_dir: &Path, client: &str) -> bool {
    let had = status(state_dir);
    let removed = std::fs::remove_file(consent_path(state_dir)).is_ok();
    audit(
        state_dir,
        serde_json::json!({"atMs": now_ms(), "kind": "consent-revoked",
            "consentId": had.map(|c| c.consent_id), "client": client}),
    );
    removed
}

/// The per-run authorization decision. Equivalent in effect to consuming a
/// manual session record (provider, model, workspace, prompt digest, bounds)
/// but issued by the broker from the standing consent; one audit line per run.
pub fn authorize_run(
    state_dir: &Path,
    a: &SessionAttempt<'_>,
    run_id: &str,
) -> Result<LiveSessionAuthorization, (String, String)> {
    let refuse = |m: &str| Err(("live-not-authorized".to_owned(), m.to_owned()));
    let Some(c) = status(state_dir) else {
        return refuse(
            "provider consent has not been given (or was revoked/expired); give it once in Nexus settings",
        );
    };
    if c.provider_id != a.provider_id || c.remote_model_id != a.remote_model_id {
        return refuse("the consent names a different provider or model");
    }
    if !c.intent_types.iter().any(|t| t == a.intent_type) {
        return refuse("the consent does not cover this kind of run");
    }
    if a.prompt.trim().is_empty() || a.workspace_id.is_empty() {
        return refuse("a run needs a task text and a project");
    }
    if a.max_turns == 0 || a.max_turns > MAX_TURNS {
        return refuse("requested turn limit exceeds the interactive ceiling");
    }
    if a.max_tool_calls > MAX_TOOL_CALLS {
        return refuse("requested tool-call limit exceeds the interactive ceiling");
    }
    if a.max_tool_result_bytes > MAX_TOOL_RESULT_BYTES {
        return refuse("requested tool-result byte limit exceeds the interactive ceiling");
    }
    match a.max_output_tokens {
        Some(n) if (1..=MAX_OUTPUT_TOKENS).contains(&n) => {}
        Some(_) => return refuse("requested output limit exceeds the interactive ceiling"),
        None => return refuse("a live run must state its output-token limit"),
    }
    let rec = LiveSessionAuthorization {
        intent_type: a.intent_type.to_owned(),
        provider_id: a.provider_id.to_owned(),
        remote_model_id: a.remote_model_id.to_owned(),
        workspace_id: a.workspace_id.to_owned(),
        prompt_sha256: prompt_digest(a.prompt),
        max_turns: a.max_turns,
        max_tool_calls: a.max_tool_calls,
        max_output_tokens: a.max_output_tokens.unwrap_or(0),
        max_tool_result_bytes: a.max_tool_result_bytes,
        billable_acknowledged: true,
        created_at_ms: now_ms(),
        expires_at_ms: now_ms() + 3600 * 1000,
    };
    audit(
        state_dir,
        serde_json::json!({"atMs": now_ms(), "kind": "run-authorized", "runId": run_id,
            "consentId": c.consent_id, "intentType": a.intent_type, "provider": a.provider_id,
            "model": a.remote_model_id, "workspace": a.workspace_id,
            "promptSha256": rec.prompt_sha256, "maxTurns": a.max_turns,
            "maxToolCalls": a.max_tool_calls, "maxOutputTokens": rec.max_output_tokens}),
    );
    Ok(rec)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att<'a>(prompt: &'a str) -> SessionAttempt<'a> {
        SessionAttempt {
            intent_type: "repo-code",
            provider_id: "opencode-go-native",
            remote_model_id: "muse-spark-1.3-contributor",
            workspace_id: "proj",
            prompt,
            max_turns: 60,
            max_tool_calls: 200,
            max_output_tokens: Some(16_384),
            max_tool_result_bytes: 512 * 1024,
        }
    }

    fn give(d: &Path) -> ProviderConsent {
        let t = consent_text("opencode-go-native", "muse-spark-1.3-contributor");
        grant(
            d,
            "opencode-go-native",
            "muse-spark-1.3-contributor",
            &["repo-code".into()],
            &prompt_digest(&t),
            "uid:1000",
        )
        .unwrap()
    }

    #[test]
    fn no_consent_no_authorization_and_the_text_digest_must_match() {
        let d = tempfile::tempdir().unwrap();
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            authorize_run(d.path(), &att("x"), "run_1").unwrap_err().0,
            "live-not-authorized"
        );
        // consenting to different text (or no text) is refused
        for bad in ["", "abc", &"0".repeat(64)] {
            assert!(grant(
                d.path(),
                "opencode-go-native",
                "muse-spark-1.3-contributor",
                &["repo-code".into()],
                bad,
                "uid:1"
            )
            .is_err());
        }
        assert!(grant(
            d.path(),
            "opencode-go-native",
            "m",
            &["shell".into()],
            "x",
            "uid:1"
        )
        .is_err());
        assert!(status(d.path()).is_none());
    }

    #[test]
    fn a_consent_authorizes_runs_within_its_scope_and_ceilings_and_every_run_is_audited() {
        let d = tempfile::tempdir().unwrap();
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let c = give(d.path());
        assert_eq!(
            std::fs::metadata(consent_path(d.path()))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        // many runs: it is standing consent, but each run is its own decision
        for i in 0..3 {
            let r = authorize_run(d.path(), &att("fix it"), &format!("run_{i}")).unwrap();
            assert_eq!(r.prompt_sha256, prompt_digest("fix it"));
            assert_eq!(r.max_output_tokens, 16_384);
        }
        // outside the consent: other provider/model, other run kind
        let mut a = att("x");
        a.provider_id = "other";
        assert!(authorize_run(d.path(), &a, "r").is_err());
        let mut a = att("x");
        a.remote_model_id = "other";
        assert!(authorize_run(d.path(), &a, "r").is_err());
        let mut a = att("x");
        a.intent_type = "repo-inspect";
        assert!(authorize_run(d.path(), &a, "r").is_err());
        // above the interactive ceilings, empty task, unstated output limit
        for mutate in [
            (|a: &mut SessionAttempt| a.max_turns = MAX_TURNS + 1) as fn(&mut SessionAttempt),
            |a| a.max_tool_calls = MAX_TOOL_CALLS + 1,
            |a| a.max_output_tokens = Some(MAX_OUTPUT_TOKENS + 1),
            |a| a.max_output_tokens = None,
            |a| a.max_tool_result_bytes = MAX_TOOL_RESULT_BYTES + 1,
            |a| a.max_turns = 0,
        ] {
            let mut a = att("x");
            mutate(&mut a);
            assert!(authorize_run(d.path(), &a, "r").is_err());
        }
        assert!(authorize_run(d.path(), &att("   "), "r").is_err());
        // audit: one line per granted run + the consent, none of them contain the prompt
        let log = std::fs::read_to_string(d.path().join(AUDIT_FILE)).unwrap();
        assert_eq!(
            log.lines().filter(|l| l.contains("run-authorized")).count(),
            3
        );
        assert!(log.contains("consent-granted") && log.contains(&c.consent_id));
        assert!(!log.contains("fix it"));
    }

    #[test]
    fn revocation_expiry_and_untrusted_files_withdraw_the_consent() {
        let d = tempfile::tempdir().unwrap();
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        give(d.path());
        assert!(authorize_run(d.path(), &att("x"), "r").is_ok());
        assert!(revoke(d.path(), "uid:1000"));
        assert!(authorize_run(d.path(), &att("x"), "r").is_err());
        assert!(std::fs::read_to_string(d.path().join(AUDIT_FILE))
            .unwrap()
            .contains("consent-revoked"));
        // a group/world-readable or symlinked consent file is not trusted
        give(d.path());
        std::fs::set_permissions(
            consent_path(d.path()),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(status(d.path()).is_none());
        std::fs::remove_file(consent_path(d.path())).unwrap();
        let other = d.path().join("other.json");
        std::fs::write(&other, "{}").unwrap();
        std::os::unix::fs::symlink(&other, consent_path(d.path())).unwrap();
        assert!(status(d.path()).is_none());
        // an expired consent no longer authorizes
        std::fs::remove_file(consent_path(d.path())).unwrap();
        let mut c = give(d.path());
        c.granted_at_ms = now_ms() - CONSENT_TTL_MS - 1000;
        atomic_write(
            &consent_path(d.path()),
            serde_json::to_string(&c).unwrap().as_bytes(),
        )
        .unwrap();
        assert!(authorize_run(d.path(), &att("x"), "r").is_err());
    }
}
