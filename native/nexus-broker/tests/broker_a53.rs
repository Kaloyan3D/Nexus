//! A5.3 offline acceptance: CLI -> broker -> Controller bridge -> Registry
//! -> daemon grant -> HTTPS executor, against a REAL nexusd, the REAL JS
//! Registry/Controller code and a local verified-TLS provider fixture.
//! No real provider, no real credential, nothing leaves 127.0.0.1.

use nexus_broker::store::{RunRecord, Store};
use nexus_broker::{BrokerConfig, BrokerHandle};
use nexus_client::intent_client as ic;
use nexus_client::intent_contract::{IntentLimits, ModelSelection, NexusIntentV1, ResponseMode};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SECRET: &str = "sk-a53-secret-marker-5d2e";
const HOST: &str = "api.provider.test";
const CRED_REF: &str = "credential://connections/conn-e2e-mock";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn native_bin(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("target")
        .join("debug")
        .join(name)
}

fn node_json(args: &[&str]) -> serde_json::Value {
    let driver = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("nexus-daemon")
        .join("tests")
        .join("e2e")
        .join("driver.cjs");
    let out = Command::new("node")
        .arg(driver)
        .args(args)
        .output()
        .expect("node");
    // Keep the driver's own output in the failure message: a bare exit code
    // hid the cause of an earlier transient failure.
    assert!(
        out.status.success(),
        "driver {:?} exited {:?}\nstdout: {}\nstderr: {}",
        args[0],
        out.status.code(),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
            .chars()
            .rev()
            .take(1500)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    );
    serde_json::from_slice(&out.stdout).expect("json line")
}

// ------------------------------------------------------------------ PKI

struct Pki {
    dir: tempfile::TempDir,
    ca_der: Vec<u8>,
}

fn sh(dir: &Path, args: &[&str]) {
    let o = Command::new("openssl")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("openssl");
    assert!(
        o.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
}

impl Pki {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("pki");
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
                "/CN=A53 Test CA",
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
        let ca_der = std::fs::read(d.join("ca.der")).unwrap();
        Self { dir, ca_der }
    }
    fn leaf(&self) -> (Vec<u8>, Vec<u8>) {
        let d = self.dir.path();
        sh(
            d,
            &[
                "ecparam",
                "-name",
                "prime256v1",
                "-genkey",
                "-noout",
                "-out",
                "l.key",
            ],
        );
        sh(
            d,
            &[
                "req", "-new", "-key", "l.key", "-subj", "/CN=leaf", "-out", "l.csr",
            ],
        );
        std::fs::write(d.join("l.ext"), format!("subjectAltName=DNS:{HOST}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\n")).unwrap();
        sh(
            d,
            &[
                "x509",
                "-req",
                "-in",
                "l.csr",
                "-CA",
                "ca.pem",
                "-CAkey",
                "ca.key",
                "-CAcreateserial",
                "-out",
                "l.pem",
                "-days",
                "1",
                "-extfile",
                "l.ext",
            ],
        );
        sh(
            d,
            &["x509", "-in", "l.pem", "-outform", "DER", "-out", "l.der"],
        );
        sh(
            d,
            &[
                "pkcs8", "-topk8", "-nocrypt", "-in", "l.key", "-outform", "DER", "-out", "l.pk8",
            ],
        );
        (
            std::fs::read(d.join("l.der")).unwrap(),
            std::fs::read(d.join("l.pk8")).unwrap(),
        )
    }
}

// ------------------------------------------------------------- provider

#[derive(Clone)]
enum Reply {
    Frames {
        frames: Vec<String>,
        gap_ms: u64,
        hold_ms: u64,
    },
    /// Read the request, then close without answering (uncertain submission).
    CloseSilently,
    /// Accept TCP and never speak TLS (handshake can't complete).
    HandshakeStall,
}

type Recorded = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

struct Provider {
    port: u16,
    accepted: Arc<AtomicUsize>,
    requests: Recorded,
}

fn delta(t: &str) -> String {
    format!(
        "data: {{\"type\":\"response.output_text.delta\",\"delta\":{}}}\n\n",
        serde_json::json!(t)
    )
}

fn completed() -> String {
    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":7,\"output_tokens\":9}}}\n\n".to_owned()
}

fn bind() -> (TcpListener, u16) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let p = l.local_addr().unwrap().port();
    (l, p)
}

fn serve(l: TcpListener, pki: &Pki, reply: Reply) -> Provider {
    let port = l.local_addr().unwrap().port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let requests: Recorded = Arc::new(Mutex::new(Vec::new()));
    let (a, r) = (accepted.clone(), requests.clone());
    let (cert, key) = pki.leaf();
    let cfg = Arc::new(
        rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert)],
            PrivateKeyDer::from(PrivatePkcs8KeyDer::from(key)),
        )
        .unwrap(),
    );
    std::thread::spawn(move || {
        for _ in 0..6 {
            let Ok((tcp, _)) = l.accept() else { return };
            a.fetch_add(1, Ordering::SeqCst);
            if matches!(reply, Reply::HandshakeStall) {
                std::thread::sleep(Duration::from_secs(8));
                continue;
            }
            tcp.set_read_timeout(Some(Duration::from_secs(5))).ok();
            let Ok(conn) = rustls::ServerConnection::new(cfg.clone()) else {
                return;
            };
            let mut s = rustls::StreamOwned::new(conn, tcp);
            let (mut buf, mut tmp, mut at) = (Vec::new(), [0u8; 4096], None);
            while at.is_none() {
                match s.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        at = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4);
                    }
                }
            }
            let Some(at) = at else { continue };
            let head = String::from_utf8_lossy(&buf[..at]).into_owned();
            let want: usize = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse().ok())
                })
                .unwrap_or(0);
            let mut body = buf[at..].to_vec();
            while body.len() < want {
                match s.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => body.extend_from_slice(&tmp[..n]),
                }
            }
            r.lock().unwrap().push((head, body));
            if let Reply::Frames {
                frames,
                gap_ms,
                hold_ms,
            } = &reply
            {
                {
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n");
                    let _ = s.flush();
                    for f in frames {
                        if s.write_all(f.as_bytes()).is_err() {
                            break;
                        }
                        let _ = s.flush();
                        std::thread::sleep(Duration::from_millis(*gap_ms));
                    }
                    std::thread::sleep(Duration::from_millis(*hold_ms));
                    s.conn.send_close_notify();
                    let _ = s.flush();
                }
            }
        }
    });
    Provider {
        port,
        accepted,
        requests,
    }
}

// -------------------------------------------------------------- fixture

struct Fx {
    tmp: tempfile::TempDir,
    daemon: Child,
    daemon_socket: PathBuf,
    daemon_db: PathBuf,
    daemon_witness: PathBuf,
    cap: PathBuf,
    provider: Provider,
    pki: Pki,
    creds: PathBuf,
    registry: PathBuf,
}

fn own_uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn health(socket: &Path) -> bool {
    use std::os::unix::net::UnixStream;
    let Ok(mut s) = UnixStream::connect(socket) else {
        return false;
    };
    s.set_read_timeout(Some(Duration::from_secs(2))).ok();
    let _ = s.write_all(b"{\"protocol\":1,\"id\":\"h\",\"cmd\":\"health\",\"params\":{}}\n");
    let mut line = String::new();
    let _ = std::io::BufRead::read_line(&mut std::io::BufReader::new(s), &mut line);
    line.contains("\"ok\":true")
}

