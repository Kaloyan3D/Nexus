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
use std::time::{Duration, Instant};

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
    /// Complete the handshake and read the request, then never answer.
    Silence(u64),
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
                Reply::Redirect(loc) => {
                    let _ = tls.write_all(
                        format!("HTTP/1.1 302 Found\r\nlocation: {loc}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes(),
                    );
                    let _ = tls.flush();
                    tls.conn.send_close_notify();
                    let _ = tls.flush();
                }
                Reply::Silence(ms) => std::thread::sleep(Duration::from_millis(*ms)),
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
    let target = ExecutionTargetV2::test_target(origin, "/v1/responses");
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

// ------------------------------------------------------------------ tests

#[test]
fn a52_01_valid_handshake_streams_over_tls_with_sni_and_credential_after_verify() {
    let pki = Pki::new("Nexus Test CA");
    let srv = good_server(
        &pki,
        ok_reply(vec![delta("Hello "), delta("TLS"), completed()]),
    );
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let mut seen_text = String::new();
    let report = c
        .transport
        .send_streaming(
            &c.attested,
            &Credential::test_credential(SECRET),
            &CancellationToken::new(),
            &limits(),
            &mut |e| {
                if let ModelEvent::TextDelta(t) = e {
                    seen_text.push_str(t);
                }
            },
        )
        .expect("tls send");
    assert_eq!(seen_text, "Hello TLS");
    assert_eq!(report.finish_reason.as_deref(), Some("stop"));
    assert_eq!(report.http_status, Some(200));
    let g = srv.seen.lock().expect("mutex");
    assert_eq!(
        g.sni[0].as_deref(),
        Some(HOST),
        "SNI is the original host name"
    );
    assert!(
        g.versions[0].contains("TLSv1_3"),
        "TLS 1.3 preferred: {}",
        g.versions[0]
    );
    assert_eq!(g.alpn[0].as_deref(), Some(&b"http/1.1"[..]));
    assert!(g.heads[0]
        .to_ascii_lowercase()
        .contains(&format!("authorization: bearer {SECRET}")));
    assert!(g.heads[0]
        .to_ascii_lowercase()
        .contains(&format!("host: {HOST}:{}", srv.port)));
    assert!(!String::from_utf8_lossy(&g.bodies[0]).contains(SECRET));
    assert_eq!(c.resolver.calls(), 1);
}

#[test]
fn a52_02_untrusted_certificate_is_refused_and_no_credential_is_sent() {
    let server_pki = Pki::new("Rogue CA");
    let client_pki = Pki::new("Trusted CA");
    let srv = good_server(&server_pki, ok_reply(vec![completed()]));
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        client_pki.client_config(),
    );
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("untrusted");
    assert_eq!(e.error.code, ModelErrorCode::TlsFailed, "{}", e.error);
    assert!(!e.bytes_sent);
    assert!(e.error.message.contains("not trusted"), "{}", e.error);
    assert!(!e.error.message.contains(SECRET));
    std::thread::sleep(Duration::from_millis(100));
    no_credential_seen(&srv);
}

#[test]
fn a52_03_wrong_certificate_hostname_is_refused() {
    let pki = Pki::new("Nexus Test CA");
    let (cert, key) = pki.leaf("other", "other.example.test", false);
    let srv = start_tls(server_config(&cert, &key), ok_reply(vec![completed()]));
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("wrong name");
    assert_eq!(e.error.code, ModelErrorCode::TlsFailed);
    assert!(e.error.message.contains("host name"), "{}", e.error);
    assert!(!e.bytes_sent);
    std::thread::sleep(Duration::from_millis(100));
    no_credential_seen(&srv);
}

#[test]
fn a52_04_expired_certificate_is_refused() {
    let pki = Pki::new("Nexus Test CA");
    let (cert, key) = pki.leaf("old", HOST, true);
    let srv = start_tls(server_config(&cert, &key), ok_reply(vec![completed()]));
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("expired");
    assert_eq!(e.error.code, ModelErrorCode::TlsFailed);
    assert!(e.error.message.contains("expired"), "{}", e.error);
    std::thread::sleep(Duration::from_millis(100));
    no_credential_seen(&srv);
}

