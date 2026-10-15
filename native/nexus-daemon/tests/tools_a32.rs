//! A3.2 trusted tool integration over the real nexusd IPC boundary.
//!
//! Real daemon subprocess, real sockets, real filesystem. Trusted
//! test/operator execution only: no model, no provider, no AI-initiated
//! calls exist anywhere in this suite.

mod common;

use common::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

struct Env {
    d: DaemonProc,
    cap: String,
    base: tempfile::TempDir,
    ws: PathBuf,
    task: String,
    attempt: String,
    command: String,
    epoch: u64,
    inc: String,
    n: u32,
}

fn setup(tag: &str) -> Env {
    let base = tempfile::tempdir().unwrap();
    let basep = std::fs::canonicalize(base.path()).unwrap();
    let ws = basep.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let d = spawn_daemon_opts(
        "shadow-test",
        true,
        &["--workspace-bases", basep.to_str().unwrap()],
    );
    let cap = read_cap(&d.cap);
    let (task, attempt, command) = (
        format!("task-{tag}"),
        format!("attempt-{tag}"),
        format!("cmd-{tag}"),
    );
    let rec = accept_one_ws(
        &d.socket,
        &cap,
        &task,
        &attempt,
        &command,
        &nexus_contracts::sha256_hex(ws.to_str().unwrap()),
    );
    let receipt = rec.get("receipt").unwrap();
    let epoch = receipt["leaseEpoch"].as_u64().unwrap();
    let inc = receipt["storeIncarnation"].as_str().unwrap().to_owned();
    Env {
        d,
        cap,
        base,
        ws,
        task,
        attempt,
        command,
        epoch,
        inc,
        n: 0,
    }
}

impl Env {
    fn priv_req(&self, cmd: &str, params: Value) -> Value {
        raw_request(&self.d.socket, &authed_frame(&self.cap, cmd, params)).expect("transport")
    }
    fn bind(&self) -> Value {
        self.priv_req(
            "workspace-bind",
            json!({"commandId": self.command, "root": self.ws.to_str().unwrap()}),
        )
    }
    fn params(&mut self, tool: &str, args: Value) -> Value {
        self.n += 1;
        json!({
            "requestId": format!("req-{}-{}", self.command, self.n),
            "cancellationId": format!("cancel-{}-{}", self.command, self.n),
            "taskInstanceId": self.task, "attemptId": self.attempt, "commandId": self.command,
            "leaseEpoch": self.epoch, "storeIncarnation": self.inc,
            "toolId": tool, "toolVersion": 1, "args": args,
        })
    }
    fn exec(&mut self, tool: &str, args: Value) -> Value {
        let p = self.params(tool, args);
        self.priv_req("tool-execute", p)
    }
    fn write(&self, rel: &str, c: &[u8]) {
        let p = self.ws.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, c).unwrap();
    }
    fn events(&self, after: i64, limit: u32) -> Value {
        raw_request(
            &self.d.socket,
            &json!({"protocol":1,"id":next_id("ev"),"cmd":"tool-events","params":{
                "taskInstanceId": self.task, "attemptId": self.attempt,
                "afterSeq": after, "limit": limit}})
            .to_string(),
        )
        .unwrap()
    }
    fn all_phases(&self) -> Vec<String> {
        let r = self.events(0, 200);
        r["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["phase"].as_str().unwrap().to_owned())
            .collect()
    }
}

fn respawn(d: &DaemonProc, bases: &Path) -> std::process::Child {
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&d.db)
        .arg("--socket")
        .arg(&d.socket)
        .arg("--cap")
        .arg(&d.cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&d.witness)
        .arg("--workspace-bases")
        .arg(bases)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(r) = raw_request(
            &d.socket,
            r#"{"protocol":1,"id":"p","cmd":"health","params":{}}"#,
        ) {
            if r["ok"] == true {
                return child;
            }
        }
        if let Ok(Some(st)) = child.try_wait() {
            panic!("daemon exited: {st}");
        }
        assert!(Instant::now() < deadline, "never ready");
        std::thread::sleep(Duration::from_millis(25));
    }
}

// ------------------------------------------------------ authentication

