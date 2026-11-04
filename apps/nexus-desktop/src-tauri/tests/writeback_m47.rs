//! M4.7: the writeback gate over the Job Scheduler benchmark run (`run_faf5b5f83191930c9ed1b07707702790`). The
//! recorded M4.6 run record is blocked (as it was live); the M4.7 controller's outcome for the same receipts is
//! still blocked (open obligations are not verification); only a fully re-established run is applied.

use nexus_desktop_lib::sync::host::{qualifies, qualifies_with};
use serde_json::{json, Value};

/// The exact fields the gate reads, copied from the recorded run record.
fn recorded() -> Value {
    json!({"terminal": true, "state": "completed", "cancelRequested": false, "errorCode": null,
        "completion": "failing-checks", "unresolvedFailedChecks": 3, "unresolvedUnattestedChecks": 2,
        "codingOutcome": {"blockedByApproval": 0, "change": "applied", "checksFailedUnresolved": 3,
            "checksUnattestedUnresolved": 2, "checksUnverified": 2, "editsApplied": 15, "staleAfterEdit": false,
            "uncertainOperations": 0, "verification": "verified-failed"}})
}

#[test]
fn the_recorded_run_stays_blocked_under_every_policy() {
    for apply_unverified in [false, true] {
        let e = qualifies_with(&recorded(), apply_unverified).unwrap_err();
        assert!(e.contains("compound command"), "{e}");
    }
}

/// The M4.7 replay of the same receipts: no false failure, but two genuine historical failures and two open
/// obligations (`unattested-checks`). Still never applied: a reclassification is not evidence.
#[test]
fn the_m47_outcome_of_the_same_receipts_is_still_blocked() {
    let mut r = recorded();
    r["unresolvedFailedChecks"] = json!(2);
    r["codingOutcome"]["checksFailedUnresolved"] = json!(2);
    r["codingOutcome"]["verification"] = json!("unattested-checks");
    for apply_unverified in [false, true] {
        assert!(qualifies_with(&r, apply_unverified).is_err());
    }
    // the open obligations alone (failures re-run) still block
    r["unresolvedFailedChecks"] = json!(0);
    r["codingOutcome"]["checksFailedUnresolved"] = json!(0);
    r["completion"] = json!("unattested-checks");
    assert!(qualifies(&r).is_err());
}

#[test]
fn only_a_fully_reestablished_run_is_applied() {
    let mut r = recorded();
    r["completion"] = json!("fulfilled");
    r["unresolvedFailedChecks"] = json!(0);
    r["unresolvedUnattestedChecks"] = json!(0);
    r["codingOutcome"]["checksFailedUnresolved"] = json!(0);
    r["codingOutcome"]["checksUnattestedUnresolved"] = json!(0);
    r["codingOutcome"]["verification"] = json!("verified-passed");
    assert!(qualifies(&r).is_ok());
}
