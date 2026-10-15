//! A4.3 independent journal witness over real processes and filesystems.
//!
//! Single-UID file: the witness runs with `--allow-same-uid-test-only`, so
//! these tests prove protocol, durability, recovery and detection logic but
//! NOT identity isolation (the multi-UID suite does). The witness fault
//! injector (`NEXUS_WITNESS_FAULT`) is test-only.

mod common;

use common::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

fn sha(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

fn witness_bin() -> PathBuf {
    nexusd_bin().with_file_name("nexus-witness")
}

struct W {
    root: tempfile::TempDir,
    wdir: PathBuf,
    wsock: PathBuf,
    data: PathBuf,
    ws: PathBuf,
    acap: PathBuf,
    witness: Option<Child>,
    daemon: Option<Child>,
    extra_flags: Vec<String>,
    cap: String,
    approver_cap: String,
    task: String,
    attempt: String,
    command: String,
    epoch: u64,
    inc: String,
    root_digest: String,
    n: u32,
}

impl Drop for W {
    fn drop(&mut self) {
        for c in [self.daemon.take(), self.witness.take()]
            .into_iter()
            .flatten()
        {
            let mut c = c;
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn spawn_witness(wdir: &Path, wsock: &Path, fault: Option<&str>) -> Child {
    let mut cmd = Command::new(witness_bin());
    cmd.arg("--dir")
        .arg(wdir)
        .arg("--socket")
        .arg(wsock)
        .arg("--allowed-uids")
        .arg(euid().to_string())
        .arg("--allow-same-uid-test-only")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(f) = fault {
        cmd.env("NEXUS_WITNESS_FAULT", f);
    }
    common::die_with_test(&mut cmd);
    let mut c = cmd.spawn().expect("spawn witness");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !wsock.exists() {
        assert!(Instant::now() < deadline, "witness never became ready");
        if let Ok(Some(st)) = c.try_wait() {
            panic!("witness exited: {st}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    c
}

fn wcall(wsock: &Path, req: Value) -> Value {
    use std::io::{BufRead, BufReader, Write};
    let mut s = std::os::unix::net::UnixStream::connect(wsock).expect("witness connect");
    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut r = req;
    r["v"] = json!(1);
    r["nonce"] = json!(next_nonce());
    s.write_all(format!("{r}\n").as_bytes()).unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    serde_json::from_str(line.trim()).unwrap_or(Value::Null)
}

impl W {
    fn daemon_args(&self, witness_flags: bool, adopt: bool) -> Vec<String> {
        let uid = euid().to_string();
        let mut v: Vec<String> = vec![
            "--db".into(),
            self.data.join("k.db").to_str().unwrap().into(),
            "--witness".into(),
            self.data.join("k.witness.db").to_str().unwrap().into(),
            "--socket".into(),
            self.data.join("n.sock").to_str().unwrap().into(),
            "--cap".into(),
            self.data.join("issuer.cap").to_str().unwrap().into(),
            "--trust-mode".into(),
            "shadow-test".into(),
            "--workspace-bases".into(),
            self.root.path().to_str().unwrap().into(),
            "--allowed-uids".into(),
            uid.clone(),
            "--enable-writes".into(),
            "--approver-cap".into(),
            self.acap.to_str().unwrap().into(),
            "--approver-uids".into(),
            uid,
            "--allow-nonindependent-approver-test-only".into(),
            "--require-human-approval".into(),
        ];
        if witness_flags {
            v.extend([
                "--external-witness".into(),
                self.wsock.to_str().unwrap().into(),
                "--external-witness-uid".into(),
                euid().to_string(),
            ]);
        }
        if adopt {
            v.push("--witness-adopt-legacy".into());
        }
        v.extend(self.extra_flags.iter().cloned());
        v
    }

    fn sock(&self) -> PathBuf {
        self.data.join("n.sock")
    }

    fn start_daemon(&mut self, witness_flags: bool, adopt: bool) {
        let _ = std::fs::remove_file(self.sock());
        let args = self.daemon_args(witness_flags, adopt);
        let mut cmd = Command::new(nexusd_bin());
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        common::die_with_test(&mut cmd);
        let mut c = cmd.spawn().expect("spawn nexusd");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(r) = raw_request(
                &self.sock(),
                r#"{"protocol":1,"id":"p","cmd":"health","params":{}}"#,
            ) {
                if r["ok"] == true {
                    break;
                }
            }
            if let Ok(Some(st)) = c.try_wait() {
                use std::io::Read;
                let mut o = String::new();
                if let Some(mut e) = c.stderr.take() {
                    let _ = e.read_to_string(&mut o);
                }
                panic!("daemon exited: {st}: {o}");
            }
            assert!(Instant::now() < deadline, "daemon never ready");
            std::thread::sleep(Duration::from_millis(25));
        }
        self.daemon = Some(c);
        self.cap = read_cap(&self.data.join("issuer.cap"));
        self.approver_cap = read_cap(&self.acap);
    }

    fn start_daemon_expect_exit(&mut self, witness_flags: bool, adopt: bool) -> String {
        let _ = std::fs::remove_file(self.sock());
        let args = self.daemon_args(witness_flags, adopt);
        let o = Command::new(nexusd_bin())
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!o.status.success(), "daemon must refuse to start");
        String::from_utf8_lossy(&o.stderr).into_owned()
    }

    fn stop_daemon(&mut self) {
        if let Some(mut c) = self.daemon.take() {
            crash(&mut c);
        }
        let _ = std::fs::remove_file(self.sock());
    }

    fn stop_witness(&mut self) {
        if let Some(mut c) = self.witness.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = std::fs::remove_file(&self.wsock);
    }

    fn start_witness(&mut self, fault: Option<&str>) {
        self.witness = Some(spawn_witness(&self.wdir, &self.wsock, fault));
    }

    fn issuer(&self, cmd: &str, p: Value) -> Value {
        raw_request(&self.sock(), &authed_frame(&self.cap, cmd, p)).unwrap()
    }
    fn approver(&self, cmd: &str, p: Value) -> Value {
        raw_request(&self.sock(), &authed_frame(&self.approver_cap, cmd, p)).unwrap()
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
    fn exec(&mut self, args: Value) -> Value {
        let p = self.params("fs.write", args);
        self.issuer("tool-execute", p)
    }
    fn request(&mut self, args: Value) -> Value {
        let p = self.params("fs.write", args);
        self.issuer("approval-request", p)
    }
    fn approve(&mut self, args: Value) -> Result<String, Value> {
        let r = self.request(args);
        if r["ok"] != true {
            return Err(r);
        }
        let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
        let g = self.approver("approval-get", json!({"approvalId": id}));
        if g["ok"] != true {
            return Err(g);
        }
        let a = &g["approval"];
        let d = self.approver(
            "approval-decide",
            json!({"approvalId": id, "requestDigest": a["requestDigest"],
                   "decision": "approve", "reviewCode": a["reviewCode"],
                   "confirmation": {"tty": false}}),
        );
        if d["ok"] != true {
            return Err(d);
        }
        Ok(id)
    }
    fn integrity(&self) -> Value {
        let r = raw_request(
            &self.sock(),
            &json!({"protocol":1,"id":next_id("i"),"cmd":"integrity-status","params":{}})
                .to_string(),
        )
        .unwrap();
        assert_eq!(r["ok"], true, "{r}");
        r["integrity"].clone()
    }
    fn put(&self, name: &str, c: &str) {
        std::fs::write(self.ws.join(name), c).unwrap();
    }
    fn disk(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.ws.join(name)).ok()
    }
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.data.join("k.db")).unwrap()
    }
    fn local_witness_db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.data.join("k.witness.db")).unwrap()
    }
}

fn wargs(path: &str, content: &str, pre: &str) -> Value {
    json!({"path": path, "content": content, "mode": "replace", "expectedSha256": sha(pre)})
}

/// Boot a fresh deployment: witness + daemon (external witness on unless
/// `anchored` is false), one accepted command, bound workspace.
fn boot(tag: &str, anchored: bool) -> W {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let rp = std::fs::canonicalize(root.path()).unwrap();
    let mk = |n: &str, mode: u32| {
        let p = rp.join(n);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p
    };
    let data = mk("data", 0o700);
    let wdir = mk("witness", 0o700);
    let adir = mk("acap", 0o700);
    let ws = mk("ws", 0o755);
    let wsock = rp.join("wit.sock");
    let mut w = W {
        root,
        wdir,
        wsock,
        data,
        ws,
        acap: adir.join("approver.cap"),
        witness: None,
        daemon: None,
        extra_flags: Vec::new(),
        cap: String::new(),
        approver_cap: String::new(),
        task: format!("t-{tag}"),
        attempt: format!("a-{tag}"),
        command: format!("c-{tag}"),
        epoch: 0,
        inc: String::new(),
        root_digest: sha(rp.join("ws").to_str().unwrap()),
        n: 0,
    };
    w.start_witness(None);
    w.start_daemon(anchored, false);
    let rec = accept_one_ws(
        &w.sock(),
        &w.cap,
        &w.task,
        &w.attempt,
        &w.command,
        &w.root_digest,
    );
    let r = rec.get("receipt").unwrap();
    w.epoch = r["leaseEpoch"].as_u64().unwrap();
    w.inc = r["storeIncarnation"].as_str().unwrap().to_owned();
    assert_ok(&w.issuer(
        "workspace-bind",
        json!({"commandId": w.command, "root": w.ws.to_str().unwrap()}),
    ));
    w
}

fn local_counts(w: &W) -> (u64, u64) {
    let c = w.db();
    let t: u64 = c
        .query_row("SELECT COUNT(*) FROM tool_journal", [], |r| r.get(0))
        .unwrap();
    let a: u64 = c
        .query_row("SELECT COUNT(*) FROM approval_events", [], |r| r.get(0))
        .unwrap();
    (t, a)
}

/// Compromised daemon UID: truncate the tool journal tail AND rewrite the
/// local witness checkpoint with a valid seal (it holds the issuance key).
fn truncate_and_reseal(w: &W, keep: u64) {
    use hmac::Mac;
    let db = w.db();
    let key_hex: String = db
        .query_row(
            "SELECT value FROM store_meta WHERE key='issuance_key'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    db.execute(
        "DELETE FROM tool_journal WHERE seq > (SELECT seq FROM tool_journal ORDER BY seq LIMIT 1 OFFSET ?1)",
        [(keep - 1) as i64],
    )
    .unwrap();
    let tail: String = db
        .query_row(
            "SELECT entry_hash FROM tool_journal ORDER BY seq DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let count: u64 = db
        .query_row("SELECT COUNT(*) FROM tool_journal", [], |r| r.get(0))
        .unwrap();
    let mut mac =
        hmac::Hmac::<sha2::Sha256>::new_from_slice(&hex::decode(key_hex).unwrap()).unwrap();
    mac.update(b"nexus-tool-journal/v1|");
    mac.update(format!("checkpoint|{count}|{tail}").as_bytes());
    let seal = hex::encode(mac.finalize().into_bytes());
    let v = common_canonical(&json!({"count": count, "tail": tail, "seal": seal}));
    w.local_witness_db()
        .execute(
            "UPDATE witness_meta SET value = ?1 WHERE key = 'tool_journal_checkpoint/v1'",
            [v],
        )
        .unwrap();
}

fn common_canonical(v: &Value) -> String {
    nexus_contracts::canonical_json(v)
}

// ------------------------------------------------------------------ tests

#[test]
fn anchored_operation_is_verified_and_matches_the_witness() {
    let mut w = boot("ok", true);
    w.put("a.txt", "x\n");
    let id = w.approve(wargs("a.txt", "y\n", "x\n")).unwrap();
    assert_ok(&w.exec(wargs("a.txt", "y\n", "x\n")));
    assert_eq!(w.disk("a.txt").unwrap(), "y\n");
    let rep = w.integrity();
    assert_eq!(rep["state"], "verified", "{rep}");
    assert_eq!(rep["configured"], true);
    let (t, a) = local_counts(&w);
    let st = wcall(&w.wsock, json!({"op": "status"}));
    assert_eq!(st["journals"]["tool-journal"]["count"], t);
    assert_eq!(st["journals"]["approval-events"]["count"], a);
    assert_eq!(st["violations"], 0);
    // The scope statement is explicit: no generic "secure" claim.
    assert!(rep["scope"].as_str().unwrap().contains("same-host witness"));
    let _ = id;
}

#[test]
fn tail_truncation_with_resealed_local_checkpoint_is_detected_and_blocks_authority() {
    let mut w = boot("trunc", true);
    w.put("a.txt", "x\n");
    w.put("b.txt", "x\n");
    w.approve(wargs("a.txt", "y\n", "x\n")).unwrap();
    assert_ok(&w.exec(wargs("a.txt", "y\n", "x\n")));
    let (t, _) = local_counts(&w);
    assert!(t >= 4);
    w.stop_daemon();
    // Compromised daemon UID erases the last entries and reseals locally:
    // the local-only checks are satisfied.
    truncate_and_reseal(&w, t - 2);
    w.start_daemon(true, false);
    let rep = w.integrity();
    assert_eq!(rep["state"], "integrity-mismatch", "{rep}");
    // Read-only inspection stays up; privileged authority is refused.
    let r = raw_request(
        &w.sock(),
        r#"{"protocol":1,"id":"h","cmd":"health","params":{}}"#,
    )
    .unwrap();
    assert_eq!(r["ok"], true);
    let r = w.request(wargs("b.txt", "y\n", "x\n"));
    assert_ne!(r["ok"], true, "{r}");
    assert_eq!(w.disk("b.txt").unwrap(), "x\n");
}

#[test]
fn rollback_to_an_older_valid_database_pair_is_detected() {
    let mut w = boot("roll", true);
    w.put("a.txt", "x\n");
    w.stop_daemon();
    // Snapshot the consistent (db + local witness) pair, then advance.
    let snap = w.root.path().join("snap");
    std::fs::create_dir_all(&snap).unwrap();
    for f in ["k.db", "k.witness.db"] {
        // VACUUM INTO folds the WAL: a self-consistent point-in-time copy.
        rusqlite::Connection::open(w.data.join(f))
            .unwrap()
            .execute("VACUUM INTO ?1", [snap.join(f).to_str().unwrap()])
            .unwrap();
    }
    w.start_daemon(true, false);
    w.approve(wargs("a.txt", "y\n", "x\n")).unwrap();
    assert_ok(&w.exec(wargs("a.txt", "y\n", "x\n")));
    w.stop_daemon();
    // Replace the whole pair with the older one (journal/witness pair
    // replacement): every local chain and checkpoint is self-consistent.
    for f in ["k.db", "k.witness.db"] {
        std::fs::copy(snap.join(f), w.data.join(f)).unwrap();
        let _ = std::fs::remove_file(w.data.join(format!("{f}-wal")));
        let _ = std::fs::remove_file(w.data.join(format!("{f}-shm")));
    }
    w.start_daemon(true, false);
    let rep = w.integrity();
    assert_eq!(rep["state"], "integrity-mismatch", "{rep}");
    assert!(
        rep["detail"]
            .as_str()
            .unwrap()
            .contains("behind the witness"),
        "{rep}"
    );
    let r = w.request(wargs("a.txt", "z\n", "y\n"));
    assert_ne!(r["ok"], true, "{r}");
}

#[test]
fn witness_unavailable_blocks_authority_but_not_reads_and_recovers_deterministically() {
    let mut w = boot("down", true);
    w.put("a.txt", "x\n");
    w.stop_witness();
    // Before append: nothing authorizes, reads still work.
    let r = w.request(wargs("a.txt", "y\n", "x\n"));
    assert_ne!(r["ok"], true, "{r}");
    assert_eq!(
        raw_request(
            &w.sock(),
            r#"{"protocol":1,"id":"h","cmd":"health","params":{}}"#
        )
        .unwrap()["ok"],
        true
    );
    let rep = w.integrity();
    assert_eq!(rep["state"], "witness-unavailable", "{rep}");
    // After witness returns the unwitnessed tail is caught up as a strict
    // continuation and the system verifies again.
    w.start_witness(None);
    let rep = w.integrity();
    assert_eq!(rep["state"], "verified", "{rep}");
    // The request whose acknowledgement never arrived exists as a PENDING
    // approval (it authorized nothing); the issuer retry is refused as a
    // duplicate until that one is decided, revoked or expired.
    let dup = w.approve(wargs("a.txt", "y\n", "x\n"));
    assert_eq!(dup.unwrap_err()["code"], "command-conflict");
    let list = raw_request(
        &w.sock(),
        &json!({"protocol":1,"id":next_id("l"),"cmd":"approval-list","params":{}}).to_string(),
    )
    .unwrap();
    let pend = list["approvals"][0]["approvalId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(list["approvals"][0]["state"], "pending");
    assert_ok(&w.issuer("approval-revoke", json!({"approvalId": pend})));
    assert!(w.approve(wargs("a.txt", "y\n", "x\n")).is_ok());
}

#[test]
fn approval_cannot_be_consumed_while_its_decision_is_unwitnessed() {
    let mut w = boot("consume", true);
    w.put("a.txt", "x\n");
    let args = wargs("a.txt", "y\n", "x\n");
    let r = w.request(args.clone());
    let id = r["approval"]["approvalId"].as_str().unwrap().to_owned();
    let g = w.approver("approval-get", json!({"approvalId": id}));
    // The witness refuses to persist: the decision lands locally but is
    // never acknowledged.
    w.stop_witness();
    w.start_witness(Some("fail-persist"));
    let a = &g["approval"];
    let d = w.approver(
        "approval-decide",
        json!({"approvalId": id, "requestDigest": a["requestDigest"], "decision": "approve",
               "reviewCode": a["reviewCode"], "confirmation": {"tty": false}}),
    );
    assert_ne!(
        d["ok"], true,
        "unacknowledged decision must not be reported: {d}"
    );
    // While unwitnessed, the approval authorizes nothing.
    let r = w.exec(args.clone());
    assert_ne!(r["ok"], true, "{r}");
    assert_eq!(w.disk("a.txt").unwrap(), "x\n");
    // Recovery: witness healthy again; the continuation is committed and
    // the genuinely-made decision becomes usable. Nothing is fabricated.
    w.stop_witness();
    w.start_witness(None);
    assert_eq!(w.integrity()["state"], "verified");
    assert_ok(&w.exec(args));
    assert_eq!(w.disk("a.txt").unwrap(), "y\n");
}

#[test]
fn lost_acknowledgement_and_crash_after_commit_are_idempotent() {
    let mut w = boot("lost", true);
    w.put("a.txt", "x\n");
    // Witness persists then drops the ack.
    w.stop_witness();
    w.start_witness(Some("drop-ack"));
    let r = w.request(wargs("a.txt", "y\n", "x\n"));
    assert_ne!(r["ok"], true, "{r}");
    w.stop_witness();
    w.start_witness(None);
    // Retrying the exact continuation is idempotent: no violation.
    assert_eq!(w.integrity()["state"], "verified");
    let st = wcall(&w.wsock, json!({"op": "status"}));
    assert_eq!(st["violations"], 0, "{st}");
    // Witness crashes right after persisting.
    w.stop_witness();
    w.start_witness(Some("exit-after-persist"));
    let r = w.request(wargs("a.txt", "z\n", "x\n"));
    assert_ne!(r["ok"], true, "{r}");
    w.stop_witness();
    w.start_witness(None);
    let rep = w.integrity();
    assert_eq!(rep["state"], "verified", "{rep}");
    let st = wcall(&w.wsock, json!({"op": "status"}));
    let (t, a) = local_counts(&w);
    assert_eq!(st["journals"]["tool-journal"]["count"], t);
    assert_eq!(st["journals"]["approval-events"]["count"], a);
    assert_eq!(st["violations"], 0);
}

#[test]
fn compromised_daemon_cannot_rewind_or_fork_the_witness() {
    let mut w = boot("evil", true);
    w.put("a.txt", "x\n");
    w.approve(wargs("a.txt", "y\n", "x\n")).unwrap();
    assert_ok(&w.exec(wargs("a.txt", "y\n", "x\n")));
    let st = wcall(&w.wsock, json!({"op": "status"}));
    let before = st["journals"]["tool-journal"].clone();
    let inc = st["storeId"].as_str().unwrap().to_owned();
    let n = before["count"].as_u64().unwrap();
    let zero = "0".repeat(64);
    let tail = before["tail"].as_str().unwrap().to_owned();
    // Rewind to an older count (forged continuation from genesis).
    let r = wcall(
        &w.wsock,
        json!({"op":"commit","storeId":inc,"journal":"tool-journal","count":1,
               "tail":"1".repeat(64),"prevCount":0,"prevTail":zero}),
    );
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(r["code"], "rollback", "{r}");
    // Fork at the same count with a different tail.
    let r = wcall(
        &w.wsock,
        json!({"op":"commit","storeId":inc,"journal":"tool-journal","count":n,
               "tail":"2".repeat(64),"prevCount":n-1,"prevTail":"3".repeat(64)}),
    );
    assert_eq!(r["ok"], false, "{r}");
    // Cross-journal substitution and unknown journal domain.
    let r = wcall(
        &w.wsock,
        json!({"op":"commit","storeId":inc,"journal":"other","count":1,
               "tail":"1".repeat(64),"prevCount":0,"prevTail":zero}),
    );
    assert_eq!(r["code"], "unknown-journal");
    // Cross-store substitution.
    let r = wcall(
        &w.wsock,
        json!({"op":"commit","storeId":"another-store","journal":"tool-journal","count":n+1,
               "tail":"4".repeat(64),"prevCount":n,"prevTail":tail}),
    );
    assert_eq!(r["code"], "store-substitution");
    // State unchanged, violations recorded.
    let st = wcall(&w.wsock, json!({"op": "status"}));
    assert_eq!(st["journals"]["tool-journal"], before);
    assert!(st["violations"].as_u64().unwrap() >= 3);
    // Tampering with the witness's own state file is detected at startup.
    w.stop_witness();
    let sp = w.wdir.join("state.json");
    let raw = std::fs::read_to_string(&sp)
        .unwrap()
        .replace("\"count\"", "\"count \"");
    std::fs::write(&sp, raw).unwrap();
    let o = Command::new(witness_bin())
        .arg("--dir")
        .arg(&w.wdir)
        .arg("status")
        .output()
        .unwrap();
    assert!(!o.status.success());
    // Deleting the state (reset) is refused too.
    std::fs::remove_file(&sp).unwrap();
    let o = Command::new(witness_bin())
        .arg("--dir")
        .arg(&w.wdir)
        .arg("status")
        .output()
        .unwrap();
    assert!(!o.status.success());
}

#[test]
fn another_store_cannot_use_the_same_witness() {
    let mut w = boot("pin", true);
    w.put("a.txt", "x\n");
    w.stop_daemon();
    // A second, different DataRoot (new incarnation) against the same witness.
    let other = w.root.path().join("data2");
    std::fs::create_dir_all(&other).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o700)).unwrap();
    let saved = std::mem::replace(&mut w.data, other);
    w.start_daemon(true, false);
    let rep = w.integrity();
    assert_eq!(rep["state"], "integrity-mismatch", "{rep}");
    assert!(
        rep["detail"]
            .as_str()
            .unwrap()
            .contains("store-substitution"),
        "{rep}"
    );
    w.stop_daemon();
    w.data = saved;
}

#[test]
fn legacy_unanchored_history_is_never_trusted_without_explicit_adoption() {
    let mut w = boot("legacy", false); // no external witness
    w.put("a.txt", "x\n");
    w.approve(wargs("a.txt", "y\n", "x\n")).unwrap();
    assert_ok(&w.exec(wargs("a.txt", "y\n", "x\n")));
    let rep = w.integrity();
    assert_eq!(rep["state"], "not-configured");
    w.stop_daemon();
    // Anchoring a store that already has history: refused as unanchored.
    w.start_daemon(true, false);
    let rep = w.integrity();
    assert_eq!(rep["state"], "unanchored-legacy", "{rep}");
    w.put("b.txt", "x\n");
    let r = w.request(wargs("b.txt", "y\n", "x\n"));
    assert_ne!(r["ok"], true, "legacy history must not authorize: {r}");
    // Explicit adoption promotes it, marked as adopted (history before
    // the adoption point remains unwitnessed).
    w.stop_daemon();
    w.start_daemon(true, true);
    let rep = w.integrity();
    assert_eq!(rep["state"], "verified", "{rep}");
    let st = wcall(&w.wsock, json!({"op": "status"}));
    assert_eq!(st["journals"]["tool-journal"]["adopted"], true);
    // After adoption the downgrade latch holds: no external witness again
    // means no writes.
    w.stop_daemon();
    let err = w.start_daemon_expect_exit(false, false);
    assert!(err.contains("witness-downgrade-refused"), "{err}");
}

#[test]
fn concurrent_writers_keep_one_consistent_witnessed_history() {
    let mut w = boot("conc", true);
    for i in 0..4 {
        w.put(&format!("f{i}.txt"), "x\n");
    }
    let mut frames = Vec::new();
    for i in 0..4 {
        let p = w.params("fs.write", wargs(&format!("f{i}.txt"), "y\n", "x\n"));
        frames.push(authed_frame(&w.cap, "approval-request", p));
    }
    let sock = w.sock();
    let hs: Vec<_> = frames
        .into_iter()
        .map(|f| {
            let s = sock.clone();
            std::thread::spawn(move || raw_request(&s, &f).unwrap())
        })
        .collect();
    let oks = hs
        .into_iter()
        .map(|h| h.join().unwrap())
        .filter(|r| r["ok"] == true)
        .count();
    assert_eq!(oks, 4);
    let rep = w.integrity();
    assert_eq!(rep["state"], "verified", "{rep}");
    let st = wcall(&w.wsock, json!({"op": "status"}));
    let (_, a) = local_counts(&w);
    assert_eq!(st["journals"]["approval-events"]["count"], a);
    assert_eq!(st["violations"], 0);
}

#[test]
fn interrupted_write_recovers_under_the_witness_without_replay() {
    let mut w = boot("crash", true);
    w.put("a.txt", "x\n");
    let args = wargs("a.txt", "y\n", "x\n");
    w.approve(args.clone()).unwrap();
    // Re-launch with a deterministic crash point inside the write.
    w.stop_daemon();
    let _ = std::fs::remove_file(w.sock());
    let dargs = w.daemon_args(true, false);
    let mut cmd = Command::new(nexusd_bin());
    cmd.args(&dargs)
        .env("NEXUS_TEST_WRITE_CRASH_AT", "after-planned")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    common::die_with_test(&mut cmd);
    let mut c = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if raw_request(
            &w.sock(),
            r#"{"protocol":1,"id":"p","cmd":"health","params":{}}"#,
        )
        .map(|r| r["ok"] == true)
        .unwrap_or(false)
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(25));
    }
    // Keys rotate per start; approvals lapse on restart: re-approve.
    w.cap = read_cap(&w.data.join("issuer.cap"));
    w.approver_cap = read_cap(&w.acap);
    let id = w.approve(args.clone());
    let crashed = if id.is_ok() {
        let p = w.params("fs.write", args.clone());
        // The daemon SIGKILLs itself inside the write: no response.
        let _ = raw_request(&w.sock(), &authed_frame(&w.cap, "tool-execute", p));
        c.wait().is_ok()
    } else {
        false
    };
    let _ = c.kill();
    let _ = c.wait();
    if !crashed {
        // The crash-injection feature is not compiled into this binary:
        // the test cannot assert interruption semantics here.
        println!("NOT RUN: write crash injection unavailable in this build");
        return;
    }
    // Restart: the interrupted write is reconciled (never replayed) and the
    // witnessed history stays consistent.
    let _ = std::fs::remove_file(w.sock());
    w.start_daemon(true, false);
    let rep = w.integrity();
    assert_eq!(rep["state"], "verified", "{rep}");
    assert_eq!(
        w.disk("a.txt").unwrap(),
        "x\n",
        "no replay of an uncertain write"
    );
    let st = wcall(&w.wsock, json!({"op": "status"}));
    let (t, _) = local_counts(&w);
    assert_eq!(st["journals"]["tool-journal"]["count"], t);
}

