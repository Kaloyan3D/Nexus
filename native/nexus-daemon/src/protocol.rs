//! A1.3 daemon IPC protocol (version 1).
//!
//! Transport: Linux Unix Domain Socket, one JSON object per line
//! (`\n`-terminated frames). Each request frame is bounded to 1 MiB;
//! anything larger is rejected before parsing and the connection is closed.
//!
//! Request envelope (exact keys; unknown top-level keys are rejected):
//!   { protocol: 1, id: "<client request id>", cmd: "<command>",
//!     params: { ... }, auth?: { nonce, ts, tag } }
//!
//! Response envelope:
//!   { protocol: 1, id: "<same id>", ok: true, ...result }
//!   { protocol: 1, id: "<same id>", ok: false, code: "<kebab>",
//!     message: "..." }
//!
//! Commands: `health` | `status` | `receipt` | `journal` | `digest`
//! (read-only, no authorization) and `acquire` | `seal` | `accept`
//! (privileged: refused unless the daemon runs in an explicitly trusted
//! shadow-test configuration with per-request issuer authentication).
//!
//! Unknown commands fail closed. No command carries shell text, filesystem
//! paths, or executable references: the vocabulary cannot name them.

use serde_json::Value;

/// Daemon IPC protocol version. Mismatches are rejected, never negotiated
/// down: the daemon speaks exactly this version.
pub const IPC_PROTOCOL_VERSION: u32 = 1;
/// Hard cap on one request frame (bytes, excluding the trailing newline).
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// Hard cap on one response frame (bytes). Kernel responses are small;
/// anything beyond this is a server bug and the connection is closed.
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Hard cap on non-empty string fields (ids, digests, command names).
pub const MAX_ID_LEN: usize = 1024;
/// Journal responses are bounded; beyond this the response reports
/// truncated: true and the caller pages by commandId reads.
pub const MAX_JOURNAL_EVENTS: usize = 5000;
/// Per-request I/O deadline in milliseconds.
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;
/// Maximum concurrent client connections; beyond this new connections are
/// refused immediately (backpressure) instead of queuing unboundedly.
pub const MAX_CLIENTS: usize = 32;

/// Machine-readable IPC failure codes. Kernel failures reuse the kernel's
/// own kebab-case vocabulary; these codes cover daemon/IPC/auth failures.
/// They are plain strings (not part of the versioned contract enum) so the
/// contract schema version does not move for operational failures.
pub mod codes {
    pub const VERSION_MISMATCH: &str = "version-mismatch";
    pub const BAD_REQUEST: &str = "bad-request";
    pub const TOO_LARGE: &str = "too-large";
    pub const UNKNOWN_COMMAND: &str = "unknown-command";
    pub const PRIVILEGED_DISABLED: &str = "privileged-disabled";
    pub const ISSUER_UNTRUSTED: &str = "issuer-untrusted";
    pub const PEER_UNAUTHORIZED: &str = "peer-unauthorized";
    pub const REPLAY_REJECTED: &str = "replay-rejected";
    pub const REPLAY_CACHE_EXHAUSTED: &str = "replay-cache-exhausted";
    pub const DAEMON_ALREADY_RUNNING: &str = "daemon-already-running";
    pub const DAEMON_OWN_STORE: &str = "daemon-owns-store";
    pub const SERVER_BUSY: &str = "server-busy";
    pub const STORE_UNHEALTHY: &str = "store-unhealthy";
}

/// Validated request. `raw_id` preserves the client id for error responses
/// even when deeper validation fails (ids that are missing/non-string fall
/// back to the empty string so the response envelope stays well-formed).
#[derive(Debug, Clone)]
pub struct IpcRequest {
    pub id: String,
    pub cmd: String,
    pub params: serde_json::Map<String, Value>,
    pub auth: Option<AuthFields>,
}

#[derive(Debug, Clone)]
pub struct AuthFields {
    pub nonce: String,
    pub ts: i64,
    pub tag: String,
}

pub fn ok(id: &str, result: Value) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("protocol".to_owned(), Value::from(IPC_PROTOCOL_VERSION));
    obj.insert("id".to_owned(), Value::String(id.to_owned()));
    obj.insert("ok".to_owned(), Value::Bool(true));
    if let Value::Object(map) = result {
        for (k, v) in map {
            obj.insert(k, v);
        }
    }
    Value::Object(obj)
}

pub fn fail(id: &str, code: &str, message: impl Into<String>) -> Value {
    serde_json::json!({
        "protocol": IPC_PROTOCOL_VERSION,
        "id": id,
        "ok": false,
        "code": code,
        "message": message.into(),
    })
}

fn get_string(map: &serde_json::Map<String, Value>, field: &str) -> Result<String, String> {
    match map.get(field) {
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(format!("bad-request: '{field}' must not be empty"));
            }
            if s.len() > MAX_ID_LEN {
                return Err(format!("bad-request: '{field}' exceeds {MAX_ID_LEN} bytes"));
            }
            Ok(s.clone())
        }
        _ => Err(format!("bad-request: '{field}' must be a string")),
    }
}