fn spawn_daemon(
    tmp: &Path,
    db: &Path,
    wit: &Path,
    socket: &Path,
    cap: &Path,
    pilot: bool,
) -> Child {
    let uid = own_uid().to_string();
    let mut c = Command::new(
        std::env::var("NEXUSD_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|_| native_bin("nexusd")),
    );
    c.arg("--db")
        .arg(db)
        .arg("--socket")
        .arg(socket)
        .arg("--cap")
        .arg(cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(wit)
        .args(["--allowed-uids", &uid]);
    if pilot {
        c.arg("--enable-model-pilot");
    }
    c.stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir(tmp);
    let child = c.spawn().expect("spawn nexusd");
    let deadline = Instant::now() + Duration::from_secs(15);
    while !health(socket) {
        assert!(Instant::now() < deadline, "nexusd never became ready");
        std::thread::sleep(Duration::from_millis(30));
    }
    child
}

fn kill(c: &mut Child) {
    let _ = c.kill();
    let _ = c.wait();
}

fn fixture(reply: Reply, pilot: bool) -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let pki = Pki::new();
    let (l, port) = bind();
    let provider = serve(l, &pki, reply);
    let registry = tmp.path().join("registry");
    std::fs::create_dir_all(&registry).unwrap();
    let repo = repo_root();
    let reg = node_json(&[
        "registry",
        registry.to_str().unwrap(),
        repo.to_str().unwrap(),
        &port.to_string(),
        &format!("https://{HOST}:{port}/v1"),
        "openai-responses",
    ]);
    assert_eq!(reg["ok"], true, "{reg}");
    let ddir = tmp.path().join("daemon");
    std::fs::create_dir_all(&ddir).unwrap();
    std::fs::set_permissions(&ddir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (db, wit, socket, cap) = (
        ddir.join("k.db"),
        ddir.join("k.wit.db"),
        ddir.join("n.sock"),
        ddir.join("issuer.cap"),
    );
    let daemon = spawn_daemon(tmp.path(), &db, &wit, &socket, &cap, pilot);
    let creds = tmp.path().join("provider-credentials.json");
    std::fs::write(&creds, serde_json::json!({ CRED_REF: SECRET }).to_string()).unwrap();
    std::fs::set_permissions(&creds, std::fs::Permissions::from_mode(0o600)).unwrap();
    Fx {
        tmp,
        daemon,
        daemon_socket: socket,
        daemon_db: db,
        daemon_witness: wit,
        cap,
        provider,
        pki,
        creds,
        registry,
    }
}

impl Fx {
    fn config(&self, name: &str) -> BrokerConfig {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(CertificateDer::from(self.pki.ca_der.clone()))
            .unwrap();
        let tls = nexus_model::egress::tls_config_with_roots(roots);
        let factory = nexus_client::TransportFactory(Arc::new(move |binding| {
            nexus_model::HttpSseTransport::with_parts(
                binding,
                Arc::new(nexus_model::testkit::ScriptedResolver::new(vec![vec![
                    "127.0.0.1".parse().unwrap(),
                ]])),
                nexus_model::egress::AddressPolicy::PublicOrLoopbackForTests,
                tls.clone(),
            )
        }));
        let root = self.tmp.path();
        BrokerConfig {
            state_dir: root.join(format!("broker-{name}")),
            socket_path: root.join(format!("broker-{name}.sock")),
            socket_group: None,
            allowed_uids: vec![],
            daemon_socket: self.daemon_socket.clone(),
            cap_path: self.cap.clone(),
            credentials_path: self.creds.clone(),
            transcript_dir: root.join("transcripts"),
            repo_root: repo_root(),
            registry_data_root: self.registry.clone(),
            ledger_workspace: root.join("intent-ledger"),
            node: "node".into(),
            extra_trusted_owner_uids: vec![],
            max_active: 4,
            rate_per_minute: 50,
            limits: nexus_client::TransportLimits {
                read_timeout_ms: 3_000,
                total_timeout_ms: 30_000,
                ..Default::default()
            },
            allow_models: vec![],
            transport: Some(factory),
            workspaces: vec![],
        }
    }

    fn start(&self, name: &str) -> BrokerHandle {
        nexus_broker::start(self.config(name)).expect("broker starts")
    }

    fn scan_for_secret(&self) {
        let mut hay = Vec::new();
        fn walk(d: &Path, out: &mut Vec<u8>) {
            if let Ok(rd) = std::fs::read_dir(d) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, out);
                    } else if p
                        .file_name()
                        .map(|n| n != "provider-credentials.json")
                        .unwrap_or(true)
                    {
                        if let Ok(b) = std::fs::read(&p) {
                            out.extend_from_slice(&b);
                        }
                    }
                }
            }
        }
        walk(self.tmp.path(), &mut hay);
        assert!(
            !hay.windows(SECRET.len()).any(|w| w == SECRET.as_bytes()),
            "provider secret found on disk"
        );
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        kill(&mut self.daemon);
    }
}

fn intent(content: &str, key: &str) -> NexusIntentV1 {
    NexusIntentV1 {
        schema_version: 1,
        request_id: format!("req-{key}"),
        idempotency_key: key.to_owned(),
        intent_type: "model-only".into(),
        content: content.to_owned(),
        model: None,
        workspace_id: None,
        limits: IntentLimits::default(),
        response_mode: ResponseMode::Stream,
        client_label: Some("a53-test".into()),
    }
}

fn wait_terminal(sock: &Path, id: &str, secs: u64) -> ic::IntentRun {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        let r = ic::status(sock, id).expect("status");
        if r.terminal {
            return r;
        }
        assert!(Instant::now() < end, "run never finished: {r:?}");
        std::thread::sleep(Duration::from_millis(60));
    }
}

fn wait_state(sock: &Path, id: &str, want: &[&str], secs: u64) -> ic::IntentRun {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        let r = ic::status(sock, id).expect("status");
        if want.contains(&r.state.as_str()) || r.terminal {
            return r;
        }
        assert!(Instant::now() < end, "state {want:?} never reached: {r:?}");
        std::thread::sleep(Duration::from_millis(60));
    }
}

fn hello() -> Reply {
    Reply::Frames {
        frames: vec![delta("Hello "), delta("broker"), completed()],
        gap_ms: 0,
        hold_ms: 0,
    }
}

fn slow(gap_ms: u64) -> Reply {
    Reply::Frames {
        frames: vec![delta("one "), delta("two "), delta("three "), completed()],
        gap_ms,
        hold_ms: 0,
    }
}

fn cli(sock: &Path, args: &[&str], stdin: Option<&str>) -> (i32, serde_json::Value, String) {
    let mut c = Command::new(native_bin("nexus"));
    c.env("NEXUS_BROKER_SOCKET", sock)
        .arg("--json")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());
    let mut child = c.spawn().expect("nexus cli");
    if let Some(t) = stdin {
        child.stdin.take().unwrap().write_all(t.as_bytes()).unwrap();
    } else {
        drop(child.stdin.take());
    }
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let last = text.trim().lines().last().unwrap_or("{}");
    (
        out.status.code().unwrap_or(-1),
        serde_json::from_str(last).unwrap_or(serde_json::Value::Null),
        text,
    )
}

// ------------------------------------------------------------- tests

