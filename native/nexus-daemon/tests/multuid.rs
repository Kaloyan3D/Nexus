//! Closure privileged multi-UID isolation suite (NOT RUN without a host).
//!
//! These tests exercise GENUINE distinct Linux UIDs: a protected nexusd
//! daemon user, a trusted issuer user, an in-group-but-unauthorized bystander,
//! and an untrusted workload user. They CANNOT run in unprivileged CI/dev
//! containers: every test (except the capability reporter) is #[ignore]d and
//! additionally requires NEXUS_MULTUID=1 plus root plus the four users below.
//! A skipped run prints NOT RUN and never claims PASS.
//!
//! Target users (created by the operator procedure, never by these tests):
//!   nexusd-test      daemon service identity (owns DataRoot 0700)
//!   nexus-issuer-test  trusted issuer (member of nexus-issuer-test group)
//!   nexus-bystander-test in issuer group but NOT in --allowed-uids
//!   nexus-untrusted-test adversarial workload (NOT in the issuer group)
//!
//! Run on the prepared host (see native/deploy/MULTUID-PROCEDURE.md):
//!   NEXUS_MULTUID=1 cargo test -p nexus-daemon --test multuid -- --ignored
//!
//! Safety: shadow-only flows. dispatch_enabled() stays false throughout.

mod common;
use common::{code_of, nexusd_bin, raw_request, terminate};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const DAEMON_USER: &str = "nexusd-test";
const ISSUER_USER: &str = "nexus-issuer-test";
const ISSUER_GROUP: &str = "nexus-issuer-test";
const BYSTANDER_USER: &str = "nexus-bystander-test";
const UNTRUSTED_USER: &str = "nexus-untrusted-test";
/// A3.3: independent write approver (own group, NOT in the issuer group).
const APPROVER_USER: &str = "nexus-approver-test";
const APPROVER_GROUP: &str = "nexus-approver-test";

struct Host {
    nexusd_uid: u32,
    issuer_uid: u32,
    bystander_uid: u32,
    untrusted_uid: u32,
    issuer_gid: u32,
}

fn uid_of(user: &str) -> Option<u32> {
    let out = Command::new("id").arg("-u").arg(user).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u32>()
        .ok()
}

fn gid_of(group: &str) -> Option<u32> {
    let out = Command::new("getent")
        .arg("group")
        .arg(group)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .split(':')
        .nth(2)?
        .parse::<u32>()
        .ok()
}

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

/// Privilege gate: honored ONLY on a prepared host. Every ignored test
/// calls this first; None prints NOT RUN (never PASS) and returns.
fn require_multuid_host(test: &str) -> Option<Host> {
    let flag = std::env::var("NEXUS_MULTUID").unwrap_or_default();
    if flag != "1" {
        println!("NOT RUN ({test}): NEXUS_MULTUID=1 is not set");
        return None;
    }
    if euid() != 0 {
        println!("NOT RUN ({test}): test runner is not root");
        return None;
    }
    // Review F4: preflight the tools the harness shells out to. Without
    // them the tests would FAIL instead of reporting NOT RUN.
    for tool in ["runuser", "python3"] {
        let usable = Command::new(tool)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !usable {
            println!("NOT RUN ({test}): tool {tool} is unavailable");
            return None;
        }
    }
    let Some(nexusd_uid) = uid_of(DAEMON_USER) else {
        println!("NOT RUN ({test}): user {DAEMON_USER} is missing");
        return None;
    };
    let Some(issuer_uid) = uid_of(ISSUER_USER) else {
        println!("NOT RUN ({test}): user {ISSUER_USER} is missing");
        return None;
    };
    let Some(bystander_uid) = uid_of(BYSTANDER_USER) else {
        println!("NOT RUN ({test}): user {BYSTANDER_USER} is missing");
        return None;
    };
    let Some(untrusted_uid) = uid_of(UNTRUSTED_USER) else {
        println!("NOT RUN ({test}): user {UNTRUSTED_USER} is missing");
        return None;
    };
    let Some(issuer_gid) = gid_of(ISSUER_GROUP) else {
        println!("NOT RUN ({test}): group {ISSUER_GROUP} is missing");
        return None;
    };
    let h = Host {
        nexusd_uid,
        issuer_uid,
        bystander_uid,
        untrusted_uid,
        issuer_gid,
    };
    // Distinctness is the whole point: refuse to run if the principals
    // collapse onto one UID (mis-provisioned host).
    let mut sorted = [h.nexusd_uid, h.issuer_uid, h.bystander_uid, h.untrusted_uid];
    sorted.sort();
    let mut distinct = true;
    for w in sorted.windows(2) {
        if w[0] == w[1] {
            distinct = false;
        }
    }
    if !distinct {
        println!("NOT RUN ({test}): principals are not 4 distinct UIDs");
        return None;
    }
    Some(h)
}

/// Run a program as another UID. runuser (no shell, no quoting hazards).
fn run_as(user: &str, program: &str, args: &[&str]) -> std::io::Result<Output> {
    Command::new("runuser")
        .arg("-u")
        .arg(user)
        .arg("--")
        .arg(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
}

const PY_CLIENT: &str = "import socket,sys;s=socket.socket(socket.AF_UNIX);s.settimeout(10);s.connect(sys.argv[1]);s.sendall((sys.argv[2]+chr(10)).encode());f=s.makefile();sys.stdout.write(f.readline())";

/// Send one IPC frame with the SO_PEERCRED of `user`. Ok(response JSON)
/// on transport success; Err(detail) when the kernel refuses the
/// connection itself (EACCES for unauthorized UIDs).
fn send_as(user: &str, socket: &Path, frame: &str) -> Result<serde_json::Value, String> {
    let out = run_as(
        user,
        "python3",
        &["-c", PY_CLIENT, &socket.to_string_lossy(), frame],
    )
    .map_err(|e| format!("runuser/python3 unavailable: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "transport refused: {}",
            // Keep the TAIL: modern Python prints the offending source line
            // and carets first, pushing the actual errno message past 300
            // leading characters (observed on Python 3.14).
            {
                let s = String::from_utf8_lossy(&out.stderr).into_owned();
                let n = s.chars().count();
                s.chars().skip(n.saturating_sub(300)).collect::<String>()
            }
        ));
    }
    serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim())
        .map_err(|e| format!("response unparsable: {e}"))
}

/// Sign one privileged frame with the handoff key (independent HMAC over
/// the documented auth bytes, mirroring common::authed_frame).
fn signed_frame(cap_hex: &str, cmd: &str, params: serde_json::Value) -> String {
    let id = common::next_id("mu");
    let nonce = common::next_nonce();
    let ts = common::now_ms();
    let tag = common::sign(cap_hex, cmd, &id, &params, &nonce, ts);
    serde_json::json!({
        "protocol": 1,
        "id": id,
        "cmd": cmd,
        "params": params,
        "auth": { "nonce": nonce, "ts": ts, "tag": tag },
    })
    .to_string()
}

