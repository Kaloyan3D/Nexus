//! A6.1.1: the verified coding outcome is derived from execution receipts only
//! and is independent of the lifecycle state and of model text.
use nexus_client::intent_client::{
    derive_coding_outcome, IntentRun, PendingApproval, ToolActivity,
};

fn act(index: u32, tool: &str, status: &str, approval: Option<&str>) -> ToolActivity {
    ToolActivity {
        index,
        turn: index,
        tool: tool.into(),
        status: status.into(),
        approval_outcome: approval.map(str::to_owned),
        ..Default::default()
    }
}

fn applied_edit(index: u32) -> ToolActivity {
    ToolActivity {
        post_sha256: Some("b".repeat(64)),
        pre_sha256: Some("a".repeat(64)),
        ..act(index, "fs_edit", "executed", Some("approved"))
    }
}

fn test_run(index: u32, verdict: &str, exit: i64) -> ToolActivity {
    ToolActivity {
        verification: Some(verdict.into()),
        exit_code: Some(exit),
        ..act(index, "proc_run", "executed", Some("approved"))
    }
}

fn run(state: &str, acts: Vec<ToolActivity>) -> IntentRun {
    IntentRun {
        intent_type: "repo-code".into(),
        state: state.into(),
        terminal: matches!(state, "completed" | "failed" | "cancelled" | "uncertain"),
        tool_activity: acts,
        ..Default::default()
    }
}

#[test]
fn an_expired_edit_is_not_an_applied_change_and_an_expired_command_is_not_a_test() {
    // the observed fixture run: read ok, edit + command approvals expired, model claims success
    let r = run(
        "completed",
        vec![
            act(1, "fs_read", "executed", None),
            act(2, "fs_edit", "refused", Some("expired")),
            act(3, "proc_run", "refused", Some("expired")),
        ],
    );
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(o.change, "not-applied");
    assert_eq!(o.verification, "blocked-by-approval");
    assert_eq!(
        (
            o.edits_applied,
            o.edits_not_applied,
            o.tests_executed,
            o.tests_not_executed,
            o.blocked_by_approval
        ),
        (0, 1, 0, 1, 2)
    );
    // lifecycle is untouched: the run really is completed
    assert_eq!(r.state, "completed");
}

#[test]
fn the_lifecycle_state_never_decides_the_outcome() {
    for state in ["completed", "failed", "cancelled", "limit-reached"] {
        let r = run(state, vec![act(1, "fs_edit", "refused", Some("denied"))]);
        let o = derive_coding_outcome(&r).unwrap();
        assert_eq!(o.change, "not-applied", "{state}");
        assert_ne!(o.verification, "verified-passed", "{state}");
    }
}

#[test]
fn a_genuinely_applied_edit_and_passing_test_verify() {
    let r = run(
        "completed",
        vec![
            act(1, "fs_read", "executed", None),
            applied_edit(2),
            test_run(3, "pass", 0),
        ],
    );
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(
        (o.change.as_str(), o.verification.as_str()),
        ("applied", "verified-passed")
    );
    assert_eq!(
        (o.edits_applied, o.tests_executed, o.last_exit_code),
        (1, 1, Some(0))
    );
    assert!(!o.stale_after_edit);
}

#[test]
fn a_failing_test_is_a_verified_failure_not_a_missing_one() {
    let r = run("completed", vec![applied_edit(1), test_run(2, "fail", 101)]);
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(o.verification, "verified-failed");
    assert_eq!(o.last_exit_code, Some(101));
}

#[test]
fn a_pass_that_predates_the_last_applied_edit_does_not_verify_the_current_state() {
    let r = run(
        "completed",
        vec![applied_edit(1), test_run(2, "pass", 0), applied_edit(3)],
    );
    let o = derive_coding_outcome(&r).unwrap();
    assert!(o.stale_after_edit);
    assert_eq!(o.verification, "not-yet-verified");
}

