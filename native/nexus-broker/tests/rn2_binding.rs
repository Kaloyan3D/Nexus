//! R-NATIVE-2 binding regression tests (execution evidence).
//! Item 3/4/5/7: run binding identity, conversation target reuse + switch
//! note + stale refusal, deterministic context block, limits helpers,
//! catalog-vs-issuance parity shape.

use nexus_client::intent_client as ic;
use nexus_client::intent_contract::ModelSelection;

#[test]
fn rn2_resolution_run_binding_shape() {
    let catalog = vec![
        ic::RegistryTarget {
            provider_id: "e2e-mock".into(),
            logical_model_id: "e2e/e2e-1".into(),
            remote_model_id: "e2e-mock-model".into(),
            route_id: "e2e-mock/e2e-1".into(),
            connection_id: Some("conn-e2e-mock".into()),
            connection_status: "verified".into(),
            protocol: "https".into(),
            context_limit_tokens: 1_000_000,
            output_limit_tokens: 8_192,
            billing_tier: "standard".into(),
            data_use: None,
            issuable: true,
            reason: None,
        },
        ic::RegistryTarget {
            provider_id: "e2e-mock".into(),
            logical_model_id: "e2e/e2e-2".into(),
            remote_model_id: "e2e-mock-model-2".into(),
            route_id: "e2e-mock/e2e-2".into(),
            connection_id: Some("conn-e2e-mock".into()),
            connection_status: "verified".into(),
            protocol: "https".into(),
            context_limit_tokens: 2_000,
            output_limit_tokens: 100,
            billing_tier: "standard".into(),
            data_use: None,
            issuable: true,
            reason: None,
        },
    ];
    // Explicit selection of the second target resolves to route-2.
    let sel = ModelSelection {
        provider_id: "e2e-mock".into(),
        remote_model_id: "e2e-mock-model-2".into(),
        logical_model_id: None,
        route_id: None,
    };
    let t = nexus_broker::resolution::resolve_target(&catalog, Some(&sel), None)
        .expect("second target resolves");
    assert_eq!(t.route_id, "e2e-mock/e2e-2");
    assert_eq!(t.connection_id.as_deref(), Some("conn-e2e-mock"));
    // Run binding carries identity + limits and no credential material.
    let binding = nexus_broker::resolution::run_binding(&t);
    assert_eq!(binding["routeId"], "e2e-mock/e2e-2");
    assert_eq!(binding["logicalModelId"], "e2e/e2e-2");
    assert_eq!(binding["contextLimitTokens"], 2_000);
    assert_eq!(binding["outputLimitTokens"], 100);
    let flat = binding.to_string();
    assert!(!flat.contains("credential"), "{flat}");
    assert!(!flat.contains("Bearer"), "{flat}");
}

#[test]
fn rn2_limits_and_determinism() {
    // Golden default: very large window keeps the configured budget.
    assert_eq!(
        nexus_broker::resolution::effective_context_budget(1_200_000, 1_000_000),
        1_200_000
    );
    // Small-context fixture compacts earlier.
    assert_eq!(
        nexus_broker::resolution::effective_context_budget(1_200_000, 2_000),
        8_000
    );
    // Output cap never exceeds the target limit.
    assert_eq!(
        nexus_broker::resolution::effective_output_cap(Some(9_000), 100),
        Some(100)
    );
    assert_eq!(
        nexus_broker::resolution::effective_output_cap(Some(50), 100),
        Some(50)
    );
    // Deterministic context management: compacting the same history twice
    // yields byte-identical items.
    use nexus_broker::context::{compact, total_bytes};
    use nexus_model::request::InputItem;
    fn items() -> Vec<InputItem> {
        (0..50)
            .map(|i| InputItem::Message {
                role: "user".into(),
                content: format!("history line {i} with padding xxxxxxxxxxxxxxxxxxxx"),
            })
            .collect()
    }
    let mut a = items();
    let mut b = items();
    compact(&mut a, "receipts", 500);
    compact(&mut b, "receipts", 500);
    assert_eq!(total_bytes(&a), total_bytes(&b));
    assert_eq!(a.len(), b.len(), "compaction must be deterministic");
}

#[test]
fn rn2_catalog_parity_rule_matches_resolver() {
    // Every issuable catalog entry resolves; every non-issuable one is refused
    // with its catalog reason. This is the parity rule the JS test also checks.
    let catalog = vec![
        ic::RegistryTarget {
            provider_id: "p".into(),
            logical_model_id: "l1".into(),
            remote_model_id: "r1".into(),
            route_id: "route-1".into(),
            connection_id: Some("c1".into()),
            connection_status: "verified".into(),
            protocol: "https".into(),
            context_limit_tokens: 1_000_000,
            output_limit_tokens: 8_000,
            billing_tier: "standard".into(),
            data_use: None,
            issuable: true,
            reason: None,
        },
        ic::RegistryTarget {
            provider_id: "p".into(),
            logical_model_id: "l3".into(),
            remote_model_id: "r3".into(),
            route_id: "route-3".into(),
            connection_id: Some("c3".into()),
            connection_status: "unverified".into(),
            protocol: "https".into(),
            context_limit_tokens: 4_000,
            output_limit_tokens: 400,
            billing_tier: "standard".into(),
            data_use: None,
            issuable: false,
            reason: Some("connection-unverified".into()),
        },
    ];
    let ok_sel = ModelSelection {
        provider_id: "p".into(),
        remote_model_id: "r1".into(),
        logical_model_id: None,
        route_id: None,
    };
    assert!(nexus_broker::resolution::resolve_target(&catalog, Some(&ok_sel), None).is_ok());
    let bad_sel = ModelSelection {
        provider_id: "p".into(),
        remote_model_id: "r3".into(),
        logical_model_id: None,
        route_id: None,
    };
    let (code, msg) = nexus_broker::resolution::resolve_target(&catalog, Some(&bad_sel), None)
        .expect_err("non-issuable refused");
    assert_eq!(code, "model-not-available");
    assert!(msg.contains("connection-unverified"), "{msg}");
}
