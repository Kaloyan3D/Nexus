//! M7: background jobs and dev servers. Real sandbox, real Node.js server, real loopback
//! bridge. Prints `NOT RUN` when the host lacks the sandbox (release battery requires it).

use nexus_tools::confine::{self};
use nexus_tools::confine_host;
use nexus_tools::inplace::{self, PrepareOptions};
use nexus_tools::jobs::{JobManager, JobStart};
use nexus_tools::result::ToolError;
use nexus_tools::sandbox::{cgroup_base, SandboxLimits, SandboxSpec};
use nexus_tools::workspace::{Workspace, WorkspacePolicy};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

fn ready(t: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available
        || c.landlock_abi.is_none()
        || !c.launch_gate
        || !Path::new("/usr/bin/node").exists()
    {
        println!(
            "NOT RUN ({t}): sandbox/Landlock/launch gate/node unavailable: {:?}",
            c.problems
        );
        return false;
    }
    true
}

struct W {
    _t: tempfile::TempDir,
    root: PathBuf,
    ws: Workspace,
}

fn world(files: &[(&str, &str)]) -> W {
    let t = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(t.path()).unwrap().join("proj");
    std::fs::create_dir_all(&root).unwrap();
    for (p, c) in files {
        let f = root.join(p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, c).unwrap();
    }
    let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    W { _t: t, root, ws }
}

#[allow(clippy::too_many_arguments)]
fn start(
    mgr: &JobManager,
    w: &W,
    program: &str,
    args: &[&str],
    authorized: &[u16],
    expose: &[(u16, u16)],
    wall_ms: u64,
    max_log_bytes: u64,
) -> Result<nexus_tools::jobs::JobRecord, ToolError> {
    let mount = inplace::prepare_with(&w.ws, &PrepareOptions::default())?;
    let mut env = BTreeMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), "/work/out".to_owned());
    let shim = confine_host::locate_shim().expect("launch gate");
    let sha = confine_host::shim_is_trustworthy(&shim).unwrap();
    let r = nexus_tools::observe::root_identity(&w.ws).unwrap();
    let spec = SandboxSpec {
        id: "job".into(),
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        src_dir: PathBuf::new(),
        cwd: "/work/src".into(),
        env,
        ro_binds: vec![],
        rw_binds: vec![],
        src_writable: true,
        pinned_root: Some(mount.root_fd()),
        protect: mount.protect(),
        fd_ro_binds: mount.fd_ro_binds(),
        egress: None,
        dev: None,
        net: false,
        limits: SandboxLimits {
            wall_ms,
            cpu_secs: 120,
            ..Default::default()
        },
        cgroup_base: cgroup_base().unwrap(),
        confine: Some(nexus_tools::sandbox::ConfineSpec {
            shim,
            shim_sha256: sha,
            root: (r.dev, r.ino),
            min_abi: confine::MIN_ABI,
            require_scope: false,
        }),
    };
    mgr.start(JobStart {
        spec,
        mount: Some(mount),
        display: format!("{program} {}", args.join(" ")),
        task: "task-m7".into(),
        authority: "test-grant-digest".into(),
        authorized_ports: authorized.to_vec(),
        expose: expose.to_vec(),
        max_log_bytes,
    })
}

