//! Authoritative execution-target extension (A2.2, Phase 2).
//!
//! The legacy [`nexus_contracts::ExecutionTargetCoreV1`] identity is
//! preserved byte-for-byte: `issuance_id`, `target_digest`, and
//! `snapshot_digest` keep their A1.x meaning, and [`ExecutionTargetV2`]
//! carries them by value. The extension adds the authoritative fields the
//! legacy vocabulary cannot express — endpoint, billing, capabilities,
//! context, and session metadata — as an explicit versioned contract
//! (`extension_version == 1`).
//!
//! A target missing ANY authoritative field is `target-incomplete`, never
//! executable. There is no implicit fallback: the transport cannot select
//! a model, provider, route, endpoint, or billing tier on its own.

use crate::error::{ModelError, ModelErrorCode};
use nexus_contracts::ExecutionTargetCoreV1;

/// Version of the authoritative extension contract.
pub const TARGET_EXTENSION_VERSION: u32 = 1;

/// Maximum endpoint URL length (mirrors Registry `MAX_URL_LENGTH`).
pub const MAX_ENDPOINT_URL_LEN: usize = 2048;

/// Authoritative provider endpoint. The origin + path are the ONLY bytes
/// the transport may connect to; redirects and proxy rewrites are refused
/// at the transport layer (see `transport.rs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoritativeEndpoint {
    /// `"https"`, or `"http"` for explicitly loopback-local testbeds.
    pub protocol: String,
    /// Full origin, e.g. `"https://api.example.com:443"`.
    pub origin: String,
    /// Absolute path, e.g. `"/v1/responses"`.
    pub path: String,
    /// HTTP method, always `"POST"` in A2.2.
    pub method: String,
    /// True only for loopback test endpoints served by `testkit`. Any
    /// `http` origin that is NOT loopback is refused.
    pub local_loopback: bool,
}

/// Billing / data-use provenance. Both fields are mandatory: a target with
/// unknown billing is not executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BillingProvenance {
    /// Billing tier that will meter the call, e.g. `"metered"`.
    pub tier: String,
    /// Data-use tier, e.g. `"standard"`.
    pub data_use: String,
}

/// Stable session binding. Serialized as the `x-opencode-session` header
/// and echoed in the request metadata; it must be byte-stable per attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionBinding {
    /// Opaque session identity.
    pub session_id: String,
}

/// Complete authoritative execution target (versioned extension over the
/// legacy core). The Registry remains the only model authority: every
/// field here is Registry-issued, and `validate_executable` refuses to
/// invent any of them.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionTargetV2 {
    /// Legacy Registry identity (preserved; issuance math unchanged).
    pub core: ExecutionTargetCoreV1,
    /// Must equal [`TARGET_EXTENSION_VERSION`].
    pub extension_version: u32,
    /// Authoritative endpoint (origin + path + method + protocol).
    pub endpoint: AuthoritativeEndpoint,
    /// Authoritative remote model id; must equal `core.remote_model_id`.
    pub remote_model_id_confirmed: String,
    /// Authoritative reasoning effort; must equal `core.reasoning`.
    pub reasoning_effort: String,
    /// Authoritative billing / data-use provenance.
    pub billing: BillingProvenance,
    /// Authoritative session binding (`x-opencode-session`).
    pub session: SessionBinding,
    /// Authoritative capability set (non-empty).
    pub capabilities: Vec<String>,
    /// Authoritative context window in tokens (> 0).
    pub context_limit_tokens: u64,
    /// Authoritative output limit in tokens (> 0).
    pub output_limit_tokens: u64,
    /// Connection binding; must equal `core.connection_id`. The credential
    /// itself never appears here (see `transport::Credential`).
    pub connection_binding: String,
    /// Opaque credential reference (never a secret value). Binds which
    /// credential the transport may load at its trusted boundary.
    pub credential_ref: String,
}

