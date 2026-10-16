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

/// A5.5: the simulated MODEL. It reads each request body and answers with
/// the SSE frames of one provider response (function calls or text).
type Responder = Arc<dyn Fn(usize, &serde_json::Value) -> Vec<String> + Send + Sync>;

#[derive(Default)]
struct RigOpts {
    /// Enable the repo-inspect pilot and a read-only workspace named `demo`.
    repo_inspect: bool,
    responder: Option<Responder>,
}

fn sse_ev(ev: &str, v: serde_json::Value) -> String {
    format!("event: {ev}\ndata: {v}\n\n")
}

fn completed_ev(resp: &str) -> String {
    sse_ev(
        "response.completed",
        serde_json::json!({"type":"response.completed","response":{"id":resp,"status":"completed","usage":{"input_tokens":50,"output_tokens":20}}}),
    )
}

fn call_frames(resp: &str, n: usize, call_id: &str, name: &str, args: &str) -> Vec<String> {
    let item = format!("fc_{n}");
    vec![
        sse_ev(
            "response.created",
            serde_json::json!({"type":"response.created","response":{"id":resp,"status":"in_progress"}}),
        ),
        sse_ev(
            "response.output_item.added",
            serde_json::json!({"type":"response.output_item.added","item":{"type":"function_call","id":item,"call_id":call_id,"name":name,"arguments":""}}),
        ),
        sse_ev(
            "response.function_call_arguments.delta",
            serde_json::json!({"type":"response.function_call_arguments.delta","item_id":item,"delta":args}),
        ),
        sse_ev(
            "response.output_item.done",
            serde_json::json!({"type":"response.output_item.done","item":{"type":"function_call","id":item,"call_id":call_id,"name":name,"arguments":args}}),
        ),
        completed_ev(resp),
    ]
}

fn text_frames(resp: &str, text: &str) -> Vec<String> {
    vec![
        sse_ev(
            "response.created",
            serde_json::json!({"type":"response.created","response":{"id":resp,"status":"in_progress"}}),
        ),
        sse_ev(
            "response.output_text.delta",
            serde_json::json!({"type":"response.output_text.delta","delta":text}),
        ),
        completed_ev(resp),
    ]
}

fn last_output(body: &serde_json::Value) -> Option<serde_json::Value> {
    body["input"]
        .as_array()?
        .iter()
        .rev()
        .find(|i| i["type"] == "function_call_output")
        .and_then(|i| i["output"].as_str())
        .and_then(|s| serde_json::from_str(s).ok())
}