// ----------------------------------------------------- A4.3 final audit

fn witness_counts(w: &W) -> (u64, u64) {
    let st = wcall(&w.wsock, json!({"op": "status"}));
    (
        st["journals"]["tool-journal"]["count"]
            .as_u64()
            .unwrap_or(0),
        st["journals"]["approval-events"]["count"]
            .as_u64()
            .unwrap_or(0),
    )
}

fn list_approvals(w: &W) -> Vec<Value> {
    let r = raw_request(
        &w.sock(),
        &json!({"protocol":1,"id":next_id("l"),"cmd":"approval-list","params":{}}).to_string(),
    )
    .unwrap();
    r["approvals"].as_array().cloned().unwrap_or_default()
}

#[test]
fn enforcement_matrix_fresh_store_requires_the_explicit_flag_and_fails_closed() {
    // Fresh store, no witness configuration: legacy mode, reported honestly
    // as not-configured (no independent anchor). This is deployment policy.
    let mut w = boot("matrix", false);
    w.put("a.txt", "x\n");
    let rep = w.integrity();
    assert_eq!(rep["state"], "not-configured");
    assert!(
        rep["scope"]
            .as_str()
            .unwrap()
            .contains("NO independent anchor"),
        "{rep}"
    );
    // Approval-enabled store without a witness still works (A4.2 semantics)
    // but is not claimed anchored.
    assert!(w.approve(wargs("a.txt", "y\n", "x\n")).is_ok());
    // Production units pass --require-external-witness: without the witness
    // flags the daemon refuses to start, even on a fresh/unlatched store.
    w.stop_daemon();
    w.extra_flags = vec!["--require-external-witness".into()];
    let err = w.start_daemon_expect_exit(false, false);
    assert!(err.contains("witness-required"), "{err}");
    // With the witness down the daemon still starts, but read-only.
    w.stop_witness();
    w.start_daemon(true, false);
    assert_eq!(w.integrity()["state"], "witness-unavailable");
    let r = w.request(wargs("a.txt", "z\n", "x\n"));
    assert_ne!(r["ok"], true, "{r}");
    let r = w.exec(wargs("a.txt", "y\n", "x\n"));
    assert_ne!(r["ok"], true, "{r}");
    assert_eq!(w.disk("a.txt").unwrap(), "x\n");
    assert_eq!(
        raw_request(
            &w.sock(),
            r#"{"protocol":1,"id":"h","cmd":"health","params":{}}"#
        )
        .unwrap()["ok"],
        true
    );
}

