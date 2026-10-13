//! Issuer authorization for daemon mutations (A1.3.3).
//!
//! Security model (explicit, tested, documented as limited):
//!
//! - The daemon NEVER treats issuer strings, caller-supplied hashes, or
//!   well-formed resolutions as authorization. `seal`/`accept` additionally
//!   require a per-request authentication tag.
//! - In the default `readonly` trust mode, privileged commands
//!   (`acquire`, `seal`, `accept`) are unconditionally refused with
//!   `privileged-disabled`: no credential can enable them.
//! - In the explicit `shadow-test` trust mode, the daemon generates one
//!   random 256-bit capability key at startup, stores it 0600 at the
//!   configured cap path, and requires every privileged request to carry
//!   `auth: { nonce, ts, tag }` where
//!   `tag = HMAC-SHA256(capkey, canonical({protocol,id,cmd,params,nonce,ts}))`
//!   with canonical bytes shared with the JS transport, a fresh 128-bit
//!   nonce per request, and `ts` (unix millis) inside a +/-5 minute window.
//!   Reused nonces are rejected (`replay-rejected`). Comparison is
//!   constant-time.
//! - HONEST LIMITATION (same-UID hostile peer): the capability file is
//!   readable by any process running as the daemon's UID, and `SO_PEERCRED`
//!   cannot distinguish which JS module produced a request. A hostile
//!   same-UID process that reads the cap file CAN impersonate the trusted
//!   issuer over this socket. Socket permissions do not fix this. The
//!   supported deployment boundary is therefore: single-tenant development
//!   / test machines with no hostile same-UID peer. Production use needs
//!   separate service identities (distinct UIDs + a protected store or an
//!   external trust anchor) and is explicitly NOT claimed here. A dedicated
//!   test proves the impersonation and pins this documentation.
//! - This is deliberately NOT a static shared string: the key is random
//!   per daemon incarnation, rotated on every restart, never logged, never
//!   returned in responses, and bound to each request's full bytes plus a
//!   single-use nonce.
//!
//! Replay-cache policy (H-06): every admitted nonce is remembered WITH its
//! request timestamp. Entries are removed ONLY after their validity window
//! has expired (request ts older than now minus the acceptance window).
//! When the bounded cache is full of still-valid entries, the daemon fails
//! closed with `replay-cache-exhausted` rather than evicting a live nonce
//! and silently re-admitting its replay. Availability is never bought by
//! weakening replay protection.
//!
//! Restart behavior: the cache lives in process memory only, and every
//! daemon start generates a fresh capability key (the cap file is
//! overwritten). Pre-restart tags fail HMAC verification post-restart, so
//! there is no cross-restart replay window to protect: a restarted daemon
//! starts with an empty cache and a new key, which is safe precisely
//! because the key rotated.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

/// Timestamp acceptance window (unix millis, +/- skew + transit).
pub const AUTH_WINDOW_MS: i64 = 5 * 60 * 1000;
/// Bounded replay cache: at most this many still-valid nonces are
/// remembered. Exhaustion fails closed; see the module policy above.
pub const MAX_SEEN_NONCES: usize = 10_000;

pub struct IssuerAuth {
    key: [u8; 32],
    seen: Mutex<NonceCache>,
}

/// Admitted nonces mapped to their request timestamps. Timestamps make
/// expiry exact: a nonce is forgotten only after it can no longer verify.
struct NonceCache {
    by_nonce: HashMap<String, i64>,
}

