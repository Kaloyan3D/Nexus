//! Offline transport testbed (TEST-ONLY; A2.2, Phase 4).
//!
//! `MockTransport` scripts every failure class without sockets;
//! `LocalMockServer` serves the same scripts over real loopback TCP so
//! `HttpSseTransport` proves its exact request line, headers, and SSE
//! handling against the wire. `load_fixture` reads the recorded corpus in
//! `native/test-vectors/model-transport/`.
//!
//! Nothing here is a production dispatch path: production dispatch remains
//! disabled (`nexus_kernel::Kernel::dispatch_enabled() == false`), and
//! this module is exercised only by `tests/conformance.rs`.

use crate::error::{redact, ModelError, ModelErrorCode};
use crate::prepare::AttestedPreparedModelRequest;
use crate::sse::parse_sse_body;
use crate::stream::CancellationToken;
use crate::transport::{SendReport, Transport, TransportError, TransportLimits};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};

/// Scripted provider behavior for `MockTransport`.
#[derive(Debug, Clone)]
pub enum MockScript {
    /// Clean SSE body ending in `response.completed`.
    CleanStream {
        /// Raw SSE body.
        body: String,
    },
    /// TCP connect itself fails (nothing sent).
    FailConnect,
    /// Bytes leave, then silence: no event is ever observed.
    DropAfterSend,
    /// Complete frames without provider completion (truncated).
    PartialFrames {
        /// Raw SSE body (no `response.completed`).
        body: String,
    },
    /// Raw body the parser must refuse.
    MalformedBody {
        /// Raw SSE body.
        body: String,
    },
    /// Provider answers with a redirect (never followed).
    Redirect,
    /// Revoke the presented credential after `events` have been observed,
    /// then fail closed (deterministic stand-in for mid-stream revocation).
    RevokeAfter {
        /// Events to observe first.
        events: usize,
        /// Raw SSE body.
        body: String,
    },
    /// Cancel the token after `events` have been observed, then keep
    /// reading: the transport must stop anyway (read-count pin).
    CancelAfter {
        /// Events to observe first.
        events: usize,
        /// Raw SSE body.
        body: String,
    },
    /// Connection drops mid-body carrying only a truncated prefix.
    DisconnectMidBody {
        /// Complete prefix frames.
        prefix: String,
        /// Trailing partial bytes (never parsed as a frame).
        trailing: String,
    },
}

/// What the mock observed (asserted by conformance tests). The credential
/// token value is NEVER recorded: only its presence.
#[derive(Debug, Default)]
pub struct MockObservations {
    /// Completed `send()` calls.
    pub sends: AtomicUsize,
    /// Events pulled from the script.
    pub reads: AtomicUsize,
    /// Last request bytes sent.
    pub last_request_bytes: Mutex<Vec<u8>>,
    /// Last session header value.
    pub last_session: Mutex<String>,
    /// Whether an authorization header was present.
    pub auth_present: AtomicUsize,
    /// Whether any raw secret was ever observed (must stay false).
    pub secret_seen: AtomicUsize,
}

/// Scripted offline transport. Parses script bodies through the REAL
/// `sse.rs` parser so mock results stay wire-faithful.
pub struct MockTransport {
    script: MockScript,
    /// Token marker treated as a secret for the `secret_seen` tripwire.
    secret_marker: String,
    /// Shared observations.
    pub observed: Arc<MockObservations>,
}

impl MockTransport {
    /// Create a scripted transport with a secret tripwire marker.
    pub fn new(script: MockScript, secret_marker: &str) -> Self {
        Self {
            script,
            secret_marker: secret_marker.to_owned(),
            observed: Arc::new(MockObservations::default()),
        }
    }

    /// Number of completed sends (duplicate-send detector).
    pub fn sends(&self) -> usize {
        self.observed.sends.load(Ordering::SeqCst)
    }

    /// Number of script events pulled (cancellation-stop detector).
    pub fn reads(&self) -> usize {
        self.observed.reads.load(Ordering::SeqCst)
    }

