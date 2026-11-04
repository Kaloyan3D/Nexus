//! Truthful, redacted failure classification (A2.2, Phase 4.7/5).
//!
//! Every constructor redacts credential-shaped material: no bearer token,
//! API key, JWT, or `sk-` secret ever reaches a message, log, or snapshot.
//! Classification is exact: an unknown provider outcome is `send-uncertain`
//! or `stream-partial`, never silently retried (see `stream.rs`).

use std::fmt;

/// Stable wire code for every model-transport failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ModelErrorCode {
    /// Prepared bytes do not match the pinned target (endpoint, model,
    /// route, reasoning, or session drifted after pin creation).
    WrongTarget,
    /// The Registry target lacks authoritative endpoint, billing,
    /// capability, context, or session metadata: not executable.
    TargetIncomplete,
    /// Dispatch was attempted without a verified attestation, or the
    /// attestation no longer matches the prepared bytes.
    AttestationFailed,
    /// The request was refused before any byte was sent (binding mismatch,
    /// revoked credential, oversize payload, non-streaming request, ...).
    TransportRefused,
    /// Bytes may have been sent but no provider event was observed: the
    /// outcome is UNKNOWN and must not trigger another call.
    SendUncertain,
    /// The stream broke after at least one event: partial output is
    /// returned for inspection, never executed, never retried.
    StreamPartial,
    /// Cancellation was requested mid-stream; the attempt is NOT terminal.
    Cancelled,
    /// The connection dropped. Before any send this stays `not_sent`;
    /// after a send it becomes `send-uncertain`/`stream-partial`.
    Disconnected,
    /// An event, payload, or assembled argument exceeded its bound.
    PayloadTooLarge,
    /// An SSE frame was incomplete or malformed.
    SseMalformed,
    /// The provider answered with a redirect. Redirects are never followed;
    /// following one would abandon the pinned endpoint.
    RedirectRefused,
    /// The transport is bound to a different endpoint origin than the
    /// prepared request (proxy/destination change refused before connect).
    EndpointMismatch,
    /// The credential was revoked before or during dispatch.
    CredentialRevoked,
    /// The same attempt id was presented with a different request digest
    /// (replay), or a second send was attempted for an uncertain outcome.
    DuplicateAttempt,
    /// Resuming an uncertain provider call needs a verified continuation
    /// the Registry has not issued: reserved, never synthesized here.
    ContinuationRequired,
    /// A per-read deadline expired.
    Timeout,
    /// The provider reported its own terminal failure (message redacted).
    ProviderFailed,
    /// TLS could not be established or verified (untrusted/expired/wrong
    /// name certificate, protocol failure). Raised only BEFORE any request
    /// byte or credential is written.
    TlsFailed,
    /// The destination (or any address it resolved to) violates the egress
    /// policy. Raised before any socket is opened.
    DestinationRefused,
}

impl ModelErrorCode {
    /// Stable kebab-case wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WrongTarget => "wrong-target",
            Self::TargetIncomplete => "target-incomplete",
            Self::AttestationFailed => "attestation-failed",
            Self::TransportRefused => "transport-refused",
            Self::SendUncertain => "send-uncertain",
            Self::StreamPartial => "stream-partial",
            Self::Cancelled => "cancelled",
            Self::Disconnected => "disconnected",
            Self::PayloadTooLarge => "payload-too-large",
            Self::SseMalformed => "sse-malformed",
            Self::RedirectRefused => "redirect-refused",
            Self::EndpointMismatch => "endpoint-mismatch",
            Self::CredentialRevoked => "credential-revoked",
            Self::DuplicateAttempt => "duplicate-attempt",
            Self::ContinuationRequired => "continuation-required",
            Self::Timeout => "timeout",
            Self::ProviderFailed => "provider-failed",
            Self::TlsFailed => "tls-failed",
            Self::DestinationRefused => "destination-refused",
        }
    }
}

impl fmt::Display for ModelErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Redacted transport error. Construct ONLY via `ModelError::new`, which
/// funnels every message through [`redact`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelError {
    /// Machine-readable classification.
    pub code: ModelErrorCode,
    /// Human-readable, redacted detail (single line, no secrets).
    pub message: String,
}

impl ModelError {
    /// Build a classified error; the message is redacted and flattened to
    /// one line before it is stored.
    pub fn new(code: ModelErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: redact(&message.into()),
        }
    }

    /// The stable wire code string.
    pub fn code_str(&self) -> &'static str {
        self.code.as_str()
    }
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ModelError {}

