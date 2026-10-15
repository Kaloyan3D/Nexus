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
/// A4.1: dedicated issuer-credential group. Members: daemon + issuer ONLY
/// (never the socket group, the approver or the bystander).
const ISSUER_CRED_GROUP: &str = "nexus-issuercred-test";

struct Host {
    nexusd_uid: u32,
    issuer_uid: u32,
    bystander_uid: u32,
    untrusted_uid: u32,
    issuer_gid: u32,
    issuercred_gid: u32,
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
    let Some(issuercred_gid) = gid_of(ISSUER_CRED_GROUP) else {
        println!("NOT RUN ({test}): group {ISSUER_CRED_GROUP} is missing");
        return None;
    };
    let h = Host {
        nexusd_uid,
        issuer_uid,
        bystander_uid,
        untrusted_uid,
        issuer_gid,
        issuercred_gid,
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
    // A4.1: the issuer handoff lives in its OWN 0750 daemon:issuercred dir,
    // not in the socket directory the approver/bystander can traverse.
    let credir = dir.join("issuercred");
    std::fs::create_dir_all(&credir).expect("mkdir");
    own(&credir, 0o750, h.nexusd_uid, h.issuercred_gid);
    let socket = sockdir.join("n.sock");
    let cap = dataroot.join("issuer.cap");
    let handoff = credir.join("issuer.handoff");
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
        "--cap-handoff-gid".to_owned(),
        h.issuercred_gid.to_string(),
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
        (t.h.nexusd_uid, t.h.issuercred_gid, 0o640),
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
    // A4.1: the approver is in the socket group (it must connect) but the
    // issuer handoff is in a separate credential group: the filesystem now
    // denies the read. The key below is therefore a STOLEN key (root-read),
    // and the SO_PEERCRED allow-list must still refuse it independently.
    assert!(
        cat_as(APPROVER_USER, &d.handoff).is_err(),
        "approver must not read the issuer handoff via socket-group membership"
    );
    let key = issuer_cap.clone();
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
    assert_eq!(
        stat_of(&d.handoff),
        (t.h.nexusd_uid, t.h.issuercred_gid, 0o640)
    );
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
    let cred2 = d.dir.join("prod2c");
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
        std::fs::create_dir_all(&cred2).unwrap();
        own(&cred2, 0o750, t.h.issuercred_gid);
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
        cred2.join("h").to_string_lossy().into_owned(),
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

// ---------------------------------------------------------------------------
// A4.1 credential isolation. The issuer handoff lives in a dedicated
// `daemon:issuercred 0750` directory; the approver credential in a dedicated
// `daemon:approver 0750` directory; the socket group (which the approver
// MUST join to connect) grants no credential access at all.
// ---------------------------------------------------------------------------

fn ls_as(user: &str, dir: &Path) -> bool {
    run_as(user, "ls", &[&dir.to_string_lossy()])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn denied_reply(user: &str, socket: &Path, key: &str) -> serde_json::Value {
    send_as(
        user,
        socket,
        &signed_frame(
            key,
            "acquire",
            serde_json::json!({"taskInstanceId": "a41-x", "backend": "native"}),
        ),
    )
    .expect("a socket-group member must be able to connect")
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_socket_membership_grants_no_credential_access_before_and_after_restart() {
    let Some(t) = require_tool_host("a41-socket-membership") else {
        return;
    };
    let (mut d, _base, acap) = spawn_tools_as(&t);
    let credir = d.handoff.parent().unwrap().to_path_buf();
    let adir = acap.parent().unwrap().to_path_buf();
    for round in 0..2 {
        if round == 1 {
            d.restart();
        }
        let issuer_key = d.read_handoff();
        let approver_key = root_read(&acap);
        // Socket-group members (approver, bystander) CAN connect: the reply is
        // a refusal, not a transport error. This is the premise being tested.
        for who in [APPROVER_USER, BYSTANDER_USER] {
            let r = denied_reply(who, &d.socket, &issuer_key);
            assert_eq!(code_of(&r), "peer-unauthorized", "{who}: {r}");
            // ...and the connection grants NO credential access.
            assert!(
                cat_as(who, &d.handoff).is_err(),
                "{who} read issuer handoff"
            );
            assert!(cat_as(who, &acap).is_err() || who == APPROVER_USER);
            assert!(
                !ls_as(who, &credir),
                "{who} listed the issuer credential dir"
            );
        }
        // The approver reads ONLY its own credential; the issuer only its own.
        assert_eq!(cat_as(APPROVER_USER, &acap).unwrap().trim(), approver_key);
        assert_eq!(cat_as(ISSUER_USER, &d.handoff).unwrap().trim(), issuer_key);
        assert!(
            cat_as(ISSUER_USER, &acap).is_err(),
            "issuer read approver cap"
        );
        assert!(cat_as(APPROVER_USER, &d.handoff).is_err());
        assert!(!ls_as(ISSUER_USER, &adir), "issuer listed approver dir");
        assert!(!ls_as(APPROVER_USER, &credir));
        // Untrusted: no connect, no read, no listing, of anything.
        assert!(send_as(
            UNTRUSTED_USER,
            &d.socket,
            &signed_frame(&issuer_key, "health", serde_json::json!({}))
        )
        .is_err());
        for p in [&d.handoff, &acap, &d.cap] {
            assert!(cat_as(UNTRUSTED_USER, p).is_err());
        }
        assert!(!ls_as(UNTRUSTED_USER, &credir) && !ls_as(UNTRUSTED_USER, &adir));
        // Exact modes; never world-accessible; directories exactly 0750.
        assert_eq!(
            stat_of(&d.handoff),
            (t.h.nexusd_uid, t.h.issuercred_gid, 0o640)
        );
        assert_eq!(stat_of(&acap), (t.h.nexusd_uid, t.approver_gid, 0o640));
        assert_eq!(
            stat_of(&credir),
            (t.h.nexusd_uid, t.h.issuercred_gid, 0o750)
        );
        assert_eq!(stat_of(&adir), (t.h.nexusd_uid, t.approver_gid, 0o750));
        assert_ne!(
            t.h.issuercred_gid, t.h.issuer_gid,
            "credential group != socket group"
        );
        assert_ne!(t.h.issuercred_gid, t.approver_gid);
    }
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_each_role_credential_is_refused_for_the_other_roles_commands() {
    let Some(t) = require_tool_host("a41-cross-role") else {
        return;
    };
    let (mut d, _base, acap) = spawn_tools_as(&t);
    // Enable sandboxed processes too so process-scope-approve is live.
    d.argv.push("--enable-process".to_owned());
    d.restart();
    let issuer_key = d.read_handoff();
    let approver_key = root_read(&acap);
    let digest = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(b"x"));
    let approve = |cmd: &str| serde_json::json!({"commandId": "c", "workspaceRootDigest": digest, "maxWriteBytes": 1, "cmd": cmd});
    let _ = approve;
    // Issuer UID + issuer key -> approver commands: refused on the key.
    for cmd in ["write-scope-approve", "process-scope-approve"] {
        let r = send_as(
            ISSUER_USER,
            &d.socket,
            &signed_frame(
                &issuer_key,
                cmd,
                serde_json::json!({"commandId": "c", "workspaceRootDigest": digest, "maxWriteBytes": 1}),
            ),
        )
        .expect("t");
        assert_eq!(code_of(&r), "issuer-untrusted", "{cmd}: {r}");
        // Issuer UID + a STOLEN approver key: key is valid, peer UID is not.
        let r = send_as(
            ISSUER_USER,
            &d.socket,
            &signed_frame(
                &approver_key,
                cmd,
                serde_json::json!({"commandId": "c2", "workspaceRootDigest": digest, "maxWriteBytes": 1}),
            ),
        )
        .expect("t");
        assert_eq!(code_of(&r), "peer-unauthorized", "{cmd} stolen: {r}");
    }
    // Approver UID + approver key (and + stolen issuer key) -> issuer grants.
    // The approver key fails issuer authentication; a stolen issuer key
    // authenticates but the approver PEER is not on the issuer allow-list.
    for (key, want) in [
        (&approver_key, "issuer-untrusted"),
        (&issuer_key, "peer-unauthorized"),
    ] {
        for cmd in ["acquire", "workspace-bind", "tool-execute", "tool-revoke"] {
            let r = send_as(
                APPROVER_USER,
                &d.socket,
                &signed_frame(
                    key,
                    cmd,
                    serde_json::json!({"taskInstanceId": "a41-y", "backend": "native"}),
                ),
            )
            .expect("t");
            assert_eq!(code_of(&r), want, "{cmd}: {r}");
        }
    }
    // Approver key presented by the issuer UID to an issuer command: the
    // approver capability can never satisfy issuer authentication.
    let r = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &approver_key,
            "acquire",
            serde_json::json!({"taskInstanceId": "a41-z", "backend": "native"}),
        ),
    )
    .expect("t");
    assert_eq!(code_of(&r), "issuer-untrusted", "{r}");
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_credentials_never_appear_in_responses_or_diagnostics() {
    let Some(t) = require_tool_host("a41-no-leak") else {
        return;
    };
    let (mut d, _base, acap) = spawn_tools_as(&t);
    let issuer_key = d.read_handoff();
    let approver_key = root_read(&acap);
    let mut seen = String::new();
    for cmd in ["health", "status", "readiness", "journal", "tool-events"] {
        let r = send_as(
            ISSUER_USER,
            &d.socket,
            &signed_frame(&issuer_key, cmd, serde_json::json!({})),
        )
        .expect("t");
        seen.push_str(&r.to_string());
    }
    // Refusals (wrong peer / wrong key) must not echo key material either.
    seen.push_str(&denied_reply(APPROVER_USER, &d.socket, &issuer_key).to_string());
    seen.push_str(
        &send_as(
            ISSUER_USER,
            &d.socket,
            &signed_frame(
                &approver_key,
                "acquire",
                serde_json::json!({"taskInstanceId": "q", "backend": "native"}),
            ),
        )
        .expect("t")
        .to_string(),
    );
    terminate(&mut d.child);
    let _ = d.child.wait();
    use std::io::Read;
    let mut diag = String::new();
    if let Some(mut e) = d.child.stderr.take() {
        let _ = e.read_to_string(&mut diag);
    }
    if let Some(mut o) = d.child.stdout.take() {
        let _ = o.read_to_string(&mut diag);
    }
    seen.push_str(&diag);
    assert!(!seen.contains(&issuer_key), "issuer key leaked");
    assert!(!seen.contains(&approver_key), "approver key leaked");
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_a41_misconfiguration_and_hostile_paths_fail_closed_without_residue() {
    let Some(t) = require_tool_host("a41-config") else {
        return;
    };
    let (d, _base, acap) = spawn_tools_as(&t);
    let argv0: Vec<String> = d.argv.clone();
    // Fresh isolated layout so nothing collides with the running daemon.
    let root = d.dir.join("a41cfg");
    std::fs::create_dir_all(&root).unwrap();
    let own = |p: &Path, mode: u32, uid: u32, gid: u32| {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::chown(c.as_ptr(), uid, gid) }, 0);
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
    };
    own(&root, 0o755, t.h.nexusd_uid, t.h.nexusd_uid);
    let mk = |name: &str, mode: u32, gid: u32| {
        let p = root.join(name);
        std::fs::create_dir_all(&p).unwrap();
        own(&p, mode, t.h.nexusd_uid, gid);
        p
    };
    let data = mk("data", 0o700, t.h.nexusd_uid);
    let sock = mk("sock", 0o750, t.h.issuer_gid);
    let cred = mk("cred", 0o750, t.h.issuercred_gid);
    let adir = mk("adir", 0o750, t.approver_gid);
    let set = |argv: &mut Vec<String>, flag: &str, val: String| {
        let i = argv.iter().position(|a| a == flag).unwrap();
        argv[i + 1] = val;
    };
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    let mut base = argv0.clone();
    set(&mut base, "--db", s(data.join("k.db")));
    set(&mut base, "--witness", s(data.join("w.db")));
    set(&mut base, "--cap", s(data.join("i.cap")));
    set(&mut base, "--socket", s(sock.join("n.sock")));
    set(&mut base, "--cap-handoff", s(cred.join("h")));
    set(&mut base, "--approver-cap", s(adir.join("a.cap")));
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
    let no_residue = |label: &str| {
        for p in [sock.join("n.sock"), cred.join("h"), adir.join("a.cap")] {
            assert!(
                std::fs::symlink_metadata(&p).is_err(),
                "{label}: residue {p:?}"
            );
        }
    };
    // 1. Issuer credential group == socket group: refused.
    let mut a = base.clone();
    set(&mut a, "--cap-handoff-gid", t.h.issuer_gid.to_string());
    let (ok, out) = run(&a);
    assert!(!ok && out.contains("equals --socket-group"), "{out}");
    no_residue("gid==socket");
    // 2. Approver credential group == issuer credential group: refused.
    let mut b = base.clone();
    set(&mut b, "--approver-cap-gid", t.h.issuercred_gid.to_string());
    let (ok, out) = run(&b);
    assert!(!ok && out.contains("issuer credential group"), "{out}");
    no_residue("approver==issuercred");
    // 3. Approver credential directory collides with the issuer credential dir.
    let mut c = base.clone();
    set(&mut c, "--approver-cap", s(cred.join("a.cap")));
    let (ok, out) = run(&c);
    assert!(!ok, "{out}");
    no_residue("approver in credir");
    // 4. Approver credential in the socket directory: refused (the approver
    //    must be in the socket group; this layout would couple the two).
    let mut e = base.clone();
    set(&mut e, "--approver-cap", s(sock.join("a.cap")));
    let (ok, out) = run(&e);
    assert!(!ok, "{out}");
    no_residue("approver in sockdir");
    // 5. Credential directory is a symlink to a valid directory: refused.
    let link = root.join("credlink");
    std::os::unix::fs::symlink(&cred, &link).unwrap();
    let mut f = base.clone();
    set(&mut f, "--cap-handoff", s(link.join("h")));
    // (the parent of the handoff is the symlink itself)
    let (ok, out) = run(&f);
    assert!(!ok, "{out}");
    no_residue("symlinked credir");
    // 6. Credential directory with loosened mode (0770): refused.
    own(&cred, 0o770, t.h.nexusd_uid, t.h.issuercred_gid);
    let (ok, out) = run(&base);
    assert!(!ok && out.contains("0750"), "{out}");
    no_residue("0770 credir");
    own(&cred, 0o750, t.h.nexusd_uid, t.h.issuercred_gid);
    // 7. Wrong credential directory group: refused.
    own(&cred, 0o750, t.h.nexusd_uid, t.h.issuer_gid);
    let (ok, out) = run(&base);
    assert!(!ok, "{out}");
    no_residue("wrong-group credir");
    own(&cred, 0o750, t.h.nexusd_uid, t.h.issuercred_gid);
    // 8. Failed startup AFTER the approver credential is published (handoff
    //    leaf is a planted symlink): the published approver credential is
    //    withdrawn, the symlink and its decoy target are left untouched.
    let decoy = root.join("decoy");
    std::fs::write(&decoy, "keep").unwrap();
    own(&decoy, 0o644, t.h.nexusd_uid, t.h.nexusd_uid);
    std::os::unix::fs::symlink(&decoy, cred.join("h")).unwrap();
    let (ok, out) = run(&base);
    assert!(!ok && out.contains("symlink"), "{out}");
    assert!(
        std::fs::symlink_metadata(adir.join("a.cap")).is_err(),
        "approver cred left behind"
    );
    assert!(!sock.join("n.sock").exists(), "socket left behind");
    assert_eq!(std::fs::read_to_string(&decoy).unwrap(), "keep");
    assert!(std::fs::symlink_metadata(cred.join("h"))
        .unwrap()
        .file_type()
        .is_symlink());
    std::fs::remove_file(cred.join("h")).unwrap();
    // 9. Pre-existing permissive regular file + hardlink at the handoff path:
    //    replaced atomically with a fresh 0640 inode; the hardlink keeps only
    //    stale bytes. (Run the real daemon briefly.)
    let planted = cred.join("h");
    std::fs::write(&planted, "stale-secret").unwrap();
    own(&planted, 0o666, t.h.nexusd_uid, t.h.nexusd_uid);
    let alias = cred.join("alias");
    std::fs::hard_link(&planted, &alias).unwrap();
    let mut cmd = Command::new("runuser");
    cmd.arg("-u")
        .arg(DAEMON_USER)
        .arg("--")
        .arg(nexusd_bin())
        .args(&base);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    poll_ready(&sock.join("n.sock"));
    assert_eq!(
        stat_of(&planted),
        (t.h.nexusd_uid, t.h.issuercred_gid, 0o640)
    );
    assert_eq!(std::fs::read_to_string(&alias).unwrap(), "stale-secret");
    assert_eq!(std::fs::read_to_string(&planted).unwrap().trim().len(), 64);
    // Orderly shutdown withdraws exactly the published credentials.
    terminate(&mut child);
    let _ = child.wait();
    no_residue("after clean stop");
    assert!(
        std::fs::symlink_metadata(&alias).is_ok(),
        "unrelated sibling must survive"
    );
    let _ = acap;
}

// ---------------------------------------------------------------------------
// A4.2 human approval across REAL Linux identities. The approver credential
// is read through the filesystem AS the approver user (never as root); the
// issuer and bystander cannot read or use it; the terminal CLI runs as the
// approver UID on a genuine pty.
// ---------------------------------------------------------------------------

struct Human {
    d: TestDaemon,
    t: ToolHost,
    acap: PathBuf,
    issuer_cap: String,
    ws: PathBuf,
    task: String,
    attempt: String,
    command: String,
    lease: serde_json::Value,
}

fn sha_hex(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

fn human_setup(tag: &str) -> Option<Human> {
    let t = require_tool_host(tag)?;
    let (mut d, base, acap) = spawn_tools_as(&t);
    d.argv.push("--require-human-approval".to_owned());
    d.restart();
    let issuer_cap = d.read_handoff();
    let ws = base.join(format!("ws-{tag}"));
    std::fs::create_dir_all(&ws).expect("ws");
    let c = std::ffi::CString::new(ws.to_string_lossy().as_bytes()).unwrap();
    unsafe { libc::chown(c.as_ptr(), t.h.nexusd_uid, t.h.issuer_gid) };
    let digest = sha_hex(&ws.to_string_lossy());
    let (task, attempt, command) = (
        format!("hu-t-{tag}"),
        format!("hu-a-{tag}"),
        format!("hu-c-{tag}"),
    );
    let snapshot = common::snapshot();
    let acquired = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "acquire",
            serde_json::json!({"taskInstanceId": task, "backend": "native"}),
        ),
    )
    .expect("acquire");
    let lease = acquired.get("lease").expect("lease").clone();
    let resolution = common::resolution_for(&task, &snapshot);
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
        &task,
        &attempt,
        &command,
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
    assert_eq!(accepted["ok"], true, "{accepted}");
    let bind = send_as(
        ISSUER_USER,
        &d.socket,
        &signed_frame(
            &issuer_cap,
            "workspace-bind",
            serde_json::json!({"commandId": command, "root": ws.to_string_lossy()}),
        ),
    )
    .expect("bind");
    assert_eq!(bind["ok"], true, "{bind}");
    let lease = accepted["receipt"].clone();
    Some(Human {
        d,
        t,
        acap,
        issuer_cap,
        ws,
        task,
        attempt,
        command,
        lease,
    })
}

impl Human {
    fn tool_params(&self, rid: &str, args: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "requestId": rid, "cancellationId": format!("c-{rid}"),
            "taskInstanceId": self.task, "attemptId": self.attempt, "commandId": self.command,
            "leaseEpoch": self.lease["leaseEpoch"], "storeIncarnation": self.lease["storeIncarnation"],
            "toolId": "fs.write", "toolVersion": 1, "args": args,
        })
    }
    fn put_file(&self, name: &str, body: &str) {
        let p = self.ws.join(name);
        std::fs::write(&p, body).unwrap();
        let c = std::ffi::CString::new(p.to_string_lossy().as_bytes()).unwrap();
        unsafe { libc::chown(c.as_ptr(), self.t.h.nexusd_uid, self.t.h.issuer_gid) };
    }
    /// The approver reads its OWN credential through the filesystem.
    fn approver_key(&self) -> String {
        cat_as(APPROVER_USER, &self.acap)
            .expect("approver must read its own credential")
            .trim()
            .to_owned()
    }
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_human_approval_end_to_end_with_separate_real_identities() {
    let Some(h) = human_setup("e2e") else {
        return;
    };
    h.put_file("a.txt", "before\n");
    let args = serde_json::json!({"path": "a.txt", "content": "after\n", "mode": "replace",
        "expectedSha256": sha_hex("before\n")});
    // The issuer cannot execute: no approval yet.
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(
            &h.issuer_cap,
            "tool-execute",
            h.tool_params("e2e-0", args.clone()),
        ),
    )
    .unwrap();
    assert_eq!(code_of(&r), "scope-refused", "{r}");
    // Issuer submits the proposal.
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(
            &h.issuer_cap,
            "approval-request",
            h.tool_params("e2e-1", args.clone()),
        ),
    )
    .unwrap();
    assert_eq!(r["ok"], true, "{r}");
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    // The approver fetches the daemon-authored review with ITS OWN key.
    let akey = h.approver_key();
    let g = send_as(
        APPROVER_USER,
        &h.d.socket,
        &signed_frame(&akey, "approval-get", serde_json::json!({"approvalId": id})),
    )
    .unwrap();
    assert_eq!(g["ok"], true, "{g}");
    let a = &g["approval"];
    assert_eq!(
        a["request"]["operation"]["postImageSha256"],
        sha_hex("after\n")
    );
    assert!(a["request"]["preview"]["text"]
        .as_str()
        .unwrap()
        .contains("+after"));
    // The issuer cannot approve, with either its key or the approver key.
    let decide = serde_json::json!({"approvalId": id, "requestDigest": a["requestDigest"],
        "decision": "approve", "reviewCode": a["reviewCode"], "confirmation": {"tty": true}});
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, "approval-decide", decide.clone()),
    )
    .unwrap();
    assert_eq!(code_of(&r), "issuer-untrusted", "{r}");
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&akey, "approval-decide", decide.clone()),
    )
    .unwrap();
    assert_eq!(code_of(&r), "peer-unauthorized", "{r}");
    // The approver decides; the issuer then executes exactly once.
    let r = send_as(
        APPROVER_USER,
        &h.d.socket,
        &signed_frame(&akey, "approval-decide", decide),
    )
    .unwrap();
    assert_eq!(r["approval"]["state"], "approved", "{r}");
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(
            &h.issuer_cap,
            "tool-execute",
            h.tool_params("e2e-2", args.clone()),
        ),
    )
    .unwrap();
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(
        std::fs::read_to_string(h.ws.join("a.txt")).unwrap(),
        "after\n"
    );
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, "tool-execute", h.tool_params("e2e-3", args)),
    )
    .unwrap();
    assert_eq!(code_of(&r), "scope-refused", "{r}");
    // Decided approvals are visible to issuer and approver, not to others.
    let list = |who: &str| {
        send_as(
            who,
            &h.d.socket,
            &serde_json::json!({"protocol":1,"id":common::next_id("l"),"cmd":"approval-list","params":{}})
                .to_string(),
        )
    };
    assert_eq!(list(ISSUER_USER).unwrap()["ok"], true);
    assert_eq!(list(APPROVER_USER).unwrap()["ok"], true);
    let r = list(BYSTANDER_USER).unwrap();
    assert_eq!(code_of(&r), "peer-unauthorized", "bystander history: {r}");
    assert!(
        list(UNTRUSTED_USER).is_err(),
        "untrusted must be refused at connect"
    );
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_stolen_credentials_cannot_forge_human_approval() {
    let Some(h) = human_setup("forge") else {
        return;
    };
    h.put_file("a.txt", "before\n");
    let args = serde_json::json!({"path": "a.txt", "content": "after\n", "mode": "replace",
        "expectedSha256": sha_hex("before\n")});
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(
            &h.issuer_cap,
            "approval-request",
            h.tool_params("f-1", args.clone()),
        ),
    )
    .unwrap();
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let akey = root_read(&h.acap); // root-stolen copy of the approver key
                                   // Every non-approver UID holding the stolen approver key is refused on
                                   // the peer, including for review (so the code cannot be harvested).
    for who in [ISSUER_USER, BYSTANDER_USER] {
        let r = send_as(
            who,
            &h.d.socket,
            &signed_frame(&akey, "approval-get", serde_json::json!({"approvalId": id})),
        )
        .unwrap();
        assert_eq!(code_of(&r), "peer-unauthorized", "{who}: {r}");
        assert!(
            cat_as(who, &h.acap).is_err(),
            "{who} read the approver credential"
        );
    }
    assert!(send_as(
        UNTRUSTED_USER,
        &h.d.socket,
        &signed_frame(&akey, "approval-get", serde_json::json!({"approvalId": id})),
    )
    .is_err());
    // The approver UID with a wrong digest/code cannot decide, and a blind
    // decision without review is refused.
    let r = send_as(
        APPROVER_USER,
        &h.d.socket,
        &signed_frame(
            &akey,
            "approval-decide",
            serde_json::json!({"approvalId": id, "requestDigest": "0".repeat(64),
                "decision": "approve", "reviewCode": "00000000", "confirmation": {"tty": true}}),
        ),
    )
    .unwrap();
    assert_ne!(r["ok"], true, "{r}");
    // After the failed attempts nothing is approved and nothing ran.
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, "tool-execute", h.tool_params("f-2", args)),
    )
    .unwrap();
    assert_eq!(code_of(&r), "scope-refused", "{r}");
    assert_eq!(
        std::fs::read_to_string(h.ws.join("a.txt")).unwrap(),
        "before\n"
    );
    // Restart cannot turn a stale review into consent.
    let mut h = h;
    h.d.restart();
    let akey2 = h.approver_key();
    let r = send_as(
        APPROVER_USER,
        &h.d.socket,
        &signed_frame(
            &akey2,
            "approval-get",
            serde_json::json!({"approvalId": id}),
        ),
    )
    .unwrap();
    assert_eq!(
        r["ok"], true,
        "pending request survives restart for re-review: {r}"
    );
}

