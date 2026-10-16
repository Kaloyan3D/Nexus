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

    #[test]
    fn existing_record_is_never_overwritten() {
        let d = tempfile::tempdir().unwrap();
        auth(d.path(), "one");
        assert!(write_record(d.path(), P, M, "two", 64, 600, true).is_err());
    }
}