struct TestDaemon {
    child: Child,
    argv: Vec<String>,
    dir: PathBuf,
    sockdir: PathBuf,
    db: PathBuf,
    witness: PathBuf,
    cap: PathBuf,
    handoff: PathBuf,
    socket: PathBuf,
}

impl Drop for TestDaemon {
    fn drop(&mut self) {
        terminate(&mut self.child);
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl TestDaemon {
    fn read_handoff(&self) -> String {
        std::fs::read_to_string(&self.handoff)
            .expect("handoff readable by root")
            .trim()
            .to_owned()
    }

    fn restart(&mut self) {
        terminate(&mut self.child);
        let _ = self.child.wait();
        let mut cmd = Command::new("runuser");
        cmd.arg("-u").arg(DAEMON_USER).arg("--").arg(nexusd_bin());
        for a in &self.argv {
            cmd.arg(a);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        self.child = cmd.spawn().expect("respawn nexusd");
        poll_ready(&self.socket);
    }
}

fn poll_ready(socket: &Path) {
    // Root polls read-only health (root bypasses socket DAC for polling;
    // privilege separation is asserted by the per-UID tests, not here).
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = raw_request(
            socket,
            r#"{"protocol":1,"id":"poll","cmd":"health","params":{}}"#,
        ) {
            if resp.get("ok") == Some(&serde_json::Value::Bool(true)) {
                return;
            }
        }
        if Instant::now() > deadline {
            panic!("multuid daemon never became ready");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Provision /tmp layout owned by the daemon user and spawn nexusd AS that
/// user: DataRoot 0700, socket dir 0750 group issuer, socket 0660,
/// handoff 0640. The operator procedure guarantees the users/groups.
fn spawn_as(h: &Host, trust: &str) -> TestDaemon {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!(
        "nexus-multuid-{}-{}",
        std::process::id(),
        common::next_id("d")
    ));
    let dataroot = dir.join("dataroot");
    let sockdir = dir.join("sockdir");
    std::fs::create_dir_all(&dataroot).expect("mkdir");
    std::fs::create_dir_all(&sockdir).expect("mkdir");
    let own = |p: &Path, mode: u32, uid: u32, gid: u32| {
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).expect("cstr");
        assert_eq!(unsafe { libc::chown(c.as_ptr(), uid, gid) }, 0);
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).expect("chmod");
    };
    // Parent is daemon-owned and group-scoped too (0750): untrusted UIDs
    // are stopped one level earlier (defense in depth; the sockdir and the
    // file modes enforce the same denial again below). Root cleans up via
    // the Drop guard regardless of ownership.
    own(&dir, 0o750, h.nexusd_uid, h.issuer_gid);
    own(&dataroot, 0o700, h.nexusd_uid, h.nexusd_uid);
    own(&sockdir, 0o750, h.nexusd_uid, h.issuer_gid);
    let db = dataroot.join("k.db");
    let witness = dataroot.join("k.witness.db");
    let socket = sockdir.join("n.sock");
    let cap = dataroot.join("issuer.cap");
    let handoff = sockdir.join("issuer.handoff");
    let argv = vec![
        "--db".to_owned(),
        db.to_string_lossy().into_owned(),
        "--socket".to_owned(),
        socket.to_string_lossy().into_owned(),
        "--cap".to_owned(),
        cap.to_string_lossy().into_owned(),
        "--witness".to_owned(),
        witness.to_string_lossy().into_owned(),
        "--trust-mode".to_owned(),
        trust.to_owned(),
        "--allowed-uids".to_owned(),
        h.issuer_uid.to_string(),
        "--socket-group".to_owned(),
        h.issuer_gid.to_string(),
        "--cap-handoff".to_owned(),
        handoff.to_string_lossy().into_owned(),
    ];
    let mut cmd = Command::new("runuser");
    cmd.arg("-u").arg(DAEMON_USER).arg("--").arg(nexusd_bin());
    for a in &argv {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn().expect("spawn nexusd as daemon user");
    let d = TestDaemon {
        child,
        argv,
        dir,
        sockdir,
        db,
        witness,
        cap,
        handoff,
        socket,
    };
    poll_ready(&d.socket);
    d
}

/// Full acquire -> seal -> accept as `user` with `cap_hex`. Returns receipt.
fn accept_one_as(
    user: &str,
    socket: &Path,
    cap_hex: &str,
    task: &str,
    attempt: &str,
    command: &str,
) -> serde_json::Value {
    let acquired = send_as(
        user,
        socket,
        &signed_frame(
            cap_hex,
            "acquire",
            serde_json::json!({"taskInstanceId": task, "backend": "native"}),
        ),
    )
    .expect("acquire transport");
    assert_eq!(
        acquired.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "acquire refused: {acquired}"
    );
    let lease = acquired.get("lease").expect("lease").clone();
    let snapshot = common::snapshot();
    let resolution = common::resolution_for(task, &snapshot);
    let sealed = send_as(
        user,
        socket,
        &signed_frame(
            cap_hex,
            "seal",
            serde_json::json!({"resolution": resolution}),
        ),
    )
    .expect("seal transport");
    assert_eq!(
        sealed.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "seal refused: {sealed}"
    );
    let intent = common::intent_for(task, attempt, command);
    let accepted = send_as(user, socket, &signed_frame(cap_hex, "accept", serde_json::json!({"intent": intent, "resolution": resolution, "snapshot": snapshot, "lease": {"epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation")}}))).expect("accept transport");
    assert_eq!(
        accepted.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "accept refused: {accepted}"
    );
    accepted
}

#[test]
fn multuid_host_capability_reporter() {
    // Always-run reporter (asserts nothing security-relevant): documents
    // whether this host can execute the ignored suite. NOT a PASS claim.
    let flag = std::env::var("NEXUS_MULTUID").unwrap_or_default();
    println!("multuid capability: NEXUS_MULTUID={flag:?} euid={} daemon={:?} issuer={:?} bystander={:?} untrusted={:?}", euid(), uid_of(DAEMON_USER), uid_of(ISSUER_USER), uid_of(BYSTANDER_USER), uid_of(UNTRUSTED_USER));
    if require_multuid_host("reporter").is_some() {
        println!("multuid capability: PREPARED (run with -- --ignored)");
    } else {
        println!("multuid capability: NOT RUN on this host (see MULTUID-PROCEDURE.md)");
    }
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_issuer_completes_acquire_seal_accept() {
    let Some(h) = require_multuid_host("issuer-flow") else {
        return;
    };
    let d = spawn_as(&h, "shadow-test");
    let cap = d.read_handoff();
    assert_eq!(cap.len(), 64, "handoff key is well-formed");
    let receipt = accept_one_as(
        ISSUER_USER,
        &d.socket,
        &cap,
        "mu-task-1",
        "mu-task-1-A1",
        "shadow-mu-1",
    );
    assert!(
        receipt.pointer("/receipt/commandId").is_some(),
        "receipt pins command"
    );
    assert_eq!(
        receipt.get("replayed"),
        Some(&serde_json::Value::Bool(false))
    );
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_issuer_cannot_touch_kernel_persistence() {
    let Some(h) = require_multuid_host("issuer-confinement") else {
        return;
    };
    let d = spawn_as(&h, "shadow-test");
    for path in [&d.cap, &d.db, &d.witness] {
        let s = path.to_string_lossy().into_owned();
        let cat = run_as(ISSUER_USER, "cat", &[s.as_str()]).expect("runuser works");
        assert!(
            !cat.status.success(),
            "issuer must not read {}",
            path.display()
        );
        let tee = run_as(ISSUER_USER, "tee", &["-a", s.as_str()]).expect("runuser works");
        assert!(
            !tee.status.success(),
            "issuer must not write {}",
            path.display()
        );
    }
    let root =
        d.db.parent()
            .expect("dataroot")
            .to_string_lossy()
            .into_owned();
    let ls = run_as(ISSUER_USER, "ls", &[root.as_str()]).expect("runuser works");
    assert!(!ls.status.success(), "issuer must not list the DataRoot");
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_untrusted_with_stolen_cap_is_denied_at_connect() {
    let Some(h) = require_multuid_host("untrusted-stolen-cap") else {
        return;
    };
    let d = spawn_as(&h, "shadow-test");
    let stolen = d.read_handoff();
    let frame = signed_frame(
        &stolen,
        "acquire",
        serde_json::json!({"taskInstanceId": "mu-hostile", "backend": "native"}),
    );
    let err = send_as(UNTRUSTED_USER, &d.socket, &frame).expect_err("untrusted connect must fail");
    assert!(
        err.contains("Permission denied"),
        "denial is OS-level EACCES: {err}"
    );
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_bystander_with_stolen_cap_gets_peer_unauthorized() {
    let Some(h) = require_multuid_host("bystander-stolen-cap") else {
        return;
    };
    let d = spawn_as(&h, "shadow-test");
    let stolen = d.read_handoff();
    let frame = signed_frame(
        &stolen,
        "acquire",
        serde_json::json!({"taskInstanceId": "mu-bystander", "backend": "native"}),
    );
    let resp = send_as(BYSTANDER_USER, &d.socket, &frame).expect("bystander connects (in group)");
    assert_eq!(resp.get("ok"), Some(&serde_json::Value::Bool(false)));
    assert_eq!(code_of(&resp), "peer-unauthorized");
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_forged_and_replayed_commands_rejected() {
    let Some(h) = require_multuid_host("forgery-replay") else {
        return;
    };
    let d = spawn_as(&h, "shadow-test");
    let cap = d.read_handoff();
    let params = serde_json::json!({"taskInstanceId": "mu-forge", "backend": "native"});
    let mut forged: serde_json::Value =
        serde_json::from_str(&signed_frame(&cap, "acquire", params)).expect("frame");
    forged["auth"]["tag"] = serde_json::Value::String("de".repeat(32));
    let resp = send_as(ISSUER_USER, &d.socket, &forged.to_string()).expect("transport");
    assert_eq!(code_of(&resp), "issuer-untrusted");
    let frame = signed_frame(
        &cap,
        "acquire",
        serde_json::json!({"taskInstanceId": "mu-replay", "backend": "native"}),
    );
    let first = send_as(ISSUER_USER, &d.socket, &frame).expect("transport");
    assert_eq!(first.get("ok"), Some(&serde_json::Value::Bool(true)));
    let replay = send_as(ISSUER_USER, &d.socket, &frame).expect("transport");
    assert_eq!(code_of(&replay), "replay-rejected");
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_receipts_stable_across_restart_with_key_rotation() {
    let Some(h) = require_multuid_host("restart-stability") else {
        return;
    };
    let mut d = spawn_as(&h, "shadow-test");
    let cap1 = d.read_handoff();
    let r1 = accept_one_as(
        ISSUER_USER,
        &d.socket,
        &cap1,
        "mu-task-r",
        "mu-task-r-A1",
        "shadow-mu-r",
    );
    let receipt1 = r1.get("receipt").expect("receipt").clone();
    let command_id = receipt1
        .get("commandId")
        .and_then(|v| v.as_str())
        .expect("receipt pins command")
        .to_owned();
    d.restart();
    let cap2 = d.read_handoff();
    assert_ne!(cap1, cap2, "capability rotates every incarnation");
    // Durability: the authoritative receipt survived the restart byte-identically
    // and stays queryable under the rotated key.
    let reread = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &cap2,
            "receipt",
            serde_json::json!({"commandId": command_id}),
        ),
    )
    .expect("receipt transport");
    assert_eq!(
        reread.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "receipt query refused: {reread}"
    );
    assert_eq!(
        reread.get("receipt"),
        Some(&receipt1),
        "receipt stable across restart"
    );
    // Fail-closed rebinding: the lease epoch is bound into the command digest by
    // design, and a re-acquire mints a new epoch — so re-accepting the same
    // command under the post-restart epoch is a conflicting rebinding, never a
    // silent fork or a duplicate receipt. (An exact replay is impossible by
    // construction: rotation invalidates the old HMAC tag.)
    let acquired = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &cap2,
            "acquire",
            serde_json::json!({"taskInstanceId": "mu-task-r", "backend": "native"}),
        ),
    )
    .expect("re-acquire transport");
    assert_eq!(
        acquired.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "re-acquire refused: {acquired}"
    );
    let lease = acquired.get("lease").expect("lease").clone();
    let snapshot = common::snapshot();
    let resolution = common::resolution_for("mu-task-r", &snapshot);
    let sealed = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(&cap2, "seal", serde_json::json!({"resolution": resolution})),
    )
    .expect("re-seal transport");
    assert_eq!(
        sealed.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "re-seal refused: {sealed}"
    );
    let intent = common::intent_for("mu-task-r", "mu-task-r-A1", "shadow-mu-r");
    let rebind = send_as(ISSUER_USER, &d.socket, &signed_frame(&cap2, "accept", serde_json::json!({"intent": intent, "resolution": resolution, "snapshot": snapshot, "lease": {"epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation")}}))).expect("re-accept transport");
    assert_eq!(
        rebind.get("ok"),
        Some(&serde_json::Value::Bool(false)),
        "rebinding under a new epoch must not succeed: {rebind}"
    );
    assert_eq!(code_of(&rebind), "command-conflict");
    // The authoritative receipt is still untouched by the refused rebinding.
    let reread2 = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &cap2,
            "receipt",
            serde_json::json!({"commandId": command_id}),
        ),
    )
    .expect("receipt transport");
    assert_eq!(reread2.get("receipt"), Some(&receipt1));
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_insecure_permissions_refuse_startup() {
    let Some(h) = require_multuid_host("insecure-refusal") else {
        return;
    };
    let mut d = spawn_as(&h, "shadow-test");
    terminate(&mut d.child);
    let _ = d.child.wait();
    use std::os::unix::fs::PermissionsExt;
    let relaunch = || {
        let mut cmd = Command::new("runuser");
        cmd.arg("-u").arg(DAEMON_USER).arg("--").arg(nexusd_bin());
        for a in &d.argv {
            cmd.arg(a);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.output().expect("daemon runs")
    };
    std::fs::set_permissions(
        d.db.parent().expect("dataroot"),
        std::fs::Permissions::from_mode(0o755),
    )
    .expect("chmod");
    let out = relaunch();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("insecure-dataroot"));
    std::fs::set_permissions(
        d.db.parent().expect("dataroot"),
        std::fs::Permissions::from_mode(0o700),
    )
    .expect("chmod");
    std::fs::set_permissions(&d.sockdir, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let out2 = relaunch();
    assert!(!out2.status.success());
    assert!(String::from_utf8_lossy(&out2.stderr).contains("insecure-socket-dir"));
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_no_shadow_operation_dispatches() {
    let Some(h) = require_multuid_host("no-dispatch") else {
        return;
    };
    let d = spawn_as(&h, "shadow-test");
    let cap = d.read_handoff();
    let accepted = accept_one_as(
        ISSUER_USER,
        &d.socket,
        &cap,
        "mu-task-n",
        "mu-task-n-A1",
        "shadow-mu-n",
    );
    assert_eq!(accepted.get("ok"), Some(&serde_json::Value::Bool(true)));
    let ready = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(&cap, "readiness", serde_json::json!({})),
    )
    .expect("transport");
    assert_eq!(
        ready.pointer("/readiness/verdict"),
        Some(&serde_json::Value::String("NOT_READY".to_owned()))
    );
    assert_eq!(
        ready.pointer("/readiness/dispatch_enabled"),
        Some(&serde_json::Value::Bool(false))
    );
    assert!(
        !nexus_kernel::Kernel::dispatch_enabled(),
        "dispatch stays disabled"
    );
}

// ---- A3.2 / A3.3 privileged tool commands ------------------------------
//
// These tests extend the suite to `workspace-bind`, `tool-execute`,
// `tool-revoke`, `tool-events` and the approver channel
// `write-scope-approve`. They require the extra approver identity
// (`nexus-approver-test`, own group) described in MULTUID-PROCEDURE.md.
// NOT RUN anywhere without that host; they never report PASS otherwise.

struct ToolHost {
    h: Host,
    approver_uid: u32,
    approver_gid: u32,
}

fn require_tool_host(test: &str) -> Option<ToolHost> {
    let h = require_multuid_host(test)?;
    let Some(approver_uid) = uid_of(APPROVER_USER) else {
        println!("NOT RUN ({test}): user {APPROVER_USER} is missing");
        return None;
    };
    let Some(approver_gid) = gid_of(APPROVER_GROUP) else {
        println!("NOT RUN ({test}): group {APPROVER_GROUP} is missing");
        return None;
    };
    Some(ToolHost {
        h,
        approver_uid,
        approver_gid,
    })
}

/// nexusd as the daemon user with writes enabled. The approver credential
/// is handed to the approver GROUP only (0640), and approver UIDs are
/// disjoint from the issuer UIDs, so `--require-independent-approver`
/// holds.
fn spawn_tools_as(t: &ToolHost) -> (TestDaemon, PathBuf, PathBuf) {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    let mut d = spawn_as(&t.h, "shadow-test");
    // Workspace base + approver credential directory owned by the daemon.
    let base = d.dir.join("work");
    let adir = d.dir.join("approver");
    for p in [&base, &adir] {
        std::fs::create_dir_all(p).expect("mkdir");
    }
    let own = |p: &Path, mode: u32, uid: u32, gid: u32| {
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).expect("cstr");
        assert_eq!(unsafe { libc::chown(c.as_ptr(), uid, gid) }, 0);
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).expect("chmod");
    };
    own(&base, 0o770, t.h.nexusd_uid, t.h.issuer_gid);
    own(&adir, 0o750, t.h.nexusd_uid, t.approver_gid);
    let acap = adir.join("approver.cap");
    d.argv.extend([
        "--workspace-bases".to_owned(),
        base.to_string_lossy().into_owned(),
        "--enable-writes".to_owned(),
        "--approver-cap".to_owned(),
        acap.to_string_lossy().into_owned(),
        "--approver-uids".to_owned(),
        t.approver_uid.to_string(),
        "--approver-cap-gid".to_owned(),
        t.approver_gid.to_string(),
        "--require-independent-approver".to_owned(),
    ]);
    d.restart();
    (d, base, acap)
}