#[test]
fn a53_cli_submit_status_result_models_and_list_contract() {
    let fx = fixture(hello(), true);
    let b = fx.start("a");
    let sock = b.socket_path().to_owned();
    // models: the Registry-issued target, endpoint kind from the https origin.
    let (code, v, _) = cli(&sock, &["intent", "models"], None);
    assert_eq!(code, 0);
    assert_eq!(v["schema"], "nexus.intent.cli/v1");
    assert_eq!(v["models"][0]["providerId"], "e2e-mock");
    assert_eq!(v["models"][0]["remoteModelId"], "e2e-mock-model");
    assert_eq!(v["models"][0]["endpointKind"], "provider");
    // submit via stdin, with an explicit model and a stable key
    let (code, v, _) = cli(
        &sock,
        &[
            "intent",
            "submit",
            "--input",
            "-",
            "--model",
            "e2e-mock/e2e-mock-model",
            "--idempotency-key",
            "cli-key-0001",
        ],
        Some("say hello"),
    );
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["ok"], true);
    let id = v["run"]["runId"].as_str().unwrap().to_owned();
    assert!(id.starts_with("run_"));
    assert_eq!(v["replay"], false);
    let run = wait_terminal(&sock, &id, 30);
    assert_eq!(run.state, "completed", "{run:?}");
    // status + result contract an external consumer relies on
    let (code, s, _) = cli(&sock, &["intent", "status", &id], None);
    assert_eq!(code, 0);
    let r = &s["run"];
    for k in [
        "runId",
        "requestId",
        "clientId",
        "state",
        "terminal",
        "taskId",
        "taskInstanceId",
        "attemptId",
        "providerId",
        "remoteModelId",
        "endpointKind",
        "conversationId",
        "usageInputTokens",
        "usageOutputTokens",
        "createdAtMs",
    ] {
        assert!(!r[k].is_null(), "status lacks {k}: {s}");
    }
    assert_eq!(r["taskId"], "INTENT-00001");
    assert_eq!(r["attemptId"], "INTENT-00001-A1");
    assert_eq!(r["clientId"], format!("uid:{}", own_uid()));
    assert_eq!(r["usageInputTokens"], 7);
    let (code, res, _) = cli(&sock, &["intent", "result", &id], None);
    assert_eq!(code, 0);
    assert_eq!(res["text"], "Hello broker");
    assert_eq!(res["run"]["state"], "completed");
    let (_, l, _) = cli(&sock, &["intent", "list"], None);
    assert_eq!(l["runs"].as_array().unwrap().len(), 1);
    // the provider received exactly one request for the selected model
    let reqs = fx.provider.requests.lock().unwrap();
    assert_eq!(reqs.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&reqs[0].1).unwrap();
    assert_eq!(body["model"], "e2e-mock-model");
    assert!(reqs[0].0.to_ascii_lowercase().contains(&format!(
        "authorization: bearer {}",
        SECRET.to_ascii_lowercase()
    )));
    drop(reqs);
    fx.scan_for_secret();
    b.shutdown();
}

#[test]
fn a53_cli_follow_streams_ndjson_and_cancel_reaches_the_executor() {
    let fx = fixture(slow(700), true);
    let b = fx.start("b");
    let sock = b.socket_path().to_owned();
    // follow: NDJSON events, text arrives before the run ends
    let (code, _, text) = cli(
        &sock,
        &[
            "intent",
            "submit",
            "--input",
            "-",
            "--follow",
            "--idempotency-key",
            "follow-key-01",
        ],
        Some("stream it"),
    );
    assert_eq!(code, 0, "{text}");
    let events: Vec<serde_json::Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    assert_eq!(events.first().unwrap()["event"], "submitted");
    assert_eq!(events.last().unwrap()["event"], "end");
    assert_eq!(events.last().unwrap()["run"]["state"], "completed");
    let streamed: String = events
        .iter()
        .filter(|e| e["event"] == "text")
        .map(|e| e["delta"].as_str().unwrap())
        .collect();
    assert_eq!(streamed, "one two three ");
    assert!(
        events.iter().filter(|e| e["event"] == "text").count() >= 2,
        "text arrived incrementally: {text}"
    );
    // cancel mid-stream via the CLI: reaches the executor, never "completed"
    let fx2 = fixture(
        Reply::Frames {
            frames: vec![delta("part "), delta("never ")],
            gap_ms: 6_000,
            hold_ms: 0,
        },
        true,
    );
    let b2 = fx2.start("b2");
    let s2 = b2.socket_path().to_owned();
    let (_, v, _) = cli(
        &s2,
        &[
            "intent",
            "submit",
            "--input",
            "-",
            "--idempotency-key",
            "cancel-key-01",
        ],
        Some("cancel me"),
    );
    let id = v["run"]["runId"].as_str().unwrap().to_owned();
    wait_state(&s2, &id, &["streaming"], 20);
    let started = Instant::now();
    let (code, c1, _) = cli(&s2, &["intent", "cancel", &id], None);
    assert_eq!(code, 0);
    assert_eq!(c1["outcome"], "requested");
    let run = wait_terminal(&s2, &id, 20);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(run.state, "cancelled", "{run:?}");
    assert_ne!(run.state, "completed");
    // repeated cancellation is idempotent and truthful
    let (_, c2, _) = cli(&s2, &["intent", "cancel", &id], None);
    assert_eq!(c2["outcome"], "already-terminal");
    let (code, r, _) = cli(&s2, &["intent", "result", &id], None);
    assert_eq!(code, 6, "a cancelled run is not a success");
    assert_eq!(r["run"]["state"], "cancelled");
    assert_eq!(r["text"], "part ");
    assert_eq!(fx2.provider.accepted.load(Ordering::SeqCst), 1);
    b2.shutdown();
    b.shutdown();
}

#[test]
fn a53_models_and_intents_are_validated_before_any_run_exists() {
    let fx = fixture(hello(), true);
    let b = fx.start("c");
    let sock = b.socket_path().to_owned();
    let mut bad = intent("hi", "bad-model-01");
    bad.model = Some(ModelSelection {
        provider_id: "e2e-mock".into(),
        remote_model_id: "other-model".into(),
    });
    assert_eq!(
        ic::submit(&sock, &bad).unwrap_err().code,
        "model-not-available"
    );
    let mut other = intent("hi", "bad-model-02");
    other.model = Some(ModelSelection {
        provider_id: "someone-else".into(),
        remote_model_id: "e2e-mock-model".into(),
    });
    assert_eq!(
        ic::submit(&sock, &other).unwrap_err().code,
        "model-not-available"
    );
    // raw frames: unknown intent type, smuggled authority, foreign verbs
    let raw = |cmd: &str, params: serde_json::Value| -> serde_json::Value {
        let f = serde_json::json!({"protocol":1,"id":"r","cmd":cmd,"params":params});
        nexus_client::transport::ipc_roundtrip(&sock, &f, 10_000).unwrap()
    };
    let base = serde_json::json!({"schemaVersion":1,"requestId":"r1","idempotencyKey":"raw-key-0001","content":"x"});
    let mut t = base.clone();
    t["intentType"] = "project-design".into();
    assert_eq!(
        raw("intent-submit", serde_json::json!({"intent": t}))["code"],
        "unsupported-intent-type"
    );
    for field in [
        "grant",
        "cap",
        "apiKey",
        "providerUrl",
        "tools",
        "workspace",
        "approval",
        "writeScope",
        "processScope",
        "clientId",
    ] {
        let mut v = base.clone();
        v["intentType"] = "model-only".into();
        v[field] = "x".into();
        let r = raw("intent-submit", serde_json::json!({"intent": v}));
        assert_eq!(r["code"], "bad-intent", "{field}: {r}");
    }
    for cmd in [
        "acquire",
        "seal",
        "accept",
        "dispatch-authorize",
        "model-redeem",
        "tool-execute",
        "workspace-bind",
        "approval-request",
        "intent-publish",
        "shutdown",
        "exec",
        "read-file",
        "status",
    ] {
        let r = raw(cmd, serde_json::json!({"cap": "x"}));
        assert_eq!(
            r["code"], "unknown-command",
            "{cmd} must not be forwarded: {r}"
        );
    }
    assert!(
        ic::list(&sock, 50).unwrap().is_empty(),
        "no rejected request created a run"
    );
    assert_eq!(fx.provider.accepted.load(Ordering::SeqCst), 0);
    // an allowlist can only narrow the Registry
    b.shutdown();
    let mut cfg = fx.config("c2");
    cfg.allow_models = vec![("e2e-mock".into(), "nope".into())];
    let b2 = nexus_broker::start(cfg).unwrap();
    assert!(ic::models(b2.socket_path()).unwrap().is_empty());
    let mut ok = intent("hi", "narrowed-0001");
    ok.model = Some(ModelSelection {
        provider_id: "e2e-mock".into(),
        remote_model_id: "e2e-mock-model".into(),
    });
    assert_eq!(
        ic::submit(b2.socket_path(), &ok).unwrap_err().code,
        "model-not-allowed"
    );
    b2.shutdown();
}

