//! A6.1.4: the Desktop's runtime replaces a broker older than the installed binary
//! before work is sent, never while a task is running, and reports a failed restart.
//! Real daemon + broker (private copies of the workspace binaries).

use nexus_desktop_lib::dto::UiError;
use nexus_desktop_lib::interactive::Runtime;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn reinstall(bin: &Path, from: &Path) {
    let t = bin.join("nexus-broker.new");
    std::fs::copy(from, &t).unwrap();
    std::fs::rename(&t, bin.join("nexus-broker")).unwrap();
}

#[test]
fn a_stale_broker_is_replaced_before_submit_unless_a_task_runs() {
    let native = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../native/target/debug");
    let real = native.join("nexus-broker");
    assert!(real.is_file(), "build the native workspace first");
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for n in ["nexusd", "nexus-broker"] {
        std::fs::copy(native.join(n), bin.join(n)).unwrap();
    }
    std::env::remove_var("NEXUS_BROKER_SOCKET");
    std::env::set_var("NEXUS_BIN_DIR", &bin);
    std::env::set_var("NEXUS_HOME", tmp.path().join("home"));
    let rt = Runtime::new();
    let _stop = rt.guard();
    rt.start_blocking();
    assert_eq!(rt.state().phase, "ready");
    let home = rt.home.clone().unwrap();
    let pid0 = nexus_runtime::status(&home).broker_pid.unwrap();
    let marker = home.broker_dir().join("keep.txt");
    std::fs::write(&marker, b"x").unwrap();

    // current: the submit runs, nothing restarts
    let mut called = 0;
    rt.submit_guarded(|| {
        called += 1;
        Ok::<_, UiError>(())
    })
    .unwrap();
    assert_eq!(called, 1);
    assert_eq!(nexus_runtime::status(&home).broker_pid, Some(pid0));
    assert!(!rt.state().update_pending);

    // the installed binary is replaced while a task is running: no restart, clear message,
    // nothing is sent
    reinstall(&bin, &real);
    *rt.activity_probe.lock().unwrap() = Some(Box::new(|| Ok(1)));
    let mut sent = false;
    let e = rt
        .submit_guarded(|| {
            sent = true;
            Ok::<_, UiError>(())
        })
        .unwrap_err();
    assert_eq!(e.code, "runtime-updating");
    assert!(e.message.contains("still running"), "{}", e.message);
    assert!(!sent, "nothing is sent to a stale broker");
    assert_eq!(
        nexus_runtime::status(&home).broker_pid,
        Some(pid0),
        "the task's broker survives"
    );
    let st = rt.state();
    assert!(st.update_pending);
    assert_eq!(st.phase, "ready");

    // idle again: the update is applied and the submission goes through, once
    *rt.activity_probe.lock().unwrap() = Some(Box::new(|| Ok(0)));
    let mut called = 0;
    rt.submit_guarded(|| {
        called += 1;
        Ok::<_, UiError>(())
    })
    .unwrap();
    assert_eq!(called, 1);
    let pid1 = nexus_runtime::status(&home).broker_pid.unwrap();
    assert_ne!(pid1, pid0);
    let st = rt.state();
    assert_eq!((st.phase.as_str(), st.update_pending), ("ready", false));
    assert_eq!(std::fs::read(&marker).unwrap(), b"x", "state survives");

    // a broken new build: reported, nothing sent, never claims ready
    let bad = bin.join("broken");
    std::fs::write(&bad, "#!/bin/sh\n[ \"$1\" = identity ] && exit 3\nexit 1\n").unwrap();
    std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o755)).unwrap();
    reinstall(&bin, &bad);
    let mut sent = false;
    let e = rt
        .submit_guarded(|| {
            sent = true;
            Ok::<_, UiError>(())
        })
        .unwrap_err();
    assert_eq!(e.code, "runtime-updating");
    assert!(e.message.contains("could not restart"), "{}", e.message);
    assert!(!sent);
    assert_eq!(rt.state().phase, "error");

    // the fixed build: one more attempt recovers without the user touching a terminal
    reinstall(&bin, &real);
    rt.submit_guarded(|| Ok::<_, UiError>(())).unwrap();
    assert_eq!(rt.state().phase, "ready");
    let _ = nexus_runtime::stop(&home);
}
