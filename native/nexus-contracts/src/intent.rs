//! `NexusIntentV1`: the versioned, unprivileged user-intent contract (A5.3).
//!
//! This is what a *client* (CLI, Nexus Desktop, a future external consumer)
//! may ask of Nexus. It deliberately contains no authority: no issuer
//! capability, no provider token or URL, no kernel grant, no tool/workspace
//! vocabulary. Unknown fields are rejected (`deny_unknown_fields`), so a
//! client cannot smuggle `grant`, `cap`, `apiKey`, `providerUrl`, `tools`,
//! `workspace` or approval requests into the request.
//!
//! The client identity is NOT a field: the broker derives it from the OS
//! peer credentials of the connection. Anything the client says about
//! itself (`clientLabel`) is display-only and never used for authorization.

use serde::{Deserialize, Serialize};

pub const INTENT_SCHEMA_VERSION: u32 = 1;
/// Largest accepted content (bytes).
pub const MAX_INTENT_CONTENT_BYTES: usize = 16 * 1024;
/// Hard ceiling a client may request for output tokens (the sealed Registry
/// limit still applies and may be lower).
pub const MAX_INTENT_OUTPUT_TOKENS: u64 = 1_000_000;

/// Machine-readable rejection class, stable across CLI/Desktop/external use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentError {
    pub code: &'static str,
    pub message: String,
}

impl IntentError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for IntentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Requested response delivery. The broker always records the stream; this
/// states what the client intends to do with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ResponseMode {
    #[default]
    Stream,
    Final,
}

/// Explicit model selection. When present the Registry-issued target must
/// match exactly; there is no fallback or substitution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSelection {
    pub provider_id: String,
    pub remote_model_id: String,
}

/// Explicit, bounded limits. They can only tighten broker/Registry limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentLimits {
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
}

/// The versioned user intent. Initially only `model-only`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NexusIntentV1 {
    pub schema_version: u32,
    /// Caller-chosen correlation id (bounded, charset-restricted).
    pub request_id: String,
    /// Stable key: resubmitting the same key with the same payload returns
    /// the same run and never a second billable attempt.
    pub idempotency_key: String,
    /// Only `"model-only"` is implemented.
    pub intent_type: String,
    /// User text (bounded). The only content the model ever sees.
    pub content: String,
    #[serde(default)]
    pub model: Option<ModelSelection>,
    #[serde(default)]
    pub limits: IntentLimits,
    #[serde(default)]
    pub response_mode: ResponseMode,
    /// Display-only label. Never used for authorization.
    #[serde(default)]
    pub client_label: Option<String>,
}

fn ident_ok(s: &str, min: usize, max: usize) -> bool {
    s.len() >= min
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn bounded_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/' | b':'))
}

impl NexusIntentV1 {
    /// Parse and validate untrusted JSON. Never panics; every refusal is a
    /// typed [`IntentError`].
    pub fn parse(value: &serde_json::Value) -> Result<Self, IntentError> {
        let intent: Self = serde_json::from_value(value.clone()).map_err(|e| {
            IntentError::new(
                "bad-intent",
                format!("intent does not match NexusIntentV1: {e}"),
            )
        })?;
        intent.validate()?;
        Ok(intent)
    }

    pub fn validate(&self) -> Result<(), IntentError> {
        if self.schema_version != INTENT_SCHEMA_VERSION {
            return Err(IntentError::new(
                "unsupported-schema",
                "unsupported NexusIntent schemaVersion",
            ));
        }
        if self.intent_type != "model-only" {
            return Err(IntentError::new(
                "unsupported-intent-type",
                "only the model-only intent type is implemented",
            ));
        }
        if !ident_ok(&self.request_id, 1, 128) {
            return Err(IntentError::new(
                "bad-intent",
                "requestId must be 1..128 chars of [A-Za-z0-9._:-]",
            ));
        }
        if !ident_ok(&self.idempotency_key, 8, 128) {
            return Err(IntentError::new(
                "bad-intent",
                "idempotencyKey must be 8..128 chars of [A-Za-z0-9._:-]",
            ));
        }
        if self.content.trim().is_empty() {
            return Err(IntentError::new("bad-intent", "content must not be empty"));
        }
        if self.content.len() > MAX_INTENT_CONTENT_BYTES {
            return Err(IntentError::new(
                "content-too-large",
                format!("content exceeds {MAX_INTENT_CONTENT_BYTES} bytes"),
            ));
        }
        if self.content.contains('\0') {
            return Err(IntentError::new("bad-intent", "content contains NUL"));
        }
        if let Some(m) = &self.model {
            if !bounded_id(&m.provider_id) || !bounded_id(&m.remote_model_id) {
                return Err(IntentError::new(
                    "bad-intent",
                    "model selection ids are empty, too long or carry forbidden characters",
                ));
            }
        }
        if let Some(n) = self.limits.max_output_tokens {
            if n == 0 || n > MAX_INTENT_OUTPUT_TOKENS {
                return Err(IntentError::new(
                    "bad-intent",
                    "limits.maxOutputTokens is out of range",
                ));
            }
        }
        if let Some(l) = &self.client_label {
            if l.len() > 64 || l.chars().any(|c| c.is_control()) {
                return Err(IntentError::new("bad-intent", "clientLabel is invalid"));
            }
        }
        Ok(())
    }