fn http_get(port: u16, path: &str) -> Result<String, String> {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.write_all(format!("GET {path} HTTP/1.0\r\nHost: localhost\r\n\r\n").as_bytes())
        .map_err(|e| e.to_string())?;
    let mut out = String::new();
    s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    s.read_to_string(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn wait_for<F: Fn() -> bool>(what: &str, f: F) {
    for _ in 0..150 {
        if f() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    panic!("timed out waiting for {what}");
}

const SERVER: &str = "const http=require('http'),fs=require('fs');http.createServer((q,s)=>{s.end(fs.readFileSync('msg.txt'))}).listen(4321,'127.0.0.1',()=>console.log('listening-4321'));\n";

#[test]
fn m7_a_dev_server_lives_in_the_sandbox_and_is_reachable_only_through_the_authorized_bridge() {
    if !ready("dev") {
        return;
    }
    let w = world(&[("server.js", SERVER), ("msg.txt", "v1\n")]);
    let dir = tempfile::tempdir().unwrap();
    let mgr = JobManager::open(dir.path()).unwrap();
    let rec = start(
        &mgr,
        &w,
        "/usr/bin/node",
        &["server.js"],
        &[4321],
        &[(4321, 0)],
        120_000,
        1 << 20,
    )
    .expect("start job");
    assert_eq!(rec.state, "running");
    assert_eq!(rec.exposed.len(), 1, "{rec:?}");
    let host_port = rec.exposed[0].1;
    // reachable through the authorized bridge; the server observes live file changes
    wait_for("server via bridge", || {
        http_get(host_port, "/").is_ok_and(|r| r.contains("v1"))
    });
    std::fs::write(w.root.join("msg.txt"), "v2\n").unwrap();
    wait_for("server observes change", || {
        http_get(host_port, "/").is_ok_and(|r| r.contains("v2"))
    });
    // logs are readable and bounded while it runs
    wait_for("log line", || {
        mgr.logs(&rec.id, 4096)
            .is_ok_and(|l| l.contains("listening-4321"))
    });
    // the sandbox port itself is NOT reachable on the host except via the bridge:
    // a fresh bridge-less connection to 4321 on host loopback must fail (nothing listens there)
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", 4321)).is_err(),
        "sandbox port must not leak onto the host"
    );
    // stop kills the tree and removes the exposure
    let t0 = std::time::Instant::now();
    let stopped = mgr.stop(&rec.id).expect("stop");
    assert_eq!(stopped.state, "stopped", "{stopped:?}");
    println!("stop latency: {} ms", t0.elapsed().as_millis());
    assert!(
        http_get(host_port, "/").is_err(),
        "bridge closed with the job"
    );
    assert_eq!(mgr.status(&rec.id).unwrap().state, "stopped");
}

#[test]
fn m7_an_unauthorized_port_is_refused_and_a_short_job_reports_its_exit() {
    if !ready("auth") {
        return;
    }
    let w = world(&[("msg.txt", "x\n")]);
    let dir = tempfile::tempdir().unwrap();
    let mgr = JobManager::open(dir.path()).unwrap();
    let e = start(
        &mgr,
        &w,
        "/usr/bin/node",
        &["-e", "0"],
        &[4321],
        &[(9999, 0)],
        30_000,
        1 << 20,
    )
    .expect_err("unauthorized port must be refused");
    assert!(e.message.contains("not authorized"), "{}", e.message);
    // a short job runs to completion with its exit code recorded
    let rec = start(&mgr, &w, "/usr/bin/true", &[], &[], &[], 30_000, 1 << 20).expect("start");
    wait_for("true exits", || {
        mgr.status(&rec.id).unwrap().state == "exited"
    });
    assert_eq!(mgr.status(&rec.id).unwrap().exit_code, Some(0));
}

#[test]
fn m7_logs_are_bounded_and_a_runtime_limit_ends_a_job() {
    if !ready("limits") {
        return;
    }
    let w = world(&[("flood.py", "print('x' * 100000)\n")]);
    let dir = tempfile::tempdir().unwrap();
    let mgr = JobManager::open(dir.path()).unwrap();
    let rec = start(
        &mgr,
        &w,
        "/usr/bin/python3",
        &["flood.py"],
        &[],
        &[],
        30_000,
        4096,
    )
    .expect("start flood");
    wait_for("flood exits", || {
        mgr.status(&rec.id).unwrap().state != "running"
    });
    let log_len = mgr.logs(&rec.id, usize::MAX).unwrap().len();
    assert!(log_len <= 16 * 1024, "log stays bounded, got {log_len}");
    // runtime limit: a sleeper with a 1s wall clock ends by itself, honestly reported
    let rec = start(&mgr, &w, "/bin/sleep", &["30"], &[], &[], 1_000, 1 << 20).expect("start");
    wait_for("sleeper limited", || {
        mgr.status(&rec.id).unwrap().state != "running"
    });
    let st = mgr.status(&rec.id).unwrap();
    assert_eq!(st.state, "exited", "{st:?}");
    assert_eq!(st.exit_code, Some(124), "{st:?}");
}

#[test]
fn m7_a_record_without_a_live_supervisor_reconciles_to_interrupted_never_running() {
    // no sandbox needed: pure record/reality reconciliation
    let dir = tempfile::tempdir().unwrap();
    let fake = nexus_tools::jobs::JobRecord {
        id: "job-fake-1".into(),
        state: "running".into(),
        display: "node server.js".into(),
        task: "task-m7".into(),
        authority: "d".into(),
        started_at_ms: 1,
        ended_at_ms: None,
        exit_code: None,
        pid: Some(999_999),
        cgroup: Some("/sys/fs/cgroup/does-not-exist-m7".into()),
        exposed: vec![],
        log_bytes: 0,
        log_truncated: false,
    };
    std::fs::write(
        dir.path().join("job-fake-1.json"),
        serde_json::to_string(&fake).unwrap(),
    )
    .unwrap();
    let mgr = JobManager::open(dir.path()).unwrap();
    let recs = mgr.list();
    let fake = recs.iter().find(|r| r.id == "job-fake-1").unwrap();
    assert_eq!(fake.state, "interrupted", "{fake:?}");
    assert!(fake.ended_at_ms.is_some());
}

#[test]
fn m7_foreground_commands_run_while_a_background_job_holds_the_workspace() {
    if !ready("fg") {
        return;
    }
    use nexus_tools::sandbox::{run_sandboxed, SandboxControl, StopReason};
    struct Never;
    impl SandboxControl for Never {
        fn should_stop(&mut self) -> Option<StopReason> {
            None
        }
        fn on_spawned(&mut self, _: u32, _: &str) -> Result<(), ToolError> {
            Ok(())
        }
    }
    let w = world(&[("server.js", SERVER), ("msg.txt", "v1\n")]);
    let dir = tempfile::tempdir().unwrap();
    let mgr = JobManager::open(dir.path()).unwrap();
    let rec = start(
        &mgr,
        &w,
        "/usr/bin/node",
        &["server.js"],
        &[4321],
        &[(4321, 0)],
        120_000,
        1 << 20,
    )
    .expect("start server");
    let host_port = rec.exposed[0].1;
    wait_for("server up", || {
        http_get(host_port, "/").is_ok_and(|r| r.contains("v1"))
    });
    // a foreground sandboxed command in the SAME workspace completes while the job runs
    let mount = inplace::prepare_with(&w.ws, &PrepareOptions::default()).unwrap();
    let mut env = BTreeMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), "/work/out".to_owned());
    let shim = confine_host::locate_shim().expect("launch gate");
    let sha = confine_host::shim_is_trustworthy(&shim).unwrap();
    let r = nexus_tools::observe::root_identity(&w.ws).unwrap();
    let spec = SandboxSpec {
        id: format!("fg-{}", std::process::id()),
        program: "/usr/bin/sh".into(),
        args: vec!["-c".into(), "echo foreground-ok && cat msg.txt".into()],
        src_dir: PathBuf::new(),
        cwd: "/work/src".into(),
        env,
        ro_binds: vec![],
        rw_binds: vec![],
        src_writable: true,
        pinned_root: Some(mount.root_fd()),
        protect: mount.protect(),
        fd_ro_binds: mount.fd_ro_binds(),
        egress: None,
        dev: None,
        net: false,
        limits: SandboxLimits {
            wall_ms: 30_000,
            cpu_secs: 60,
            ..Default::default()
        },
        cgroup_base: cgroup_base().unwrap(),
        confine: Some(nexus_tools::sandbox::ConfineSpec {
            shim,
            shim_sha256: sha,
            root: (r.dev, r.ino),
            min_abi: confine::MIN_ABI,
            require_scope: false,
        }),
    };
    let t0 = std::time::Instant::now();
    let o = run_sandboxed(&spec, &mut Never).expect("foreground run");
    let txt = String::from_utf8_lossy(&o.stdout).into_owned();
    assert!(txt.contains("foreground-ok"), "{txt}");
    println!(
        "foreground command while job active: {} ms",
        t0.elapsed().as_millis()
    );
    // and the background server is still alive afterwards
    assert!(http_get(host_port, "/").is_ok_and(|r| r.contains("v1")));
    mgr.stop(&rec.id).unwrap();
}

