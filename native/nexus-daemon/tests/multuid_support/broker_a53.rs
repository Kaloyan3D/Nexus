//! A5.3 final audit: the intent broker under REAL distinct kernel UIDs.
//!
//! Identities (all different UIDs, enforced by the kernel):
//!   nexusd-test           daemon            nexus-issuer-test   issuer + broker + executor
//!   nexus-desktop-test    Desktop client 1  nexus-desktop2-test Desktop client 2 (a second authorized UID)
//!   nexus-approver-test   independent approver
//!   nexus-witness-test    external witness
//!   nexus-bystander-test  in the socket group but NOT allowed
//!   nexus-untrusted-test  no relationship at all
//!
//! The broker binary is the `test-fixtures` build (it only adds an injectable
//! fixture CA/resolver; TLS verification stays mandatory). The provider is a
//! local verified-TLS fixture. This proves cross-UID isolation of the broker.
//! It does NOT claim isolation between same-UID applications.

use super::*;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::process::CommandExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const DESKTOP_USER: &str = "nexus-desktop-test";
const DESKTOP2_USER: &str = "nexus-desktop2-test";
const CLIENT_GROUP: &str = "nexus-brokerclient-test";
const SECRET: &str = "sk-mu-broker-secret-8c1f";
const HOST: &str = "api.provider.test";
const CRED_REF: &str = "credential://connections/conn-e2e-mock";

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

type Recorded = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

struct Provider {
    accepted: Arc<AtomicUsize>,
    requests: Recorded,
}

fn delta(t: &str) -> String {
    format!(
        "data: {{\"type\":\"response.output_text.delta\",\"delta\":{}}}\n\n",
        serde_json::json!(t)
    )
}

fn done_frame() -> String {
    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":4,\"output_tokens\":5}}}\n\n".to_owned()
}

fn serve_tls(l: TcpListener, cert: Vec<u8>, key: Vec<u8>, gap_ms: u64) -> Provider {
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
    let accepted = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let (a, r) = (accepted.clone(), requests.clone());
    std::thread::spawn(move || {
        for _ in 0..16 {
            let Ok((tcp, _)) = l.accept() else { return };
            a.fetch_add(1, Ordering::SeqCst);
            let r = r.clone();
            let cfg = cfg.clone();
            std::thread::spawn(move || {
                tcp.set_read_timeout(Some(Duration::from_secs(10))).ok();
                let Ok(conn) = rustls::ServerConnection::new(cfg) else {
                    return;
                };
                let mut s = rustls::StreamOwned::new(conn, tcp);
                let (mut buf, mut tmp, mut at) = (Vec::new(), [0u8; 4096], None);
                while at.is_none() {
                    match s.read(&mut tmp) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => {
                            buf.extend_from_slice(&tmp[..n]);
                            at = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4);
                        }
                    }
                }
                let at = at.unwrap();
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
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n");
                for f in [
                    delta("Hello "),
                    delta("from "),
                    delta("the fixture"),
                    done_frame(),
                ] {
                    let _ = s.write_all(f.as_bytes());
                    let _ = s.flush();
                    std::thread::sleep(Duration::from_millis(gap_ms));
                }
                s.conn.send_close_notify();
                let _ = s.flush();
            });
        }
    });
    Provider { accepted, requests }
}

