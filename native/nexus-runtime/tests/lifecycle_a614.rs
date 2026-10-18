//! A6.1.4 broker lifecycle: a broker older than the installed binary is detected and
//! replaced when (and only when) nothing is running; state survives; a failed restart is
//! reported and recoverable. Uses private copies of the real binaries (needs
//! `cargo build --workspace` first, like the broker integration tests).

use nexus_runtime::{freshness, start, start_if, status, stop, Freshness, Home, Phase, Tools};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

struct Rig {
    _tmp: tempfile::TempDir,
    bin: PathBuf,
    home: Home,
    tools: Tools,
}

fn rig() -> Rig {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let repo = root.parent().unwrap().to_path_buf();
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for n in ["nexusd", "nexus-broker"] {
        let src = root.join("target/debug").join(n);
        assert!(
            src.is_file(),
            "build the workspace first: {}",
            src.display()
        );
        std::fs::copy(&src, bin.join(n)).unwrap();
    }
    let home = Home {
        root: tmp.path().join("home"),
    };
    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|d| d.join("node"))
        .find(|p| p.is_file())
        .expect("node on PATH");
    let tools = Tools {
        nexusd: bin.join("nexusd"),
        broker: bin.join("nexus-broker"),
        node,
        repo_root: repo,
    };
    Rig {
        _tmp: tmp,
        bin,
        home,
        tools,
    }
}

/// "Install a new build": a new file (new inode) at the same path.
fn reinstall_broker(r: &Rig, from: &Path) {
    let tmp = r.bin.join("nexus-broker.new");
    std::fs::copy(from, &tmp).unwrap();
    std::fs::rename(&tmp, &r.tools.broker).unwrap();
}

fn real_broker() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("target/debug/nexus-broker")
}

#[test]
fn a_replaced_broker_binary_is_detected_and_replaced_when_idle_keeping_state() {
    let r = rig();
    let st = start(&r.home, &r.tools).expect("start");
    assert_eq!(st.phase, Phase::Ready);
    assert_eq!(freshness(&r.home, &r.tools), Freshness::Current);
    // state that must survive a restart
    let creds = std::fs::read(r.home.credentials()).unwrap();
    let marker = r.home.broker_dir().join("keep-me.txt");
    std::fs::write(&marker, b"consent+authorization stand-in").unwrap();
    let old_pid = st.broker_pid.unwrap();

    reinstall_broker(&r, &real_broker());
    assert_eq!(freshness(&r.home, &r.tools), Freshness::Stale);

    let st = start_if(&r.home, &r.tools, || Ok(())).expect("recover");
    assert_eq!(st.phase, Phase::Ready);
    assert_ne!(st.broker_pid.unwrap(), old_pid, "a new broker process");
    assert_eq!(freshness(&r.home, &r.tools), Freshness::Current);
    assert_eq!(std::fs::read(r.home.credentials()).unwrap(), creds);
    assert_eq!(
        std::fs::read(&marker).unwrap(),
        b"consent+authorization stand-in"
    );
    // a second start is a no-op (same process)
    let again = start(&r.home, &r.tools).unwrap();
    assert_eq!(again.broker_pid, st.broker_pid);
    stop(&r.home).unwrap();
}

#[test]
fn a_busy_runtime_is_never_replaced_just_to_update() {
    let r = rig();
    let st = start(&r.home, &r.tools).unwrap();
    reinstall_broker(&r, &real_broker());
    let e = start_if(&r.home, &r.tools, || {
        Err("1 task(s) are still running".into())
    })
    .expect_err("deferred");
    assert!(e.ends_with("still running"), "{e}");
    // nothing was stopped: same processes, still answering, still reported stale
    let now = status(&r.home);
    assert_eq!(now.broker_pid, st.broker_pid);
    assert_eq!(now.daemon_pid, st.daemon_pid);
    assert_eq!(now.phase, Phase::Ready);
    assert_eq!(freshness(&r.home, &r.tools), Freshness::Stale);
    // once idle the update is applied
    let st2 = start_if(&r.home, &r.tools, || Ok(())).unwrap();
    assert_ne!(st2.broker_pid, st.broker_pid);
    stop(&r.home).unwrap();
}

#[test]
fn a_failed_restart_is_reported_and_a_later_start_recovers() {
    let r = rig();
    start(&r.home, &r.tools).unwrap();
    // the "new build" is broken
    let bad = r.bin.join("broken");
    std::fs::write(&bad, "#!/bin/sh\n[ \"$1\" = identity ] && exit 3\nexit 1\n").unwrap();
    std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o755)).unwrap();
    reinstall_broker(&r, &bad);
    let e = start_if(&r.home, &r.tools, || Ok(()));
    assert!(e.is_err(), "a broken broker must not look ready: {e:?}");
    assert_ne!(status(&r.home).phase, Phase::Ready);
    // the fixed build is installed: the next start brings everything back
    reinstall_broker(&r, &real_broker());
    let st = start(&r.home, &r.tools).expect("recover after fix");
    assert_eq!(st.phase, Phase::Ready);
    assert_eq!(freshness(&r.home, &r.tools), Freshness::Current);
    stop(&r.home).unwrap();
}

#[test]
fn a_killed_daemon_is_restarted_alone_while_the_broker_keeps_running() {
    let r = rig();
    let st = start(&r.home, &r.tools).unwrap();
    let (dpid, bpid) = (st.daemon_pid.unwrap(), st.broker_pid.unwrap());
    let cap = std::fs::read(r.home.issuer_cap()).unwrap();
    unsafe { libc::kill(dpid as i32, libc::SIGKILL) };
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(status(&r.home).daemon_pid.is_none());
    let st2 = start(&r.home, &r.tools).expect("daemon-only restart");
    assert_eq!(st2.phase, Phase::Ready);
    assert_ne!(st2.daemon_pid.unwrap(), dpid, "a new daemon");
    assert_eq!(
        st2.broker_pid.unwrap(),
        bpid,
        "the broker (and its running work) was not touched"
    );
    // the new daemon issued a new capability file; the broker re-reads it when the old one is refused
    assert_ne!(std::fs::read(r.home.issuer_cap()).unwrap(), cap);
    // the restarted daemon answers its socket with that capability
    let c = nexus_client::issuer::read_capability(&r.home.issuer_cap()).unwrap();
    let s = nexus_client::issuer::issuer_call(
        &r.home.daemon_socket(),
        &c,
        "status",
        serde_json::json!({}),
    )
    .unwrap();
    assert_eq!(s["ok"], true, "{s}");
    stop(&r.home).unwrap();
}