#[test]
fn unauthenticated_and_readonly_tool_execution_is_refused() {
    let mut e = setup("auth");
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    let p = e.params("fs.read", json!({"path": "a.txt"}));
    // No auth block at all.
    let r = raw_request(
        &e.d.socket,
        &json!({"protocol":1,"id":"u1","cmd":"tool-execute","params":p}).to_string(),
    )
    .unwrap();
    assert_refused(&r, "issuer-untrusted");
    // Wrong capability key.
    let r = raw_request(
        &e.d.socket,
        &authed_frame(&"ab".repeat(32), "tool-execute", p.clone()),
    )
    .unwrap();
    assert_refused(&r, "issuer-untrusted");
    // Same for binding and revocation.
    for (cmd, params) in [
        (
            "workspace-bind",
            json!({"commandId": e.command, "root": e.ws.to_str().unwrap()}),
        ),
        ("tool-revoke", json!({"commandId": e.command})),
    ] {
        let r = raw_request(
            &e.d.socket,
            &json!({"protocol":1,"id":"u2","cmd":cmd,"params":params}).to_string(),
        )
        .unwrap();
        assert_refused(&r, "issuer-untrusted");
    }
    assert!(
        e.all_phases().is_empty(),
        "no journal rows from refused calls"
    );
    terminate(&mut e.d.child);

    // Default readonly daemon: privileged tool ops are disabled outright.
    let mut d = spawn_daemon("readonly", true);
    let r = raw_request(
        &d.socket,
        &authed_frame(&"ab".repeat(32), "tool-execute", json!({"requestId": "x"})),
    )
    .unwrap();
    assert_refused(&r, "privileged-disabled");
    terminate(&mut d.child);
}

#[test]
fn replayed_authenticated_frame_is_rejected() {
    let mut e = setup("replay");
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    let p = e.params("fs.read", json!({"path": "a.txt"}));
    let frame = authed_frame(&e.cap, "tool-execute", p);
    assert_ok(&raw_request(&e.d.socket, &frame).unwrap());
    let again = raw_request(&e.d.socket, &frame).unwrap();
    assert_refused(&again, "replay-rejected");
    assert_eq!(e.all_phases(), vec!["authorized", "started", "completed"]);
}

// ------------------------------------------- Controller workspace binding

#[test]
fn arbitrary_roots_never_authorize_execution() {
    let mut e = setup("roots");
    e.write("a.txt", b"x\n");
    // No binding yet: refused, nothing read.
    let r = e.exec("fs.read", json!({"path": "a.txt"}));
    assert_refused(&r, "delivery-invalid");
    // Caller-supplied root/path parameters are not even parseable.
    let mut p = e.params("fs.read", json!({"path": "a.txt"}));
    p["workspaceRoot"] = json!("/etc");
    assert_refused(&e.priv_req("tool-execute", p), "bad-request");
    let mut p = e.params("fs.read", json!({"path": "a.txt"}));
    p["root"] = json!("/");
    assert_refused(&e.priv_req("tool-execute", p), "bad-request");
    // Binding outside the operator-allowed base is refused...
    let outside = tempfile::tempdir().unwrap();
    let r = e.priv_req(
        "workspace-bind",
        json!({"commandId": e.command, "root": outside.path().to_str().unwrap()}),
    );
    assert_refused(&r, "scope-refused");
    for evil in ["/", "/etc", "/proc", "relative/path"] {
        let r = e.priv_req(
            "workspace-bind",
            json!({"commandId": e.command, "root": evil}),
        );
        assert_refused(&r, "scope-refused");
    }
    // ...as is an unknown command.
    let r = e.priv_req(
        "workspace-bind",
        json!({"commandId": "no-such", "root": e.ws.to_str().unwrap()}),
    );
    assert_eq!(r["ok"], false);
    // The legitimate bind works, never echoes the root, and is idempotent.
    let r = e.bind();
    assert_ok(&r);
    assert!(!r.to_string().contains(e.ws.to_str().unwrap()));
    assert_ok(&e.bind());
    // A different root for the same command conflicts.
    let other = e.base.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let r = e.priv_req(
        "workspace-bind",
        json!({"commandId": e.command, "root": std::fs::canonicalize(&other).unwrap().to_str().unwrap()}),
    );
    assert_eq!(r["ok"], false);
    // And execution now works through the bound root only.
    let r = e.exec("fs.read", json!({"path": "a.txt"}));
    assert_ok(&r);
    assert_eq!(r["result"]["output"]["content"], "x\n");
    assert_eq!(r["execution"]["aiInitiated"], false);
}

