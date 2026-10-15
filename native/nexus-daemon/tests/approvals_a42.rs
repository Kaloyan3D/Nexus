//! A4.2 human-approval integration over the real nexusd IPC boundary.
//!
//! IMPORTANT: this file runs single-UID, so the approver is configured with
//! `--allow-nonindependent-approver-test-only`. These tests prove the
//! backend state machine, binding and fail-closed behaviour. They do NOT
//! prove human presence or OS-level identity separation: the multi-UID
//! suite (`multuid.rs`) does that. Decisions here are driven by the test
//! harness and must never be read as genuine human confirmation.

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

struct A {
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

fn daemon_args(basep: &std::path::Path, acap: &std::path::Path) -> Vec<String> {
    daemon_args_with(basep, acap, false)
}

fn daemon_args_with(basep: &std::path::Path, acap: &std::path::Path, process: bool) -> Vec<String> {
    let uid = euid().to_string();
    let mut v = vec![
        "--workspace-bases".into(),
        basep.to_str().unwrap().into(),
        "--allowed-uids".into(),
        uid.clone(),
        "--enable-writes".into(),
        "--approver-cap".into(),
        acap.to_str().unwrap().into(),
        "--approver-uids".into(),
        uid,
        "--allow-nonindependent-approver-test-only".into(),
        "--require-human-approval".into(),
    ];
    if process {
        v.push("--enable-process".into());
    }
    v
}

fn setup(tag: &str) -> A {
    setup_with(tag, false)
}

fn setup_with(tag: &str, process: bool) -> A {
    use std::os::unix::fs::PermissionsExt;
    let base = tempfile::tempdir().unwrap();
    let basep = std::fs::canonicalize(base.path()).unwrap();
    let ws = basep.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let acap_dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(acap_dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let approver_cap_path = acap_dir.path().join("approver.cap");
    let args = daemon_args_with(&basep, &approver_cap_path, process);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let d = spawn_daemon_env("shadow-test", true, &refs, &[]);
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
    let a = A {
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
    assert_ok(&a.issuer(
        "workspace-bind",
        json!({"commandId": a.command, "root": a.ws.to_str().unwrap()}),
    ));
    a
}

impl Drop for A {
    fn drop(&mut self) {
        let _ = self.d.child.kill();
        let _ = self.d.child.wait();
    }
}

impl A {
    fn issuer(&self, cmd: &str, params: Value) -> Value {
        raw_request(&self.d.socket, &authed_frame(&self.cap, cmd, params)).unwrap()
    }
    fn approver(&self, cmd: &str, params: Value) -> Value {
        raw_request(
            &self.d.socket,
            &authed_frame(&self.approver_cap, cmd, params),
        )
        .unwrap()
    }
    fn params(&mut self, tool: &str, args: Value) -> Value {
        self.n += 1;
        json!({
            "requestId": format!("a-{}-{}", self.command, self.n),
            "cancellationId": format!("ac-{}-{}", self.command, self.n),
            "taskInstanceId": self.task, "attemptId": self.attempt, "commandId": self.command,
            "leaseEpoch": self.epoch, "storeIncarnation": self.inc,
            "toolId": tool, "toolVersion": 1, "args": args,
        })
    }
    fn exec(&mut self, tool: &str, args: Value) -> Value {
        let p = self.params(tool, args);
        self.issuer("tool-execute", p)
    }
    fn request(&mut self, tool: &str, args: Value) -> Value {
        let p = self.params(tool, args);
        self.issuer("approval-request", p)
    }
    fn request_with(&mut self, tool: &str, args: Value, extra: Value) -> Value {
        let mut p = self.params(tool, args);
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        self.issuer("approval-request", p)
    }
    fn write(&self, rel: &str, c: &str) {
        let p = self.ws.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, c).unwrap();
    }
    fn disk(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.ws.join(rel)).ok()
    }
    fn get(&self, id: &str) -> Value {
        self.approver("approval-get", json!({ "approvalId": id }))
    }
    fn decide_raw(&self, id: &str, digest: &str, code: &str, decision: &str) -> Value {
        self.approver(
            "approval-decide",
            json!({"approvalId": id, "requestDigest": digest, "decision": decision,
                   "reviewCode": code, "reason": "test", "confirmation": {"tty": false}}),
        )
    }
    /// request -> review -> approve. Returns approval id.
    fn approved(&mut self, tool: &str, args: Value) -> String {
        let r = self.request(tool, args);
        assert_ok(&r);
        let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
        let g = self.get(&id);
        assert_ok(&g);
        let a = &g["approval"];
        let d = self.decide_raw(
            &id,
            a["requestDigest"].as_str().unwrap(),
            a["reviewCode"].as_str().unwrap(),
            "approve",
        );
        assert_ok(&d);
        assert_eq!(d["approval"]["state"], "approved");
        id
    }
    fn list(&self) -> Vec<Value> {
        let r = raw_request(
            &self.d.socket,
            &json!({"protocol":1,"id":next_id("al"),"cmd":"approval-list","params":{}}).to_string(),
        )
        .unwrap();
        assert_ok(&r);
        r["approvals"].as_array().cloned().unwrap_or_default()
    }
    fn state_of(&self, id: &str) -> String {
        self.list()
            .iter()
            .find(|a| a["approvalId"] == id)
            .map(|a| a["state"].as_str().unwrap().to_owned())
            .unwrap_or_default()
    }
}

fn write_args(path: &str, content: &str, pre: &str) -> Value {
    json!({"path": path, "content": content, "mode": "replace", "expectedSha256": sha(pre)})
}

fn respawn(a: &A) -> std::process::Child {
    let basep = std::fs::canonicalize(a.base.path()).unwrap();
    let args = daemon_args(&basep, &a.approver_cap_path);
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&a.d.db)
        .arg("--socket")
        .arg(&a.d.socket)
        .arg("--cap")
        .arg(&a.d.cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&a.d.witness)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    common::die_with_test(&mut cmd);
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(r) = raw_request(
            &a.d.socket,
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

// ------------------------------------------------------------- happy path

#[test]
fn approved_write_executes_once_and_matches_the_reviewed_diff() {
    let mut a = setup("happy");
    a.write("a.txt", "one\ntwo\n");
    let args = write_args("a.txt", "one\nTWO\nthree\n", "one\ntwo\n");
    // Without any approval: refused, nothing written.
    assert_refused(&a.exec("fs.write", args.clone()), "scope-refused");
    assert_eq!(a.disk("a.txt").unwrap(), "one\ntwo\n");
    let r = a.request("fs.write", args.clone());
    assert_ok(&r);
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    assert_eq!(r["approval"]["state"], "pending");
    // The list never carries review content or the review code.
    let listed = serde_json::to_string(&a.list()).unwrap();
    assert!(
        !listed.contains("TWO") && !listed.contains("reviewCode"),
        "{listed}"
    );
    let g = a.get(&id);
    assert_ok(&g);
    let req = &g["approval"]["request"];
    assert_eq!(req["schemaVersion"], 1);
    assert_eq!(req["paths"], json!(["a.txt"]));
    assert_eq!(req["operation"]["preImageSha256"], sha("one\ntwo\n"));
    assert_eq!(
        req["operation"]["postImageSha256"],
        sha("one\nTWO\nthree\n")
    );
    assert_eq!(req["preview"]["kind"], "unified-diff");
    let diff = req["preview"]["text"].as_str().unwrap();
    assert!(diff.contains("-two\n") && diff.contains("+TWO\n") && diff.contains("+three\n"));
    // Pending approval does not authorize execution.
    assert_refused(&a.exec("fs.write", args.clone()), "scope-refused");
    let d = a.decide_raw(
        &id,
        g["approval"]["requestDigest"].as_str().unwrap(),
        g["approval"]["reviewCode"].as_str().unwrap(),
        "approve",
    );
    assert_ok(&d);
    let r = a.exec("fs.write", args.clone());
    assert_ok(&r);
    assert_eq!(a.disk("a.txt").unwrap(), "one\nTWO\nthree\n");
    assert_eq!(
        sha(&a.disk("a.txt").unwrap()),
        req["operation"]["postImageSha256"]
    );
    assert_eq!(a.state_of(&id), "consumed");
    // Single-use: the same operation cannot run again under the same approval.
    a.write("a.txt", "one\ntwo\n");
    let r = a.exec("fs.write", args);
    assert_refused(&r, "scope-refused");
    assert_eq!(a.disk("a.txt").unwrap(), "one\ntwo\n");
}

// ---------------------------------------------------- 1,2: forged / issuer

#[test]
fn forged_and_issuer_generated_approvals_are_refused() {
    let mut a = setup("forge");
    a.write("a.txt", "x\n");
    let args = write_args("a.txt", "y\n", "x\n");
    let r = a.request("fs.write", args.clone());
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let digest = r["approval"]["requestDigest"].as_str().unwrap().to_owned();
    // Issuer credential cannot read the review or decide.
    assert_refused(
        &a.issuer("approval-get", json!({"approvalId": id})),
        "issuer-untrusted",
    );
    assert_refused(
        &a.issuer(
            "approval-decide",
            json!({"approvalId": id, "requestDigest": digest, "decision": "approve",
                   "reviewCode": "00000000", "confirmation": {"tty": true}}),
        ),
        "issuer-untrusted",
    );
    // Approver credential, but never reviewed: refused (no blind approval).
    let r = a.decide_raw(&id, &digest, "00000000", "approve");
    assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
    assert!(
        r["message"].as_str().unwrap().contains("not reviewed"),
        "{r}"
    );
    // Reviewed, but a guessed review code: refused.
    let g = a.get(&id);
    assert_ok(&g);
    let real = g["approval"]["reviewCode"].as_str().unwrap();
    let wrong = if real == "deadbeef" {
        "cafebabe"
    } else {
        "deadbeef"
    };
    let r = a.decide_raw(&id, &digest, wrong, "approve");
    assert!(
        r["message"].as_str().unwrap().contains("review code"),
        "{r}"
    );
    // Reviewed, right code, forged digest: refused.
    let r = a.decide_raw(&id, &"0".repeat(64), real, "approve");
    assert_eq!(code_of(&r), "binding-mismatch", "{r}");
    // Legacy scope approval is closed in human mode, even for the approver.
    let r = a.approver(
        "write-scope-approve",
        json!({"commandId": a.command, "workspaceRootDigest": a.root_digest, "maxWriteBytes": 99}),
    );
    assert_refused(&r, "approval-required");
    // Nothing executed throughout.
    assert_refused(&a.exec("fs.write", args), "scope-refused");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
    assert_eq!(a.state_of(&id), "pending");
}

// ------------------------------------------- 6,7,17: changed path/args/budget

#[test]
fn any_change_to_path_content_or_budget_after_approval_is_refused() {
    let mut a = setup("mutate");
    a.write("a.txt", "x\n");
    a.write("b.txt", "x\n");
    let args = write_args("a.txt", "approved\n", "x\n");
    let id = a.approved("fs.write", args.clone());
    // Different path.
    let r = a.exec("fs.write", write_args("b.txt", "approved\n", "x\n"));
    assert_refused(&r, "scope-refused");
    // Different content.
    let r = a.exec("fs.write", write_args("a.txt", "approved!\n", "x\n"));
    assert_refused(&r, "scope-refused");
    // Different budget.
    let mut p = a.params("fs.write", args.clone());
    p["budgets"] = json!({"maxWriteBytes": 5});
    assert_refused(&a.issuer("tool-execute", p), "scope-refused");
    // Different tool (edit) on the same file.
    let r = a.exec(
        "fs.edit",
        json!({"path": "a.txt", "expectedSha256": sha("x\n"),
               "edits": [{"oldText": "x", "newText": "approved"}]}),
    );
    assert_refused(&r, "scope-refused");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
    assert_eq!(a.disk("b.txt").unwrap(), "x\n");
    // The approval is still intact and usable for the exact operation.
    assert_eq!(a.state_of(&id), "approved");
    assert_ok(&a.exec("fs.write", args));
    assert_eq!(a.disk("a.txt").unwrap(), "approved\n");
}

// ----------------------------------- 4,5: another task / another workspace

#[test]
fn approval_does_not_transfer_to_another_task_or_workspace() {
    let mut a = setup("xfer");
    a.write("a.txt", "x\n");
    let args = write_args("a.txt", "y\n", "x\n");
    let _ = a.approved("fs.write", args.clone());
    // A second accepted command in a different task bound to another
    // workspace root.
    let base = std::fs::canonicalize(a.base.path()).unwrap();
    let ws2 = base.join("ws2");
    std::fs::create_dir_all(&ws2).unwrap();
    std::fs::write(ws2.join("a.txt"), "x\n").unwrap();
    let (t2, at2, c2) = ("task-xfer2", "attempt-xfer2", "cmd-xfer2");
    let rec = accept_one_ws(
        &a.d.socket,
        &a.cap,
        t2,
        at2,
        c2,
        &sha(ws2.to_str().unwrap()),
    );
    let r2 = rec.get("receipt").unwrap();
    assert_ok(&a.issuer(
        "workspace-bind",
        json!({"commandId": c2, "root": ws2.to_str().unwrap()}),
    ));
    let p2 = json!({
        "requestId": "x-1", "cancellationId": "xc-1",
        "taskInstanceId": t2, "attemptId": at2, "commandId": c2,
        "leaseEpoch": r2["leaseEpoch"], "storeIncarnation": r2["storeIncarnation"],
        "toolId": "fs.write", "toolVersion": 1, "args": args,
    });
    // Same exact args digest, different task/command/workspace: refused.
    assert_refused(&a.issuer("tool-execute", p2.clone()), "scope-refused");
    assert_eq!(std::fs::read_to_string(ws2.join("a.txt")).unwrap(), "x\n");
    // And the other command's own approval request cannot be decided with
    // the first command's digest.
    let r = a.issuer("approval-request", p2);
    assert_ok(&r);
    assert_ne!(
        r["approval"]["workspaceRootDigest"],
        json!(a.root_digest),
        "approval carries the other workspace identity"
    );
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
}

// ------------------------------------------ 8: duplicates; denial is final

#[test]
fn duplicate_requests_and_decisions_are_refused_and_denial_is_final() {
    let mut a = setup("dup");
    a.write("a.txt", "x\n");
    let args = write_args("a.txt", "y\n", "x\n");
    let r = a.request("fs.write", args.clone());
    assert_ok(&r);
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    // Duplicate open request for the exact same operation.
    let r2 = a.request("fs.write", args.clone());
    assert!(!r2["ok"].as_bool().unwrap_or(false), "{r2}");
    let g = a.get(&id);
    let (digest, code) = (
        g["approval"]["requestDigest"].as_str().unwrap().to_owned(),
        g["approval"]["reviewCode"].as_str().unwrap().to_owned(),
    );
    assert_ok(&a.decide_raw(&id, &digest, &code, "deny"));
    assert_eq!(a.state_of(&id), "denied");
    // Denial is final: neither approve nor a second deny is accepted.
    for d in ["approve", "deny"] {
        let r = a.decide_raw(&id, &digest, &code, d);
        assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
        assert!(
            r["message"].as_str().unwrap().contains("not pending"),
            "{r}"
        );
    }
    assert_eq!(a.state_of(&id), "denied");
    assert_refused(&a.exec("fs.write", args), "scope-refused");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
}

// --------------------------------------------------------------- 9: expiry

#[test]
fn expired_approvals_cannot_be_decided_or_consumed() {
    let mut a = setup("exp");
    a.write("a.txt", "x\n");
    let args = write_args("a.txt", "y\n", "x\n");
    // Pending that expires before the decision.
    let r = a.request_with("fs.write", args.clone(), json!({"ttlMs": 1000}));
    assert_ok(&r);
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = a.get(&id);
    std::thread::sleep(Duration::from_millis(1300));
    let r = a.decide_raw(
        &id,
        g["approval"]["requestDigest"].as_str().unwrap(),
        g["approval"]["reviewCode"].as_str().unwrap(),
        "approve",
    );
    assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
    assert_eq!(a.state_of(&id), "expired");
    // Approved that expires before execution.
    let r = a.request_with("fs.write", args.clone(), json!({"ttlMs": 1000}));
    let id2 = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = a.get(&id2);
    assert_ok(&a.decide_raw(
        &id2,
        g["approval"]["requestDigest"].as_str().unwrap(),
        g["approval"]["reviewCode"].as_str().unwrap(),
        "approve",
    ));
    std::thread::sleep(Duration::from_millis(1300));
    assert_refused(&a.exec("fs.write", args), "scope-refused");
    assert_eq!(a.state_of(&id2), "expired");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
}

// ------------------------------------------------- 10, 11: revoke / stale

#[test]
fn revocation_and_new_generation_invalidate_unused_approvals() {
    let mut a = setup("rev");
    a.write("a.txt", "x\n");
    let args = write_args("a.txt", "y\n", "x\n");
    // Issuer withdraws one approval.
    let id = a.approved("fs.write", args.clone());
    let r = a.issuer(
        "approval-revoke",
        json!({"approvalId": id, "reason": "changed mind"}),
    );
    assert_ok(&r);
    assert_eq!(a.state_of(&id), "revoked");
    assert_refused(&a.exec("fs.write", args.clone()), "scope-refused");
    // Command-level tool revocation revokes every open approval.
    a.write("b.txt", "x\n");
    let args_b = write_args("b.txt", "y\n", "x\n");
    let id2 = a.approved("fs.write", args_b.clone());
    assert_ok(&a.issuer(
        "tool-revoke",
        json!({"commandId": a.command, "reason": "stop"}),
    ));
    assert_eq!(a.state_of(&id2), "revoked");
    let r = a.exec("fs.write", args_b);
    assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
    assert_eq!(a.disk("b.txt").unwrap(), "x\n");
}

#[test]
fn a_new_attempt_generation_revokes_pending_and_approved_requests() {
    let mut a = setup("gen");
    a.write("a.txt", "x\n");
    let args = write_args("a.txt", "y\n", "x\n");
    let approved = a.approved("fs.write", args.clone());
    let pending = {
        a.write("b.txt", "x\n");
        let r = a.request("fs.write", write_args("b.txt", "y\n", "x\n"));
        r["approval"]["approvalId"].as_str().unwrap().to_owned()
    };
    // A new lease generation for the same task supersedes the old one.
    let r = a.issuer(
        "acquire",
        json!({"taskInstanceId": a.task, "backend": "native"}),
    );
    assert_ok(&r);
    // Stale generation: the old approval can never authorize execution.
    let r = a.exec("fs.write", args);
    assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
    // Pending is revoked on first contact with the stale generation.
    let g = a.get(&pending);
    assert!(!g["ok"].as_bool().unwrap_or(false), "{g}");
    assert_eq!(a.state_of(&pending), "revoked");
    assert_eq!(a.state_of(&approved), "revoked");
}

// ------------------------------------------- 12, 13: restart / crash recovery

#[test]
fn restart_never_fabricates_or_preserves_consent() {
    let mut a = setup("restart");
    a.write("a.txt", "x\n");
    a.write("b.txt", "x\n");
    let args_a = write_args("a.txt", "y\n", "x\n");
    let args_b = write_args("b.txt", "y\n", "x\n");
    // (12) review armed, then the daemon dies before the decision.
    let r = a.request("fs.write", args_b.clone());
    let pend = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = a.get(&pend);
    let (pd, pc) = (
        g["approval"]["requestDigest"].as_str().unwrap().to_owned(),
        g["approval"]["reviewCode"].as_str().unwrap().to_owned(),
    );
    // (13) approved but not yet executed.
    let approved = a.approved("fs.write", args_a.clone());
    crash(&mut a.d.child);
    a.d.child = respawn(&a);
    a.approver_cap = read_cap(&a.approver_cap_path);
    a.cap = read_cap(&a.d.cap);
    // Approved-but-unconsumed approvals lapse on restart.
    assert_eq!(a.state_of(&approved), "expired");
    let r = a.exec("fs.write", args_a);
    assert_refused(&r, "scope-refused");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
    // Pending survives but must be re-reviewed: the stale review is void.
    assert_eq!(a.state_of(&pend), "pending");
    let r = a.decide_raw(&pend, &pd, &pc, "approve");
    assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
    assert!(
        r["message"].as_str().unwrap().contains("not reviewed"),
        "{r}"
    );
    let g = a.get(&pend);
    assert_ok(&g);
    assert_ok(&a.decide_raw(
        &pend,
        g["approval"]["requestDigest"].as_str().unwrap(),
        g["approval"]["reviewCode"].as_str().unwrap(),
        "approve",
    ));
    assert_ok(&a.exec("fs.write", args_b));
    assert_eq!(a.disk("b.txt").unwrap(), "y\n");
}

// ------------------------------------------------------ 14: concurrent decisions

#[test]
fn concurrent_decisions_have_exactly_one_winner() {
    let mut a = setup("conc");
    a.write("a.txt", "x\n");
    let r = a.request("fs.write", write_args("a.txt", "y\n", "x\n"));
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = a.get(&id);
    let digest = g["approval"]["requestDigest"].as_str().unwrap().to_owned();
    let code = g["approval"]["reviewCode"].as_str().unwrap().to_owned();
    let socket = a.d.socket.clone();
    let cap = a.approver_cap.clone();
    let mut handles = Vec::new();
    for i in 0..8 {
        let (socket, cap, id, digest, code) = (
            socket.clone(),
            cap.clone(),
            id.clone(),
            digest.clone(),
            code.clone(),
        );
        handles.push(std::thread::spawn(move || {
            let decision = if i % 2 == 0 { "approve" } else { "deny" };
            let r = raw_request(
                &socket,
                &authed_frame(
                    &cap,
                    "approval-decide",
                    json!({"approvalId": id, "requestDigest": digest, "decision": decision,
                           "reviewCode": code, "confirmation": {"tty": false}}),
                ),
            )
            .unwrap();
            (r["ok"].as_bool().unwrap_or(false), decision)
        }));
    }
    let results: Vec<(bool, &str)> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let wins: Vec<_> = results.iter().filter(|(ok, _)| *ok).collect();
    assert_eq!(wins.len(), 1, "exactly one decision may win: {results:?}");
    let want = if wins[0].1 == "approve" {
        "approved"
    } else {
        "denied"
    };
    assert_eq!(a.state_of(&id), want);
}

// ---------------------------------------------- 16, 18: history / diagnostics

#[test]
fn audit_trail_is_complete_and_leaks_no_secrets() {
    let mut a = setup("audit");
    a.write("a.txt", "TOPSECRET-before\n");
    let args = write_args("a.txt", "TOPSECRET-after\n", "TOPSECRET-before\n");
    let id = a.approved("fs.write", args.clone());
    assert_ok(&a.exec("fs.write", args));
    let r = raw_request(
        &a.d.socket,
        &json!({"protocol":1,"id":next_id("h"),"cmd":"approval-list",
                "params":{"approvalId": id}})
        .to_string(),
    )
    .unwrap();
    assert_ok(&r);
    let events: Vec<&str> = r["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(
        events,
        vec![
            "requested",
            "pending",
            "reviewed",
            "review-armed",
            "approved",
            "consumed"
        ]
    );
    let all = r.to_string();
    // No content, key material or review code in the history surface.
    assert!(!all.contains("TOPSECRET"), "content leaked: {all}");
    assert!(!all.contains(&a.cap) && !all.contains(&a.approver_cap));
    assert!(!all.contains("reviewCode"));
    let approved_ev = r["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["event"] == "approved")
        .unwrap();
    let ha = &approved_ev["payload"]["humanAuth"];
    assert_eq!(ha["mechanism"], "approver-uid-terminal-review-code");
    // Honest labelling: human presence is explicitly NOT verified.
    assert!(ha["notVerified"]
        .as_array()
        .unwrap()
        .contains(&json!("human-presence")));
    assert_eq!(approved_ev["payload"]["independent"], false); // test-only topology
    assert_eq!(r["approval"]["state"], "consumed");
    assert!(r["approval"]["grantRequestId"].as_str().is_some());
}

#[test]
fn reads_need_no_approval_and_processes_cannot_bypass_the_gate() {
    let mut a = setup("reads");
    a.write("a.txt", "x\n");
    // Read tools are unaffected by human approval mode.
    assert_ok(&a.exec("fs.read", json!({"path": "a.txt"})));
    // A read cannot be wrapped in an approval.
    let r = a.request("fs.read", json!({"path": "a.txt"}));
    assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
    // Processes are not enabled here; approval for them is refused.
    let r = a.request("proc.run", json!({"program": "cargo", "args": ["check"]}));
    assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
    // Replay of a signed approver frame is rejected.
    let r = a.request("fs.write", write_args("a.txt", "y\n", "x\n"));
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let frame = authed_frame(&a.approver_cap, "approval-get", json!({"approvalId": id}));
    assert_ok(&raw_request(&a.d.socket, &frame).unwrap());
    let again = raw_request(&a.d.socket, &frame).unwrap();
    assert_refused(&again, "replay-rejected");
}

// ------------------------------------------------ process approvals (sandbox)

#[test]
fn process_approval_binds_exact_argv_and_budget_and_is_single_use() {
    let c = nexus_tools::sandbox::preflight();
    let tc = nexus_tools::process::Toolchain::discover();
    if !c.available || tc.cargo_home_bin.is_none() || tc.rustup_home.is_none() {
        println!(
            "NOT RUN: sandbox or cargo toolchain unavailable: {:?}",
            c.problems
        );
        return;
    }
    let mut a = setup_with("proc", true);
    a.write(
        "Cargo.toml",
        "[package]\nname = \"p\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    );
    a.write("src/lib.rs", "pub fn f() {}\n");
    let args = json!({"program": "cargo", "args": ["check", "--offline"], "cwd": "."});
    // No approval: refused, no execution.
    assert_refused(&a.exec("proc.run", args.clone()), "scope-refused");
    let r = a.request("proc.run", args.clone());
    assert_ok(&r);
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    assert_eq!(r["approval"]["scope"], "process");
    // Writes cannot be approved by a process approval and vice versa: the
    // write tool has no scope here.
    let g = a.get(&id);
    assert_ok(&g);
    let op = &g["approval"]["request"]["operation"];
    assert_eq!(op["kind"], "proc.run");
    assert_eq!(op["program"], "cargo");
    assert_eq!(op["argv"], json!(["check", "--offline"]));
    assert_eq!(op["sandbox"]["network"], "none");
    assert_eq!(op["sandbox"]["writeBack"], "none");
    assert!(
        g["approval"]["request"]["limits"]["procWallMs"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_ok(&a.decide_raw(
        &id,
        g["approval"]["requestDigest"].as_str().unwrap(),
        g["approval"]["reviewCode"].as_str().unwrap(),
        "approve",
    ));
    // Different argv / subcommand / budget: refused with no execution.
    assert_refused(
        &a.exec(
            "proc.run",
            json!({"program": "cargo", "args": ["build", "--offline"], "cwd": "."}),
        ),
        "scope-refused",
    );
    let mut p = a.params("proc.run", args.clone());
    p["budgets"] = json!({"procWallMs": 5000});
    assert_refused(&a.issuer("tool-execute", p), "scope-refused");
    assert_eq!(a.state_of(&id), "approved");
    // Exact operation: the approval is consumed by the execution attempt
    // (its outcome is the executor's business, covered by A3.4 tests).
    let _ = a.exec("proc.run", args.clone());
    assert_eq!(a.state_of(&id), "consumed");
    assert_refused(&a.exec("proc.run", args), "scope-refused");
}

// ------------------------------------------------ no silent downgrade (P0)

fn daemon_cmd(a: &A, args: &[String]) -> Command {
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&a.d.db)
        .arg("--socket")
        .arg(&a.d.socket)
        .arg("--cap")
        .arg(&a.d.cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&a.d.witness)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    common::die_with_test(&mut cmd);
    cmd
}

#[test]
fn restart_without_human_approval_cannot_enable_writes_or_processes() {
    let mut a = setup("down");
    a.write("a.txt", "x\n");
    let args = write_args("a.txt", "y\n", "x\n");
    let _approved = a.approved("fs.write", args.clone());
    // Daemon stops; a launcher restarts it WITHOUT the human-approval flag,
    // trying every legacy path to re-enable writes/processes.
    crash(&mut a.d.child);
    let _ = std::fs::remove_file(&a.d.socket); // SIGKILL leaves the node
    let basep = std::fs::canonicalize(a.base.path()).unwrap();
    let uid = euid().to_string();
    let base_flags: Vec<String> = vec![
        "--workspace-bases".into(),
        basep.to_str().unwrap().into(),
        "--allowed-uids".into(),
        uid.clone(),
        "--approver-cap".into(),
        a.approver_cap_path.to_str().unwrap().into(),
        "--approver-uids".into(),
        uid,
        "--allow-nonindependent-approver-test-only".into(),
    ];
    for extra in [
        vec!["--enable-writes"],
        vec!["--enable-process"],
        vec!["--enable-writes", "--enable-process"],
    ] {
        let mut v = base_flags.clone();
        v.extend(extra.iter().map(|s| s.to_string()));
        let out = daemon_cmd(&a, &v).output().unwrap();
        assert!(!out.status.success(), "downgrade must not start: {extra:?}");
        let text = String::from_utf8_lossy(&out.stderr);
        assert!(text.contains("approval-downgrade-refused"), "{text}");
        assert!(!a.d.socket.exists(), "no socket may be left bound");
    }
    // Read-only service remains available without any mutation authority.
    let mut ro = daemon_cmd(&a, &[]).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while raw_request(
        &a.d.socket,
        r#"{"protocol":1,"id":"p","cmd":"health","params":{}}"#,
    )
    .map(|r| r["ok"] != true)
    .unwrap_or(true)
    {
        assert!(Instant::now() < deadline, "read-only daemon did not start");
        std::thread::sleep(Duration::from_millis(25));
    }
    let cap = read_cap(&a.d.cap);
    // Legacy approver commands and tool writes do nothing here.
    let r = raw_request(
        &a.d.socket,
        &authed_frame(
            &cap,
            "tool-execute",
            json!({"requestId":"ro-1","cancellationId":"roc-1","taskInstanceId":a.task,
                   "attemptId":a.attempt,"commandId":a.command,"leaseEpoch":a.epoch,
                   "storeIncarnation":a.inc,"toolId":"fs.write","toolVersion":1,"args":args}),
        ),
    )
    .unwrap();
    assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
    let _ = ro.kill();
    let _ = ro.wait();
    // The human-approval deployment itself still restarts normally.
    a.d.child = respawn(&a);
}

#[test]
fn previously_approved_request_cannot_execute_through_another_path() {
    let mut a = setup("path");
    a.write("a.txt", "x\n");
    let args = write_args("a.txt", "y\n", "x\n");
    let id = a.approved("fs.write", args.clone());
    // The approver key cannot execute; the legacy scope path is closed.
    let p = a.params("fs.write", args.clone());
    assert_refused(
        &raw_request(
            &a.d.socket,
            &authed_frame(&a.approver_cap, "tool-execute", p),
        )
        .unwrap(),
        "issuer-untrusted",
    );
    let r = a.approver(
        "write-scope-approve",
        json!({"commandId": a.command, "workspaceRootDigest": a.root_digest, "maxWriteBytes": 1 << 20}),
    );
    assert_refused(&r, "approval-required");
    let r = a.approver(
        "process-scope-approve",
        json!({"commandId": a.command, "workspaceRootDigest": a.root_digest, "maxWallMs": 1000}),
    );
    assert!(!r["ok"].as_bool().unwrap_or(false), "{r}");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
    // Daemon restart without the flag (writes on) is refused, so the
    // coarse scope bound by the approval can never be used unapproved.
    crash(&mut a.d.child);
    let basep = std::fs::canonicalize(a.base.path()).unwrap();
    let uid = euid().to_string();
    let out = daemon_cmd(
        &a,
        &[
            "--workspace-bases".into(),
            basep.to_str().unwrap().into(),
            "--allowed-uids".into(),
            uid.clone(),
            "--enable-writes".into(),
            "--approver-cap".into(),
            a.approver_cap_path.to_str().unwrap().into(),
            "--approver-uids".into(),
            uid,
            "--allow-nonindependent-approver-test-only".into(),
        ],
    )
    .output()
    .unwrap();
    assert!(!out.status.success());
    a.d.child = respawn(&a);
    assert_eq!(a.state_of(&id), "expired");
    assert_eq!(a.disk("a.txt").unwrap(), "x\n");
}

#[test]
fn human_mode_with_incomplete_configuration_refuses_to_start() {
    let a = setup("cfg");
    let mut a = a;
    crash(&mut a.d.child);
    let basep = std::fs::canonicalize(a.base.path()).unwrap();
    let uid = euid().to_string();
    // Human approval requested but no write/process class to govern.
    let out = daemon_cmd(
        &a,
        &[
            "--require-human-approval".into(),
            "--allowed-uids".into(),
            uid.clone(),
        ],
    )
    .output()
    .unwrap();
    assert!(!out.status.success());
    // Human approval without any independence declaration (neither
    // --require-independent-approver nor the explicit test-only flag).
    let out = daemon_cmd(
        &a,
        &[
            "--workspace-bases".into(),
            basep.to_str().unwrap().into(),
            "--allowed-uids".into(),
            uid.clone(),
            "--enable-writes".into(),
            "--approver-cap".into(),
            a.approver_cap_path.to_str().unwrap().into(),
            "--approver-uids".into(),
            uid.clone(),
            "--require-human-approval".into(),
        ],
    )
    .output()
    .unwrap();
    assert!(!out.status.success());
    // Missing approver configuration must not enable writes.
    let out = daemon_cmd(
        &a,
        &[
            "--workspace-bases".into(),
            basep.to_str().unwrap().into(),
            "--allowed-uids".into(),
            uid,
            "--enable-writes".into(),
            "--require-human-approval".into(),
            "--allow-nonindependent-approver-test-only".into(),
        ],
    )
    .output()
    .unwrap();
    assert!(!out.status.success());
    assert!(!a.d.socket.exists());
}