#[test]
fn a52_05_plaintext_downgrade_never_receives_the_credential() {
    // A server that answers the TLS ClientHello with plaintext HTTP.
    let l = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = l.local_addr().unwrap().port();
    let got = Arc::new(Mutex::new(Vec::<u8>::new()));
    let g2 = got.clone();
    std::thread::spawn(move || {
        if let Ok((mut s, _)) = l.accept() {
            s.set_read_timeout(Some(Duration::from_secs(2))).ok();
            let mut b = [0u8; 4096];
            if let Ok(n) = s.read(&mut b) {
                g2.lock().unwrap().extend_from_slice(&b[..n]);
            }
            let _ = s.write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\ndata: x\n\n",
            );
            std::thread::sleep(Duration::from_millis(300));
        }
    });
    let pki = Pki::new("Nexus Test CA");
    let c = client(
        &origin(port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("downgrade");
    assert_eq!(e.error.code, ModelErrorCode::TlsFailed, "{}", e.error);
    assert!(!e.bytes_sent);
    let bytes = got.lock().unwrap().clone();
    assert!(!bytes.is_empty(), "the server did receive the ClientHello");
    assert!(
        !String::from_utf8_lossy(&bytes).contains(SECRET)
            && !String::from_utf8_lossy(&bytes).contains("POST "),
        "only TLS handshake bytes were sent"
    );
    // An https origin can never be satisfied by a plaintext scheme change:
    // the binding is exact.
    let wrong = TransportBinding::new(&format!("http://{HOST}:{port}"));
    assert!(wrong.check(&origin(port)).is_err());
}

#[test]
fn a52_06_to_09_dns_policy_refuses_every_prohibited_answer_before_any_socket() {
    let pki = Pki::new("Nexus Test CA");
    let cases: Vec<(&str, Vec<IpAddr>)> = vec![
        ("loopback", vec!["127.0.0.1".parse().unwrap()]),
        ("private", vec!["10.1.2.3".parse().unwrap()]),
        (
            "link-local-metadata",
            vec!["169.254.169.254".parse().unwrap()],
        ),
        (
            "mixed public+private",
            vec![
                "93.184.216.34".parse().unwrap(),
                "192.168.0.7".parse().unwrap(),
            ],
        ),
        (
            "mixed private-last",
            vec![
                "10.0.0.1".parse().unwrap(),
                "93.184.216.34".parse().unwrap(),
            ],
        ),
        (
            "ipv4-mapped loopback",
            vec!["::ffff:127.0.0.1".parse().unwrap()],
        ),
        (
            "ipv4-mapped private",
            vec!["::ffff:10.0.0.9".parse().unwrap()],
        ),
        ("ipv6 loopback", vec!["::1".parse().unwrap()]),
        ("ula", vec!["fd00::5".parse().unwrap()]),
        ("multicast", vec!["224.0.0.1".parse().unwrap()]),
        (
            "6to4 embedding loopback",
            vec!["2002:7f00:1::1".parse().unwrap()],
        ),
        ("unspecified", vec!["0.0.0.0".parse().unwrap()]),
        ("empty", vec![]),
    ];
    for (name, ips) in cases {
        let c = client(
            "https://api.provider.test:443",
            vec![ips],
            AddressPolicy::PublicOnly,
            pki.client_config(),
        );
        let started = Instant::now();
        let e = run(&c, &CancellationToken::new(), &limits()).expect_err(name);
        assert_eq!(
            e.error.code,
            ModelErrorCode::DestinationRefused,
            "{name}: {}",
            e.error
        );
        assert!(!e.bytes_sent, "{name}");
        assert_eq!(c.resolver.calls(), 1, "{name}: resolved exactly once");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{name}: refused without connecting"
        );
    }
}