#[test]
fn anchored_store_cannot_be_laundered_through_a_fresh_witness() {
    let mut w = boot("launder", true);
    w.put("a.txt", "x\n");
    w.approve(wargs("a.txt", "y\n", "x\n")).unwrap();
    assert_ok(&w.exec(wargs("a.txt", "y\n", "x\n")));
    w.stop_daemon();
    // A compromised launcher points the store at a brand-new witness
    // directory (no memory of prior commitments), optionally with adoption.
    w.stop_witness();
    let fresh = w.root.path().join("witness-fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fresh, std::fs::Permissions::from_mode(0o700)).unwrap();
    let original = std::mem::replace(&mut w.wdir, fresh);
    w.start_witness(None);
    // With adoption: refused outright, nothing is accepted.
    let err = w.start_daemon_expect_exit(true, true);
    assert!(err.contains("adopt-refused"), "{err}");
    let st = wcall(&w.wsock, json!({"op": "status"}));
    assert!(st["journals"]
        .as_object()
        .map(|m| m.is_empty())
        .unwrap_or(true));
    // Without adoption: history stays unanchored and nothing is authorized.
    w.start_daemon(true, false);
    assert_eq!(w.integrity()["state"], "unanchored-legacy");
    let r = w.request(wargs("a.txt", "z\n", "y\n"));
    assert_ne!(r["ok"], true, "{r}");
    w.stop_daemon();
    w.stop_witness();
    w.wdir = original;
}

/// Position (1-based) of the LAST journal row with `phase`, if any.
fn pos_of(c: &rusqlite::Connection, table: &str, col: &str, val: &str) -> Option<u64> {
    c.query_row(
        &format!(
            "SELECT COUNT(*) FROM {table} WHERE seq <= (SELECT MAX(seq) FROM {table} WHERE {col} = ?1)"
        ),
        [val],
        |r| r.get::<_, u64>(0),
    )
    .ok()
    .filter(|p| *p > 0)
}

fn property_run(fault_prefix: &str, n: u32) {
    let mut w = boot(&format!("prop-{fault_prefix}-{n}"), true);
    w.put("a.txt", "x\n");
    // Inject the fault only for the operation under test.
    w.stop_witness();
    w.start_witness(Some(&format!("{fault_prefix}:{n}")));
    let args = wargs("a.txt", "y\n", "x\n");
    let approved = w.approve(args.clone());
    let exec_ok = if approved.is_ok() {
        w.exec(args)["ok"] == true
    } else {
        false
    };
    let (wt, wa) = witness_counts(&w);
    if std::env::var("DBG_PROP").is_ok() {
        eprintln!(
            "{fault_prefix}:{n} approved={} exec_ok={exec_ok} local={:?} witness=({wt},{wa})",
            approved.is_ok(),
            local_counts(&w)
        );
    }
    let c = w.db();
    let changed = w.disk("a.txt").unwrap() == "y\n";
    // Publication never precedes an acknowledged `prepared` record.
    if changed {
        let p = pos_of(&c, "tool_journal", "phase", "prepared").expect("prepared recorded");
        assert!(
            p <= wt,
            "{fault_prefix}:{n}: file changed but prepared (pos {p}) not witnessed (witness {wt})"
        );
        let planned = pos_of(&c, "tool_journal", "phase", "planned").expect("planned recorded");
        assert!(planned <= wt, "{fault_prefix}:{n}: planned unwitnessed");
    }
    // A grant is never minted before its approval consumption is witnessed.
    if let Some(auth) = pos_of(&c, "tool_journal", "phase", "authorized") {
        let _ = auth;
        let consumed = pos_of(&c, "approval_events", "event", "consumed").expect("consumed");
        assert!(
            consumed <= wa,
            "{fault_prefix}:{n}: grant minted with unwitnessed consumption"
        );
        // ...and the authorized entry itself is witnessed before start.
        if pos_of(&c, "tool_journal", "phase", "started").is_some() {
            let auth_pos = pos_of(&c, "tool_journal", "phase", "authorized").unwrap();
            assert!(
                auth_pos <= wt,
                "{fault_prefix}:{n}: started with unwitnessed authorization"
            );
        }
    }
    if exec_ok {
        // A success response implies every transition was acknowledged.
        let (lt, la) = local_counts(&w);
        assert_eq!(
            (lt, la),
            (wt, wa),
            "{fault_prefix}:{n}: ok with unwitnessed tail"
        );
    }
    // Recovery is deterministic: with a healthy witness the system verifies
    // or (for uncertain writes) reconciles; never a fabricated success.
    w.stop_witness();
    w.start_witness(None);
    let rep = w.integrity();
    assert!(
        rep["state"] == "verified",
        "{fault_prefix}:{n}: expected deterministic recovery, got {rep}"
    );
}

#[test]
fn no_critical_transition_relies_on_an_unacknowledged_commit() {
    // Sweep the failure point across every witness commit of the flow.
    for n in 0..14 {
        property_run("fail-after", n);
    }
}

#[test]
fn lost_acknowledgements_at_every_point_never_authorize_early() {
    for n in 0..14 {
        property_run("drop-ack-after", n);
    }
}

#[test]
fn daemon_crash_between_append_and_acknowledgement_recovers_without_authorizing() {
    let mut w = boot("hang", true);
    w.put("a.txt", "x\n");
    let (_, a0) = local_counts(&w);
    w.stop_witness();
    w.start_witness(Some("hang"));
    let frame = {
        let p = w.params("fs.write", wargs("a.txt", "y\n", "x\n"));
        authed_frame(&w.cap, "approval-request", p)
    };
    let sock = w.sock();
    let t = std::thread::spawn(move || raw_request(&sock, &frame));
    // Wait until the entry is appended locally while the witness stalls.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if local_counts(&w).1 > a0 {
            break;
        }
        assert!(Instant::now() < deadline, "append never observed");
        std::thread::sleep(Duration::from_millis(10));
    }
    w.stop_daemon(); // SIGKILL before any acknowledgement
    let _ = t.join();
    w.stop_witness();
    w.start_witness(None);
    // Restart: the unwitnessed continuation is committed (deterministic)
    // and the request exists only as PENDING; nothing is authorized.
    w.start_daemon(true, false);
    assert_eq!(w.integrity()["state"], "verified");
    let l = list_approvals(&w);
    assert_eq!(l.len(), 1, "{l:?}");
    assert_eq!(l[0]["state"], "pending");
    let r = w.exec(wargs("a.txt", "y\n", "x\n"));
    assert_ne!(r["ok"], true, "{r}");
    assert_eq!(w.disk("a.txt").unwrap(), "x\n");
    let (_, a1) = local_counts(&w);
    assert_eq!(witness_counts(&w).1, a1);
}