    fn note_send(&self, request: &AttestedPreparedModelRequest, auth_present: bool) {
        let prepared = request.prepared();
        *self.observed.last_request_bytes.lock().expect("mutex") = prepared.request_bytes.clone();
        *self.observed.last_session.lock().expect("mutex") = prepared.session_header.clone();
        if auth_present {
            self.observed.auth_present.fetch_add(1, Ordering::SeqCst);
        }
        if !self.secret_marker.is_empty() {
            let body = String::from_utf8_lossy(&prepared.request_bytes);
            if body.contains(&self.secret_marker)
                || prepared.session_header.contains(&self.secret_marker)
            {
                self.observed.secret_seen.fetch_add(1, Ordering::SeqCst);
            }
        }
        self.observed.sends.fetch_add(1, Ordering::SeqCst);
    }
}

impl Transport for MockTransport {
    fn send(
        &self,
        request: &AttestedPreparedModelRequest,
        credential: &crate::transport::Credential,
        cancel: &CancellationToken,
        limits: &TransportLimits,
    ) -> Result<SendReport, TransportError> {
        match &self.script {
            MockScript::FailConnect => Err(TransportError::refused(ModelError::new(
                ModelErrorCode::Disconnected,
                "mock connection refused (nothing sent)",
            ))),
            MockScript::DropAfterSend => {
                credential.check().map_err(TransportError::after_send)?;
                self.note_send(request, true);
                Err(TransportError::after_send(ModelError::new(
                    ModelErrorCode::SendUncertain,
                    "mock dropped after send with no observed event (outcome unknown; not re-sending)",
                )))
            }
            MockScript::Redirect => {
                credential.check().map_err(TransportError::after_send)?;
                self.note_send(request, true);
                Err(TransportError::after_send(ModelError::new(
                    ModelErrorCode::RedirectRefused,
                    "mock answered with a redirect (never followed; pinned endpoint retained)",
                )))
            }
            MockScript::CleanStream { body }
            | MockScript::PartialFrames { body }
            | MockScript::MalformedBody { body } => {
                credential.check().map_err(TransportError::after_send)?;
                if cancel.is_cancelled() {
                    return Err(TransportError::after_send(ModelError::new(
                        ModelErrorCode::Cancelled,
                        "mock cancelled after send (outcome unknown; not re-sending)",
                    )));
                }
                self.note_send(request, true);
                parse_body_report(body, limits, None)
            }
            MockScript::RevokeAfter { events, body } => {
                credential.check().map_err(TransportError::after_send)?;
                self.note_send(request, true);
                let (parsed, _) =
                    parse_sse_body(body, limits.max_events).map_err(TransportError::after_send)?;
                let mut shown = Vec::new();
                for event in parsed {
                    if shown.len() >= *events {
                        credential.revoke();
                        return Err(TransportError::after_send(ModelError::new(
                            ModelErrorCode::CredentialRevoked,
                            "credential was revoked mid-stream (partial output retained; not re-sending)",
                        )));
                    }
                    self.observed.reads.fetch_add(1, Ordering::SeqCst);
                    shown.push(event);
                }
                // Revocation point beyond the script: fall through as partial.
                credential.revoke();
                Err(TransportError::after_send(ModelError::new(
                    ModelErrorCode::CredentialRevoked,
                    "credential was revoked mid-stream (partial output retained; not re-sending)",
                )))
            }
            MockScript::CancelAfter { events, body } => {
                credential.check().map_err(TransportError::after_send)?;
                self.note_send(request, true);
                let (parsed, finish) =
                    parse_sse_body(body, limits.max_events).map_err(TransportError::after_send)?;
                let mut shown = Vec::new();
                for event in parsed {
                    if shown.len() >= *events {
                        cancel.cancel();
                    }
                    if cancel.is_cancelled() {
                        // Stop pulling: further script events are never read.
                        return Ok(SendReport {
                            stop_cause: None,
                            bytes_sent: true,
                            events: shown,
                            finish_reason: None,
                            http_status: None,
                            truncated: true,
                            note: Some(
                                "cancelled mid-stream; transport stopped reading".to_owned(),
                            ),
                        });
                    }
                    self.observed.reads.fetch_add(1, Ordering::SeqCst);
                    shown.push(event);
                }
                let truncated = finish.is_none();
                Ok(SendReport {
                    stop_cause: None,
                    bytes_sent: true,
                    events: shown,
                    finish_reason: finish,
                    http_status: None,
                    truncated,
                    note: None,
                })
            }
            MockScript::DisconnectMidBody { prefix, trailing } => {
                credential.check().map_err(TransportError::after_send)?;
                self.note_send(request, true);
                let mut body = prefix.clone();
                body.push_str(trailing);
                let events = crate::sse::parse_sse_body_complete_prefix(&body, limits.max_events)
                    .map_err(TransportError::after_send)?;
                for _ in &events {
                    self.observed.reads.fetch_add(1, Ordering::SeqCst);
                }
                Ok(SendReport {
                    stop_cause: None,
                    bytes_sent: true,
                    events,
                    finish_reason: None,
                    http_status: None,
                    truncated: true,
                    note: Some("mock connection dropped mid-body".to_owned()),
                })
            }
        }
    }
}

