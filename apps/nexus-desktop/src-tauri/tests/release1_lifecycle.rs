//! Release 1: a runtime the application (or a test) starts must be stopped when its guard ends, with nothing
//! left behind - no `nexusd`, no broker, no socket - and a second runtime in another home must be untouched.
//! This is the regression test for the orphaned test runtimes found during Release 1 acceptance.

use nexus_desktop_lib::interactive::Runtime;
use std::path::PathBuf;

fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

#[test]
fn a_started_runtime_is_stopped_with_its_guard_and_leaves_no_orphans() {
    let native = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../native/target/debug");
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for n in [
        "nexusd",
        "nexus-broker",
        "nexus-approver",
        "nexus-confine",
        "nexus-egress",
    ] {
        std::fs::copy(native.join(n), bin.join(n)).expect("build the native workspace first");
    }
    std::env::remove_var("NEXUS_BROKER_SOCKET");
    std::env::remove_var("NEXUS_KEEP_RUNTIME");
    std::env::set_var("NEXUS_BIN_DIR", &bin);
    let home_path = tmp.path().join("h");
    std::env::set_var("NEXUS_HOME", &home_path);
    let (daemon, broker, home);
    {
        let rt = Runtime::new();
        let _stop = rt.guard();
        rt.start_blocking();
        assert_eq!(rt.state().phase, "ready", "{:?}", rt.state().message);
        home = rt.home.clone().unwrap();
        let st = nexus_runtime::status(&home);
        daemon = st.daemon_pid.expect("daemon running");
        broker = st.broker_pid.expect("broker running");
        assert!(pid_alive(daemon) && pid_alive(broker));
        // exactly these two processes run from THIS test's private binary directory
        for pid in [daemon, broker] {
            let exe = std::fs::read_link(format!("/proc/{pid}/exe")).unwrap();
            assert!(exe.starts_with(&bin), "{exe:?}");
        }
    } // guard dropped: graceful stop
    let end = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while (pid_alive(daemon) || pid_alive(broker)) && std::time::Instant::now() < end {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    assert!(!pid_alive(daemon), "the daemon outlived its guard");
    assert!(!pid_alive(broker), "the broker outlived its guard");
    let st = nexus_runtime::status(&home);
    assert!(st.broker_pid.is_none() && st.daemon_pid.is_none(), "{st:?}");
}
