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
/// The loop limits are meaningful only for `repo-inspect` (A5.5) and are
/// refused on `model-only`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentLimits {
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    /// Maximum provider calls (model turns) in one run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    /// Maximum tool executions in one run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<u32>,
    /// Maximum total tool-result bytes returned to the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_result_bytes: Option<u64>,
    /// Maximum wall-clock seconds for the whole run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_runtime_secs: Option<u64>,
}

impl IntentLimits {
    fn has_loop_limits(&self) -> bool {
        self.max_turns.is_some()
            || self.max_tool_calls.is_some()
            || self.max_tool_result_bytes.is_some()
            || self.max_runtime_secs.is_some()
    }
}

/// Intent type of the plain text-only inference (A5.1).
pub const INTENT_MODEL_ONLY: &str = "model-only";
/// Intent type of the read-only agentic repository inspection (A5.5).
pub const INTENT_REPO_INSPECT: &str = "repo-inspect";

/// Hard ceilings a client may request for the loop (policy may be lower).
pub const MAX_INSPECT_TURNS: u32 = 12;
pub const MAX_INSPECT_TOOL_CALLS: u32 = 40;
pub const MAX_INSPECT_RESULT_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_INSPECT_RUNTIME_SECS: u64 = 1800;

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
    /// `"model-only"` (text-only) or `"repo-inspect"` (read-only tools).
    pub intent_type: String,
    /// User text (bounded). The only content the model ever sees.
    pub content: String,
    #[serde(default)]
    pub model: Option<ModelSelection>,
    /// Server-managed workspace identity (never a path). Required for
    /// `repo-inspect`; refused for every other intent type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
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
        if self.intent_type != INTENT_MODEL_ONLY && self.intent_type != INTENT_REPO_INSPECT {
            return Err(IntentError::new(
                "unsupported-intent-type",
                "only the model-only and repo-inspect intent types are implemented",
            ));
        }
        let inspect = self.intent_type == INTENT_REPO_INSPECT;
        match (&self.workspace_id, inspect) {
            (None, true) => {
                return Err(IntentError::new(
                    "bad-intent",
                    "repo-inspect requires an explicit workspaceId",
                ))
            }
            (Some(_), false) => return Err(IntentError::new(
                "bad-intent",
                "workspaceId is only valid for repo-inspect; model-only never touches a workspace",
            )),
            (Some(w), true) if !ident_ok(w, 1, 64) => {
                return Err(IntentError::new(
                    "bad-intent",
                    "workspaceId must be 1..64 chars of [A-Za-z0-9._:-] (an identity, not a path)",
                ))
            }
            _ => {}
        }
        if !inspect && self.limits.has_loop_limits() {
            return Err(IntentError::new(
                "bad-intent",
                "loop limits are only valid for repo-inspect",
            ));
        }
        for (name, v, max) in [
            (
                "maxTurns",
                self.limits.max_turns.map(u64::from),
                u64::from(MAX_INSPECT_TURNS),
            ),
            (
                "maxToolCalls",
                self.limits.max_tool_calls.map(u64::from),
                u64::from(MAX_INSPECT_TOOL_CALLS),
            ),
            (
                "maxToolResultBytes",
                self.limits.max_tool_result_bytes,
                MAX_INSPECT_RESULT_BYTES,
            ),
            (
                "maxRuntimeSecs",
                self.limits.max_runtime_secs,
                MAX_INSPECT_RUNTIME_SECS,
            ),
        ] {
            if let Some(n) = v {
                if n == 0 || n > max {
                    return Err(IntentError::new(
                        "bad-intent",
                        format!("limits.{name} is out of range (1..={max})"),
                    ));
                }
            }
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
        let mut v = serde_json::json!({
            "intentType": self.intent_type,
            "content": self.content,
            "model": self.model,
            "limits": self.limits,
        });
        // Only repo-inspect carries a workspace: model-only digests are
        // byte-identical to the pre-A5.5 definition.
        if let Some(w) = &self.workspace_id {
            v["workspaceId"] = serde_json::json!(w);
        }
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
    fn repo_inspect_requires_a_workspace_identity_and_model_only_forbids_one() {
        let mut v = base();
        v["intentType"] = serde_json::json!("repo-inspect");
        assert_eq!(NexusIntentV1::parse(&v).unwrap_err().code, "bad-intent");
        v["workspaceId"] = serde_json::json!("demo-repo");
        let i = NexusIntentV1::parse(&v).expect("valid repo-inspect");
        assert_eq!(i.workspace_id.as_deref(), Some("demo-repo"));
        // an identity, never a path
        for bad in ["/etc", "../x", "a/b", "", "with space", &"w".repeat(65)] {
            v["workspaceId"] = serde_json::json!(bad);
            assert!(NexusIntentV1::parse(&v).is_err(), "{bad}");
        }
        // model-only never carries a workspace or loop limits
        let mut m = base();
        m["workspaceId"] = serde_json::json!("demo-repo");
        assert!(NexusIntentV1::parse(&m).is_err());
        let mut m = base();
        m["limits"] = serde_json::json!({"maxTurns": 3});
        assert!(NexusIntentV1::parse(&m).is_err());
    }

    #[test]
    fn loop_limits_are_bounded_and_authority_fields_still_rejected_for_repo_inspect() {
        let mut v = base();
        v["intentType"] = serde_json::json!("repo-inspect");
        v["workspaceId"] = serde_json::json!("demo");
        v["limits"] = serde_json::json!({"maxTurns": 5, "maxToolCalls": 10, "maxToolResultBytes": 65536, "maxRuntimeSecs": 120});
        assert!(NexusIntentV1::parse(&v).is_ok());
        for (k, bad) in [
            ("maxTurns", 0u64),
            ("maxTurns", 13),
            ("maxToolCalls", 41),
            ("maxToolResultBytes", 3 << 20),
            ("maxRuntimeSecs", 0),
        ] {
            let mut w = v.clone();
            w["limits"][k] = serde_json::json!(bad);
            assert!(NexusIntentV1::parse(&w).is_err(), "{k}={bad}");
        }
        for k in [
            "workspace",
            "root",
            "path",
            "tools",
            "toolPolicy",
            "allowWrite",
            "cwd",
            "env",
            "systemPrompt",
            "provider",
        ] {
            let mut w = v.clone();
            w[k] = serde_json::json!("x");
            assert_eq!(
                NexusIntentV1::parse(&w).unwrap_err().code,
                "bad-intent",
                "{k}"
            );
        }
        let mut w = v.clone();
        w["limits"]["allowedTools"] = serde_json::json!(["fs.write"]);
        assert!(NexusIntentV1::parse(&w).is_err());
        let mut w = v.clone();
        w["intentType"] = serde_json::json!("repo-edit");
        assert_eq!(
            NexusIntentV1::parse(&w).unwrap_err().code,
            "unsupported-intent-type"
        );
    }

    #[test]
    fn model_only_digest_is_unchanged_and_workspace_changes_the_inspect_digest() {
        let a = NexusIntentV1::parse(&base()).unwrap();
        let legacy = crate::sha256_hex(&crate::canonical_json(&serde_json::json!({
            "intentType": "model-only", "content": "hello", "model": null,
            "limits": {"maxOutputTokens": null},
        })));
        assert_eq!(
            a.payload_digest(),
            legacy,
            "A5.1-A5.4 digests must not move"
        );
        let mut v = base();
        v["intentType"] = serde_json::json!("repo-inspect");
        v["workspaceId"] = serde_json::json!("one");
        let one = NexusIntentV1::parse(&v).unwrap().payload_digest();
        v["workspaceId"] = serde_json::json!("two");
        assert_ne!(one, NexusIntentV1::parse(&v).unwrap().payload_digest());
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