#[test]
fn m7_a_rust_dev_server_runs_as_a_background_job() {
    if !ready("rust")
        || !Path::new("/usr/bin/cargo").exists()
            && !std::env::var("HOME")
                .map(|h| Path::new(&h).join(".cargo/bin/cargo").exists())
                .unwrap_or(false)
    {
        return;
    }
    let main_rs = "use std::io::{Read, Write};\nfn main() { let l = std::net::TcpListener::bind(\"127.0.0.1:4322\").unwrap(); println!(\"rust-listening\"); for s in l.incoming() { if let Ok(mut s) = s { let mut b = [0u8; 512]; let _ = s.read(&mut b); let _ = s.write_all(b\"HTTP/1.0 200 OK\\r\\n\\r\\nrust-ok\"); } } }\n";
    let w = world(&[
        (
            "Cargo.toml",
            "[package]\nname = \"m7srv\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        ),
        ("src/main.rs", main_rs),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let mgr = JobManager::open(dir.path()).unwrap();
    // build first (foreground job, waited), then serve
    let build = start(
        &mgr,
        &w,
        "/usr/bin/cargo",
        &["build"],
        &[],
        &[],
        300_000,
        1 << 20,
    )
    .expect("cargo build job");
    wait_for("cargo build", || {
        mgr.status(&build.id).unwrap().state != "running"
    });
    assert_eq!(
        mgr.status(&build.id).unwrap().exit_code,
        Some(0),
        "{:?}",
        mgr.logs(&build.id, 4096)
    );
    let rec = start(
        &mgr,
        &w,
        "/work/src/target/debug/m7srv",
        &[],
        &[4322],
        &[(4322, 0)],
        120_000,
        1 << 20,
    )
    .expect("start rust server");
    let host_port = rec.exposed[0].1;
    wait_for("rust server via bridge", || {
        http_get(host_port, "/").is_ok_and(|r| r.contains("rust-ok"))
    });
    mgr.stop(&rec.id).unwrap();
}

#[test]
fn m7_a_dotnet_dev_server_runs_as_a_background_job() {
    if !ready("dotnet") || !Path::new("/usr/bin/dotnet").exists() {
        return;
    }
    let prog = "using System; using System.Net; using System.Net.Sockets; using System.Text; var l = new TcpListener(IPAddress.Loopback, 4323); l.Start(); Console.WriteLine(\"dotnet-listening\"); while (true) { using var c = l.AcceptTcpClient(); var b = Encoding.UTF8.GetBytes(\"HTTP/1.0 200 OK\r\n\r\ndotnet-ok\"); c.GetStream().Write(b, 0, b.Length); }\n";
    let w = world(&[
        ("m7.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n"),
        ("Program.cs", prog),
    ]);
    // fixture build on the host (no external packages); if this SDK cannot build offline,
    // the honest outcome is NOT TESTED, printed below — never a fabricated pass.
    let o = std::process::Command::new("/usr/bin/dotnet")
        .args(["build", "-c", "Release", "--nologo", "-v", "q"])
        .current_dir(&w.root)
        .output()
        .unwrap();
    if !o.status.success() {
        println!(
            "NOT TESTED (dotnet): host SDK build failed offline: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        return;
    }
    // locate the built apphost under bin/Release/<tfm>/ whatever this SDK targets
    let mut bin: Option<String> = None;
    for e in std::fs::read_dir(w.root.join("bin/Release"))
        .unwrap()
        .flatten()
    {
        let cand = e.path().join("m7");
        if cand.exists() {
            bin = Some(format!(
                "/work/src/bin/Release/{}/m7",
                e.file_name().to_string_lossy()
            ));
        }
    }
    let Some(bin) = bin else {
        println!("NOT TESTED (dotnet): no apphost produced");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let mgr = JobManager::open(dir.path()).unwrap();
    let rec = start(&mgr, &w, &bin, &[], &[4323], &[(4323, 0)], 120_000, 1 << 20)
        .expect("start dotnet server");
    let host_port = rec.exposed[0].1;
    wait_for("dotnet server via bridge", || {
        http_get(host_port, "/").is_ok_and(|r| r.contains("dotnet-ok"))
    });
    mgr.stop(&rec.id).unwrap();
}
