//! A3.4 sandbox escape / isolation tests: REAL Linux processes in the real
//! sandbox. If the host cannot provide a mandatory primitive the tests
//! print `NOT RUN` and return (never a PASS claim).

use nexus_tools::sandbox::{
    kernel_limits_available, preflight, run_sandboxed, ExitKind, ResourceBackend, SandboxControl,
    SandboxLimits, SandboxOutcome, SandboxSpec, StopReason,
};
use nexus_tools::ToolError;
use std::collections::BTreeMap;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const PY: &str = "/usr/bin/python3";

struct Never;
impl SandboxControl for Never {
    fn should_stop(&mut self) -> Option<StopReason> {
        None
    }
    fn on_spawned(&mut self, _: u32, _: &str) -> Result<(), ToolError> {
        Ok(())
    }
}

fn caps_ok(test: &str) -> bool {
    let c = preflight();
    if !c.available {
        println!("NOT RUN ({test}): sandbox unavailable: {:?}", c.problems);
    }
    c.available
}

macro_rules! require_sandbox {
    ($t:expr) => {
        if !caps_ok($t) {
            return;
        }
        if !std::path::Path::new(PY).exists() {
            println!("NOT RUN ({}): {PY} missing", $t);
            return;
        }
    };
}

fn spec(id: &str, program: &str, args: &[&str], src: &std::path::Path) -> SandboxSpec {
    let mut env = BTreeMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), "/work/out".to_owned());
    SandboxSpec {
        id: id.to_owned(),
        program: program.to_owned(),
        args: args.iter().map(|s| s.to_string()).collect(),
        src_dir: src.to_path_buf(),
        cwd: "/work/src".to_owned(),
        env,
        ro_binds: vec![],
        limits: SandboxLimits {
            wall_ms: 20_000,
            cpu_secs: 20,
            memory_bytes: 512 * 1024 * 1024,
            address_space_bytes: 4 * 1024 * 1024 * 1024,
            max_procs: 64,
            ..Default::default()
        },
        cgroup_base: nexus_tools::sandbox::cgroup_base().unwrap(),
    }
}

fn py(id: &str, code: &str, src: &std::path::Path) -> SandboxOutcome {
    run_sandboxed(&spec(id, PY, &["-c", code], src), &mut Never).expect("sandbox run")
}

fn out(o: &SandboxOutcome) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// systemd collects scopes asynchronously: gone = removed or empty.
fn cgroup_gone(cg: &str) -> bool {
    for _ in 0..300 {
        let p = std::path::Path::new(cg);
        if !p.exists() {
            return true;
        }
        if std::fs::read_to_string(p.join("cgroup.procs"))
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
            && !p.exists()
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    std::fs::read_to_string(std::path::Path::new(cg).join("cgroup.procs"))
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
}

fn stage() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("hello.txt"), "snapshot\n").unwrap();
    d
}

#[test]
fn preflight_reports_the_real_boundary() {
    let c = preflight();
    println!("preflight: {c:?}");
    if c.available {
        assert!(c.seccomp);
        assert!(c.bwrap_version.is_some());
        assert!(c.problems.is_empty());
    } else {
        assert!(!c.problems.is_empty(), "unavailable must say why");
    }
}

