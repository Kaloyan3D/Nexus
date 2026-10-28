//! Release 1: a computer without Node.js, and an installation whose programs are missing, must fail at
//! start-up with a message that names the cause - never with a hang or a half-started runtime. (The page
//! turns these into steps; see `startupHelp`.) One test per process: the environment is global.

use nexus_desktop_lib::interactive::Runtime;

#[test]
fn a_missing_node_is_reported_by_the_runtime_state_and_nothing_is_started() {
    let native =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../native/target/debug");
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for n in ["nexusd", "nexus-broker"] {
        std::fs::copy(native.join(n), bin.join(n)).expect("build the native workspace first");
    }
    let empty = tmp.path().join("empty-path");
    std::fs::create_dir(&empty).unwrap();
    std::env::remove_var("NEXUS_BROKER_SOCKET");
    std::env::set_var("NEXUS_BIN_DIR", &bin);
    std::env::set_var("NEXUS_HOME", tmp.path().join("home"));
    std::env::set_var("PATH", &empty); // no node anywhere
    let rt = Runtime::new();
    rt.start_blocking();
    let st = rt.state();
    assert_eq!(st.phase, "error", "{st:?}");
    let msg = st.message.expect("the cause is given");
    assert!(msg.contains("node was not found"), "{msg}");
    assert!(!st.can_open_projects && !st.provider_connected && !st.consent.given);
    // nothing was left running
    assert!(
        !tmp.path().join("home").join("run").exists()
            || nexus_runtime::status(rt.home.as_ref().unwrap())
                .broker_pid
                .is_none()
    );
}
