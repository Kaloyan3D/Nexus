//! Provider transport boundary (A2.2, Phase 3/4).
//!
//! Transport selection decision (recorded here and in A2.2-EVIDENCE.md):
//!
//! * Candidate A (`genai` 0.6/0.7-beta, jeremychone multi-provider SDK) was REJECTED:
//!   verified multi-provider scope (openai incl. openai_resp Responses, anthropic, opencode_go,
//!   custom endpoints) but automatic model-to-adapter resolution with Ollama fallback:
//!   a second model router our contract forbids; no pre-send serialization proof (typed builders,
//!   pub(crate) tap only); endpoints SDK-resolved; redirects followed by reqwest default; first-class proxy; no x-opencode-session/billing semantics.
//! * Candidate B (minimal direct Responses-compatible HTTP/SSE transport)
//!   was CHOSEN: every byte on the wire derives from the attested
//!   preparation, the endpoint origin/path/method/headers are asserted
//!   before connect, redirects are refused, retries are absent, and the
//!   whole path runs offline against `testkit` fixtures.
//!
//! Security contract enforced by every implementation:
//!
//! * `send()` takes ONLY an [`AttestedPreparedModelRequest`]: unattested
//!   bytes cannot reach the wire (unattested types do not compile here).
//! * The credential travels as a separate [`Credential`] handle. It is
//!   injected into exactly one `authorization` header at send time, never
//!   serialized into request bytes, logs, snapshots, or errors.
//! * The [`TransportBinding`] pins the expected endpoint origin. A prepared
//!   request for any other origin is refused BEFORE connect (proxy or
//!   destination changes cannot redirect the call).
//! * Redirects (3xx) are never followed. There is deliberately NO proxy
//!   code path (mirroring Registry `pinned-transport.cjs`).
//! * No automatic retry exists anywhere: potentially billable requests are
//!   sent at most once per attempt; unknown outcomes surface as
//!   `send-uncertain` / `stream-partial` via `stream.rs`.

use crate::error::{redact, ModelError, ModelErrorCode};
use crate::prepare::AttestedPreparedModelRequest;
use crate::sse::{parse_sse_body, parse_sse_body_complete_prefix, ModelEvent};
use crate::stream::CancellationToken;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

/// Default bound on SSE frames per response.
pub const DEFAULT_MAX_EVENTS: usize = 1024;
/// Default bound on assembled text+reasoning bytes (256 KiB).
pub const DEFAULT_MAX_TEXT_BYTES: usize = 256 * 1024;
/// Default bound on assembled tool-argument bytes (64 KiB).
pub const DEFAULT_MAX_ARG_BYTES: usize = 64 * 1024;
/// Default per-read timeout (30 s; tests override to millis).
pub const DEFAULT_READ_TIMEOUT_MS: u64 = 30_000;

/// Transport resource bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportLimits {
    /// Maximum SSE frames per response.
    pub max_events: usize,
    /// Maximum assembled text+reasoning bytes.
    pub max_text_bytes: usize,
    /// Maximum assembled tool-argument bytes.
    pub max_arg_bytes: usize,
    /// Per-read deadline in millis.
    pub read_timeout_ms: u64,
}

impl Default for TransportLimits {
    fn default() -> Self {
        Self {
            max_events: DEFAULT_MAX_EVENTS,
            max_text_bytes: DEFAULT_MAX_TEXT_BYTES,
            max_arg_bytes: DEFAULT_MAX_ARG_BYTES,
            read_timeout_ms: DEFAULT_READ_TIMEOUT_MS,
        }
    }
}

/// Authentication material, kept OUTSIDE request bytes. `Debug` is redacted
/// by construction; the token is injected into one header at send time.
#[derive(Clone)]
pub struct Credential {
    token: String,
    revoked: Arc<AtomicBool>,
}

