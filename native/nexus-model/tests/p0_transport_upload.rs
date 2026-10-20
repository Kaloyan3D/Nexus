//! P0 (DSH vs Native) transport reproduction: request-upload backpressure.
//!
//! `egress::connect` gives every provider socket a 100 ms read AND write
//! timeout so cancellation and deadlines are observed promptly. The read
//! loop treats a timed-out slice as "keep waiting"; the request upload used
//! `write_all`, which gives up on the first timed-out slice. A provider that
//! is merely slow to drain a large request body (normal TCP backpressure: a
//! proxy streaming the body upstream, a busy edge) was therefore reported as
//! `send-uncertain` - the R-NATIVE-3 run 14 "lost answers" (77 of 279
//! requests, none below ~50 KB of conversation).
//!
//! The fixture is a plain loopback HTTP server that accepts the connection,
//! pauses before reading (the client must block on a full socket buffer),
//! then reads the whole request and answers with a normal SSE stream.

use nexus_contracts::{RegistryProvenanceV1, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION};
use nexus_model::egress::AddressPolicy;
use nexus_model::testkit::ScriptedResolver;
use nexus_model::*;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TASK: &str = "task-p0-upload";

fn issued_for(target: &ExecutionTargetV2) -> (RegistryResolutionV1, serde_json::Value) {
    let snapshot = serde_json::json!({"tag": "p0-upload"});
    let tv = serde_json::to_value(&target.core).expect("core");
    let mut issued = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
        issuer: "nexus-registry-bridge/1".to_owned(),
        task_instance_id: TASK.to_owned(),
        role: "muse_main".to_owned(),
        target: target.core.clone(),
        provenance: RegistryProvenanceV1 {
            issuer: "nexus-registry-bridge/1".to_owned(),
            resolution_id_compat: target.core.resolution_id.clone(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(&snapshot),
            target_digest: nexus_contracts::target_digest_of(&tv),
            mode_config_revision: target.core.mode_config_revision.clone(),
            issuance_id: String::new(),
        },
    };
    issued.provenance.issuance_id = issued.issuance_id_of();
    (issued, snapshot)
}

/// A request whose serialized body is roughly `approx_bytes` long.
fn big_request(approx_bytes: usize) -> ModelRequest {
    let per = 24 * 1024;
    let n = (approx_bytes / per).clamp(1, 120);
    let mut r = ModelRequest::text_only("user", &"x".repeat(per));
    r.messages = (0..n)
        .map(|i| ChatMessage {
            role: if i % 2 == 0 { "user" } else { "assistant" }.to_owned(),
            content: format!("{i}:{}", "lorem ipsum ".repeat(per / 12)),
        })
        .collect();
    r
}

struct Slow {
    port: u16,
    bodies: Arc<Mutex<Vec<usize>>>,
}

/// Accept one connection, wait `pause_ms` WITHOUT reading, then read the whole
/// request and answer with a complete SSE stream.
fn slow_reader(pause_ms: u64) -> Slow {
    let l = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = l.local_addr().expect("addr").port();
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let seen = bodies.clone();
    std::thread::spawn(move || {
        let Ok((mut tcp, _)) = l.accept() else { return };
        std::thread::sleep(Duration::from_millis(pause_ms));
        tcp.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let mut buf = Vec::new();
        let mut tmp = [0u8; 65536];
        let mut body_at = None;
        while body_at.is_none() {
            match tcp.read(&mut tmp) {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    body_at = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4);
                }
            }
        }
        let head = String::from_utf8_lossy(&buf[..body_at.unwrap()]).to_ascii_lowercase();
        let want: usize = head
            .lines()
            .find_map(|l| {
                l.strip_prefix("content-length:")
                    .and_then(|v| v.trim().parse().ok())
            })
            .unwrap_or(0);
        let mut got = buf.len() - body_at.unwrap();
        while got < want {
            match tcp.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => got += n,
            }
        }
        seen.lock().unwrap().push(got);
        if got < want {
            return; // truncated upload: the client gave up mid-body
        }
        let _ = tcp.write_all(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n\
data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_p0\",\"status\":\"completed\",\"usage\":{\"input_tokens\":7,\"output_tokens\":1}}}\n\n",
        );
    });
    Slow { port, bodies }
}

struct Prepared {
    transport: HttpSseTransport,
    attested: AttestedPreparedModelRequest,
}