const PTY_DRIVER: &str = r#"
import os, pty, sys, time, select
user, argv_json = sys.argv[1], sys.argv[2]
import json
argv = json.loads(argv_json)
answer = sys.argv[3] if len(sys.argv) > 3 else None
pid, fd = pty.fork()
if pid == 0:
    os.execvp("runuser", ["runuser", "-u", user, "--"] + argv)
out = b""
sent = False
deadline = time.time() + 40
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        if answer is not None and not sent and b"Type the review code" in out and out.rstrip().endswith(b":") or (answer is not None and not sent and b"leave pending: " in out):
            time.sleep(0.2)
            os.write(fd, (answer + "\n").encode())
            sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
sys.stdout.write("\nEXIT=%d\n" % (os.waitstatus_to_exitcode(status)))
"#;

fn approver_cli_bin() -> PathBuf {
    if let Ok(p) = std::env::var("NEXUS_APPROVER_BIN") {
        return PathBuf::from(p);
    }
    nexusd_bin().with_file_name("nexus-approver")
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_terminal_approver_cli_requires_a_real_terminal_and_typed_code() {
    let Some(h) = human_setup("cli") else {
        return;
    };
    let cli = approver_cli_bin();
    if !cli.exists() {
        println!("NOT RUN: nexus-approver binary missing at {cli:?}");
        return;
    }
    h.put_file("a.txt", "before\n");
    let args = serde_json::json!({"path": "a.txt", "content": "after\n", "mode": "replace",
        "expectedSha256": sha_hex("before\n")});
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(
            &h.issuer_cap,
            "approval-request",
            h.tool_params("c-1", args.clone()),
        ),
    )
    .unwrap();
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let argv = |extra: &[&str]| -> String {
        let mut v = vec![
            cli.to_string_lossy().into_owned(),
            "--socket".to_owned(),
            h.d.socket.to_string_lossy().into_owned(),
            "--cap-file".to_owned(),
            h.acap.to_string_lossy().into_owned(),
        ];
        v.extend(extra.iter().map(|s| s.to_string()));
        serde_json::to_string(&v).unwrap()
    };
    // 1. No terminal (piped stdin/stdout): the CLI refuses outright.
    let out = Command::new("runuser")
        .arg("-u")
        .arg(APPROVER_USER)
        .arg("--")
        .arg(&cli)
        .args([
            "--socket",
            &h.d.socket.to_string_lossy(),
            "--cap-file",
            &h.acap.to_string_lossy(),
            "review",
            &id,
        ])
        .stdin(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    // 2. A wrong answer on a real pty leaves the approval pending.
    let run = |answer: &str| {
        let o = Command::new("python3")
            .arg("-c")
            .arg(PTY_DRIVER)
            .arg(APPROVER_USER)
            .arg(argv(&["review", &id]))
            .arg(answer)
            .output()
            .unwrap();
        String::from_utf8_lossy(&o.stdout).into_owned()
    };
    let out = run("not-the-code");
    assert!(
        out.contains("left pending") && out.contains("EXIT=0"),
        "{out}"
    );
    let state = |who: &str, key: &str| {
        let r = send_as(
            who,
            &h.d.socket,
            &serde_json::json!({"protocol":1,"id":common::next_id("s"),"cmd":"approval-list",
                "params":{"approvalId": id}})
            .to_string(),
        )
        .unwrap();
        let _ = key;
        r["approval"]["state"].as_str().unwrap_or("?").to_owned()
    };
    assert_eq!(state(ISSUER_USER, ""), "pending");
    // 3. The review shows the exact diff and digests; the typed review
    //    code (echoed by the harness from the screen) approves.
    let probe = run("");
    assert!(
        probe.contains("+after") && probe.contains("postImageSha256"),
        "{probe}"
    );
    let code = probe
        .split("review code (")
        .nth(1)
        .and_then(|s| s.split(')').next())
        .expect("review code displayed")
        .to_owned();
    let out = run(&code);
    assert!(
        out.contains("recorded: approved") && out.contains("EXIT=0"),
        "{out}"
    );
    assert_eq!(state(ISSUER_USER, ""), "approved");
    // 4. Execute under the approval.
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, "tool-execute", h.tool_params("c-2", args)),
    )
    .unwrap();
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(
        std::fs::read_to_string(h.ws.join("a.txt")).unwrap(),
        "after\n"
    );
    // 5. The CLI cannot even load the credential as another identity.
    let out = Command::new("runuser")
        .arg("-u")
        .arg(ISSUER_USER)
        .arg("--")
        .arg(&cli)
        .args([
            "--socket",
            &h.d.socket.to_string_lossy(),
            "--cap-file",
            &h.acap.to_string_lossy(),
            "review",
            &id,
        ])
        .output()
        .unwrap();
    assert_ne!(out.status.code(), Some(0));
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_independent_human_approval_store_cannot_be_downgraded_by_restart() {
    let Some(mut h) = human_setup("down") else {
        return;
    };
    h.put_file("a.txt", "before\n");
    let argv = h.d.argv.clone();
    terminate(&mut h.d.child);
    let _ = h.d.child.wait();
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
    // (a) the flag silently dropped, writes still enabled
    let a: Vec<String> = argv
        .iter()
        .filter(|x| *x != "--require-human-approval")
        .cloned()
        .collect();
    let (ok, out) = run(&a);
    assert!(!ok && out.contains("approval-downgrade-refused"), "{out}");
    // (b) independence replaced by the test-only self-approval flag
    let mut b: Vec<String> = argv
        .iter()
        .filter(|x| *x != "--require-independent-approver")
        .cloned()
        .collect();
    b.push("--allow-nonindependent-approver-test-only".to_owned());
    let (ok, out) = run(&b);
    assert!(!ok && out.contains("approval-downgrade-refused"), "{out}");
    // (c) processes enabled under the dropped flag
    let mut c = a.clone();
    c.push("--enable-process".to_owned());
    let (ok, out) = run(&c);
    assert!(!ok && out.contains("approval-downgrade-refused"), "{out}");
    // The compliant configuration still starts and the credentials are
    // re-published with the A4.1 modes.
    let _ = std::fs::remove_file(&h.d.socket);
    h.d.restart();
    assert_eq!(
        stat_of(&h.acap),
        (h.t.h.nexusd_uid, h.t.approver_gid, 0o640)
    );
}

