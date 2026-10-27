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
const ENGINES: [&str; 13] = [
    "muse-v1", // the previous identity of the adaptive engine: not an alias, never resolvable
    "muse-v0",
    "nexus-adaptive-v1",
    "muse-v1-shadow",
    "muse-v1-signals",
    "effort-test-v0",
    "dual-v1",
    "MUSE-V0",
    "muse-v0 ",
    "nexus-adaptive-v1\n",
    "muse_v1",
    "",
    "../nexus-adaptive-v1",
];

/// Exactly two (mode, engine) pairs resolve in a production build (S10-A): the default mode with
/// muse-v0 and the opt-in adaptive mode with nexus-adaptive-v1. Nothing resembling either does.
#[test]
fn only_the_default_pair_and_the_opt_in_adaptive_pair_resolve() {
    let mut ok = Vec::new();
    for mode in MODES {
        for engine in ENGINES {
            if resolve(mode, engine).is_ok() {
                ok.push((mode, engine));
            }
        }
    }
    assert_eq!(
        ok,
        [
            ("engineering-v2", "muse-v0"),
            ("engineering-v2-adaptive", "nexus-adaptive-v1")
        ],
        "{ok:?}"
    );
}

#[test]
fn every_experimental_engine_and_the_former_adaptive_id_are_unavailable_under_every_mode() {
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
    // the adaptive engine runs ONLY in the adaptive mode, and the adaptive mode cannot run the default engine
    for mode in ["engineering-v1", "engineering-v2", "engineering-v3"] {
        assert_eq!(
            resolve(mode, "nexus-adaptive-v1").err().unwrap().code,
            "engine-mode-mismatch",
            "{mode}"
        );
    }
    assert_eq!(
        resolve("engineering-v2-adaptive", "muse-v0")
            .err()
            .unwrap()
            .code,
        "engine-mode-mismatch"
    );
}

#[test]
fn the_activation_gate_is_an_open_compile_time_constant_that_no_environment_can_change() {
    const { assert!(engine::MUSE_V1_PRODUCTION_ENABLED) };
    // there is no runtime switch: the environment can neither close the gate nor register a test engine
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
    assert!(resolve("engineering-v2-adaptive", "nexus-adaptive-v1").is_ok());
    for engine in ["muse-v1-shadow", "muse-v1-signals", "effort-test-v0"] {
        assert_eq!(
            resolve("engineering-v2-adaptive", engine)
                .err()
                .unwrap()
                .code,
            "engine-unavailable",
            "an environment variable must not register {engine}"
        );
    }
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

/// The shipped adaptive definition is the ACTIVE opt-in beta (S10-A), carries the sealed budget and is
/// pinned by the install closure; the default mode is untouched. (File-level: the Registry itself is
/// JavaScript and covered by its own suites.)
#[test]
fn the_shipped_adaptive_definition_is_the_budgeted_opt_in_beta() {
    let def: serde_json::Value = serde_json::from_slice(
        &std::fs::read(repo_root().join("config/registry/modes/engineering-v2-adaptive.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(def["id"], "engineering-v2-adaptive");
    assert_eq!(def["orchestrationEngineId"], "nexus-adaptive-v1");
    assert_eq!(def["status"], "active");
    assert_eq!(def["selectable"], true);
    assert_eq!(def["runnable"], true);
    assert_eq!(def["requestBudgetBytes"], 440_000);
    let closure =
        std::fs::read_to_string(repo_root().join("scripts/MusePresetDependencyClosure.cjs"))
            .unwrap();
    assert!(
        closure.contains("registry/modes/engineering-v2-adaptive.json"),
        "pinned by the install closure"
    );
    let v2: serde_json::Value = serde_json::from_slice(
        &std::fs::read(repo_root().join("config/registry/modes/engineering-v2.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        v2["orchestrationEngineId"], "muse-v0",
        "the default mode still runs muse-v0"
    );
    assert_eq!(v2["status"], "active-legacy");
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
        "913244e7801c4b59236385699c4c8b4daf30e92ac36ca9ad0c7da4ae469e7215"
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
        engine::tool_catalog_profile("nexus-adaptive-v1", true),
        P::RepoCodeMuseSignalsV1
    );
    assert_eq!(
        engine::tool_catalog_profile("nexus-adaptive-v1 ", true),
        P::RepoCodeV1
    );
    assert_eq!(
        engine::tool_catalog_profile("nexus-adaptive-v1", false),
        P::RepoInspectV1
    );
}
