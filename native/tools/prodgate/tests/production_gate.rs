//! EM-04C2 S9: what a PRODUCTION build of the broker (default features, no `test-engines`) does.
//!
//! Functional proof first: every test calls the real production code paths. The companion script
//! (`scripts/EM04C2-ReleaseGate.cjs`) additionally scans the produced test binary for the symbols
//! of the test-only modules, as a second, weaker line of evidence.
//!
//! Run: `cargo test --release --manifest-path native/tools/prodgate/Cargo.toml`

use nexus_broker::engine::{self, resolve};
use nexus_broker::engine_state::{key_admissible, EngineStateStore, PUBLISHED_TEST_KEY_SHA256};
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

const MODES: [&str; 6] = [
    "engineering-v1",
    "engineering-v2",
    "engineering-v2-adaptive",
    "engineering-v3",
    "engineering-v2-adaptive ",
    "",
];
const ENGINES: [&str; 12] = [
    "muse-v0",
    "muse-v1",
    "muse-v1-shadow",
    "muse-v1-signals",
    "effort-test-v0",
    "dual-v1",
    "MUSE-V0",
    "muse-v0 ",
    "muse-v1\n",
    "muse_v1",
    "",
    "../muse-v1",
];

/// Exactly one (mode, engine) pair resolves in a production build: the default mode with muse-v0.
#[test]
fn only_the_default_mode_with_muse_v0_resolves() {
    let mut ok = Vec::new();
    for mode in MODES {
        for engine in ENGINES {
            if resolve(mode, engine).is_ok() {
                ok.push((mode, engine));
            }
        }
    }
    assert_eq!(ok, [("engineering-v2", "muse-v0")], "{ok:?}");
}

#[test]
fn every_experimental_and_adaptive_engine_is_unavailable_under_every_mode() {
    for engine in [
        "muse-v1",
        "muse-v1-shadow",
        "muse-v1-signals",
        "effort-test-v0",
    ] {
        for mode in MODES {
            let e = resolve(mode, engine)
                .err()
                .unwrap_or_else(|| panic!("{engine} resolved under {mode:?}"));
            assert_eq!(e.code, "engine-unavailable", "{mode:?} {engine}");
            assert!(e.message.contains("nothing was sent"));
        }
    }
    // the adaptive mode cannot run the default engine either
    assert_eq!(
        resolve("engineering-v2-adaptive", "muse-v0")
            .err()
            .unwrap()
            .code,
        "engine-mode-mismatch"
    );
}

#[test]
fn the_activation_gate_is_a_closed_compile_time_constant() {
    const { assert!(!engine::MUSE_V1_PRODUCTION_ENABLED) };
    // there is no runtime switch to open it: the environment cannot register an engine
    for var in [
        "NEXUS_MUSE_V1",
        "NEXUS_MUSE_V1_ENABLED",
        "NEXUS_ENABLE_ADAPTIVE",
        "NEXUS_TEST_ENGINES",
        "MUSE_V1_PRODUCTION_ENABLED",
    ] {
        // SAFETY: single test in this process touching these names
        unsafe { std::env::set_var(var, "1") };
    }
    assert_eq!(
        resolve("engineering-v2-adaptive", "muse-v1")
            .err()
            .unwrap()
            .code,
        "engine-unavailable",
        "an environment variable must not open the gate"
    );
}