/// Prepare (untimed: canonicalizing megabytes is slow in debug builds) the
/// request for the fixture at `srv`.
fn prepare_big(srv: &Slow, approx: usize) -> Prepared {
    let origin = format!("http://127.0.0.1:{}", srv.port);
    let target = ExecutionTargetV2::test_target(&origin, "/v1/responses");
    let (issued, snapshot) = issued_for(&target);
    let pin = VerifiedExecutionPin::bind(
        TASK,
        "cmd-p0",
        "attempt-p0",
        1,
        "inc",
        &issued,
        &snapshot,
        &target,
        "cmd-digest",
    )
    .expect("pin");
    let binding = TransportBinding::new(&origin);
    let runtime = OfflineModelRuntime::new(
        HttpSseTransport::new(binding.clone()),
        binding.clone(),
        TransportLimits::default(),
    );
    let prepared = runtime
        .prepare(&pin, &issued, &snapshot, &target, &big_request(approx))
        .expect("prepare");
    assert!(
        prepared.request_bytes.len() >= approx / 2,
        "fixture body too small"
    );
    let attested = runtime
        .attest(&pin, &issued, &snapshot, &target, prepared)
        .expect("attest");
    let loopback: Vec<IpAddr> = vec!["127.0.0.1".parse().unwrap()];
    let transport = HttpSseTransport::with_parts(
        binding,
        Arc::new(ScriptedResolver::new(vec![loopback])),
        AddressPolicy::PublicOrLoopbackForTests,
        nexus_model::egress::default_tls_config(),
    );
    Prepared {
        transport,
        attested,
    }
}

fn send(
    p: &Prepared,
    cancel: &CancellationToken,
    limits: &TransportLimits,
) -> Result<SendReport, TransportError> {
    p.transport.send(
        &p.attested,
        &Credential::test_credential("sk-p0-upload-marker"),
        cancel,
        limits,
    )
}

/// Largest body the request bound allows (loopback socket buffers auto-tune to
/// a few MB, so smaller bodies never block on 127.0.0.1).
const BIG: usize = 3_900 * 1024;

fn limits() -> TransportLimits {
    TransportLimits {
        read_timeout_ms: 5_000,
        total_timeout_ms: 20_000,
        ..TransportLimits::default()
    }
}

/// The defect: a healthy provider that takes 1.5 s to start draining a ~4 MB
/// request is answered completely, yet the client must not report the send as
/// uncertain. Before the fix this failed with `send-uncertain` ("body send
/// outcome unknown") after ~100 ms of backpressure.
#[test]
fn p0_upload_backpressure_longer_than_one_io_slice_is_not_a_lost_answer() {
    let srv = slow_reader(1_500);
    let p = prepare_big(&srv, BIG);
    let t = Instant::now();
    let r = send(&p, &CancellationToken::new(), &limits());
    let report = match r {
        Ok(rep) => rep,
        Err(e) => panic!(
            "upload backpressure was reported as a lost answer after {:?}: {:?} (bytes_sent={})",
            t.elapsed(),
            e.error,
            e.bytes_sent
        ),
    };
    assert_eq!(report.finish_reason.as_deref(), Some("stop"));
    assert!(!report.truncated);
    assert!(report.events.contains(&ModelEvent::TextDelta("ok".into())));
    // the server received the WHOLE body
    let got = srv.bodies.lock().unwrap().clone();
    assert_eq!(got.len(), 1);
    assert!(got[0] > 2 * 1024 * 1024, "server received {} bytes", got[0]);
}

/// The fix must stay bounded: a peer that never drains the request is still
/// cut off by the exchange deadline (no unbounded blocking, outcome uncertain
/// because part of the request may have reached the provider).
#[test]
fn p0_upload_to_a_peer_that_never_reads_is_bounded_by_the_exchange_deadline() {
    let srv = slow_reader(60_000);
    let l = TransportLimits {
        read_timeout_ms: 5_000,
        total_timeout_ms: 1_500,
        ..TransportLimits::default()
    };
    let p = prepare_big(&srv, BIG);
    let t = Instant::now();
    let e = send(&p, &CancellationToken::new(), &l)
        .expect_err("a peer that never reads cannot succeed");
    let took = t.elapsed();
    assert!(
        e.bytes_sent,
        "bytes may have reached the peer: outcome is uncertain"
    );
    assert_eq!(e.error.code, ModelErrorCode::SendUncertain, "{:?}", e.error);
    assert!(
        took >= Duration::from_millis(1_200),
        "gave up too early: {took:?}"
    );
    assert!(
        took < Duration::from_millis(4_000),
        "not bounded by the deadline: {took:?}"
    );
}

/// Cancellation is still observed while the upload is blocked.
#[test]
fn p0_upload_blocked_on_backpressure_observes_cancellation_promptly() {
    let srv = slow_reader(60_000);
    let p = prepare_big(&srv, BIG);
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        c2.cancel();
    });
    let t = Instant::now();
    let e = send(&p, &cancel, &limits()).expect_err("cancelled");
    assert!(
        t.elapsed() < Duration::from_millis(2_500),
        "{:?}",
        t.elapsed()
    );
    assert!(e.bytes_sent);
    assert!(
        matches!(
            e.error.code,
            ModelErrorCode::Cancelled | ModelErrorCode::SendUncertain
        ),
        "{:?}",
        e.error
    );
}