/// Redact credential-shaped material from arbitrary text.
///
/// Rules (deliberately broad; false positives are acceptable, false
/// negatives are not): `sk-` tokens, `Bearer` values, `api-key`-shaped
/// assignments, JWT-shaped triples, `eyJ` prefixes, and raw newlines are
/// replaced. The output is a single line.
///
/// Tests pin every rule (`secret_redaction_in_every_error_path`).
///
/// Scope boundary: redaction covers transport-generated errors, headers,
/// and logs. Provider CONTENT (deltas, tool arguments) is untrusted data
/// returned verbatim and is never scanned: our credential never travels in
/// request bytes, so reflection of user-typed text is a data problem, not
/// a credential leak through this layer.
pub fn redact(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &raw[i..];
        // Bearer <token>
        if rest.len() >= 7 && (rest.starts_with("Bearer ") || rest.starts_with("bearer ")) {
            out.push_str(&rest[..7]);
            out.push_str("[REDACTED]");
            i += 7;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            continue;
        }
        // sk-... secrets (OpenAI-style and generic).
        if rest.starts_with("sk-") {
            out.push_str("[REDACTED]");
            i += 3;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric()
                    || bytes[i] == b'-'
                    || bytes[i] == b'_'
                    || bytes[i] == b'.')
            {
                i += 1;
            }
            continue;
        }
        // api-key / apikey assignments: api_key=VALUE, "apiKey": "VALUE".
        if matches_prefix_ci(rest, "api-key")
            || matches_prefix_ci(rest, "api_key")
            || matches_prefix_ci(rest, "apikey")
        {
            let mut j = i;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-' || bytes[j] == b'_')
            {
                j += 1;
            }
            // Skip separators, quotes, colons, equals.
            let mut k = j;
            while k < bytes.len()
                && (bytes[k] == b'='
                    || bytes[k] == b':'
                    || bytes[k] == b'"'
                    || bytes[k] == b'\''
                    || bytes[k].is_ascii_whitespace())
            {
                k += 1;
            }
            if k > j {
                out.push_str(&raw[i..j]);
                out.push_str("=[REDACTED]");
                while k < bytes.len()
                    && !bytes[k].is_ascii_whitespace()
                    && bytes[k] != b'"'
                    && bytes[k] != b'\''
                    && bytes[k] != b','
                    && bytes[k] != b'}'
                {
                    k += 1;
                }
                i = k;
                continue;
            }
        }
        // JWT-shaped triples or eyJ-prefixed blobs.
        if rest.starts_with("eyJ") || looks_like_jwt(rest) {
            out.push_str("[REDACTED-JWT]");
            while i < bytes.len()
                && !bytes[i].is_ascii_whitespace()
                && bytes[i] != b'"'
                && bytes[i] != b'\''
                && bytes[i] != b','
            {
                i += 1;
            }
            continue;
        }
        // `i` always rests on a char boundary here (every skip loop stops
        // at an ASCII delimiter and every step advances a full char), but a
        // redactor must never panic: fall back to one raw byte on violation.
        let c = raw[i..].chars().next().unwrap_or('\u{FFFD}');
        if c == '\n' || c == '\r' {
            out.push(' ');
        } else if c.is_control() {
            // Drop other control bytes: they carry no diagnostic value.
        } else {
            out.push(c);
        }
        i += c.len_utf8();
    }
    out
}

fn matches_prefix_ci(s: &str, pat: &str) -> bool {
    s.len() >= pat.len() && s[..pat.len()].eq_ignore_ascii_case(pat)
}

fn looks_like_jwt(s: &str) -> bool {
    let mut dots = 0;
    let mut len = 0;
    for b in s.bytes() {
        if b == b'.' {
            dots += 1;
        } else if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            len += 1;
        } else {
            break;
        }
        if len + dots > 500 {
            break;
        }
    }
    dots == 2 && len > 20
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_rules_hold() {
        let e = ModelError::new(
            ModelErrorCode::TransportRefused,
            "auth Bearer abc123 failed with sk-live-456 and api_key=zzz",
        );
        assert!(!e.message.contains("abc123"), "{e}");
        assert!(!e.message.contains("sk-live-456"), "{e}");
        assert!(!e.message.contains("zzz"), "{e}");
        assert!(e.message.contains("[REDACTED]"), "{e}");
        let j = ModelError::new(ModelErrorCode::ProviderFailed, "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c boom");
        assert!(
            !j.message
                .contains("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"),
            "{j}"
        );
        let nl = ModelError::new(ModelErrorCode::SseMalformed, "line1\nline2\rline3");
        assert!(!nl.message.contains('\n'), "{nl}");
    }
}
