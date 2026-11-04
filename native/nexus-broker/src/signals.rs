//! EM-04B: the Core side of the Muse reasoning-signals tool (`muse_update_reasoning_state`).
//!
//! The tool is broker-handled CONTROL-PLANE input. It has no Kernel tool id and no effect outside
//! the experimental engine's own state. This module is what the Core does BEFORE the engine sees a
//! call:
//! * a strict, closed parse with the historical rules and error codes of
//!   `config/Muse-ReasoningSignals.cjs` `validateReasoningSignal`;
//! * a size bound;
//! * the trusted dispatch identity: the generation, attempt and call id come from the Core, never
//!   from the model;
//! * the historical acknowledgement text.
//!
//! The engine then applies the signal through the historical `applyReasoningSignal` (bridge),
//! which validates it again.
//!
//! A signal is a model-authored CLAIM about cognition (phase, established findings, failure
//! events, conflicting evidence). It is never evidence of execution: those are the Core's trusted
//! activity observations. It never names an effort, counter, identity, provider or model.

use serde_json::Value;

/// The historical tool name.
pub const TOOL: &str = nexus_model::repo_tools::MUSE_SIGNALS_TOOL;
/// Version of this argument contract (the historical nine-field schema).
pub const SIGNALS_SCHEMA_VERSION: u32 = 1;
/// Largest accepted argument document (the nine fields fit in < 300 bytes).
pub const MAX_SIGNAL_ARGS_BYTES: usize = 1024;

/// Fields the model may send (historical `SIGNAL_FIELDS`, in their canonical order).
pub const SIGNAL_FIELDS: [&str; 9] = [
    "phase",
    "markRootCauseEstablished",
    "invalidateRootCause",
    "markSolutionEstablished",
    "invalidateSolution",
    "recordHypothesisFailure",
    "recordImplementationFailure",
    "conflictingEvidence",
    "resolveConflictingEvidence",
];

/// Explicitly forbidden fields (historical `FORBIDDEN_SIGNAL_FIELDS`): effort selectors, raw
/// counters and state, identity and provider metadata.
pub const FORBIDDEN_SIGNAL_FIELDS: [&str; 21] = [
    "effort",
    "reasoningEffort",
    "reasoning_effort",
    "medium",
    "high",
    "xhigh",
    "max",
    "failedHypotheses",
    "failedImplementationAttempts",
    "currentEffort",
    "lastResolution",
    "state",
    "requestMax",
    "workspace",
    "taskId",
    "taskInstanceId",
    "sessionId",
    "provider",
    "model",
    "capabilities",
    "routingState",
];

/// A refused signal (nothing is recorded; the model receives the reason as a tool error).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalRefusal {
    /// The historical code (`invalid-signal`, `forbidden-field`, `unknown-field`,
    /// `invalid-phase`, `invalid-field`) or `signal-oversized`.
    pub code: &'static str,
    pub message: String,
}

fn refuse(code: &'static str, message: impl Into<String>) -> SignalRefusal {
    SignalRefusal {
        code,
        message: message.into(),
    }
}

