//! Shared integration-test support: the native binaries the tests spawn.
//!
//! `cargo test -p nexus-broker` builds only this crate; the `nexusd`, `nexus` and
//! `nexus-approver` binaries live in other crates, so cargo left whatever an earlier build
//! produced in `target/debug`. That could be a stale daemon or one built WITHOUT the
//! `crash-injection` feature (only a workspace test build unifies it in), which made the
//! crash-point tests fail with "the crash point never fired".
//!
//! `native_bin` therefore builds the binaries once per test process, with the feature, exactly as
//! the tests need them. Cargo's own fingerprinting makes this a no-op when they are current.
//! Set `NEXUS_TEST_SKIP_BIN_BUILD=1` to use the binaries as they are (for example in a sandbox
//! that already built them).

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Once;

static BUILT: Once = Once::new();

fn ensure_built() {
    BUILT.call_once(|| {
        if std::env::var_os("NEXUS_TEST_SKIP_BIN_BUILD").is_some() {
            return;
        }
        let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
        let status = std::process::Command::new(cargo)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .args([
                "build",
                "--offline",
                "-p",
                "nexus-daemon",
                "-p",
                "nexus-cli",
                "-p",
                "nexus-tools",
                "--bins",
                "--features",
                "nexus-tools/crash-injection",
            ])
            .status()
            .expect("run cargo to build the native test binaries");
        assert!(
            status.success(),
            "building the native test binaries failed; a stale binary must not be used"
        );
    });
}

pub fn native_bin(name: &str) -> PathBuf {
    ensure_built();
    // a build in a custom target directory (CI, the Nexus sandbox) is where cargo put the binaries
    if let Some(dir) = std::env::var_os("CARGO_TARGET_DIR") {
        return PathBuf::from(dir).join("debug").join(name);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("target")
        .join("debug")
        .join(name)
}
