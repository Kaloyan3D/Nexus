//! Autonomous recovery for the interactive profile (autonomy-first refactor).
//!
//! A provider turn that ends without a usable answer is NOT the end of the task. The
//! request is a pure function of the durable conversation (every tool result already
//! executed and receipted), so asking again can never repeat a local effect: it only
//! costs another provider call. What must never be repeated is a local tool execution
//! whose outcome is unknown; that is handled where tools run, not here.
//!
//! Policy: bounded exponential backoff, a circuit breaker for a persistent outage, and
//! a harder context squeeze when the failure pattern looks like context overflow.

use std::time::Duration;

/// Failures in a row after which the provider is declared unavailable (about ten minutes
/// of backoff). Progress made so far stays in the working copy and the transcript.
pub const BREAKER_AFTER: u32 = 14;
pub const BACKOFF_BASE: Duration = Duration::from_secs(2);
pub const BACKOFF_CAP: Duration = Duration::from_secs(60);

/// Codes for which asking the provider again is the right response.
pub fn is_recoverable(code: &str) -> bool {
    matches!(
        code,
        "send-uncertain"
            | "stream-partial"
            | "timeout"
            | "disconnected"
            | "provider-failed"
            | "sse-malformed"
            | "tool-call-incomplete"
            | "transport-refused"
            | "tls-failed"
            | "payload-too-large"
            | "continuation-required"
    )
}

/// Wait before retry number `n` (1-based) of the current outage.
pub fn backoff(n: u32) -> Duration {
    let secs = BACKOFF_BASE
        .as_secs()
        .saturating_mul(1u64 << n.saturating_sub(1).min(10));
    Duration::from_secs(secs).min(BACKOFF_CAP)
}

/// Fraction of the normal context budget to use after `n` consecutive failures: the
/// second and later failures may be context overflow, so the history is squeezed harder.
pub fn context_scale(n: u32) -> f64 {
    match n {
        0 | 1 => 1.0,
        2 => 0.7,
        3 => 0.5,
        _ => 0.35,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_provider_codes_recover_and_authority_codes_do_not() {
        for c in [
            "send-uncertain",
            "stream-partial",
            "timeout",
            "disconnected",
            "provider-failed",
            "tool-call-incomplete",
        ] {
            assert!(is_recoverable(c), "{c}");
        }
        for c in [
            "cancelled",
            "credential-revoked",
            "destination-refused",
            "endpoint-mismatch",
            "redirect-refused",
            "attestation-failed",
            "wrong-target",
            "duplicate-attempt",
        ] {
            assert!(!is_recoverable(c), "{c}");
        }
    }

    #[test]
    fn backoff_grows_then_caps_and_context_squeezes() {
        assert_eq!(backoff(1), Duration::from_secs(2));
        assert_eq!(backoff(2), Duration::from_secs(4));
        assert_eq!(backoff(5), Duration::from_secs(32));
        assert_eq!(backoff(6), BACKOFF_CAP);
        assert_eq!(backoff(40), BACKOFF_CAP);
        assert!(context_scale(1) > context_scale(3));
    }
}