#[test]
fn an_edit_without_a_post_image_receipt_or_a_command_without_a_verdict_is_uncertain_never_a_pass() {
    let no_receipt = ToolActivity {
        post_sha256: None,
        ..act(1, "fs_edit", "executed", Some("approved"))
    };
    let o =
        derive_coding_outcome(&run("completed", vec![no_receipt, test_run(2, "pass", 0)])).unwrap();
    assert_eq!(o.uncertain_operations, 1);
    assert_eq!(
        (o.change.as_str(), o.verification.as_str()),
        ("uncertain", "uncertain")
    );
    let no_verdict = ToolActivity {
        verification: None,
        ..act(1, "proc_run", "executed", Some("approved"))
    };
    let o = derive_coding_outcome(&run("completed", vec![no_verdict])).unwrap();
    assert_eq!(o.verification, "uncertain");
    assert_eq!(o.tests_executed, 0);
}

#[test]
fn interrupted_or_uncertain_operations_never_become_a_pass() {
    // activity marked uncertain by the broker (lost daemon answer)
    let r = run(
        "uncertain",
        vec![act(1, "fs_edit", "uncertain", Some("approved"))],
    );
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(
        (o.change.as_str(), o.verification.as_str()),
        ("uncertain", "uncertain")
    );
    // an earlier passing test does not rescue an uncertain later operation
    let r = run(
        "uncertain",
        vec![
            applied_edit(1),
            test_run(2, "pass", 0),
            act(3, "fs_edit", "uncertain", Some("approved")),
        ],
    );
    assert_eq!(derive_coding_outcome(&r).unwrap().verification, "uncertain");
    // a run the broker closed as tool-outcome-uncertain with no recorded activity at all
    let mut r = run("uncertain", vec![]);
    r.error_code = Some("tool-outcome-uncertain".into());
    assert_eq!(derive_coding_outcome(&r).unwrap().verification, "uncertain");
}

#[test]
fn no_proposal_or_no_command_is_reported_as_such_and_a_live_run_is_not_yet_verified() {
    let o = derive_coding_outcome(&run("completed", vec![act(1, "fs_read", "executed", None)]))
        .unwrap();
    assert_eq!(
        (o.change.as_str(), o.verification.as_str()),
        ("none-proposed", "no-test-executed")
    );
    let live = run("tool-running", vec![applied_edit(1)]);
    assert_eq!(
        derive_coding_outcome(&live).unwrap().verification,
        "not-yet-verified"
    );
}

#[test]
fn a_pending_edit_approval_is_a_pending_change_and_never_a_verified_one() {
    let mut r = run(
        "approval-pending",
        vec![act(1, "fs_read", "executed", None)],
    );
    r.pending_approval = Some(PendingApproval {
        approval_id: "a".into(),
        tool: "fs_edit".into(),
        operation: Some("edit".into()),
        ..Default::default()
    });
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(
        (o.change.as_str(), o.verification.as_str()),
        ("pending-approval", "not-yet-verified")
    );
}

#[test]
fn partial_success_is_reported_as_partial() {
    let r = run(
        "completed",
        vec![
            applied_edit(1),
            act(2, "fs_edit", "refused", Some("expired")),
            test_run(3, "pass", 0),
        ],
    );
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(o.change, "partially-applied");
    assert_eq!(o.verification, "verified-passed"); // the command's own verdict, scoped to what ran
    assert_eq!(o.blocked_by_approval, 1);
}