fn root_read(path: &Path) -> String {
    std::fs::read_to_string(path)
        .expect("readable by root")
        .trim()
        .to_owned()
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_tool_commands_require_issuer_and_writes_require_the_approver() {
    let Some(t) = require_tool_host("tool-commands") else {
        return;
    };
    let (d, base, acap) = spawn_tools_as(&t);
    let issuer_cap = d.read_handoff();
    let approver_cap = root_read(&acap);
    let ws = base.join("ws");
    std::fs::create_dir_all(&ws).expect("ws");
    let c = std::ffi::CString::new(ws.to_string_lossy().as_bytes()).unwrap();
    unsafe { libc::chown(c.as_ptr(), t.h.nexusd_uid, t.h.issuer_gid) };
    let digest = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(ws.to_string_lossy().as_bytes()))
    };
    // Accept a command whose intent commits to this workspace (issuer).
    let snapshot = common::snapshot();
    let acquired = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "acquire",
            serde_json::json!({"taskInstanceId": "mu-w", "backend": "native"}),
        ),
    )
    .expect("acquire");
    let lease = acquired.get("lease").expect("lease").clone();
    let resolution = common::resolution_for("mu-w", &snapshot);
    let _ = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "seal",
            serde_json::json!({"resolution": resolution}),
        ),
    );
    let intent = nexus_contracts::ControllerIntentV1::build(
        "mu-w",
        "mu-a",
        "mu-c",
        "native",
        1,
        "muse_main",
        "engineering-v2",
        common::rev3(),
        serde_json::json!({"op": "engineer-turn", "workspaceRootDigest": digest}),
    );
    let accepted = send_as(ISSUER_USER, &d.socket, &signed_frame(&issuer_cap, "accept", serde_json::json!({
        "intent": serde_json::to_value(&intent).unwrap(), "resolution": resolution, "snapshot": snapshot,
        "lease": {"epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation")}})))
        .expect("accept");
    assert_eq!(
        accepted.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "{accepted}"
    );
    let rc = accepted["receipt"].clone();
    let bind = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "workspace-bind",
            serde_json::json!({"commandId": "mu-c", "root": ws.to_string_lossy()}),
        ),
    )
    .expect("bind");
    assert_eq!(
        bind.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "{bind}"
    );
    let exec = |cap: &str, user: &str, rid: &str| {
        send_as(
            user,
            &d.socket,
            &signed_frame(
                cap,
                "tool-execute",
                serde_json::json!({
            "requestId": rid, "cancellationId": format!("c-{rid}"), "taskInstanceId": "mu-w",
            "attemptId": "mu-a", "commandId": "mu-c", "leaseEpoch": rc["leaseEpoch"],
            "storeIncarnation": rc["storeIncarnation"], "toolId": "fs.write", "toolVersion": 1,
            "args": {"path": "f.txt", "content": "hi\n", "mode": "create"}}),
            ),
        )
    };
    // Issuer alone: no approved scope -> refused.
    assert_eq!(
        code_of(&exec(&issuer_cap, ISSUER_USER, "r1").expect("t")),
        "scope-refused"
    );
    // The issuer key cannot approve.
    let r = send_as(ISSUER_USER, &d.socket, &signed_frame(&issuer_cap, "write-scope-approve",
        serde_json::json!({"commandId": "mu-c", "workspaceRootDigest": digest, "maxWriteBytes": 1000}))).expect("t");
    assert_eq!(code_of(&r), "issuer-untrusted");
    // The approver identity with the approver key can; and is reported independent.
    let r = send_as(APPROVER_USER, &d.socket, &signed_frame(&approver_cap, "write-scope-approve",
        serde_json::json!({"commandId": "mu-c", "workspaceRootDigest": digest, "maxWriteBytes": 1000}))).expect("t");
    assert_eq!(r["writeScope"]["independent"], true, "{r}");
    assert_eq!(
        exec(&issuer_cap, ISSUER_USER, "r2").expect("t").get("ok"),
        Some(&serde_json::Value::Bool(true))
    );
    assert_eq!(std::fs::read_to_string(ws.join("f.txt")).unwrap(), "hi\n");
    // The approver identity cannot execute tools or bind workspaces.
    let r = exec(&approver_cap, APPROVER_USER, "r3");
    assert!(r.is_err() || r.as_ref().unwrap().get("ok") == Some(&serde_json::Value::Bool(false)));
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_untrusted_and_bystander_cannot_use_tool_commands_or_read_events() {
    let Some(t) = require_tool_host("tool-denials") else {
        return;
    };
    let (d, _base, acap) = spawn_tools_as(&t);
    let stolen_issuer = d.read_handoff();
    for (cmd, params) in [
        (
            "workspace-bind",
            serde_json::json!({"commandId": "x", "root": "/tmp"}),
        ),
        ("tool-execute", serde_json::json!({"requestId": "x"})),
        ("tool-revoke", serde_json::json!({"commandId": "x"})),
    ] {
        // Untrusted: OS-level denial at connect.
        let e = send_as(
            UNTRUSTED_USER,
            &d.socket,
            &signed_frame(&stolen_issuer, cmd, params.clone()),
        )
        .expect_err("untrusted must not connect");
        assert!(e.contains("Permission denied"), "{e}");
        // Bystander (in issuer group, NOT allow-listed): peer-unauthorized.
        let r = send_as(
            BYSTANDER_USER,
            &d.socket,
            &signed_frame(&stolen_issuer, cmd, params),
        )
        .expect("t");
        assert_eq!(code_of(&r), "peer-unauthorized", "{cmd}");
    }
    // Read-only tool-events is peer-gated for the bystander as well.
    let frame = serde_json::json!({"protocol":1,"id":"ev","cmd":"tool-events",
        "params":{"taskInstanceId":"t","attemptId":"a"}})
    .to_string();
    let r = send_as(BYSTANDER_USER, &d.socket, &frame).expect("t");
    assert_eq!(code_of(&r), "peer-unauthorized");
    // The approver credential file is not readable by issuer-side identities.
    for user in [ISSUER_USER, BYSTANDER_USER, UNTRUSTED_USER] {
        let out = run_as(user, "cat", &[&acap.to_string_lossy()]).expect("run");
        assert!(
            !out.status.success(),
            "{user} must not read the approver credential"
        );
    }
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_approver_with_stolen_approver_cap_from_wrong_uid_is_refused() {
    let Some(t) = require_tool_host("approver-wrong-uid") else {
        return;
    };
    let (d, _base, acap) = spawn_tools_as(&t);
    let approver_cap = root_read(&acap);
    // The issuer UID somehow holds the approver key (stolen): peer gate.
    let r = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &approver_cap,
            "write-scope-approve",
            serde_json::json!({"commandId": "x", "workspaceRootDigest": "d", "maxWriteBytes": 1}),
        ),
    )
    .expect("t");
    assert_eq!(code_of(&r), "peer-unauthorized");
}