#[test]
fn root_replacement_after_binding_is_refused() {
    let mut e = setup("rootswap");
    e.write("a.txt", b"orig\n");
    assert_ok(&e.bind());
    let moved = e.base.path().join("moved");
    std::fs::rename(&e.ws, &moved).unwrap();
    std::fs::create_dir_all(&e.ws).unwrap();
    std::fs::write(e.ws.join("a.txt"), "REPLACED\n").unwrap();
    let r = e.exec("fs.read", json!({"path": "a.txt"}));
    assert_refused(&r, "workspace-mismatch");
    assert!(e.all_phases().is_empty());
}

// ------------------------------------------------ grants, leases, forgery

#[test]
fn stale_lease_wrong_attempt_and_duplicates_are_refused() {
    let mut e = setup("lease");
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    // Wrong attempt / epoch / incarnation / forged ids.
    let mut p = e.params("fs.read", json!({"path": "a.txt"}));
    p["attemptId"] = json!("attempt-evil");
    assert_eq!(e.priv_req("tool-execute", p)["ok"], false);
    let mut p = e.params("fs.read", json!({"path": "a.txt"}));
    p["leaseEpoch"] = json!(e.epoch + 7);
    assert_eq!(e.priv_req("tool-execute", p)["ok"], false);
    let mut p = e.params("fs.read", json!({"path": "a.txt"}));
    p["storeIncarnation"] = json!("forged-incarnation");
    assert_eq!(e.priv_req("tool-execute", p)["ok"], false);
    let mut p = e.params("fs.read", json!({"path": "a.txt"}));
    p["commandId"] = json!("cmd-not-bound");
    assert_eq!(e.priv_req("tool-execute", p)["ok"], false);
    assert!(e.all_phases().is_empty());

    // Duplicate request id.
    let p = e.params("fs.read", json!({"path": "a.txt"}));
    assert_ok(&e.priv_req("tool-execute", p.clone()));
    let dup = e.priv_req("tool-execute", p);
    assert_eq!(dup["ok"], false);
    assert_eq!(e.all_phases(), vec!["authorized", "started", "completed"]);

    // A newer generation supersedes the lease: old epoch is stale.
    let r = e.priv_req(
        "acquire",
        json!({"taskInstanceId": e.task, "backend": "native"}),
    );
    assert_ok(&r);
    let r = e.exec("fs.read", json!({"path": "a.txt"}));
    assert_eq!(r["ok"], false);
    assert!(
        r["message"].as_str().unwrap().contains("stale-lease"),
        "{r}"
    );
}

#[test]
fn hard_links_in_dependency_dirs_and_special_paths_are_refused_via_daemon() {
    let mut e = setup("hl");
    let outside = e.base.path().join("secret.txt");
    std::fs::write(&outside, "OUTSIDE-SECRET\n").unwrap();
    assert_ok(&e.bind());
    for d in ["node_modules", "target", "vendor"] {
        std::fs::create_dir_all(e.ws.join(d)).unwrap();
        std::fs::hard_link(&outside, e.ws.join(d).join("x.txt")).unwrap();
        let r = e.exec("fs.read", json!({"path": format!("{d}/x.txt")}));
        assert_ok(&r);
        assert_eq!(r["result"]["error"]["code"], "hardlink-refused", "{d}");
    }
    e.write(".env", b"TOKEN=abc\n");
    let r = e.exec("fs.read", json!({"path": ".env"}));
    assert_eq!(r["result"]["error"]["code"], "sensitive-path-refused");
}

// ------------------------------------------------- events & isolation

