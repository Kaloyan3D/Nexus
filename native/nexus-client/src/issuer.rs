//! Issuer-authenticated daemon calls (A5.3).
//!
//! The ONLY holder of these helpers' inputs is an issuer-identity process:
//! the broker/executor. They are not reachable from the renderer, and the
//! Tauri backend does not link a code path that reads a capability file.

use crate::error::ClientError;
use hmac::Mac;
use sha2::Sha256;
use std::path::Path;

/// Build a frame signed with the issuer capability (same canonical bytes as
/// the daemon's verifier).
pub fn signed_frame(
    cap_hex: &str,
    cmd: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    let key = hex::decode(cap_hex.trim())
        .map_err(|_| ClientError::unauthorized("issuer capability file is not hex"))?;
    let nonce = crate::model_run::urandom_hex(16)?;
    let id = format!("issuer-{}", &nonce[..12]);
    let ts = crate::model_run::now_ms() as i64;
    let mut envelope = serde_json::Map::new();
    envelope.insert("protocol".to_owned(), serde_json::Value::from(1u64));
    envelope.insert("id".to_owned(), serde_json::Value::String(id.clone()));
    envelope.insert("cmd".to_owned(), serde_json::Value::String(cmd.to_owned()));
    envelope.insert("params".to_owned(), params.clone());
    envelope.insert("nonce".to_owned(), serde_json::Value::String(nonce.clone()));
    envelope.insert("ts".to_owned(), serde_json::Value::from(ts));
    let canonical = nexus_contracts::canonical_json(&serde_json::Value::Object(envelope));
    let mut mac = hmac::Hmac::<Sha256>::new_from_slice(&key)
        .map_err(|_| ClientError::unauthorized("issuer capability has an invalid length"))?;
    mac.update(canonical.as_bytes());
    let tag = hex::encode(mac.finalize().into_bytes());
    Ok(serde_json::json!({
        "protocol": 1, "id": id, "cmd": cmd, "params": params,
        "auth": { "nonce": nonce, "ts": ts, "tag": tag },
    }))
}

/// Read the capability file (hex). The value never leaves this process.
pub fn read_capability(path: &Path) -> Result<String, ClientError> {
    std::fs::read_to_string(path)
        .map_err(|_| ClientError::unauthorized("issuer capability file is unreadable"))
}

/// One issuer-authenticated round trip. Returns the daemon response whether
/// `ok` or not; the caller inspects `ok`/`code`.
pub fn issuer_call(
    socket: &Path,
    cap_hex: &str,
    cmd: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    let frame = signed_frame(cap_hex, cmd, params)?;
    crate::transport::ipc_roundtrip(socket, &frame, 15_000)
}

/// Like [`issuer_call`] with an explicit read timeout, for the long-running
/// verbs (a sandboxed process may legitimately run for minutes). The caller
/// must pass a timeout larger than the operation's own wall limit so that a
/// timeout here always means "daemon unreachable", never "still running".
pub fn issuer_call_with_timeout(
    socket: &Path,
    cap_hex: &str,
    cmd: &str,
    params: serde_json::Value,
    timeout_ms: u64,
) -> Result<serde_json::Value, ClientError> {
    let frame = signed_frame(cap_hex, cmd, params)?;
    crate::transport::ipc_roundtrip(socket, &frame, timeout_ms)
}