#[test]
fn a52_10_dns_rebinding_between_validation_and_connect_cannot_redirect_the_connection() {
    // First answer: the fixture. Any second resolution would answer with a
    // metadata address. The transport must resolve once and connect by IP.
    let pki = Pki::new("Nexus Test CA");
    let srv = good_server(&pki, ok_reply(vec![delta("pinned"), completed()]));
    let c = client(
        &origin(srv.port),
        vec![
            vec!["127.0.0.1".parse().unwrap()],
            vec!["169.254.169.254".parse().unwrap()],
        ],
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let r = run(&c, &CancellationToken::new(), &limits()).expect("send");
    assert_eq!(r.finish_reason.as_deref(), Some("stop"));
    assert_eq!(
        c.resolver.calls(),
        1,
        "never re-resolved between policy check and connect"
    );
    assert_eq!(srv.accepted.load(Ordering::SeqCst), 1);
}

#[test]
fn a52_11_redirect_to_localhost_or_private_is_refused_and_not_followed() {
    let pki = Pki::new("Nexus Test CA");
    let private = TcpListener::bind("127.0.0.1:0").expect("private target");
    private.set_nonblocking(true).unwrap();
    let loc = format!(
        "https://127.0.0.1:{}/steal",
        private.local_addr().unwrap().port()
    );
    let srv = good_server(&pki, Reply::Redirect(loc));
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("redirect");
    assert_eq!(e.error.code, ModelErrorCode::RedirectRefused);
    std::thread::sleep(Duration::from_millis(150));
    assert!(private.accept().is_err(), "redirect target was contacted");
    assert_eq!(srv.accepted.load(Ordering::SeqCst), 1);
    // The credential went to the sealed origin only (inside TLS), once.
    let g = srv.seen.lock().unwrap();
    assert_eq!(g.heads.len(), 1);
}

#[test]
fn a52_12_proxy_environment_variables_are_never_consulted() {
    let proxy = TcpListener::bind("127.0.0.1:0").expect("proxy");
    proxy.set_nonblocking(true).unwrap();
    let p = format!("http://127.0.0.1:{}", proxy.local_addr().unwrap().port());
    for k in [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        std::env::set_var(k, &p);
    }
    std::env::set_var("NO_PROXY", "");
    let pki = Pki::new("Nexus Test CA");
    let srv = good_server(&pki, ok_reply(vec![delta("direct"), completed()]));
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let r = run(&c, &CancellationToken::new(), &limits()).expect("send");
    assert_eq!(r.finish_reason.as_deref(), Some("stop"));
    std::thread::sleep(Duration::from_millis(100));
    assert!(proxy.accept().is_err(), "a proxy was contacted");
    assert_eq!(srv.accepted.load(Ordering::SeqCst), 1);
    // And the source has no environment-proxy code path at all.
    for src in [
        include_str!("../src/transport.rs"),
        include_str!("../src/egress.rs"),
    ] {
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains("env::var"),
            "transport code must not read the environment"
        );
        assert!(
            !code.contains("dangerous"),
            "no verification bypass API may be used"
        );
    }
}

#[test]
fn a52_13_authorization_is_attached_only_to_the_sealed_origin_after_tls() {
    let pki = Pki::new("Nexus Test CA");
    // A second, *trusted* TLS server the redirect points at: it must see 0.
    let other = good_server(&pki, ok_reply(vec![completed()]));
    let loc = format!("https://{HOST}:{}/elsewhere", other.port);
    let srv = good_server(&pki, Reply::Redirect(loc));
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let _ = run(&c, &CancellationToken::new(), &limits());
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        other.accepted.load(Ordering::SeqCst),
        0,
        "no forwarding on redirect"
    );
    assert!(other.seen.lock().unwrap().heads.is_empty());
    // Exactly one authorization header on the one request line.
    let g = srv.seen.lock().unwrap();
    let h = g.heads[0].to_ascii_lowercase();
    assert_eq!(h.matches("authorization:").count(), 1);
    assert!(h.starts_with("post /v1/responses http/1.1"));
}

