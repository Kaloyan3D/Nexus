//! A3.3 trusted write integration over the real nexusd IPC boundary.
//! Real daemon subprocess, sockets, filesystem and SIGKILL crash points.

mod common;

use common::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

fn sha(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

struct W {
    d: DaemonProc,
    cap: String,
    approver_cap_path: PathBuf,
    approver_cap: String,
    base: tempfile::TempDir,
    _acap_dir: tempfile::TempDir,
    ws: PathBuf,
    task: String,
    attempt: String,
    command: String,
    epoch: u64,
    inc: String,
    root_digest: String,
    n: u32,
}

fn setup_with(tag: &str, extra: &[&str], envs: &[(&str, &str)], approve: bool) -> W {
    use std::os::unix::fs::PermissionsExt;
    let base = tempfile::tempdir().unwrap();
    let basep = std::fs::canonicalize(base.path()).unwrap();
    let ws = basep.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let acap_dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(acap_dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let approver_cap_path = acap_dir.path().join("approver.cap");
    let uid = euid().to_string();
    let mut args: Vec<String> = vec![
        "--workspace-bases".into(),
        basep.to_str().unwrap().into(),
        "--allowed-uids".into(),
        uid.clone(),
        "--enable-writes".into(),
        "--approver-cap".into(),
        approver_cap_path.to_str().unwrap().into(),
        "--approver-uids".into(),
        uid,
        "--allow-nonindependent-approver-test-only".into(),
    ];
    args.extend(extra.iter().map(|s| s.to_string()));
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let d = spawn_daemon_env("shadow-test", true, &refs, envs);
    let cap = read_cap(&d.cap);
    let approver_cap = read_cap(&approver_cap_path);
    let (task, attempt, command) = (
        format!("task-{tag}"),
        format!("attempt-{tag}"),
        format!("cmd-{tag}"),
    );
    let root_digest = sha(ws.to_str().unwrap());
    let rec = accept_one_ws(&d.socket, &cap, &task, &attempt, &command, &root_digest);
    let receipt = rec.get("receipt").unwrap();
    let mut w = W {
        d,
        cap,
        approver_cap_path,
        approver_cap,
        base,
        _acap_dir: acap_dir,
        ws,
        task,
        attempt,
        command,
        epoch: receipt["leaseEpoch"].as_u64().unwrap(),
        inc: receipt["storeIncarnation"].as_str().unwrap().to_owned(),
        root_digest,
        n: 0,
    };
    assert_ok(&w.issuer(
        "workspace-bind",
        json!({"commandId": w.command, "root": w.ws.to_str().unwrap()}),
    ));
    if approve {
        assert_ok(&w.approve(1 << 20));
    }
    w.n = 0;
    w
}

fn setup(tag: &str) -> W {
    setup_with(tag, &[], &[], true)
}

/// A panicking test must never leak a daemon (and its sandboxes).
impl Drop for W {
    fn drop(&mut self) {
        let _ = self.d.child.kill();
        let _ = self.d.child.wait();
    }
}

impl W {
    fn issuer(&self, cmd: &str, params: Value) -> Value {
        raw_request(&self.d.socket, &authed_frame(&self.cap, cmd, params)).unwrap()
    }
    fn approve(&self, max: u64) -> Value {
        raw_request(
            &self.d.socket,
            &authed_frame(
                &self.approver_cap,
                "write-scope-approve",
                json!({"commandId": self.command, "workspaceRootDigest": self.root_digest,
                       "maxWriteBytes": max, "approverId": "test-approver"}),
            ),
        )
        .unwrap()
    }
    fn params(&mut self, tool: &str, args: Value) -> Value {
        self.n += 1;
        json!({
            "requestId": format!("w-{}-{}", self.command, self.n),
            "cancellationId": format!("wc-{}-{}", self.command, self.n),
            "taskInstanceId": self.task, "attemptId": self.attempt, "commandId": self.command,
            "leaseEpoch": self.epoch, "storeIncarnation": self.inc,
            "toolId": tool, "toolVersion": 1, "args": args,
        })
    }
    fn exec(&mut self, tool: &str, args: Value) -> Value {
        let p = self.params(tool, args);
        self.issuer("tool-execute", p)
    }
    fn write(&self, rel: &str, c: &str) {
        let p = self.ws.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, c).unwrap();
    }
    fn disk(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.ws.join(rel)).ok()
    }
    fn events(&self) -> Vec<Value> {
        let r = raw_request(
            &self.d.socket,
            &json!({"protocol":1,"id":next_id("ev"),"cmd":"tool-events","params":{
                "taskInstanceId": self.task, "attemptId": self.attempt, "limit": 200}})
            .to_string(),
        )
        .unwrap();
        r["records"].as_array().cloned().unwrap_or_default()
    }
    fn phases(&self) -> Vec<String> {
        self.events()
            .iter()
            .map(|r| r["phase"].as_str().unwrap().to_owned())
            .collect()
    }
    fn tmp_files(&self) -> usize {
        std::fs::read_dir(&self.ws)
            .unwrap()
            .flatten()
            .filter(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.starts_with(".nexus-tmp-") || n.starts_with(".nexus-stage-")
            })
            .count()
    }
}

