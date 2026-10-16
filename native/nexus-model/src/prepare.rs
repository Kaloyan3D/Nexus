//! Exact target-bound request preparation + pre-dispatch attestation
//! (A2.2, Phase 4.1/4.2).
//!
//! `prepare()` NEVER sends network bytes: it binds the pin, the
//! authoritative target, and the model input into exact, inspectable
//! request bytes. `attest()` re-verifies the binding and issues the ONLY
//! token `dispatch()` accepts. There is no constructor for
//! `AttestedPreparedModelRequest` except `attest()`.
//!
//! The attestation is structural (see `pin.rs` trust boundary): it proves
//! the prepared bytes still match the presented pin/target digests. It is
//! not a production authorization token and confers no right to execute.

use crate::error::{ModelError, ModelErrorCode};
use crate::pin::VerifiedExecutionPin;
use crate::request::{ModelRequest, MAX_REQUEST_BYTES};
use crate::target::ExecutionTargetV2;
use nexus_contracts::RegistryResolutionV1;

/// Exact bytes ready to send, with their provenance. Inspectable BEFORE
/// dispatch: tests assert on `request_bytes`, `endpoint_origin`,
/// `remote_model_id`, `reasoning_effort`, and `session_header`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedModelRequest {
    /// Attempt this preparation belongs to.
    pub attempt_id: String,
    /// Exact endpoint origin (scheme://host[:port]).
    pub endpoint_origin: String,
    /// Exact endpoint path.
    pub endpoint_path: String,
    /// HTTP method (`POST`).
    pub method: String,
    /// Protocol (`https`, or `http` for loopback testbeds).
    pub protocol: String,
    /// Authoritative remote model id (from the target, never the input).
    pub remote_model_id: String,
    /// Effective reasoning effort (pin-confirmed).
    pub reasoning_effort: String,
    /// Stable `x-opencode-session` value (pin-confirmed).
    pub session_header: String,
    /// Wire adapter the Registry target selected.
    pub wire_profile: crate::target::WireProfile,
    /// Exact serialized request body (canonical JSON).
    pub request_bytes: Vec<u8>,
    /// sha256 of `request_bytes`.
    pub request_digest: String,
    /// Target extension digest this preparation is bound to.
    pub target_digest: String,
    /// Extension digest this preparation is bound to.
    pub extension_digest: String,
    /// Pin digest this preparation is bound to.
    pub pin_digest: String,
}

/// The ONLY value `dispatch()` accepts. Field is private: construction
/// requires [`attest`], which re-verifies the full binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttestedPreparedModelRequest {
    prepared: PreparedModelRequest,
    attestation: Attestation,
}

/// Pre-dispatch attestation record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attestation {
    /// Pin digest covered by the attestation.
    pub pin_digest: String,
    /// Target digest covered by the attestation.
    pub target_digest: String,
    /// Extension digest covered by the attestation.
    pub extension_digest: String,
    /// Request digest covered by the attestation.
    pub request_digest: String,
    /// Attestation instant (unix millis, for audit only — never a TTL).
    pub issued_at_ms: i64,
}

impl AttestedPreparedModelRequest {
    /// Borrow the prepared request (read-only; no mutation seam exists).
    pub fn prepared(&self) -> &PreparedModelRequest {
        &self.prepared
    }

    /// Borrow the attestation record.
    pub fn attestation(&self) -> &Attestation {
        &self.attestation
    }
}

