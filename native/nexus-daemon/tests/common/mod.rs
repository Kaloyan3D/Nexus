#![allow(dead_code)]
//! Real-subprocess harness for nexusd tests: every test drives the actual
//! `nexusd` binary over a real Unix socket in a temporary DataRoot. No
//! production task data is touched.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static SEQ: AtomicU64 = AtomicU64::new(1);

pub fn nexusd_bin() -> PathBuf {
    if let Ok(p) = std::env::var("NEXUSD_BIN") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/debug/nexusd")
}

pub fn kernel_bin() -> PathBuf {
    if let Ok(p) = std::env::var("NEXUS_KERNEL_BIN") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/debug/nexus-kernel")
}

pub struct DaemonProc {
    pub _dir: tempfile::TempDir,
    pub child: Child,
    pub socket: PathBuf,
    pub db: PathBuf,
    pub witness: PathBuf,
    pub cap: PathBuf,
}

pub fn spawn_daemon(trust: &str, with_witness: bool) -> DaemonProc {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("k.db");
    let witness = dir.path().join("k.witness.db");
    let socket = dir.path().join("n.sock");
    let cap = dir.path().join("issuer.cap");
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&db)
        .arg("--socket")
        .arg(&socket)
        .arg("--cap")
        .arg(&cap)
        .arg("--trust-mode")
        .arg(trust)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if with_witness {
        cmd.arg("--witness").arg(&witness);
    }
    let mut child = cmd.spawn().expect("spawn nexusd");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = raw_request(
            &socket,
            r#"{"protocol":1,"id":"ready-poll","cmd":"health","params":{}}"#,
        ) {
            if resp.get("ok") == Some(&serde_json::Value::Bool(true)) {
                break;
            }
        }
        if Instant::now() > deadline {
            terminate(&mut child);
            panic!("daemon never became ready");
        }
        match child.try_wait() {
            Ok(Some(status)) => panic!("daemon exited early: {status}"),
            Ok(None) => {}
            Err(e) => panic!("wait failed: {e}"),
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    DaemonProc {
        _dir: dir,
        child,
        socket,
        db,
        witness,
        cap,
    }
}

/// SIGTERM (graceful), then SIGKILL fallback after a bounded wait.
pub fn terminate(child: &mut Child) {
    let pid = child.id();
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {}
            Err(_) => return,
        }
        if Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// SIGKILL: models a crash (no graceful shutdown, no socket cleanup).