impl Credential {
    /// Wrap test-only credential material. Production issuance of live
    /// credentials is out of scope: A2.2 is offline and production dispatch
    /// remains disabled (`dispatch_enabled() == false`).
    pub fn test_credential(token: &str) -> Self {
        Self {
            token: token.to_owned(),
            revoked: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Revoke the credential. In-flight dispatch observes this before
    /// sending and (for scripted transports) mid-stream.
    pub fn revoke(&self) {
        self.revoked.store(true, Ordering::SeqCst);
    }

    /// True once revoked.
    pub fn is_revoked(&self) -> bool {
        self.revoked.load(Ordering::SeqCst)
    }

    /// Fail closed when revoked. Checked before any byte is sent.
    pub fn check(&self) -> Result<(), ModelError> {
        if self.is_revoked() {
            return Err(ModelError::new(
                ModelErrorCode::CredentialRevoked,
                "credential was revoked before dispatch",
            ));
        }
        Ok(())
    }

    /// Render the single `authorization` header value. The caller must not
    /// log or persist the result.
    pub fn authorization_value(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credential([REDACTED])")
    }
}

/// Pins the endpoint origin a transport instance may contact. Any prepared
/// request for another origin is refused before connect: unauthorized
/// proxy/redirect destination changes cannot move the call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportBinding {
    /// Exact allowed origin (`scheme://host[:port]`).
    pub origin: String,
}

impl TransportBinding {
    /// Create a binding for one exact origin.
    pub fn new(origin: &str) -> Self {
        Self {
            origin: origin.to_owned(),
        }
    }

    /// Refuse a request bound for any other origin before connecting.
    pub fn check(&self, request_origin: &str) -> Result<(), ModelError> {
        if self.origin != request_origin {
            return Err(ModelError::new(
                ModelErrorCode::EndpointMismatch,
                "transport is bound to a different endpoint origin (refusing proxy/destination change)",
            ));
        }
        Ok(())
    }
}

/// What `send()` observed on the wire.
#[derive(Debug, Clone)]
pub struct SendReport {
    /// True once the request bytes left this process.
    pub bytes_sent: bool,
    /// Normalized provider events in wire order.
    pub events: Vec<ModelEvent>,
    /// Provider finish reason, if the provider completed.
    pub finish_reason: Option<String>,
    /// Raw HTTP status when the transport speaks HTTP.
    pub http_status: Option<u16>,
    /// True when the stream was cut before terminal completion.
    pub truncated: bool,
    /// Redacted transport note (e.g. why a stream truncated). Never secret.
    pub note: Option<String>,
}

/// Transport failure with honest send context. `bytes_sent == false` proves
/// (to TCP-connect granularity) that no byte left this process, so the
/// attempt stays `not_sent`. `bytes_sent == true` means provider-side
/// effects are UNKNOWN: the runtime records uncertainty and never retries.
#[derive(Debug, Clone)]
pub struct TransportError {
    /// Classified, redacted error.
    pub error: ModelError,
    /// True once request bytes may have left this process.
    pub bytes_sent: bool,
}

impl TransportError {
    /// Refusal before any byte was sent (connect failed, gate refused).
    pub fn refused(error: ModelError) -> Self {
        Self {
            error,
            bytes_sent: false,
        }
    }

    /// Failure after bytes may have been sent (outcome unknown).
    pub fn after_send(error: ModelError) -> Self {
        Self {
            error,
            bytes_sent: true,
        }
    }
}

/// Provider transport. Implementations speak to exactly the prepared
/// origin/path, stream Responses-compatible SSE, and report — never retry.
/// `testkit::MockTransport` (scripted) and `HttpSseTransport` (real TCP
/// against `testkit::LocalMockServer`) are the only implementations in
/// A2.2; both are offline. No production dispatch path exists.
pub trait Transport {
    /// Send exactly once and report. `Err` carries [`TransportError`]:
    /// `bytes_sent == false` proves nothing left this process
    /// (`disconnected` before any send); anything after the flush is
    /// uncertain or partial. Cancellation is honored between events.
    /// No implementation retries.
    fn send(
        &self,
        request: &AttestedPreparedModelRequest,
        credential: &Credential,
        cancel: &CancellationToken,
        limits: &TransportLimits,
    ) -> Result<SendReport, TransportError>;
}

/// Minimal direct Responses-compatible HTTP/1.1 + SSE transport over
/// `std::net::TcpStream` (Candidate B). No TLS here: the offline testbed
/// serves loopback `http`; the endpoint validator (`target.rs`) already
/// refuses non-loopback `http`, and production `https` terminates in the
/// future execution-readiness gate — not in A2.2.
///
/// Wire discipline: exact `POST <path> HTTP/1.1` to the prepared origin,
/// fixed header allowlist (`host`, `content-type`, `accept`,
/// `content-length`, `x-opencode-session`, `authorization`,
/// `connection: close`), body = prepared bytes verbatim. 3xx is
/// `redirect-refused` (never followed). Non-200 is a classified transport
/// error. `text/event-stream` bodies stream through `sse.rs` with
/// cancellation checks between reads.
pub struct HttpSseTransport {
    binding: TransportBinding,
}

impl HttpSseTransport {
    /// Create the transport pinned to one exact endpoint origin. The binding
    /// is enforced inside `send()` before connect, so even a direct caller
    /// bypassing the runtime cannot steer this transport at another origin.
    /// (The runtime checks its own binding too: either gate fails closed.)
    pub fn new(binding: TransportBinding) -> Self {
        Self { binding }
    }