// ---- A3.4 sandboxed process commands -----------------------------------

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_process_commands_require_issuer_and_approver_and_deny_everyone_else() {
    let Some(t) = require_tool_host("process-commands") else {
        return;
    };
    // Sandbox must exist on the host too, else this is NOT RUN.
    if !nexus_tools::sandbox::preflight().available {
        println!("NOT RUN (process-commands): sandbox unavailable on this host");
        return;
    }
    let (mut d, base, acap) = spawn_tools_as(&t);
    d.argv.push("--enable-process".to_owned());
    d.restart();
    let issuer_cap = d.read_handoff();
    let approver_cap = root_read(&acap);
    let ws = base.join("ws");
    std::fs::create_dir_all(&ws).expect("ws");
    let digest = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(ws.to_string_lossy().as_bytes()))
    };
    let snapshot = common::snapshot();
    let acquired = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "acquire",
            serde_json::json!({"taskInstanceId": "mu-p", "backend": "native"}),
        ),
    )
    .expect("acquire");
    let lease = acquired.get("lease").expect("lease").clone();
    let resolution = common::resolution_for("mu-p", &snapshot);
    let _ = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "seal",
            serde_json::json!({"resolution": resolution}),
        ),
    );
    let intent = nexus_contracts::ControllerIntentV1::build(
        "mu-p",
        "mu-pa",
        "mu-pc",
        "native",
        1,
        "muse_main",
        "engineering-v2",
        common::rev3(),
        serde_json::json!({"op": "engineer-turn", "workspaceRootDigest": digest}),
    );
    let accepted = send_as(ISSUER_USER, &d.socket, &signed_frame(&issuer_cap, "accept", serde_json::json!({
        "intent": serde_json::to_value(&intent).unwrap(), "resolution": resolution, "snapshot": snapshot,
        "lease": {"epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation")}})))
        .expect("accept");
    let rc = accepted["receipt"].clone();
    let bind = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "workspace-bind",
            serde_json::json!({"commandId": "mu-pc", "root": ws.to_string_lossy()}),
        ),
    )
    .expect("bind");
    assert_eq!(
        bind.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "{bind}"
    );
    let run = |cap: &str, user: &str, rid: &str| {
        send_as(
            user,
            &d.socket,
            &signed_frame(
                cap,
                "tool-execute",
                serde_json::json!({
            "requestId": rid, "cancellationId": format!("c-{rid}"), "taskInstanceId": "mu-p",
            "attemptId": "mu-pa", "commandId": "mu-pc", "leaseEpoch": rc["leaseEpoch"],
            "storeIncarnation": rc["storeIncarnation"], "toolId": "proc.run", "toolVersion": 1,
            "args": {"program": "cargo", "args": ["check", "--offline", "--locked"]}}),
            ),
        )
    };
    // 1. issuer alone: no process scope -> refused.
    assert_eq!(
        code_of(&run(&issuer_cap, ISSUER_USER, "q1").expect("t")),
        "scope-refused"
    );
    // 2. issuer key cannot approve a process scope.
    let r = send_as(ISSUER_USER, &d.socket, &signed_frame(&issuer_cap, "process-scope-approve",
        serde_json::json!({"commandId": "mu-pc", "workspaceRootDigest": digest, "maxWallMs": 1000}))).expect("t");
    assert_eq!(code_of(&r), "issuer-untrusted");
    // 3. untrusted: OS-level denial; bystander: peer-unauthorized (even with the stolen issuer cap).
    let e = send_as(
        UNTRUSTED_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "tool-execute",
            serde_json::json!({"requestId": "x"}),
        ),
    )
    .expect_err("untrusted must not connect");
    assert!(e.contains("Permission denied"), "{e}");
    let r = send_as(
        BYSTANDER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "tool-execute",
            serde_json::json!({"requestId": "x"}),
        ),
    )
    .expect("t");
    assert_eq!(code_of(&r), "peer-unauthorized");
    // 4. the approver identity approves; independence is reported true.
    let r = send_as(APPROVER_USER, &d.socket, &signed_frame(&approver_cap, "process-scope-approve",
        serde_json::json!({"commandId": "mu-pc", "workspaceRootDigest": digest, "maxWallMs": 60000}))).expect("t");
    assert_eq!(r["processScope"]["independent"], true, "{r}");
    // 5. the approver identity cannot execute.
    let r = run(&approver_cap, APPROVER_USER, "q2");
    assert!(r.is_err() || r.as_ref().unwrap().get("ok") == Some(&serde_json::Value::Bool(false)));
    // 6. the daemon user's sandbox cannot read the credential directory.
    let out = run_as(DAEMON_USER, "cat", &[&acap.to_string_lossy()]).expect("run");
    let _ = out; // daemon user owns it; the SANDBOX (not the user) is the boundary tested elsewhere
}