#[test]
fn a53_duplicate_submissions_are_idempotent_even_under_concurrency() {
    let fx = fixture(slow(150), true);
    let b = fx.start("d");
    let sock = b.socket_path().to_owned();
    let i = intent("same payload", "dup-key-0001");
    let mut hs = Vec::new();
    for _ in 0..6 {
        let (s, i) = (sock.clone(), i.clone());
        hs.push(std::thread::spawn(move || {
            ic::submit(&s, &i).expect("submit")
        }));
    }
    let replies: Vec<_> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    let ids: std::collections::HashSet<_> = replies.iter().map(|r| r.run.run_id.clone()).collect();
    assert_eq!(ids.len(), 1, "one key, one run: {ids:?}");
    assert_eq!(
        replies.iter().filter(|r| !r.replay).count(),
        1,
        "exactly one original"
    );
    let run = wait_terminal(&sock, ids.iter().next().unwrap(), 30);
    assert_eq!(run.state, "completed");
    assert_eq!(
        fx.provider.accepted.load(Ordering::SeqCst),
        1,
        "exactly one billable submission"
    );
    // replay after completion returns the same run and sends nothing
    let again = ic::submit(&sock, &i).unwrap();
    assert!(again.replay && again.run.run_id == run.run_id);
    // same key, different payload: conflict, no second attempt
    let other = intent("DIFFERENT payload", "dup-key-0001");
    assert_eq!(
        ic::submit(&sock, &other).unwrap_err().code,
        "idempotency-conflict"
    );
    assert_eq!(fx.provider.accepted.load(Ordering::SeqCst), 1);
    b.shutdown();
}

#[test]
fn a53_clients_are_authenticated_by_peer_uid_and_isolated_from_each_other() {
    let fx = fixture(hello(), true);
    // A broker that does not list this UID refuses everything.
    let mut cfg = fx.config("e1");
    cfg.allowed_uids = vec![own_uid().wrapping_add(1)];
    let closed = nexus_broker::start(cfg).unwrap();
    for e in [
        ic::models(closed.socket_path()).unwrap_err(),
        ic::submit(closed.socket_path(), &intent("x", "unauth-key-01")).unwrap_err(),
        ic::list(closed.socket_path(), 5).unwrap_err(),
    ] {
        assert_eq!(e.code, "unauthorized", "{e}");
    }
    closed.shutdown();
    // Isolation: a run owned by another client id is invisible and untouchable.
    let b = fx.start("e2");
    let sock = b.socket_path().to_owned();
    let mine = ic::submit(&sock, &intent("mine", "iso-key-0001"))
        .unwrap()
        .run;
    wait_terminal(&sock, &mine.run_id, 30);
    let foreign_id = format!("run_{}", "ab".repeat(16));
    {
        let store = Store::open(&b.broker.cfg.state_dir).unwrap();
        let _g = store.lock();
        let run = ic::IntentRun {
            run_id: foreign_id.clone(),
            client_id: "uid:99999".into(),
            state: "executing".into(),
            conversation_id: Some("model_00000000000000000000000000000000".into()),
            ..Default::default()
        };
        store
            .put(&RunRecord {
                run,
                payload_digest: "d".into(),
                idempotency_key: "k".into(),
            })
            .unwrap();
    }
    for (name, r) in [
        ("status", ic::status(&sock, &foreign_id).map(|_| ())),
        ("result", ic::result(&sock, &foreign_id).map(|_| ())),
        ("cancel", ic::cancel(&sock, &foreign_id).map(|_| ())),
        (
            "follow",
            ic::follow(&sock, &foreign_id, 0, None, 0).map(|_| ()),
        ),
        (
            "missing",
            ic::status(&sock, &format!("run_{}", "cd".repeat(16))).map(|_| ()),
        ),
    ] {
        assert_eq!(
            r.unwrap_err().code,
            "not-found",
            "{name}: same answer as an absent run"
        );
    }
    assert!(ic::list(&sock, 100)
        .unwrap()
        .iter()
        .all(|r| r.client_id == format!("uid:{}", own_uid())));
    assert!(
        ic::status(&sock, "../../etc/passwd").is_err(),
        "run ids are validated"
    );
    // the same idempotency key under another client id is a different key
    let store = Store::open(&b.broker.cfg.state_dir).unwrap();
    assert!(store.idem_lookup("uid:99999", "iso-key-0001").is_none());
    b.shutdown();
}

#[test]
fn a53_credentials_and_authority_never_cross_the_client_boundary() {
    let fx = fixture(hello(), true);
    let b = fx.start("f");
    let sock = b.socket_path().to_owned();
    let run = ic::submit(&sock, &intent("secrets?", "secret-key-01"))
        .unwrap()
        .run;
    let done = wait_terminal(&sock, &run.run_id, 30);
    let res = ic::result(&sock, &run.run_id).unwrap();
    let all = serde_json::json!({ "run": done, "res": res, "list": ic::list(&sock, 50).unwrap(), "models": ic::models(&sock).unwrap() }).to_string();
    for needle in [
        SECRET,
        "issuer.cap",
        "credentialRef",
        "tagHex",
        "nonceHex",
        "provider-credentials",
    ] {
        assert!(!all.contains(needle), "client-visible data leaked {needle}");
    }
    let cap = std::fs::read_to_string(&fx.cap).unwrap();
    assert!(!all.contains(cap.trim()));
    fx.scan_for_secret();
    // the broker does not hand its capability to anyone on disk
    let mode = std::fs::metadata(&b.broker.cfg.socket_path)
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o600,
        "socket is owner-only unless a group is configured"
    );
    let sm = std::fs::metadata(&b.broker.cfg.state_dir)
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(sm, 0o700);
    b.shutdown();
}