    /// Borrow the pinned origin.
    pub fn binding(&self) -> &TransportBinding {
        &self.binding
    }
}

impl Transport for HttpSseTransport {
    fn send(
        &self,
        request: &AttestedPreparedModelRequest,
        credential: &Credential,
        cancel: &CancellationToken,
        limits: &TransportLimits,
    ) -> Result<SendReport, TransportError> {
        credential.check().map_err(TransportError::refused)?;
        cancel.check().map_err(|_| {
            TransportError::refused(ModelError::new(
                ModelErrorCode::Cancelled,
                "cancelled before sending (no bytes sent)",
            ))
        })?;
        let prepared = request.prepared();
        // Transport-level origin gate (defense in depth alongside the
        // runtime binding check): refused before any socket exists.
        self.binding
            .check(&prepared.endpoint_origin)
            .map_err(TransportError::refused)?;
        let (host, port) =
            split_origin(&prepared.endpoint_origin).map_err(TransportError::refused)?;
        let addr = format!("{host}:{port}");
        let mut stream = TcpStream::connect(&addr).map_err(|e| {
            TransportError::refused(ModelError::new(
                ModelErrorCode::Disconnected,
                format!(
                    "connection to the pinned endpoint failed: {}",
                    redact(&e.to_string())
                ),
            ))
        })?;
        stream
            .set_read_timeout(Some(Duration::from_millis(limits.read_timeout_ms)))
            .map_err(|e| {
                TransportError::refused(ModelError::new(
                    ModelErrorCode::TransportRefused,
                    format!("read deadline unsettable: {}", redact(&e.to_string())),
                ))
            })?;
        // Exact request line + fixed header allowlist. The credential
        // enters exactly one header and never the body.
        let session = &prepared.session_header;
        let auth = credential.authorization_value();
        let head = format!(
            "POST {} HTTP/1.1\r\nhost: {}\r\ncontent-type: application/json\r\naccept: text/event-stream\r\ncontent-length: {}\r\nx-opencode-session: {}\r\nconnection: close\r\n",
            prepared.endpoint_path,
            host_port_header(&prepared.endpoint_origin, &host, port),
            prepared.request_bytes.len(),
            session,
        );
        // NOTE: `auth` is written to the socket only; it never enters any
        // error, log, or snapshot on this path.
        stream.write_all(head.as_bytes()).map_err(|e| {
            TransportError::after_send(ModelError::new(
                ModelErrorCode::SendUncertain,
                format!("header send outcome unknown: {}", redact(&e.to_string())),
            ))
        })?;
        stream
            .write_all(format!("authorization: {auth}\r\n").as_bytes())
            .map_err(|e| {
                TransportError::after_send(ModelError::new(
                    ModelErrorCode::SendUncertain,
                    format!(
                        "credential header send outcome unknown: {}",
                        redact(&e.to_string())
                    ),
                ))
            })?;
        // Blank line terminating the header block, then the exact body.
        stream.write_all(b"\r\n").map_err(|e| {
            TransportError::after_send(ModelError::new(
                ModelErrorCode::SendUncertain,
                format!(
                    "header terminator send outcome unknown: {}",
                    redact(&e.to_string())
                ),
            ))
        })?;
        // Drop the secret from memory as early as possible (best effort;
        // `String` zeroization is not guaranteed, so the guarantee stated
        // is narrower: the value never reaches logs/errors/snapshots).
        let _ = auth.len();
        stream.write_all(&prepared.request_bytes).map_err(|e| {
            TransportError::after_send(ModelError::new(
                ModelErrorCode::SendUncertain,
                format!("body send outcome unknown: {}", redact(&e.to_string())),
            ))
        })?;
        stream.flush().map_err(|e| {
            TransportError::after_send(ModelError::new(
                ModelErrorCode::SendUncertain,
                format!("body flush outcome unknown: {}", redact(&e.to_string())),
            ))
        })?;
        // From here the bytes may exist provider-side: every later failure
        // is uncertain or partial, never "not sent".
        cancel.check().map_err(|_| {
            TransportError::after_send(ModelError::new(
                ModelErrorCode::SendUncertain,
                "cancelled after send with no observed event (outcome unknown; not re-sending)",
            ))
        })?;
        if credential.is_revoked() {
            return Err(TransportError::after_send(ModelError::new(
                ModelErrorCode::CredentialRevoked,
                "credential was revoked after send (outcome unknown; not re-sending)",
            )));
        }
        let (raw, read_err) = read_all_partial(&stream, cancel, limits);
        // Cancellation wins over partial bytes: stop now, keep the attempt
        // uncertain, and never present a cancelled stream as data.
        if let Some(ref e) = read_err {
            if e.code == ModelErrorCode::Cancelled {
                return Err(TransportError::after_send(e.clone()));
            }
            if e.code == ModelErrorCode::PayloadTooLarge {
                return Err(TransportError::after_send(e.clone()));
            }
        }
        if raw.is_empty() {
            // Nothing arrived after the flush: the read error (timeout,
            // disconnect, pre-read cancellation) classifies the outcome.
            let error = read_err.unwrap_or_else(|| {
                ModelError::new(
                    ModelErrorCode::SendUncertain,
                    "no provider event observed after send (outcome unknown; not re-sending)",
                )
            });
            return Err(TransportError::after_send(error));
        }
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (status, headers, body) =
            split_http_response(&text).map_err(TransportError::after_send)?;
        if (300..400).contains(&status) {
            return Err(TransportError::after_send(ModelError::new(
                ModelErrorCode::RedirectRefused,
                "provider answered with a redirect (never followed; pinned endpoint retained)",
            )));
        }
        if status != 200 {
            return Err(TransportError::after_send(ModelError::new(
                ModelErrorCode::Disconnected,
                format!("provider answered HTTP {status} (no event observed; outcome uncertain)"),
            )));
        }
        let content_type = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        if !content_type.contains("text/event-stream") {
            return Err(TransportError::after_send(ModelError::new(
                ModelErrorCode::SseMalformed,
                "provider response is not an event stream",
            )));
        }
        match parse_sse_body(&body, limits.max_events) {
            Ok((events, finish_reason)) => {
                let truncated = finish_reason.is_none();
                Ok(SendReport {
                    bytes_sent: true,
                    events,
                    finish_reason,
                    http_status: Some(status),
                    truncated,
                    note: read_err.map(|e| e.message),
                })
            }
            Err(parse_err) => {
                // A mid-stream cut leaves complete frames before the break:
                // retain them as a truncated partial report instead of
                // discarding the observed events.
                if read_err.is_some() {
                    if let Ok(events) = parse_sse_body_complete_prefix(&body, limits.max_events) {
                        if !events.is_empty() {
                            return Ok(SendReport {
                                bytes_sent: true,
                                events,
                                finish_reason: None,
                                http_status: Some(status),
                                truncated: true,
                                note: Some(parse_err.message),
                            });
                        }
                    }
                }
                Err(TransportError::after_send(parse_err))
            }
        }
    }
}

fn split_origin(origin: &str) -> Result<(String, u16), ModelError> {
    let (scheme, rest) = origin.split_once("://").ok_or_else(|| {
        ModelError::new(
            ModelErrorCode::EndpointMismatch,
            "endpoint origin lacks a scheme",
        )
    })?;
    let host_part = rest.split('/').next().unwrap_or("");
    if host_part.contains('@') {
        return Err(ModelError::new(
            ModelErrorCode::EndpointMismatch,
            "endpoint origin must not carry userinfo",
        ));
    }
    let (host, port) = match host_part.rsplit_once(':') {
        Some((h, p)) => {
            let port: u16 = p.parse().map_err(|_| {
                ModelError::new(
                    ModelErrorCode::EndpointMismatch,
                    "endpoint origin port invalid",
                )
            })?;
            (h.to_owned(), port)
        }
        None => (
            host_part.to_owned(),
            if scheme == "https" { 443 } else { 80 },
        ),
    };
    if host.trim().is_empty() {
        return Err(ModelError::new(
            ModelErrorCode::EndpointMismatch,
            "endpoint origin lacks a host",
        ));
    }
    // Defense in depth (prepared hosts already passed target validation):
    // no control, space, DEL, or non-ASCII byte may reach the request line.
    if !host.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ModelError::new(
            ModelErrorCode::EndpointMismatch,
            "endpoint host carries characters forbidden on the wire",
        ));
    }
    Ok((host, port))
}

