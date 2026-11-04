//! A3.4 trusted sandboxed-process integration over the real nexusd IPC
//! boundary: real daemon, real sockets, real bubblewrap sandbox, real
//! cargo build scripts. NOT RUN (and daemon refuses to enable processes)
//! when the host cannot provide the sandbox.

mod common;

use common::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The execution cgroups are a host-wide namespace: tests that assert on
/// them must not overlap.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

fn sha(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

fn host_ready(test: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available {
        println!("NOT RUN ({test}): sandbox unavailable: {:?}", c.problems);
        return false;
    }
    let tc = nexus_tools::process::Toolchain::discover();
    if tc.cargo_home_bin.is_none() || tc.rustup_home.is_none() {
        println!("NOT RUN ({test}): no cargo toolchain");
        return false;
    }
    true
}

struct P {
    d: DaemonProc,
    cap: String,
    approver_cap: String,
    approver_cap_path: PathBuf,
    base: tempfile::TempDir,
    _acap: tempfile::TempDir,
    ws: PathBuf,
    task: String,
    attempt: String,
    command: String,
    epoch: u64,
    inc: String,
    root_digest: String,
    n: u32,
}

fn setup(tag: &str, envs: &[(&str, &str)], approve: bool) -> P {
    use std::os::unix::fs::PermissionsExt;
    let base = tempfile::tempdir().unwrap();
    let basep = std::fs::canonicalize(base.path()).unwrap();
    let ws = basep.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let acap = tempfile::tempdir().unwrap();
    std::fs::set_permissions(acap.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let approver_cap_path = acap.path().join("approver.cap");
    let uid = euid().to_string();
    let args: Vec<String> = vec![
        "--workspace-bases".into(),
        basep.to_str().unwrap().into(),
        "--allowed-uids".into(),
        uid.clone(),
        "--enable-process".into(),
        "--approver-cap".into(),
        approver_cap_path.to_str().unwrap().into(),
        "--approver-uids".into(),
        uid,
        "--allow-nonindependent-approver-test-only".into(),
    ];
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
    let r = rec.get("receipt").unwrap();
    let mut p = P {
        d,
        cap,
        approver_cap,
        approver_cap_path,
        base,
        _acap: acap,
        ws,
        task,
        attempt,
        command,
        epoch: r["leaseEpoch"].as_u64().unwrap(),
        inc: r["storeIncarnation"].as_str().unwrap().to_owned(),
        root_digest,
        n: 0,
    };
    assert_ok(&p.issuer(
        "workspace-bind",
        json!({"commandId": p.command, "root": p.ws.to_str().unwrap()}),
    ));
    if approve {
        assert_ok(&p.approve(600_000));
    }
    p.n = 0;
    p
}

/// A panicking test must never leak a daemon (and its sandboxes).
impl Drop for P {
    fn drop(&mut self) {
        let _ = self.d.child.kill();
        let _ = self.d.child.wait();
    }
}

impl P {
    fn issuer(&self, cmd: &str, params: Value) -> Value {
        raw_request(&self.d.socket, &authed_frame(&self.cap, cmd, params)).unwrap()
    }
    fn approve(&self, max_wall: u64) -> Value {
        raw_request(
            &self.d.socket,
            &authed_frame(
                &self.approver_cap,
                "process-scope-approve",
                json!({"commandId": self.command, "workspaceRootDigest": self.root_digest,
                       "maxWallMs": max_wall, "approverId": "test-approver"}),
            ),
        )
        .unwrap()
    }
    fn params(&mut self, args: Value) -> Value {
        self.n += 1;
        json!({
            "requestId": format!("p-{}-{}", self.command, self.n),
            "cancellationId": format!("pc-{}-{}", self.command, self.n),
            "taskInstanceId": self.task, "attemptId": self.attempt, "commandId": self.command,
            "leaseEpoch": self.epoch, "storeIncarnation": self.inc,
            "toolId": "proc.run", "toolVersion": 1, "args": args,
        })
    }
    fn exec(&mut self, args: Value) -> Value {
        let p = self.params(args);
        self.issuer("tool-execute", p)
    }
    fn cargo(&mut self, extra: &[&str]) -> Value {
        let mut a = vec!["check", "--offline", "--locked"];
        a.extend_from_slice(extra);
        self.exec(json!({"program": "cargo", "args": a, "cwd": "."}))
    }
    fn write(&self, rel: &str, c: &str) {
        let p = self.ws.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, c).unwrap();
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
    fn project(&self, build_rs: Option<&str>) {
        self.write(
            "Cargo.toml",
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\nbuild = \"build.rs\"\n",
        );
        self.write(
            "Cargo.lock",
            "# This file is automatically @generated by Cargo.\nversion = 3\n\n[[package]]\nname = \"demo\"\nversion = \"0.1.0\"\n",
        );
        self.write("src/main.rs", "fn main() {}\n");
        self.write("build.rs", build_rs.unwrap_or("fn main() {}\n"));
    }
}

fn exec_cgroups_nonempty() -> Vec<String> {
    // Both resource backends: the daemon's own cgroup directory (polling)
    // and the systemd user-manager scopes (kernel-enforced limits).
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(base) = nexus_tools::sandbox::cgroup_base() {
        dirs.push(base);
    }
    if let Some(p) = nexus_tools::sandbox::expected_scope_path("x") {
        if let Some(parent) = p.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    let mut v = Vec::new();
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with("nexus-exec-") {
                let procs =
                    std::fs::read_to_string(e.path().join("cgroup.procs")).unwrap_or_default();
                if !procs.trim().is_empty() {
                    v.push(n);
                }
            }
        }
    }
    v
}

// --------------------------------------------------------- authority

#[test]
fn process_execution_needs_independent_scope_and_is_disabled_by_default() {
    let _g = serial();
    if !host_ready("proc-authority") {
        return;
    }
    let mut p = setup("authority", &[], false);
    p.project(None);
    // No approval: the issuer cannot run anything.
    assert_refused(&p.cargo(&[]), "scope-refused");
    // The issuer key cannot approve; the approver key cannot execute.
    let r = raw_request(
        &p.d.socket,
        &authed_frame(&p.cap, "process-scope-approve",
            json!({"commandId": p.command, "workspaceRootDigest": p.root_digest, "maxWallMs": 1000})),
    )
    .unwrap();
    assert_refused(&r, "issuer-untrusted");
    let params = p.params(json!({"program": "cargo", "args": ["check", "--offline"]}));
    let r = raw_request(
        &p.d.socket,
        &authed_frame(&p.approver_cap, "tool-execute", params),
    )
    .unwrap();
    assert_refused(&r, "issuer-untrusted");
    // Approving another workspace digest is refused.
    let r = raw_request(
        &p.d.socket,
        &authed_frame(&p.approver_cap, "process-scope-approve",
            json!({"commandId": p.command, "workspaceRootDigest": sha("/elsewhere"), "maxWallMs": 1000})),
    )
    .unwrap();
    assert_refused(&r, "binding-mismatch");
    // A WRITE scope does not authorize a process (and none exists here).
    assert!(p.phases().is_empty(), "no journal rows from refusals");
    // Approve properly; commands outside the policy are still refused.
    assert_ok(&p.approve(300_000));
    for args in [
        json!({"program": "sh", "args": ["-c", "id"]}),
        json!({"program": "/bin/sh", "args": ["-c", "id"]}),
        json!({"program": "cargo", "args": ["install", "evil"]}),
        json!({"program": "cargo", "args": ["check"]}),
        json!({"program": "python3", "args": ["-c", "pass"]}),
        json!({"program": "cargo", "args": ["check", "--offline"], "shell": "id"}),
    ] {
        let r = p.exec(args.clone());
        assert_eq!(r["ok"], false, "{args}");
    }
    assert!(p.phases().is_empty(), "refused commands mint no grants");
    // A replayed approval frame is rejected.
    let frame = authed_frame(
        &p.approver_cap,
        "process-scope-approve",
        json!({"commandId": p.command, "workspaceRootDigest": p.root_digest, "maxWallMs": 300_000}),
    );
    let _ = raw_request(&p.d.socket, &frame).unwrap();
    assert_refused(
        &raw_request(&p.d.socket, &frame).unwrap(),
        "replay-rejected",
    );
}

#[test]
fn process_execution_is_off_unless_enabled() {
    let _g = serial();
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
    let rec = accept_one_ws(
        &d.socket,
        &cap,
        "t-off",
        "a-off",
        "c-off",
        &sha(ws.to_str().unwrap()),
    );
    let rc = rec["receipt"].clone();
    assert_ok(
        &raw_request(
            &d.socket,
            &authed_frame(
                &cap,
                "workspace-bind",
                json!({"commandId": "c-off", "root": ws.to_str().unwrap()}),
            ),
        )
        .unwrap(),
    );
    let r = raw_request(
        &d.socket,
        &authed_frame(&cap, "tool-execute", json!({
            "requestId": "r1", "cancellationId": "c1", "taskInstanceId": "t-off", "attemptId": "a-off",
            "commandId": "c-off", "leaseEpoch": rc["leaseEpoch"], "storeIncarnation": rc["storeIncarnation"],
            "toolId": "proc.run", "toolVersion": 1,
            "args": {"program": "cargo", "args": ["check", "--offline", "--locked"]}})),
    )
    .unwrap();
    assert_refused(&r, "process-disabled");
    terminate(&mut d.child);
    // --enable-process without the approver configuration refuses to start.
    let dir = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let out = Command::new(nexusd_bin())
        .arg("--db")
        .arg(dir.path().join("k.db"))
        .arg("--socket")
        .arg(dir.path().join("s.sock"))
        .arg("--cap")
        .arg(dir.path().join("c.cap"))
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--enable-process")
        .output()
        .unwrap();
    assert!(!out.status.success());
}

// ------------------------------------------------- real build execution

#[test]
fn cargo_check_runs_in_the_sandbox_over_a_snapshot_and_nothing_is_written_back() {
    let _g = serial();
    if !host_ready("proc-cargo-e2e") {
        return;
    }
    let mut p = setup("e2e", &[], true);
    p.project(None);
    p.write(".env", "TOKEN=must-not-be-staged\n");
    p.write("id_rsa", "PRIVATE\n");
    let r = p.cargo(&[]);
    assert_ok(&r);
    let out = &r["result"]["output"];
    assert_eq!(out["verification"], "pass", "{out}");
    assert_eq!(out["exitCode"], 0);
    assert_eq!(out["network"], "none");
    assert_eq!(out["writeBack"], "none");
    let enforcement = out["resourceEnforcement"].as_str().unwrap().to_owned();
    assert!(enforcement == "kernel-cgroup" || enforcement == "rlimit-polling");
    assert_eq!(
        enforcement == "kernel-cgroup",
        nexus_tools::sandbox::kernel_limits_available()
    );
    assert_eq!(r["execution"]["scope"], "process");
    assert_eq!(r["execution"]["aiInitiated"], false);
    assert_eq!(r["execution"]["testOnlyApproval"], true);
    // Real project: no artifacts, no lockfile changes, no target dir.
    assert!(!p.ws.join("target").exists());
    // Lifecycle records visible through the read-only API.
    assert_eq!(
        p.phases(),
        vec!["authorized", "started", "prepared", "running", "exited"]
    );
    let ev = p.events();
    let prepared = ev.iter().find(|e| e["phase"] == "prepared").unwrap();
    assert_eq!(prepared["process"]["sandbox"]["network"], "none");
    assert!(
        prepared["process"]["snapshotDigest"]
            .as_str()
            .unwrap()
            .len()
            == 64
    );
    assert!(prepared["process"]["command"]
        .as_str()
        .unwrap()
        .starts_with("cargo check"));
    let exited = ev.iter().find(|e| e["phase"] == "exited").unwrap();
    assert_eq!(exited["process"]["exitCode"], 0);
    assert_eq!(exited["process"]["verification"], "pass");
    assert!(exited["process"]["wallMs"].as_u64().is_some());
    // Events carry a bounded redacted tail but never the staged secrets.
    let dump = serde_json::to_string(&ev).unwrap();
    assert!(!dump.contains("must-not-be-staged") && !dump.contains("PRIVATE"));
    // No execution directory or cgroup is left behind.
    assert!(exec_cgroups_nonempty().is_empty());
}

#[test]
fn malicious_build_script_cannot_reach_host_secrets_network_or_the_project() {
    let _g = serial();
    if !host_ready("proc-malicious") {
        return;
    }
    let canary_dir = tempfile::tempdir().unwrap();
    let canary = canary_dir.path().join("host-secret.txt");
    std::fs::write(&canary, "HOST-SECRET-CANARY").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let mut p = setup(
        "malicious",
        &[("NEXUS_ISSUER_CAP_CANARY", "capability-canary-value")],
        true,
    );
    let (issuer_cap, socket_path) = (p.d.cap.clone(), p.d.socket.clone());
    let (approver_cap, db_path) = (p.approver_cap_path.clone(), p.d.db.clone());
    let build = format!(
        r#"
use std::io::Write;
fn main() {{
    let mut r = Vec::<String>::new();
    for (n, path) in [("issuer_cap", {issuer_cap:?}), ("approver_cap", {approver_cap:?}),
                      ("kernel_db", {db_path:?}), ("daemon_socket", {socket_path:?})] {{
        r.push(format!("{{n}}_exists={{}}", std::path::Path::new(path).exists()));
        r.push(format!("{{n}}_read={{}}", std::fs::read(path).is_ok()));
    }}
    r.push(format!("socket_connect={{}}", std::os::unix::net::UnixStream::connect({socket_path:?}).is_ok()));
    r.push(format!("canary_read={{:?}}", std::fs::read_to_string({canary:?}).is_ok()));
    r.push(format!("etc_shadow={{}}", std::fs::read_to_string("/etc/shadow").is_ok()));
    r.push(format!("home_listing={{:?}}", std::fs::read_dir("/home").is_ok()));
    r.push(format!("ssh={{:?}}", std::env::var("HOME").ok().map(|h| std::path::Path::new(&h).join(".ssh").exists())));
    r.push(format!("writeback={{}}", std::fs::write("/work/src/BACKDOOR.rs", "evil").is_ok()));
    r.push(format!("net_loopback={{}}", std::net::TcpStream::connect_timeout(&"127.0.0.1:{port}".parse().unwrap(), std::time::Duration::from_secs(2)).is_ok()));
    r.push(format!("net_external={{}}", std::net::TcpStream::connect_timeout(&"1.1.1.1:53".parse().unwrap(), std::time::Duration::from_secs(2)).is_ok()));
    let env: Vec<String> = std::env::vars().map(|(k, _)| k).filter(|k| k.contains("CANARY") || k.contains("NEXUS")).collect();
    r.push(format!("leaked_env={{:?}}", env));
    r.push(format!("fds={{}}", std::fs::read_dir("/proc/self/fd").map(|d| d.count()).unwrap_or(0)));
    let _ = std::process::Command::new("/usr/bin/sleep").arg("1000").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
    let _ = std::io::stderr().write_all(format!("RESULT {{}}\n", r.join(";")).as_bytes());
    std::process::exit(7);
}}
"#,
        canary = canary.display().to_string(),
        port = port,
        issuer_cap = issuer_cap.display().to_string(),
        approver_cap = approver_cap.display().to_string(),
        db_path = db_path.display().to_string(),
        socket_path = socket_path.display().to_string()
    );
    p.project(Some(&build));
    let r = p.cargo(&[]);
    assert_ok(&r);
    let out = &r["result"]["output"];
    assert_eq!(out["verification"], "fail"); // build script exited 7
    let stderr = out["stderr"].as_str().unwrap();
    let line = stderr
        .lines()
        .find(|l| l.contains("RESULT "))
        .unwrap_or_else(|| panic!("{stderr}"));
    for must in [
        "canary_read=false",
        "etc_shadow=false",
        "home_listing=false",
        "writeback=false",
        "net_loopback=false",
        "net_external=false",
        "leaked_env=[]",
        "issuer_cap_exists=false",
        "issuer_cap_read=false",
        "approver_cap_exists=false",
        "approver_cap_read=false",
        "kernel_db_exists=false",
        "kernel_db_read=false",
        "daemon_socket_exists=false",
        "socket_connect=false",
    ] {
        assert!(line.contains(must), "expected `{must}` in {line}");
    }
    assert!(!line.contains("ssh=Some(true)"), "{line}");
    assert!(listener.accept().is_err(), "host listener was contacted");
    assert!(!p.ws.join("BACKDOOR.rs").exists());
    assert_eq!(
        std::fs::read_to_string(p.ws.join("src/main.rs")).unwrap(),
        "fn main() {}\n"
    );
    // The background `sleep 1000` the build script spawned is gone.
    std::thread::sleep(Duration::from_millis(500));
    assert!(exec_cgroups_nonempty().is_empty());
    // The persisted record contains no capability material.
    let dump = serde_json::to_string(&p.events()).unwrap();
    assert!(!dump.contains("capability-canary-value"));
}

#[test]
fn output_flood_is_bounded_and_redacted_in_response_and_records() {
    let _g = serial();
    if !host_ready("proc-flood") {
        return;
    }
    let mut p = setup("flood", &[], true);
    p.project(Some(
        r#"
fn main() {
    let line = "x".repeat(1000);
    for _ in 0..20000 { eprintln!("{line}"); }
    eprintln!("api_token = \"supersecretvalue123456\"");
    std::process::exit(3);
}
"#,
    ));
    let r = p.exec(
        json!({"program": "cargo", "args": ["check", "--offline", "--locked"],
                          "cwd": "."}),
    );
    assert_ok(&r);
    let out = &r["result"]["output"];
    assert_eq!(out["stderrTruncated"], true);
    assert!(
        out["stderr"].as_str().unwrap().len() <= 300 * 1024,
        "unbounded response"
    );
    assert!(!r.to_string().contains("supersecretvalue123456"));
    let dump = serde_json::to_string(&p.events()).unwrap();
    assert!(!dump.contains("supersecretvalue123456"));
    assert!(
        dump.len() < 200 * 1024,
        "persisted diagnostics must be bounded: {}",
        dump.len()
    );
}

#[test]
fn revocation_and_scope_cap_stop_running_builds_and_are_recorded() {
    let _g = serial();
    if !host_ready("proc-fence") {
        return;
    }
    let mut p = setup("fence", &[], false);
    p.project(Some(
        "fn main() { std::thread::sleep(std::time::Duration::from_secs(300)); }\n",
    ));
    assert_ok(&p.approve(4_000)); // approver caps wall time at 4 s
    let t = Instant::now();
    let r = p.cargo(&[]);
    assert_ok(&r);
    assert_eq!(r["result"]["output"]["reason"], "timeout");
    assert!(t.elapsed() < Duration::from_secs(60));
    assert!(exec_cgroups_nonempty().is_empty());
    // Revocation mid-run.
    let mut p = setup("fence2", &[], true);
    p.project(Some(
        "fn main() { std::thread::sleep(std::time::Duration::from_secs(300)); }\n",
    ));
    let params = p.params(json!({"program": "cargo", "args": ["check", "--offline", "--locked"]}));
    let sock = p.d.socket.clone();
    let frame = authed_frame(&p.cap, "tool-execute", params);
    let h = std::thread::spawn(move || raw_request(&sock, &frame).unwrap());
    let deadline = Instant::now() + Duration::from_secs(120);
    while !p.phases().iter().any(|x| x == "running") {
        assert!(Instant::now() < deadline, "build never reached running");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_ok(&p.issuer("tool-revoke", json!({"commandId": p.command})));
    let r = h.join().unwrap();
    assert_ok(&r);
    let last = p.events().pop().unwrap();
    assert_eq!(last["phase"], "cancelled");
    assert_eq!(last["process"]["terminationReason"], "revoked");
    assert!(exec_cgroups_nonempty().is_empty());
}

#[test]
fn daemon_sigkill_leaves_no_running_children_and_restart_closes_the_record() {
    let _g = serial();
    if !host_ready("proc-crash") {
        return;
    }
    let mut p = setup("crash", &[], true);
    p.project(Some(
        "fn main() { std::thread::sleep(std::time::Duration::from_secs(600)); }\n",
    ));
    let params = p.params(json!({"program": "cargo", "args": ["check", "--offline", "--locked"]}));
    let rid = params["requestId"].as_str().unwrap().to_owned();
    let sock = p.d.socket.clone();
    let frame = authed_frame(&p.cap, "tool-execute", params.clone());
    let h = std::thread::spawn(move || raw_request(&sock, &frame));
    let deadline = Instant::now() + Duration::from_secs(120);
    while !p.phases().iter().any(|x| x == "running") {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !exec_cgroups_nonempty().is_empty(),
        "build should be running"
    );
    crash(&mut p.d.child);
    let _ = h.join();
    // Orphans die with the supervisor (PDEATHSIG + PID-namespace teardown).
    let deadline = Instant::now() + Duration::from_secs(15);
    while !exec_cgroups_nonempty().is_empty() {
        assert!(
            Instant::now() < deadline,
            "sandboxed processes survived the daemon crash"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = std::fs::remove_file(&p.d.socket);
    // Restart: reconciliation closes the open record; nothing is restarted.
    let basep = std::fs::canonicalize(p.base.path()).unwrap();
    let uid = euid().to_string();
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&p.d.db)
        .arg("--socket")
        .arg(&p.d.socket)
        .arg("--cap")
        .arg(&p.d.cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&p.d.witness)
        .arg("--workspace-bases")
        .arg(&basep)
        .arg("--allowed-uids")
        .arg(&uid)
        .arg("--enable-process")
        .arg("--approver-cap")
        .arg(&p.approver_cap_path)
        .arg("--approver-uids")
        .arg(&uid)
        .arg("--allow-nonindependent-approver-test-only")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    common::die_with_test(&mut cmd);
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(r) = raw_request(
            &p.d.socket,
            r#"{"protocol":1,"id":"h","cmd":"health","params":{}}"#,
        ) {
            if r["ok"] == true {
                break;
            }
        }
        if let Ok(Some(st)) = child.try_wait() {
            panic!("daemon exited: {st}");
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(50));
    }
    p.cap = read_cap(&p.d.cap);
    let phases = p.phases();
    assert_eq!(
        phases,
        vec![
            "authorized",
            "started",
            "prepared",
            "running",
            "interrupted"
        ]
    );
    let last = p.events().pop().unwrap();
    assert_eq!(last["process"]["outcome"], "uncertain", "{last}");
    assert_eq!(last["process"]["processStarted"], true);
    // The same request id can never run again.
    let again = raw_request(&p.d.socket, &authed_frame(&p.cap, "tool-execute", params)).unwrap();
    assert_eq!(again["ok"], false, "{rid}");
    assert!(exec_cgroups_nonempty().is_empty());
    terminate(&mut child);
}

#[test]
fn ipc_disconnect_and_duplicate_requests_execute_exactly_once() {
    let _g = serial();
    use std::io::Write;
    if !host_ready("proc-disconnect") {
        return;
    }
    let mut p = setup("disc", &[], true);
    p.project(None);
    let params = p.params(json!({"program": "cargo", "args": ["check", "--offline", "--locked"]}));
    let frame = authed_frame(&p.cap, "tool-execute", params.clone());
    {
        let mut s = std::os::unix::net::UnixStream::connect(&p.d.socket).unwrap();
        s.write_all(frame.as_bytes()).unwrap();
        s.write_all(b"\n").unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(180);
    while !p.phases().iter().any(|x| x == "exited") {
        assert!(Instant::now() < deadline, "execution never finished");
        std::thread::sleep(Duration::from_millis(100));
    }
    let again = raw_request(&p.d.socket, &authed_frame(&p.cap, "tool-execute", params)).unwrap();
    assert_eq!(again["ok"], false);
    assert_eq!(
        p.phases(),
        vec!["authorized", "started", "prepared", "running", "exited"]
    );
}

#[test]
fn concurrent_builds_are_bounded_isolated_and_journal_consistently() {
    let _g = serial();
    if !host_ready("proc-concurrent") {
        return;
    }
    let mut p = setup("conc", &[], true);
    p.project(None);
    let mut hs = Vec::new();
    for _ in 0..6 {
        let params =
            p.params(json!({"program": "cargo", "args": ["check", "--offline", "--locked"]}));
        let sock = p.d.socket.clone();
        let frame = authed_frame(&p.cap, "tool-execute", params);
        hs.push(std::thread::spawn(move || {
            raw_request(&sock, &frame).unwrap()
        }));
    }
    let rs: Vec<Value> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    let ok = rs.iter().filter(|r| r["ok"] == true).count();
    let busy = rs.iter().filter(|r| code_of(r) == "server-busy").count();
    assert_eq!(ok + busy, 6, "{rs:?}");
    assert!(ok >= 1);
    for r in rs.iter().filter(|r| r["ok"] == true) {
        assert_eq!(r["result"]["output"]["verification"], "pass", "{r}");
    }
    let ph = p.phases();
    assert_eq!(ph.iter().filter(|x| *x == "exited").count(), ok);
    assert_eq!(ph.len(), ok * 5);
    assert!(exec_cgroups_nonempty().is_empty());
}

#[test]
fn require_kernel_limits_flag_refuses_to_start_without_them() {
    let _g = serial();
    if !host_ready("proc-require-kernel") {
        return;
    }
    let base = tempfile::tempdir().unwrap();
    let basep = std::fs::canonicalize(base.path()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let uid = euid().to_string();
    let mut c = Command::new(nexusd_bin());
    c.arg("--db")
        .arg(dir.path().join("k.db"))
        .arg("--socket")
        .arg(dir.path().join("s.sock"))
        .arg("--cap")
        .arg(dir.path().join("c.cap"))
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(dir.path().join("w.db"))
        .arg("--workspace-bases")
        .arg(&basep)
        .arg("--allowed-uids")
        .arg(&uid)
        .arg("--enable-process")
        .arg("--approver-cap")
        .arg(dir.path().join("a.cap"))
        .arg("--approver-uids")
        .arg(&uid)
        .arg("--allow-nonindependent-approver-test-only")
        .arg("--require-kernel-resource-limits")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if nexus_tools::sandbox::kernel_limits_available() {
        // Available here: the daemon starts and reports kernel enforcement.
        let mut child = c.spawn().unwrap();
        let sock = dir.path().join("s.sock");
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut status = None;
        while Instant::now() < deadline {
            if let Ok(r) = raw_request(
                &sock,
                r#"{"protocol":1,"id":"s","cmd":"status","params":{}}"#,
            ) {
                if r["ok"] == true {
                    status = Some(r);
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        let st = status.expect("daemon never became ready");
        assert_eq!(st["sandbox"]["kernelEnforcedLimits"], true);
        assert_eq!(st["sandbox"]["resourceEnforcement"], "kernel-cgroup");
    } else {
        let out = c.output().unwrap();
        assert!(!out.status.success());
    }
}