/// The published HMAC key of the EM-03 fixtures is refused by `EngineStateStore::open` itself.
#[test]
fn the_published_test_hmac_key_is_refused_by_the_real_store() {
    // located by its suffix, so that this test binary does not itself embed the fixture's marker
    // name (the release gate scans production test binaries for it)
    let dir = repo_root().join("native/nexus-broker/tests/fixtures/em03-engine-state");
    let file = std::fs::read_dir(&dir)
        .expect("the fixture directory")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.to_string_lossy().ends_with("-em03-hmac-key.hex"))
        .expect("the published fixture key file");
    let hex_key = std::fs::read_to_string(file).expect("the published fixture key");
    assert_eq!(
        nexus_contracts::sha256_hex(&hex_key),
        PUBLISHED_TEST_KEY_SHA256,
        "the fingerprint is the fixture file's"
    );
    let key: [u8; 32] = hex::decode(hex_key.trim()).unwrap().try_into().unwrap();
    assert!(!key_admissible(&key, false));
    assert!(
        key_admissible(&[7u8; 32], false),
        "any other key is admissible"
    );
    // functional: a state root whose key file IS the published key
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("engine")).unwrap();
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(dir.path().join("engine-state.key"))
        .unwrap();
    f.write_all(hex_key.trim().as_bytes()).unwrap();
    drop(f);
    let e = EngineStateStore::open(dir.path()).err().expect("refused");
    assert_eq!(e.code, "engine-state-key-refused", "{}", e.message);
    // a freshly minted key is accepted (the store works in production)
    let fresh = tempfile::tempdir().unwrap();
    EngineStateStore::open(fresh.path()).expect("a fresh key is fine");
}

/// The shipped adaptive definition is dormant and carries the sealed budget; no install closure
/// pins it. (File-level: the Registry itself is JavaScript and covered by its own suites.)
#[test]
fn the_shipped_adaptive_definition_is_dormant_and_budgeted() {
    let def: serde_json::Value = serde_json::from_slice(
        &std::fs::read(repo_root().join("config/registry/modes/engineering-v2-adaptive.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(def["id"], "engineering-v2-adaptive");
    assert_eq!(def["orchestrationEngineId"], "muse-v1");
    assert_eq!(def["status"], "planned");
    assert_eq!(def["selectable"], false);
    assert_eq!(def["runnable"], false);
    assert_eq!(def["requestBudgetBytes"], 440_000);
    let closure =
        std::fs::read_to_string(repo_root().join("scripts/MusePresetDependencyClosure.cjs"))
            .unwrap();
    assert!(
        !closure.contains("engineering-v2-adaptive"),
        "not in the install closure"
    );
    let v2: serde_json::Value = serde_json::from_slice(
        &std::fs::read(repo_root().join("config/registry/modes/engineering-v2.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        v2["orchestrationEngineId"], "muse-v0",
        "the default mode still runs muse-v0"
    );
}

/// Catalog identity: the three frozen tool catalogs of the production build.
#[test]
fn the_frozen_tool_catalog_digests_are_the_pinned_ones() {
    use nexus_model::{repo_tools as rt, ToolProfile as P};
    assert_eq!(
        engine::tool_catalog_profile("muse-v0", true),
        P::RepoCodeV1,
        "production muse-v0 offers the baseline catalog"
    );
    assert_eq!(
        rt::frozen_catalog_digest(P::RepoCodeV1),
        "58f513de4ac7097e2d2c44999180ec74295aaaf590d585ff15787b784db8d90b"
    );
    assert!(rt::frozen_catalog_digest(P::RepoInspectV1).starts_with("b06d9c9f"));
    assert!(rt::frozen_catalog_digest(P::RepoCodeMuseSignalsV1).starts_with("5f7d19e2"));
    for p in [P::RepoCodeV1, P::RepoInspectV1, P::RepoCodeMuseSignalsV1] {
        assert!(
            rt::verify_catalog(p),
            "{p:?}: this build offers exactly its frozen bytes"
        );
    }
    // the adaptive engine's row exists, by exact id only
    assert_eq!(
        engine::tool_catalog_profile("muse-v1", true),
        P::RepoCodeMuseSignalsV1
    );
    assert_eq!(
        engine::tool_catalog_profile("muse-v1 ", true),
        P::RepoCodeV1
    );
    assert_eq!(
        engine::tool_catalog_profile("muse-v1", false),
        P::RepoInspectV1
    );
}
