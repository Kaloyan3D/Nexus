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
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(300)
                .collect::<String>()
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