#[test]
fn a53_model_output_cannot_invoke_tools_or_touch_the_workspace() {
    let frames = vec![
        delta("Please run `rm -rf ~` and write /etc/passwd"),
        "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"c1\",\"name\":\"fs.write\"}}\n\n".to_owned(),
        "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"c1\",\"delta\":\"{\\\"path\\\":\\\"/etc/passwd\\\"}\"}\n\n".to_owned(),
        completed(),
    ];
    let fx = fixture(
        Reply::Frames {
            frames,
            gap_ms: 0,
            hold_ms: 0,
        },
        true,
    );
    let b = fx.start("g");
    let sock = b.socket_path().to_owned();
    let run = ic::submit(&sock, &intent("be dangerous", "tools-key-001"))
        .unwrap()
        .run;
    let done = wait_terminal(&sock, &run.run_id, 30);
    assert_eq!(done.state, "completed");
    let res = ic::result(&sock, &run.run_id).unwrap();
    assert_eq!(res.text, "Please run `rm -rf ~` and write /etc/passwd");
    let tool_events = nexus_client::issuer::issuer_call(
        &fx.daemon_socket,
        &std::fs::read_to_string(&fx.cap).unwrap(),
        "tool-events",
        serde_json::json!({"taskInstanceId": done.task_instance_id.clone().unwrap(), "attemptId": done.attempt_id.clone().unwrap()}),
    )
    .unwrap();
    assert!(
        !tool_events.to_string().contains("fs.write"),
        "{tool_events}"
    );
    let status = nexus_client::status(&nexus_client::ClientConfig {
        socket_path: fx.daemon_socket.clone(),
        ledger_dir: None,
        json: false,
        runs_dir: None,
        sessions_root: None,
        transcript_dir: b.broker.cfg.transcript_dir.clone(),
    })
    .unwrap();
    assert_eq!(status["writesEnabled"], false);
    assert_eq!(status["processEnabled"], false);
    assert_eq!(status["dispatchEnabled"], false);
    b.shutdown();
}

#[test]
fn a53_cancel_before_submission_and_during_the_tls_handshake_send_nothing() {
    let fx = fixture(Reply::HandshakeStall, true);
    let b = fx.start("h");
    let sock = b.socket_path().to_owned();
    let run = ic::submit(&sock, &intent("stall", "stall-key-001"))
        .unwrap()
        .run;
    // wait until the executor is connecting (TCP accepted, TLS cannot finish)
    let end = Instant::now() + Duration::from_secs(20);
    while fx.provider.accepted.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < end, "executor never reached the provider");
        std::thread::sleep(Duration::from_millis(30));
    }
    let t = Instant::now();
    assert_eq!(ic::cancel(&sock, &run.run_id).unwrap().outcome, "requested");
    let done = wait_terminal(&sock, &run.run_id, 15);
    assert!(t.elapsed() < Duration::from_secs(4), "{:?}", t.elapsed());
    assert_eq!(done.state, "cancelled", "{done:?}");
    assert!(
        fx.provider.requests.lock().unwrap().is_empty(),
        "no application data"
    );
    // cancel immediately after submit (before/at preparation): never completed
    let fx2 = fixture(hello(), true);
    let b2 = fx2.start("h2");
    let s2 = b2.socket_path().to_owned();
    let r2 = ic::submit(&s2, &intent("early", "early-key-001"))
        .unwrap()
        .run;
    let _ = ic::cancel(&s2, &r2.run_id).unwrap();
    let d2 = wait_terminal(&s2, &r2.run_id, 30);
    assert!(d2.state == "cancelled" || d2.state == "completed", "{d2:?}");
    if d2.state == "cancelled" {
        assert!(fx2.provider.requests.lock().unwrap().len() <= 1);
    }
    b2.shutdown();
    b.shutdown();
}

#[test]
fn a53_uncertain_submission_is_never_resubmitted() {
    let fx = fixture(Reply::CloseSilently, true);
    let b = fx.start("i");
    let sock = b.socket_path().to_owned();
    let i = intent("billable?", "uncertain-key-1");
    let run = ic::submit(&sock, &i).unwrap().run;
    let done = wait_terminal(&sock, &run.run_id, 30);
    assert_eq!(done.state, "uncertain", "{done:?}");
    assert_eq!(fx.provider.accepted.load(Ordering::SeqCst), 1);
    // resubmitting the same key: the same uncertain run, no new attempt
    let again = ic::submit(&sock, &i).unwrap();
    assert!(again.replay && again.run.state == "uncertain");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(fx.provider.accepted.load(Ordering::SeqCst), 1);
    // a NEW key is the client's explicit decision: a new, separate attempt
    let fresh = ic::submit(&sock, &intent("billable?", "uncertain-key-2")).unwrap();
    assert!(!fresh.replay && fresh.run.run_id != run.run_id);
    b.shutdown();
}

#[test]
fn a53_limits_busy_rate_and_bounded_follow() {
    let fx = fixture(
        Reply::Frames {
            frames: (0..60)
                .map(|i| delta(&format!("{i:03}-{}", "x".repeat(1_800))))
                .chain([completed()])
                .collect(),
            gap_ms: 20,
            hold_ms: 0,
        },
        true,
    );
    let mut cfg = fx.config("j");
    cfg.max_active = 1;
    cfg.rate_per_minute = 3;
    let b = nexus_broker::start(cfg).unwrap();
    let sock = b.socket_path().to_owned();
    let first = ic::submit(&sock, &intent("big", "limit-key-001"))
        .unwrap()
        .run;
    assert_eq!(
        ic::submit(&sock, &intent("second", "limit-key-002"))
            .unwrap_err()
            .code,
        "busy"
    );
    // bounded follow: every delta <= 32 KiB, offsets validated, reconnect-safe
    let mut offset = 0u64;
    let mut text = String::new();
    let mut reconnects = 0;
    let end = Instant::now() + Duration::from_secs(40);
    loop {
        let f = ic::follow(&sock, &first.run_id, offset, None, 500).unwrap();
        assert!(f.text_delta.len() <= 32 * 1024);
        text.push_str(&f.text_delta);
        offset = f.next_offset;
        if reconnects == 0 && offset > 10_000 {
            reconnects += 1; // a brand-new client resumes from the stored offset
        }
        if f.run.terminal && f.text_delta.is_empty() {
            break;
        }
        assert!(Instant::now() < end);
    }
    let res = ic::result(&sock, &first.run_id).unwrap();
    assert_eq!(
        text, res.text,
        "resumable follow reassembles the exact output"
    );
    assert!(res.text.len() > 100_000);
    assert_eq!(
        ic::follow(&sock, &first.run_id, res.text.len() as u64 + 5, None, 0)
            .unwrap_err()
            .code,
        "bad-offset"
    );
    assert_eq!(
        ic::follow(&sock, &first.run_id, 0, None, 0)
            .unwrap()
            .text_delta
            .len(),
        32 * 1024
    );
    // rate limit: 3 per minute per client
    let _ = ic::submit(&sock, &intent("r2", "limit-key-003"));
    let _ = ic::submit(&sock, &intent("r3", "limit-key-004"));
    let e = ic::submit(&sock, &intent("r4", "limit-key-005")).unwrap_err();
    assert!(e.code == "rate-limited" || e.code == "busy", "{e}");
    b.shutdown();
}

#[test]
fn a53_broker_refuses_to_start_without_the_model_pilot() {
    let fx = fixture(hello(), false);
    let err = nexus_broker::start(fx.config("k"))
        .err()
        .expect("must refuse");
    assert!(err.contains("model pilot is disabled"), "{err}");
    // a second broker on the same state directory is refused too
    let fx2 = fixture(hello(), true);
    let first = fx2.start("k2");
    let second = nexus_broker::start(fx2.config("k2"))
        .err()
        .expect("single owner");
    assert!(second.contains("already"), "{second}");
    first.shutdown();
}

