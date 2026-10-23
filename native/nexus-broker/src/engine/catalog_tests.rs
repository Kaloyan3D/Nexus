//! EM-04C1: tool catalog integrity. The catalog a run is offered is a pure function of its kind
//! and the SEALED engine identity; the production catalog is frozen; the signals tool exists in
//! exactly one catalog.

use super::muse_v0::MUSE_V0;
use super::muse_v1::{MUSE_V1_ACTIVE, MUSE_V1_SIGNALS};
use super::*;
use nexus_model::repo_tools as rt;
use nexus_model::ToolProfile as P;

#[test]
fn the_catalog_follows_the_sealed_engine_identity_and_nothing_else() {
    // every coding run is RepoCodeV1 except the one experimental engine's
    for id in [
        "muse-v0",
        "muse-v1-shadow",
        "dual-v1",
        "effort-test-v0",
        "",
        " ",
        "MUSE-V1-SIGNALS",
        "muse-v1-signals ",
        " muse-v1-signals",
        "muse-v1-signals\n",
        "muse-v1-signals\0",
        "muse-v1-signal",
        "muse-v1-signalsX",
        "../muse-v1-signals",
        "muse_v1_signals",
        "muse-v1-signals/../muse-v0",
    ] {
        assert_eq!(tool_catalog_profile(id, true), P::RepoCodeV1, "{id:?}");
        assert_eq!(tool_catalog_profile(id, false), P::RepoInspectV1, "{id:?}");
    }
    assert_eq!(
        tool_catalog_profile(muse_v1::SIGNALS_ENGINE_ID, true),
        P::RepoCodeMuseSignalsV1
    );
    // EM-04C2 S6: the ACTIVE engine has its own row, by exact id (the same frozen catalog)
    assert_eq!(
        tool_catalog_profile(muse_v1::ACTIVE_ENGINE_ID, true),
        P::RepoCodeMuseSignalsV1
    );
    for near in [
        "nexus-adaptive-v1 ",
        " nexus-adaptive-v1",
        "MUSE-V1",
        "nexus-adaptive-v1\n",
        "muse-v11",
        "muse-v1", // the previous identity is NOT an alias: no signals catalog for it
        "NEXUS-ADAPTIVE-V1",
        "nexus-adaptive-v1/../muse-v0",
    ] {
        assert_eq!(tool_catalog_profile(near, true), P::RepoCodeV1, "{near:?}");
    }
    // a read-only run never gets the coding catalog, whatever the engine
    for id in [muse_v1::SIGNALS_ENGINE_ID, muse_v1::ACTIVE_ENGINE_ID] {
        assert_eq!(tool_catalog_profile(id, false), P::RepoInspectV1);
    }
}

#[test]
fn production_muse_v0_offers_the_frozen_baseline_catalog() {
    let p = tool_catalog_profile(MUSE_V0.descriptor().engine_id, true);
    assert_eq!(p, P::RepoCodeV1);
    assert!(rt::verify_catalog(p));
    assert_eq!(
        rt::catalog_digest_for(p),
        "58f513de4ac7097e2d2c44999180ec74295aaaf590d585ff15787b784db8d90b",
        "the digest of the production catalog at baseline 49026e8"
    );
    // the future Muse engine's catalog is another identity
    let m = tool_catalog_profile(muse_v1::SIGNALS_ENGINE_ID, true);
    assert_ne!(rt::frozen_catalog_digest(p), rt::frozen_catalog_digest(m));
}

#[test]
fn every_profile_a_run_can_get_matches_its_frozen_identity() {
    for e in engines(true) {
        for code in [true, false] {
            let p = tool_catalog_profile(e.descriptor().engine_id, code);
            assert!(rt::verify_catalog(p), "{} {code}", e.descriptor().engine_id);
        }
    }
}

#[test]
fn the_signals_catalog_is_reached_in_production_only_through_the_sealed_adaptive_identity() {
    // S10-A: a production build registers muse-v0 and nexus-adaptive-v1. The default engine never
    // gets the signals catalog; the adaptive engine gets exactly the frozen signals/adaptive
    // catalog; the EXPERIMENTAL signals engine is absent, so a resolution naming it fails closed.
    const { assert!(MUSE_V1_PRODUCTION_ENABLED) };
    let prod: Vec<&str> = engines(false)
        .iter()
        .map(|e| e.descriptor().engine_id)
        .collect();
    assert_eq!(prod, ["muse-v0", "nexus-adaptive-v1"]);
    assert_eq!(tool_catalog_profile("muse-v0", true), P::RepoCodeV1);
    assert_eq!(
        tool_catalog_profile(muse_v1::ACTIVE_ENGINE_ID, true),
        P::RepoCodeMuseSignalsV1
    );
    assert!(!prod.contains(&muse_v1::SIGNALS_ENGINE_ID));
    assert!(!prod.contains(&"muse-v1-shadow"));
}

#[test]
fn only_the_sealed_signals_capable_engine_descriptors_carry_the_signals_catalog() {
    // the descriptors that select a profile other than RepoCodeV1
    let special: Vec<&str> = engines(true)
        .iter()
        .map(|e| e.descriptor().engine_id)
        .filter(|id| tool_catalog_profile(id, true) != P::RepoCodeV1)
        .collect();
    assert_eq!(
        special,
        [muse_v1::ACTIVE_ENGINE_ID, muse_v1::SIGNALS_ENGINE_ID],
        "the two Muse signals-capable engines, and no other"
    );
    // its descriptor reserves nothing: the tool's real bytes are in every measured request
    assert_eq!(MUSE_V1_SIGNALS.descriptor().request_reserve_bytes, 0);
    assert_eq!(MUSE_V1_ACTIVE.descriptor().request_reserve_bytes, 0);
    assert_eq!(MUSE_V0.descriptor().request_reserve_bytes, 0);
}
