#![allow(dead_code, unused_imports)] // fixture helpers copied from tls_a52 (not all used here)
//! A5.4 OpenCode Go protocol-compatibility suite (built on the A5.2 TLS fixtures).
//!
//! A5.2 adversarial suite: real rustls handshakes against local TLS
//! fixtures, scripted DNS and the egress policy.
//!
//! PKI: a throwaway CA is generated per test with the `openssl` CLI and is
//! trusted ONLY by the test's own `ClientConfig`. Production code has no
//! way to add it. No test touches the network beyond 127.0.0.1.

use nexus_contracts::{RegistryProvenanceV1, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION};
use nexus_model::egress::{self, AddressPolicy};
use nexus_model::testkit::ScriptedResolver;
use nexus_model::*;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SECRET: &str = "sk-a52-secret-marker-91c4";
const HOST: &str = "api.provider.test";
const TASK: &str = "task-a5-2";

// ------------------------------------------------------------------ PKI

struct Pki {
    dir: tempfile::TempDir,
    ca_der: Vec<u8>,
}

fn sh(dir: &Path, args: &[&str]) {
    let out = Command::new("openssl")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("openssl CLI is required for the A5.2 TLS fixtures");
    assert!(
        out.status.success(),
        "openssl {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn read(dir: &Path, name: &str) -> Vec<u8> {
    std::fs::read(dir.join(name)).expect("read fixture file")
}

impl Pki {
    fn new(cn: &str) -> Self {
        let dir = tempfile::tempdir().expect("pki dir");
        let d = dir.path();
        sh(
            d,
            &[
                "ecparam",
                "-name",
                "prime256v1",
                "-genkey",
                "-noout",
                "-out",
                "ca.key",
            ],
        );
        sh(
            d,
            &[
                "req",
                "-x509",
                "-new",
                "-key",
                "ca.key",
                "-out",
                "ca.pem",
                "-days",
                "2",
                "-subj",
                &format!("/CN={cn}"),
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
            ],
        );
        sh(
            d,
            &["x509", "-in", "ca.pem", "-outform", "DER", "-out", "ca.der"],
        );
        let ca_der = read(d, "ca.der");
        Self { dir, ca_der }
    }

    /// Issue a leaf for `dns`; `expired` backdates the validity window.
    fn leaf(&self, name: &str, dns: &str, expired: bool) -> (Vec<u8>, Vec<u8>) {
        let d = self.dir.path();
        let (key, csr, pem, ext, der, pk8) = (
            format!("{name}.key"),
            format!("{name}.csr"),
            format!("{name}.pem"),
            format!("{name}.ext"),
            format!("{name}.der"),
            format!("{name}.pk8"),
        );
        sh(
            d,
            &[
                "ecparam",
                "-name",
                "prime256v1",
                "-genkey",
                "-noout",
                "-out",
                &key,
            ],
        );
        sh(
            d,
            &[
                "req", "-new", "-key", &key, "-subj", "/CN=leaf", "-out", &csr,
            ],
        );
        std::fs::write(
            d.join(&ext),
            format!(
                "subjectAltName=DNS:{dns}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\n"
            ),
        )
        .expect("ext");
        let mut args: Vec<&str> = vec![
            "x509",
            "-req",
            "-in",
            &csr,
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-out",
            &pem,
            "-extfile",
            &ext,
        ];
        if expired {
            args.extend([
                "-not_before",
                "20200101000000Z",
                "-not_after",
                "20200102000000Z",
            ]);
        } else {
            args.extend(["-days", "1"]);
        }
        sh(d, &args);
        sh(d, &["x509", "-in", &pem, "-outform", "DER", "-out", &der]);
        sh(
            d,
            &[
                "pkcs8", "-topk8", "-nocrypt", "-in", &key, "-outform", "DER", "-out", &pk8,
            ],
        );
        (read(d, &der), read(d, &pk8))
    }

    fn client_config(&self) -> Arc<rustls::ClientConfig> {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(CertificateDer::from(self.ca_der.clone()))
            .expect("test CA parses");
        egress::tls_config_with_roots(roots)
    }
}

// --------------------------------------------------------------- server

#[derive(Clone)]
enum Reply {
    Frames {
        frames: Vec<Vec<u8>>,
        gap_ms: u64,
        hold_ms: u64,
        close_notify: bool,
    },
    Redirect(String),
    /// Raw pieces, each its own TLS write + flush, `gap_ms` apart, then hold and close.
    Pieces {
        pieces: Vec<Vec<u8>>,
        gap_ms: u64,
        hold_ms: u64,
    },
    /// Complete the handshake and read the request, then never answer.
    Silence(u64),
    /// Write these exact bytes (a complete HTTP response), then close.
    Raw(Vec<u8>),
}

#[derive(Default)]
struct Seen {
    heads: Vec<String>,
    bodies: Vec<Vec<u8>>,
    sni: Vec<Option<String>>,
    versions: Vec<String>,
    alpn: Vec<Option<Vec<u8>>>,
}

struct TlsServer {
    port: u16,
    accepted: Arc<AtomicUsize>,
    seen: Arc<Mutex<Seen>>,
}

fn server_config(cert: &[u8], key: &[u8]) -> Arc<rustls::ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("versions")
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.to_vec())],
            PrivateKeyDer::from(PrivatePkcs8KeyDer::from(key.to_vec())),
        )
        .expect("server cert");
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(cfg)
}