fn own(p: &Path, mode: u32, uid: u32, gid: u32) {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
    assert_eq!(
        unsafe { libc::chown(c.as_ptr(), uid, gid) },
        0,
        "chown {}",
        p.display()
    );
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn chown_r(p: &Path, uid: u32, gid: u32) {
    let st = Command::new("chown")
        .arg("-R")
        .arg(format!("{uid}:{gid}"))
        .arg(p)
        .status()
        .unwrap();
    assert!(st.success());
}

struct Rig {
    d: TestDaemon,
    _witness: WitnessRig,
    root: PathBuf,
    sock: PathBuf,
    state: PathBuf,
    transcripts: PathBuf,
    creds: PathBuf,
    registry: PathBuf,
    ca: PathBuf,
    client_gid: u32,
    desktop: u32,
    desktop2: u32,
    provider: Provider,
    broker: Option<Child>,
    handoff_gid: u32,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.stop_broker();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn frame(cmd: &str, params: serde_json::Value) -> String {
    serde_json::json!({"protocol":1,"id":"mu","cmd":cmd,"params":params}).to_string()
}

fn intent(content: &str, key: &str) -> serde_json::Value {
    serde_json::json!({"schemaVersion":1,"requestId":format!("req-{key}"),"idempotencyKey":key,"intentType":"model-only","content":content})
}

impl Rig {
    fn new(tag: &str, gap_ms: u64) -> Option<Rig> {
        let t = require_tool_host(tag)?;
        let desktop = uid_of(DESKTOP_USER)?;
        let desktop2 = uid_of(DESKTOP2_USER)?;
        let client_gid = gid_of(CLIENT_GROUP)?;
        // Daemon with the independent approver AND the external witness, the
        // model pilot enabled: the full identity set around the broker.
        let (mut d, _base, _acap) = spawn_tools_as(&t);
        let w = start_witness_rig(t.h.nexusd_uid)?;
        d.argv.extend([
            "--external-witness".to_owned(),
            w.sock.to_string_lossy().into_owned(),
            "--external-witness-uid".to_owned(),
            w.uid.to_string(),
            "--enable-model-pilot".to_owned(),
        ]);
        d.restart();
        let root = std::env::temp_dir().join(format!(
            "nexus-mu-broker-{}-{}",
            std::process::id(),
            common::next_id("b")
        ));
        std::fs::create_dir_all(&root).unwrap();
        own(&root, 0o755, 0, 0);
        // fixture PKI + provider (ns-root; it plays "the internet")
        let pki = root.join("pki");
        std::fs::create_dir_all(&pki).unwrap();
        sh(
            &pki,
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
            &pki,
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
                "/CN=MU Test CA",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
            ],
        );
        sh(
            &pki,
            &["x509", "-in", "ca.pem", "-outform", "DER", "-out", "ca.der"],
        );
        sh(
            &pki,
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
            &pki,
            &[
                "req", "-new", "-key", "l.key", "-subj", "/CN=leaf", "-out", "l.csr",
            ],
        );
        std::fs::write(pki.join("l.ext"), format!("subjectAltName=DNS:{HOST}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\n")).unwrap();
        sh(
            &pki,
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
            &pki,
            &["x509", "-in", "l.pem", "-outform", "DER", "-out", "l.der"],
        );
        sh(
            &pki,
            &[
                "pkcs8", "-topk8", "-nocrypt", "-in", "l.key", "-outform", "DER", "-out", "l.pk8",
            ],
        );
        let ca = pki.join("ca.der");
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let provider = serve_tls(
            l,
            std::fs::read(pki.join("l.der")).unwrap(),
            std::fs::read(pki.join("l.pk8")).unwrap(),
            gap_ms,
        );
        // Registry fixture (real JS code) -> issuer-owned data root
        let repo_mu = PathBuf::from(std::env::var("NEXUS_MU_REPO").expect("NEXUS_MU_REPO"));
        let registry = root.join("registry");
        std::fs::create_dir_all(&registry).unwrap();
        let driver = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("e2e")
            .join("driver.cjs");
        let out = Command::new("node")
            .arg(driver)
            .args(["registry"])
            .arg(&registry)
            .arg(&repo_mu)
            .arg(port.to_string())
            .arg(format!("https://{HOST}:{port}/v1"))
            .arg("openai-responses")
            .stderr(Stdio::null())
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("\"ok\":true"),
            "registry fixture: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        chown_r(&registry, t.h.issuer_uid, t.h.issuer_gid);
        own(&registry, 0o700, t.h.issuer_uid, t.h.issuer_gid);
        // broker-owned state, private transcripts, protected credential file
        let state = root.join("broker-state");
        let transcripts = root.join("transcripts");
        let sockdir = root.join("sock");
        for p in [&state, &transcripts] {
            std::fs::create_dir_all(p).unwrap();
            own(p, 0o700, t.h.issuer_uid, t.h.issuer_gid);
        }
        std::fs::create_dir_all(&sockdir).unwrap();
        own(&sockdir, 0o750, t.h.issuer_uid, client_gid);
        let creds = root.join("provider-credentials.json");
        std::fs::write(&creds, serde_json::json!({ CRED_REF: SECRET }).to_string()).unwrap();
        own(&creds, 0o600, t.h.issuer_uid, t.h.issuer_gid);
        let sock = sockdir.join("broker.sock");
        Some(Rig {
            handoff_gid: t.h.issuercred_gid,
            d,
            _witness: w,
            root,
            sock,
            state,
            transcripts,
            creds,
            registry,
            ca,
            client_gid,
            desktop,
            desktop2,
            provider,
            broker: None,
        })
    }

    fn start_broker(&mut self) {
        let bin = std::env::var("NEXUS_BROKER_BIN").expect("NEXUS_BROKER_BIN");
        let node = format!("{}/node", Path::new(&bin).parent().unwrap().display());
        let log = std::fs::File::create(
            self.root
                .join(format!("broker-{}.log", common::next_id("l"))),
        )
        .unwrap();
        own(&self.root.join("pki"), 0o755, 0, 0);
        let mut c = Command::new("runuser");
        c.process_group(0)
            .arg("-u")
            .arg(ISSUER_USER)
            .arg("--")
            .arg(&bin)
            .arg("--state-dir")
            .arg(&self.state)
            .arg("--socket")
            .arg(&self.sock)
            .arg("--socket-group")
            .arg(self.client_gid.to_string())
            .arg("--allowed-uids")
            .arg(format!("{},{}", self.desktop, self.desktop2))
            .arg("--daemon-socket")
            .arg(&self.d.socket)
            .arg("--cap")
            .arg(&self.d.handoff)
            .arg("--credentials")
            .arg(&self.creds)
            .arg("--transcript-dir")
            .arg(&self.transcripts)
            .arg("--repo-root")
            .arg(std::env::var("NEXUS_MU_REPO").unwrap())
            .arg("--registry-data-root")
            .arg(&self.registry)
            .arg("--node")
            .arg(node)
            .arg("--test-tls-ca")
            .arg(&self.ca)
            .arg("--test-resolve")
            .arg("127.0.0.1")
            .arg("--test-trust-owner-uid")
            .arg("65534")
            .args(["--read-timeout-ms", "3000", "--total-timeout-ms", "40000"])
            .stdout(Stdio::null())
            .stderr(log);
        self.broker = Some(c.spawn().expect("spawn broker as issuer"));
        let end = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(v) = send_as(
                DESKTOP_USER,
                &self.sock,
                &frame("intent-models", serde_json::json!({})),
            ) {
                if v["ok"] == true {
                    return;
                }
            }
            if Instant::now() >= end {
                let mut log = String::new();
                for e in std::fs::read_dir(&self.root).unwrap().flatten() {
                    if e.file_name().to_string_lossy().ends_with(".log") {
                        log.push_str(&std::fs::read_to_string(e.path()).unwrap_or_default());
                    }
                }
                panic!("broker never became ready; log:\n{log}");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Kill the whole broker process group (runuser wrapper, broker, node).
    fn stop_broker(&mut self) {
        if let Some(mut c) = self.broker.take() {
            unsafe { libc::kill(-(c.id() as i32), libc::SIGKILL) };
            let _ = c.wait();
        }
    }

    fn call(
        &self,
        user: &str,
        cmd: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        send_as(user, &self.sock, &frame(cmd, params))
    }

    fn wait_terminal(&self, user: &str, id: &str) -> serde_json::Value {
        let end = Instant::now() + Duration::from_secs(60);
        loop {
            let r = self
                .call(user, "intent-status", serde_json::json!({"runId": id}))
                .unwrap();
            if r["result"]["run"]["terminal"] == true {
                return r["result"]["run"].clone();
            }
            assert!(Instant::now() < end, "run never finished: {r}");
            std::thread::sleep(Duration::from_millis(150));
        }
    }
}

fn cli_as(rig: &Rig, user: &str, args: &[&str]) -> (i32, serde_json::Value) {
    let cli = std::env::var("NEXUS_CLI_BIN").expect("NEXUS_CLI_BIN");
    let mut a: Vec<String> = vec![
        format!("NEXUS_BROKER_SOCKET={}", rig.sock.display()),
        cli,
        "--json".into(),
    ];
    a.extend(args.iter().map(|s| s.to_string()));
    let refs: Vec<&str> = a.iter().map(|s| s.as_str()).collect();
    let out = run_as(user, "env", &refs).unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    (
        out.status.code().unwrap_or(-1),
        serde_json::from_str(text.trim().lines().last().unwrap_or("{}"))
            .unwrap_or(serde_json::Value::Null),
    )
}

fn denied(user: &str, program: &str, args: &[&str]) -> bool {
    let o = run_as(user, program, args).unwrap();
    !o.status.success() && String::from_utf8_lossy(&o.stderr).contains("Permission denied")
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_broker_end_to_end_across_distinct_identities() {
    let Some(mut rig) = Rig::new("broker-e2e", 500) else {
        return;
    };
    rig.start_broker();
    let input = rig.root.join("input.txt");
    std::fs::write(&input, "hello from the desktop identity").unwrap();
    own(&input, 0o644, 0, 0);

    // 1 + 8. The Desktop UID submits a model-only intent through the CLI;
    // the broker drives Registry -> Kernel grant -> HTTPS fixture.
    let (code, v) = cli_as(
        &rig,
        DESKTOP_USER,
        &[
            "intent",
            "submit",
            "--input",
            input.to_str().unwrap(),
            "--wait",
            "--idempotency-key",
            "mu-desktop-key1",
        ],
    );
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["run"]["state"], "completed", "{v}");
    assert_eq!(v["text"], "Hello from the fixture");
    assert_eq!(v["run"]["clientId"], format!("uid:{}", rig.desktop));
    assert_eq!(v["run"]["endpointKind"], "provider");
    let run1 = v["run"]["runId"].as_str().unwrap().to_owned();
    assert_eq!(rig.provider.accepted.load(Ordering::SeqCst), 1);
    {
        let reqs = rig.provider.requests.lock().unwrap();
        assert!(reqs[0]
            .0
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {SECRET}")));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&reqs[0].1).unwrap()["model"],
            "e2e-mock-model"
        );
    }
    // the real Kernel grant exists for this run (receipt for the command)
    let cap = rig.d.read_handoff();
    let receipt = send_as(
        ISSUER_USER,
        &rig.d.socket,
        &signed_frame(
            &cap,
            "receipt",
            serde_json::json!({"commandId": v["run"]["commandId"]}),
        ),
    )
    .unwrap();
    assert_eq!(receipt["ok"], true, "{receipt}");

    // 2 + 4. The Desktop UID (a member of the socket group) cannot read the
    // issuer capability, the provider credential, broker state, the ledger,
    // transcripts or the daemon's data - group membership grants none of it.
    let dd = rig.d.db.parent().unwrap().to_string_lossy().into_owned();
    for target in [
        rig.d.handoff.to_string_lossy().into_owned(),
        rig.creds.to_string_lossy().into_owned(),
        rig.state.join("broker.lock").to_string_lossy().into_owned(),
        rig.state.join("runs").to_string_lossy().into_owned(),
        rig.state.join("ledger").to_string_lossy().into_owned(),
        rig.transcripts.to_string_lossy().into_owned(),
        rig.registry.to_string_lossy().into_owned(),
        dd,
    ] {
        for user in [DESKTOP_USER, DESKTOP2_USER] {
            assert!(
                denied(user, "ls", &["-ld", &target])
                    || denied(user, "cat", &[&target])
                    || denied(user, "ls", &[&target]),
                "{user} must not reach {target}"
            );
        }
    }
    let id = run_as(DESKTOP_USER, "id", &["-G"]).unwrap();
    assert!(
        String::from_utf8_lossy(&id.stdout)
            .split_whitespace()
            .any(|g| g == rig.client_gid.to_string()),
        "desktop is in the socket group"
    );
    assert!(
        !String::from_utf8_lossy(&id.stdout)
            .split_whitespace()
            .any(|g| g == rig.handoff_gid.to_string()),
        "but not in the issuer-credential group"
    );

    // 3. The Desktop UID cannot reach privileged daemon commands: the daemon
    // socket is not even connectable, and the broker forwards nothing.
    let e = send_as(
        DESKTOP_USER,
        &rig.d.socket,
        "{\"protocol\":1,\"id\":\"x\",\"cmd\":\"health\",\"params\":{}}",
    )
    .unwrap_err();
    assert!(e.contains("Permission denied"), "{e}");
    for cmd in [
        "acquire",
        "seal",
        "accept",
        "dispatch-authorize",
        "model-redeem",
        "tool-execute",
        "workspace-bind",
        "approval-request",
        "approval-decide",
        "write-scope-approve",
        "status",
        "shutdown",
    ] {
        let r = rig
            .call(DESKTOP_USER, cmd, serde_json::json!({"cap": "x"}))
            .unwrap();
        assert_eq!(r["code"], "unknown-command", "{cmd}: {r}");
    }

    // 5. Unauthorized UIDs cannot submit or inspect.
    // In the socket group but not allowed -> the broker refuses by peer UID:
    for (cmd, p) in [
        ("intent-models", serde_json::json!({})),
        (
            "intent-submit",
            serde_json::json!({"intent": intent("x", "mu-bystander-1")}),
        ),
        ("intent-list", serde_json::json!({"limit": 5})),
        ("intent-status", serde_json::json!({"runId": run1})),
    ] {
        let r = rig.call(BYSTANDER_USER, cmd, p).unwrap();
        assert_eq!(
            (r["ok"].as_bool(), r["code"].as_str()),
            (Some(false), Some("unauthorized")),
            "{cmd}: {r}"
        );
    }
    // Not in the socket group at all (untrusted, approver, witness): the kernel refuses.
    for user in [UNTRUSTED_USER, APPROVER_USER, "nexus-witness-test"] {
        let e = rig
            .call(user, "intent-models", serde_json::json!({}))
            .unwrap_err();
        assert!(e.contains("Permission denied"), "{user}: {e}");
    }
    assert_eq!(
        rig.provider.accepted.load(Ordering::SeqCst),
        1,
        "no unauthorized request caused a submission"
    );

    // 6. One authorized UID cannot touch another authorized UID's runs.
    let (code, v2) = cli_as(
        &rig,
        DESKTOP2_USER,
        &[
            "intent",
            "submit",
            "--input",
            input.to_str().unwrap(),
            "--idempotency-key",
            "mu-desktop-key1",
        ],
    );
    assert_eq!(code, 0, "{v2}");
    let run2 = v2["run"]["runId"].as_str().unwrap().to_owned();
    assert_ne!(
        run1, run2,
        "the same key under another UID is a different key"
    );
    assert_eq!(v2["replay"], false);
    for (cmd, p) in [
        ("intent-status", serde_json::json!({"runId": run2})),
        ("intent-result", serde_json::json!({"runId": run2})),
        ("intent-cancel", serde_json::json!({"runId": run2})),
        (
            "intent-follow",
            serde_json::json!({"runId": run2, "offset": 0, "waitMs": 0}),
        ),
    ] {
        let r = rig.call(DESKTOP_USER, cmd, p).unwrap();
        assert_eq!(r["code"], "not-found", "{cmd}: {r}");
    }
    let l1 = rig
        .call(DESKTOP_USER, "intent-list", serde_json::json!({}))
        .unwrap();
    let ids: Vec<String> = l1["result"]["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["runId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, vec![run1.clone()]);
    // the owner is unaffected by the foreign cancel attempt and finishes
    let fin2 = rig.wait_terminal(DESKTOP2_USER, &run2);
    assert_eq!(fin2["state"], "completed", "{fin2}");
    // 6b. a hostile authorized-or-not peer cannot starve authorized clients
    let flood: Vec<_> = (0..30)
        .filter_map(|_| std::os::unix::net::UnixStream::connect(&rig.sock).ok())
        .collect();
    let _ = flood.len(); // the root test process holds the connections (it can connect as root)
    let t = Instant::now();
    let r = rig
        .call(DESKTOP_USER, "intent-models", serde_json::json!({}))
        .unwrap();
    assert_eq!(r["ok"], true);
    assert!(t.elapsed() < Duration::from_secs(6), "{:?}", t.elapsed());
    drop(flood);

    // credentials never in broker log / client-visible data / any readable file
    let mut hay = String::new();
    for e in std::fs::read_dir(&rig.root).unwrap().flatten() {
        if e.file_name().to_string_lossy().ends_with(".log") {
            hay.push_str(&std::fs::read_to_string(e.path()).unwrap_or_default());
        }
    }
    hay.push_str(&v.to_string());
    hay.push_str(&v2.to_string());
    assert!(
        !hay.contains(SECRET),
        "provider secret leaked to a log or client payload"
    );
    assert!(!hay.contains(cap.trim()), "issuer capability leaked");

    // the final run set is exactly what the two clients submitted
    assert_eq!(rig.provider.accepted.load(Ordering::SeqCst), 2);
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_broker_restart_preserves_ownership_and_idempotency_and_leaks_no_process() {
    let Some(mut rig) = Rig::new("broker-restart", 100) else {
        return;
    };
    rig.start_broker();
    let r = rig
        .call(
            DESKTOP_USER,
            "intent-submit",
            serde_json::json!({"intent": intent("persist me", "mu-persist-key1")}),
        )
        .unwrap();
    let id = r["result"]["run"]["runId"].as_str().unwrap().to_owned();
    let fin = rig.wait_terminal(DESKTOP_USER, &id);
    assert_eq!(fin["state"], "completed");
    // SIGKILL the whole broker group (broker + any node child) and restart it.
    rig.stop_broker();
    let _ = std::fs::remove_file(&rig.sock);
    rig.start_broker();
    // ownership survives: same owner sees it, the other UID does not
    let again = rig
        .call(
            DESKTOP_USER,
            "intent-status",
            serde_json::json!({"runId": id}),
        )
        .unwrap();
    assert_eq!(again["result"]["run"]["state"], "completed");
    assert_eq!(
        again["result"]["run"]["clientId"],
        format!("uid:{}", rig.desktop)
    );
    let other = rig
        .call(
            DESKTOP2_USER,
            "intent-status",
            serde_json::json!({"runId": id}),
        )
        .unwrap();
    assert_eq!(other["code"], "not-found");
    // idempotency survives: the same key replays the same run, no new attempt
    let rep = rig
        .call(
            DESKTOP_USER,
            "intent-submit",
            serde_json::json!({"intent": intent("persist me", "mu-persist-key1")}),
        )
        .unwrap();
    assert_eq!(rep["result"]["replay"], true);
    assert_eq!(rep["result"]["run"]["runId"], id);
    let conflict = rig
        .call(
            DESKTOP_USER,
            "intent-submit",
            serde_json::json!({"intent": intent("different", "mu-persist-key1")}),
        )
        .unwrap();
    assert_eq!(conflict["code"], "idempotency-conflict");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        rig.provider.accepted.load(Ordering::SeqCst),
        1,
        "restart never causes a second submission"
    );
    // model-only still works through the existing grants after the restart
    let n = rig
        .call(
            DESKTOP2_USER,
            "intent-submit",
            serde_json::json!({"intent": intent("after restart", "mu-after-key01")}),
        )
        .unwrap();
    let id2 = n["result"]["run"]["runId"].as_str().unwrap().to_owned();
    assert_eq!(rig.wait_terminal(DESKTOP2_USER, &id2)["state"], "completed");
    // Stopping the broker reaps everything it started (no broker/executor/node leak).
    let pid = rig.broker.as_ref().unwrap().id() as i32;
    rig.stop_broker();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        unsafe { libc::kill(-pid, 0) },
        -1,
        "the broker process group is gone"
    );
    let still = Command::new("pgrep")
        .args(["-f", "^/tmp/nxmu/bin/nexus-broker"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&still.stdout).trim().is_empty(),
        "leaked broker: {}",
        String::from_utf8_lossy(&still.stdout)
    );
}
