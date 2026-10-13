//! A1.2 shadow bridge protocol (version 1).
//!
//! A narrowly scoped JS -> Rust request/response surface for SHADOW-ONLY
//! command acceptance. Transport is a local CLI subprocess: the caller
//! writes one bounded JSON request file and reads one JSON response on
//! stdout. There is deliberately:
//!
//! - no daemon, no socket, no authentication to get wrong: the OS process
//!   boundary plus file permissions are the trust boundary. The prototype
//!   operates in an isolated trusted test boundary; a real Controller
//!   deployment MUST keep this shadow-only (see A1.2 evidence).
//! - no shell interpolation: argv file paths only, JSON over stdio.
//! - no model execution, tool invocation, dispatch, network or exec paths:
//!   the request vocabulary cannot name an executable at all.
//! - no secrets in logs: responses carry digests, ids and kebab-case error
//!   codes only; the issuance HMAC key never leaves the store.
//!
//! Wire shape (all objects, camelCase to match the JS bridge bytes):
//!   request  { protocol: 1, ...command fields }
//!   success  { protocol: 1, ok: true, ...command result }
//!   refusal  { protocol: 1, ok: false, code: "<kebab-code>", message: "..." }
//!
//! Subcommands: acquire | seal | accept | receipt | journal | digest.
//! Every non-digest subcommand is restart-safe and idempotent:
//! re-accepting an identical envelope replays the original receipt,
//! a reused commandId with different identity is a conflict.

use nexus_contracts::{ControllerIntentV1, KernelError, KernelErrorCode};
use std::path::Path;

pub const BRIDGE_PROTOCOL_VERSION: u32 = 1;
/// Hard cap on request file bytes. Shadow envelopes are a few KB; anything
/// larger is rejected before parsing.
pub const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
/// Hard cap on non-empty string fields (ids, digests, incarnations).
pub const MAX_ID_LEN: usize = 1024;
/// Journal responses are bounded; beyond this the response reports
/// truncated: true and the caller pages by commandId reads.
pub const MAX_JOURNAL_EVENTS: usize = 5000;

fn protocol_fail(code: KernelErrorCode, msg: impl Into<String>) -> serde_json::Value {
    serde_json::json!({
        "protocol": BRIDGE_PROTOCOL_VERSION,
        "ok": false,
        "code": code.as_str(),
        "message": msg.into(),
    })
}

fn get_map<'a>(
    root: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<&'a serde_json::Map<String, serde_json::Value>, serde_json::Value> {
    match root.get(field) {
        Some(serde_json::Value::Object(m)) => Ok(m),
        _ => Err(protocol_fail(
            KernelErrorCode::DeliveryInvalid,
            format!("bad-request: '{field}' must be an object"),
        )),
    }
}

fn get_string(
    map: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    allow_empty: bool,
) -> Result<String, serde_json::Value> {
    match map.get(field) {
        Some(serde_json::Value::String(s)) => {
            if !allow_empty && s.is_empty() {
                return Err(protocol_fail(
                    KernelErrorCode::DeliveryInvalid,
                    format!("bad-request: '{field}' must not be empty"),
                ));
            }
            if s.len() > MAX_ID_LEN {
                return Err(protocol_fail(
                    KernelErrorCode::DeliveryInvalid,
                    format!("bad-request: '{field}' exceeds {MAX_ID_LEN} bytes"),
                ));
            }
            Ok(s.clone())
        }
        _ => Err(protocol_fail(
            KernelErrorCode::DeliveryInvalid,
            format!("bad-request: '{field}' must be a string"),
        )),
    }
}