pub fn crash(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// One request frame -> one parsed response line.
pub fn raw_request(socket: &Path, frame: &str) -> Result<serde_json::Value, String> {
    let mut stream = UnixStream::connect(socket).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(frame.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    if line.trim().is_empty() {
        return Err("empty response".to_owned());
    }
    serde_json::from_str(line.trim()).map_err(|e| e.to_string())
}

pub fn read_cap(cap: &Path) -> String {
    std::fs::read_to_string(cap)
        .expect("cap readable")
        .trim()
        .to_owned()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Independent request signer (hand-rolled HMAC over the documented auth
/// bytes, not the daemon's own signer): proves the wire contract, not just
/// a round-trip through one implementation.
pub fn sign(
    cap_hex: &str,
    cmd: &str,
    id: &str,
    params: &serde_json::Value,
    nonce: &str,
    ts: i64,
) -> String {
    use hmac::Mac;
    let mut envelope = serde_json::Map::new();
    envelope.insert("protocol".to_owned(), serde_json::Value::from(1u64));
    envelope.insert("id".to_owned(), serde_json::Value::String(id.to_owned()));
    envelope.insert("cmd".to_owned(), serde_json::Value::String(cmd.to_owned()));
    envelope.insert("params".to_owned(), params.clone());
    envelope.insert(
        "nonce".to_owned(),
        serde_json::Value::String(nonce.to_owned()),
    );
    envelope.insert("ts".to_owned(), serde_json::Value::from(ts));
    let canonical = nexus_contracts::canonical_json(&serde_json::Value::Object(envelope));
    let key = hex::decode(cap_hex.trim()).expect("cap hex");
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(&key).expect("hmac key");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn next_id(tag: &str) -> String {
    format!("{tag}-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

pub fn next_nonce() -> String {
    format!(
        "{:032x}{:032x}",
        SEQ.fetch_add(1, Ordering::Relaxed),
        now_ms() as u64
    )
}

pub fn authed_frame(cap_hex: &str, cmd: &str, params: serde_json::Value) -> String {
    let id = next_id("req");
    let nonce = next_nonce();
    let ts = now_ms();
    let tag = sign(cap_hex, cmd, &id, &params, &nonce, ts);
    serde_json::json!({
        "protocol": 1,
        "id": id,
        "cmd": cmd,
        "params": params,
        "auth": { "nonce": nonce, "ts": ts, "tag": tag },
    })
    .to_string()
}

pub fn code_of(resp: &serde_json::Value) -> String {
    resp.get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_owned()
}

pub fn assert_ok(resp: &serde_json::Value) -> &serde_json::Value {
    assert_eq!(
        resp.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "expected ok, got {resp}"
    );
    resp
}

pub fn assert_refused(resp: &serde_json::Value, code: &str) {
    assert_eq!(
        resp.get("ok"),
        Some(&serde_json::Value::Bool(false)),
        "expected refusal, got {resp}"
    );
    assert_eq!(code_of(resp), code, "wrong refusal code: {resp}");
}

// -- kernel-shaped fixtures (same shapes as nexus-kernel tests/common) --

pub fn rev3() -> serde_json::Value {
    serde_json::json!(3)
}

pub fn snapshot() -> serde_json::Value {
    serde_json::json!({"schemaVersion": 1, "tag": "daemon-test-snapshot", "modes": []})
}

/// Real contract types serialized to wire JSON: fixtures are valid by
/// construction, never hand-built digests.
pub fn resolution_for(task: &str, snapshot: &serde_json::Value) -> serde_json::Value {
    use nexus_contracts::{
        ExecutionTargetCoreV1, RegistryProvenanceV1, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION,
    };
    let target = ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", rev3());
    let target_value = serde_json::to_value(&target).expect("target value");
    let provisional = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
        issuer: "nexus-registry-bridge/1".to_owned(),
        task_instance_id: task.to_owned(),
        role: "muse_main".to_owned(),
        target,
        provenance: RegistryProvenanceV1 {
            issuer: "nexus-registry-bridge/1".to_owned(),
            resolution_id_compat: "compat".to_owned(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(snapshot),
            target_digest: nexus_contracts::target_digest_of(&target_value),
            mode_config_revision: rev3(),
            issuance_id: String::new(),
        },
    };
    let issuance_id = provisional.issuance_id_of();
    let mut issued = provisional;
    issued.provenance.issuance_id = issuance_id;
    serde_json::to_value(&issued).expect("resolution value")
}

pub fn intent_for(task: &str, attempt: &str, command: &str) -> serde_json::Value {
    let intent = nexus_contracts::ControllerIntentV1::build(
        task,
        attempt,
        command,
        "native",
        1,
        "muse_main",
        "engineering-v2",
        rev3(),
        serde_json::json!({"op": "engineer-turn"}),
    );
    serde_json::to_value(&intent).expect("intent value")
}

/// Full privileged flow: acquire -> seal -> accept. Returns the receipt.
pub fn accept_one(
    socket: &Path,
    cap_hex: &str,
    task: &str,
    attempt: &str,
    command: &str,
) -> serde_json::Value {
    let acquired = raw_request(
        socket,
        &authed_frame(
            cap_hex,
            "acquire",
            serde_json::json!({"taskInstanceId": task, "backend": "native"}),
        ),
    )
    .expect("acquire transport");
    assert_ok(&acquired);
    let lease = acquired.get("lease").expect("lease").clone();
    let snapshot = snapshot();
    let resolution = resolution_for(task, &snapshot);
    let sealed = raw_request(
        socket,
        &authed_frame(
            cap_hex,
            "seal",
            serde_json::json!({"resolution": resolution}),
        ),
    )
    .expect("seal transport");
    assert_ok(&sealed);
    let intent = intent_for(task, attempt, command);
    let accepted = raw_request(
        socket,
        &authed_frame(
            cap_hex,
            "accept",
            serde_json::json!({
                "intent": intent,
                "resolution": resolution,
                "snapshot": snapshot,
                "lease": { "epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation") },
            }),
        ),
    )
    .expect("accept transport");
    assert_ok(&accepted);
    accepted
}