#[test]
fn only_coding_runs_have_an_outcome_and_the_json_shape_is_stable() {
    let mut r = run("completed", vec![]);
    r.intent_type = "repo-inspect".into();
    assert!(derive_coding_outcome(&r).is_none());
    r.intent_type = "model-only".into();
    assert!(derive_coding_outcome(&r).is_none());
    let o = derive_coding_outcome(&run(
        "completed",
        vec![applied_edit(1), test_run(2, "pass", 0)],
    ))
    .unwrap();
    let v = serde_json::to_value(&o).unwrap();
    for k in [
        "verification",
        "change",
        "editsApplied",
        "editsNotApplied",
        "testsExecuted",
        "testsNotExecuted",
        "blockedByApproval",
        "lastExitCode",
        "staleAfterEdit",
        "uncertainOperations",
    ] {
        assert!(v.get(k).is_some(), "{k}");
    }
    // a record from an older broker (no field) still decodes, with no outcome claimed
    let old: IntentRun = serde_json::from_value(serde_json::json!({
        "runId": "r", "requestId": "q", "clientId": "uid:1", "state": "completed", "terminal": true,
        "intentType": "repo-code", "responseMode": "stream", "cancelRequested": false, "createdAtMs": 1, "updatedAtMs": 1
    }))
    .unwrap();
    assert!(old.coding_outcome.is_none());
}

// ---- D5: the outcome must not show "all tests passed" while a recorded check failed

fn digest_run(index: u32, verdict: &str, exit: i64, digest: &str) -> ToolActivity {
    ToolActivity {
        args_digest: Some(digest.into()),
        ..test_run(index, verdict, exit)
    }
}

#[test]
fn an_earlier_failed_check_is_not_hidden_by_a_later_pass_of_a_different_command() {
    // the wide suite failed, then a narrower command passed: NOT "verified-passed"
    let r = run(
        "completed",
        vec![
            applied_edit(1),
            digest_run(2, "fail", 101, "wide-suite"),
            digest_run(3, "pass", 0, "narrow-test"),
        ],
    );
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(o.verification, "verified-mixed", "{o:?}");
    assert_eq!(o.checks_failed_unresolved, 1);
    assert_eq!(o.tests_executed, 2);
}

#[test]
fn re_running_the_same_command_to_a_pass_clears_its_earlier_failure() {
    let r = run(
        "completed",
        vec![
            applied_edit(1),
            digest_run(2, "fail", 101, "suite"),
            applied_edit(3),
            digest_run(4, "pass", 0, "suite"),
        ],
    );
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(o.verification, "verified-passed", "{o:?}");
    assert_eq!(o.checks_failed_unresolved, 0);
}

#[test]
fn failures_that_left_the_bounded_activity_list_still_count() {
    // the activity list keeps only the latest entries; the run's own count covers the whole run
    let mut r = run(
        "completed",
        vec![applied_edit(70), digest_run(71, "pass", 0, "narrow")],
    );
    r.unresolved_failed_checks = 2;
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(o.verification, "verified-mixed");
    assert_eq!(o.checks_failed_unresolved, 2);
}

#[test]
fn an_unverified_pipeline_is_neither_a_pass_nor_a_failure_nor_an_uncertain_operation() {
    let r = run(
        "completed",
        vec![applied_edit(1), digest_run(2, "unverified", 141, "piped")],
    );
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(o.verification, "no-test-executed", "{o:?}");
    assert_eq!(
        (
            o.tests_executed,
            o.checks_unverified,
            o.uncertain_operations
        ),
        (0, 1, 0)
    );
    // and it never turns an earlier failure into a pass
    let r = run(
        "completed",
        vec![
            digest_run(1, "fail", 101, "suite"),
            digest_run(2, "unverified", 141, "piped"),
        ],
    );
    let o = derive_coding_outcome(&r).unwrap();
    assert_eq!(o.verification, "verified-failed", "{o:?}");
}

#[test]
fn a_plain_pass_or_fail_is_unchanged() {
    let o = derive_coding_outcome(&run(
        "completed",
        vec![applied_edit(1), test_run(2, "pass", 0)],
    ))
    .unwrap();
    assert_eq!(
        (o.verification.as_str(), o.checks_failed_unresolved),
        ("verified-passed", 0)
    );
    let o = derive_coding_outcome(&run(
        "completed",
        vec![applied_edit(1), test_run(2, "fail", 1)],
    ))
    .unwrap();
    assert_eq!(o.verification, "verified-failed");
}