fn start_tls(cfg: Arc<rustls::ServerConfig>, reply: Reply) -> TlsServer {
    let l = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = l.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(Mutex::new(Seen::default()));
    let (a, s) = (accepted.clone(), seen.clone());
    std::thread::spawn(move || {
        for _ in 0..3 {
            let Ok((tcp, _)) = l.accept() else { return };
            a.fetch_add(1, Ordering::SeqCst);
            tcp.set_read_timeout(Some(Duration::from_secs(5))).ok();
            let Ok(conn) = rustls::ServerConnection::new(cfg.clone()) else {
                return;
            };
            let mut tls = rustls::StreamOwned::new(conn, tcp);
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let mut body_at = None;
            let mut failed = false;
            while body_at.is_none() {
                match tls.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        body_at = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4);
                    }
                    Err(_) => {
                        failed = true;
                        break;
                    }
                }
            }
            if failed || body_at.is_none() {
                continue; // handshake rejected by the client, or EOF
            }
            let head = String::from_utf8_lossy(&buf[..body_at.unwrap()]).into_owned();
            let want: usize = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse().ok())
                })
                .unwrap_or(0);
            let mut body = buf[body_at.unwrap()..].to_vec();
            while body.len() < want {
                match tls.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => body.extend_from_slice(&tmp[..n]),
                }
            }
            {
                let mut g = s.lock().expect("mutex");
                g.heads.push(head);
                g.bodies.push(body);
                g.sni.push(tls.conn.server_name().map(str::to_owned));
                g.versions
                    .push(format!("{:?}", tls.conn.protocol_version()));
                g.alpn.push(tls.conn.alpn_protocol().map(<[u8]>::to_vec));
            }
            match &reply {
                Reply::Frames {
                    frames,
                    gap_ms,
                    hold_ms,
                    close_notify,
                } => {
                    let _ = tls.write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
                    );
                    let _ = tls.flush();
                    for f in frames {
                        if tls.write_all(f).is_err() {
                            break;
                        }
                        let _ = tls.flush();
                        std::thread::sleep(Duration::from_millis(*gap_ms));
                    }
                    std::thread::sleep(Duration::from_millis(*hold_ms));
                    if *close_notify {
                        tls.conn.send_close_notify();
                        let _ = tls.flush();
                    }
                }
                Reply::Pieces {
                    pieces,
                    gap_ms,
                    hold_ms,
                } => {
                    for p in pieces {
                        if tls.write_all(p).is_err() {
                            break;
                        }
                        let _ = tls.flush();
                        std::thread::sleep(Duration::from_millis(*gap_ms));
                    }
                    std::thread::sleep(Duration::from_millis(*hold_ms));
                    tls.conn.send_close_notify();
                    let _ = tls.flush();
                }
                Reply::Redirect(loc) => {
                    let _ = tls.write_all(
                        format!("HTTP/1.1 302 Found\r\nlocation: {loc}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes(),
                    );
                    let _ = tls.flush();
                    tls.conn.send_close_notify();
                    let _ = tls.flush();
                }
                Reply::Silence(ms) => std::thread::sleep(Duration::from_millis(*ms)),
                Reply::Raw(bytes) => {
                    let _ = tls.write_all(bytes);
                    let _ = tls.flush();
                    tls.conn.send_close_notify();
                    let _ = tls.flush();
                }
            }
        }
    });
    TlsServer {
        port,
        accepted,
        seen,
    }
}

fn delta(t: &str) -> Vec<u8> {
    format!(
        "data: {{\"type\":\"response.output_text.delta\",\"delta\":{}}}\n\n",
        serde_json::json!(t)
    )
    .into_bytes()
}

fn completed() -> Vec<u8> {
    b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}}\n\n".to_vec()
}

fn ok_reply(frames: Vec<Vec<u8>>) -> Reply {
    Reply::Frames {
        frames,
        gap_ms: 0,
        hold_ms: 0,
        close_notify: true,
    }
}

// --------------------------------------------------------- client plumbing