// ---- crash / restart: the broker runs as a CHILD PROCESS of this test binary

fn child_cfg_path(fx: &Fx) -> PathBuf {
    fx.tmp.path().join("child-cfg.json")
}

#[test]
#[ignore = "child entry point for the crash test; run only via the parent test"]
fn broker_child_entry() {
    let Ok(p) = std::env::var("A53_CHILD_CFG") else {
        return;
    };
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
    let ca = std::fs::read(v["ca"].as_str().unwrap()).unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(ca)).unwrap();
    let tls = nexus_model::egress::tls_config_with_roots(roots);
    let factory = nexus_client::TransportFactory(Arc::new(move |binding| {
        nexus_model::HttpSseTransport::with_parts(
            binding,
            Arc::new(nexus_model::testkit::ScriptedResolver::new(vec![vec![
                "127.0.0.1".parse().unwrap(),
            ]])),
            nexus_model::egress::AddressPolicy::PublicOrLoopbackForTests,
            tls.clone(),
        )
    }));
    let p = |k: &str| PathBuf::from(v[k].as_str().unwrap());
    let cfg = BrokerConfig {
        state_dir: p("state"),
        socket_path: p("socket"),
        socket_group: None,
        allowed_uids: vec![],
        daemon_socket: p("daemon_socket"),
        cap_path: p("cap"),
        credentials_path: p("creds"),
        transcript_dir: p("transcripts"),
        repo_root: repo_root(),
        registry_data_root: p("registry"),
        ledger_workspace: p("ledger"),
        node: "node".into(),
        extra_trusted_owner_uids: vec![],
        max_active: 4,
        rate_per_minute: 50,
        limits: nexus_client::TransportLimits {
            read_timeout_ms: 3_000,
            total_timeout_ms: 60_000,
            ..Default::default()
        },
        allow_models: vec![],
        transport: Some(factory),
        workspaces: vec![],
    };
    let _h = nexus_broker::start(cfg).expect("child broker");
    std::thread::sleep(Duration::from_secs(600));
}

#[test]
fn a53_broker_crash_and_daemon_restart_never_duplicate_a_billable_submission() {
    let mut fx = fixture(
        Reply::Frames {
            frames: vec![delta("in flight "), delta("never ")],
            gap_ms: 8_000,
            hold_ms: 0,
        },
        true,
    );
    let ca_path = fx.tmp.path().join("ca.der");
    std::fs::write(&ca_path, &fx.pki.ca_der).unwrap();
    let root = fx.tmp.path();
    std::fs::write(
        child_cfg_path(&fx),
        serde_json::json!({
            "ca": ca_path, "state": root.join("broker-crash"), "socket": root.join("broker-crash.sock"),
            "daemon_socket": fx.daemon_socket, "cap": fx.cap, "creds": fx.creds,
            "transcripts": root.join("transcripts"), "registry": fx.registry, "ledger": root.join("intent-ledger"),
        })
        .to_string(),
    )
    .unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["broker_child_entry", "--exact", "--ignored", "--nocapture"])
        .env("A53_CHILD_CFG", child_cfg_path(&fx))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let sock = root.join("broker-crash.sock");
    let end = Instant::now() + Duration::from_secs(30);
    while ic::models(&sock).is_err() {
        assert!(Instant::now() < end, "child broker never came up");
        std::thread::sleep(Duration::from_millis(100));
    }
    let i = intent("crash me", "crash-key-001");
    let run = ic::submit(&sock, &i).unwrap().run;
    wait_state(&sock, &run.run_id, &["streaming"], 30);
    // Hard-kill the broker (and with it the in-process executor) mid-stream,
    // and restart the daemon too.
    kill(&mut child);
    kill(&mut fx.daemon);
    fx.daemon = spawn_daemon(
        fx.tmp.path(),
        &fx.daemon_db,
        &fx.daemon_witness,
        &fx.daemon_socket,
        &fx.cap,
        true,
    );
    let _ = std::fs::remove_file(&sock);
    // New broker over the same durable state: recovery closes the run.
    let b = nexus_broker::start({
        let mut c = fx.config("crash");
        c.state_dir = root.join("broker-crash");
        c.socket_path = root.join("broker-crash.sock");
        c
    })
    .expect("restarted broker");
    let after = ic::status(b.socket_path(), &run.run_id).unwrap();
    assert!(after.terminal, "recovery must close the run: {after:?}");
    assert_eq!(after.state, "uncertain", "{after:?}");
    assert_eq!(after.error_code.as_deref(), Some("send-uncertain"));
    // Reconnecting clients see the same run; replaying the key resubmits nothing.
    let again = ic::submit(b.socket_path(), &i).unwrap();
    assert!(again.replay && again.run.run_id == run.run_id);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(
        fx.provider.accepted.load(Ordering::SeqCst),
        1,
        "exactly one provider submission, ever"
    );
    // the grant of that run cannot be redeemed again after the daemon restart
    let cap = std::fs::read_to_string(&fx.cap).unwrap();
    let probe = nexus_client::issuer::issuer_call(&fx.daemon_socket, &cap, "dispatch-authorize", serde_json::json!({
        "commandId": after.command_id.clone().unwrap(), "requestDigest": after.request_digest.clone().unwrap(),
        "scope": "model-only", "endpointOrigin": format!("https://{HOST}:{}", fx.provider.port), "credentialRef": CRED_REF,
    })).unwrap();
    assert_eq!(probe["code"], "command-conflict", "{probe}");
    // a run that had not reached the executor is abandoned, never resumed
    {
        let store = Store::open(&b.broker.cfg.state_dir).unwrap();
        let _g = store.lock();
        let run = ic::IntentRun {
            run_id: format!("run_{}", "ef".repeat(16)),
            client_id: format!("uid:{}", own_uid()),
            state: "preparing".into(),
            ..Default::default()
        };
        store
            .put(&RunRecord {
                run,
                payload_digest: "d".into(),
                idempotency_key: "k2".into(),
            })
            .unwrap();
    }
    b.shutdown();
    let b2 = nexus_broker::start({
        let mut c = fx.config("crash");
        c.state_dir = root.join("broker-crash");
        c.socket_path = root.join("broker-crash.sock");
        c
    })
    .unwrap();
    let ab = ic::status(b2.socket_path(), &format!("run_{}", "ef".repeat(16))).unwrap();
    assert_eq!(ab.state, "abandoned");
    assert_eq!(fx.provider.accepted.load(Ordering::SeqCst), 1);
    b2.shutdown();
    fx.scan_for_secret();
}