#[test]
fn host_filesystem_is_invisible_and_credentials_unreadable() {
    require_sandbox!("host-fs");
    let host = tempfile::tempdir().unwrap();
    let canary = host.path().join("id_rsa");
    std::fs::write(&canary, "PRIVATE-KEY-CANARY").unwrap();
    let src = stage();
    let home = std::env::var("HOME").unwrap_or_default();
    let code = format!(
        r#"
import os, json
res = {{}}
for p in [{canary:?}, {home:?} + "/.ssh/id_rsa", {home:?} + "/.cargo/credentials.toml",
          "/etc/shadow", "/root", "/home", "/var", "/run/user", "/sys/kernel", "/boot"]:
    res[p] = os.path.exists(p)
res["root_listing"] = sorted(os.listdir("/"))
print(json.dumps(res))
"#,
        canary = canary.display().to_string(),
        home = home
    );
    let o = py("hostfs", &code, src.path());
    assert_eq!(
        o.exit,
        ExitKind::Exited(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    for (k, val) in v.as_object().unwrap() {
        if k != "root_listing" {
            assert_eq!(val, false, "{k} is visible inside the sandbox");
        }
    }
    let listing: Vec<String> = serde_json::from_value(v["root_listing"].clone()).unwrap();
    for allowed in &listing {
        assert!(
            ["usr", "bin", "sbin", "lib", "lib64", "proc", "dev", "tmp", "work"]
                .contains(&allowed.as_str()),
            "unexpected root entry {allowed}: {listing:?}"
        );
    }
}

#[test]
fn host_write_attempts_fail_and_scratch_never_reaches_the_host() {
    require_sandbox!("host-write");
    let src = stage();
    let host = tempfile::tempdir().unwrap();
    let code = r#"
import os, json
res = {}
def attempt(path, data="x"):
    try:
        with open(path, "w") as f: f.write(data)
        return "WROTE"
    except Exception as e:
        return type(e).__name__
res["usr"] = attempt("/usr/nexus-pwn")
res["src"] = attempt("/work/src/pwn.txt")
res["src_overwrite"] = attempt("/work/src/hello.txt", "tampered")
res["root"] = attempt("/pwn")
res["tmp"] = attempt("/tmp/ok")
res["out"] = attempt("/work/out/ok")
print(json.dumps(res))
"#;
    let o = py("hostwrite", code, src.path());
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    for k in ["usr", "src", "src_overwrite", "root"] {
        assert_ne!(v[k], "WROTE", "{k} was writable");
    }
    assert_eq!(v["tmp"], "WROTE");
    assert_eq!(v["out"], "WROTE");
    // The snapshot on the host is untouched and nothing leaked out.
    assert_eq!(
        std::fs::read_to_string(src.path().join("hello.txt")).unwrap(),
        "snapshot\n"
    );
    assert!(!src.path().join("pwn.txt").exists());
    assert_eq!(std::fs::read_dir(host.path()).unwrap().count(), 0);
}

#[test]
fn proc_and_sys_do_not_expose_the_host() {
    require_sandbox!("proc-sys");
    let src = stage();
    let me = std::process::id();
    let code = format!(
        r#"
import os, json
pids = sorted(int(x) for x in os.listdir("/proc") if x.isdigit())
res = {{"pids": pids, "host_visible": os.path.exists("/proc/{me}"),
        "sys": os.path.exists("/sys"), "self_root": os.path.realpath("/proc/self/root")}}
st = open("/proc/self/status").read()
for line in st.splitlines():
    if line.split(":")[0] in ("NoNewPrivs","Seccomp","CapEff","CapPrm","CapBnd","Uid"):
        res[line.split(":")[0]] = line.split(":",1)[1].strip()
print(json.dumps(res))
"#
    );
    let o = py("procsys", &code, src.path());
    assert_eq!(
        o.exit,
        ExitKind::Exited(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    assert_eq!(v["host_visible"], false);
    assert_eq!(v["sys"], false);
    assert!(v["pids"].as_array().unwrap().len() <= 8, "{v}");
    assert_eq!(v["NoNewPrivs"], "1");
    assert_eq!(v["Seccomp"], "2", "seccomp filter not active: {v}");
    assert!(
        v["CapEff"].as_str().unwrap().chars().all(|c| c == '0'),
        "{v}"
    );
    assert_ne!(
        v["Uid"]
            .as_str()
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap(),
        "0"
    );
}

#[test]
fn network_including_host_loopback_is_unreachable() {
    require_sandbox!("network");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let src = stage();
    let code = format!(
        r#"
import socket, json
res = {{}}
for name, addr in [("host_loopback", ("127.0.0.1", {port})), ("external", ("1.1.1.1", 53)),
                   ("lan", ("192.168.1.1", 80))]:
    s = socket.socket(); s.settimeout(2)
    try:
        s.connect(addr); res[name] = "CONNECTED"
    except Exception as e:
        res[name] = type(e).__name__
    finally:
        s.close()
# A listener inside the sandbox is private to it.
try:
    l = socket.socket(); l.bind(("0.0.0.0", 0)); res["bind"] = "ok"
except Exception as e:
    res["bind"] = type(e).__name__
try:
    import socket as S
    raw = S.socket(S.AF_PACKET, S.SOCK_RAW); res["raw"] = "OPENED"
except Exception as e:
    res["raw"] = type(e).__name__
print(json.dumps(res))
"#
    );
    let o = py("network", &code, src.path());
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    for k in ["host_loopback", "external", "lan"] {
        assert_ne!(v[k], "CONNECTED", "{k} reachable: {v}");
    }
    assert_ne!(v["raw"], "OPENED");
    // The host listener never saw a connection.
    assert!(
        listener.accept().is_err(),
        "host loopback listener was reached"
    );
}

#[test]
fn environment_and_descriptors_do_not_leak() {
    require_sandbox!("env-fd");
    std::env::set_var("NEXUS_ISSUER_CAP_CANARY", "super-secret-capability");
    // A descriptor the daemon holds, deliberately NOT close-on-exec.
    let f = std::fs::File::open("/etc/hostname").unwrap();
    let fd = f.as_raw_fd();
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC);
    }
    let src = stage();
    let o = py(
        "envfd",
        r#"
import os, json
print(json.dumps({"env": dict(os.environ), "fds": sorted(os.listdir("/proc/self/fd"))}))
"#,
        src.path(),
    );
    assert_eq!(
        o.exit,
        ExitKind::Exited(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    let env = v["env"].as_object().unwrap();
    assert!(
        !env.keys()
            .any(|k| k.contains("CANARY") || k.contains("NEXUS")),
        "{env:?}"
    );
    let keys: Vec<&String> = env.keys().collect();
    assert!(
        keys.iter()
            .all(|k| ["PATH", "HOME", "LC_CTYPE", "PWD"].contains(&k.as_str())),
        "{keys:?}"
    );
    let fds: Vec<String> = serde_json::from_value(v["fds"].clone()).unwrap();
    // Only stdio (+ the listing fd itself).
    assert!(
        fds.iter()
            .all(|f| matches!(f.as_str(), "0" | "1" | "2" | "3")),
        "{fds:?}"
    );
    drop(f);
}

#[test]
fn privilege_escalation_primitives_are_denied() {
    require_sandbox!("privesc");
    let src = stage();
    let code = r#"
import ctypes, os, json
libc = ctypes.CDLL(None, use_errno=True)
res = {}
def sc(nr, *a):
    r = libc.syscall(nr, *[ctypes.c_long(x) for x in a])
    return (r, ctypes.get_errno())
res["setuid0"] = "OK" if os.geteuid() == 0 else "not-root"
for name, nr in [("ptrace", 101), ("mount", 165), ("unshare", 272), ("setns", 308),
                 ("bpf", 321), ("keyctl", 250), ("io_uring_setup", 425), ("kexec_load", 246)]:
    r, e = sc(nr, 0, 0, 0, 0, 0, 0)
    res[name] = {"ret": r, "errno": e}
# clone3 is forced to ENOSYS
r, e = sc(435, 0, 0)
res["clone3"] = {"ret": r, "errno": e}
try:
    os.setuid(0); res["os_setuid"] = "OK"
except Exception as ex:
    res["os_setuid"] = type(ex).__name__
print(json.dumps(res))
"#;
    let o = py("privesc", code, src.path());
    assert_eq!(
        o.exit,
        ExitKind::Exited(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    for k in [
        "ptrace",
        "mount",
        "unshare",
        "setns",
        "bpf",
        "keyctl",
        "io_uring_setup",
        "kexec_load",
    ] {
        assert_eq!(v[k]["ret"], -1, "{k}");
        assert_eq!(v[k]["errno"], 1, "{k} must be EPERM: {v}");
    }
    assert_eq!(v["clone3"]["errno"], 38);
    assert_eq!(v["setuid0"], "not-root");
    assert_ne!(v["os_setuid"], "OK");
}

#[test]
fn fork_bomb_is_contained_and_reaped() {
    require_sandbox!("fork-bomb");
    let src = stage();
    let marker = format!("nexus-bomb-{}", std::process::id());
    let code = format!(
        r#"
import os, sys, time
sys.argv[0] = "{marker}"
n = 0
while True:
    try:
        pid = os.fork()
    except OSError:
        time.sleep(0.05)
        continue
    if pid == 0:
        time.sleep(60)
        os._exit(0)
    n += 1
    if n > 5000: break
"#
    );
    let mut s = spec("forkbomb", PY, &["-c", &code], src.path());
    s.limits.max_procs = 32;
    s.limits.wall_ms = 8_000;
    let started = Instant::now();
    let o = run_sandboxed(&s, &mut Never).expect("run");
    assert!(started.elapsed() < Duration::from_secs(25));
    assert!(
        o.peak_procs <= 32 + 16,
        "process count exceeded bound: {}",
        o.peak_procs
    );
    // Nothing survives: the execution cgroup is empty / collected.
    assert!(cgroup_gone(&o.cgroup));
    let leftovers = std::process::Command::new("pgrep")
        .args(["-f", &marker])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&leftovers.stdout).trim().is_empty());
}

#[test]
fn memory_exhaustion_is_stopped() {
    require_sandbox!("memory");
    let src = stage();
    let mut s = spec(
        "memhog",
        PY,
        &["-c", "b=[]\nimport time\nwhile True:\n    b.append(bytearray(64*1024*1024)); [x.__setitem__(0,1) for x in b]\n"],
        src.path(),
    );
    s.limits.memory_bytes = 200 * 1024 * 1024;
    s.limits.address_space_bytes = 6 * 1024 * 1024 * 1024;
    s.limits.wall_ms = 20_000;
    let o = run_sandboxed(&s, &mut Never).expect("run");
    assert!(
        matches!(
            o.exit,
            ExitKind::MemoryLimit | ExitKind::Signaled(_) | ExitKind::Exited(1)
        ),
        "{:?}",
        o.exit
    );
    assert!(
        o.peak_rss_bytes < 3 * 1024 * 1024 * 1024,
        "{}",
        o.peak_rss_bytes
    );
}

#[test]
fn cpu_spin_and_wall_clock_are_bounded() {
    require_sandbox!("cpu");
    let src = stage();
    let mut s = spec("cpuspin", PY, &["-c", "while True: pass"], src.path());
    s.limits.cpu_secs = 1;
    s.limits.wall_ms = 15_000;
    let t = Instant::now();
    let o = run_sandboxed(&s, &mut Never).expect("run");
    assert!(t.elapsed() < Duration::from_secs(12), "{:?}", t.elapsed());
    assert!(
        matches!(
            o.exit,
            ExitKind::Signaled(24)
                | ExitKind::Signaled(9)
                | ExitKind::Exited(137)
                | ExitKind::Exited(152)
        ),
        "{:?}",
        o.exit
    );
    assert!(o.signal_hint.is_some(), "{:?}", o.exit);

    let mut s = spec("sleeper", "/usr/bin/sleep", &["60"], src.path());
    s.limits.wall_ms = 1_000;
    let t = Instant::now();
    let o = run_sandboxed(&s, &mut Never).expect("run");
    assert_eq!(o.exit, ExitKind::Timeout);
    assert!(t.elapsed() < Duration::from_secs(8));
}

#[test]
fn output_flood_is_bounded_and_flagged() {
    require_sandbox!("output");
    let src = stage();
    let mut s = spec(
        "flood",
        PY,
        &["-c", "import sys\nfor _ in range(400):\n    sys.stdout.write('A'*1024*1024)\nsys.stderr.write('E'*500000)\n"],
        src.path(),
    );
    s.limits.stdout_cap = 64 * 1024;
    s.limits.stderr_cap = 4 * 1024;
    s.limits.wall_ms = 30_000;
    let o = run_sandboxed(&s, &mut Never).expect("run");
    assert_eq!(o.exit, ExitKind::Exited(0));
    assert_eq!(o.stdout.len(), 64 * 1024);
    assert_eq!(o.stderr.len(), 4 * 1024);
    assert!(o.stdout_truncated && o.stderr_truncated);
    assert!(o.stdout_bytes >= 400 * 1024 * 1024);
}

struct StopAfter(Instant, Duration, bool);
impl SandboxControl for StopAfter {
    fn should_stop(&mut self) -> Option<StopReason> {
        if self.0.elapsed() >= self.1 {
            Some(if self.2 {
                StopReason::Revoked("lease superseded".into())
            } else {
                StopReason::Cancelled
            })
        } else {
            None
        }
    }
    fn on_spawned(&mut self, _: u32, _: &str) -> Result<(), ToolError> {
        self.0 = Instant::now();
        Ok(())
    }
}

#[test]
fn cancellation_and_revocation_kill_the_whole_tree() {
    require_sandbox!("cancel");
    let src = stage();
    for revoke in [false, true] {
        let marker = format!("nexus-tree-{}-{revoke}", std::process::id());
        let code = format!(
            "import os, sys, time\nsys.argv[0]='{marker}'\nfor _ in range(3):\n    if os.fork()==0:\n        time.sleep(120); os._exit(0)\ntime.sleep(120)\n"
        );
        let s = spec(&format!("cancel{revoke}"), PY, &["-c", &code], src.path());
        let t = Instant::now();
        let o = run_sandboxed(
            &s,
            &mut StopAfter(Instant::now(), Duration::from_millis(700), revoke),
        )
        .expect("run");
        assert!(t.elapsed() < Duration::from_secs(10));
        assert_eq!(
            o.exit.reason(),
            if revoke { "revoked" } else { "cancelled" }
        );
        assert!(cgroup_gone(&o.cgroup), "cgroup not removed");
        let left = std::process::Command::new("pgrep")
            .args(["-f", &marker])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&left.stdout).trim().is_empty(),
            "children survived"
        );
    }
}

#[test]
fn daemonized_grandchildren_do_not_outlive_the_execution() {
    require_sandbox!("daemonize");
    let src = stage();
    let marker = format!("nexus-daemon-{}", std::process::id());
    let code = format!(
        r#"
import os, sys, time
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        sys.argv[0] = "{marker}"
        time.sleep(300)
    os._exit(0)
time.sleep(0.2)
"#
    );
    let o = py("daemonize", &code, src.path());
    assert_eq!(o.exit, ExitKind::Exited(0));
    std::thread::sleep(Duration::from_millis(300));
    let left = std::process::Command::new("pgrep")
        .args(["-f", &marker])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&left.stdout).trim().is_empty(),
        "orphan survived"
    );
}