#[test]
fn tool_events_are_paged_isolated_and_replay_safe() {
    let mut e = setup("events");
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    for _ in 0..4 {
        assert_ok(&e.exec("fs.read", json!({"path": "a.txt"})));
    }
    // 12 records. Page by 5: no overlap, no gap, stable order.
    let mut seen = Vec::new();
    let mut cursor = 0i64;
    loop {
        let r = e.events(cursor, 5);
        assert_ok(&r);
        for rec in r["records"].as_array().unwrap() {
            seen.push(rec["seq"].as_i64().unwrap());
        }
        cursor = r["nextCursor"].as_i64().unwrap();
        if !r["hasMore"].as_bool().unwrap() {
            break;
        }
    }
    assert_eq!(seen.len(), 12);
    assert!(seen.windows(2).all(|w| w[0] < w[1]));
    // Re-reading from a mid cursor ("reconnect") yields exactly the tail.
    let r = e.events(seen[5], 200);
    let tail: Vec<i64> = r["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(tail, seen[6..].to_vec());
    // Page size is capped.
    let r = e.events(0, 100000);
    assert_eq!(r["pageSize"], 200);
    // Cross-task / cross-attempt / unknown scope: refused, no data.
    let other = raw_request(
        &e.d.socket,
        &json!({"protocol":1,"id":"x","cmd":"tool-events","params":{
            "taskInstanceId": "some-other-task", "attemptId": e.attempt}})
        .to_string(),
    )
    .unwrap();
    assert_eq!(other["ok"], false);
    assert!(other.get("records").is_none());
    let other = raw_request(
        &e.d.socket,
        &json!({"protocol":1,"id":"x","cmd":"tool-events","params":{
            "taskInstanceId": e.task, "attemptId": "attempt-other"}})
        .to_string(),
    )
    .unwrap();
    assert_eq!(other["ok"], false);
    // Unknown parameters (e.g. a path or root) are rejected.
    let bad = raw_request(
        &e.d.socket,
        &json!({"protocol":1,"id":"x","cmd":"tool-events","params":{
            "taskInstanceId": e.task, "attemptId": e.attempt, "root": "/"}})
        .to_string(),
    )
    .unwrap();
    assert_refused(&bad, "bad-request");
    // Projection never carries roots, file content or query text.
    let dump = e.events(0, 200).to_string();
    assert!(!dump.contains(e.ws.to_str().unwrap()));
}

#[test]
fn secrets_are_redacted_and_events_never_carry_raw_content_or_queries() {
    let mut e = setup("redact");
    e.write("cfg.txt", b"api_token = \"topsecretvalue99\"\nhello\n");
    assert_ok(&e.bind());
    let r = e.exec("fs.read", json!({"path": "cfg.txt"}));
    assert_ok(&r);
    assert!(!r.to_string().contains("topsecretvalue99"));
    assert_eq!(r["result"]["redaction"]["redacted"], true);
    let s = e.exec("fs.search", json!({"query": "topsecretvalue"}));
    assert_ok(&s);
    assert_eq!(s["result"]["stats"]["matchesReturned"], 0);
    let ev = e.events(0, 200).to_string();
    assert!(!ev.contains("topsecretvalue99") && !ev.contains("topsecretvalue"));
    // Oversized output stays bounded and is flagged.
    let mut big = String::new();
    for i in 0..4000 {
        big.push_str(&format!("line {i} lorem ipsum dolor\n"));
    }
    e.write("big.txt", big.as_bytes());
    let mut p = e.params("fs.read", json!({"path": "big.txt"}));
    p["budgets"] = json!({"maxOutputBytes": 2048});
    let r = e.priv_req("tool-execute", p);
    assert_ok(&r);
    assert_eq!(r["result"]["truncation"]["truncated"], true);
    assert!(r["result"]["output"]["content"].as_str().unwrap().len() <= 2048);
}

// ------------------------------------------- fencing, crash, recovery

fn big_tree(e: &Env) {
    for d in 0..60 {
        let dir = e.ws.join(format!("d{d:02}"));
        std::fs::create_dir_all(&dir).unwrap();
        for f in 0..300 {
            std::fs::write(dir.join(format!("f{f:03}.txt")), "nothing here\n").unwrap();
        }
    }
}

#[test]
fn revocation_during_recursive_search_stops_reads_and_is_journaled() {
    let mut e = setup("revoke");
    big_tree(&e);
    assert_ok(&e.bind());
    let mut p = e.params("fs.search", json!({"query": "zzz-never-present"}));
    p["budgets"] = json!({"maxFiles": 20000, "maxDirs": 1000, "maxScanBytes": 200_000_000u64});
    let sock = e.d.socket.clone();
    let frame = authed_frame(&e.cap, "tool-execute", p);
    let t = std::thread::spawn(move || raw_request(&sock, &frame).unwrap());
    // Let the scan start, then revoke through the authenticated channel.
    std::thread::sleep(Duration::from_millis(60));
    assert_ok(&e.priv_req(
        "tool-revoke",
        json!({"commandId": e.command, "reason": "test"}),
    ));
    let r = t.join().unwrap();
    assert_ok(&r);
    assert_eq!(r["result"]["error"]["code"], "revoked", "{r}");
    let scanned = r["result"]["stats"]["filesScanned"].as_u64().unwrap();
    assert!(scanned < 18000, "scan ran to completion: {scanned}");
    // Journaled accurately as a cancelled completion; new requests refused.
    let ev = e.events(0, 200);
    let last = ev["records"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["phase"], "completed");
    assert_eq!(last["errorCode"], "revoked");
    let again = e.exec("fs.list", json!({}));
    assert_eq!(again["ok"], false);
}

#[test]
fn lease_supersession_during_search_stops_the_scan() {
    let mut e = setup("lease-mid");
    big_tree(&e);
    assert_ok(&e.bind());
    let mut p = e.params("fs.search", json!({"query": "zzz-never-present"}));
    p["budgets"] = json!({"maxFiles": 20000, "maxDirs": 1000, "maxScanBytes": 200_000_000u64});
    let sock = e.d.socket.clone();
    let frame = authed_frame(&e.cap, "tool-execute", p);
    let t = std::thread::spawn(move || raw_request(&sock, &frame).unwrap());
    std::thread::sleep(Duration::from_millis(60));
    assert_ok(&e.priv_req(
        "acquire",
        json!({"taskInstanceId": e.task, "backend": "native"}),
    ));
    let r = t.join().unwrap();
    assert_ok(&r);
    assert_eq!(r["result"]["error"]["code"], "revoked", "{r}");
}

#[test]
fn daemon_crash_mid_execution_is_interrupted_never_replayed() {
    let mut e = setup("crash");
    big_tree(&e);
    assert_ok(&e.bind());
    let mut p = e.params("fs.search", json!({"query": "zzz-never-present"}));
    p["budgets"] = json!({"maxFiles": 20000, "maxDirs": 1000, "maxScanBytes": 200_000_000u64});
    let rid = p["requestId"].as_str().unwrap().to_owned();
    let sock = e.d.socket.clone();
    let frame = authed_frame(&e.cap, "tool-execute", p.clone());
    let t = std::thread::spawn(move || raw_request(&sock, &frame));
    // Wait until `started` is journaled, then SIGKILL the daemon.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if e.all_phases().iter().any(|p| p == "started") {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    crash(&mut e.d.child);
    let _ = t.join();
    let _ = std::fs::remove_file(&e.d.socket);

    // Restart: startup reconciliation closes the open request honestly.
    let mut child = respawn(&e.d, &std::fs::canonicalize(e.base.path()).unwrap());
    e.cap = read_cap(&e.d.cap);
    let phases = e.all_phases();
    assert_eq!(
        phases,
        vec!["authorized", "started", "interrupted"],
        "{phases:?}"
    );
    let ev = e.events(0, 200);
    let rec = ev["records"].as_array().unwrap().last().unwrap().clone();
    assert!(rec["reason"]
        .as_str()
        .unwrap()
        .contains("never re-executed"));
    // The same request id can never execute again; a fresh one can.
    p["requestId"] = json!(rid);
    let r = e.priv_req("tool-execute", p);
    assert_eq!(r["ok"], false);
    assert_ok(&e.exec("fs.list", json!({})));
    // No `completed` was invented for the interrupted request.
    assert_eq!(
        e.all_phases().iter().filter(|p| *p == "completed").count(),
        1
    );
    terminate(&mut child);
}

#[test]
fn revocation_survives_daemon_restart() {
    let mut e = setup("revoke-restart");
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    assert_ok(&e.priv_req("tool-revoke", json!({"commandId": e.command})));
    terminate(&mut e.d.child);
    let mut child = respawn(&e.d, &std::fs::canonicalize(e.base.path()).unwrap());
    e.cap = read_cap(&e.d.cap);
    let r = e.exec("fs.read", json!({"path": "a.txt"}));
    assert_eq!(r["ok"], false);
    assert!(
        r["message"].as_str().unwrap().contains("intent-fenced")
            || r["message"].as_str().unwrap().contains("revoked"),
        "{r}"
    );
    terminate(&mut child);
}

#[test]
fn journal_witness_inconsistency_fails_closed_at_startup() {
    let mut e = setup("inconsistent");
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    for _ in 0..3 {
        assert_ok(&e.exec("fs.read", json!({"path": "a.txt"})));
    }
    terminate(&mut e.d.child);
    let conn = rusqlite::Connection::open(&e.d.db).unwrap();
    conn.execute("DELETE FROM tool_journal WHERE seq > 4", [])
        .unwrap();
    drop(conn);
    let out = Command::new(nexusd_bin())
        .arg("--db")
        .arg(&e.d.db)
        .arg("--socket")
        .arg(&e.d.socket)
        .arg("--cap")
        .arg(&e.d.cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&e.d.witness)
        .output()
        .unwrap();
    assert!(!out.status.success(), "daemon must refuse to start");
    let text =
        String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("inconsistent") || text.contains("store-corrupt"),
        "{text}"
    );
}