fn respawn(w: &W, envs: &[(&str, &str)]) -> std::process::Child {
    let basep = std::fs::canonicalize(w.base.path()).unwrap();
    let uid = euid().to_string();
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&w.d.db)
        .arg("--socket")
        .arg(&w.d.socket)
        .arg("--cap")
        .arg(&w.d.cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&w.d.witness)
        .arg("--workspace-bases")
        .arg(&basep)
        .arg("--allowed-uids")
        .arg(&uid)
        .arg("--enable-writes")
        .arg("--approver-cap")
        .arg(&w.approver_cap_path)
        .arg("--approver-uids")
        .arg(&uid)
        .arg("--allow-nonindependent-approver-test-only")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    common::die_with_test(&mut cmd);
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(r) = raw_request(
            &w.d.socket,
            r#"{"protocol":1,"id":"p","cmd":"health","params":{}}"#,
        ) {
            if r["ok"] == true {
                return child;
            }
        }
        if let Ok(Some(st)) = child.try_wait() {
            panic!("daemon exited: {st}");
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(25));
    }
}

// ------------------------------------------------------------------ authority

#[test]
fn issuer_capability_alone_cannot_approve_and_approver_cannot_issue() {
    let mut w = setup_with("keys", &[], &[], false);
    w.write("a.txt", "orig\n");
    let args = json!({"path": "a.txt", "content": "NEW", "mode": "replace", "expectedSha256": sha("orig\n")});
    // Without approval: scope-refused (the issuer cannot make one).
    let r = w.exec("fs.write", args.clone());
    assert_refused(&r, "scope-refused");
    // The issuer key cannot satisfy write-scope-approve.
    let r = raw_request(
        &w.d.socket,
        &authed_frame(&w.cap, "write-scope-approve",
            json!({"commandId": w.command, "workspaceRootDigest": w.root_digest, "maxWriteBytes": 1000})),
    )
    .unwrap();
    assert_refused(&r, "issuer-untrusted");
    // The approver key cannot execute or bind as issuer.
    let p = w.params("fs.write", args.clone());
    let r = raw_request(
        &w.d.socket,
        &authed_frame(&w.approver_cap, "tool-execute", p),
    )
    .unwrap();
    assert_refused(&r, "issuer-untrusted");
    let r = raw_request(
        &w.d.socket,
        &authed_frame(
            &w.approver_cap,
            "workspace-bind",
            json!({"commandId": w.command, "root": w.ws.to_str().unwrap()}),
        ),
    )
    .unwrap();
    assert_refused(&r, "issuer-untrusted");
    // Approving a different workspace digest is refused.
    let r = raw_request(
        &w.d.socket,
        &authed_frame(&w.approver_cap, "write-scope-approve",
            json!({"commandId": w.command, "workspaceRootDigest": sha("/elsewhere"), "maxWriteBytes": 1000})),
    )
    .unwrap();
    assert_refused(&r, "binding-mismatch");
    assert_eq!(w.disk("a.txt").unwrap(), "orig\n");
    // Correct approval is accepted; replay of the approval frame is not.
    let frame = authed_frame(
        &w.approver_cap,
        "write-scope-approve",
        json!({"commandId": w.command, "workspaceRootDigest": w.root_digest, "maxWriteBytes": 1 << 20}),
    );
    let r = raw_request(&w.d.socket, &frame).unwrap();
    assert_ok(&r);
    // Same-UID test configuration is honestly reported as NOT independent.
    assert_eq!(r["writeScope"]["independent"], false);
    assert_refused(
        &raw_request(&w.d.socket, &frame).unwrap(),
        "replay-rejected",
    );
    // And now the write is permitted.
    let r = w.exec("fs.write", args);
    assert_ok(&r);
    assert_eq!(w.disk("a.txt").unwrap(), "NEW");
}