#[test]
fn concurrent_sandboxes_are_isolated_from_each_other() {
    require_sandbox!("concurrent");
    let mut hs = Vec::new();
    for i in 0..6 {
        hs.push(std::thread::spawn(move || {
            let src = stage();
            let code = format!(
                r#"
import os, json
open("/tmp/mine", "w").write("{i}")
open("/work/out/mine", "w").write("{i}")
print(json.dumps({{"tmp": open("/tmp/mine").read(), "out": open("/work/out/mine").read(),
                  "entries": sorted(os.listdir("/work/out")), "pid1_is_me": os.getpid()}}))
"#
            );
            let o = py(&format!("conc{i}"), &code, src.path());
            (i, o)
        }));
    }
    for h in hs {
        let (i, o) = h.join().unwrap();
        assert_eq!(
            o.exit,
            ExitKind::Exited(0),
            "{}",
            String::from_utf8_lossy(&o.stderr)
        );
        let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
        assert_eq!(v["tmp"], i.to_string());
        assert_eq!(v["entries"], serde_json::json!(["mine"]));
    }
}

#[test]
fn fails_closed_when_isolation_cannot_be_established() {
    require_sandbox!("fail-closed");
    let src = stage();
    let marker = src.path().join("RAN");
    let code = "open('/work/out/x','w'); print('ran')".to_string();
    let _ = marker;
    // Unusable cgroup base: nothing may run.
    let mut s = spec("noc", PY, &["-c", &code], src.path());
    s.cgroup_base = PathBuf::from("/nonexistent/cgroup/base");
    // In polling mode the supervisor needs its own cgroup directory: an
    // unusable base must refuse rather than run unsupervised.
    s.limits.backend = ResourceBackend::Polling;
    let e = run_sandboxed(&s, &mut Never).unwrap_err();
    assert_eq!(e.code.as_str(), "sandbox-unavailable");
    // Relative program path / missing snapshot: refused before spawning.
    let mut s = spec("rel", "python3", &["-c", "pass"], src.path());
    assert_eq!(
        run_sandboxed(&s, &mut Never).unwrap_err().code.as_str(),
        "sandbox-unavailable"
    );
    s.program = PY.to_owned();
    s.src_dir = PathBuf::from("/nonexistent/src");
    assert_eq!(
        run_sandboxed(&s, &mut Never).unwrap_err().code.as_str(),
        "sandbox-unavailable"
    );
}