fn get_u64(
    map: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<u64, serde_json::Value> {
    match map.get(field) {
        Some(serde_json::Value::Number(n)) => n.as_u64().ok_or_else(|| {
            protocol_fail(
                KernelErrorCode::DeliveryInvalid,
                format!("bad-request: '{field}' must be an unsigned integer"),
            )
        }),
        _ => Err(protocol_fail(
            KernelErrorCode::DeliveryInvalid,
            format!("bad-request: '{field}' must be an unsigned integer"),
        )),
    }
}

fn check_protocol(root: &serde_json::Value) -> Result<(), serde_json::Value> {
    match root.get("protocol") {
        Some(serde_json::Value::Number(n))
            if n.as_u64() == Some(BRIDGE_PROTOCOL_VERSION as u64) =>
        {
            Ok(())
        }
        _ => Err(protocol_fail(
            KernelErrorCode::UnsupportedSchema,
            "bad-request: 'protocol' must be 1",
        )),
    }
}

/// Read and validate one bounded request file. Process-level failures
/// (missing file, oversize, unparsable JSON, non-object envelope) are
/// returned as Err(String) for stderr + exit code; every well-formed
/// request envelope instead yields a versioned JSON response value.
pub fn read_request(path: &Path) -> Result<serde_json::Value, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("unreadable request file: {e}"))?;
    if meta.len() > MAX_REQUEST_BYTES {
        return Err(format!(
            "request file exceeds {MAX_REQUEST_BYTES} bytes (too-large)"
        ));
    }
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("unreadable request file: {e}"))?;
    if text.len() as u64 > MAX_REQUEST_BYTES {
        return Err("request file exceeds size cap (too-large)".to_owned());
    }
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("request is not valid JSON: {e}"))?;
    if !value.is_object() {
        return Err("request envelope must be a JSON object (bad-request)".to_owned());
    }
    Ok(value)
}

/// Execute one validated request against an opened kernel. Never panics on
/// adversarial input: every refusal is a versioned { ok: false } value.
pub fn execute(
    kernel: &mut crate::Kernel,
    command: &str,
    req: &serde_json::Value,
) -> serde_json::Value {
    if let Err(response) = check_protocol(req) {
        return response;
    }
    let root = req.as_object().expect("envelope is an object");
    match command {
        "acquire" => do_acquire(kernel, root),
        "seal" => do_seal(kernel, root),
        "accept" => do_accept(kernel, root),
        "receipt" => do_receipt(kernel, root),
        "journal" => do_journal(kernel, root),
        _ => protocol_fail(
            KernelErrorCode::DeliveryInvalid,
            "bad-request: unknown bridge subcommand",
        ),
    }
}

fn kernel_fail(e: KernelError) -> serde_json::Value {
    protocol_fail(e.code, e.message)
}

fn do_acquire(
    kernel: &mut crate::Kernel,
    root: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    let task = match get_string(root, "taskInstanceId", false) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let backend = match get_string(root, "backend", false) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match kernel.acquire_generation(&task, &backend) {
        Ok(lease) => serde_json::json!({
            "protocol": BRIDGE_PROTOCOL_VERSION,
            "ok": true,
            "lease": lease,
        }),
        Err(e) => kernel_fail(e),
    }
}

fn do_seal(
    kernel: &mut crate::Kernel,
    root: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    let resolution_value = match root.get("resolution") {
        Some(v) if v.is_object() => v.clone(),
        _ => {
            return protocol_fail(
                KernelErrorCode::DeliveryInvalid,
                "bad-request: 'resolution' must be an object",
            )
        }
    };
    let issued: nexus_contracts::RegistryResolutionV1 =
        match serde_json::from_value(resolution_value) {
            Ok(v) => v,
            Err(_) => {
                return protocol_fail(
                    KernelErrorCode::DeliveryInvalid,
                    "bad-request: 'resolution' does not match RegistryResolutionV1",
                )
            }
        };
    match kernel.seal_issuance(&issued) {
        Ok(id) => serde_json::json!({
            "protocol": BRIDGE_PROTOCOL_VERSION,
            "ok": true,
            "issuanceId": id,
        }),
        Err(e) => kernel_fail(e),
    }
}