#[test]
fn a52_14_cancellation_during_tls_handshake_returns_promptly_with_nothing_sent() {
    // Accepts TCP and then says nothing: the handshake can never finish.
    let l = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((s, _)) = l.accept() {
            std::thread::sleep(Duration::from_secs(6));
            drop(s);
        }
    });
    let pki = Pki::new("Nexus Test CA");
    let c = client(
        &origin(port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let token = CancellationToken::new();
    let t2 = token.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        t2.cancel();
    });
    let started = Instant::now();
    let e = run(&c, &token, &limits()).expect_err("cancelled");
    assert_eq!(e.error.code, ModelErrorCode::Cancelled, "{}", e.error);
    assert!(
        !e.bytes_sent,
        "cancel before the handshake finished sent nothing"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a52_14b_stalled_handshake_hits_the_exchange_deadline() {
    let l = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((s, _)) = l.accept() {
            std::thread::sleep(Duration::from_secs(4));
            drop(s);
        }
    });
    let pki = Pki::new("Nexus Test CA");
    let c = client(
        &origin(port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let l = TransportLimits {
        total_timeout_ms: 500,
        ..limits()
    };
    let started = Instant::now();
    let e = run(&c, &CancellationToken::new(), &l).expect_err("deadline");
    assert_eq!(e.error.code, ModelErrorCode::Timeout, "{}", e.error);
    assert!(!e.bytes_sent);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn a52_15_stream_cut_without_close_notify_is_truncated_not_complete() {
    let pki = Pki::new("Nexus Test CA");
    let srv = good_server(
        &pki,
        Reply::Frames {
            frames: vec![delta("partial ")],
            gap_ms: 0,
            hold_ms: 0,
            close_notify: false,
        },
    );
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let r = run(&c, &CancellationToken::new(), &limits()).expect("report");
    assert!(r.truncated && r.finish_reason.is_none());
    assert!(r
        .events
        .iter()
        .any(|e| matches!(e, ModelEvent::TextDelta(t) if t == "partial ")));
}

#[test]
fn a52_16_malformed_and_oversized_sse_over_tls_fail_closed() {
    let pki = Pki::new("Nexus Test CA");
    let srv = good_server(
        &pki,
        ok_reply(vec![delta("ok"), b"data: {not json}\n\n".to_vec()]),
    );
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let e = run(&c, &CancellationToken::new(), &limits()).expect_err("malformed");
    assert_eq!(e.error.code, ModelErrorCode::SseMalformed);

    let big = delta(&"x".repeat(4_000));
    let srv = good_server(&pki, ok_reply(vec![big; 200]));
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let l = TransportLimits {
        max_text_bytes: 2_048,
        max_arg_bytes: 512,
        ..limits()
    };
    let e = run(&c, &CancellationToken::new(), &l).expect_err("oversized");
    assert_eq!(e.error.code, ModelErrorCode::PayloadTooLarge);
}

#[test]
fn a52_stream_framing_utf8_boundaries_multi_events_and_partial_frames() {
    // One TLS record carries three events; another splits a multibyte
    // character and a frame across writes with pauses.
    let pki = Pki::new("Nexus Test CA");
    let whole = [delta("a"), delta("é"), delta("✓")].concat();
    let split = delta("ünï-🙂");
    let mid = split.len() / 2 + 1; // lands inside a multibyte sequence
    let frames = vec![
        whole,
        split[..mid].to_vec(),
        split[mid..].to_vec(),
        completed(),
    ];
    let srv = good_server(
        &pki,
        Reply::Frames {
            frames,
            gap_ms: 80,
            hold_ms: 0,
            close_notify: true,
        },
    );
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
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
                    text.push_str(t);
                }
            },
        )
        .expect("send");
    assert_eq!(
        text, "aé✓ünï-🙂",
        "no replacement characters, no duplicates, wire order"
    );
    assert!(!r.truncated);
}