#[test]
fn malicious_build_script_cannot_reach_the_host() {
    require_sandbox!("build-script");
    // Models a cargo build.rs / npm postinstall: arbitrary code runs with
    // the snapshot as its input, and tries to read secrets, write back to
    // the project and phone home.
    let host = tempfile::tempdir().unwrap();
    let project = host.path().join("project");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(
        project.join("build.py"),
        r#"
import os, socket, json, glob
r = {}
r["ssh"] = glob.glob(os.path.expanduser("~") + "/.ssh/*") + glob.glob("/home/*/.ssh/*")
try:
    open("/work/src/BACKDOOR.rs", "w").write("evil"); r["writeback"] = "WROTE"
except Exception as e:
    r["writeback"] = type(e).__name__
try:
    s = socket.create_connection(("8.8.8.8", 53), 2); r["net"] = "CONNECTED"
except Exception as e:
    r["net"] = type(e).__name__
r["cwd"] = os.getcwd()
print(json.dumps(r))
"#,
    )
    .unwrap();
    let o = run_sandboxed(&spec("mal", PY, &["build.py"], &project), &mut Never).expect("run");
    assert_eq!(
        o.exit,
        ExitKind::Exited(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    assert_eq!(v["ssh"], serde_json::json!([]));
    assert_ne!(v["writeback"], "WROTE");
    assert_ne!(v["net"], "CONNECTED");
    assert!(!project.join("BACKDOOR.rs").exists());
}

// ============ A3.4 audit: resource enforcement ===========================

fn kernel_ok(t: &str) -> bool {
    if !kernel_limits_available() {
        println!("NOT RUN ({t}): kernel-enforced limits unavailable on this host");
        return false;
    }
    true
}

#[test]
fn rlimit_nproc_is_scoped_to_the_user_namespace_and_really_applies() {
    require_sandbox!("nproc");
    let src = stage();
    // Count how many processes can actually be created: this proves the
    // limit is enforced by the kernel via RLIMIT_NPROC (EAGAIN) and is NOT
    // the supervisor poll (which only kills at max_procs + 8).
    let code = r#"
import os, time, errno, json
kids, err = 0, None
while kids < 400:
    try:
        pid = os.fork()
    except OSError as e:
        err = errno.errorcode.get(e.errno, str(e.errno)); break
    if pid == 0:
        time.sleep(5); os._exit(0)
    kids += 1
print(json.dumps({"kids": kids, "err": err}))
time.sleep(0.2)
"#;
    let mut s = spec("nproc", PY, &["-c", code], src.path());
    s.limits.max_procs = 40;
    s.limits.backend = ResourceBackend::Polling; // rlimit only, no cgroup pids
    s.limits.wall_ms = 20_000;
    let o = run_sandboxed(&s, &mut Never).expect("run");
    assert_eq!(
        o.exit,
        ExitKind::Exited(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(out(&o).lines().next().unwrap()).unwrap();
    assert_eq!(v["err"], "EAGAIN", "{v}");
    let kids = v["kids"].as_u64().unwrap();
    assert!(
        kids > 5 && kids <= 40,
        "limit not applied as configured: {kids}"
    );
    // The host's own process count is irrelevant: the limit is per userns.
}

#[test]
fn kernel_backend_enforces_aggregate_memory_between_polls() {
    require_sandbox!("kernel-mem");
    if !kernel_ok("kernel-mem") {
        return;
    }
    let src = stage();
    // 8 processes each touching 128 MiB as fast as possible: ~1 GiB
    // aggregate against a 192 MiB resident budget, well inside one
    // supervisor poll interval.
    let code = r#"
import os, time
for _ in range(8):
    if os.fork() == 0:
        b = bytearray(128*1024*1024)
        for i in range(0, len(b), 4096): b[i] = 1
        time.sleep(30); os._exit(0)
time.sleep(30)
"#;
    let mut s = spec("kmem", PY, &["-c", code], src.path());
    s.limits.memory_bytes = 192 * 1024 * 1024;
    s.limits.scratch_bytes = 16 * 1024 * 1024;
    s.limits.tmp_bytes = 16 * 1024 * 1024;
    s.limits.backend = ResourceBackend::KernelScope;
    s.limits.wall_ms = 30_000;
    let o = run_sandboxed(&s, &mut Never).expect("run");
    assert_eq!(o.resource_enforcement, "kernel-cgroup");
    assert!(o.oom_killed, "kernel OOM kill expected: {:?}", o.exit);
    assert!(
        o.peak_rss_bytes <= 192 * 1024 * 1024 + 32 * 1024 * 1024 + 16 * 1024 * 1024,
        "aggregate memory exceeded the kernel limit: {}",
        o.peak_rss_bytes
    );
}

#[test]
fn kernel_backend_enforces_aggregate_process_count() {
    require_sandbox!("kernel-pids");
    if !kernel_ok("kernel-pids") {
        return;
    }
    let src = stage();
    let code = r#"
import os, time, errno, json
kids, err = 0, None
while kids < 500:
    try:
        pid = os.fork()
    except OSError as e:
        err = errno.errorcode.get(e.errno, str(e.errno)); break
    if pid == 0:
        time.sleep(5); os._exit(0)
    kids += 1
print(json.dumps({"kids": kids, "err": err}))
"#;
    let mut s = spec("kpids", PY, &["-c", code], src.path());
    s.limits.max_procs = 24;
    s.limits.backend = ResourceBackend::KernelScope;
    let o = run_sandboxed(&s, &mut Never).expect("run");
    assert_eq!(o.resource_enforcement, "kernel-cgroup");
    assert!(o.peak_procs <= 24 + 16, "{}", o.peak_procs);
    assert!(
        o.pids_limit_hit || o.exit != ExitKind::Exited(0) || out(&o).contains("EAGAIN"),
        "{:?} {}",
        o.exit,
        out(&o)
    );
}

#[test]
fn polling_backend_worst_case_is_measured_and_labelled() {
    // Documents (and bounds) the polling-only exposure: a fast allocator
    // can exceed the budget before the 50 ms poll notices. The test does
    // not assert the budget held; it asserts the run is bounded by the
    // per-process address-space cap and labelled `rlimit-polling`.
    require_sandbox!("polling-worst");
    let src = stage();
    let code = r#"
b = bytearray(400*1024*1024)
for i in range(0, len(b), 4096): b[i] = 1
import time; time.sleep(30)
"#;
    let mut s = spec("pollmem", PY, &["-c", code], src.path());
    s.limits.memory_bytes = 64 * 1024 * 1024;
    s.limits.address_space_bytes = 1024 * 1024 * 1024;
    s.limits.backend = ResourceBackend::Polling;
    s.limits.wall_ms = 20_000;
    let o = run_sandboxed(&s, &mut Never).expect("run");
    assert_eq!(o.resource_enforcement, "rlimit-polling");
    println!(
        "POLLING WORST CASE: budget 64 MiB, observed peak {} MiB, exit {:?}",
        o.peak_rss_bytes / (1024 * 1024),
        o.exit
    );
    assert!(o.peak_rss_bytes <= 1024 * 1024 * 1024 + 256 * 1024 * 1024);
    assert!(matches!(
        o.exit,
        ExitKind::MemoryLimit | ExitKind::Signaled(_) | ExitKind::Exited(_)
    ));
}

#[test]
fn preflight_reports_resource_enforcement_honestly() {
    let c = preflight();
    println!("kernel_enforced_limits = {}", c.kernel_enforced_limits);
    assert_eq!(c.kernel_enforced_limits, kernel_limits_available());
}

// ============ A3.4 audit: seccomp, procfs, mounts, capabilities ===========

#[test]
fn x32_abi_and_compat_syscalls_cannot_bypass_the_filter() {
    require_sandbox!("x32");
    let src = stage();
    let code = r#"
import ctypes, json, os
libc = ctypes.CDLL(None, use_errno=True)
res = {}
# ptrace(PTRACE_TRACEME) through the x32 ABI number space (bit 30 set).
r = libc.syscall(ctypes.c_long(0x40000000 | 101), 0, 0, 0, 0)
res["x32_ptrace"] = [r, ctypes.get_errno()]
print(json.dumps(res), flush=True)
"#;
    let o = py("x32", code, src.path());
    // Either the process is killed by the filter (no output) or the call
    // fails; it must never succeed.
    let text = out(&o);
    if let Some(line) = text.lines().next() {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(v["x32_ptrace"][0], -1, "{v}");
    } else {
        assert!(
            matches!(o.exit, ExitKind::Signaled(_) | ExitKind::Exited(_)),
            "{:?}",
            o.exit
        );
        assert_ne!(o.exit, ExitKind::Exited(0));
    }
}

#[test]
fn procfs_and_dev_expose_no_writable_host_controls() {
    require_sandbox!("procfs-write");
    let src = stage();
    let code = r#"
import json, os
res = {}
targets = ["/proc/sys/kernel/hostname", "/proc/sys/kernel/core_pattern", "/proc/sys/vm/drop_caches",
           "/proc/sysrq-trigger", "/proc/sys/kernel/modprobe", "/proc/1/oom_score_adj",
           "/proc/self/attr/current", "/dev/mem", "/dev/kmsg", "/dev/sda", "/dev/disk",
           "/dev/fuse", "/dev/net/tun", "/dev/shm/x"]
for t in targets:
    try:
        fd = os.open(t, os.O_WRONLY)
        os.write(fd, b"0")
        res[t] = "WROTE"
    except Exception as e:
        res[t] = type(e).__name__
# Writable mounts: only /tmp and /work/out.
writable = []
for root in ["/", "/usr", "/proc", "/dev", "/work", "/work/src", "/tmp", "/work/out"]:
    try:
        p = os.path.join(root, ".w"); open(p, "w").close(); os.unlink(p); writable.append(root)
    except Exception:
        pass
res["writable"] = sorted(writable)
print(json.dumps(res))
"#;
    let o = py("procw", code, src.path());
    assert_eq!(
        o.exit,
        ExitKind::Exited(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    for (k, val) in v.as_object().unwrap() {
        if k != "writable" {
            assert_ne!(val, "WROTE", "{k} was writable");
        }
    }
    assert_eq!(
        v["writable"],
        serde_json::json!(["/tmp", "/work/out"]),
        "{v}"
    );
}

#[test]
fn toolchain_mounts_are_read_only_and_minimal() {
    require_sandbox!("toolchain-ro");
    let host = tempfile::tempdir().unwrap();
    let tc = host.path().join("tc");
    std::fs::create_dir_all(tc.join("sub")).unwrap();
    std::fs::write(tc.join("sub/f"), "x").unwrap();
    let src = stage();
    let mut s = spec(
        "tcro",
        PY,
        &[
            "-c",
            "import os,json
r={}
for p in ['/toolchain/new','/toolchain/sub/new']:
    try:
        open(p,'w').write('x'); r[p]='WROTE'
    except Exception as e: r[p]=type(e).__name__
r['sub']=sorted(os.listdir('/toolchain'))
print(json.dumps(r))",
        ],
        src.path(),
    );
    s.ro_binds = vec![(tc.clone(), "/toolchain".to_owned())];
    let o = run_sandboxed(&s, &mut Never).expect("run");
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    for p in ["/toolchain/new", "/toolchain/sub/new"] {
        assert_ne!(v[p], "WROTE", "{p}");
    }
    assert!(!tc.join("new").exists() && !tc.join("sub/new").exists());
}

// 12-hour reminder: nothing above uses a shell; every payload is a program
// plus argv, so there is no quoting/expansion surface in the harness.

/// A4.4: namespace-creating clone() flags must be refused. `unshare`/`setns`
/// are denied by number, but `clone(CLONE_NEWUSER|...)` is a different
/// syscall whose danger is in its flag argument.
#[test]
fn nested_namespace_creation_via_clone_is_denied() {
    require_sandbox!("nested-userns");
    let src = stage();
    let code = r#"
import ctypes, os, json
libc = ctypes.CDLL(None, use_errno=True)
SIGCHLD = 17
flags = {"newuser": 0x10000000, "newns": 0x00020000, "newnet": 0x40000000,
         "newpid": 0x20000000, "newuts": 0x04000000, "newipc": 0x08000000,
         "newcgroup": 0x02000000}
res = {}
for name, f in flags.items():
    r = libc.syscall(56, ctypes.c_long(f | SIGCHLD), 0, 0, 0, 0)
    e = ctypes.get_errno()
    if r == 0:
        os._exit(0)          # we are the child of an ALLOWED clone
    if r > 0:
        try: os.waitpid(r, 0)
        except Exception: pass
    res[name] = {"ret": r, "errno": e}
# a plain fork-style clone must still work
r = libc.syscall(56, ctypes.c_long(SIGCHLD), 0, 0, 0, 0)
if r == 0:
    os._exit(0)
os.waitpid(r, 0)
res["plain_fork"] = "ok" if r > 0 else "fail"
print(json.dumps(res))
"#;
    let o = py("nested-ns", code, src.path());
    assert_eq!(
        o.exit,
        ExitKind::Exited(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(out(&o).trim()).unwrap();
    for k in [
        "newuser",
        "newns",
        "newnet",
        "newpid",
        "newuts",
        "newipc",
        "newcgroup",
    ] {
        assert_eq!(v[k]["ret"], -1, "clone with {k} must be refused: {v}");
        // Capability-less namespaces are refused with EPERM; nested user
        // namespaces hit the sandbox's user-namespace limit (ENOSPC).
        let e = v[k]["errno"].as_i64().unwrap();
        assert!(e == 1 || (k == "newuser" && e == 28), "{k}: errno {e}: {v}");
    }
    assert_eq!(
        v["plain_fork"], "ok",
        "ordinary fork must keep working: {v}"
    );
}