fn issued_for(target: &ExecutionTargetV2) -> (RegistryResolutionV1, serde_json::Value) {
    let snapshot = serde_json::json!({"tag": "a52"});
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

struct Client {
    transport: HttpSseTransport,
    attested: AttestedPreparedModelRequest,
    resolver: Arc<ScriptedResolver>,
}

fn client(
    origin: &str,
    answers: Vec<Vec<IpAddr>>,
    policy: AddressPolicy,
    tls: Arc<rustls::ClientConfig>,
) -> Client {
    client_for(
        origin,
        answers,
        policy,
        tls,
        WireProfile::OpenCodeGoResponses,
        "/inference/go/openai/v1/responses",
    )
}

fn client_for(
    origin: &str,
    answers: Vec<Vec<IpAddr>>,
    policy: AddressPolicy,
    tls: Arc<rustls::ClientConfig>,
    profile: WireProfile,
    path: &str,
) -> Client {
    let mut target = ExecutionTargetV2::test_target(origin, path);
    target.wire_profile = profile;
    let (issued, snapshot) = issued_for(&target);
    let pin = VerifiedExecutionPin::bind(
        TASK,
        "cmd-a52",
        "attempt-a52",
        1,
        "inc",
        &issued,
        &snapshot,
        &target,
        "cmd-digest",
    )
    .expect("pin");
    let binding = TransportBinding::new(origin);
    let resolver = Arc::new(ScriptedResolver::new(answers));
    let transport = HttpSseTransport::with_parts(binding.clone(), resolver.clone(), policy, tls);
    let runtime = OfflineModelRuntime::new(
        HttpSseTransport::new(binding.clone()),
        binding,
        TransportLimits::default(),
    );
    let prepared = runtime
        .prepare(
            &pin,
            &issued,
            &snapshot,
            &target,
            &ModelRequest::text_only("user", "hi"),
        )
        .expect("prepare");
    let attested = runtime
        .attest(&pin, &issued, &snapshot, &target, prepared)
        .expect("attest");
    Client {
        transport,
        attested,
        resolver,
    }
}

fn loopback() -> Vec<Vec<IpAddr>> {
    vec![vec!["127.0.0.1".parse().unwrap()]]
}

fn limits() -> TransportLimits {
    TransportLimits {
        read_timeout_ms: 2_000,
        total_timeout_ms: 20_000,
        ..TransportLimits::default()
    }
}

fn run(
    c: &Client,
    cancel: &CancellationToken,
    l: &TransportLimits,
) -> Result<SendReport, TransportError> {
    c.transport
        .send(&c.attested, &Credential::test_credential(SECRET), cancel, l)
}

fn origin(port: u16) -> String {
    format!("https://{HOST}:{port}")
}

fn good_server(pki: &Pki, reply: Reply) -> TlsServer {
    let (c, k) = pki.leaf("good", HOST, false);
    start_tls(server_config(&c, &k), reply)
}

fn no_credential_seen(s: &TlsServer) {
    let g = s.seen.lock().expect("mutex");
    for h in &g.heads {
        assert!(
            !h.to_ascii_lowercase().contains("authorization"),
            "credential reached a refused peer"
        );
    }
    assert!(
        g.heads.is_empty(),
        "no application data may reach a peer that failed verification"
    );
}

// ===================== A5.4 OpenCode Go compatibility tests =====================

const GO_PATH: &str = "/inference/go/openai/v1/responses";

fn sse(event: &str, data: serde_json::Value) -> Vec<u8> {
    format!("event: {event}\ndata: {data}\n\n").into_bytes()
}

/// A realistic OpenAI-Responses stream as served by Go-style gateways.
fn realistic_stream(texts: &[&str], usage: bool, finish: &str) -> Vec<Vec<u8>> {
    let mut out = vec![
        sse(
            "response.created",
            serde_json::json!({"type":"response.created","sequence_number":0,"response":{"id":"resp_0123abcd","object":"response","status":"in_progress","model":"muse-spark-1.3-contributor"}}),
        ),
        sse(
            "response.in_progress",
            serde_json::json!({"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_0123abcd","status":"in_progress"}}),
        ),
        sse(
            "response.output_item.added",
            serde_json::json!({"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}),
        ),
        sse(
            "response.content_part.added",
            serde_json::json!({"type":"response.content_part.added","sequence_number":3,"item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}),
        ),
    ];
    for (i, t) in texts.iter().enumerate() {
        out.push(sse("response.output_text.delta", serde_json::json!({"type":"response.output_text.delta","sequence_number":4 + i,"item_id":"msg_1","output_index":0,"content_index":0,"delta":t})));
    }
    out.push(sse("response.output_text.done", serde_json::json!({"type":"response.output_text.done","item_id":"msg_1","output_index":0,"content_index":0,"text":texts.concat()})));
    out.push(sse("response.content_part.done", serde_json::json!({"type":"response.content_part.done","item_id":"msg_1","output_index":0,"content_index":0})));
    out.push(sse("response.output_item.done", serde_json::json!({"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed"}})));
    let mut resp = serde_json::json!({"id":"resp_0123abcd","status":"completed"});
    if usage {
        resp["usage"] = serde_json::json!({"input_tokens":12,"input_tokens_details":{"cached_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":17});
    }
    if finish != "stop" {
        resp["status"] = serde_json::json!("incomplete");
        resp["incomplete_details"] = serde_json::json!({"reason": finish});
        out.push(sse(
            "response.incomplete",
            serde_json::json!({"type":"response.incomplete","response":resp}),
        ));
    } else {
        out.push(sse(
            "response.completed",
            serde_json::json!({"type":"response.completed","response":resp}),
        ));
    }
    out
}

fn go_client(srv: &TlsServer, pki: &Pki) -> Client {
    client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    )
}

fn events_of(r: &SendReport) -> (String, Option<(u64, u64)>, Option<String>) {
    let mut text = String::new();
    let mut usage = None;
    let mut id = None;
    for e in &r.events {
        match e {
            ModelEvent::TextDelta(t) => text.push_str(t),
            ModelEvent::Usage(u) => usage = Some((u.input_tokens, u.output_tokens)),
            ModelEvent::ResponseId(i) => id = Some(i.clone()),
            _ => {}
        }
    }
    (text, usage, id)
}

#[test]
fn a54_request_shape_headers_and_endpoint_match_the_documented_go_contract() {
    let pki = Pki::new("Go CA");
    let srv = good_server(&pki, ok_reply(realistic_stream(&["Hi"], true, "stop")));
    let c = client_for(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
        WireProfile::OpenCodeGoResponses,
        GO_PATH,
    );
    run(&c, &CancellationToken::new(), &limits()).expect("send");
    let g = srv.seen.lock().unwrap();
    let head = g.heads[0].to_ascii_lowercase();
    assert!(
        head.starts_with(&format!("post {GO_PATH} http/1.1")),
        "{head}"
    );
    for h in [
        "content-type: application/json",
        "accept: text/event-stream",
        "user-agent: nexus-native-model-only/1",
        "x-opencode-session: ",
    ] {
        assert!(head.contains(h), "missing header {h}: {head}");
    }
    assert!(head.contains(&format!("authorization: bearer {SECRET}")));
    assert_eq!(
        head.matches("x-opencode-session").count(),
        1,
        "one stable session header"
    );
    assert_eq!(head.matches("user-agent").count(), 1);
    let body: serde_json::Value = serde_json::from_slice(&g.bodies[0]).unwrap();
    let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        ["input", "max_output_tokens", "model", "reasoning", "stream"],
        "only documented Responses fields: {body}"
    );
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_output_tokens"], 1024);
    assert_eq!(body["reasoning"]["effort"], "low");
    assert!(body["input"].as_array().unwrap()[0]["role"] == "user");
    for forbidden in [
        "session",
        "metadata",
        "tools",
        "tool_choice",
        "store",
        "previous_response_id",
    ] {
        assert!(
            body.get(forbidden).is_none(),
            "{forbidden} must not be sent to Go"
        );
    }
    assert!(!String::from_utf8_lossy(&g.bodies[0]).contains(SECRET));
}

#[test]
fn a54_the_legacy_profile_still_emits_the_pre_a54_body() {
    let pki = Pki::new("Go CA");
    let srv = good_server(&pki, ok_reply(realistic_stream(&["Hi"], true, "stop")));
    let c = client_for(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
        WireProfile::Legacy,
        "/v1/responses",
    );
    run(&c, &CancellationToken::new(), &limits()).expect("send");
    let g = srv.seen.lock().unwrap();
    let body: serde_json::Value = serde_json::from_slice(&g.bodies[0]).unwrap();
    assert!(
        body.get("session").is_some()
            && body.get("metadata").is_some()
            && body.get("tools").is_some()
    );
}

#[test]
fn a54_the_go_adapter_is_pinned_to_its_documented_endpoint_without_fallback() {
    use nexus_model::{OPENCODE_GO_ORIGIN, OPENCODE_GO_RESPONSES_PATH};
    assert_eq!(OPENCODE_GO_ORIGIN, "https://opencode.ai");
    assert_eq!(
        OPENCODE_GO_RESPONSES_PATH,
        "/inference/go/openai/v1/responses"
    );
    // The production transport (enforce_pins) refuses any other origin/path
    // BEFORE any DNS query: the legacy /zen/go path, another host, a sibling path.
    for (o, p) in [
        ("https://opencode.ai", "/zen/go/v1/responses"),
        (
            "https://opencode.ai",
            "/inference/go/openai/v1/chat/completions",
        ),
        ("https://opencode.ai", "/inference/go/v1/responses"),
        (
            "https://api.openai.com",
            "/inference/go/openai/v1/responses",
        ),
        (
            "https://opencode.ai.evil.example",
            "/inference/go/openai/v1/responses",
        ),
    ] {
        let mut target = ExecutionTargetV2::test_target(o, p);
        target.wire_profile = WireProfile::OpenCodeGoResponses;
        let (issued, snapshot) = issued_for(&target);
        let pin =
            VerifiedExecutionPin::bind(TASK, "c", "a", 1, "inc", &issued, &snapshot, &target, "d")
                .unwrap();
        let binding = TransportBinding::new(o);
        let rt = OfflineModelRuntime::new(
            HttpSseTransport::new(binding.clone()),
            binding.clone(),
            TransportLimits::default(),
        );
        let prepared = rt
            .prepare(
                &pin,
                &issued,
                &snapshot,
                &target,
                &ModelRequest::text_only("user", "x"),
            )
            .unwrap();
        let attested = rt
            .attest(&pin, &issued, &snapshot, &target, prepared)
            .unwrap();
        let t = HttpSseTransport::new(binding);
        let e = t
            .send(
                &attested,
                &Credential::test_credential(SECRET),
                &CancellationToken::new(),
                &limits(),
            )
            .expect_err("pinned");
        assert_eq!(
            e.error.code,
            ModelErrorCode::EndpointMismatch,
            "{o}{p}: {}",
            e.error
        );
        assert!(!e.bytes_sent);
    }
}

#[test]
fn a54_go_adapter_refuses_tools_plaintext_and_sub_minimum_output() {
    let mut t = ExecutionTargetV2::test_target("http://127.0.0.1:9", GO_PATH);
    t.wire_profile = WireProfile::OpenCodeGoResponses;
    assert!(
        t.validate_executable().is_err(),
        "plain http is not allowed for the Go adapter"
    );
    let mut t = ExecutionTargetV2::test_target("https://opencode.ai", GO_PATH);
    t.wire_profile = WireProfile::OpenCodeGoResponses;
    t.output_limit_tokens = 8;
    assert!(
        t.validate_executable().is_err(),
        "below the provider floor of 16"
    );
    // tools are never sent
    let mut t = ExecutionTargetV2::test_target("https://opencode.ai", GO_PATH);
    t.wire_profile = WireProfile::OpenCodeGoResponses;
    let (issued, snapshot) = issued_for(&t);
    let pin =
        VerifiedExecutionPin::bind(TASK, "c", "a", 1, "inc", &issued, &snapshot, &t, "d").unwrap();
    let binding = TransportBinding::new("https://opencode.ai");
    let rt = OfflineModelRuntime::new(
        HttpSseTransport::new(binding.clone()),
        binding,
        TransportLimits::default(),
    );
    let mut req = ModelRequest::text_only("user", "x");
    req.tools.push(nexus_model::ToolDefinition {
        name: "t".into(),
        description: "d".into(),
        parameters: serde_json::json!({}),
    });
    assert!(rt.prepare(&pin, &issued, &snapshot, &t, &req).is_err());
    // a lowered cap below the floor is refused; a cap above the sealed limit too
    let mut low = ModelRequest::text_only("user", "x");
    low.max_output_tokens = Some(8);
    assert!(rt.prepare(&pin, &issued, &snapshot, &t, &low).is_err());
    let mut high = ModelRequest::text_only("user", "x");
    high.max_output_tokens = Some(10_000_000);
    assert!(rt.prepare(&pin, &issued, &snapshot, &t, &high).is_err());
    // the profile is part of the sealed extension digest, legacy digests unchanged
    let legacy = ExecutionTargetV2::test_target("https://opencode.ai", GO_PATH);
    let mut go = legacy.clone();
    go.wire_profile = WireProfile::OpenCodeGoResponses;
    assert_ne!(legacy.extension_digest(), go.extension_digest());
    assert!(!legacy.extension_canonical().contains("wireProfile"));
    assert!(go
        .extension_canonical()
        .contains("\"wireProfile\":\"opencode-go-responses\""));
}

#[test]
fn a54_realistic_stream_decodes_text_usage_finish_and_ids() {
    let pki = Pki::new("Go CA");
    let srv = good_server(
        &pki,
        Reply::Raw({
            let mut b = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream; charset=utf-8\r\nx-request-id: req_AbC-123\r\nconnection: close\r\n\r\n".to_vec();
            for f in realistic_stream(&["Hello, ", "wörld ", "✓"], true, "stop") {
                b.extend_from_slice(&f);
            }
            b
        }),
    );
    let c = go_client(&srv, &pki);
    let r = run(&c, &CancellationToken::new(), &limits()).expect("send");
    let (text, usage, id) = events_of(&r);
    assert_eq!(text, "Hello, wörld ✓");
    assert_eq!(usage, Some((12, 5)), "provider-reported usage only");
    assert_eq!(id.as_deref(), Some("resp_0123abcd"));
    assert_eq!(r.provider_request_id.as_deref(), Some("req_AbC-123"));
    assert_eq!(r.finish_reason.as_deref(), Some("stop"));
    assert!(!r.truncated);
}

#[test]
fn a54_usage_and_request_id_are_never_invented() {
    let pki = Pki::new("Go CA");
    let srv = good_server(&pki, ok_reply(realistic_stream(&["x"], false, "stop")));
    let c = go_client(&srv, &pki);
    let r = run(&c, &CancellationToken::new(), &limits()).expect("send");
    let (_, usage, _) = events_of(&r);
    assert_eq!(usage, None, "absent usage stays absent");
    assert_eq!(
        r.provider_request_id, None,
        "no request-id header, none reported"
    );
}

#[test]
fn a54_incomplete_terminal_is_reported_as_such_not_as_a_plain_stop() {
    let pki = Pki::new("Go CA");
    let srv = good_server(
        &pki,
        ok_reply(realistic_stream(&["cut off"], true, "max_output_tokens")),
    );
    let c = go_client(&srv, &pki);
    let r = run(&c, &CancellationToken::new(), &limits()).expect("send");
    assert_eq!(
        r.finish_reason.as_deref(),
        Some("incomplete:max_output_tokens")
    );
    assert!(!r.truncated);
    let (text, usage, _) = events_of(&r);
    assert_eq!(text, "cut off");
    assert_eq!(usage, Some((12, 5)));
}

#[test]
fn a54_error_events_and_unknown_events_never_look_like_success() {
    let pki = Pki::new("Go CA");
    // error event after partial output
    let mut frames = realistic_stream(&["partial "], false, "stop");
    frames.truncate(5); // created, in_progress, item added, part added, one delta
    frames.push(sse("error", serde_json::json!({"type":"error","code":"server_error","message":"secret prose must not be echoed","sequence_number":9})));
    let srv = good_server(&pki, ok_reply(frames));
    let c = go_client(&srv, &pki);
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("stream error");
    assert_eq!(e.error.code, ModelErrorCode::ProviderFailed);
    assert!(e.error.message.contains("server_error"));
    assert!(!e.error.message.contains("secret prose"));
    assert!(e.bytes_sent);
    // response.failed
    let srv = good_server(
        &pki,
        ok_reply(vec![sse(
            "response.failed",
            serde_json::json!({"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"x"}}}),
        )]),
    );
    let c = go_client(&srv, &pki);
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("failed");
    assert_eq!(e.error.code, ModelErrorCode::ProviderFailed);
    // only unknown events, no terminal: truncated, never completed
    let srv = good_server(
        &pki,
        ok_reply(vec![
            sse(
                "response.reasoning_summary_text.delta",
                serde_json::json!({"type":"response.reasoning_summary_text.delta","delta":"thinking"}),
            ),
            sse(
                "response.refusal.delta",
                serde_json::json!({"type":"response.refusal.delta","delta":"no"}),
            ),
            sse(
                "response.some_future_event",
                serde_json::json!({"type":"response.some_future_event"}),
            ),
            b"data: [DONE]\n\n".to_vec(),
        ]),
    );
    let c = go_client(&srv, &pki);
    let r = run(&c, &CancellationToken::new(), &limits()).expect("report");
    assert!(
        r.truncated && r.finish_reason.is_none(),
        "[DONE] alone is not a completion"
    );
    assert!(
        r.events.is_empty()
            || r.events
                .iter()
                .all(|e| !matches!(e, ModelEvent::TextDelta(_)))
    );
}

#[test]
fn a54_split_frames_multi_events_and_utf8_boundaries_over_the_go_stream() {
    let pki = Pki::new("Go CA");
    let all: Vec<u8> = realistic_stream(&["héllo ", "🙂 ", "done"], true, "stop").concat();
    // cut the stream into awkward chunks (inside frames and inside a multibyte char)
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut i = 0;
    for step in [7usize, 13, 5, 101, 3, 29, 400, 17] {
        if i >= all.len() {
            break;
        }
        let end = (i + step).min(all.len());
        chunks.push(all[i..end].to_vec());
        i = end;
    }
    if i < all.len() {
        chunks.push(all[i..].to_vec());
    }
    let srv = good_server(
        &pki,
        Reply::Frames {
            frames: chunks,
            gap_ms: 20,
            hold_ms: 0,
            close_notify: true,
        },
    );
    let c = go_client(&srv, &pki);
    let mut text = String::new();
    let r = c
        .transport
        .send_streaming(
            &c.attested,
            &Credential::test_credential(SECRET),
            &CancellationToken::new(),
            &limits(),
            &mut |e| {
                if let ModelEvent::TextDelta(t) = e {
                    text.push_str(t)
                }
            },
        )
        .expect("send");
    assert_eq!(
        text, "héllo 🙂 done",
        "exact text, no replacement characters"
    );
    assert_eq!(r.finish_reason.as_deref(), Some("stop"));
}

fn http_error(status: &str, headers: &str, body: &str) -> Reply {
    Reply::Raw(format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_bytes())
}

#[test]
fn a54_http_errors_are_classified_without_echoing_the_body() {
    let pki = Pki::new("Go CA");
    let hostile = "sk-LEAK-THIS-SECRET-should-never-appear";
    let cases: Vec<(&str, String, &str)> = vec![
        (
            "400 Bad Request",
            format!("{{\"error\":{{\"type\":\"MissingSessionID\",\"message\":\"{hostile}\"}}}}"),
            "x-opencode-session header is required",
        ),
        (
            "400 Bad Request",
            format!("{{\"error\":{{\"type\":\"privacy-gate\",\"message\":\"{hostile}\"}}}}"),
            "privacy opt-in",
        ),
        (
            "400 Bad Request",
            format!("{{\"error\":{{\"message\":\"Model is unavailable {hostile}\"}}}}"),
            "model unavailable",
        ),
        (
            "401 Unauthorized",
            format!("{{\"type\":\"AuthError\",\"message\":\"{hostile}\"}}"),
            "authentication or authorization rejected",
        ),
        (
            "429 Too Many Requests",
            format!("{{\"message\":\"{hostile}\"}}"),
            "rate limited",
        ),
        (
            "503 Service Unavailable",
            "{}".to_owned(),
            "provider server error",
        ),
    ];
    for (status, body, expect) in cases {
        let srv = good_server(
            &pki,
            http_error(
                status,
                "x-request-id: req_err_77\r\nretry-after: 1\r\n",
                &body,
            ),
        );
        let c = go_client(&srv, &pki);
        let e = run(&c, &CancellationToken::new(), &limits()).expect_err(status);
        assert_eq!(e.error.code, ModelErrorCode::ProviderFailed, "{status}");
        assert!(e.error.message.contains(expect), "{status}: {}", e.error);
        assert!(
            e.error.message.contains("request-id=req_err_77"),
            "{}",
            e.error
        );
        assert!(
            !e.error.message.contains(hostile) && !e.error.message.contains("LEAK"),
            "{}",
            e.error
        );
        assert!(e.error.message.contains("not retried"));
        assert_eq!(
            srv.accepted.load(Ordering::SeqCst),
            1,
            "no retry after {status}"
        );
    }
}

#[test]
fn a54_unexpected_response_shapes_fail_closed() {
    let pki = Pki::new("Go CA");
    // 200 but JSON, not an event stream
    let srv = good_server(&pki, Reply::Raw(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}".to_vec()));
    let c = go_client(&srv, &pki);
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("json 200");
    assert_eq!(e.error.code, ModelErrorCode::SseMalformed);
    // a completion with a non-completed status
    let srv = good_server(
        &pki,
        ok_reply(vec![sse(
            "response.completed",
            serde_json::json!({"type":"response.completed","response":{"status":"cancelled"}}),
        )]),
    );
    let c = go_client(&srv, &pki);
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("odd status");
    assert_eq!(e.error.code, ModelErrorCode::ProviderFailed);
    // duplicate completion
    let mut f = realistic_stream(&["a"], true, "stop");
    let last = f.last().unwrap().clone();
    f.push(last);
    let srv = good_server(&pki, ok_reply(f));
    let c = go_client(&srv, &pki);
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("dup");
    assert_eq!(e.error.code, ModelErrorCode::SseMalformed);
}

#[test]
fn registry_issued_go_extension_parses_and_digest_matches_js() {
    // Fixture produced by the real JS Registry issuer (native-intent-bridge
    // `issue`) for the operator provider `opencode-go-native`.
    let raw = include_str!("fixtures/go_issued_by_registry.json");
    let v: serde_json::Value = serde_json::from_str(raw).unwrap();
    let core: nexus_contracts::target::ExecutionTargetCoreV1 =
        serde_json::from_value(v["core"].clone()).unwrap();
    let t = nexus_model::ExecutionTargetV2::from_extension_json(core, &v["extension"])
        .expect("Rust accepts the Registry-issued Go target");
    assert_eq!(
        t.wire_profile,
        nexus_model::WireProfile::OpenCodeGoResponses
    );
    assert_eq!(t.extension_digest(), v["extensionDigest"].as_str().unwrap());
    assert_eq!(t.endpoint.origin, "https://opencode.ai");
    assert_eq!(t.endpoint.path, "/inference/go/openai/v1/responses");
}

fn chunked(body: &[u8], sizes: &[usize]) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut i, mut k) = (0usize, 0usize);
    while i < body.len() {
        let n = sizes[k % sizes.len()].min(body.len() - i);
        out.extend_from_slice(format!("{n:x}\r\n").as_bytes());
        out.extend_from_slice(&body[i..i + n]);
        out.extend_from_slice(b"\r\n");
        i += n;
        k += 1;
    }
    out.extend_from_slice(b"0\r\n\r\n");
    out
}

#[test]
fn a54_chunked_transfer_encoding_is_decoded_even_when_chunks_split_frames_and_utf8() {
    // Found by the first live attempt: the real endpoint answers with
    // `Transfer-Encoding: chunked`; chunk-size lines were parsed as SSE.
    let pki = Pki::new("Go CA");
    let mut sse_body = Vec::new();
    for f in realistic_stream(&["Hello, ", "wörld ", "✓"], true, "stop") {
        sse_body.extend_from_slice(&f);
    }
    for sizes in [vec![1usize], vec![7], vec![13, 2, 41], vec![4096]] {
        let mut b = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nx-request-id: req_chunk-1\r\nconnection: close\r\n\r\n".to_vec();
        b.extend_from_slice(&chunked(&sse_body, &sizes));
        let srv = good_server(&pki, Reply::Raw(b));
        let c = go_client(&srv, &pki);
        let r = run(&c, &CancellationToken::new(), &limits()).expect("send");
        let (text, usage, _) = events_of(&r);
        assert_eq!(text, "Hello, wörld ✓", "chunk sizes {sizes:?}");
        assert_eq!(usage, Some((12, 5)));
        assert_eq!(r.provider_request_id.as_deref(), Some("req_chunk-1"));
    }
}

#[test]
fn a54_malformed_chunk_framing_fails_closed_without_guessing() {
    let pki = Pki::new("Go CA");
    let srv = good_server(
        &pki,
        Reply::Raw(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\nZZ\r\ndata: x\r\n\r\n0\r\n\r\n".to_vec()),
    );
    let c = go_client(&srv, &pki);
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("bad chunk size");
    assert_eq!(e.error.code, ModelErrorCode::SseMalformed);
}

#[test]
fn a54_unrecognized_sse_line_reports_its_shape_not_its_content() {
    let pki = Pki::new("Go CA");
    let srv = good_server(
        &pki,
        Reply::Raw(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 40\r\nconnection: close\r\n\r\nweird-field SECRET-CONTENT-xyz\r\n\r\ndata: {}\r\n\r\n".to_vec()),
    );
    let c = go_client(&srv, &pki);
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("unknown line");
    assert!(
        e.error.message.contains("prefix 'weird-field'"),
        "{}",
        e.error.message
    );
    assert!(!e.error.message.contains("SECRET"));
}

// ---- A5.4 audit: chunked transfer-encoding hardening (local verified TLS only) ----

const CHUNK_HEAD: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";

fn good_sse() -> Vec<u8> {
    let mut b = Vec::new();
    for f in realistic_stream(&["Hello, ", "wörld ", "✓"], true, "stop") {
        b.extend_from_slice(&f);
    }
    b
}

fn send_raw(reply: Reply) -> Result<SendReport, TransportError> {
    let pki = Pki::new("Go CA");
    let srv = good_server(&pki, reply);
    let c = go_client(&srv, &pki);
    run(&c, &CancellationToken::new(), &limits())
}

fn assert_never_completed(r: Result<SendReport, TransportError>, what: &str) {
    match r {
        Err(_) => {}
        Ok(rep) => assert!(
            rep.truncated || rep.finish_reason.is_none(),
            "{what}: must not look like a clean completion: {rep:?}"
        ),
    }
}

#[test]
fn a54_chunk_boundaries_split_across_separate_tls_writes_and_reads() {
    let body = chunked(&good_sse(), &[5]);
    let mut all = CHUNK_HEAD.to_vec();
    all.extend_from_slice(&body);
    // 3-byte TLS writes: every size line, CRLF, frame and UTF-8 sequence is split.
    let pieces: Vec<Vec<u8>> = all.chunks(3).map(|c| c.to_vec()).collect();
    let r = send_raw(Reply::Pieces {
        pieces,
        gap_ms: 1,
        hold_ms: 0,
    })
    .expect("send");
    let (text, usage, _) = events_of(&r);
    assert_eq!(text, "Hello, wörld ✓");
    assert_eq!(usage, Some((12, 5)));
    assert!(!r.truncated && r.finish_reason.is_some());
}

#[test]
fn a54_many_chunks_in_one_read_extensions_and_trailers_are_accepted() {
    let sse = good_sse();
    let mut body = Vec::new();
    for part in sse.chunks(11) {
        body.extend_from_slice(format!("{:X};name=\"v;x\"\r\n", part.len()).as_bytes());
        body.extend_from_slice(part);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(b"0;last=1\r\nX-Trailer: ignored\r\nAnother: one\r\n\r\n");
    let mut all = CHUNK_HEAD.to_vec();
    all.extend_from_slice(&body);
    let r = send_raw(Reply::Raw(all)).expect("send");
    let (text, _, _) = events_of(&r);
    assert_eq!(text, "Hello, wörld ✓");
    assert!(!r.truncated);
}

#[test]
fn a54_sse_events_spanning_chunks_arrive_in_order_exactly_once() {
    let sse = good_sse();
    let mut all = CHUNK_HEAD.to_vec();
    all.extend_from_slice(&chunked(&sse, &[1, 2, 3, 97]));
    let r = send_raw(Reply::Raw(all)).expect("send");
    let (text, _, id) = events_of(&r);
    assert_eq!(text, "Hello, wörld ✓", "no duplicated or dropped delta");
    assert_eq!(id.as_deref(), Some("resp_0123abcd"));
}

#[test]
fn a54_premature_eof_and_missing_terminal_chunk_never_become_completions() {
    // every frame is valid and response.completed arrived, but the terminal chunk did not
    let mut body = chunked(&good_sse(), &[64]);
    body.truncate(body.len() - 5); // drop "0\r\n\r\n"
    let mut all = CHUNK_HEAD.to_vec();
    all.extend_from_slice(&body);
    let r = send_raw(Reply::Raw(all.clone()));
    assert_never_completed(r, "missing terminal chunk");
    // cut in the middle of a chunk
    let cut = all.len() - 40;
    let r = send_raw(Reply::Raw(all[..cut].to_vec()));
    assert_never_completed(r, "EOF inside a chunk");
    // cut inside a size line
    let mut all2 = CHUNK_HEAD.to_vec();
    all2.extend_from_slice(b"4");
    assert_never_completed(send_raw(Reply::Raw(all2)), "EOF inside a size line");
    // headers only, then EOF
    assert_never_completed(send_raw(Reply::Raw(CHUNK_HEAD.to_vec())), "no body");
}

#[test]
fn a54_malformed_framing_and_hostile_sizes_fail_closed() {
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("non-hex size", b"ZZ\r\ndata: {}\r\n\r\n0\r\n\r\n".to_vec()),
        ("0x prefix", b"0x5\r\nhello\r\n0\r\n\r\n".to_vec()),
        ("negative", b"-5\r\nhello\r\n0\r\n\r\n".to_vec()),
        ("empty size", b"\r\nhello\r\n0\r\n\r\n".to_vec()),
        (
            "data not followed by CRLF",
            b"5\r\nhelloXX0\r\n\r\n".to_vec(),
        ),
        (
            "size overflow digits",
            b"fffffffffffffffff\r\nx\r\n".to_vec(),
        ),
        ("huge declared chunk", b"ffffffff\r\nx\r\n".to_vec()),
        ("bare LF framing", b"5\nhello\n0\n\n".to_vec()),
        ("space padded", b" 5 \r\nhello\r\n0\r\n\r\n".to_vec()),
    ];
    for (name, body) in cases {
        let mut all = CHUNK_HEAD.to_vec();
        all.extend_from_slice(&body);
        assert_never_completed(send_raw(Reply::Raw(all)), name);
    }
}

#[test]
fn a54_conflicting_or_stacked_framing_headers_are_refused() {
    let mk = |head: &str| {
        let mut all = head.as_bytes().to_vec();
        all.extend_from_slice(&chunked(&good_sse(), &[64]));
        all
    };
    for (name, head) in [
        ("content-length + chunked", "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 10\r\ntransfer-encoding: chunked\r\n\r\n"),
        ("gzip, chunked", "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: gzip, chunked\r\n\r\n"),
        ("duplicate TE", "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\ntransfer-encoding: chunked\r\n\r\n"),
        ("unknown TE", "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: weird\r\n\r\n"),
        ("content-encoding gzip", "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-encoding: gzip\r\ntransfer-encoding: chunked\r\n\r\n"),
    ] {
        let r = send_raw(Reply::Raw(mk(head)));
        match r {
            Err(e) => assert_eq!(e.error.code, ModelErrorCode::SseMalformed, "{name}"),
            Ok(rep) => panic!("{name}: accepted: {rep:?}"),
        }
    }
}

#[test]
fn a54_chunked_flood_is_bounded_by_the_transport_cap() {
    let pki = Pki::new("Go CA");
    let big = vec![b'a'; 64 * 1024];
    let mut pieces = vec![CHUNK_HEAD.to_vec()];
    for _ in 0..64 {
        let mut c = format!("{:x}\r\n", big.len()).into_bytes();
        c.extend_from_slice(&big);
        c.extend_from_slice(b"\r\n");
        pieces.push(c);
    }
    let srv = good_server(
        &pki,
        Reply::Pieces {
            pieces,
            gap_ms: 0,
            hold_ms: 0,
        },
    );
    let c = go_client(&srv, &pki);
    let mut l = limits();
    l.max_text_bytes = 16 * 1024;
    l.max_arg_bytes = 16 * 1024; // cap = 32 KiB + 64 KiB framing, far below the 4 MiB sent
    let e = run(&c, &CancellationToken::new(), &l).expect_err("flood");
    assert_eq!(e.error.code, ModelErrorCode::PayloadTooLarge);
}

#[test]
fn a54_cancellation_during_a_chunked_stream_is_not_a_completion() {
    let pki = Pki::new("Go CA");
    let sse = good_sse();
    let all_body = chunked(&sse, &[16]);
    let mut pieces = vec![CHUNK_HEAD.to_vec()];
    for p in all_body.chunks(40) {
        pieces.push(p.to_vec());
    }
    let srv = good_server(
        &pki,
        Reply::Pieces {
            pieces,
            gap_ms: 60,
            hold_ms: 0,
        },
    );
    let c = go_client(&srv, &pki);
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        c2.cancel();
    });
    let r = run(&c, &cancel, &limits());
    match r {
        Err(e) => assert_eq!(e.error.code, ModelErrorCode::Cancelled),
        Ok(rep) => panic!("cancelled stream reported as data: {rep:?}"),
    }
}