/// Parse and strictly validate one frame. Returns the request on success;
/// on failure returns (response_id, code, message) for a versioned refusal.
/// Malformed JSON itself is a transport failure (no id is trustworthy) and
/// is reported with an empty-string id.
#[allow(clippy::result_large_err)]
pub fn parse_frame(frame: &str) -> Result<IpcRequest, (String, &'static str, String)> {
    let value: Value = serde_json::from_str(frame).map_err(|e| {
        (
            String::new(),
            codes::BAD_REQUEST,
            format!("request is not valid JSON: {e}"),
        )
    })?;
    let root = match value.as_object() {
        Some(m) => m,
        None => {
            return Err((
                String::new(),
                codes::BAD_REQUEST,
                "request envelope must be a JSON object".to_owned(),
            ));
        }
    };
    for key in root.keys() {
        match key.as_str() {
            "protocol" | "id" | "cmd" | "params" | "auth" => {}
            _ => {
                return Err((
                    String::new(),
                    codes::BAD_REQUEST,
                    format!("bad-request: unknown request field '{key}'"),
                ));
            }
        }
    }
    match root.get("protocol") {
        Some(Value::Number(n)) if n.as_u64() == Some(u64::from(IPC_PROTOCOL_VERSION)) => {}
        _ => {
            let id = root
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            return Err((
                id,
                codes::VERSION_MISMATCH,
                format!(
                    "unsupported IPC protocol version; this daemon speaks exactly version {IPC_PROTOCOL_VERSION}"
                ),
            ));
        }
    }
    let id = get_string(root, "id").map_err(|m| (String::new(), codes::BAD_REQUEST, m))?;
    let cmd = get_string(root, "cmd").map_err(|m| (id.clone(), codes::BAD_REQUEST, m))?;
    let params = match root.get("params") {
        None => serde_json::Map::new(),
        Some(Value::Object(m)) => m.clone(),
        _ => {
            return Err((
                id,
                codes::BAD_REQUEST,
                "bad-request: 'params' must be an object".to_owned(),
            ));
        }
    };
    let auth = match root.get("auth") {
        None => None,
        Some(Value::Object(m)) => {
            let nonce = match m.get("nonce") {
                Some(Value::String(s)) if !s.is_empty() && s.len() <= 128 => s.clone(),
                _ => {
                    return Err((
                        id,
                        codes::BAD_REQUEST,
                        "bad-request: 'auth.nonce' must be a non-empty hex string".to_owned(),
                    ));
                }
            };
            let ts = match m.get("ts") {
                Some(Value::Number(n)) => n.as_i64().ok_or_else(|| {
                    (
                        id.clone(),
                        codes::BAD_REQUEST,
                        "bad-request: 'auth.ts' must be an integer".to_owned(),
                    )
                })?,
                _ => {
                    return Err((
                        id.clone(),
                        codes::BAD_REQUEST,
                        "bad-request: 'auth.ts' must be an integer".to_owned(),
                    ));
                }
            };
            let tag = match m.get("tag") {
                Some(Value::String(s)) if !s.is_empty() && s.len() <= 256 => s.clone(),
                _ => {
                    return Err((
                        id.clone(),
                        codes::BAD_REQUEST,
                        "bad-request: 'auth.tag' must be a non-empty string".to_owned(),
                    ));
                }
            };
            for key in m.keys() {
                match key.as_str() {
                    "nonce" | "ts" | "tag" => {}
                    _ => {
                        return Err((
                            id.clone(),
                            codes::BAD_REQUEST,
                            format!("bad-request: unknown auth field '{key}'"),
                        ));
                    }
                }
            }
            Some(AuthFields { nonce, ts, tag })
        }
        _ => {
            return Err((
                id,
                codes::BAD_REQUEST,
                "bad-request: 'auth' must be an object".to_owned(),
            ));
        }
    };
    Ok(IpcRequest {
        id,
        cmd,
        params,
        auth,
    })
}

/// True for commands that mutate authoritative state and therefore require
/// issuer authorization (or explicit refusal when untrusted).
pub fn is_privileged(cmd: &str) -> bool {
    matches!(
        cmd,
        "acquire"
            | "seal"
            | "accept"
            | "seal-extension"
            | "intent-publish"
            | "intent-fence"
            | "dispatch-authorize"
            | "model-redeem"
            | "workspace-bind"
            | "tool-execute"
            | "tool-revoke"
            | "approval-request"
            | "approval-revoke"
    )
}

/// True for the read-only surface. Anything else is unknown and fails closed.
/// `readiness` is strictly observational (A2.0 Gate 5): it reports blocker
/// dimensions, issues no token, and can never authorize execution.
pub fn is_read_only(cmd: &str) -> bool {
    matches!(
        cmd,
        "health"
            | "status"
            | "receipt"
            | "journal"
            | "digest"
            | "readiness"
            | "tool-events"
            | "approval-list"
            | "integrity-status"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_request_parses() {
        let r = parse_frame(r#"{"protocol":1,"id":"a1","cmd":"health","params":{}}"#).unwrap();
        assert_eq!(r.id, "a1");
        assert_eq!(r.cmd, "health");
        assert!(r.auth.is_none());
    }

    #[test]
    fn version_mismatch_rejected_with_id() {
        let e = parse_frame(r#"{"protocol":2,"id":"a1","cmd":"health"}"#).unwrap_err();
        assert_eq!(e.0, "a1");
        assert_eq!(e.1, codes::VERSION_MISMATCH);
    }

    #[test]
    fn unknown_top_level_field_rejected() {
        let e = parse_frame(r#"{"protocol":1,"id":"a","cmd":"health","evil":1}"#).unwrap_err();
        assert_eq!(e.1, codes::BAD_REQUEST);
    }

    #[test]
    fn non_object_rejected() {
        let e = parse_frame("[1,2]").unwrap_err();
        assert_eq!(e.1, codes::BAD_REQUEST);
    }
}