#[test]
fn ipc_disconnect_mid_request_is_exactly_once_and_recoverable() {
    use std::io::Write;
    let mut e = setup("disc");
    big_tree(&e);
    assert_ok(&e.bind());
    let mut p = e.params("fs.search", json!({"query": "zzz-never-present"}));
    p["budgets"] = json!({"maxFiles": 3000});
    let frame = authed_frame(&e.cap, "tool-execute", p.clone());
    {
        let mut s = std::os::unix::net::UnixStream::connect(&e.d.socket).unwrap();
        s.write_all(frame.as_bytes()).unwrap();
        s.write_all(b"\n").unwrap();
        // Drop immediately without reading the response.
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while !e.all_phases().iter().any(|p| p == "completed") {
        assert!(Instant::now() < deadline, "execution never completed");
        std::thread::sleep(Duration::from_millis(20));
    }
    // A retry with the same request id is a conflict, not a second run.
    let r = e.priv_req("tool-execute", p);
    assert_eq!(r["ok"], false);
    assert_eq!(e.all_phases(), vec!["authorized", "started", "completed"]);
}

#[test]
fn concurrent_executions_are_bounded_and_journal_consistently() {
    let mut e = setup("conc");
    for i in 0..50 {
        e.write(&format!("f{i}.txt"), b"needle\n");
    }
    assert_ok(&e.bind());
    let mut hs = Vec::new();
    for i in 0..10 {
        let p = e.params("fs.search", json!({"query": "needle"}));
        let sock = e.d.socket.clone();
        let frame = authed_frame(&e.cap, "tool-execute", p);
        let _ = i;
        hs.push(std::thread::spawn(move || {
            raw_request(&sock, &frame).unwrap()
        }));
    }
    let rs: Vec<Value> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    let ok = rs.iter().filter(|r| r["ok"] == true).count();
    let busy = rs.iter().filter(|r| code_of(r) == "server-busy").count();
    assert_eq!(ok + busy, 10, "{rs:?}");
    assert!(ok >= 1);
    let phases = e.all_phases();
    assert_eq!(phases.iter().filter(|p| *p == "completed").count(), ok);
    assert_eq!(phases.len(), ok * 3);
}

#[test]
fn dispatch_remains_disabled_and_status_is_unchanged() {
    let e = setup("status");
    let r = raw_request(
        &e.d.socket,
        &json!({"protocol":1,"id":"s","cmd":"status","params":{}}).to_string(),
    )
    .unwrap();
    assert_ok(&r);
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
}

#[test]
fn client_api_reads_real_events_from_the_daemon_with_cursor_resume() {
    let mut e = setup("client");
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    assert_ok(&e.exec("fs.read", json!({"path": "a.txt"})));
    assert_ok(&e.exec("fs.list", json!({})));
    let cfg = nexus_client::ClientConfig::resolve(Some(e.d.socket.clone()), None, true).unwrap();
    let (events, cursor, complete) =
        nexus_client::tool_events_folded(&cfg, &e.task, &e.attempt, 0).unwrap();
    assert!(complete);
    assert_eq!(events.len(), 2);
    assert!(events
        .iter()
        .all(|x| x.status == nexus_client::ToolEventStatus::Completed && !x.ai_initiated));
    assert_eq!(events[0].tool_id, "fs.read");
    // Resume from the cursor: nothing new, then exactly the new request.
    let (again, c2, _) =
        nexus_client::tool_events_folded(&cfg, &e.task, &e.attempt, cursor).unwrap();
    assert!(again.is_empty() && c2 == cursor);
    assert_ok(&e.exec("fs.read", json!({"path": "a.txt"})));
    let (more, _, _) = nexus_client::tool_events_folded(&cfg, &e.task, &e.attempt, cursor).unwrap();
    assert_eq!(more.len(), 1);
    // Cross-task access is refused through the client too.
    let err = nexus_client::tool_events(&cfg, "other-task", &e.attempt, 0, 10).unwrap_err();
    assert!(!err.message.is_empty());
}

#[test]
fn valid_issuer_cannot_bind_a_different_allowed_workspace_or_an_uncommitted_intent() {
    let mut e = setup("commit");
    // Another directory beneath the SAME allowed base.
    let sib = e.base.path().join("sibling");
    std::fs::create_dir_all(&sib).unwrap();
    let sib = std::fs::canonicalize(&sib).unwrap();
    let r = e.priv_req(
        "workspace-bind",
        json!({"commandId": e.command, "root": sib.to_str().unwrap()}),
    );
    assert_refused(&r, "binding-mismatch");
    // A command whose accepted intent carries no workspace commitment can
    // never be bound, even to a root beneath an allowed base.
    let rec = accept_one(
        &e.d.socket,
        &e.cap,
        "task-nocommit",
        "attempt-nocommit",
        "cmd-nocommit",
    );
    assert_ok(&rec);
    let r = e.priv_req(
        "workspace-bind",
        json!({"commandId": "cmd-nocommit", "root": e.ws.to_str().unwrap()}),
    );
    assert_refused(&r, "scope-refused");
    // The committed root binds fine and execution proceeds.
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    assert_ok(&e.exec("fs.read", json!({"path": "a.txt"})));
}

fn write_attempts(runs: &Path, display: &str, instance: &str, attempts: &[(&str, u64)]) {
    let dir = runs.join(display);
    std::fs::create_dir_all(&dir).unwrap();
    let mut body = String::new();
    for (aid, seq) in attempts {
        body.push_str(
            &json!({"taskId": display, "taskInstanceId": instance, "attemptId": aid,
                    "sequence": seq, "status": "started", "executionClass": "muse_main"})
            .to_string(),
        );
        body.push('\n');
    }
    std::fs::write(dir.join("attempts.jsonl"), body).unwrap();
}

#[test]
fn task_events_use_authoritative_attempts_and_never_merge_tasks_or_attempts() {
    let mut e = setup("auth-attempts");
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    assert_ok(&e.exec("fs.read", json!({"path": "a.txt"})));
    let runs = tempfile::tempdir().unwrap();
    // The Controller journal lists this task's real attempt, a stale
    // attempt the kernel never accepted, and a DIFFERENT task instance.
    write_attempts(
        runs.path(),
        "TASK-1",
        &e.task,
        &[(e.attempt.as_str(), 1), ("attempt-stale", 2)],
    );
    write_attempts(
        runs.path(),
        "TASK-2",
        "other-instance",
        &[("other-attempt", 1)],
    );
    let mut cfg =
        nexus_client::ClientConfig::resolve(Some(e.d.socket.clone()), None, true).unwrap();
    cfg.runs_dir = Some(runs.path().to_path_buf());
    let t = nexus_client::tool_events_for_task(&cfg, &e.task).unwrap();
    assert!(t.available);
    assert_eq!(t.attempts.len(), 2);
    assert_eq!(t.attempts[0].attempt_id, e.attempt);
    assert_eq!(t.attempts[0].events.len(), 1);
    assert!(t.attempts[0]
        .events
        .iter()
        .all(|x| x.task_instance_id == e.task && x.attempt_id == e.attempt));
    assert_eq!(t.attempts[0].events[0].lease_epoch, Some(e.epoch));
    // Stale/unknown attempt: reported per attempt, no events, never merged.
    assert_eq!(t.attempts[1].attempt_id, "attempt-stale");
    assert!(t.attempts[1].events.is_empty());
    assert!(t.attempts[1].error.is_some());
    // The other task's attempt can never be read through this task, and
    // querying that foreign instance returns nothing of ours.
    let other = nexus_client::tool_events_for_task(&cfg, "other-instance").unwrap();
    assert!(other.attempts.iter().all(|a| a.events.is_empty()));
    // Without an authoritative attempt list: explicit unavailable, no guess.
    cfg.runs_dir = None;
    let none = nexus_client::tool_events_for_task(&cfg, &e.task).unwrap();
    assert!(!none.available && none.attempts.is_empty() && none.reason.is_some());
    let empty = tempfile::tempdir().unwrap();
    cfg.runs_dir = Some(empty.path().to_path_buf());
    let none = nexus_client::tool_events_for_task(&cfg, &e.task).unwrap();
    assert!(!none.available);
}

#[test]
fn peer_uid_gate_covers_privileged_tool_ops_and_tool_events() {
    // Allowlist names a UID that is not ours: the cap key alone must not
    // be enough, and tool-events must be refused to a non-listed peer.
    let base = tempfile::tempdir().unwrap();
    let basep = std::fs::canonicalize(base.path()).unwrap();
    let mut d = spawn_daemon_opts(
        "shadow-test",
        true,
        &[
            "--allowed-uids",
            "4242",
            "--workspace-bases",
            basep.to_str().unwrap(),
        ],
    );
    let cap = read_cap(&d.cap);
    for (cmd, params) in [
        (
            "workspace-bind",
            json!({"commandId": "c", "root": basep.to_str().unwrap()}),
        ),
        ("tool-execute", json!({"requestId": "r"})),
        ("tool-revoke", json!({"commandId": "c"})),
    ] {
        let r = raw_request(&d.socket, &authed_frame(&cap, cmd, params)).unwrap();
        assert_refused(&r, "peer-unauthorized");
    }
    let r = raw_request(
        &d.socket,
        &json!({"protocol":1,"id":"e","cmd":"tool-events","params":{
            "taskInstanceId":"t","attemptId":"a"}})
        .to_string(),
    )
    .unwrap();
    assert_refused(&r, "peer-unauthorized");
    // Unrelated read-only commands are unaffected by the gate.
    let r = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"h","cmd":"health","params":{}}"#,
    )
    .unwrap();
    assert_ok(&r);
    terminate(&mut d.child);
}