#[test]
fn writes_are_disabled_by_default_and_misconfiguration_fails_closed() {
    // Default daemon (no --enable-writes): mutating tools refused.
    let base = tempfile::tempdir().unwrap();
    let basep = std::fs::canonicalize(base.path()).unwrap();
    let ws = basep.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let mut d = spawn_daemon_opts(
        "shadow-test",
        true,
        &["--workspace-bases", basep.to_str().unwrap()],
    );
    let cap = read_cap(&d.cap);
    let digest = sha(ws.to_str().unwrap());
    let rec = accept_one_ws(&d.socket, &cap, "t-def", "a-def", "c-def", &digest);
    let rc = rec["receipt"].clone();
    assert_ok(
        &raw_request(
            &d.socket,
            &authed_frame(
                &cap,
                "workspace-bind",
                json!({"commandId": "c-def", "root": ws.to_str().unwrap()}),
            ),
        )
        .unwrap(),
    );
    let r = raw_request(
        &d.socket,
        &authed_frame(&cap, "tool-execute", json!({
            "requestId": "r1", "cancellationId": "c1", "taskInstanceId": "t-def", "attemptId": "a-def",
            "commandId": "c-def", "leaseEpoch": rc["leaseEpoch"], "storeIncarnation": rc["storeIncarnation"],
            "toolId": "fs.write", "toolVersion": 1,
            "args": {"path": "x.txt", "content": "x", "mode": "create"}})),
    )
    .unwrap();
    assert_refused(&r, "write-disabled");
    assert!(!ws.join("x.txt").exists());
    terminate(&mut d.child);

    // Misconfigurations refuse to START (no silent fallback).
    for extra in [
        vec!["--enable-writes"],
        vec!["--enable-writes", "--allowed-uids", "1000"],
        vec![
            "--enable-writes",
            "--allowed-uids",
            "1000",
            "--approver-uids",
            "1000",
        ],
    ] {
        let dir = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut c = Command::new(nexusd_bin());
        c.arg("--db")
            .arg(dir.path().join("k.db"))
            .arg("--socket")
            .arg(dir.path().join("s.sock"))
            .arg("--cap")
            .arg(dir.path().join("c.cap"))
            .arg("--trust-mode")
            .arg("shadow-test");
        for e in &extra {
            c.arg(e);
        }
        let out = c.output().unwrap();
        assert!(!out.status.success(), "must refuse: {extra:?}");
    }
    // --require-independent-approver with overlapping UIDs refuses.
    let dir = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let uid = euid().to_string();
    let out = Command::new(nexusd_bin())
        .arg("--db")
        .arg(dir.path().join("k.db"))
        .arg("--socket")
        .arg(dir.path().join("s.sock"))
        .arg("--cap")
        .arg(dir.path().join("c.cap"))
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--enable-writes")
        .arg("--allowed-uids")
        .arg(&uid)
        .arg("--approver-uids")
        .arg(&uid)
        .arg("--approver-cap")
        .arg(dir.path().join("a.cap"))
        .arg("--workspace-bases")
        .arg(dir.path())
        .arg("--require-independent-approver")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("overlap")
            || String::from_utf8_lossy(&out.stdout).contains("overlap")
    );
}

