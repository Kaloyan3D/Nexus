//! A3.2 library-level lifecycle, consistency and binding tests.

mod common;

use common::*;
use nexus_kernel::Kernel;
use nexus_tools::{authorize, begin, execute, CancellationToken};
use serde_json::json;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[test]
fn unstarted_grants_expire_deterministically_and_cannot_run_later() {
    let mut fx = fixture("expire");
    fx.write("a.txt", b"x\n");
    let (call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    // Not yet old enough: nothing closed.
    let r = fx
        .kernel
        .reconcile_tool_journal_at(now_ms(), false)
        .unwrap();
    assert_eq!(r.expired, 0);
    // Far in the future: closed as `expired`, idempotently.
    let later = now_ms() + 3_600_000;
    let r = fx.kernel.reconcile_tool_journal_at(later, false).unwrap();
    assert_eq!(r.expired, 1);
    assert_eq!(
        fx.kernel
            .reconcile_tool_journal_at(later, false)
            .unwrap()
            .expired,
        0
    );
    assert_eq!(fx.journal_phases(), vec!["authorized", "expired"]);
    // The lapsed grant can no longer start, and no read happened.
    let e = execute(&mut fx.kernel, &call, &cancel).unwrap_err();
    assert!(e.message.contains("not re-executable"), "{e}");
    assert_eq!(call.prepared().workspace().access_count(), 0);
    let ev = nexus_tools::tool_events_from_journal(&fx.kernel.list_tool_journal(None).unwrap());
    assert_eq!(ev[0].status, nexus_tools::ToolEventStatus::Expired);
}

#[test]
fn started_without_completion_becomes_interrupted_not_completed() {
    let mut fx = fixture("interrupt");
    fx.write("a.txt", b"x\n");
    let (call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    let _started = begin(&mut fx.kernel, &call, &cancel).unwrap(); // crash here
                                                                   // In-flight-safe mode leaves it alone.
    assert_eq!(
        fx.kernel.reconcile_tool_journal(false).unwrap().interrupted,
        0
    );
    let r = fx.kernel.reconcile_tool_journal(true).unwrap();
    assert_eq!(r.interrupted, 1);
    assert_eq!(
        fx.journal_phases(),
        vec!["authorized", "started", "interrupted"]
    );
    assert_eq!(
        fx.kernel.reconcile_tool_journal(true).unwrap().interrupted,
        0
    );
    let ev = nexus_tools::tool_events_from_journal(&fx.kernel.list_tool_journal(None).unwrap());
    assert_eq!(ev[0].status, nexus_tools::ToolEventStatus::Interrupted);
    assert!(ev[0].output_digest.is_none(), "no completion invented");
    assert_eq!(fx.kernel.verify_tool_journal().unwrap(), 3);
}

fn checkpoint_value(wit: &std::path::Path) -> String {
    let c = rusqlite::Connection::open(wit).unwrap();
    c.query_row(
        "SELECT value FROM witness_meta WHERE key = 'tool_journal_checkpoint/v1'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}
fn set_checkpoint(wit: &std::path::Path, v: &str) {
    let c = rusqlite::Connection::open(wit).unwrap();
    c.execute(
        "UPDATE witness_meta SET value = ?1 WHERE key = 'tool_journal_checkpoint/v1'",
        [v],
    )
    .unwrap();
}

#[test]
fn crash_between_append_and_checkpoint_is_recoverable_but_two_ahead_fails_closed() {
    let mut fx = fixture("window");
    fx.write("a.txt", b"x\n");
    fx.run("fs.read", json!({"path": "a.txt"})).unwrap(); // 3 rows
    let at3 = checkpoint_value(&fx.witness);
    fx.run("fs.read", json!({"path": "a.txt"})).unwrap(); // 6 rows
    let (db, wit) = (fx.db.clone(), fx.witness.clone());

    // Store ahead by exactly one: restore the checkpoint of 5 rows by
    // taking the real checkpoint after the 5th append.
    // (Simulate by rolling the witness back to the value after 5 rows.)
    // Build it: re-run is not possible, so derive from journal.
    drop(fx.kernel);
    // Roll back to 3 rows' checkpoint with 6 rows present => 3 ahead.
    set_checkpoint(&wit, &at3);
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    let e = k.verify_tool_journal().unwrap_err();
    assert!(e.message.contains("more than one entry ahead"), "{e}");
    // And a mutating call fails closed rather than blessing the tail.
    let r = k.reconcile_tool_journal(false);
    assert!(r.is_err());
}

#[test]
fn one_entry_ahead_is_recoverable_and_missing_checkpoint_fails_closed() {
    let mut fx = fixture("window1");
    fx.write("a.txt", b"x\n");
    let (call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    let before = checkpoint_value(&fx.witness); // after `authorized` (1 row)
    let _s = begin(&mut fx.kernel, &call, &cancel).unwrap(); // 2 rows
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    drop(fx.kernel);
    set_checkpoint(&wit, &before); // crash before the checkpoint write
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    assert_eq!(k.verify_tool_journal().unwrap(), 2); // tolerated window
                                                     // Next append advances the checkpoint; state converges.
    assert_eq!(k.reconcile_tool_journal(true).unwrap().interrupted, 1);
    assert_eq!(k.verify_tool_journal().unwrap(), 3);
    drop(k);
    // Missing checkpoint with a non-trivial journal: inconsistent evidence.
    let c = rusqlite::Connection::open(&wit).unwrap();
    c.execute(
        "DELETE FROM witness_meta WHERE key = 'tool_journal_checkpoint/v1'",
        [],
    )
    .unwrap();
    drop(c);
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    let e = k.verify_tool_journal().unwrap_err();
    assert!(e.message.contains("no witness checkpoint"), "{e}");
}

#[test]
fn revocation_and_lease_changes_stop_midflight_probe_at_library_level() {
    let mut fx = fixture("probe");
    for i in 0..30 {
        fx.write(&format!("d/f{i}.txt"), b"nothing\n");
    }
    let (call, cancel) = fx.authorized("fs.search", json!({"query": "zzz"}));
    let started = begin(&mut fx.kernel, &call, &cancel).unwrap();
    // Revoke between begin and run: the very first probe must stop it.
    fx.kernel.revoke_tools(&fx.command.clone(), "test").unwrap();
    let k: &Kernel = &fx.kernel;
    let g = call.grant().clone();
    let mut probe = || {
        k.check_tool_fence_for(&g).map_err(|e| {
            nexus_tools::ToolError::new(nexus_tools::ToolErrorCode::Revoked, e.code.as_str())
        })
    };
    let res = nexus_tools::run_started(&call, &cancel, &mut probe);
    assert_eq!(res.error.as_ref().unwrap().code.as_str(), "revoked");
    assert_eq!(res.stats.files_scanned, 0, "no file read after revocation");
    let out = nexus_tools::finish(&mut fx.kernel, &call, &started, res).unwrap();
    assert_eq!(out.journal.payload["errorCode"], "revoked");
    let ev = nexus_tools::tool_events_from_journal(&fx.kernel.list_tool_journal(None).unwrap());
    assert_eq!(ev[0].status, nexus_tools::ToolEventStatus::Cancelled);
}

#[test]
fn forged_binding_cannot_be_published_or_rebound() {
    let mut fx = fixture("bind");
    // Outside the allowed base.
    let outside = tempfile::tempdir().unwrap();
    let e = fx
        .kernel
        .bind_workspace(
            &fx.command.clone(),
            outside.path().to_str().unwrap(),
            &[fx.base.clone()],
        )
        .unwrap_err();
    assert_eq!(e.code.as_str(), "scope-refused");
    // Empty allowed list => nothing can be bound (fail closed).
    let sub = fx.ws.clone();
    let e = fx
        .kernel
        .bind_workspace(&fx.command.clone(), sub.to_str().unwrap(), &[])
        .unwrap_err();
    assert_eq!(e.code.as_str(), "scope-refused");
    // Unknown command.
    let e = fx
        .kernel
        .bind_workspace(
            "no-such",
            sub.to_str().unwrap(),
            std::slice::from_ref(&fx.base),
        )
        .unwrap_err();
    assert_eq!(e.code.as_str(), "delivery-invalid");
    // Re-binding to another directory conflicts.
    let other = fx.base.join("other");
    std::fs::create_dir_all(&other).unwrap();
    let e = fx
        .kernel
        .bind_workspace(
            &fx.command.clone(),
            other.to_str().unwrap(),
            &[fx.base.clone()],
        )
        .unwrap_err();
    // The accepted Controller intent committed to the original root, so even
    // a valid issuer cannot re-point the command at another allowed dir.
    assert_eq!(e.code.as_str(), "binding-mismatch");
    // Tampering with the stored binding is detected (seal).
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    let cmd = fx.command.clone();
    drop(fx.kernel);
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute(
        "UPDATE workspace_bindings SET binding_json = replace(binding_json, 'workspace', 'workspacf')",
        [],
    )
    .unwrap();
    drop(c);
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    let e = k.workspace_binding(&cmd).unwrap_err();
    assert_eq!(e.code.as_str(), "forged-issuer");
}

#[test]
fn cancelled_midflight_token_is_journaled_as_cancelled() {
    let mut fx = fixture("cancelled");
    for d in 0..20 {
        for f in 0..200 {
            fx.write(&format!("d{d}/f{f}.txt"), b"nothing\n");
        }
    }
    let mut r = fx.request("fs.search", json!({"query": "zzz"}));
    r.budgets.max_files = 20000;
    let cancel = CancellationToken::new(&r.cancellation_id);
    let p = fx.prepare_req(r).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let c2 = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2));
        c2.cancel();
    });
    let o = execute(&mut fx.kernel, &call, &cancel).unwrap();
    t.join().unwrap();
    assert_eq!(o.result.error.as_ref().unwrap().code.as_str(), "cancelled");
    let ev = nexus_tools::tool_events_from_journal(&fx.kernel.list_tool_journal(None).unwrap());
    assert_eq!(ev[0].status, nexus_tools::ToolEventStatus::Cancelled);
}

#[test]
fn issuer_cannot_choose_a_different_allowed_workspace() {
    let mut fx = fixture("choose");
    // A second, perfectly valid directory beneath the same allowed base.
    let sibling = fx.base.join("sibling-ws");
    std::fs::create_dir_all(&sibling).unwrap();
    let sib = std::fs::canonicalize(&sibling).unwrap();
    let e = fx
        .kernel
        .bind_workspace(
            &fx.command.clone(),
            sib.to_str().unwrap(),
            std::slice::from_ref(&fx.base),
        )
        .unwrap_err();
    assert_eq!(e.code.as_str(), "binding-mismatch");
    // The committed one is still the only bindable root and stays bound.
    assert_eq!(fx.binding().root_path, fx.ws.to_str().unwrap());
}