/// list -> search -> read -> grounded answer, every step derived from the
/// real tool result in the request.
fn investigate_responder() -> Responder {
    Arc::new(|n, body| {
        let resp = format!("resp_{n}");
        match n {
            0 => call_frames(&resp, n, "call_list", "fs_list", r#"{"path":"."}"#),
            1 => {
                let out = last_output(body).expect("list output");
                assert!(out["result"]["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["name"] == "src"));
                call_frames(
                    &resp,
                    n,
                    "call_search",
                    "fs_search",
                    r#"{"query":"authorize_model_execution","path":"src"}"#,
                )
            }
            2 => {
                let out = last_output(body).expect("search output");
                let def = out["result"]["matches"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| {
                        m["text"]
                            .as_str()
                            .unwrap_or("")
                            .contains("pub fn authorize_model_execution")
                    })
                    .expect("definition")
                    .clone();
                let args = serde_json::json!({"path": def["path"], "startLine": def["line"].as_u64().unwrap() - 1, "maxLines": 12}).to_string();
                call_frames(&resp, n, "call_read", "fs_read", &args)
            }
            _ => text_frames(&resp, "Authorization is decided in src/auth.rs:5-13."),
        }
    })
}

fn serve_tls_reactive(
    l: TcpListener,
    cert: Vec<u8>,
    key: Vec<u8>,
    responder: Responder,
) -> Provider {
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
        for _ in 0..32 {
            let Ok((tcp, _)) = l.accept() else { return };
            let n = a.fetch_add(1, Ordering::SeqCst);
            tcp.set_read_timeout(Some(Duration::from_secs(10))).ok();
            let Ok(conn) = rustls::ServerConnection::new(cfg.clone()) else {
                return;
            };
            let mut s = rustls::StreamOwned::new(conn, tcp);
            let (mut buf, mut tmp, mut at) = (Vec::new(), [0u8; 8192], None);
            while at.is_none() {
                match s.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => {
                        buf.extend_from_slice(&tmp[..k]);
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
                    Ok(k) => body.extend_from_slice(&tmp[..k]),
                }
            }
            let parsed: serde_json::Value =
                serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
            r.lock().unwrap().push((head, body));
            let frames = responder(n, &parsed);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n");
            for f in frames {
                let _ = s.write_all(format!("{:x}\r\n{}\r\n", f.len(), f).as_bytes());
                let _ = s.flush();
            }
            let _ = s.write_all(b"0\r\n\r\n");
            s.conn.send_close_notify();
            let _ = s.flush();
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
    /// A5.5: daemon-owned read-only repository (None unless repo_inspect).
    workspace: Option<PathBuf>,
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
        Self::new_opts(tag, gap_ms, RigOpts::default())
    }

    fn new_opts(tag: &str, gap_ms: u64, opts: RigOpts) -> Option<Rig> {
        let t = require_tool_host(tag)?;
        let desktop = uid_of(DESKTOP_USER)?;
        let desktop2 = uid_of(DESKTOP2_USER)?;
        let client_gid = gid_of(CLIENT_GROUP)?;
        // Daemon with the independent approver AND the external witness, the
        // model pilot enabled: the full identity set around the broker.
        let (mut d, base, _acap) = spawn_tools_as(&t);
        let w = start_witness_rig(t.h.nexusd_uid)?;
        d.argv.extend([
            "--external-witness".to_owned(),
            w.sock.to_string_lossy().into_owned(),
            "--external-witness-uid".to_owned(),
            w.uid.to_string(),
            "--enable-model-pilot".to_owned(),
        ]);
        if opts.repo_inspect {
            d.argv.push("--enable-repo-inspect".to_owned());
        }
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
        let (cert, key) = (
            std::fs::read(pki.join("l.der")).unwrap(),
            std::fs::read(pki.join("l.pk8")).unwrap(),
        );
        let provider = match opts.responder.clone() {
            Some(rsp) => serve_tls_reactive(l, cert, key, rsp),
            None => serve_tls(l, cert, key, gap_ms),
        };
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
            .args(if opts.repo_inspect {
                vec!["opencode-go-responses"]
            } else {
                vec![]
            })
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
        // A5.5: a daemon-owned repository. Only the daemon UID (the tool
        // executor) and the broker's issuer group can traverse it; neither
        // Desktop UID can read a byte of it directly.
        let workspace = if opts.repo_inspect {
            let ws = base.join("repo");
            for (rel, text) in [
                ("README.md", "# demo\n"),
                ("src/auth.rs", "//! Authorization gate.\nuse crate::dispatch::Grant;\n\n/// Decide whether a model request may execute.\npub fn authorize_model_execution(prompt: &str, scope: &str) -> Option<Grant> {\n    if scope != \"model-only\" {\n        return None;\n    }\n    if prompt.is_empty() {\n        return None;\n    }\n    Some(Grant { scope: scope.to_owned() })\n}\n"),
                ("src/dispatch.rs", "use crate::auth::authorize_model_execution;\n\npub fn run_model(prompt: &str) {\n    let _ = authorize_model_execution(prompt, \"model-only\");\n}\n"),
                (".env", "API_KEY=MU-REPO-SECRET-do-not-leak-4411\n"),
            ] {
                let p = ws.join(rel);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(&p, text).unwrap();
            }
            chown_r(&ws, t.h.nexusd_uid, t.h.issuer_gid);
            let _ = Command::new("chmod")
                .args(["-R", "u=rwX,g=rX,o=", ws.to_str().unwrap()])
                .status();
            let _ = Command::new("chmod")
                .args(["600", ws.join(".env").to_str().unwrap()])
                .status();
            Some(ws)
        } else {
            None
        };
        Some(Rig {
            workspace,
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
            .args(["--read-timeout-ms", "3000", "--total-timeout-ms", "40000"]);
        if let Some(ws) = &self.workspace {
            // only the FIRST Desktop UID may select it
            c.arg("--workspace")
                .arg(format!("demo={}", ws.display()))
                .arg("--workspace-allow")
                .arg(format!("demo={}", self.desktop));
        }
        c.stdout(Stdio::null()).stderr(log);
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

/// CLI as `user` with extra environment (a private local transcript dir).
fn cli_env_as(rig: &Rig, user: &str, local: &Path, args: &[&str]) -> (i32, serde_json::Value) {
    let cli = std::env::var("NEXUS_CLI_BIN").expect("NEXUS_CLI_BIN");
    let mut a: Vec<String> = vec![
        format!("NEXUS_BROKER_SOCKET={}", rig.sock.display()),
        format!("NEXUS_TRANSCRIPT_DIR={}", local.display()),
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

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_desktop_contract_reads_runs_without_transcript_access() {
    let Some(mut rig) = Rig::new("desktop-contract", 700) else {
        return;
    };
    rig.start_broker();
    let input = rig.root.join("input.txt");
    std::fs::write(&input, "hello from the desktop identity").unwrap();
    own(&input, 0o644, 0, 0);
    // each Desktop UID has its OWN private local transcript dir (empty)
    let (l1, l2) = (rig.root.join("local-d1"), rig.root.join("local-d2"));
    for (p, u) in [(&l1, rig.desktop), (&l2, rig.desktop2)] {
        std::fs::create_dir_all(p).unwrap();
        own(p, 0o700, u, u);
    }
    let mut seen_output = String::new();

    // 1-2. Desktop submits; the broker runs the real chain.
    let (c, v) = cli_env_as(
        &rig,
        DESKTOP_USER,
        &l1,
        &[
            "intent",
            "submit",
            "--input",
            input.to_str().unwrap(),
            "--idempotency-key",
            "mu-dc-key-0001",
        ],
    );
    assert_eq!(c, 0, "{v}");
    let run_id = v["run"]["runId"].as_str().unwrap().to_owned();
    seen_output.push_str(&v.to_string());

    // 4. Desktop contract: list -> conversation id, then incremental reads by cursor.
    let end = Instant::now() + Duration::from_secs(60);
    let conv = loop {
        let (_, l) = cli_env_as(&rig, DESKTOP_USER, &l1, &["intent", "desktop", "list"]);
        if let Some(e) = l["value"].as_array().and_then(|a| a.first()) {
            assert_eq!(e["firstPrompt"], "hello from the desktop identity");
            assert_eq!(e["providerId"], "e2e-mock");
            break e["conversationId"].as_str().unwrap().to_owned();
        }
        assert!(Instant::now() < end, "conversation never appeared");
        std::thread::sleep(Duration::from_millis(150));
    };
    let mut cursor: Option<u64> = None;
    let mut partials: Vec<String> = Vec::new();
    let mut last_user = String::new();
    loop {
        let mut args = vec!["intent", "desktop", "conversation", conv.as_str()];
        let cur = cursor.map(|c| c.to_string());
        if let Some(c) = &cur {
            args.extend(["--after", c.as_str()]);
        }
        let (code, r) = cli_env_as(&rig, DESKTOP_USER, &l1, &args);
        assert_eq!(code, 0, "{r}");
        let view = &r["value"];
        assert_eq!(view["source"], "native-store");
        if let Some(h) = view["page"]["headSeq"].as_u64() {
            cursor = Some(h);
        }
        for e in view["page"]["events"].as_array().unwrap() {
            if e["kind"] == "assistant-message" {
                partials.push(e["text"].as_str().unwrap_or("").to_owned());
            }
            if e["kind"] == "user-message" {
                last_user = e["text"].as_str().unwrap_or("").to_owned();
            }
        }
        seen_output.push_str(&r.to_string());
        let (_, s) = cli_env_as(
            &rig,
            DESKTOP_USER,
            &l1,
            &["intent", "desktop", "status", &conv],
        );
        if s["value"]["terminal"] == true {
            assert_eq!(s["value"]["state"], "completed", "{s}");
            assert_eq!(s["value"]["providerId"], "e2e-mock");
            assert_eq!(s["value"]["usageInputTokens"], 4);
            break;
        }
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(150));
    }
    assert_eq!(last_user, "hello from the desktop identity");
    assert!(
        partials.len() >= 2,
        "streamed incrementally through the broker: {partials:?}"
    );
    assert_eq!(
        partials.last().unwrap(),
        "Hello from the fixture",
        "complete response, no transcript read"
    );
    assert_eq!(rig.provider.accepted.load(Ordering::SeqCst), 1);

    // 5. Reconnect/resume from the correct byte offset (fresh process each call).
    let full = "Hello from the fixture";
    let mid = 11u64; // "Hello from " boundary
    let f = rig
        .call(
            DESKTOP_USER,
            "intent-follow",
            serde_json::json!({"runId": run_id, "offset": mid, "waitMs": 0}),
        )
        .unwrap();
    assert_eq!(f["result"]["textDelta"], &full[mid as usize..]);
    assert_eq!(f["result"]["nextOffset"], full.len());
    let bad = rig
        .call(
            DESKTOP_USER,
            "intent-follow",
            serde_json::json!({"runId": run_id, "offset": 9999, "waitMs": 0}),
        )
        .unwrap();
    assert_eq!(bad["code"], "bad-offset");

    // 3 / 8. The Desktop UID cannot read the private transcript files directly.
    let tdir = rig.transcripts.to_string_lossy().into_owned();
    let tfile = format!("{tdir}/{conv}.jsonl");
    for user in [DESKTOP_USER, DESKTOP2_USER] {
        assert!(
            denied(user, "ls", &[&tdir]),
            "{user} must not list the transcript dir"
        );
        assert!(
            denied(user, "cat", &[&tfile]),
            "{user} must not read the transcript file"
        );
    }

    // 7. The other authorized Desktop UID sees nothing of this run.
    let (_, o) = cli_env_as(
        &rig,
        DESKTOP2_USER,
        &l2,
        &["intent", "desktop", "conversation", &conv],
    );
    assert_eq!(o["value"]["available"], false, "{o}");
    assert!(
        !o.to_string().contains("Hello from the fixture")
            && !o.to_string().contains("hello from the desktop")
    );
    let (_, ol) = cli_env_as(&rig, DESKTOP2_USER, &l2, &["intent", "desktop", "list"]);
    assert_eq!(ol["value"].as_array().map(|a| a.len()), Some(0));
    let (c2, os) = cli_env_as(
        &rig,
        DESKTOP2_USER,
        &l2,
        &["intent", "desktop", "status", &conv],
    );
    assert_ne!(c2, 0, "{os}");
    let (c3, _) = cli_env_as(
        &rig,
        DESKTOP2_USER,
        &l2,
        &["intent", "desktop", "cancel", &conv],
    );
    assert_ne!(
        c3, 0,
        "a foreign UID cannot cancel through the Desktop contract either"
    );

    // 6. Cancellation through the Desktop contract reaches the executor.
    let (_, v2) = cli_env_as(
        &rig,
        DESKTOP_USER,
        &l1,
        &[
            "intent",
            "submit",
            "--input",
            input.to_str().unwrap(),
            "--idempotency-key",
            "mu-dc-key-0002",
        ],
    );
    let run2 = v2["run"]["runId"].as_str().unwrap().to_owned();
    let conv2 = loop {
        let (_, s) = cli_env_as(&rig, DESKTOP_USER, &l1, &["intent", "desktop", "list"]);
        let hit = s["value"]
            .as_array()
            .and_then(|a| a.iter().find(|e| e["state"] == "streaming").cloned());
        if let Some(e) = hit {
            break e["conversationId"].as_str().unwrap().to_owned();
        }
        assert!(Instant::now() < end, "second run never streamed");
        std::thread::sleep(Duration::from_millis(100));
    };
    let (cc, cr) = cli_env_as(
        &rig,
        DESKTOP_USER,
        &l1,
        &["intent", "desktop", "cancel", &conv2],
    );
    assert_eq!(cc, 0, "{cr}");
    let fin = rig.wait_terminal(DESKTOP_USER, &run2);
    assert_eq!(fin["state"], "cancelled", "{fin}");
    assert_eq!(
        rig.provider.accepted.load(Ordering::SeqCst),
        2,
        "one submission per run, no resend"
    );

    // 8. No private state or credential in anything the Desktop saw or logged.
    let mut hay = seen_output;
    for e in std::fs::read_dir(&rig.root).unwrap().flatten() {
        if e.file_name().to_string_lossy().ends_with(".log") {
            hay.push_str(&std::fs::read_to_string(e.path()).unwrap_or_default());
        }
    }
    let cap = rig.d.read_handoff();
    assert!(!hay.contains(SECRET) && !hay.contains(cap.trim()));
    assert!(!hay.contains("provider-credentials") && !hay.contains("broker-state"));

    // 9. No process remains.
    let pid = rig.broker.as_ref().unwrap().id() as i32;
    rig.stop_broker();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(unsafe { libc::kill(-pid, 0) }, -1);
    let still = Command::new("pgrep")
        .args(["-f", "^/tmp/nxmu/bin/nexus-broker"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&still.stdout).trim().is_empty());
}

/// A5.5: the read-only tool boundary under REAL distinct kernel UIDs.
///
/// The tool executor is the daemon UID; the broker/issuer UID sequences the
/// loop; two Desktop UIDs are authorized broker clients but only the FIRST may
/// select the `demo` workspace; neither can read one byte of the repository,
/// the credentials, the transcripts or the daemon directly. The model is
/// simulated by a local verified-TLS provider; everything else is real.
#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_a55_repo_inspect_read_only_tools_across_distinct_identities() {
    let Some(mut rig) = Rig::new_opts(
        "inspect-e2e",
        0,
        RigOpts {
            repo_inspect: true,
            responder: Some(investigate_responder()),
        },
    ) else {
        return;
    };
    rig.start_broker();
    let ws = rig.workspace.clone().unwrap();
    let task = rig.root.join("task.txt");
    std::fs::write(
        &task,
        "Find the function that authorizes model execution and cite it.",
    )
    .unwrap();
    own(&task, 0o644, 0, 0);

    // 1. workspace identities are per-UID; a path never crosses the protocol
    let (code, v) = cli_as(&rig, DESKTOP_USER, &["intent", "workspaces"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(
        v["workspaces"],
        serde_json::json!([{"workspaceId": "demo"}])
    );
    assert!(!v.to_string().contains(ws.to_str().unwrap()));
    let (code, v2) = cli_as(&rig, DESKTOP2_USER, &["intent", "workspaces"]);
    assert_eq!(code, 0, "{v2}");
    assert_eq!(v2["workspaces"], serde_json::json!([]));

    // 2. neither Desktop UID can read the repository (or its secret) directly
    for user in [DESKTOP_USER, DESKTOP2_USER] {
        for t in [
            ws.join("src/auth.rs"),
            ws.join(".env"),
            ws.clone(),
            ws.parent().unwrap().to_path_buf(),
        ] {
            let ts = t.to_string_lossy().into_owned();
            assert!(
                denied(user, "cat", &[&ts])
                    || denied(user, "ls", &["-ld", &ts])
                    || denied(user, "ls", &[&ts]),
                "{user} must not reach {ts}"
            );
        }
    }

    // 3. the allowed Desktop UID runs the whole agentic loop through the CLI
    let (code, v) = cli_as(
        &rig,
        DESKTOP_USER,
        &[
            "intent",
            "submit",
            "--type",
            "repo-inspect",
            "--workspace",
            "demo",
            "--input",
            task.to_str().unwrap(),
            "--max-output-tokens",
            "512",
            "--wait",
            "--idempotency-key",
            "mu-inspect-key1",
        ],
    );
    assert_eq!(code, 0, "{v}");
    let run = v["run"].clone();
    assert_eq!(run["state"], "completed", "{run}");
    assert_eq!(run["clientId"], format!("uid:{}", rig.desktop));
    assert_eq!(run["workspaceId"], "demo");
    assert_eq!(run["toolCalls"], 3, "{run}");
    let tools: Vec<&str> = run["toolActivity"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["tool"].as_str().unwrap())
        .collect();
    assert_eq!(tools, ["fs_list", "fs_search", "fs_read"]);
    assert!(run["toolActivity"]
        .as_array()
        .unwrap()
        .iter()
        .all(|a| a["status"] == "executed" && a["executionId"].is_string()));
    assert!(v["text"].as_str().unwrap().contains("src/auth.rs:5-13"));
    assert_eq!(run["citationsVerified"][0], "src/auth.rs:5-13", "{run}");
    assert_eq!(
        rig.provider.accepted.load(Ordering::SeqCst),
        4,
        "four provider calls, no more"
    );
    {
        let reqs = rig.provider.requests.lock().unwrap();
        assert!(reqs[0]
            .0
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {SECRET}")));
        let first: serde_json::Value = serde_json::from_slice(&reqs[0].1).unwrap();
        assert_eq!(first["tools"].as_array().unwrap().len(), 3);
        for (_, body) in reqs.iter() {
            let t = String::from_utf8_lossy(body);
            assert!(
                !t.contains("MU-REPO-SECRET"),
                "repo secret reached the provider"
            );
            assert!(
                !t.contains(SECRET),
                "provider credential reached the provider body"
            );
        }
    }

    // 4. the real Kernel journal (daemon UID) recorded each call as a
    //    model-initiated READ, under the turn that proposed it
    let task_id = run["taskId"].as_str().unwrap();
    let ti = run["taskInstanceId"].as_str().unwrap();
    for turn in 1..=3 {
        let r = send_as(
            ISSUER_USER,
            &rig.d.socket,
            &frame(
                "tool-events",
                serde_json::json!({"taskInstanceId": ti, "attemptId": format!("{task_id}-A{turn}"), "limit": 50}),
            ),
        )
        .unwrap();
        let recs = r["records"].as_array().unwrap_or_else(|| panic!("{r}"));
        assert_eq!(recs[0]["phase"], "authorized");
        assert_eq!(recs[0]["scope"], "read");
        assert_eq!(recs[0]["aiInitiated"], true, "{r}");
        assert!(recs.iter().all(|x| ["fs.list", "fs.search", "fs.read"]
            .contains(&x["toolId"].as_str().unwrap_or("fs.list"))));
    }

    // 5. cross-UID isolation of the run, its tool activity and its transcript
    let run_id = run["runId"].as_str().unwrap().to_owned();
    let conv = run["conversationId"].as_str().unwrap().to_owned();
    for (cmd, p) in [
        ("intent-status", serde_json::json!({"runId": run_id})),
        ("intent-result", serde_json::json!({"runId": run_id})),
        ("intent-cancel", serde_json::json!({"runId": run_id})),
        (
            "intent-follow",
            serde_json::json!({"runId": run_id, "offset": 0, "waitMs": 0}),
        ),
        (
            "intent-conversation",
            serde_json::json!({"conversationId": conv}),
        ),
    ] {
        let r = rig.call(DESKTOP2_USER, cmd, p).unwrap();
        assert_eq!(r["code"], "not-found", "{cmd}: {r}");
    }
    let l2 = rig
        .call(DESKTOP2_USER, "intent-list", serde_json::json!({}))
        .unwrap();
    assert_eq!(l2["result"]["runs"].as_array().unwrap().len(), 0);
    let conv_view = rig
        .call(
            DESKTOP_USER,
            "intent-conversation",
            serde_json::json!({"conversationId": conv, "limit": 200}),
        )
        .unwrap();
    let ct = conv_view.to_string();
    assert!(
        ct.contains("fs_read") && ct.contains("toolresult-"),
        "tool activity is in the owner's conversation"
    );
    assert!(!ct.contains("MU-REPO-SECRET"));
    // the second UID may not select the workspace even though the broker allows it to connect
    let r = rig
        .call(
            DESKTOP2_USER,
            "intent-submit",
            serde_json::json!({"intent": {"schemaVersion":1,"requestId":"r2","idempotencyKey":"mu-inspect-key2","intentType":"repo-inspect","content":"x","workspaceId":"demo"}}),
        )
        .unwrap();
    assert_eq!(r["code"], "workspace-not-allowed", "{r}");

    // 6. no client can smuggle a path or authority into the intent
    for bad in [
        serde_json::json!({"workspaceId": "/"}),
        serde_json::json!({"workspaceId": "demo", "workspace": ws.to_str().unwrap()}),
        serde_json::json!({"workspaceId": "demo", "root": "/"}),
        serde_json::json!({"workspaceId": "demo", "tools": ["fs_write"]}),
        serde_json::json!({"workspaceId": "demo", "toolPolicy": "all"}),
    ] {
        let mut i = serde_json::json!({"schemaVersion":1,"requestId":"r3","idempotencyKey":"mu-inspect-bad1","intentType":"repo-inspect","content":"x"});
        for (k, val) in bad.as_object().unwrap() {
            i[k] = val.clone();
        }
        let r = rig
            .call(
                DESKTOP_USER,
                "intent-submit",
                serde_json::json!({"intent": i}),
            )
            .unwrap();
        assert_eq!(r["ok"], false, "{bad}: {r}");
        assert_eq!(r["code"], "bad-intent", "{bad}: {r}");
    }

    // 7. unauthorized identities cannot enumerate or use workspaces; the
    //    privileged daemon verbs stay unreachable from every client UID
    let r = rig
        .call(BYSTANDER_USER, "intent-workspaces", serde_json::json!({}))
        .unwrap();
    assert_eq!(r["code"], "unauthorized", "{r}");
    let e = rig
        .call(UNTRUSTED_USER, "intent-workspaces", serde_json::json!({}))
        .unwrap_err();
    assert!(e.contains("Permission denied"), "{e}");
    for user in [DESKTOP_USER, DESKTOP2_USER] {
        let e = send_as(
            user,
            &rig.d.socket,
            &frame("tool-execute", serde_json::json!({})),
        )
        .unwrap_err();
        assert!(e.contains("Permission denied"), "{user}: {e}");
    }
    for cmd in [
        "tool-execute",
        "workspace-bind",
        "dispatch-authorize",
        "model-redeem",
    ] {
        let r = rig.call(DESKTOP_USER, cmd, serde_json::json!({})).unwrap();
        assert_eq!(r["code"], "unknown-command", "{cmd}: {r}");
    }
    assert_eq!(
        rig.provider.accepted.load(Ordering::SeqCst),
        4,
        "none of the above caused a provider call"
    );
}