fn host_port_header(origin: &str, host: &str, port: u16) -> String {
    let default = if origin.starts_with("https://") {
        443
    } else {
        80
    };
    if port == default {
        host.to_owned()
    } else {
        format!("{host}:{port}")
    }
}

/// Bounded read returning bytes-so-far plus the terminal read outcome.
/// A mid-stream cut keeps the received prefix: the caller parses complete
/// frames from it (truncated partial) instead of discarding observed events.
/// Returns `(bytes, None)` on a clean EOF, `(bytes, Some(error))` when the
/// read itself failed or was cancelled after bytes arrived.
fn read_all_partial(
    mut stream: &TcpStream,
    cancel: &CancellationToken,
    limits: &TransportLimits,
) -> (Vec<u8>, Option<ModelError>) {
    // Bounded: at most max_text_bytes + max_arg_bytes + 64 KiB framing.
    let cap = limits
        .max_text_bytes
        .saturating_add(limits.max_arg_bytes)
        .saturating_add(64 * 1024);
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        if cancel.is_cancelled() {
            return (
                buf,
                Some(ModelError::new(
                    ModelErrorCode::Cancelled,
                    "cancelled while reading the provider stream (partial output retained, not terminal)",
                )),
            );
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > cap {
                    return (
                        buf,
                        Some(ModelError::new(
                            ModelErrorCode::PayloadTooLarge,
                            "provider response exceeds the transport bound",
                        )),
                    );
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                return (
                    buf,
                    Some(ModelError::new(
                        ModelErrorCode::Timeout,
                        "provider read deadline expired (outcome uncertain; not re-sending)",
                    )),
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                return (
                    buf,
                    Some(ModelError::new(
                        ModelErrorCode::Disconnected,
                        format!("provider stream read failed: {}", redact(&e.to_string())),
                    )),
                );
            }
        }
    }
    (buf, None)
}

/// Parsed HTTP response head: status, headers, and body.
type HttpResponseParts = (u16, Vec<(String, String)>, String);

fn split_http_response(text: &str) -> Result<HttpResponseParts, ModelError> {
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(|| {
        ModelError::new(
            ModelErrorCode::SseMalformed,
            "provider response lacks a complete HTTP header block",
        )
    })?;
    let mut lines = head.lines();
    let status_line = lines.next().ok_or_else(|| {
        ModelError::new(
            ModelErrorCode::SseMalformed,
            "provider response lacks a status line",
        )
    })?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| {
            ModelError::new(
                ModelErrorCode::SseMalformed,
                "provider status line is malformed",
            )
        })?;
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_owned(), v.trim().to_owned()));
        }
    }
    Ok((status, headers, body.to_owned()))
}