impl IssuerAuth {
    pub fn generate() -> Result<Self, String> {
        let mut key = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut key))
            .map_err(|e| format!("entropy unavailable: {e}"))?;
        Ok(Self {
            key,
            seen: Mutex::new(NonceCache {
                by_nonce: HashMap::new(),
            }),
        })
    }

    pub fn key_hex(&self) -> String {
        hex::encode(self.key)
    }

    /// Canonical bytes the tag covers. MUST match the JS transport
    /// (`native-shadow-daemon.cjs` `authBytesOf`) field-for-field; the
    /// cross-language agreement is pinned by integration test.
    pub fn auth_bytes(
        cmd: &str,
        id: &str,
        params: &serde_json::Map<String, serde_json::Value>,
        nonce: &str,
        ts: i64,
    ) -> String {
        let mut envelope = serde_json::Map::new();
        envelope.insert("cmd".to_owned(), serde_json::Value::String(cmd.to_owned()));
        envelope.insert("id".to_owned(), serde_json::Value::String(id.to_owned()));
        envelope.insert(
            "nonce".to_owned(),
            serde_json::Value::String(nonce.to_owned()),
        );
        envelope.insert(
            "params".to_owned(),
            serde_json::Value::Object(params.clone()),
        );
        envelope.insert(
            "protocol".to_owned(),
            serde_json::Value::from(crate::protocol::IPC_PROTOCOL_VERSION),
        );
        envelope.insert("ts".to_owned(), serde_json::Value::from(ts));
        nexus_contracts::canonical_json(&serde_json::Value::Object(envelope))
    }

    pub fn tag_for(
        &self,
        cmd: &str,
        id: &str,
        params: &serde_json::Map<String, serde_json::Value>,
        nonce: &str,
        ts: i64,
    ) -> String {
        use hmac::Mac;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(&self.key)
            .expect("HMAC accepts 32-byte keys");
        mac.update(Self::auth_bytes(cmd, id, params, nonce, ts).as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// Verify one privileged request's auth fields. Ok(()) admits the
    /// request; Err(code) names the refusal (`issuer-untrusted`,
    /// `replay-rejected`, or `replay-cache-exhausted`). Nonce reservation
    /// happens here so concurrent duplicates cannot both pass.
    pub fn verify(
        &self,
        cmd: &str,
        id: &str,
        params: &serde_json::Map<String, serde_json::Value>,
        auth: &crate::protocol::AuthFields,
        now_ms: i64,
    ) -> Result<(), &'static str> {
        if auth.nonce.len() > 128 || !is_hex(&auth.nonce) {
            return Err(crate::protocol::codes::ISSUER_UNTRUSTED);
        }
        if auth.tag.len() > 256 || !is_hex(&auth.tag) {
            return Err(crate::protocol::codes::ISSUER_UNTRUSTED);
        }
        if (now_ms - auth.ts).abs() > AUTH_WINDOW_MS {
            return Err(crate::protocol::codes::ISSUER_UNTRUSTED);
        }
        let expected = self.tag_for(cmd, id, params, &auth.nonce, auth.ts);
        if !constant_time_eq(&expected, &auth.tag) {
            return Err(crate::protocol::codes::ISSUER_UNTRUSTED);
        }
        let mut seen = self
            .seen
            .lock()
            .map_err(|_| crate::protocol::codes::ISSUER_UNTRUSTED)?;
        // Any repeat of a remembered nonce is a replay, whatever its age:
        // requests older than the window already failed the ts check above,
        // so a remembered match is always a live replay.
        if seen.by_nonce.contains_key(&auth.nonce) {
            return Err(crate::protocol::codes::REPLAY_REJECTED);
        }
        // Expire first: forget only nonces that can no longer verify, so
        // memory stays bounded without ever dropping live protection.
        seen.by_nonce.retain(|_, ts| now_ms - *ts <= AUTH_WINDOW_MS);
        // Still full of live nonces: fail closed. Evicting one would let
        // its replay verify as fresh inside the validity window.
        if seen.by_nonce.len() >= MAX_SEEN_NONCES {
            return Err(crate::protocol::codes::REPLAY_CACHE_EXHAUSTED);
        }
        seen.by_nonce.insert(auth.nonce.clone(), auth.ts);
        Ok(())
    }
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.len().is_multiple_of(2) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0 && !a.is_empty()
}

/// Write the capability key to `path` with owner-only (0600) permissions.
/// The parent directory is created if missing. Overwrites any previous key:
/// rotation happens on every daemon start.
pub fn write_cap_file(path: &Path, key_hex: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cap dir unavailable: {e}"))?;
        }
    }
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("cap file unwritable: {e}"))?;
    use std::io::Write;
    file.write_all(key_hex.as_bytes())
        .map_err(|e| format!("cap file unwritable: {e}"))?;
    // Harden against pre-existing permissive modes on rotation.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("cap file permissions unsettable: {e}"))?;
    Ok(())
}