#[test]
fn a53_cli_json_contract_for_an_external_consumer_and_error_classes() {
    // A small simulated external consumer: it knows ONLY the documented
    // envelope, never terminal formatting. (Not an Arthur integration.)
    struct Consumer {
        sock: PathBuf,
    }
    impl Consumer {
        fn run(&self, args: &[&str], stdin: Option<&str>) -> (i32, serde_json::Value) {
            let (c, v, _) = cli(&self.sock, args, stdin);
            (c, v)
        }
    }
    let fx = fixture(hello(), true);
    let b = fx.start("l");
    let c = Consumer {
        sock: b.socket_path().to_owned(),
    };
    let (code, v) = c.run(
        &[
            "intent",
            "submit",
            "--input",
            "-",
            "--wait",
            "--idempotency-key",
            "ext-key-0001",
        ],
        Some("from an external consumer"),
    );
    assert_eq!(code, 0);
    assert_eq!(
        (v["schema"].as_str(), v["ok"].as_bool()),
        (Some("nexus.intent.cli/v1"), Some(true))
    );
    assert_eq!(v["text"], "Hello broker");
    assert_eq!(v["run"]["state"], "completed");
    // error classification
    let (code, e) = c.run(
        &["intent", "submit", "--input", "-", "--model", "x/y"],
        Some("hi"),
    );
    assert_eq!(code, 2);
    assert_eq!(
        (
            e["ok"].as_bool(),
            e["error"]["class"].as_str(),
            e["error"]["code"].as_str()
        ),
        (Some(false), Some("rejected"), Some("model-not-available"))
    );
    let (code, e) = c.run(
        &["intent", "status", "run_00000000000000000000000000000000"],
        None,
    );
    assert_eq!((code, e["error"]["code"].as_str()), (2, Some("not-found")));
    let (_, e) = c.run(&["intent", "submit", "--intent", "-"], Some("{\"schemaVersion\":1,\"requestId\":\"a\",\"idempotencyKey\":\"intent-json-1\",\"intentType\":\"project-design\",\"content\":\"x\"}"));
    assert_eq!(e["error"]["code"], "bad-usage");
    let dead = Consumer {
        sock: fx.tmp.path().join("nobody-listens.sock"),
    };
    let (code, e) = dead.run(&["intent", "models"], None);
    assert_eq!((code, e["error"]["class"].as_str()), (3, Some("transport")));
    b.shutdown();
}

// ------------------------------------------------ final broker security audit

#[test]
fn a53_audit_broker_never_replaces_a_non_socket_file_at_its_socket_path() {
    let fx = fixture(hello(), true);
    let cfg = fx.config("audit-sock");
    std::fs::write(&cfg.socket_path, b"precious operator data").unwrap();
    let err = nexus_broker::start(cfg.clone()).err().expect("must refuse");
    assert!(err.contains("not a socket"), "{err}");
    assert_eq!(
        std::fs::read(&cfg.socket_path).unwrap(),
        b"precious operator data"
    );
    // a symlink is not followed or removed either
    std::fs::remove_file(&cfg.socket_path).unwrap();
    let target = fx.tmp.path().join("victim");
    std::fs::write(&target, b"victim").unwrap();
    std::os::unix::fs::symlink(&target, &cfg.socket_path).unwrap();
    assert!(nexus_broker::start(cfg).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"victim");
}

#[test]
fn a53_audit_untrusted_node_or_bridge_code_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let fx = fixture(hello(), true);
    // 1. node found in a world-writable directory
    let evil = fx.tmp.path().join("evil-bin");
    std::fs::create_dir_all(&evil).unwrap();
    std::fs::set_permissions(&evil, std::fs::Permissions::from_mode(0o777)).unwrap();
    let node = evil.join("node");
    std::fs::write(&node, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut cfg = fx.config("audit-node");
    cfg.node = node.to_string_lossy().into_owned();
    let e = nexus_broker::start(cfg).err().expect("untrusted node");
    assert!(e.contains("node executable rejected"), "{e}");
    // 2. a group/world-writable bridge module
    let repo = fx.tmp.path().join("repo-copy");
    let reg = repo.join("config").join("registry");
    std::fs::create_dir_all(&reg).unwrap();
    let bridge = reg.join("native-intent-bridge.cjs");
    std::fs::write(&bridge, "// copy\n").unwrap();
    std::fs::set_permissions(&bridge, std::fs::Permissions::from_mode(0o666)).unwrap();
    let mut cfg = fx.config("audit-bridge");
    cfg.repo_root = repo.clone();
    let e = nexus_broker::start(cfg).err().expect("untrusted bridge");
    assert!(
        e.contains("bridge rejected") || e.contains("untrusted"),
        "{e}"
    );
    // 3. a relative PATH entry is never used to find node
    assert!(nexus_broker::trust::resolve_node("definitely-not-a-real-binary", &[]).is_err());
}

#[test]
fn a53_audit_infrastructure_errors_do_not_leak_paths_and_no_client_text_reaches_the_bridge() {
    let fx = fixture(hello(), true);
    let mut cfg = fx.config("audit-leak");
    cfg.registry_data_root = PathBuf::from("/nonexistent/very-secret-registry-location");
    let b = nexus_broker::start(cfg).unwrap();
    let e = ic::submit(b.socket_path(), &intent("hi", "leak-key-0001")).unwrap_err();
    assert!(!e.message.contains("very-secret-registry-location"), "{e}");
    assert!(!e.message.contains("/nonexistent"), "{e}");
    b.shutdown();
    // Hostile content: it reaches only the model prompt, never the Controller
    // ledger or the bridge's arguments.
    let b = fx.start("audit-leak2");
    let sock = b.socket_path().to_owned();
    let hostile = "'; rm -rf / #\n$(touch /tmp/pwned) `id` \"}\\u0000 ../../etc/passwd";
    let run = ic::submit(&sock, &intent(hostile, "hostile-key-01"))
        .unwrap()
        .run;
    let done = wait_terminal(&sock, &run.run_id, 30);
    assert_eq!(done.state, "completed", "{done:?}");
    let mut hay = Vec::new();
    fn walk(d: &Path, out: &mut Vec<u8>) {
        if let Ok(rd) = std::fs::read_dir(d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out)
                } else if let Ok(b) = std::fs::read(&p) {
                    out.extend_from_slice(&b)
                }
            }
        }
    }
    walk(&b.broker.cfg.ledger_workspace, &mut hay);
    walk(&b.broker.cfg.state_dir, &mut hay);
    assert!(
        !String::from_utf8_lossy(&hay).contains("rm -rf"),
        "client text reached the ledger/state"
    );
    assert!(!Path::new("/tmp/pwned").exists());
    let mode = std::fs::metadata(&b.broker.cfg.ledger_workspace)
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o700, "ledger is private to the issuer identity");
    b.shutdown();
}

#[test]
fn a53_audit_unauthorized_peers_cannot_hold_connection_slots() {
    use std::os::unix::net::UnixStream;
    let fx = fixture(hello(), true);
    let mut cfg = fx.config("audit-dos");
    cfg.allowed_uids = vec![own_uid().wrapping_add(1)]; // we are "unauthorized"
    let b = nexus_broker::start(cfg).unwrap();
    let started = Instant::now();
    let conns: Vec<UnixStream> = (0..12)
        .filter_map(|_| UnixStream::connect(b.socket_path()).ok())
        .collect();
    let mut answered = 0;
    for mut c in conns {
        c.set_read_timeout(Some(Duration::from_secs(3))).ok();
        let mut line = String::new();
        let _ = std::io::BufRead::read_line(&mut std::io::BufReader::new(&mut c), &mut line);
        if line.contains("unauthorized") || line.contains("busy") {
            answered += 1;
        }
    }
    assert_eq!(
        answered, 12,
        "every idle unauthorized peer is answered or shed"
    );
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
    b.shutdown();
}

