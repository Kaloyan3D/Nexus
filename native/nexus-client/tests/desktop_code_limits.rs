//! `repo-code` limits: Nexus sends only a per-call output ceiling and whatever the person chose; there is
//! no built-in ceiling on edits, tests, bytes, tool calls, turns or time.
use nexus_client::intent_client::{
    DesktopCodeLimits, UserLimits, DESKTOP_CODE_LIMITS, INTERACTIVE_CODE_LIMITS,
};
use nexus_client::intent_contract::NexusIntentV1;

fn intent_json(limits: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1, "requestId": "gui-req-0001", "idempotencyKey": "gui-idem-0001",
        "intentType": "repo-code", "content": "fix it", "workspaceId": "synthetic-test",
        "limits": limits, "clientLabel": "nexus-desktop"
    })
}

#[test]
fn the_profile_limits_carry_only_the_per_call_output_ceiling_and_are_accepted_by_the_contract() {
    let l = serde_json::to_value(DESKTOP_CODE_LIMITS.to_intent_limits()).unwrap();
    // nothing else is sent: Nexus has no ceiling of its own on edits, tests, bytes, tool calls, turns or time
    assert_eq!(l, serde_json::json!({"maxOutputTokens": 1024}));
    let i = NexusIntentV1::parse(&intent_json(l)).expect("valid repo-code intent");
    assert_eq!(i.limits.max_output_tokens, Some(1024));
    assert!(i.limits.max_turns.is_none() && i.limits.max_tool_calls.is_none());
    assert!(i.limits.max_tool_result_bytes.is_none() && i.limits.max_runtime_secs.is_none());
    // the interactive profile's per-call ceiling is larger (whole files), still just one request parameter
    assert_eq!(INTERACTIVE_CODE_LIMITS.max_output_tokens, 32_768);
}

#[test]
fn a_persons_own_limits_are_the_only_limits_that_reach_the_intent() {
    let mine = UserLimits {
        max_turns: Some(40),
        max_tool_calls: None,
        max_runtime_secs: Some(3600),
    };
    let l = serde_json::to_value(mine.to_intent_limits(INTERACTIVE_CODE_LIMITS)).unwrap();
    assert_eq!(
        l,
        serde_json::json!({"maxOutputTokens": 32768, "maxTurns": 40, "maxRuntimeSecs": 3600})
    );
    assert!(NexusIntentV1::parse(&intent_json(l)).is_ok());
    // none chosen = none sent; and the renderer-facing view serialises with no fields at all
    assert_eq!(
        serde_json::to_value(UserLimits::default()).unwrap(),
        serde_json::json!({})
    );
    let v = serde_json::to_value(DesktopCodeLimits {
        max_output_tokens: 7,
    })
    .unwrap();
    assert_eq!(v, serde_json::json!({"maxOutputTokens": 7}));
}

#[test]
fn a_pending_approval_reaches_the_client_with_its_proposal_and_restrictions_and_tolerates_older_records(
) {
    // Older run records (no A6.1 fields) still decode; new ones carry the details.
    let old: nexus_client::intent_client::PendingApproval = serde_json::from_value(serde_json::json!({
        "approvalId": "a", "tool": "fs_edit", "summary": "edit x", "requestDigest": null, "expiresAtMs": null
    }))
    .unwrap();
    assert!(old.operation.is_none() && old.restrictions.is_empty());
    let new: nexus_client::intent_client::PendingApproval = serde_json::from_value(serde_json::json!({
        "approvalId": "a", "tool": "proc_run", "summary": "cargo test", "requestDigest": "d", "expiresAtMs": 5,
        "operation": "command", "target": "cargo", "proposal": "cargo test --offline", "restrictions": ["network access is disabled"], "createdAtMs": 1
    }))
    .unwrap();
    assert_eq!(new.operation.as_deref(), Some("command"));
    let back = serde_json::to_value(&new).unwrap();
    assert_eq!(back["restrictions"][0], "network access is disabled");
}