pub fn read_cap_file(path: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cap file unreadable: {e}"))?;
    let trimmed = text.trim().to_owned();
    if trimmed.len() != 64 || !is_hex(&trimmed) {
        return Err("cap file is malformed".to_owned());
    }
    Ok(trimmed)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_verify() {
        let auth = IssuerAuth::generate().unwrap();
        let params = serde_json::Map::new();
        let nonce = "ab".repeat(16);
        let ts = now_ms();
        let tag = auth.tag_for("acquire", "id1", &params, &nonce, ts);
        let fields = crate::protocol::AuthFields {
            nonce: nonce.clone(),
            ts,
            tag,
        };
        assert!(auth.verify("acquire", "id1", &params, &fields, ts).is_ok());
        // Same nonce replays are rejected.
        assert_eq!(
            auth.verify("acquire", "id1", &params, &fields, ts)
                .unwrap_err(),
            crate::protocol::codes::REPLAY_REJECTED
        );
    }

    #[test]
    fn stale_timestamp_refused() {
        let auth = IssuerAuth::generate().unwrap();
        let params = serde_json::Map::new();
        let nonce = "cd".repeat(16);
        let ts = now_ms() - AUTH_WINDOW_MS - 1000;
        let tag = auth.tag_for("seal", "id2", &params, &nonce, ts);
        let fields = crate::protocol::AuthFields { nonce, ts, tag };
        assert_eq!(
            auth.verify("seal", "id2", &params, &fields, now_ms())
                .unwrap_err(),
            crate::protocol::codes::ISSUER_UNTRUSTED
        );
    }

    /// H-06: a still-valid nonce is never forgotten while it can verify.
    /// Failing-first: the pre-fix FIFO cache drops the oldest nonce after
    /// 10,000 admissions, so replaying it verifies as a fresh request.
    /// Specified fix (fail closed at capacity): the cache fills with live
    /// nonces, further fresh requests are refused with
    /// `replay-cache-exhausted`, and the oldest live replay stays rejected.
    #[test]
    fn replay_after_cache_eviction_is_still_rejected() {
        let auth = IssuerAuth::generate().unwrap();
        let params = serde_json::Map::new();
        let ts = now_ms();
        let first_nonce = "aa".repeat(16);
        let first_tag = auth.tag_for("acquire", "id-first", &params, &first_nonce, ts);
        let first = crate::protocol::AuthFields {
            nonce: first_nonce.clone(),
            ts,
            tag: first_tag,
        };
        assert!(auth
            .verify("acquire", "id-first", &params, &first, ts)
            .is_ok());
        // Fill the cache exactly to capacity with distinct valid nonces.
        for i in 1..(super::MAX_SEEN_NONCES as u64) {
            let nonce = format!("{:032x}{:032x}", i, ts as u64);
            let id = format!("fill-{i}");
            let tag = auth.tag_for("acquire", &id, &params, &nonce, ts);
            let fields = crate::protocol::AuthFields { nonce, ts, tag };
            assert!(auth.verify("acquire", &id, &params, &fields, ts).is_ok());
        }
        // One more fresh, otherwise-valid request: refused (fail closed)
        // rather than evicting a live nonce to make room.
        let extra_nonce = "bb".repeat(16);
        let extra_tag = auth.tag_for("acquire", "id-extra", &params, &extra_nonce, ts);
        let extra = crate::protocol::AuthFields {
            nonce: extra_nonce,
            ts,
            tag: extra_tag,
        };
        assert_eq!(
            auth.verify("acquire", "id-extra", &params, &extra, ts)
                .unwrap_err(),
            crate::protocol::codes::REPLAY_CACHE_EXHAUSTED
        );
        // The oldest nonce is still inside its validity window, so its
        // replay must be rejected — never silently re-admitted.
        assert_eq!(
            auth.verify("acquire", "id-first", &params, &first, now_ms())
                .unwrap_err(),
            crate::protocol::codes::REPLAY_REJECTED
        );
    }

    #[test]
    fn wrong_key_refused() {
        let a = IssuerAuth::generate().unwrap();
        let b = IssuerAuth::generate().unwrap();
        let params = serde_json::Map::new();
        let nonce = "ef".repeat(16);
        let ts = now_ms();
        let tag = a.tag_for("accept", "id3", &params, &nonce, ts);
        let fields = crate::protocol::AuthFields { nonce, ts, tag };
        assert_eq!(
            b.verify("accept", "id3", &params, &fields, ts).unwrap_err(),
            crate::protocol::codes::ISSUER_UNTRUSTED
        );
    }
}