fn do_accept(
    kernel: &mut crate::Kernel,
    root: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    let intent_value = match root.get("intent") {
        Some(v) if v.is_object() => v.clone(),
        _ => {
            return protocol_fail(
                KernelErrorCode::DeliveryInvalid,
                "bad-request: 'intent' must be an object",
            )
        }
    };
    let resolution_value = match root.get("resolution") {
        Some(v) if v.is_object() => v.clone(),
        _ => {
            return protocol_fail(
                KernelErrorCode::DeliveryInvalid,
                "bad-request: 'resolution' must be an object",
            )
        }
    };
    let snapshot = match root.get("snapshot") {
        Some(v) if v.is_object() => v.clone(),
        _ => {
            return protocol_fail(
                KernelErrorCode::DeliveryInvalid,
                "bad-request: 'snapshot' must be an object",
            )
        }
    };
    let lease_map = match get_map(root, "lease") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let mut intent: ControllerIntentV1 = match serde_json::from_value(intent_value) {
        Ok(v) => v,
        Err(_) => {
            return protocol_fail(
                KernelErrorCode::DeliveryInvalid,
                "bad-request: 'intent' does not match ControllerIntentV1",
            )
        }
    };
    if intent.lease.is_some() {
        return protocol_fail(
            KernelErrorCode::DeliveryInvalid,
            "bad-request: intent carries its own lease; the lease comes only from acquire_generation",
        );
    }
    let issued: nexus_contracts::RegistryResolutionV1 =
        match serde_json::from_value(resolution_value) {
            Ok(v) => v,
            Err(_) => {
                return protocol_fail(
                    KernelErrorCode::DeliveryInvalid,
                    "bad-request: 'resolution' does not match RegistryResolutionV1",
                )
            }
        };
    let epoch = match get_u64(lease_map, "epoch") {
        Ok(v) => v,
        Err(r) => return r,
    };
    let incarnation = match get_string(lease_map, "storeIncarnation", false) {
        Ok(v) => v,
        Err(r) => return r,
    };
    intent = intent.with_lease(epoch, &incarnation);
    let req = crate::AcceptRequest {
        intent,
        issued,
        snapshot,
    };
    match kernel.accept_command(&req) {
        Ok((receipt, created)) => serde_json::json!({
            "protocol": BRIDGE_PROTOCOL_VERSION,
            "ok": true,
            "receipt": receipt,
            "replayed": !created,
        }),
        Err(e) => kernel_fail(e),
    }
}

fn do_receipt(
    kernel: &mut crate::Kernel,
    root: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    let command_id = match get_string(root, "commandId", false) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match kernel.read_receipt(&command_id) {
        Ok(found) => serde_json::json!({
            "protocol": BRIDGE_PROTOCOL_VERSION,
            "ok": true,
            "receipt": found,
        }),
        Err(e) => kernel_fail(e),
    }
}

fn do_journal(
    kernel: &mut crate::Kernel,
    root: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    let task = match get_string(root, "taskInstanceId", false) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let backend = match get_string(root, "backend", false) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let events = match kernel.list_events(&task, &backend) {
        Ok(v) => v,
        Err(e) => return kernel_fail(e),
    };
    let truncated = events.len() > MAX_JOURNAL_EVENTS;
    let mut receipts = Vec::new();
    for event in events.iter().take(MAX_JOURNAL_EVENTS) {
        if let Some(command_id) = event.command_id.as_ref() {
            match kernel.read_receipt(command_id) {
                Ok(Some(r)) => receipts.push(r),
                Ok(None) => {}
                Err(e) => return kernel_fail(e),
            }
        }
    }
    serde_json::json!({
        "protocol": BRIDGE_PROTOCOL_VERSION,
        "ok": true,
        "receipts": receipts,
        "events": events.into_iter().take(MAX_JOURNAL_EVENTS).collect::<Vec<_>>(),
        "truncated": truncated,
    })
}

/// Canonical digest oracle (no store access): proves JS <-> Rust digest
/// agreement on identical JSON bytes. Used by the bridge integration tests.
pub fn digest_value(value: &serde_json::Value) -> serde_json::Value {
    let canonical = nexus_contracts::canonical_json(value);
    let sha = nexus_contracts::sha256_hex(&canonical);
    serde_json::json!({
        "protocol": BRIDGE_PROTOCOL_VERSION,
        "ok": true,
        "canonical": canonical,
        "sha256": sha,
    })
}

/// Render a kernel error as a versioned refusal (shared with main.rs).
pub fn render_kernel_error(e: &KernelError) -> serde_json::Value {
    kernel_fail(KernelError::new(e.code, e.message.clone()))
}