#[test]
fn bind_and_revoke_are_replay_protected_and_tool_events_cannot_mutate() {
    let e = setup("replay2");
    let frame = authed_frame(
        &e.cap,
        "workspace-bind",
        json!({"commandId": e.command, "root": e.ws.to_str().unwrap()}),
    );
    assert_ok(&raw_request(&e.d.socket, &frame).unwrap());
    assert_refused(
        &raw_request(&e.d.socket, &frame).unwrap(),
        "replay-rejected",
    );
    let frame = authed_frame(&e.cap, "tool-revoke", json!({"commandId": e.command}));
    assert_ok(&raw_request(&e.d.socket, &frame).unwrap());
    assert_refused(
        &raw_request(&e.d.socket, &frame).unwrap(),
        "replay-rejected",
    );
    // tool-events with injected privileged-looking parameters is rejected
    // outright; it has no write or execute semantics.
    for extra in ["requestId", "toolId", "args", "commandId", "reason"] {
        let mut p = json!({"taskInstanceId": e.task, "attemptId": e.attempt});
        p[extra] = json!("x");
        let r = raw_request(
            &e.d.socket,
            &json!({"protocol":1,"id":"x","cmd":"tool-events","params":p}).to_string(),
        )
        .unwrap();
        assert_refused(&r, "bad-request");
    }
    assert!(e.all_phases().is_empty());
}

#[test]
fn journal_corruption_while_running_latches_reconciliation() {
    let mut e = setup("latch");
    e.write("a.txt", b"x\n");
    assert_ok(&e.bind());
    for _ in 0..3 {
        assert_ok(&e.exec("fs.read", json!({"path": "a.txt"})));
    }
    // Truncate the journal under the running daemon.
    let conn = rusqlite::Connection::open(&e.d.db).unwrap();
    conn.execute("DELETE FROM tool_journal WHERE seq > 3", [])
        .unwrap();
    drop(conn);
    let r = e.exec("fs.read", json!({"path": "a.txt"}));
    assert_eq!(r["ok"], false);
    assert!(
        r["message"].as_str().unwrap().contains("store-corrupt"),
        "{r}"
    );
    let st = raw_request(
        &e.d.socket,
        &json!({"protocol":1,"id":"s","cmd":"status","params":{}}).to_string(),
    )
    .unwrap();
    assert_eq!(st["reconciliationRequired"], true, "{st}");
}
