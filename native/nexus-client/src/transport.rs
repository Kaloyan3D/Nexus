//! Authenticated service-boundary transport (A2.4 Phase 2).
//!
//! The client speaks the versioned daemon IPC (one JSON object per line over
//! a Unix socket) and never touches SQLite. Privileged mutations require the
//! daemon-side issuer capability, which this crate never mints, stores, or
//! logs: operator-provided capability files stay in caller memory and are
//! redacted from every error. Normal CLI users get the read-only surface;
//! anything else fails closed with `unauthorized`, never with a raw
//! capability handoff.

use crate::error::ClientError;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

/// One IPC round trip over the daemon socket.
pub fn ipc_roundtrip(
    socket_path: &std::path::Path,
    request: &serde_json::Value,
    timeout_ms: u64,
) -> Result<serde_json::Value, ClientError> {
    let stream = UnixStream::connect(socket_path).map_err(|e| {
        ClientError::disconnected(format!(
            "daemon socket unreachable at {}: {}",
            socket_path.display(),
            e
        ))
    })?;
    stream
        .set_read_timeout(Some(Duration::from_millis(timeout_ms)))
        .map_err(|e| ClientError::internal(format!("socket timeout unsettable: {e}")))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(timeout_ms)))
        .map_err(|e| ClientError::internal(format!("socket timeout unsettable: {e}")))?;
    let mut line = serde_json::to_string(request)
        .map_err(|e| ClientError::internal(format!("request unserializable: {e}")))?;
    line.push('\n');
    let mut w = stream
        .try_clone()
        .map_err(|e| ClientError::internal(format!("socket clone failed: {e}")))?;
    w.write_all(line.as_bytes())
        .map_err(|e| ClientError::disconnected(format!("daemon write failed: {e}")))?;
    w.flush()
        .map_err(|e| ClientError::disconnected(format!("daemon flush failed: {e}")))?;
    let mut reader = BufReader::new(stream);
    let mut resp = String::new();
    reader
        .read_line(&mut resp)
        .map_err(|e| ClientError::disconnected(format!("daemon read failed: {e}")))?;
    if resp.is_empty() {
        return Err(ClientError::disconnected(
            "daemon closed the connection without a response",
        ));
    }
    serde_json::from_str(&resp)
        .map_err(|e| ClientError::internal(format!("daemon response is not JSON: {e}")))
}

/// Build a versioned read-only request frame (no auth material attached).
pub fn read_request(id: &str, cmd: &str, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "protocol": crate::version::IPC_PROTOCOL_VERSION, "id": id, "cmd": cmd, "params": params })
}

/// Interpret a daemon response envelope into result-or-client-error.
pub fn interpret_response(resp: &serde_json::Value) -> Result<serde_json::Value, ClientError> {
    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        return Ok(resp.clone());
    }
    let code = resp
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("daemon-error");
    let message = resp
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("daemon refused the request");
    match code {
        "peer-unauthorized" | "issuer-untrusted" | "privileged-disabled" | "replay-rejected" => {
            Err(ClientError::unauthorized(format!("{code}: {message}")))
        }
        _ => Err(ClientError::internal(format!("{code}: {message}"))),
    }
}