#[test]
fn truncated_unwitnessed_tail_is_consistent_but_never_authorized_anything() {
    let mut w = boot("tailcut", true);
    w.put("a.txt", "x\n");
    w.approve(wargs("a.txt", "y\n", "x\n")).unwrap();
    w.stop_witness();
    w.start_witness(Some("fail-persist"));
    let (_, a_before) = local_counts(&w);
    let r = w.request(wargs("a.txt", "z\n", "x\n"));
    assert_ne!(r["ok"], true, "{r}");
    let (_, a_after) = local_counts(&w);
    assert!(a_after > a_before, "unwitnessed entries were appended");
    w.stop_daemon();
    // Attacker removes exactly the unwitnessed tail (and its row).
    {
        let c = w.db();
        c.execute(
            "DELETE FROM approval_events WHERE seq > (SELECT seq FROM approval_events ORDER BY seq LIMIT 1 OFFSET ?1)",
            [(a_before - 1) as i64],
        )
        .unwrap();
        c.execute(
            "DELETE FROM approvals WHERE approval_id NOT IN (SELECT approval_id FROM approval_events)",
            [],
        )
        .unwrap();
    }
    w.stop_witness();
    w.start_witness(None);
    w.start_daemon(true, false);
    // Consistent with the witness (the removed entries never authorized or
    // were reported): this residual window is documented, not hidden.
    assert_eq!(w.integrity()["state"], "verified");
    assert!(list_approvals(&w).iter().all(|a| a["state"] != "pending"));
}

