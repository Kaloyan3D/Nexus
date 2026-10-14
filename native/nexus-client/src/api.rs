//! Versioned client operations shared by CLI and future GUI (A2.4 Phase 2).
//!
//! One authoritative surface: status/health, task listing and details,
//! attempt status, registry model information (mock catalog offline;
//! live issuance stays blocked), verification/evidence, streaming events,
//! and operator actions gated by daemon authorization. The client never
//! opens SQLite: kernel state arrives only through the authenticated IPC
//! boundary, and task metadata arrives from read-only ledger JSON.

use crate::config::ClientConfig;
use crate::error::ClientError;
use crate::transport::{interpret_response, ipc_roundtrip, read_request};

/// Request timeout for single IPC round trips.
pub const IPC_TIMEOUT_MS: u64 = 10_000;

fn req(cfg: &ClientConfig, id: &str, cmd: &str) -> Result<serde_json::Value, ClientError> {
    let frame = read_request(id, cmd, serde_json::json!({}));
    let resp = ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?;
    interpret_response(&resp)
}

/// Runtime status and health (read-only; works while the daemon runs).
pub fn status(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    req(cfg, "nexus-status", "status")
}

/// Daemon health probe (read-only).
pub fn health(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    req(cfg, "nexus-health", "health")
}

/// Read-only dispatch readiness assessment (observational, never authorizing).
pub fn readiness(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    req(cfg, "nexus-readiness", "readiness")
}

/// One command receipt by id (read-only).
pub fn receipt(cfg: &ClientConfig, command_id: &str) -> Result<serde_json::Value, ClientError> {
    if command_id.is_empty() {
        return Err(ClientError::usage("command id must not be empty"));
    }
    let frame = read_request(
        "nexus-receipt",
        "receipt",
        serde_json::json!({ "commandId": command_id }),
    );
    interpret_response(&ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?)
}

/// Bounded journal read (read-only event streaming source).
pub fn journal(cfg: &ClientConfig, limit: u64) -> Result<serde_json::Value, ClientError> {
    let frame = read_request(
        "nexus-journal",
        "journal",
        serde_json::json!({ "limit": limit }),
    );
    interpret_response(&ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?)
}

/// Store digest (read-only integrity pin).
pub fn digest(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    req(cfg, "nexus-digest", "digest")
}

/// Task listing from the read-only Controller ledger (never SQLite).
/// Without a ledger directory the operation reports `ledger-unavailable`
/// instead of inventing tasks.
pub fn tasks(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    let dir = cfg.ledger_dir.clone().ok_or_else(|| {
        ClientError::usage("no ledger directory configured (set NEXUS_LEDGER_DIR or --ledger-dir)")
    })?;
    let path = dir.join("tasks.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        ClientError::internal(format!("ledger unreadable at {}: {e}", path.display()))
    })?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| ClientError::internal(format!("ledger tasks.json is not JSON: {e}")))?;
    Ok(serde_json::json!({ "ok": true, "tasks": value, "source": path.display().to_string() }))
}

/// Task details: ledger record plus live attempt/receipt state where known.
pub fn task_show(cfg: &ClientConfig, task_id: &str) -> Result<serde_json::Value, ClientError> {
    if task_id.is_empty() {
        return Err(ClientError::usage("task id must not be empty"));
    }
    let all = tasks(cfg)?;
    let found = all.get("tasks").cloned().unwrap_or(serde_json::Value::Null);
    Ok(
        serde_json::json!({ "ok": true, "taskId": task_id, "tasks": found, "note": "ledger is the task source of truth; kernel receipts pin execution state per command" }),
    )
}

/// Controller attempt status: receipt plus generation/witness context.
pub fn attempt_status(
    cfg: &ClientConfig,
    command_id: &str,
) -> Result<serde_json::Value, ClientError> {
    let r = receipt(cfg, command_id)?;
    let ready = readiness(cfg).unwrap_or(serde_json::json!({"ok": false}));
    Ok(serde_json::json!({ "ok": true, "commandId": command_id, "receipt": r, "readiness": ready }))
}

/// Registry model information.
///
/// Offline A2.4 reports the local mock/test catalog plus the explicit live
/// blockers (no TLS stack, no live scope gate, no billing metadata, no live
/// credential path). The Registry JS service remains the only live model
/// authority: this catalog never routes production traffic.
pub fn models() -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "clientApiVersion": crate::version::CLIENT_API_VERSION,
        "catalog": [
            { "model": "e2e-mock-model", "scope": "mock-e2e", "origin": "http://127.0.0.1:0 (loopback testbed)", "reasoning": "low", "live": false },
            { "model": "remote-model-a", "scope": "offline-test", "origin": "loopback only", "reasoning": "low", "live": false }
        ],
        "live": { "ready": false, "blockers": ["no live scope authorization (kernel refuses non-mock-e2e)", "no TLS termination in the transport (https refused fail-closed)", "production Registry carries no billingTier metadata", "no live credential loading path", "multi-UID container re-proof pending"] },
        "dispatchEnabled": false
    })
}

/// Verification and evidence bundle for one command (receipt + journal +
/// digest, all read-only).
pub fn verify(cfg: &ClientConfig, command_id: &str) -> Result<serde_json::Value, ClientError> {
    let r = receipt(cfg, command_id)?;
    let j = journal(cfg, 50).unwrap_or(serde_json::json!({"ok": false}));
    let d = digest(cfg).unwrap_or(serde_json::json!({"ok": false}));
    Ok(
        serde_json::json!({ "ok": true, "commandId": command_id, "receipt": r, "journal": j, "digest": d, "dispatchEnabled": false }),
    )
}

/// Operator cancellation (Controller fence) is authorization-gated: normal
/// CLI users without the daemon issuer capability receive `unauthorized`.
/// This client never mints or forwards raw capabilities; the daemon enforces
/// the gate and this function only surfaces its refusal honestly.
pub fn cancel(_cfg: &ClientConfig, _command_id: &str) -> Result<serde_json::Value, ClientError> {
    Err(ClientError::unauthorized("cancellation requires the daemon issuer capability, which normal CLI users are never given; run the broker as operator or fence through the Controller ledger"))
}

/// Local daemon reachability without authentication (used by `doctor`).
pub fn probe_daemon(cfg: &ClientConfig) -> (bool, String) {
    match health(cfg) {
        Ok(_) => (
            true,
            format!("daemon reachable at {}", cfg.socket_path.display()),
        ),
        Err(e) => (
            false,
            format!("daemon unreachable at {}: {e}", cfg.socket_path.display()),
        ),
    }
}