#[test]
fn a52_ip_literal_and_obfuscated_destinations_are_refused_at_both_layers() {
    let resolver = ScriptedResolver::new(vec![vec![]]);
    for o in [
        "https://10.0.0.1:443",
        "https://[::1]:443",
        "https://127.0.0.1:443",
        "https://169.254.169.254:443",
        "https://2130706433:443",
        "https://0x7f.0.0.1:443",
        "https://localhost:443",
        "https://metadata:443",
    ] {
        // Layer 1: the sealed target is not executable.
        let t = ExecutionTargetV2::test_target(o, "/v1/responses");
        assert!(t.validate_executable().is_err(), "{o}: target validation");
        // Layer 2: the egress policy refuses before any resolver query.
        let e = egress::approve_destination(o, &resolver, AddressPolicy::PublicOnly).expect_err(o);
        assert_eq!(e.code, ModelErrorCode::DestinationRefused, "{o}: {e}");
    }
    assert_eq!(
        resolver.calls(),
        0,
        "no DNS query for syntactically prohibited hosts"
    );
    // A public IP literal is approved WITHOUT any DNS query.
    let ok = egress::approve_destination(
        "https://93.184.216.34:443",
        &resolver,
        AddressPolicy::PublicOnly,
    )
    .expect("public literal");
    assert_eq!(ok.addrs.len(), 1);
    assert_eq!(resolver.calls(), 0);
    // Plain http is loopback-only, for literals and for resolved names.
    assert!(egress::approve_destination(
        "http://93.184.216.34:80",
        &resolver,
        AddressPolicy::PublicOnly
    )
    .is_err());
    assert!(egress::approve_destination(
        "http://127.0.0.1:8080",
        &resolver,
        AddressPolicy::PublicOnly
    )
    .is_ok());
    let rs = ScriptedResolver::new(vec![vec!["93.184.216.34".parse().unwrap()]]);
    assert!(egress::approve_destination(
        "http://api.provider.test:80",
        &rs,
        AddressPolicy::PublicOnly
    )
    .is_err());
}

#[test]
fn a52_cancellation_and_deadline_during_dns_resolution_are_prompt() {
    let pki = Pki::new("Nexus Test CA");
    // A resolver that takes 5 s: the exchange must not wait for it.
    let mk = || {
        let target =
            ExecutionTargetV2::test_target("https://api.provider.test:443", "/v1/responses");
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
        let binding = TransportBinding::new("https://api.provider.test:443");
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
                &ModelRequest::text_only("user", "hi"),
            )
            .expect("prepare");
        let attested = rt
            .attest(&pin, &issued, &snapshot, &target, prepared)
            .expect("attest");
        let resolver = Arc::new(
            ScriptedResolver::new(vec![vec!["93.184.216.34".parse().unwrap()]])
                .with_delay_ms(5_000),
        );
        let t = HttpSseTransport::with_parts(
            binding,
            resolver,
            AddressPolicy::PublicOnly,
            pki.client_config(),
        );
        (t, attested)
    };
    // Cancellation.
    let (t, a) = mk();
    let token = CancellationToken::new();
    let t2 = token.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        t2.cancel();
    });
    let started = Instant::now();
    let e = t
        .send(&a, &Credential::test_credential(SECRET), &token, &limits())
        .expect_err("cancelled in DNS");
    assert_eq!(e.error.code, ModelErrorCode::Cancelled, "{}", e.error);
    assert!(!e.bytes_sent);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    // Deadline.
    let (t, a) = mk();
    let l = TransportLimits {
        total_timeout_ms: 400,
        ..limits()
    };
    let started = Instant::now();
    let e = t
        .send(
            &a,
            &Credential::test_credential(SECRET),
            &CancellationToken::new(),
            &l,
        )
        .expect_err("deadline in DNS");
    assert_eq!(e.error.code, ModelErrorCode::Timeout, "{}", e.error);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn a52_provider_silence_after_a_verified_handshake_is_an_uncertain_timeout() {
    let pki = Pki::new("Nexus Test CA");
    let srv = good_server(&pki, Reply::Silence(3_000));
    let c = client(
        &origin(srv.port),
        loopback(),
        AddressPolicy::PublicOrLoopbackForTests,
        pki.client_config(),
    );
    let l = TransportLimits {
        read_timeout_ms: 300,
        ..limits()
    };
    let started = Instant::now();
    let e = run(&c, &CancellationToken::new(), &l).expect_err("silence");
    assert_eq!(e.error.code, ModelErrorCode::Timeout, "{}", e.error);
    assert!(
        e.bytes_sent,
        "the request was written: outcome unknown, never retried"
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(srv.accepted.load(Ordering::SeqCst), 1, "no reconnect");
    assert_eq!(c.resolver.calls(), 1, "no re-resolution");
}
