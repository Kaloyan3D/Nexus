//! R-NATIVE-1: serialization + backward-compatibility contract tests for
//! `AllowedModel` (unchanged) and `RegistryTarget` (new, read-only catalog).

use nexus_client::intent_client::{AllowedModel, RegistryTarget};

fn target() -> RegistryTarget {
    RegistryTarget {
        provider_id: "e2e-mock".into(),
        logical_model_id: "e2e/e2e-1".into(),
        remote_model_id: "e2e-mock-model".into(),
        route_id: "e2e-mock/e2e-1".into(),
        connection_id: Some("conn-e2e-mock".into()),
        connection_status: "connected".into(),
        protocol: "openai-responses".into(),
        context_limit_tokens: 8192,
        output_limit_tokens: 1024,
        billing_tier: "e2e-unmetered-test".into(),
        data_use: Some("contributor".into()),
        issuable: true,
        reason: None,
    }
}

#[test]
fn registry_target_camel_case_round_trip() {
    let t = target();
    let v = serde_json::to_value(&t).unwrap();
    for k in [
        "providerId",
        "logicalModelId",
        "remoteModelId",
        "routeId",
        "connectionId",
        "connectionStatus",
        "protocol",
        "contextLimitTokens",
        "outputLimitTokens",
        "billingTier",
        "dataUse",
        "issuable",
    ] {
        assert!(!v[k].is_null(), "missing camelCase key {k}: {v}");
    }
    // `reason` is None -> omitted.
    assert!(v.get("reason").is_none(), "{v}");
    let back: RegistryTarget = serde_json::from_value(v).unwrap();
    assert_eq!(back, t);
}

#[test]
fn registry_target_never_carries_credentials_or_paths() {
    let text = serde_json::to_string(&target()).unwrap().to_lowercase();
    for bad in ["credential", "secret", "bearer", ".json", "/tmp", ":\\"] {
        assert!(!text.contains(bad), "leak {bad}: {text}");
    }
}

#[test]
fn registry_target_missing_optionals_default_and_extra_fields_ignored() {
    // Older/sparser bridge output: only the required quartet + issuable.
    let v = serde_json::json!({
        "providerId": "p", "logicalModelId": "l", "remoteModelId": "r",
        "routeId": "rt", "issuable": false, "reason": "connection-not-connected",
        "futureField": {"nested": [1, 2, 3]},
    });
    let t: RegistryTarget = serde_json::from_value(v).unwrap();
    assert_eq!(t.provider_id, "p");
    assert_eq!(t.connection_id, None);
    assert_eq!(t.connection_status, "");
    assert_eq!(t.context_limit_tokens, 0);
    assert!(!t.issuable);
    assert_eq!(t.reason.as_deref(), Some("connection-not-connected"));
}

#[test]
fn allowed_model_shape_is_unchanged_and_targets_are_optional() {
    // Exact pre-existing fields, exact camelCase names.
    let v = serde_json::json!({
        "providerId": "e2e-mock", "remoteModelId": "e2e-mock-model",
        "logicalModelId": "e2e/e2e-1", "endpointKind": "provider",
        "outputLimitTokens": 1024,
    });
    let m: AllowedModel = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(serde_json::to_value(&m).unwrap(), v);
    // The broker's intent-models reply keeps `models` required and `targets`
    // optional: an old client that only reads `models` still decodes.
    let reply = serde_json::json!({ "models": [v] });
    let models: Vec<AllowedModel> = serde_json::from_value(reply["models"].clone()).unwrap();
    assert_eq!(models.len(), 1);
    let with_targets =
        serde_json::json!({ "models": [v], "targets": [serde_json::to_value(target()).unwrap()] });
    let models2: Vec<AllowedModel> =
        serde_json::from_value(with_targets["models"].clone()).unwrap();
    let targets: Vec<RegistryTarget> =
        serde_json::from_value(with_targets["targets"].clone()).unwrap();
    assert_eq!(models2, models);
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].route_id, "e2e-mock/e2e-1");
}

/// The golden wire shape shared with the Desktop: the same file is typed against the TypeScript
/// `RegistryTarget` in `apps/nexus-desktop/src/test/contract.test.ts`. Whatever Rust serializes must be
/// exactly this (optional fields omitted, never null), so the two sides cannot drift apart silently.
#[test]
fn the_registry_target_wire_shape_is_the_one_the_desktop_contract_expects() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/nexus-desktop/src/test/contract/registry-targets.json"
    );
    let raw = std::fs::read_to_string(path).expect("golden contract file");
    let golden: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let parsed: Vec<nexus_client::intent_client::RegistryTarget> =
        serde_json::from_value(golden.clone()).expect("the golden file parses as RegistryTarget");
    assert_eq!(parsed.len(), 2);
    assert!(parsed[0].issuable && parsed[0].reason.is_none());
    assert!(!parsed[1].issuable && parsed[1].reason.as_deref() == Some("connection-not-connected"));
    assert_eq!(
        serde_json::to_value(&parsed).unwrap(),
        golden,
        "Rust serializes a RegistryTarget differently from the contract file"
    );
}