/// Strict validation with the historical rules: an object; forbidden fields first, then unknown
/// fields; `phase` a string naming a known phase (trimmed, case-insensitive); every event field
/// `true`, `false` (a no-op) or absent.
pub fn validate(args: &Value, raw_len: usize) -> Result<(), SignalRefusal> {
    if raw_len > MAX_SIGNAL_ARGS_BYTES {
        return Err(refuse(
            "signal-oversized",
            format!("the signal exceeds {MAX_SIGNAL_ARGS_BYTES} bytes"),
        ));
    }
    let Some(o) = args.as_object() else {
        return Err(refuse("invalid-signal", "signal must be an object."));
    };
    // Forbidden fields are checked over ALL keys first: the provider's arguments arrive as a
    // key-ordered map, so the historical "first key in insertion order" cannot be reproduced; both
    // refuse, and the forbidden code is the more specific one (parity S-2).
    for k in o.keys() {
        if FORBIDDEN_SIGNAL_FIELDS.contains(&k.as_str()) {
            return Err(refuse(
                "forbidden-field",
                format!("field {} cannot be set by the model.", quoted(k)),
            ));
        }
    }
    for k in o.keys() {
        if !SIGNAL_FIELDS.contains(&k.as_str()) {
            return Err(refuse(
                "unknown-field",
                format!("unknown field {}.", quoted(k)),
            ));
        }
    }
    if let Some(p) = o.get("phase") {
        let Some(p) = p.as_str() else {
            return Err(refuse("invalid-phase", "phase must be a string."));
        };
        if normalized_phase(p).is_none() {
            return Err(refuse(
                "invalid-phase",
                format!("unknown phase {}.", quoted(p)),
            ));
        }
    }
    for f in &SIGNAL_FIELDS[1..] {
        match o.get(*f) {
            None | Some(Value::Bool(_)) => {}
            Some(_) => {
                return Err(refuse(
                    "invalid-field",
                    format!("field {f} must be true when present."),
                ))
            }
        }
    }
    Ok(())
}

