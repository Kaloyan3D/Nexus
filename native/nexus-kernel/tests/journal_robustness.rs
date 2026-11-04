mod common;

use common::{payload, rev3, setup, snapshot};
use nexus_contracts::{ControllerIntentV1, KernelErrorCode};
use nexus_kernel::AcceptRequest;

fn nasty_ids() -> Vec<String> {
    let dq = (34u8 as char).to_string();
    let bs = (92u8 as char).to_string();
    let nl = (10u8 as char).to_string();
    let soh = (1u8 as char).to_string();
    vec![
        ["cmd-quote-", &dq, "-here"].concat(),
        ["cmd-backslash-", &bs, "-here"].concat(),
        "cmd-unicode-héllo".to_owned(),
        ["cmd-control-", &nl, "-", &soh].concat(),
        "cmd-sql-'; DROP TABLE receipts;--".to_owned(),
        "cmd-trailing-space ".to_owned(),
    ]
}

#[test]
fn adversarial_command_ids_round_trip() {
    let (mut kernel, _p) = setup("journal-nasty");
    let task = "task-nasty";
    let ids = nasty_ids();
    for (i, cid) in ids.iter().enumerate() {
        let lease = kernel.acquire_generation(task, "native").expect("acquire");
        let attempt = ["attempt-", &i.to_string()].concat();
        let intent = ControllerIntentV1::build(
            task,
            &attempt,
            cid,
            "native",
            1,
            "muse_main",
            "engineering-v2",
            rev3(),
            payload(),
        )
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
        let snap = snapshot();
        let issued = common::make_issued(&mut kernel, task, &snap);
        let (receipt, created) = kernel
            .accept_command(&AcceptRequest {
                intent: intent.clone(),
                issued: issued.clone(),
                snapshot: snap.clone(),
            })
            .expect("accept nasty id");
        assert!(created);
        let again = kernel.read_receipt(cid).expect("read").expect("present");
        assert_eq!(again, receipt);
        let (replayed, created_again) = kernel
            .accept_command(&AcceptRequest {
                intent,
                issued,
                snapshot: snap,
            })
            .expect("replay");
        assert!(!created_again);
        assert_eq!(replayed, receipt);
    }
    let events = kernel.list_events(task, "native").expect("journal parses");
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == nexus_contracts::KernelEventKind::CommandAccepted)
            .count(),
        ids.len()
    );
    for e in &events {
        if e.kind == nexus_contracts::KernelEventKind::CommandAccepted {
            let seen = e
                .payload
                .get("commandId")
                .and_then(|v| v.as_str())
                .expect("commandId parses");
            assert!(ids.iter().any(|id| id == seen), "payload carries exact id");
        }
    }
    let state = kernel.reconstruct(task, "native").expect("reconstruct");
    assert_eq!(state.receipts.len(), ids.len());
}

#[test]
fn tampered_receipt_status_fails_closed() {
    let (mut kernel, paths) = setup("journal-tamper");
    let (intent1, issued1, snap1) = common::handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    let (intent2, issued2, snap2) = common::handshake(&mut kernel, "task-2", "attempt-2", "cmd-2");
    let (r1, _) = kernel
        .accept_command(&AcceptRequest {
            intent: intent1.clone(),
            issued: issued1.clone(),
            snapshot: snap1.clone(),
        })
        .expect("accept 1");
    let _ = kernel
        .accept_command(&AcceptRequest {
            intent: intent2.clone(),
            issued: issued2.clone(),
            snapshot: snap2.clone(),
        })
        .expect("accept 2");
    assert_eq!(r1.command_id, "cmd-1");
    drop(kernel);
    {
        let conn = rusqlite::Connection::open(&paths.db).expect("raw open");
        conn.execute(
            "UPDATE receipts SET status = 'dispatched-executed' WHERE command_id = 'cmd-1'",
            [],
        )
        .expect("tamper 1");
        conn.execute(
            "UPDATE receipts SET status = '' WHERE command_id = 'cmd-2'",
            [],
        )
        .expect("tamper 2");
    }
    let mut kernel = common::reopen(&paths, true);
    let err1 = kernel
        .read_receipt("cmd-1")
        .expect_err("unknown status must fail");
    assert_eq!(err1.code, KernelErrorCode::StoreCorrupt);
    let err2 = kernel
        .read_receipt("cmd-2")
        .expect_err("empty status must fail");
    assert_eq!(err2.code, KernelErrorCode::StoreCorrupt);
    let replay = kernel.accept_command(&AcceptRequest {
        intent: intent1,
        issued: issued1,
        snapshot: snap1,
    });
    assert!(replay.is_err(), "replay of tampered receipt fails closed");
    assert_eq!(
        replay.expect_err("must fail").code,
        KernelErrorCode::StoreCorrupt
    );
    assert_eq!(
        kernel.count_receipts().expect("count"),
        2,
        "tampering mints nothing"
    );
}