impl ExecutionTargetV2 {
    /// Refuse anything that is not a fully-specified executable target.
    /// Every refusal names the missing field and carries
    /// `target-incomplete`; cross-field drift carries `wrong-target`.
    pub fn validate_executable(&self) -> Result<(), ModelError> {
        if self.extension_version != TARGET_EXTENSION_VERSION {
            return Err(ModelError::new(
                ModelErrorCode::TargetIncomplete,
                format!(
                    "unsupported target extension version {}",
                    self.extension_version
                ),
            ));
        }
        self.core.validate_complete().map_err(|e| {
            ModelError::new(
                ModelErrorCode::TargetIncomplete,
                format!("legacy target identity incomplete: {e}"),
            )
        })?;
        validate_endpoint(&self.endpoint)?;
        if self.remote_model_id_confirmed.trim().is_empty() {
            return Err(incomplete("remoteModelId (authoritative confirmation)"));
        }
        if self.remote_model_id_confirmed != self.core.remote_model_id {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "authoritative remote model id differs from the sealed core identity",
            ));
        }
        if self.reasoning_effort.trim().is_empty() {
            return Err(incomplete("reasoning effort (authoritative confirmation)"));
        }
        if self.reasoning_effort != self.core.reasoning {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "authoritative reasoning effort differs from the sealed core identity",
            ));
        }
        if self.billing.tier.trim().is_empty() {
            return Err(incomplete("billing.tier"));
        }
        if self.billing.data_use.trim().is_empty() {
            return Err(incomplete("billing.dataUse (data-use provenance)"));
        }
        if self.session.session_id.trim().is_empty() {
            return Err(incomplete("session binding (x-opencode-session)"));
        }
        // The session travels in the x-opencode-session header: the same
        // wire rule applies (CRLF/SP smuggling refused).
        if !is_wire_safe(&self.session.session_id) {
            return Err(ModelError::new(
                ModelErrorCode::TargetIncomplete,
                "session binding carries characters forbidden on the wire",
            ));
        }
        if self.capabilities.is_empty() || self.capabilities.iter().any(|c| c.trim().is_empty()) {
            return Err(incomplete("capabilities (non-empty authoritative set)"));
        }
        if self.context_limit_tokens == 0 {
            return Err(incomplete("context limit (tokens)"));
        }
        if self.connection_binding.trim().is_empty() {
            return Err(incomplete("connection binding"));
        }
        if self.output_limit_tokens == 0 {
            return Err(incomplete("output limit (tokens)"));
        }
        if self.credential_ref.trim().is_empty() {
            return Err(incomplete("credential reference"));
        }
        if self.connection_binding != self.core.connection_id {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "connection binding differs from the sealed core identity",
            ));
        }
        Ok(())
    }

    /// Canonical JSON of the extension (core excluded: its digest already
    /// binds it). The pin binds this digest alongside the legacy digests.
    pub fn extension_canonical(&self) -> String {
        let value = serde_json::json!({
            "extensionVersion": self.extension_version,
            "endpoint": {
                "protocol": self.endpoint.protocol,
                "origin": self.endpoint.origin,
                "path": self.endpoint.path,
                "method": self.endpoint.method,
                "localLoopback": self.endpoint.local_loopback,
            },
            "remoteModelIdConfirmed": self.remote_model_id_confirmed,
            "reasoningEffort": self.reasoning_effort,
            "billing": { "tier": self.billing.tier, "dataUse": self.billing.data_use },
            "session": { "sessionId": self.session.session_id },
            "capabilities": self.capabilities,
            "contextLimitTokens": self.context_limit_tokens,
            "outputLimitTokens": self.output_limit_tokens,
            "connectionBinding": self.connection_binding,
            "credentialRef": self.credential_ref,
        });
        nexus_contracts::canonical_json(&value)
    }

    /// Digest binding the extension bytes.
    pub fn extension_digest(&self) -> String {
        nexus_contracts::sha256_hex(&self.extension_canonical())
    }

    /// Build the authoritative extension from Registry-issued JSON bound to
    /// an already-typed sealed core. The JSON contract is exact: unknown
    /// keys are refused (they would silently split the JS and Rust digests),
    /// every field is type-checked, and the result passes
    /// `validate_executable` before it is returned. The core itself is
    /// caller-provided from the sealed `RegistryResolutionV1`.
    pub fn from_extension_json(
        core: ExecutionTargetCoreV1,
        ext: &serde_json::Value,
    ) -> Result<Self, ModelError> {
        let obj = ext
            .as_object()
            .ok_or_else(|| incomplete("extension (object)"))?;
        const TOP: &[&str] = &[
            "extensionVersion",
            "endpoint",
            "remoteModelIdConfirmed",
            "reasoningEffort",
            "billing",
            "session",
            "capabilities",
            "contextLimitTokens",
            "outputLimitTokens",
            "connectionBinding",
            "credentialRef",
        ];
        for key in obj.keys() {
            if !TOP.contains(&key.as_str()) {
                return Err(ModelError::new(
                    ModelErrorCode::TargetIncomplete,
                    format!("extension carries unknown field {key}"),
                ));
            }
        }
        let str_field = |key: &str| -> Result<String, ModelError> {
            obj.get(key)
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .ok_or_else(|| incomplete(key))
        };
        let u64_field = |key: &str| -> Result<u64, ModelError> {
            obj.get(key)
                .and_then(|v| v.as_u64())
                .ok_or_else(|| incomplete(key))
        };
        let sub = |key: &str| -> Result<&serde_json::Map<String, serde_json::Value>, ModelError> {
            obj.get(key)
                .and_then(|v| v.as_object())
                .ok_or_else(|| incomplete(key))
        };
        let sub_str = |map: &serde_json::Map<String, serde_json::Value>,
                       key: &str,
                       path: &str|
         -> Result<String, ModelError> {
            map.get(key)
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .ok_or_else(|| incomplete(path))
        };
        let endpoint_map = sub("endpoint")?;
        for key in endpoint_map.keys() {
            if !["protocol", "origin", "path", "method", "localLoopback"].contains(&key.as_str()) {
                return Err(ModelError::new(
                    ModelErrorCode::TargetIncomplete,
                    format!("endpoint carries unknown field {key}"),
                ));
            }
        }
        let endpoint = AuthoritativeEndpoint {
            protocol: sub_str(endpoint_map, "protocol", "endpoint.protocol")?,
            origin: sub_str(endpoint_map, "origin", "endpoint.origin")?,
            path: sub_str(endpoint_map, "path", "endpoint.path")?,
            method: sub_str(endpoint_map, "method", "endpoint.method")?,
            local_loopback: endpoint_map
                .get("localLoopback")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| incomplete("endpoint.localLoopback"))?,
        };
        let billing_map = sub("billing")?;
        let billing = BillingProvenance {
            tier: sub_str(billing_map, "tier", "billing.tier")?,
            data_use: sub_str(billing_map, "dataUse", "billing.dataUse")?,
        };
        let session_map = sub("session")?;
        let session = SessionBinding {
            session_id: sub_str(session_map, "sessionId", "session.sessionId")?,
        };
        let capabilities: Vec<String> = obj
            .get("capabilities")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .map(|v| v.as_str().unwrap_or("").to_owned())
                    .collect()
            })
            .ok_or_else(|| incomplete("capabilities"))?;
        let version = obj
            .get("extensionVersion")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| incomplete("extensionVersion"))? as u32;
        let target = Self {
            core,
            extension_version: version,
            endpoint,
            remote_model_id_confirmed: str_field("remoteModelIdConfirmed")?,
            reasoning_effort: str_field("reasoningEffort")?,
            billing,
            session,
            capabilities,
            context_limit_tokens: u64_field("contextLimitTokens")?,
            output_limit_tokens: u64_field("outputLimitTokens")?,
            connection_binding: str_field("connectionBinding")?,
            credential_ref: str_field("credentialRef")?,
        };
        target.validate_executable()?;
        Ok(target)
    }

    /// Deterministic test target bound to a loopback mock origin.
    pub fn test_target(origin: &str, path: &str) -> Self {
        let core = ExecutionTargetCoreV1 {
            schema_version: nexus_contracts::CONTRACT_SCHEMA_VERSION,
            resolution_id: "compat-resolution".to_owned(),
            mode_id: "engineering-v2".to_owned(),
            orchestration_engine_id: "muse".to_owned(),
            mode_config_revision: serde_json::json!({"revision": 1}),
            role_id: "muse_main".to_owned(),
            logical_model_id: "logical-model".to_owned(),
            route_id: "route-a".to_owned(),
            provider_id: "provider-a".to_owned(),
            remote_model_id: "remote-model-a".to_owned(),
            connection_id: "connection-a".to_owned(),
            execution_kind: "raw-model".to_owned(),
            access_type: "managed".to_owned(),
            protocol_id: "https".to_owned(),
            reasoning: "low".to_owned(),
            required_capabilities: vec!["text".to_owned()],
            slot_requirements: serde_json::json!({}),
            data_use_tier: Some("standard".to_owned()),
        };
        Self {
            core,
            extension_version: TARGET_EXTENSION_VERSION,
            endpoint: AuthoritativeEndpoint {
                protocol: origin_protocol(origin).to_owned(),
                origin: origin.to_owned(),
                path: path.to_owned(),
                method: "POST".to_owned(),
                local_loopback: true,
            },
            remote_model_id_confirmed: "remote-model-a".to_owned(),
            reasoning_effort: "low".to_owned(),
            billing: BillingProvenance {
                tier: "metered".to_owned(),
                data_use: "standard".to_owned(),
            },
            session: SessionBinding {
                session_id: "session-test-1".to_owned(),
            },
            capabilities: vec!["text".to_owned()],
            context_limit_tokens: 8192,
            output_limit_tokens: 1024,
            connection_binding: "connection-a".to_owned(),
            credential_ref: "credential://connections/connection-a".to_owned(),
        }
    }
}