/// The historical phase normalization (`trim().toLowerCase()`), `None` if unknown. `trim` uses
/// ECMAScript's WhiteSpace + LineTerminator set exactly (it differs from Rust's `char::is_whitespace`:
/// U+FEFF is trimmed, U+0085 is not).
pub fn normalized_phase(p: &str) -> Option<&'static str> {
    let js_space = |c: char| {
        matches!(
            c,
            '\u{0009}'
                | '\u{000A}'
                | '\u{000B}'
                | '\u{000C}'
                | '\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    };
    let t = p.trim_matches(js_space).to_lowercase();
    nexus_model::repo_tools::MUSE_PHASES
        .iter()
        .copied()
        .find(|x| *x == t)
}

fn quoted(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// The historical `stableSignalHash`: SHA-256 of the JSON of the present fields in canonical
/// order, first 32 hex characters.
pub fn stable_hash(signal: &Value) -> String {
    let mut parts = Vec::new();
    for f in SIGNAL_FIELDS {
        if let Some(v) = signal.get(f) {
            parts.push(format!("{}:{}", quoted(f), v));
        }
    }
    let canonical = format!("{{{}}}", parts.join(","));
    nexus_contracts::sha256_hex(&canonical)[..32].to_owned()
}

/// The trusted dispatch identity of one call: the Core's generation, attempt and call id with
/// the signal's hash (the historical key is `rootCallId|callId|hash`). Bounded, so the historical
/// processed-id window (100) stays small in the engine state.
pub fn dispatch_key(generation: &str, attempt: u32, call_id: &str, signal: &Value) -> String {
    let id = nexus_contracts::sha256_hex(&format!(
        "{generation}\n{attempt}\n{call_id}\n{}",
        stable_hash(signal)
    ));
    format!("n1:{}", &id[..29])
}

/// The historical model-facing acknowledgement text (`renderAck`): state labels and counters,
/// never an effort.
pub fn render_ack(value: &Value) -> String {
    if !value.is_object() {
        return "Reasoning state signal recorded.".into();
    }
    let s = |k: &str| match &value[k] {
        Value::Null => "undefined".to_owned(),
        Value::String(x) => x.clone(),
        other => other.to_string(),
    };
    let mut lines = vec![
        format!(
            "Reasoning state updated{}:",
            if value["duplicate"] == true {
                " (duplicate delivery ignored)"
            } else {
                ""
            }
        ),
        format!("phase: {}", s("phase")),
        format!("rootCauseEstablished: {}", s("rootCauseEstablished")),
        format!("solutionEstablished: {}", s("solutionEstablished")),
        format!("failedHypotheses: {}", s("failedHypotheses")),
        format!(
            "failedImplementationAttempts: {}",
            s("failedImplementationAttempts")
        ),
        format!("totalFailedHypotheses: {}", s("totalFailedHypotheses")),
        format!(
            "totalFailedImplementationAttempts: {}",
            s("totalFailedImplementationAttempts")
        ),
        format!("conflictingEvidence: {}", s("conflictingEvidence")),
        format!(
            "activityState: {}",
            if value["activityState"].is_null() {
                "none".to_owned()
            } else {
                s("activityState")
            }
        ),
    ];
    if let Some(a) = value["applied"].as_array() {
        let names: Vec<String> = a
            .iter()
            .map(|x| x.as_str().unwrap_or("").to_owned())
            .collect();
        lines.push(format!(
            "applied: {}",
            if names.is_empty() {
                "(none)".to_owned()
            } else {
                names.join(", ")
            }
        ));
    }
    lines.join("\n")
}

/// A short, redaction-safe summary of a signal for the run's activity timeline: the field names
/// it sets (never values beyond the phase name).
pub fn summary(signal: &Value) -> String {
    let mut out = Vec::new();
    for f in SIGNAL_FIELDS {
        match signal.get(f) {
            Some(Value::String(p)) => {
                out.push(format!("phase={}", normalized_phase(p).unwrap_or("?")))
            }
            Some(Value::Bool(true)) => out.push(f.to_owned()),
            _ => {}
        }
    }
    if out.is_empty() {
        "(no change)".into()
    } else {
        out.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_historical_rules_and_codes_apply_in_their_order() {
        let ok = |v: Value| validate(&v, v.to_string().len());
        assert!(ok(json!({})).is_ok());
        assert!(ok(json!({"phase": " Diagnose "})).is_ok());
        assert!(ok(json!({"recordHypothesisFailure": true, "conflictingEvidence": false})).is_ok());
        let code = |v: Value| ok(v).unwrap_err().code;
        assert_eq!(code(json!([1])), "invalid-signal");
        assert_eq!(code(json!("phase")), "invalid-signal");
        assert_eq!(code(json!({"effort": "max"})), "forbidden-field");
        assert_eq!(
            code(json!({"phase": "verify", "xhigh": true})),
            "forbidden-field"
        );
        assert_eq!(code(json!({"taskInstanceId": "t"})), "forbidden-field");
        assert_eq!(code(json!({"bogus": true})), "unknown-field");
        assert_eq!(code(json!({"phase": 3})), "invalid-phase");
        assert_eq!(code(json!({"phase": "hack"})), "invalid-phase");
        assert_eq!(code(json!({"recordHypothesisFailure": 1})), "invalid-field");
        assert_eq!(
            code(json!({"markSolutionEstablished": "true"})),
            "invalid-field"
        );
        let big = json!({"phase": "x".repeat(2_000)});
        assert_eq!(
            validate(&big, big.to_string().len()).unwrap_err().code,
            "signal-oversized"
        );
    }

    #[test]
    fn the_dispatch_identity_is_trusted_bounded_and_content_sensitive() {
        let s = json!({"phase": "verify"});
        let k = dispatch_key("task-a", 3, "call_1", &s);
        assert_eq!(k.len(), 32);
        assert_eq!(k, dispatch_key("task-a", 3, "call_1", &s));
        assert_ne!(
            k,
            dispatch_key("task-b", 3, "call_1", &s),
            "another generation"
        );
        assert_ne!(
            k,
            dispatch_key("task-a", 4, "call_1", &s),
            "another attempt"
        );
        assert_ne!(k, dispatch_key("task-a", 3, "call_2", &s), "another call");
        assert_ne!(
            k,
            dispatch_key("task-a", 3, "call_1", &json!({"phase": "review"})),
            "another signal"
        );
    }

    #[test]
    fn the_summary_never_carries_free_text() {
        assert_eq!(
            summary(
                &json!({"phase": "Verify", "recordHypothesisFailure": true, "conflictingEvidence": false})
            ),
            "phase=verify recordHypothesisFailure"
        );
        assert_eq!(summary(&json!({})), "(no change)");
    }
}