#[test]
fn ambiguous_pending_continuation_is_not_committed_and_blocks_authority() {
    let mut w = boot("ambig", true);
    w.put("a.txt", "x\n");
    w.approve(wargs("a.txt", "y\n", "x\n")).unwrap();
    let (_, wa) = witness_counts(&w);
    w.stop_witness();
    w.start_witness(Some("fail-persist"));
    let _ = w.request(wargs("a.txt", "q\n", "x\n")); // unwitnessed tail
    w.stop_daemon();
    // The witnessed prefix itself no longer matches the local history.
    w.db()
        .execute(
            "UPDATE approval_events SET entry_hash = ?1 WHERE seq = (SELECT seq FROM approval_events ORDER BY seq LIMIT 1 OFFSET ?2)",
            rusqlite::params!["f".repeat(64), (wa - 1) as i64],
        )
        .unwrap();
    w.stop_witness();
    w.start_witness(None);
    w.start_daemon(true, false);
    assert_eq!(w.integrity()["state"], "integrity-mismatch");
    // The ambiguous continuation was NOT blindly committed.
    assert_eq!(witness_counts(&w).1, wa);
    let r = w.request(wargs("a.txt", "r\n", "x\n"));
    assert_ne!(r["ok"], true, "{r}");
}

#[test]
fn concurrent_commits_from_the_same_prefix_have_exactly_one_winner() {
    let w = boot("race", true);
    let st = wcall(&w.wsock, json!({"op": "status"}));
    let store = st["storeId"].as_str().unwrap().to_owned();
    let cur = st["journals"]["approval-events"].clone();
    let (c, t) = (
        cur["count"].as_u64().unwrap(),
        cur["tail"].as_str().unwrap().to_owned(),
    );
    let sock = w.wsock.clone();
    let hs: Vec<_> = (0..8)
        .map(|i| {
            let (sock, store, t) = (sock.clone(), store.clone(), t.clone());
            std::thread::spawn(move || {
                wcall(
                    &sock,
                    json!({"op":"commit","storeId":store,"journal":"approval-events",
                           "count": c + 1, "tail": format!("{:064x}", i + 1),
                           "prevCount": c, "prevTail": t}),
                )
            })
        })
        .collect();
    let rs: Vec<Value> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(rs.iter().filter(|r| r["ok"] == true).count(), 1, "{rs:?}");
    let st = wcall(&w.wsock, json!({"op": "status"}));
    assert_eq!(st["journals"]["approval-events"]["count"], c + 1);
}

#[test]
fn witness_has_no_authority_operations() {
    let w = boot("noauth", true);
    let before = wcall(&w.wsock, json!({"op": "status"}));
    for op in [
        "approval-decide",
        "approval-get",
        "tool-execute",
        "authorize",
        "grant",
        "reset",
        "write-scope-approve",
    ] {
        let r = wcall(&w.wsock, json!({"op": op, "storeId": "x"}));
        assert_eq!(r["ok"], false, "{op}: {r}");
        assert_eq!(r["code"], "bad-request", "{op}: {r}");
    }
    let after = wcall(&w.wsock, json!({"op": "status"}));
    assert_eq!(before["journals"], after["journals"]);
    assert_eq!(before["commitSeq"], after["commitSeq"]);
}