fn is_wire_safe(value: &str) -> bool {
    value.bytes().all(|b| b.is_ascii_graphic())
}

pub(crate) fn incomplete(field: &str) -> ModelError {
    ModelError::new(
        ModelErrorCode::TargetIncomplete,
        format!("mandatory authoritative target field {field} is missing"),
    )
}

fn validate_endpoint(ep: &AuthoritativeEndpoint) -> Result<(), ModelError> {
    if ep.origin.trim().is_empty() {
        return Err(incomplete("endpoint.origin"));
    }
    if ep.origin.len() > MAX_ENDPOINT_URL_LEN {
        return Err(ModelError::new(
            ModelErrorCode::TargetIncomplete,
            "endpoint origin exceeds the length bound",
        ));
    }
    if ep.method != "POST" {
        return Err(ModelError::new(
            ModelErrorCode::TargetIncomplete,
            "endpoint method must be POST",
        ));
    }
    if !ep.path.starts_with('/') {
        return Err(incomplete("endpoint.path (absolute path)"));
    }
    // Wire safety: a control byte, SP, DEL, or non-ASCII byte in the origin
    // or path would split the HTTP head (request smuggling). Refuse before
    // any byte exists to send.
    if !is_wire_safe(&ep.origin) {
        return Err(ModelError::new(
            ModelErrorCode::TargetIncomplete,
            "endpoint origin carries characters forbidden on the wire",
        ));
    }
    if !is_wire_safe(&ep.path) {
        return Err(ModelError::new(
            ModelErrorCode::TargetIncomplete,
            "endpoint path carries characters forbidden on the wire",
        ));
    }
    let (scheme, rest) = match ep.origin.split_once("://") {
        Some(p) => p,
        None => {
            return Err(incomplete("endpoint.origin (scheme://host)"));
        }
    };
    if scheme != ep.protocol {
        return Err(ModelError::new(
            ModelErrorCode::WrongTarget,
            "endpoint origin scheme differs from the bound protocol",
        ));
    }
    if ep.protocol != "https" && ep.protocol != "http" {
        return Err(incomplete("endpoint.protocol (http|https)"));
    }
    // No userinfo: credentials never travel inside the endpoint string.
    let host_part = rest.split('/').next().unwrap_or("");
    if host_part.contains('@') {
        return Err(ModelError::new(
            ModelErrorCode::TargetIncomplete,
            "endpoint origin must not carry userinfo",
        ));
    }
    let host = host_part.split(':').next().unwrap_or("");
    if host.trim().is_empty() {
        return Err(incomplete("endpoint.origin (hostname)"));
    }
    if ep.protocol == "http" && !ep.local_loopback {
        return Err(ModelError::new(
            ModelErrorCode::TargetIncomplete,
            "plaintext http is allowed only for explicitly loopback-local testbeds",
        ));
    }
    if ep.protocol == "http" && ep.local_loopback && !is_loopback_host(host) {
        return Err(ModelError::new(
            ModelErrorCode::TargetIncomplete,
            "loopback-local endpoint must address a loopback host",
        ));
    }
    Ok(())
}

fn origin_protocol(origin: &str) -> &str {
    match origin.split_once("://") {
        Some(("http", _)) => "http",
        _ => "https",
    }
}

fn is_loopback_host(host: &str) -> bool {
    let h = host
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    h == "localhost" || h == "127.0.0.1" || h == "::1" || h.starts_with("127.")
}
