//! A6.1: the Desktop's fixed `repo-code` limits are a valid, in-ceiling intent
//! and cannot be widened by anything the renderer sends.
use nexus_client::intent_client::{DesktopCodeLimits, DESKTOP_CODE_LIMITS};
use nexus_client::intent_contract::NexusIntentV1;

fn intent_json(limits: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1, "requestId": "gui-req-0001", "idempotencyKey": "gui-idem-0001",
        "intentType": "repo-code", "content": "fix it", "workspaceId": "synthetic-test",
        "limits": limits, "clientLabel": "nexus-desktop"
    })
}

#[test]
fn the_desktop_limits_are_accepted_by_the_intent_contract() {
    let l = serde_json::to_value(DESKTOP_CODE_LIMITS.to_intent_limits()).unwrap();
    let i = NexusIntentV1::parse(&intent_json(l)).expect("valid repo-code intent");
    assert_eq!(i.limits.max_edits, Some(DESKTOP_CODE_LIMITS.max_edits));
    assert_eq!(i.limits.max_tests, Some(DESKTOP_CODE_LIMITS.max_tests));
    assert_eq!(i.limits.max_turns, Some(12));
    assert_eq!(i.limits.max_tool_calls, Some(30));
    assert_eq!(i.limits.max_tool_result_bytes, Some(131_072));
    assert_eq!(i.limits.max_output_tokens, Some(1024));
}

#[test]
fn the_desktop_limits_are_conservative_and_serialize_for_the_renderer() {
    let d: DesktopCodeLimits = DESKTOP_CODE_LIMITS;
    assert!(d.max_turns <= 16 && d.max_tool_calls <= 30 && d.max_edits <= 5 && d.max_tests <= 5);
    assert!(
        d.max_output_tokens <= 1024
            && d.max_tool_result_bytes <= 131_072
            && d.max_runtime_secs <= 1800
    );
    let v = serde_json::to_value(d).unwrap();
    for k in [
        "maxTurns",
        "maxToolCalls",
        "maxToolResultBytes",
        "maxEdits",
        "maxTests",
        "maxOutputTokens",
        "maxRuntimeSecs",
    ] {
        assert!(v[k].is_u64(), "{k}");
    }
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