#[test]
fn approver_peer_uid_is_enforced_even_with_the_valid_approver_key() {
    use std::os::unix::fs::PermissionsExt;
    let base = tempfile::tempdir().unwrap();
    let basep = std::fs::canonicalize(base.path()).unwrap();
    let acap = tempfile::tempdir().unwrap();
    std::fs::set_permissions(acap.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let cap_path = acap.path().join("approver.cap");
    let uid = euid().to_string();
    let mut d = spawn_daemon_opts(
        "shadow-test",
        true,
        &[
            "--workspace-bases",
            basep.to_str().unwrap(),
            "--allowed-uids",
            &uid,
            "--enable-writes",
            "--approver-cap",
            cap_path.to_str().unwrap(),
            "--approver-uids",
            "4242",
        ],
    );
    let key = read_cap(&cap_path);
    let r = raw_request(
        &d.socket,
        &authed_frame(
            &key,
            "write-scope-approve",
            json!({"commandId": "c", "workspaceRootDigest": "d", "maxWriteBytes": 10}),
        ),
    )
    .unwrap();
    assert_refused(&r, "peer-unauthorized");
    terminate(&mut d.child);
}

// ------------------------------------------------------ end-to-end behavior

#[test]
fn write_and_edit_flow_through_ipc_with_full_lifecycle_records() {
    let mut w = setup("flow");
    let r = w.exec(
        "fs.write",
        json!({"path": "n.txt", "content": "v1\n", "mode": "create"}),
    );
    assert_ok(&r);
    assert_eq!(r["result"]["output"]["state"], "verified");
    assert_eq!(r["execution"]["scope"], "write");
    assert_eq!(w.disk("n.txt").unwrap(), "v1\n");
    let r = w.exec(
        "fs.edit",
        json!({"path": "n.txt", "expectedSha256": sha("v1\n"),
               "edits": [{"oldText": "v1", "newText": "v2"}]}),
    );
    assert_ok(&r);
    assert_eq!(w.disk("n.txt").unwrap(), "v2\n");
    // conflict: stale pre-image
    let r = w.exec(
        "fs.edit",
        json!({"path": "n.txt", "expectedSha256": sha("v1\n"),
               "edits": [{"oldText": "v2", "newText": "v3"}]}),
    );
    assert_ok(&r);
    assert_eq!(r["result"]["error"]["code"], "conflict");
    assert_eq!(w.disk("n.txt").unwrap(), "v2\n");
    let ph = w.phases();
    assert_eq!(
        ph,
        vec![
            "authorized",
            "started",
            "planned",
            "prepared",
            "applied",
            "verified",
            "authorized",
            "started",
            "planned",
            "prepared",
            "applied",
            "verified",
            "authorized",
            "started",
            "conflict",
        ]
    );
    // Events carry pre/post metadata and never content.
    let ev = w.events();
    let verified = ev.iter().find(|e| e["phase"] == "verified").unwrap();
    assert_eq!(verified["change"]["postSha256"], sha("v1\n"));
    assert_eq!(verified["change"]["operation"], "create");
    let dump = serde_json::to_string(&ev).unwrap();
    assert!(!dump.contains("\"v2"));
    assert!(w.tmp_files() == 0);
    // read tools still work on the same binding
    let r = w.exec("fs.read", json!({"path": "n.txt"}));
    assert_ok(&r);
    assert_eq!(r["result"]["output"]["content"], "v2\n");
}

#[test]
fn cross_task_scope_cannot_be_reused_and_events_do_not_leak() {
    let mut w = setup("xt");
    // A second, unrelated accepted command with its own workspace.
    let ws2 = w.base.path().join("ws2");
    std::fs::create_dir_all(&ws2).unwrap();
    let ws2 = std::fs::canonicalize(&ws2).unwrap();
    let rec2 = accept_one_ws(
        &w.d.socket,
        &w.cap,
        "task-other",
        "attempt-other",
        "cmd-other",
        &sha(ws2.to_str().unwrap()),
    );
    let rc2 = rec2["receipt"].clone();
    assert_ok(&w.issuer(
        "workspace-bind",
        json!({"commandId": "cmd-other", "root": ws2.to_str().unwrap()}),
    ));
    // Command 1's approval cannot be borrowed by command 2.
    let r = w.issuer("tool-execute", json!({
        "requestId": "x1", "cancellationId": "xc1", "taskInstanceId": "task-other", "attemptId": "attempt-other",
        "commandId": "cmd-other", "leaseEpoch": rc2["leaseEpoch"], "storeIncarnation": rc2["storeIncarnation"],
        "toolId": "fs.write", "toolVersion": 1, "args": {"path": "p.txt", "content": "x", "mode": "create"}}));
    assert_refused(&r, "scope-refused");
    assert!(!ws2.join("p.txt").exists());
    // And cmd-1's approval digest cannot approve cmd-2.
    let r = raw_request(
        &w.d.socket,
        &authed_frame(&w.approver_cap, "write-scope-approve",
            json!({"commandId": "cmd-other", "workspaceRootDigest": w.root_digest, "maxWriteBytes": 100})),
    )
    .unwrap();
    assert_refused(&r, "binding-mismatch");
    // Task 1's writes do not appear under task 2.
    assert_ok(&w.exec(
        "fs.write",
        json!({"path": "mine.txt", "content": "m", "mode": "create"}),
    ));
    let r = raw_request(
        &w.d.socket,
        &json!({"protocol":1,"id":"e","cmd":"tool-events","params":{
            "taskInstanceId": "task-other", "attemptId": "attempt-other"}})
        .to_string(),
    )
    .unwrap();
    assert_ok(&r);
    assert!(r["records"].as_array().unwrap().is_empty());
}

#[test]
fn revocation_blocks_further_writes_and_survives_restart() {
    let mut w = setup("revoke");
    w.write("a.txt", "orig\n");
    assert_ok(&w.issuer("tool-revoke", json!({"commandId": w.command})));
    let r = w.exec("fs.write", json!({"path": "a.txt", "content": "N", "mode": "replace", "expectedSha256": sha("orig\n")}));
    assert_eq!(r["ok"], false);
    terminate(&mut w.d.child);
    let mut c = respawn(&w, &[]);
    w.cap = read_cap(&w.d.cap);
    let r = w.exec("fs.write", json!({"path": "a.txt", "content": "N", "mode": "replace", "expectedSha256": sha("orig\n")}));
    assert_eq!(r["ok"], false);
    assert_eq!(w.disk("a.txt").unwrap(), "orig\n");
    terminate(&mut c);
}

// ---------------------------------------------------------- crash recovery

fn crash_case(
    point: &str,
    replace: bool,
    want_observed: &str,
    want_mutation: &str,
    want_disk: &str,
) {
    let tag = format!("crash-{point}-{}", if replace { "r" } else { "c" });
    let mut w = setup_with(&tag, &[], &[("NEXUS_TEST_WRITE_CRASH_AT", point)], true);
    w.write("a.txt", "orig\n");
    let args = if replace {
        json!({"path": "a.txt", "content": "NEW\n", "mode": "replace", "expectedSha256": sha("orig\n")})
    } else {
        json!({"path": "created.txt", "content": "NEW\n", "mode": "create"})
    };
    let p = w.params("fs.write", args);
    let rid = p["requestId"].as_str().unwrap().to_owned();
    let r = raw_request(
        &w.d.socket,
        &authed_frame(&w.cap, "tool-execute", p.clone()),
    );
    assert!(
        r.is_err() || r.as_ref().unwrap()["ok"] != true,
        "daemon should have died: {r:?}"
    );
    let _ = w.d.child.wait();
    let _ = std::fs::remove_file(&w.d.socket);

    let mut c = respawn(&w, &[]);
    w.cap = read_cap(&w.d.cap);
    let ev = w.events();
    let last = ev.last().unwrap();
    assert_eq!(last["phase"], "interrupted", "{point}: {:?}", w.phases());
    assert_eq!(last["change"]["observed"], want_observed, "{point}");
    assert_eq!(last["change"]["mutation"], want_mutation, "{point}");
    // No `verified`/`applied-by-recovery` is ever invented.
    assert!(!w.phases().iter().any(|p| p == "verified"));
    let target = if replace { "a.txt" } else { "created.txt" };
    match want_disk {
        "ORIG" => assert_eq!(
            w.disk(target).unwrap_or_default(),
            if replace { "orig\n" } else { "" }
        ),
        "NEW" => assert_eq!(w.disk(target).unwrap(), "NEW\n"),
        _ => unreachable!(),
    }
    assert_eq!(w.tmp_files(), 0, "abandoned temp must be cleaned: {point}");
    // Replay of the same request is refused; nothing changes.
    let again = raw_request(&w.d.socket, &authed_frame(&w.cap, "tool-execute", p)).unwrap();
    assert_eq!(again["ok"], false, "{rid}");
    // The system is usable afterwards.
    let r = w.exec("fs.read", json!({"path": target}));
    assert_ok(&r);
    terminate(&mut c);
}

#[test]
fn sigkill_after_planned_leaves_target_untouched() {
    crash_case("after-planned", true, "pre-image-intact", "none", "ORIG");
}

#[test]
fn sigkill_after_prepared_cleans_the_temp_and_leaves_target_untouched() {
    crash_case("after-prepared", true, "pre-image-intact", "none", "ORIG");
}

#[test]
fn sigkill_after_rename_before_applied_record_is_observed_not_replayed() {
    crash_case(
        "after-rename",
        true,
        "post-image-present",
        "applied-unverified",
        "NEW",
    );
}

#[test]
fn sigkill_after_applied_record_before_verification_is_interrupted() {
    crash_case(
        "after-applied",
        true,
        "post-image-present",
        "applied-unverified",
        "NEW",
    );
}

#[test]
fn sigkill_immediately_after_exchange_removes_only_the_verified_displaced_original() {
    // name == post-image, temp name == displaced original (== expected
    // pre-image): recovery may dispose of it, and says what it saw.
    crash_case(
        "after-exchange",
        true,
        "post-image-present",
        "applied-unverified",
        "NEW",
    );
}

#[test]
fn nonindependent_approval_is_test_only_and_labelled_everywhere() {
    // Without the explicit test-only flag the daemon refuses to enable
    // writes when approver UIDs overlap issuer UIDs.
    let dir = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let uid = euid().to_string();
    let out = Command::new(nexusd_bin())
        .arg("--db")
        .arg(dir.path().join("k.db"))
        .arg("--socket")
        .arg(dir.path().join("s.sock"))
        .arg("--cap")
        .arg(dir.path().join("c.cap"))
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--enable-writes")
        .arg("--allowed-uids")
        .arg(&uid)
        .arg("--approver-uids")
        .arg(&uid)
        .arg("--approver-cap")
        .arg(dir.path().join("a.cap"))
        .arg("--workspace-bases")
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(!out.status.success());
    let text =
        String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("not independent"), "{text}");
    // With the flag (isolated test setups) everything is labelled.
    let mut w = setup("testonly");
    let r = w.exec(
        "fs.write",
        json!({"path": "t.txt", "content": "x\n", "mode": "create"}),
    );
    assert_ok(&r);
    assert_eq!(r["execution"]["approverIndependent"], false);
    assert_eq!(r["execution"]["testOnlyApproval"], true);
    let ev = w.events();
    let authorized = ev.iter().find(|e| e["phase"] == "authorized").unwrap();
    assert_eq!(authorized["change"]["approverIndependent"], false);
}

#[test]
fn sigkill_during_create_publication_is_classified() {
    crash_case(
        "after-rename",
        false,
        "post-image-present",
        "applied-unverified",
        "NEW",
    );
    crash_case("after-prepared", false, "pre-image-intact", "none", "ORIG");
}