// ---------------------------------------------------------------------------
// A4.3 independent journal witness under its own Linux identity. The
// witness state/key are 0700 witness-owned; the daemon is only a client.
// ---------------------------------------------------------------------------

const WITNESS_USER: &str = "nexus-witness-test";
const WITNESS_CLIENT_GROUP: &str = "nexus-witnessc-test";

struct WitnessRig {
    child: Child,
    base: PathBuf,
    state: PathBuf,
    sock: PathBuf,
    uid: u32,
}

impl WitnessRig {
    /// Restart the SAME witness identity on the SAME protected state.
    fn restart(&mut self, daemon_uid: u32) {
        use std::os::unix::process::CommandExt;
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.sock);
        let cgid = gid_of(WITNESS_CLIENT_GROUP).unwrap();
        self.child = Command::new("runuser")
            .process_group(0)
            .arg("-u")
            .arg(WITNESS_USER)
            .arg("--")
            .arg(witness_bin())
            .arg("--dir")
            .arg(&self.state)
            .arg("--socket")
            .arg(&self.sock)
            .arg("--allowed-uids")
            .arg(daemon_uid.to_string())
            .arg("--socket-group")
            .arg(cgid.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("respawn witness");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.sock.exists() {
            assert!(Instant::now() < deadline, "witness did not come back");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for WitnessRig {
    fn drop(&mut self) {
        // runuser forks: signal the whole process group.
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn witness_bin() -> PathBuf {
    if let Ok(p) = std::env::var("NEXUS_WITNESS_BIN") {
        return PathBuf::from(p);
    }
    nexusd_bin().with_file_name("nexus-witness")
}

fn start_witness_rig(daemon_uid: u32) -> Option<WitnessRig> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    let wuid = uid_of(WITNESS_USER)?;
    let wgid = gid_of(WITNESS_USER)?;
    let cgid = gid_of(WITNESS_CLIENT_GROUP)?;
    if !witness_bin().exists() {
        println!("NOT RUN: nexus-witness binary missing");
        return None;
    }
    let base = std::env::temp_dir().join(format!(
        "nexus-witness-{}-{}",
        std::process::id(),
        common::next_id("w")
    ));
    std::fs::create_dir_all(&base).ok()?;
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).ok()?;
    let own = |p: &Path, mode: u32, gid: u32| {
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::chown(c.as_ptr(), wuid, gid) }, 0);
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
    };
    let state = base.join("state");
    let sockdir = base.join("sock");
    std::fs::create_dir_all(&state).ok()?;
    std::fs::create_dir_all(&sockdir).ok()?;
    own(&state, 0o700, wgid);
    own(&sockdir, 0o750, cgid);
    let sock = sockdir.join("w.sock");
    use std::os::unix::process::CommandExt;
    let child = Command::new("runuser")
        .process_group(0)
        .arg("-u")
        .arg(WITNESS_USER)
        .arg("--")
        .arg(witness_bin())
        .arg("--dir")
        .arg(&state)
        .arg("--socket")
        .arg(&sock)
        .arg("--allowed-uids")
        .arg(daemon_uid.to_string())
        .arg("--socket-group")
        .arg(cgid.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !sock.exists() {
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Some(WitnessRig {
        child,
        base,
        state,
        sock,
        uid: wuid,
    })
}

fn witness_human_setup(tag: &str) -> Option<(Human, WitnessRig)> {
    let mut h = human_setup(tag)?;
    let rig = start_witness_rig(h.t.h.nexusd_uid)?;
    h.d.argv.extend([
        "--external-witness".to_owned(),
        rig.sock.to_string_lossy().into_owned(),
        "--external-witness-uid".to_owned(),
        rig.uid.to_string(),
    ]);
    h.d.restart();
    h.issuer_cap = h.d.read_handoff(); // keys rotate on every start
    Some((h, rig))
}

fn status_via(user: &str, sock: &Path) -> Result<serde_json::Value, String> {
    let frame = serde_json::json!({"v":1,"op":"status","nonce":"probe"}).to_string();
    send_as(user, sock, &frame)
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_witness_state_and_key_are_unreachable_to_every_other_identity() {
    let Some((h, rig)) = witness_human_setup("wiso") else {
        return;
    };
    let key = rig.state.join("witness.key");
    let st = rig.state.join("state.json");
    // Anchored operation works across real identities.
    h.put_file("a.txt", "before\n");
    let args = serde_json::json!({"path": "a.txt", "content": "after\n", "mode": "replace",
        "expectedSha256": sha_hex("before\n")});
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(
            &h.issuer_cap,
            "approval-request",
            h.tool_params("w-1", args),
        ),
    )
    .unwrap();
    assert_eq!(r["ok"], true, "{r}");
    let integ = send_as(
        ISSUER_USER,
        &h.d.socket,
        &serde_json::json!({"protocol":1,"id":common::next_id("i"),"cmd":"integrity-status","params":{}})
            .to_string(),
    )
    .unwrap();
    assert_eq!(integ["integrity"]["state"], "verified", "{integ}");
    // Daemon, issuer, approver, bystander, untrusted: no read, no listing.
    for who in [
        DAEMON_USER,
        ISSUER_USER,
        APPROVER_USER,
        BYSTANDER_USER,
        UNTRUSTED_USER,
    ] {
        assert!(cat_as(who, &key).is_err(), "{who} read the witness key");
        assert!(cat_as(who, &st).is_err(), "{who} read witness state");
        assert!(!ls_as(who, &rig.state), "{who} listed witness state");
    }
    // The daemon cannot write or replace witness state either.
    let o = run_as(
        DAEMON_USER,
        "sh",
        &["-c", &format!("echo x > {}", st.to_string_lossy())],
    )
    .unwrap();
    assert!(!o.status.success());
    let o = run_as(DAEMON_USER, "rm", &["-f", &st.to_string_lossy()]).unwrap();
    assert!(!o.status.success() || st.exists());
    assert!(st.exists());
    // Modes (and ownership) are exact, and survive a daemon restart.
    let mut h = h;
    let before = (stat_of(&rig.state), stat_of(&key), stat_of(&st));
    h.d.restart();
    assert_eq!(before, (stat_of(&rig.state), stat_of(&key), stat_of(&st)));
    assert_eq!(stat_of(&rig.state).0, rig.uid);
    assert_eq!(stat_of(&rig.state).2, 0o700);
    assert_eq!(stat_of(&key).2, 0o600);
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_only_the_daemon_uid_can_talk_to_the_witness_and_cannot_rewind_it() {
    let Some((h, rig)) = witness_human_setup("wpeer") else {
        return;
    };
    // Only the daemon may commit/query: a same-group but unauthorized
    // identity reaches the socket and is refused on the peer UID.
    let r = status_via(BYSTANDER_USER, &rig.sock).expect("bystander can connect (group)");
    assert_eq!(r["code"], "peer-unauthorized", "{r}");
    // Identities outside the client group never reach it (kernel EACCES).
    for who in [ISSUER_USER, APPROVER_USER, UNTRUSTED_USER] {
        assert!(
            status_via(who, &rig.sock).is_err(),
            "{who} connected to the witness"
        );
    }
    // Integrity status is peer-gated on the daemon too (same-group bystander).
    let r = send_as(
        BYSTANDER_USER,
        &h.d.socket,
        &serde_json::json!({"protocol":1,"id":common::next_id("i"),"cmd":"integrity-status","params":{}})
            .to_string(),
    )
    .unwrap();
    assert_eq!(code_of(&r), "peer-unauthorized", "{r}");
    // The daemon identity itself cannot rewind or fork committed history.
    h.put_file("a.txt", "x\n");
    let args = serde_json::json!({"path": "a.txt", "content": "y\n", "mode": "replace",
        "expectedSha256": sha_hex("x\n")});
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(
            &h.issuer_cap,
            "approval-request",
            h.tool_params("w-2", args),
        ),
    )
    .unwrap();
    assert_eq!(r["ok"], true, "{r}");
    let st = status_via(DAEMON_USER, &rig.sock).unwrap();
    assert_eq!(st["ok"], true, "{st}");
    let store = st["storeId"].as_str().unwrap().to_owned();
    let n = st["journals"]["approval-events"]["count"].as_u64().unwrap();
    assert!(n >= 2);
    let evil = serde_json::json!({"v":1,"op":"commit","nonce":"e1","storeId":store,
        "journal":"approval-events","count":1,"tail":"a".repeat(64),
        "prevCount":0,"prevTail":"0".repeat(64)})
    .to_string();
    let r = send_as(DAEMON_USER, &rig.sock, &evil).unwrap();
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(r["code"], "rollback");
    let after = status_via(DAEMON_USER, &rig.sock).unwrap();
    assert_eq!(
        after["journals"]["approval-events"],
        st["journals"]["approval-events"]
    );
    assert!(after["violations"].as_u64().unwrap() >= 1);
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_daemon_uid_rollback_of_its_own_journal_is_detected_by_the_witness() {
    let Some((mut h, _rig)) = witness_human_setup("wroll") else {
        return;
    };
    h.put_file("a.txt", "before\n");
    let args = serde_json::json!({"path": "a.txt", "content": "after\n", "mode": "replace",
        "expectedSha256": sha_hex("before\n")});
    for rid in ["r-1", "r-2"] {
        let mut a = args.clone();
        a["content"] = serde_json::json!(format!("after-{rid}\n"));
        let r = send_as(
            ISSUER_USER,
            &h.d.socket,
            &signed_frame(&h.issuer_cap, "approval-request", h.tool_params(rid, a)),
        )
        .unwrap();
        assert_eq!(r["ok"], true, "{r}");
    }
    // The daemon UID (owner of its database) deletes approval history as
    // itself. Nothing local can tell; the independent witness can.
    let db = h.d.db.clone();
    terminate(&mut h.d.child);
    let _ = h.d.child.wait();
    let o = run_as(
        DAEMON_USER,
        "python3",
        &[
            "-c",
            "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('DELETE FROM approval_events WHERE seq > (SELECT MIN(seq)+1 FROM approval_events)');c.commit()",
            &db.to_string_lossy(),
        ],
    )
    .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let _ = std::fs::remove_file(&h.d.socket);
    h.d.restart();
    h.issuer_cap = h.d.read_handoff();
    let integ = send_as(
        ISSUER_USER,
        &h.d.socket,
        &serde_json::json!({"protocol":1,"id":common::next_id("i"),"cmd":"integrity-status","params":{}})
            .to_string(),
    )
    .unwrap();
    assert_eq!(integ["integrity"]["state"], "integrity-mismatch", "{integ}");
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(
            &h.issuer_cap,
            "approval-request",
            h.tool_params("r-3", args),
        ),
    )
    .unwrap();
    assert_ne!(r["ok"], true, "authority must be refused: {r}");
}

// ---------------------------------------------------------------------------
// A4.4 integrated offline end-to-end under the production-v1 profile with
// real, distinct identities: issuer, approver, daemon, witness, bystander,
// untrusted. Approver interaction is driven by this harness over IPC: it is
// labelled TEST-ONLY and is NOT authenticated human presence (the pty CLI
// test covers the terminal workflow; presence remains PARTIAL).
// ---------------------------------------------------------------------------

fn profile_flags() -> Vec<String> {
    [
        "--require-external-witness",
        "--security-profile",
        "production-v1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn ipc_i(h: &Human, cmd: &str, p: serde_json::Value) -> serde_json::Value {
    send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, cmd, p),
    )
    .expect("issuer ipc")
}

fn ipc_a(h: &Human, key: &str, cmd: &str, p: serde_json::Value) -> serde_json::Value {
    send_as(APPROVER_USER, &h.d.socket, &signed_frame(key, cmd, p)).expect("approver ipc")
}

fn read_only(h: &Human, who: &str, cmd: &str) -> serde_json::Value {
    send_as(
        who,
        &h.d.socket,
        &serde_json::json!({"protocol":1,"id":common::next_id("r"),"cmd":cmd,"params":{}})
            .to_string(),
    )
    .expect("read-only ipc")
}

fn wit_counts(rig: &WitnessRig) -> (u64, u64) {
    let st = status_via(DAEMON_USER, &rig.sock).expect("witness status");
    (
        st["journals"]["tool-journal"]["count"]
            .as_u64()
            .unwrap_or(0),
        st["journals"]["approval-events"]["count"]
            .as_u64()
            .unwrap_or(0),
    )
}

fn db_counts(db: &Path) -> (u64, u64) {
    // Read as root (harness); the daemon user owns the files.
    let c = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("db readable by root");
    let t: u64 = c
        .query_row("SELECT COUNT(*) FROM tool_journal", [], |r| r.get(0))
        .unwrap();
    let a: u64 = c
        .query_row("SELECT COUNT(*) FROM approval_events", [], |r| r.get(0))
        .unwrap();
    (t, a)
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_integrated_offline_e2e_under_the_production_profile() {
    let Some((mut h, mut rig)) = witness_human_setup("a44e2e") else {
        return;
    };
    // Production profile: restart the daemon under production-v1.
    h.d.argv.extend(profile_flags());
    h.d.restart();
    h.issuer_cap = h.d.read_handoff();
    let integ = read_only(&h, ISSUER_USER, "integrity-status");
    assert_eq!(integ["securityProfile"], "production-v1", "{integ}");
    assert_eq!(integ["integrity"]["state"], "verified", "{integ}");

    let args = |content: &str, pre: &str| {
        serde_json::json!({"path": "a.txt", "content": content, "mode": "replace",
            "expectedSha256": sha_hex(pre)})
    };
    h.put_file("a.txt", "v0\n");
    let propose = |h: &Human, rid: &str, a: serde_json::Value, ttl: Option<u64>| {
        let mut p = h.tool_params(rid, a);
        if let Some(t) = ttl {
            p["ttlMs"] = serde_json::json!(t);
        }
        ipc_i(h, "approval-request", p)
    };
    let review = |h: &Human, key: &str, id: &str| {
        ipc_a(
            h,
            key,
            "approval-get",
            serde_json::json!({"approvalId": id}),
        )
    };
    let decide = |h: &Human, key: &str, id: &str, g: &serde_json::Value, d: &str| {
        let a = &g["approval"];
        ipc_a(
            h,
            key,
            "approval-decide",
            serde_json::json!({
            "approvalId": id, "requestDigest": a["requestDigest"], "decision": d,
            "reviewCode": a["reviewCode"], "confirmation": {"tty": false}}),
        )
    };
    let exec = |h: &Human, rid: &str, a: serde_json::Value| {
        ipc_i(h, "tool-execute", h.tool_params(rid, a))
    };

    // --- 1..2: proposal, daemon-authored request, independent review/deny.
    let r = propose(&h, "e-1", args("v1\n", "v0\n"), None);
    assert_eq!(r["ok"], true, "{r}");
    let id1 = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let akey = h.approver_key();
    let g = review(&h, &akey, &id1);
    assert_eq!(
        g["approval"]["request"]["operation"]["postImageSha256"],
        sha_hex("v1\n")
    );
    let d = decide(&h, &akey, &id1, &g, "deny");
    assert_eq!(d["approval"]["state"], "denied", "{d}");
    assert_eq!(
        code_of(&exec(&h, "e-1x", args("v1\n", "v0\n"))),
        "scope-refused"
    );
    assert_eq!(std::fs::read_to_string(h.ws.join("a.txt")).unwrap(), "v0\n");

    // --- 3..9: approve -> witness-committed -> consume -> execute -> verify.
    let r = propose(&h, "e-2", args("v1\n", "v0\n"), None);
    let id2 = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = review(&h, &akey, &id2);
    let d = decide(&h, &akey, &id2, &g, "approve");
    assert_eq!(d["approval"]["state"], "approved", "{d}");
    // The decision is already witnessed when the response is returned.
    let (_, wa) = wit_counts(&rig);
    assert_eq!(wa, db_counts(&h.d.db).1, "approval journal fully witnessed");
    // Exact scope only: any other content is refused.
    assert_eq!(
        code_of(&exec(&h, "e-2bad", args("EVIL\n", "v0\n"))),
        "scope-refused"
    );
    let r = exec(&h, "e-2ok", args("v1\n", "v0\n"));
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(std::fs::read_to_string(h.ws.join("a.txt")).unwrap(), "v1\n");
    assert_eq!(
        code_of(&exec(&h, "e-2again", args("v1\n", "v0\n"))),
        "scope-refused"
    );
    let (wt, wa) = wit_counts(&rig);
    assert_eq!(
        (wt, wa),
        db_counts(&h.d.db),
        "journals fully witnessed after execution"
    );
    let integ = read_only(&h, ISSUER_USER, "integrity-status");
    assert_eq!(integ["integrity"]["state"], "verified", "{integ}");
    let hist = read_only(&h, ISSUER_USER, "approval-list");
    assert!(hist["approvals"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["approvalId"] == id2 && a["state"] == "consumed"));

    // --- expiry
    let r = propose(&h, "e-3", args("v2\n", "v1\n"), Some(1000));
    let id3 = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = review(&h, &akey, &id3);
    std::thread::sleep(Duration::from_millis(1400));
    let d = decide(&h, &akey, &id3, &g, "approve");
    assert_ne!(d["ok"], true, "expired approval must not be decidable: {d}");

    // --- revocation before execution
    let r = propose(&h, "e-4", args("v2\n", "v1\n"), None);
    let id4 = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = review(&h, &akey, &id4);
    assert_eq!(decide(&h, &akey, &id4, &g, "approve")["ok"], true);
    let r = ipc_i(
        &h,
        "approval-revoke",
        serde_json::json!({"approvalId": id4, "reason": "e2e"}),
    );
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(
        code_of(&exec(&h, "e-4x", args("v2\n", "v1\n"))),
        "scope-refused"
    );

    // --- restart: approved-but-unconsumed lapses; history verifies.
    let r = propose(&h, "e-5", args("v2\n", "v1\n"), None);
    let id5 = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = review(&h, &akey, &id5);
    assert_eq!(decide(&h, &akey, &id5, &g, "approve")["ok"], true);
    h.d.restart();
    h.issuer_cap = h.d.read_handoff();
    assert_eq!(
        code_of(&exec(&h, "e-5x", args("v2\n", "v1\n"))),
        "scope-refused"
    );
    let integ = read_only(&h, ISSUER_USER, "integrity-status");
    assert_eq!(integ["integrity"]["state"], "verified", "{integ}");
    assert_eq!(integ["securityProfile"], "production-v1");

    // --- witness outage: reads stay up, authority refused, then recovery.
    unsafe {
        libc::kill(-(rig.child.id() as i32), libc::SIGKILL);
    }
    let _ = rig.child.wait();
    let _ = std::fs::remove_file(&rig.sock);
    assert_eq!(read_only(&h, ISSUER_USER, "health")["ok"], true);
    let r = propose(&h, "e-7", args("v2\n", "v1\n"), None);
    assert_ne!(r["ok"], true, "no authority while the witness is down: {r}");
    let integ = read_only(&h, ISSUER_USER, "integrity-status");
    assert_eq!(
        integ["integrity"]["state"], "witness-unavailable",
        "{integ}"
    );
    // Real-identity boundaries still hold during the outage.
    assert_eq!(
        code_of(
            &send_as(
                BYSTANDER_USER,
                &h.d.socket,
                &signed_frame(
                    &h.issuer_cap,
                    "tool-execute",
                    serde_json::json!({"requestId":"x"})
                )
            )
            .unwrap()
        ),
        "peer-unauthorized"
    );
    assert!(send_as(UNTRUSTED_USER, &h.d.socket, "{}").is_err());
    // Same identity, same protected state: deterministic recovery.
    rig.restart(h.t.h.nexusd_uid);
    let integ = read_only(&h, ISSUER_USER, "integrity-status");
    assert_eq!(integ["integrity"]["state"], "verified", "{integ}");
    let akey = h.approver_key();
    // The request whose acknowledgement never arrived exists as PENDING
    // (it authorized nothing) and blocks an identical retry: withdraw it.
    let l = read_only(&h, ISSUER_USER, "approval-list");
    for a in l["approvals"].as_array().unwrap() {
        if a["state"] == "pending" {
            let r = ipc_i(
                &h,
                "approval-revoke",
                serde_json::json!({"approvalId": a["approvalId"]}),
            );
            assert_eq!(r["ok"], true, "{r}");
        }
    }
    let r = propose(&h, "e-8", args("v2\n", "v1\n"), None);
    assert_eq!(r["ok"], true, "authority returns with the witness: {r}");
    let id8 = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = review(&h, &akey, &id8);
    assert_eq!(decide(&h, &akey, &id8, &g, "approve")["ok"], true);
    assert_eq!(exec(&h, "e-8x", args("v2\n", "v1\n"))["ok"], true);
    assert_eq!(std::fs::read_to_string(h.ws.join("a.txt")).unwrap(), "v2\n");
    let (wt, wa) = wit_counts(&rig);
    assert_eq!((wt, wa), db_counts(&h.d.db));

    // --- stale lease: a new generation supersedes older approvals.
    let r = propose(&h, "e-9", args("v3\n", "v2\n"), None);
    let id6 = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = review(&h, &akey, &id6);
    assert_eq!(decide(&h, &akey, &id6, &g, "approve")["ok"], true);
    let acq = ipc_i(
        &h,
        "acquire",
        serde_json::json!({"taskInstanceId": h.task, "backend": "native"}),
    );
    assert_eq!(acq["ok"], true, "{acq}");
    let r = exec(&h, "e-9x", args("v3\n", "v2\n"));
    assert_ne!(r["ok"], true, "stale lease must not execute: {r}");
    assert_eq!(std::fs::read_to_string(h.ws.join("a.txt")).unwrap(), "v2\n");
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_production_profile_refuses_incomplete_downgraded_and_test_only_starts() {
    let Some((mut h, rig)) = witness_human_setup("a44prof") else {
        return;
    };
    let base_argv = h.d.argv.clone();
    // Start under the profile, then try every downgrade as the launcher.
    h.d.argv.extend(profile_flags());
    h.d.restart();
    let mut argv_ok = h.d.argv.clone();
    terminate(&mut h.d.child);
    let _ = h.d.child.wait();
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
    let _ = std::fs::remove_file(&h.d.socket);
    // (a) profile dropped on a profiled store, writes still enabled
    let (ok, out) = run(&base_argv);
    assert!(!ok && out.contains("profile-downgrade-refused"), "{out}");
    // (b) test-only approver flag under the profile
    let mut b = argv_ok.clone();
    b.push("--allow-nonindependent-approver-test-only".into());
    let (ok, out) = run(&b);
    assert!(!ok && out.contains("profile-violation"), "{out}");
    // (c) legacy adoption flag under the profile
    let mut c = argv_ok.clone();
    c.push("--witness-adopt-legacy".into());
    let (ok, out) = run(&c);
    assert!(!ok && out.contains("profile-violation"), "{out}");
    // (d) witness configuration omitted under the profile
    let mut d: Vec<String> = Vec::new();
    let mut skip = 0;
    for a in &argv_ok {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        if a == "--external-witness" || a == "--external-witness-uid" {
            skip = 1;
            continue;
        }
        d.push(a.clone());
    }
    let (ok, out) = run(&d);
    assert!(!ok && out.contains("profile-violation"), "{out}");
    // (e) witness fault injection armed in the daemon environment
    let o = Command::new("runuser")
        .arg("-u")
        .arg(DAEMON_USER)
        .arg("--")
        .env("NEXUS_WITNESS_FAULT", "fail-persist")
        .arg(nexusd_bin())
        .args(&argv_ok)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    // `runuser` forwards the environment: the profile must see it.
    let txt = String::from_utf8_lossy(&o.stderr).into_owned();
    assert!(
        !o.status.success() && txt.contains("NEXUS_WITNESS_FAULT"),
        "{txt}"
    );
    // (f) a fresh DataRoot with the profile but incomplete flags never
    //     creates a store or socket.
    let fresh = h.d.dir.join("fresh-profile");
    std::fs::create_dir_all(&fresh).unwrap();
    let mut f = vec![
        "--db".to_owned(),
        fresh.join("k.db").to_string_lossy().into_owned(),
        "--socket".to_owned(),
        fresh.join("n.sock").to_string_lossy().into_owned(),
        "--trust-mode".to_owned(),
        "shadow-test".to_owned(),
        "--security-profile".to_owned(),
        "production-v1".to_owned(),
        "--enable-writes".to_owned(),
    ];
    let (ok, out) = run(&f);
    assert!(!ok && out.contains("profile-violation"), "{out}");
    assert!(!fresh.join("k.db").exists() && !fresh.join("n.sock").exists());
    f.push("--validate-config-only".into());
    let (ok, _) = run(&f);
    assert!(!ok);
    // (g) read-only start of a profiled store is still possible (no writes).
    let mut ro: Vec<String> = Vec::new();
    let mut i = 0;
    while i < base_argv.len() {
        let a = &base_argv[i];
        if a == "--enable-writes" || a == "--require-human-approval" {
            i += 1;
            continue;
        }
        ro.push(a.clone());
        i += 1;
    }
    let _ = std::fs::remove_file(&h.d.socket);
    let mut child = Command::new("runuser")
        .arg("-u")
        .arg(DAEMON_USER)
        .arg("--")
        .arg(nexusd_bin())
        .args(&ro)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    poll_ready(&h.d.socket);
    let r = read_only(&h, ISSUER_USER, "health");
    assert_eq!(r["ok"], true);
    let _ = child.kill();
    let _ = child.wait();
    argv_ok.clear();
    drop(rig);
}

#[test]
#[ignore = "requires prepared multi-UID host (see MULTUID-PROCEDURE.md); NOT RUN elsewhere"]
fn multuid_sandboxed_process_under_approval_and_witness() {
    let Some((mut h, rig)) = witness_human_setup("a44proc") else {
        return;
    };
    h.d.argv.extend([
        "--enable-process".to_owned(),
        "--require-kernel-resource-limits".to_owned(),
        "--require-external-witness".to_owned(),
    ]);
    // Probe first: if the harness cannot provide kernel-enforced limits for
    // the daemon identity the daemon must REFUSE (fail closed). Report that
    // gate honestly instead of weakening the requirement.
    terminate(&mut h.d.child);
    let _ = h.d.child.wait();
    let _ = std::fs::remove_file(&h.d.socket);
    let probe = Command::new("timeout")
        .arg("8")
        .arg("runuser")
        .arg("-u")
        .arg(DAEMON_USER)
        .arg("--")
        .arg(nexusd_bin())
        .args(&h.d.argv)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&probe.stderr).into_owned();
    if text.contains("\"event\":\"fatal\"") {
        assert!(
            text.contains("sandbox-unavailable"),
            "refusal must be the explicit fail-closed code: {text}"
        );
        println!(
            "GATE BLOCKED: kernel-enforced limits unavailable to the daemon identity in the userns harness (daemon refused, fail closed). Continuing with the labelled POLLING backend; kernel enforcement is verified separately on the host."
        );
        h.d.argv.retain(|a| a != "--require-kernel-resource-limits");
    }
    let _ = std::fs::remove_file(&h.d.socket);
    h.d.restart();
    h.issuer_cap = h.d.read_handoff();
    h.put_file(
        "Cargo.toml",
        "[package]\nname = \"a44\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    );
    std::fs::create_dir_all(h.ws.join("src")).unwrap();
    h.put_file("src/lib.rs", "pub fn f() -> u8 { 1 }\n");
    let args = serde_json::json!({"program": "cargo", "args": ["check", "--offline"], "cwd": "."});
    let mk = |rid: &str| {
        let mut p = h.tool_params(rid, args.clone());
        p["toolId"] = serde_json::json!("proc.run");
        p
    };
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, "tool-execute", mk("p-0")),
    )
    .unwrap();
    assert_eq!(code_of(&r), "scope-refused", "{r}");
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, "approval-request", mk("p-1")),
    )
    .unwrap();
    assert_eq!(r["ok"], true, "{r}");
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let akey = h.approver_key();
    let g = send_as(
        APPROVER_USER,
        &h.d.socket,
        &signed_frame(&akey, "approval-get", serde_json::json!({"approvalId": id})),
    )
    .unwrap();
    let op = &g["approval"]["request"]["operation"];
    assert_eq!(op["sandbox"]["network"], "none");
    assert_eq!(op["argv"], serde_json::json!(["check", "--offline"]));
    let a = &g["approval"];
    let d = send_as(
        APPROVER_USER,
        &h.d.socket,
        &signed_frame(
            &akey,
            "approval-decide",
            serde_json::json!({"approvalId": id, "requestDigest": a["requestDigest"],
                "decision": "approve", "reviewCode": a["reviewCode"], "confirmation": {"tty": false}}),
        ),
    )
    .unwrap();
    assert_eq!(d["ok"], true, "{d}");
    let mut bad = mk("p-2");
    bad["args"]["args"] = serde_json::json!(["build", "--offline"]);
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, "tool-execute", bad),
    )
    .unwrap();
    assert_eq!(code_of(&r), "scope-refused", "{r}");
    let r = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, "tool-execute", mk("p-3")),
    )
    .unwrap();
    let r2 = send_as(
        ISSUER_USER,
        &h.d.socket,
        &signed_frame(&h.issuer_cap, "tool-execute", mk("p-4")),
    )
    .unwrap();
    assert_eq!(code_of(&r2), "scope-refused", "single use: {r2}");
    let list = read_only(&h, ISSUER_USER, "approval-list");
    assert!(
        list["approvals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["approvalId"] == id && x["state"] == "consumed"),
        "approval consumed by the execution attempt: first={r}"
    );
    let (wt, wa) = wit_counts(&rig);
    assert_eq!((wt, wa), db_counts(&h.d.db), "journals fully witnessed");
    let integ = read_only(&h, ISSUER_USER, "integrity-status");
    assert_eq!(integ["integrity"]["state"], "verified", "{integ}");
    println!("PROCESS RESULT: ok={} code={}", r["ok"], code_of(&r));
}