    /// Digest of everything that determines the billable request. Used for
    /// idempotency conflict detection (same key, different payload).
    pub fn payload_digest(&self) -> String {
        let v = serde_json::json!({
            "intentType": self.intent_type,
            "content": self.content,
            "model": self.model,
            "limits": self.limits,
        });
        crate::sha256_hex(&crate::canonical_json(&v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "requestId": "req-1",
            "idempotencyKey": "idem-0001",
            "intentType": "model-only",
            "content": "hello",
        })
    }

    #[test]
    fn minimal_intent_parses_with_defaults() {
        let i = NexusIntentV1::parse(&base()).expect("valid");
        assert_eq!(i.response_mode, ResponseMode::Stream);
        assert!(i.model.is_none());
    }

    #[test]
    fn unknown_intent_types_and_schema_are_rejected() {
        for t in ["project-design", "tool-run", "shell", "write", ""] {
            let mut v = base();
            v["intentType"] = serde_json::json!(t);
            let e = NexusIntentV1::parse(&v).expect_err(t);
            assert_eq!(e.code, "unsupported-intent-type", "{t}");
        }
        let mut v = base();
        v["schemaVersion"] = serde_json::json!(2);
        assert_eq!(
            NexusIntentV1::parse(&v).unwrap_err().code,
            "unsupported-schema"
        );
    }

    #[test]
    fn authority_bearing_fields_cannot_be_smuggled() {
        for k in [
            "grant",
            "cap",
            "issuerCap",
            "apiKey",
            "token",
            "providerUrl",
            "endpoint",
            "tools",
            "workspace",
            "approval",
            "writeScope",
            "processScope",
            "command",
            "clientId",
            "leaseEpoch",
            "extension",
            "resolution",
        ] {
            let mut v = base();
            v[k] = serde_json::json!("x");
            let e = NexusIntentV1::parse(&v).expect_err(k);
            assert_eq!(e.code, "bad-intent", "{k}");
        }
        let mut v = base();
        v["model"] = serde_json::json!({"providerId":"p","remoteModelId":"m","url":"http://x"});
        assert!(NexusIntentV1::parse(&v).is_err());
    }

    #[test]
    fn bounds_are_enforced() {
        let mut v = base();
        v["content"] = serde_json::json!("x".repeat(MAX_INTENT_CONTENT_BYTES + 1));
        assert_eq!(
            NexusIntentV1::parse(&v).unwrap_err().code,
            "content-too-large"
        );
        for bad in [
            ("idempotencyKey", "short"),
            ("idempotencyKey", "has space in it"),
            ("requestId", ""),
            ("content", "   "),
        ] {
            let mut v = base();
            v[bad.0] = serde_json::json!(bad.1);
            assert!(NexusIntentV1::parse(&v).is_err(), "{bad:?}");
        }
        let mut v = base();
        v["limits"] = serde_json::json!({"maxOutputTokens": 0});
        assert!(NexusIntentV1::parse(&v).is_err());
    }

    #[test]
    fn payload_digest_binds_billable_content_not_correlation() {
        let a = NexusIntentV1::parse(&base()).unwrap();
        let mut v = base();
        v["requestId"] = serde_json::json!("req-other");
        v["clientLabel"] = serde_json::json!("ui");
        let b = NexusIntentV1::parse(&v).unwrap();
        assert_eq!(a.payload_digest(), b.payload_digest());
        let mut v = base();
        v["content"] = serde_json::json!("hello!");
        assert_ne!(
            a.payload_digest(),
            NexusIntentV1::parse(&v).unwrap().payload_digest()
        );
    }
}