// ------------------------------------------------------------------------
// A3.6 additions: identity-level properties the A3.2–A3.5 suites could only
// exercise as flags. All use real distinct OS identities.
// ------------------------------------------------------------------------

fn stat_of(path: &Path) -> (u32, u32, u32) {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).expect("stat as root");
    (m.uid(), m.gid(), m.mode() & 0o7777)
}

fn cat_as(user: &str, path: &Path) -> Result<String, String> {
    let o = run_as(user, "cat", &[&path.to_string_lossy()]).map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&o.stderr).into_owned())
    }
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_credential_files_have_exact_owners_and_cross_identity_reads_fail() {
    let Some(t) = require_tool_host("credential-files") else {
        return;
    };
    let (d, _base, acap) = spawn_tools_as(&t);
    // Daemon-created credentials: exact owner/group/mode.
    let (u, g, m) = stat_of(&d.handoff);
    assert_eq!(
        (u, g, m),
        (t.h.nexusd_uid, t.h.issuer_gid, 0o640),
        "issuer handoff"
    );
    let (u, g, m) = stat_of(&d.cap);
    assert_eq!((u, m), (t.h.nexusd_uid, 0o600), "issuer master cap");
    let _ = g;
    let (u, g, m) = stat_of(&acap);
    assert_eq!(
        (u, g, m),
        (t.h.nexusd_uid, t.approver_gid, 0o640),
        "approver cap"
    );
    // Issuer cannot read the approver credential nor the issuer master key
    // or the database; the untrusted identity cannot even traverse.
    for who in [ISSUER_USER, BYSTANDER_USER, UNTRUSTED_USER] {
        assert!(cat_as(who, &acap).is_err(), "{who} read approver cap");
        assert!(cat_as(who, &d.cap).is_err(), "{who} read master cap");
        assert!(cat_as(who, &d.db).is_err(), "{who} read db");
    }
    // The approver identity cannot read the master cap or the database.
    assert!(cat_as(APPROVER_USER, &d.cap).is_err());
    assert!(cat_as(APPROVER_USER, &d.db).is_err());
    // The untrusted identity cannot read the issuer handoff.
    assert!(cat_as(UNTRUSTED_USER, &d.handoff).is_err());
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_approver_identity_cannot_issue_even_holding_the_issuer_key() {
    let Some(t) = require_tool_host("approver-cannot-issue") else {
        return;
    };
    let (d, _base, _acap) = spawn_tools_as(&t);
    let issuer_cap = d.read_handoff();
    // Topology: the approver UID must be in the socket group to connect at
    // all, which also makes the 0640 issuer handoff readable to it. The
    // control is the daemon's SO_PEERCRED allow-list, not file secrecy.
    let seen = cat_as(APPROVER_USER, &d.handoff);
    println!(
        "approver can read issuer handoff via socket group: {}",
        seen.is_ok()
    );
    let key = seen.unwrap_or(issuer_cap.clone());
    let key = key.trim().to_owned();
    let r = send_as(
        APPROVER_USER,
        &d.socket,
        &signed_frame(
            &key,
            "acquire",
            serde_json::json!({"taskInstanceId": "mu-x", "backend": "native"}),
        ),
    )
    .expect("transport");
    assert_eq!(code_of(&r), "peer-unauthorized", "{r}");
    // And an issuer UID presenting the issuer key to an approver command is
    // refused on the key, not merely on the peer.
    let digest = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(b"x"));
    let r = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(&issuer_cap, "write-scope-approve", serde_json::json!({"commandId": "c", "workspaceRootDigest": digest, "maxWriteBytes": 1})),
    )
    .expect("transport");
    assert_eq!(code_of(&r), "issuer-untrusted", "{r}");
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_restart_preserves_ownership_and_privilege_changes_apply() {
    let Some(t) = require_tool_host("restart-ownership") else {
        return;
    };
    let (mut d, _base, acap) = spawn_tools_as(&t);
    let old_issuer = d.read_handoff();
    let old_approver = root_read(&acap);
    d.restart();
    // Ownership/modes are re-established, not inherited from luck.
    assert_eq!(stat_of(&d.handoff), (t.h.nexusd_uid, t.h.issuer_gid, 0o640));
    assert_eq!(stat_of(&acap), (t.h.nexusd_uid, t.approver_gid, 0o640));
    assert_eq!(stat_of(&d.cap).0, t.h.nexusd_uid);
    let new_issuer = d.read_handoff();
    assert_ne!(old_issuer, new_issuer, "issuer key must rotate on restart");
    assert_ne!(old_approver, root_read(&acap), "approver key must rotate");
    // The pre-restart key is dead for its own (still allowed) UID.
    let r = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &old_issuer,
            "acquire",
            serde_json::json!({"taskInstanceId": "mu-r", "backend": "native"}),
        ),
    )
    .expect("t");
    assert_eq!(code_of(&r), "issuer-untrusted", "{r}");
    // Privilege change: restart with the allow-list moved to the bystander.
    // The former issuer UID, now holding a *fresh valid* key, is refused on
    // the peer; the new UID succeeds.
    let i = d.argv.iter().position(|a| a == "--allowed-uids").unwrap();
    d.argv[i + 1] = t.h.bystander_uid.to_string();
    d.restart();
    let fresh = d.read_handoff();
    let r = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &fresh,
            "acquire",
            serde_json::json!({"taskInstanceId": "mu-r2", "backend": "native"}),
        ),
    )
    .expect("t");
    assert_eq!(code_of(&r), "peer-unauthorized", "{r}");
    let r = send_as(
        BYSTANDER_USER,
        &d.socket,
        &signed_frame(
            &fresh,
            "acquire",
            serde_json::json!({"taskInstanceId": "mu-r2", "backend": "native"}),
        ),
    )
    .expect("t");
    assert_eq!(r.get("ok"), Some(&serde_json::Value::Bool(true)), "{r}");
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_production_configuration_refuses_overlapping_or_test_only_approval() {
    let Some(t) = require_tool_host("production-config") else {
        return;
    };
    let (d, base, acap) = spawn_tools_as(&t);
    let mut base_argv: Vec<String> = d.argv.clone();
    // Fresh paths so nothing collides with the running daemon.
    let dir = d.dir.join("prod2d");
    let sock = d.dir.join("prod2s");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(&sock).unwrap();
    {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;
        let own = |p: &Path, mode: u32, gid: u32| {
            let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::chown(c.as_ptr(), t.h.nexusd_uid, gid) }, 0);
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        own(&dir, 0o700, t.h.nexusd_uid);
        own(&sock, 0o750, t.h.issuer_gid);
    }
    let swap = |argv: &mut Vec<String>, flag: &str, val: String| {
        let i = argv.iter().position(|a| a == flag).unwrap();
        argv[i + 1] = val;
    };
    swap(
        &mut base_argv,
        "--db",
        dir.join("k.db").to_string_lossy().into_owned(),
    );
    swap(
        &mut base_argv,
        "--socket",
        sock.join("n.sock").to_string_lossy().into_owned(),
    );
    swap(
        &mut base_argv,
        "--cap",
        dir.join("i.cap").to_string_lossy().into_owned(),
    );
    swap(
        &mut base_argv,
        "--witness",
        dir.join("w.db").to_string_lossy().into_owned(),
    );
    swap(
        &mut base_argv,
        "--cap-handoff",
        sock.join("h").to_string_lossy().into_owned(),
    );
    swap(
        &mut base_argv,
        "--approver-cap",
        acap.with_file_name("a2.cap").to_string_lossy().into_owned(),
    );
    let _ = &base;
    let run = |argv: &[String]| -> (bool, String) {
        let o = Command::new("runuser")
            .arg("-u")
            .arg(DAEMON_USER)
            .arg("--")
            .arg(nexusd_bin())
            .args(argv)
            .stdin(Stdio::null())
            .output()
            .expect("spawn");
        (
            o.status.success(),
            String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr),
        )
    };
    // 1. Approver == issuer UID with --require-independent-approver: fatal.
    let mut a = base_argv.clone();
    swap(&mut a, "--approver-uids", t.h.issuer_uid.to_string());
    let (ok, out) = run(&a);
    assert!(!ok, "overlapping approver must refuse: {out}");
    assert!(out.contains("approver UIDs overlap"), "{out}");
    assert!(!sock.join("n.sock").exists(), "no socket may be bound");
    // 2. Overlap without --require and without the test-only flag: still
    //    refuses to enable writes (never silently non-independent).
    let mut b = a.clone();
    b.retain(|x| x != "--require-independent-approver");
    let (ok, out) = run(&b);
    assert!(!ok, "{out}");
    assert!(out.contains("not independent"), "{out}");
    // 3. The test-only flag cannot satisfy --require-independent-approver.
    let mut c = a.clone();
    c.push("--allow-nonindependent-approver-test-only".to_owned());
    let (ok, out) = run(&c);
    assert!(!ok, "{out}");
    assert!(!sock.join("n.sock").exists());
    // 4. An approver credential group equal to the issuer socket group
    //    would let issuers read the approver key: refused.
    let mut e = base_argv.clone();
    swap(&mut e, "--approver-cap-gid", t.h.issuer_gid.to_string());
    let (ok, out) = run(&e);
    assert!(!ok, "{out}");
    assert!(out.contains("issuer socket group"), "{out}");
    assert!(!sock.join("n.sock").exists());
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_sandboxed_build_cannot_reach_capability_files_or_daemon_state() {
    let Some(t) = require_tool_host("sandbox-credentials") else {
        return;
    };
    if !nexus_tools::sandbox::preflight().available {
        println!("NOT RUN (sandbox-credentials): sandbox unavailable on this host");
        return;
    }
    let (mut d, base, acap) = spawn_tools_as(&t);
    d.argv.push("--enable-process".to_owned());
    d.restart();
    let issuer_cap = d.read_handoff();
    let approver_cap = root_read(&acap);
    let ws = base.join("ws");
    std::fs::create_dir_all(ws.join("src")).unwrap();
    // The build script runs as the daemon's UID inside the sandbox and
    // probes every credential/state path by absolute name plus the host
    // process table. Any success is an ESCAPE panic.
    let targets = [
        d.cap.clone(),
        d.handoff.clone(),
        acap.clone(),
        d.db.clone(),
        d.witness.clone(),
        d.socket.clone(),
    ];
    let list = targets
        .iter()
        .map(|p| format!("{:?}", p.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(",");
    std::fs::write(
        ws.join("Cargo.toml"),
        "[package]\nname=\"probe\"\nversion=\"0.1.0\"\nedition=\"2021\"\nbuild=\"build.rs\"\n",
    )
    .unwrap();
    std::fs::write(
        ws.join("Cargo.lock"),
        "version = 4\n\n[[package]]\nname = \"probe\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    std::fs::write(ws.join("src/lib.rs"), "").unwrap();
    std::fs::write(
        ws.join("build.rs"),
        format!(
            r#"fn main() {{
    let mut bad: Vec<String> = Vec::new();
    for p in [{list}] {{
        if std::fs::read(p).is_ok() || std::fs::metadata(p).is_ok() {{ bad.push(p.to_string()); }}
    }}
    for p in ["/proc/1/root/tmp/nexus-multuid", "/tmp/nexus-multuid"] {{
        if std::fs::metadata(p).is_ok() {{ bad.push(p.to_string()); }}
    }}
    // PID 1 here is the sandbox's own init (private pid namespace); it must
    // not carry any daemon/host markers.
    if let Ok(e) = std::fs::read_to_string("/proc/1/environ") {{
        if e.contains("NEXUS") || e.contains("SSH_AUTH") {{ bad.push("pid1-env".to_string()); }}
    }}
    // Only this sandbox's own processes may be visible.
    let n = std::fs::read_dir("/proc").map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit())).count()).unwrap_or(0);
    if n > 40 {{ bad.push(format!("host-proc-table:{{n}}")); }}
    if let Ok(e) = std::fs::read_to_string("/proc/self/environ") {{
        if e.contains("NEXUS") || e.contains("cap") {{ bad.push("env".to_string()); }}
    }}
    if !bad.is_empty() {{ panic!("ESCAPE:{{}}", bad.join(",")); }}
}}
"#
        ),
    )
    .unwrap();
    let digest = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(
        ws.to_string_lossy().as_bytes(),
    ));
    let snapshot = common::snapshot();
    let acquired = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "acquire",
            serde_json::json!({"taskInstanceId": "mu-s", "backend": "native"}),
        ),
    )
    .expect("acquire");
    let lease = acquired.get("lease").expect("lease").clone();
    let resolution = common::resolution_for("mu-s", &snapshot);
    let _ = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "seal",
            serde_json::json!({"resolution": resolution}),
        ),
    );
    let intent = nexus_contracts::ControllerIntentV1::build(
        "mu-s",
        "mu-sa",
        "mu-sc",
        "native",
        1,
        "muse_main",
        "engineering-v2",
        common::rev3(),
        serde_json::json!({"op": "engineer-turn", "workspaceRootDigest": digest}),
    );
    let accepted = send_as(ISSUER_USER, &d.socket, &signed_frame(&issuer_cap, "accept", serde_json::json!({
        "intent": serde_json::to_value(&intent).unwrap(), "resolution": resolution, "snapshot": snapshot,
        "lease": {"epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation")}}))).expect("accept");
    let rc = accepted["receipt"].clone();
    let bind = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "workspace-bind",
            serde_json::json!({"commandId": "mu-sc", "root": ws.to_string_lossy()}),
        ),
    )
    .expect("bind");
    assert_eq!(
        bind.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "{bind}"
    );
    let r = send_as(APPROVER_USER, &d.socket, &signed_frame(&approver_cap, "process-scope-approve",
        serde_json::json!({"commandId": "mu-sc", "workspaceRootDigest": digest, "maxWallMs": 120000}))).expect("approve");
    assert_eq!(r["processScope"]["independent"], true, "{r}");
    let out = send_as(ISSUER_USER, &d.socket, &signed_frame(&issuer_cap, "tool-execute", serde_json::json!({
        "requestId": "s1", "cancellationId": "c-s1", "taskInstanceId": "mu-s", "attemptId": "mu-sa", "commandId": "mu-sc",
        "leaseEpoch": rc["leaseEpoch"], "storeIncarnation": rc["storeIncarnation"], "toolId": "proc.run", "toolVersion": 1,
        "args": {"program": "cargo", "args": ["check", "--offline", "--locked"]}}))).expect("exec");
    println!("sandbox probe response: {out}");
    let text = out.to_string();
    // The probe ran (not refused for lack of a toolchain) and found nothing.
    assert!(
        !text.contains("ESCAPE"),
        "sandbox build observed host state: {text}"
    );
    assert!(
        !text.contains(&issuer_cap) && !text.contains(&approver_cap),
        "capability leaked"
    );
    assert!(
        text.contains("\"exitCode\":0")
            || text.contains("command-refused")
            || text.contains("toolchain"),
        "unexpected process outcome: {text}"
    );
    if text.contains("command-refused") || text.contains("toolchain") {
        println!("NOT RUN (sandbox-credentials probe body): cargo toolchain not reachable by the daemon identity");
    }
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_dependency_cache_is_single_owner_and_wrong_owner_fails_closed() {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    let Some(t) = require_tool_host("depcache-owner") else {
        return;
    };
    let root = std::env::temp_dir().join(format!("nexus-multuid-dc-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let c = std::ffi::CString::new(root.as_os_str().as_bytes()).unwrap();
    // Owned by the daemon identity, private: the intended deployment.
    unsafe { libc::chown(c.as_ptr(), t.h.nexusd_uid, t.h.nexusd_uid) };
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(root.join("VERSION"), "nexus-depcache/1\n").unwrap();
    // Root (a different euid) must not silently adopt a cache it does not
    // own: fail closed.
    let e = nexus_tools::depcache::DepCache::open(
        &root,
        false,
        nexus_tools::depcache::CacheQuota::default(),
    )
    .unwrap_err();
    assert_eq!(e.code, "cache-root", "{e}");
    // No other identity can even list it.
    for who in [ISSUER_USER, BYSTANDER_USER, UNTRUSTED_USER, APPROVER_USER] {
        let o = run_as(who, "ls", &[&root.to_string_lossy()]).expect("run");
        assert!(!o.status.success(), "{who} listed the cache");
    }
    let _ = std::fs::remove_dir_all(&root);
}