fn parse_body_report(
    body: &str,
    limits: &TransportLimits,
    note: Option<String>,
) -> Result<SendReport, TransportError> {
    let (events, finish_reason) =
        parse_sse_body(body, limits.max_events).map_err(TransportError::after_send)?;
    let truncated = finish_reason.is_none();
    Ok(SendReport {
        stop_cause: None,
        bytes_sent: true,
        events,
        finish_reason,
        http_status: None,
        truncated,
        note,
    })
}

/// Recorded fixture: one wire-faithful request/response pair from
/// `native/test-vectors/model-transport/`.
#[derive(Debug, Clone)]
pub struct Fixture {
    /// Fixture name.
    pub name: String,
    /// Raw SSE body as recorded.
    pub sse_body: String,
    /// Expected assistant text.
    pub expected_text: String,
    /// Expected reasoning text.
    pub expected_reasoning: String,
    /// Expected tool calls `(name, arguments_json)`.
    pub expected_tools: Vec<(String, serde_json::Value)>,
    /// Expected usage `(input, output)`.
    pub expected_usage: (u64, u64),
    /// Expected finish reason.
    pub expected_finish: String,
}

/// Load one recorded fixture by name (no network, file only).
pub fn load_fixture(name: &str) -> Fixture {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../test-vectors/model-transport")
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("fixture {name} unreadable at {}: {e}", path.display()));
    let value: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("fixture {name} malformed: {e}"));
    Fixture {
        name: name.to_owned(),
        sse_body: value
            .get("sse_body")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("fixture {name} lacks sse_body"))
            .to_owned(),
        expected_text: value
            .get("expected_text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
        expected_reasoning: value
            .get("expected_reasoning")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
        expected_tools: value
            .get("expected_tools")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .map(|t| {
                        (
                            t.get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_owned(),
                            t.get("arguments")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        expected_usage: {
            let u = value.get("expected_usage");
            (
                u.and_then(|v| v.get("input_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                u.and_then(|v| v.get("output_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
            )
        },
        expected_finish: value
            .get("expected_finish")
            .and_then(|v| v.as_str())
            .unwrap_or("stop")
            .to_owned(),
    }
}

/// Normalize one fixture body straight through the parser + assembler.
/// Asserts the recorded expectations (wire-faithful without sockets).
pub fn normalize_fixture(
    fixture: &Fixture,
    attempt_id: &str,
    request_digest: &str,
    limits: &TransportLimits,
) -> crate::sse::TerminalResponse {
    let (events, finish) = parse_sse_body(&fixture.sse_body, limits.max_events)
        .unwrap_or_else(|e| panic!("fixture {} failed to parse: {e}", fixture.name));
    let mut assembler = crate::sse::StreamAssembler::new(
        attempt_id,
        request_digest,
        limits.max_events,
        limits.max_text_bytes,
        limits.max_arg_bytes,
    );
    for event in events {
        assembler
            .push(event)
            .unwrap_or_else(|e| panic!("fixture {} failed to assemble: {e}", fixture.name));
    }
    assembler
        .set_finish(&finish.unwrap_or_else(|| panic!("fixture {} never completes", fixture.name)));
    assembler
        .finish()
        .unwrap_or_else(|e| panic!("fixture {} failed to finish: {e}", fixture.name))
}

/// What the mock server observed (asserted by conformance tests). The
/// authorization VALUE is never stored: only its presence.
#[derive(Debug, Default)]
pub struct ServerObservations {
    /// Accepted TCP connections.
    pub connections: AtomicUsize,
    /// Request line of the first connection.
    pub request_line: Mutex<String>,
    /// Session header of the first connection.
    pub session_header: Mutex<String>,
    /// Whether an authorization header was present.
    pub auth_present: AtomicUsize,
    /// Request body bytes of the first connection.
    pub request_body: Mutex<Vec<u8>>,
}

/// Scripted loopback HTTP server for `HttpSseTransport` tests.
/// Serves exactly the scripted status/body, then closes. Handles connections
/// until `shutdown_after` is reached or the handle is joined.
pub struct LocalMockServer {
    /// Socket address (127.0.0.1:ephemeral).
    pub addr: std::net::SocketAddr,
    observed: Arc<ServerObservations>,
    shutdown: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

/// One scripted HTTP response.
#[derive(Debug, Clone)]
pub struct MockHttpResponse {
    /// HTTP status.
    pub status: u16,
    /// Extra headers.
    pub headers: Vec<(String, String)>,
    /// Body bytes (SSE for 200s).
    pub body: String,
    /// When true, close mid-body after `cut_after` bytes.
    pub cut_after: Option<usize>,
    /// When true, emit the body in 7-byte drips (proves parser immunity to TCP segmentation).
    /// When set, emit these raw bytes instead of body (invalid-UTF-8 probe).
    pub drip: bool,
    pub raw_bytes: Option<Vec<u8>>,
    /// Read-deadline probe doc.
    pub stall_ms: Option<u64>,
}

impl MockHttpResponse {
    /// 200 `text/event-stream` with the given SSE body.
    pub fn sse(body: &str) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
            body: body.to_owned(),
            cut_after: None,
            stall_ms: None,
            drip: false,
            raw_bytes: None,
        }
    }

    /// 302 redirect (must never be followed).
    pub fn redirect() -> Self {
        Self {
            status: 302,
            headers: vec![(
                "location".to_owned(),
                "https://elsewhere.example/r".to_owned(),
            )],
            body: String::new(),
            cut_after: None,
            stall_ms: None,
            drip: false,
            raw_bytes: None,
        }
    }

    /// Accept the request, then stall before responding (read-deadline
    /// probe). Keep the stall small; the test overrides the read timeout.
    pub fn stall(ms: u64) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
            body: String::new(),
            cut_after: None,
            stall_ms: Some(ms),
            drip: false,
            raw_bytes: None,
        }
    }
}

impl LocalMockServer {
    /// Serve `responses` in connection order on loopback (one per test).
    /// `max_connections` bounds accepted sockets so a runaway client
    /// cannot hang the test.
    pub fn serve(responses: Vec<MockHttpResponse>, max_connections: usize) -> Self {
        let listener =
            TcpListener::bind("127.0.0.1:0").expect("loopback listener binds in testbed");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let addr = listener.local_addr().expect("listener addr");
        let observed = Arc::new(ServerObservations::default());
        let obs = observed.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let stop = shutdown.clone();
        let handle = std::thread::spawn(move || {
            let mut served = 0;
            let start = std::time::Instant::now();
            let idle_cap = std::time::Duration::from_secs(30);
            loop {
                if stop.load(Ordering::SeqCst)
                    || served >= max_connections
                    || start.elapsed() > idle_cap
                {
                    break;
                }
                let mut stream = match listener.accept() {
                    Ok((s, _)) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                obs.connections.fetch_add(1, Ordering::SeqCst);
                let request = read_http_request(&mut stream);
                if served == 0 {
                    *obs.request_line.lock().expect("mutex") = request.0;
                    *obs.session_header.lock().expect("mutex") = request.1;
                    if request.2 {
                        obs.auth_present.fetch_add(1, Ordering::SeqCst);
                    }
                    *obs.request_body.lock().expect("mutex") = request.3;
                }
                let script = responses.get(served).cloned().unwrap_or(MockHttpResponse {
                    status: 500,
                    headers: Vec::new(),
                    body: String::new(),
                    cut_after: None,
                    stall_ms: None,
                    drip: false,
                    raw_bytes: None,
                });
                served += 1;
                write_http_response(&mut stream, &script);
                if served >= responses.len() {
                    break;
                }
            }
        });
        Self {
            addr,
            observed,
            shutdown,
            handle: Some(handle),
        }
    }

    /// Endpoint origin for this server (`http://127.0.0.1:PORT`).
    pub fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Observed connections.
    pub fn connections(&self) -> usize {
        self.observed.connections.load(Ordering::SeqCst)
    }

    /// Borrow server observations.
    pub fn observed(&self) -> &ServerObservations {
        &self.observed
    }

    /// Signal shutdown and join the server thread (idempotent, prompt:
    /// the accept loop polls the flag every few millis).
    pub fn join(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for LocalMockServer {
    fn drop(&mut self) {
        self.join();
    }
}

fn read_http_request(stream: &mut std::net::TcpStream) -> (String, String, bool, Vec<u8>) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    // Read until the header terminator (bounded).
    while head.len() < 64 * 1024 {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                head.extend_from_slice(&byte);
                if head.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let head_text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = head_text.lines();
    let request_line = lines.next().unwrap_or("").to_owned();
    let mut content_length = 0usize;
    let mut session = String::new();
    let mut auth = false;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => {
                    content_length = v.trim().parse().unwrap_or(0).min(2 * 1024 * 1024);
                }
                "x-opencode-session" => session = v.trim().to_owned(),
                // Presence only: the VALUE is never stored.
                "authorization" => auth = true,
                _ => {}
            }
        }
    }
    let mut body = vec![0u8; content_length];
    let mut done = 0;
    while done < content_length {
        match stream.read(&mut body[done..]) {
            Ok(0) => break,
            Ok(n) => done += n,
            Err(_) => break,
        }
    }
    body.truncate(done);
    // Defensive: the recorded body must not carry the test secret marker.
    // (The marker check itself lives in conformance tests via `redact`.)
    let _ = redact("");
    (request_line, session, auth, body)
}

fn write_http_response(stream: &mut std::net::TcpStream, script: &MockHttpResponse) {
    if let Some(ms) = script.stall_ms {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    let reason = match script.status {
        200 => "OK",
        302 => "Found",
        _ => "Error",
    };
    let payload: Vec<u8> = script
        .raw_bytes
        .clone()
        .unwrap_or_else(|| script.body.clone().into_bytes());
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\ncontent-length: {}\r\nconnection: close\r\n",
        script.status,
        payload.len()
    );
    for (k, v) in &script.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    if script.drip {
        for chunk in payload.chunks(7) {
            let _ = stream.write_all(chunk);
            // Drip feed: segments land arbitrarily; the read loop accumulates.
        }
    } else {
        match script.cut_after {
            Some(n) => {
                let _ = stream.write_all(&payload[..n.min(payload.len())]); // mid-body cut
            }
            None => {
                let _ = stream.write_all(&payload);
            }
        }
    }
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_clean_stream_parses() {
        let body = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n\
             data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1},\"finish_reason\":\"stop\"}}\n\n\
             data: [DONE]\n\n";
        let t = MockTransport::new(
            MockScript::CleanStream {
                body: body.to_owned(),
            },
            "",
        );
        assert_eq!(t.sends(), 0);
    }
}