/// Bind pin + authoritative target + model input into exact request bytes.
/// Sends NOTHING. Refuses wrong-target drift, incomplete targets, and
/// oversize payloads before any byte exists to send.
pub fn prepare(
    pin: &VerifiedExecutionPin,
    issued: &RegistryResolutionV1,
    snapshot: &serde_json::Value,
    target: &ExecutionTargetV2,
    input: &ModelRequest,
) -> Result<PreparedModelRequest, ModelError> {
    target.validate_executable()?;
    pin.verify_against(issued, snapshot, target)?;
    input.validate_shape()?;
    let reasoning = input
        .effective_reasoning(&target.reasoning_effort)?
        .to_owned();
    let session = input
        .effective_session(&target.session.session_id)?
        .to_owned();
    let max_output = input.effective_max_output(target.output_limit_tokens)?;
    // Exact OpenCode-compatible body. The model id, reasoning effort, and
    // session come ONLY from the pinned target + confirmed overrides.
    let body = match target.wire_profile {
        crate::target::WireProfile::Legacy if input.tool_profile.is_some() => {
            return Err(ModelError::new(
                ModelErrorCode::TransportRefused,
                "the repo-inspect tool profile is only offered through the OpenCode Go adapter",
            ));
        }
        crate::target::WireProfile::Legacy => serde_json::json!({
            "model": target.remote_model_id_confirmed,
            "input": input.messages.iter().map(|m| {
                serde_json::json!({ "role": m.role, "content": m.content })
            }).collect::<Vec<_>>(),
            "reasoning": { "effort": reasoning },
            "stream": true,
            // A5.2 budget: the Registry-sealed output limit travels with every
            // request so the provider itself bounds the billable output.
            "max_output_tokens": max_output,
            "session": { "id": session },
            "tools": input.tools.iter().map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                })
            }).collect::<Vec<_>>(),
            "metadata": {
                "x-opencode-session": session,
                "route": target.core.route_id,
                "provider": target.core.provider_id,
                "connection": target.core.connection_id,
            },
        }),
        // OpenCode Go adapter: the minimal Responses body only. No `session`
        // or `metadata` extension fields (the session travels in the
        // `x-opencode-session` header), no `tools` (model-only), nothing the
        // documented contract does not name.
        crate::target::WireProfile::OpenCodeGoResponses => {
            if !input.tools.is_empty() {
                return Err(ModelError::new(
                    ModelErrorCode::TransportRefused,
                    "the OpenCode Go adapter never sends caller-supplied tool definitions",
                ));
            }
            if max_output < crate::target::OPENCODE_GO_MIN_OUTPUT_TOKENS {
                return Err(ModelError::new(
                    ModelErrorCode::TargetIncomplete,
                    "output cap is below the provider minimum of 16 tokens",
                ));
            }
            match input.tool_profile {
                // A5.5 tool-enabled variant: fixed catalog, stateless history
                // (function_call + function_call_output items), one call at a time.
                Some(crate::request::ToolProfile::RepoInspectV1) => serde_json::json!({
                    "model": target.remote_model_id_confirmed,
                    "input": input.items.iter().map(|it| match it {
                        crate::request::InputItem::Message { role, content } => {
                            serde_json::json!({ "role": role, "content": content })
                        }
                        crate::request::InputItem::FunctionCall { call_id, name, arguments } => {
                            serde_json::json!({
                                "type": "function_call", "call_id": call_id,
                                "name": name, "arguments": arguments,
                            })
                        }
                        crate::request::InputItem::FunctionCallOutput { call_id, output } => {
                            serde_json::json!({
                                "type": "function_call_output", "call_id": call_id, "output": output,
                            })
                        }
                    }).collect::<Vec<_>>(),
                    "tools": crate::repo_tools::definitions(),
                    "tool_choice": "auto",
                    "parallel_tool_calls": false,
                    "stream": true,
                    "max_output_tokens": max_output,
                    "reasoning": { "effort": reasoning },
                }),
                None => serde_json::json!({
                    "model": target.remote_model_id_confirmed,
                    "input": input.messages.iter().map(|m| {
                        serde_json::json!({ "role": m.role, "content": m.content })
                    }).collect::<Vec<_>>(),
                    "stream": true,
                    "max_output_tokens": max_output,
                    "reasoning": { "effort": reasoning },
                }),
            }
        }
    };
    let canonical = nexus_contracts::canonical_json(&body);
    if canonical.len() > MAX_REQUEST_BYTES {
        return Err(ModelError::new(
            ModelErrorCode::PayloadTooLarge,
            format!("serialized request exceeds {MAX_REQUEST_BYTES} bytes"),
        ));
    }
    let request_digest = nexus_contracts::sha256_hex(&canonical);
    Ok(PreparedModelRequest {
        attempt_id: pin.attempt_id.clone(),
        endpoint_origin: target.endpoint.origin.clone(),
        endpoint_path: target.endpoint.path.clone(),
        method: target.endpoint.method.clone(),
        protocol: target.endpoint.protocol.clone(),
        remote_model_id: target.remote_model_id_confirmed.clone(),
        reasoning_effort: reasoning,
        session_header: session,
        wire_profile: target.wire_profile,
        request_bytes: canonical.into_bytes(),
        request_digest,
        target_digest: pin.target_digest.clone(),
        extension_digest: pin.extension_digest.clone(),
        pin_digest: pin.pin_digest(),
    })
}

/// Re-verify the full binding and issue the dispatch attestation. The
/// attestation covers (pin, target, extension, request) digests: any later
/// mutation invalidates it, and `dispatch()` re-checks coverage.
pub fn attest(
    pin: &VerifiedExecutionPin,
    issued: &RegistryResolutionV1,
    snapshot: &serde_json::Value,
    target: &ExecutionTargetV2,
    prepared: PreparedModelRequest,
    now_ms: i64,
) -> Result<AttestedPreparedModelRequest, ModelError> {
    target.validate_executable()?;
    pin.verify_against(issued, snapshot, target)?;
    if prepared.attempt_id != pin.attempt_id {
        return Err(ModelError::new(
            ModelErrorCode::AttestationFailed,
            "prepared attempt differs from the pinned attempt",
        ));
    }
    if prepared.pin_digest != pin.pin_digest() {
        return Err(ModelError::new(
            ModelErrorCode::AttestationFailed,
            "prepared pin binding no longer matches",
        ));
    }
    if prepared.extension_digest != pin.extension_digest
        || prepared.extension_digest != target.extension_digest()
    {
        return Err(ModelError::new(
            ModelErrorCode::WrongTarget,
            "prepared extension binding drifted after preparation",
        ));
    }
    if prepared.remote_model_id != target.remote_model_id_confirmed
        || prepared.reasoning_effort != target.reasoning_effort
        || prepared.session_header != target.session.session_id
        || prepared.endpoint_origin != target.endpoint.origin
        || prepared.endpoint_path != target.endpoint.path
    {
        return Err(ModelError::new(
            ModelErrorCode::WrongTarget,
            "prepared routing differs from the pinned target",
        ));
    }
    let recomputed = nexus_contracts::sha256_hex(&String::from_utf8_lossy(&prepared.request_bytes));
    if recomputed != prepared.request_digest {
        return Err(ModelError::new(
            ModelErrorCode::AttestationFailed,
            "prepared bytes do not match their digest",
        ));
    }
    let attestation = Attestation {
        pin_digest: prepared.pin_digest.clone(),
        target_digest: prepared.target_digest.clone(),
        extension_digest: prepared.extension_digest.clone(),
        request_digest: prepared.request_digest.clone(),
        issued_at_ms: now_ms,
    };
    Ok(AttestedPreparedModelRequest {
        prepared,
        attestation,
    })
}

/// Current unix time in millis (audit stamp only).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