#[test]
fn a53_audit_pipeline_failures_show_clients_a_code_not_infrastructure_detail() {
    use std::os::unix::fs::PermissionsExt;
    let fx = fixture(hello(), true);
    // An unusable ledger refuses to start (fail early)...
    let mut bad = fx.config("audit-leak3a");
    bad.ledger_workspace = PathBuf::from("/dev/null/nexus-ledger");
    assert!(nexus_broker::start(bad)
        .err()
        .expect("unusable")
        .contains("ledger directory is unusable"));
    // ...and one that breaks AFTER start fails runs with a code, not detail.
    let cfg = fx.config("audit-leak3");
    let ledger = cfg.ledger_workspace.clone();
    let b = nexus_broker::start(cfg).unwrap();
    std::fs::set_permissions(&ledger, std::fs::Permissions::from_mode(0o500)).unwrap();
    let run = ic::submit(b.socket_path(), &intent("hi", "leak3-key-0001"))
        .unwrap()
        .run;
    let done = wait_terminal(b.socket_path(), &run.run_id, 30);
    std::fs::set_permissions(&ledger, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(done.state, "rejected", "{done:?}");
    assert_eq!(done.error_code.as_deref(), Some("bridge-error"));
    let msg = done.error_message.clone().unwrap_or_default();
    assert!(
        !msg.contains("intent-ledger") && !msg.contains(".ai-harness") && !msg.contains("EACCES"),
        "{msg}"
    );
    assert!(msg.contains("bridge-error"), "{msg}");
    assert_eq!(
        fx.provider.accepted.load(Ordering::SeqCst),
        0,
        "nothing was sent"
    );
    b.shutdown();
}

#[test]
fn a53_audit_default_broker_binary_carries_no_fixture_trust_injection() {
    // The fixture CA/resolver flags exist only in the separate
    // `test-fixtures` build used by the multi-UID harness. The default
    // (workspace) binary must not contain that code path at all.
    let bin = std::fs::read(native_bin("nexus-broker")).expect("build the workspace first");
    let has = |needle: &str| bin.windows(needle.len()).any(|w| w == needle.as_bytes());
    assert!(
        !has("TEST-FIXTURES BUILD"),
        "default broker contains the fixture marker"
    );
    assert!(!has("--test-tls-ca") && !has("--test-resolve") && !has("--test-trust-owner-uid"));
}

#[test]
fn a531_conversation_is_served_per_run_by_ownership_with_incremental_paging() {
    let fx = fixture(slow(300), true);
    let b = fx.start("conv");
    let sock = b.socket_path().to_owned();
    let run = ic::submit(&sock, &intent("page me", "conv-key-00001"))
        .unwrap()
        .run;
    // incremental: poll the conversation by cursor while the run streams
    let end = Instant::now() + Duration::from_secs(30);
    let mut cursor: Option<u64> = None;
    let mut texts: Vec<String> = Vec::new();
    #[allow(unused_assignments)]
    let mut conv_id: Option<String> = None;
    loop {
        let r = ic::status(&sock, &run.run_id).unwrap();
        if let Some(c) = &r.conversation_id {
            conv_id = Some(c.clone());
            let view = ic::conversation(&sock, c, cursor, None, Some(50)).unwrap();
            assert_eq!(view["source"], "native-store");
            if let Some(h) = view["page"]["headSeq"].as_u64() {
                cursor = Some(h);
            }
            for e in view["page"]["events"].as_array().unwrap() {
                if e["kind"] == "assistant-message" {
                    texts.push(e["text"].as_str().unwrap_or("").to_owned());
                }
            }
            if r.terminal {
                break;
            }
        }
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        texts.len() >= 2,
        "partial revisions arrived incrementally: {texts:?}"
    );
    assert_eq!(texts.last().unwrap(), "one two three ");
    // a fully caught-up cursor yields nothing new
    let again =
        ic::conversation(&sock, conv_id.as_deref().unwrap(), cursor, None, Some(50)).unwrap();
    assert!(again["page"]["events"].as_array().unwrap().is_empty());
    // the owner's list carries a prompt preview; the user's prompt is in the view
    let l = ic::list(&sock, 10).unwrap();
    assert_eq!(l[0].prompt_preview.as_deref(), Some("page me"));
    // ownership: someone else's conversation, an unknown id and a traversal id are all `not-found`
    let foreign_conv = "model_ffffffffffffffffffffffffffffffff";
    {
        let store = Store::open(&b.broker.cfg.state_dir).unwrap();
        let _g = store.lock();
        let run = ic::IntentRun {
            run_id: format!("run_{}", "12".repeat(16)),
            client_id: "uid:99999".into(),
            state: "completed".into(),
            terminal: true,
            conversation_id: Some(foreign_conv.into()),
            ..Default::default()
        };
        store
            .put(&RunRecord {
                run,
                payload_digest: "d".into(),
                idempotency_key: "k".into(),
            })
            .unwrap();
    }
    for c in [
        foreign_conv,
        "model_00000000000000000000000000000000",
        "../../etc/passwd",
        "task_0123456789abcdef0123456789abcdef",
    ] {
        assert_eq!(
            ic::conversation(&sock, c, None, None, None)
                .unwrap_err()
                .code,
            "not-found",
            "{c}"
        );
    }
    b.shutdown();
}

#[test]
fn a54_live_gate_refuses_real_https_runs_without_operator_authorization() {
    use std::sync::atomic::Ordering;
    let fx = fixture(hello(), true);
    // Production transport (no injected one): an https endpoint is "live".
    let mut cfg = fx.config("live");
    cfg.transport = None;
    let state = cfg.state_dir.clone();
    let b = nexus_broker::start(cfg).expect("broker starts");
    let sock = b.socket_path().to_owned();

    // 1. No record: refused before any grant; the provider sees nothing.
    let r = ic::submit(&sock, &intent("ping", "a54-live-none"))
        .unwrap()
        .run;
    let r = wait_terminal(&sock, &r.run_id, 30);
    assert_eq!(r.state, "rejected", "{r:?}");
    assert_eq!(
        r.error_code.as_deref(),
        Some("live-not-authorized"),
        "{r:?}"
    );
    assert_eq!(fx.provider.accepted.load(Ordering::SeqCst), 0);

    // 2. A record for a different prompt is refused AND consumed.
    nexus_broker::live_auth::write_record(
        &state,
        "e2e-mock",
        "e2e-mock-model",
        "another prompt",
        64,
        600,
        true,
    )
    .unwrap();
    let mut i = intent("ping", "a54-live-mismatch");
    i.limits.max_output_tokens = Some(32);
    let r = wait_terminal(&sock, &ic::submit(&sock, &i).unwrap().run.run_id, 30);
    assert_eq!(
        r.error_code.as_deref(),
        Some("live-not-authorized"),
        "{r:?}"
    );
    assert!(
        !nexus_broker::live_auth::record_path(&state).exists(),
        "mismatch consumes the record"
    );

    // 3. Exact record but no explicit output limit: refused (nothing sent).
    nexus_broker::live_auth::write_record(
        &state,
        "e2e-mock",
        "e2e-mock-model",
        "ping",
        64,
        600,
        true,
    )
    .unwrap();
    let r = wait_terminal(
        &sock,
        &ic::submit(&sock, &intent("ping", "a54-live-nolimit"))
            .unwrap()
            .run
            .run_id,
        30,
    );
    assert_eq!(
        r.error_code.as_deref(),
        Some("live-not-authorized"),
        "{r:?}"
    );
    assert_eq!(
        fx.provider.accepted.load(Ordering::SeqCst),
        0,
        "nothing was sent in any case"
    );
    b.shutdown();
}
