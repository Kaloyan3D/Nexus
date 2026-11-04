//! EM-02: a task generation's binding row is written once and never changes.

use nexus_store::{SealOutcome, Store};

#[test]
fn a_task_binding_is_written_once_and_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(&dir.path().join("k.db")).unwrap();
    assert!(s.fetch_task_binding("task-1").unwrap().is_none());
    let first = s
        .seal_task_binding("task-1", "d1", r#"{"a":1}"#, "seal1")
        .unwrap();
    assert!(matches!(first, SealOutcome::Created));
    // the identical binding again: idempotent
    let again = s
        .seal_task_binding("task-1", "d1", r#"{"a":1}"#, "seal1")
        .unwrap();
    assert!(matches!(again, SealOutcome::Identical));
    // any different binding for the same task: refused, the first one stays
    let Err(err) = s.seal_task_binding("task-1", "d2", r#"{"a":2}"#, "seal2") else {
        panic!("a different binding replaced the first one");
    };
    assert_eq!(err.code.as_str(), "issuance-conflict");
    let (d, json, seal) = s.fetch_task_binding("task-1").unwrap().unwrap();
    assert_eq!(
        (d.as_str(), json.as_str(), seal.as_str()),
        ("d1", r#"{"a":1}"#, "seal1")
    );
    // another task is independent; reopening keeps both
    s.seal_task_binding("task-2", "d3", r#"{"b":1}"#, "seal3")
        .unwrap();
    drop(s);
    let s = Store::open(&dir.path().join("k.db")).unwrap();
    assert_eq!(s.fetch_task_binding("task-1").unwrap().unwrap().0, "d1");
    assert_eq!(s.fetch_task_binding("task-2").unwrap().unwrap().0, "d3");
}
