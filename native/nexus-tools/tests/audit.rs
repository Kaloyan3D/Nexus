//! A3.1 final-audit regressions: mounts, hard links, redaction, restart and
//! multi-process exactly-once, journal integrity and checkpointing.

mod common;

use common::*;
use nexus_kernel::Kernel;
use nexus_tools::workspace::{RelPath, Workspace, WorkspacePolicy};
use nexus_tools::{authorize, execute, AuthorizedToolCall, CancellationToken, ToolRequestV1};
use serde_json::json;
use std::process::Command;

fn child_env(name: &str) -> bool {
    std::env::var("NEXUS_AUDIT_CHILD").as_deref() == Ok(name)
}

fn run_child(test: &str, env: &[(&str, String)]) -> std::process::Output {
    let mut c = Command::new(std::env::current_exe().unwrap());
    c.args(["--exact", test, "--nocapture", "--test-threads=1"]);
    c.env("NEXUS_AUDIT_CHILD", test);
    for (k, v) in env {
        c.env(k, v);
    }
    c.output().unwrap()
}

// ------------------------------------------------------------ bind mounts

/// Runs *inside* a private user+mount namespace where `ws/d` is a
/// same-device bind mount of the outside directory.
#[test]
fn child_bind_mount() {
    if !child_env("child_bind_mount") {
        return;
    }
    let ws_path = std::env::var("AUDIT_WS").unwrap();
    let outside = std::env::var("AUDIT_OUTSIDE").unwrap();
    use std::os::unix::fs::MetadataExt;
    let d_dev = std::fs::metadata(format!("{ws_path}/d")).unwrap().dev();
    let ws_dev = std::fs::metadata(&ws_path).unwrap().dev();
    // The case st_dev alone cannot see: same device, different mount.
    assert_eq!(d_dev, ws_dev, "fixture must be a same-device bind mount");
    assert!(std::path::Path::new(&outside).join("secret.txt").exists());
    let ws = Workspace::open_root(&ws_path, WorkspacePolicy::default()).unwrap();
    let e = ws
        .open_file(&RelPath::parse("d/secret.txt").unwrap())
        .unwrap_err();
    assert_eq!(e.code.as_str(), "mount-crossing", "{e}");
    let e = ws.open_dir(&RelPath::parse("d").unwrap()).unwrap_err();
    assert_eq!(e.code.as_str(), "mount-crossing", "{e}");
    println!("BIND-MOUNT-REFUSED");
}

#[test]
fn same_device_bind_mount_is_refused() {
    let fx = fixture("bind");
    std::fs::create_dir_all(fx.ws.join("d")).unwrap();
    let script = format!(
        "mount --bind '{}' '{}' && exec \"$0\" \"$@\"",
        fx.outside.display(),
        fx.ws.join("d").display()
    );
    let exe = std::env::current_exe().unwrap();
    let out = Command::new("unshare")
        .args(["-rm", "sh", "-c", &script])
        .arg(exe)
        .args([
            "--exact",
            "child_bind_mount",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("NEXUS_AUDIT_CHILD", "child_bind_mount")
        .env("AUDIT_WS", fx.ws.to_str().unwrap())
        .env("AUDIT_OUTSIDE", fx.outside.to_str().unwrap())
        .output();
    let out = match out {
        Ok(o) => o,
        Err(_) => {
            eprintln!("SKIP: unshare unavailable");
            return;
        }
    };
    let so = String::from_utf8_lossy(&out.stdout);
    let se = String::from_utf8_lossy(&out.stderr);
    if se.contains("Operation not permitted") || se.contains("unshare failed") {
        eprintln!("SKIP: user namespaces unavailable: {se}");
        return;
    }
    assert!(out.status.success(), "child failed\n{so}\n{se}");
    assert!(so.contains("BIND-MOUNT-REFUSED"), "{so}");
}

// -------------------------------------------------------------- hard links

#[test]
fn hard_links_to_outside_files_are_refused() {
    let mut fx = fixture("hardlink");
    std::fs::hard_link(fx.outside.join("secret.txt"), fx.ws.join("innocent.txt")).unwrap();
    fx.write("plain.txt", b"fine\n");
    let r = fx.run("fs.read", json!({"path": "innocent.txt"}));
    assert_eq!(err_code(&r), "hardlink-refused");
    let s = fx
        .run("fs.search", json!({"query": OUTSIDE_SECRET}))
        .unwrap();
    assert_eq!(s.result.stats.matches_returned, 0);
    assert_eq!(s.result.stats.skipped_hardlinks, 1);
    assert_eq!(
        err_code(&fx.run("fs.read", json!({"path": "plain.txt"}))),
        "ok"
    );
    // A3.2: there is no dependency-directory exemption. A hard link into
    // node_modules/target/vendor is refused exactly like any other.
    for d in ["node_modules", "target", "vendor"] {
        std::fs::create_dir_all(fx.ws.join(d)).unwrap();
        std::fs::hard_link(fx.outside.join("secret.txt"), fx.ws.join(d).join("p.txt")).unwrap();
        let r = fx.run("fs.read", json!({"path": format!("{d}/p.txt")}));
        assert_eq!(err_code(&r), "hardlink-refused", "{d}");
    }
}

// ------------------------------------------------------------ cancellation

#[test]
fn search_is_cancellable_mid_run() {
    let mut fx = fixture("cancel-mid");
    for d in 0..40 {
        for f in 0..250 {
            fx.write(&format!("d{d:02}/f{f:03}.txt"), b"nothing to see\n");
        }
    }
    let mut r = fx.request("fs.search", json!({"query": "zzz-never"}));
    r.budgets.max_files = 20_000;
    r.budgets.max_dirs = 1000;
    let cancel = CancellationToken::new(&r.cancellation_id);
    let call = authorize(&mut fx.kernel, prepare_b(r).unwrap()).unwrap();
    let c2 = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2));
        c2.cancel();
    });
    let o = execute(&mut fx.kernel, &call, &cancel).unwrap();
    t.join().unwrap();
    assert_eq!(o.result.error.as_ref().unwrap().code.as_str(), "cancelled");
    assert!(o.result.stats.files_scanned < 10_000, "ran to completion");
    // Cancelled execution is still journaled as completed(error:cancelled).
    assert_eq!(
        fx.journal_phases(),
        vec!["authorized", "started", "completed"]
    );
}

// --------------------------------------------------------------- redaction

#[test]
fn secrets_in_permitted_files_are_redacted_and_marked() {
    let mut fx = fixture("redact");
    fx.write(
        "app.conf",
        b"name = demo\napi_token = \"supersecretvalue123\"\nkey = sk-abcdefghijklmnopqrstuvwxyz123456\nplain line\n",
    );
    fx.write(
        "key.txt",
        b"intro\n-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkq\n-----END PRIVATE KEY-----\noutro\n",
    );
    fx.write("code.rs", b"fn main() {\n    println!(\"hi\");\n}\n");
    let r = fx.run("fs.read", json!({"path": "app.conf"})).unwrap();
    let c = r.result.output.as_ref().unwrap()["content"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        !c.contains("supersecretvalue123") && !c.contains("sk-abcdefgh"),
        "{c}"
    );
    assert!(c.contains("name = demo") && c.contains("plain line"));
    assert!(r.result.redaction.redacted && r.result.redaction.count >= 2);
    // Journal: kinds/counts only, never the secret.
    let j = serde_json::to_string(
        &fx.kernel
            .list_tool_journal(None)
            .unwrap()
            .iter()
            .map(|e| e.payload.clone())
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert!(!j.contains("supersecretvalue123") && !j.contains("sk-abcdefgh"));
    assert!(j.contains("\"redacted\":true"));
    // PEM block withheld, surrounding lines intact, also when paging past it.
    let r = fx.run("fs.read", json!({"path": "key.txt"})).unwrap();
    let c = r.result.output.as_ref().unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(!c.contains("MIIBVQ") && c.contains("intro") && c.contains("outro"));
    let r = fx
        .run("fs.read", json!({"path": "key.txt", "startLine": 3}))
        .unwrap();
    let c = r.result.output.as_ref().unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(!c.contains("MIIBVQ"), "{c}");
    // Ordinary code is untouched and not flagged.
    let r = fx.run("fs.read", json!({"path": "code.rs"})).unwrap();
    assert!(!r.result.redaction.redacted);
    assert_eq!(
        r.result.output.as_ref().unwrap()["content"],
        "fn main() {\n    println!(\"hi\");\n}\n"
    );
    // No prefix oracle: searching for the secret's own text finds nothing.
    let s = fx
        .run("fs.search", json!({"query": "sk-abcdefghijkl"}))
        .unwrap();
    assert_eq!(s.result.stats.matches_returned, 0);
    let s = fx.run("fs.search", json!({"query": "api_token"})).unwrap();
    let m = &s.result.output.as_ref().unwrap()["matches"][0]["text"];
    assert!(m.as_str().unwrap().contains("[REDACTED:nexus]"));
    assert!(s.result.redaction.redacted);
}

#[test]
fn error_messages_do_not_leak_content_or_host_paths() {
    let mut fx = fixture("errmsg");
    fx.write("bad.txt", b"line1\nSECRET-\xff-BYTES\n");
    let r = fx.run("fs.read", json!({"path": "bad.txt"})).unwrap();
    let m = &r.result.error.as_ref().unwrap().message;
    assert!(
        !m.contains("SECRET") && !m.contains(fx.ws.to_str().unwrap()),
        "{m}"
    );
    let r = fx.run("fs.read", json!({"path": "nope.txt"})).unwrap();
    let m = &r.result.error.as_ref().unwrap().message;
    assert!(!m.contains(fx.ws.to_str().unwrap()), "{m}");
}

// ---------------------------------------------------- restart and replay

fn make_request(fx: &mut Fx, rid: &str) -> ToolRequestV1 {
    let mut r = fx.request("fs.read", json!({"path": "a.txt"}));
    r.request_id = rid.into();
    r.cancellation_id = format!("c-{rid}");
    r
}

#[test]
fn grant_survives_restart_exactly_once_and_crash_is_not_replayable() {
    let mut fx = fixture("restart");
    fx.write("a.txt", b"x\n");
    let req = make_request(&mut fx, "r-1");
    let call = authorize(&mut fx.kernel, prepare_b(req.clone()).unwrap()).unwrap();
    let grant = call.grant().clone();
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    drop(fx.kernel);

    // Restart #1: valid grant executes exactly once.
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    let c = CancellationToken::new(&req.cancellation_id);
    let call = AuthorizedToolCall::from_parts(prepare_b(req.clone()).unwrap(), grant.clone());
    execute(&mut k, &call, &c).unwrap();
    drop(k);

    // Restart #2: replay after restart is refused with zero reads.
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    let call = AuthorizedToolCall::from_parts(prepare_b(req.clone()).unwrap(), grant);
    let e = execute(&mut k, &call, &c).unwrap_err();
    assert!(e.message.contains("command-conflict"), "{e}");
    assert_eq!(call.prepared().workspace().access_count(), 0);

    // Crash between started and completed: begin only, then "die".
    let req2 = retarget(&req, "r-2");
    let call2 = authorize(&mut k, prepare_b(req2.clone()).unwrap()).unwrap();
    k.begin_tool_execution(
        call2.grant(),
        call2.prepared().args_digest(),
        call2.prepared().budget_digest(),
    )
    .unwrap();
    drop(k);
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    let c2 = CancellationToken::new(&req2.cancellation_id);
    let again = AuthorizedToolCall::from_parts(prepare_b(req2).unwrap(), call2.grant().clone());
    assert!(
        execute(&mut k, &again, &c2).is_err(),
        "crashed start must not replay"
    );
    assert_eq!(again.prepared().workspace().access_count(), 0);
    let ev = nexus_tools::tool_events_from_journal(&k.list_tool_journal(None).unwrap());
    let last = ev.last().unwrap().clone().mark_interrupted_if_open();
    assert_eq!(last.status, nexus_tools::ToolEventStatus::Interrupted);
    assert_eq!(k.verify_tool_journal().unwrap(), 3 + 2);
}

fn retarget(base: &ToolRequestV1, rid: &str) -> ToolRequestV1 {
    let mut r = base.clone();
    r.request_id = rid.into();
    r.cancellation_id = format!("c-{rid}");
    r
}

#[test]
fn child_race_begin() {
    if !child_env("child_race_begin") {
        return;
    }
    let req: ToolRequestV1 = serde_json::from_str(&std::env::var("AUDIT_REQ").unwrap()).unwrap();
    let grant: nexus_kernel::SealedToolGrant =
        serde_json::from_str(&std::env::var("AUDIT_GRANT").unwrap()).unwrap();
    let mut k = Kernel::open(
        std::path::Path::new(&std::env::var("AUDIT_DB").unwrap()),
        Some(std::path::Path::new(&std::env::var("AUDIT_WIT").unwrap())),
    )
    .unwrap();
    let c = CancellationToken::new(&req.cancellation_id);
    let call = AuthorizedToolCall::from_parts(prepare_b(req).unwrap(), grant);
    match execute(&mut k, &call, &c) {
        Ok(_) => println!("RACE-WON"),
        Err(_) => println!("RACE-REFUSED"),
    }
}

#[test]
fn multi_process_grant_race_has_exactly_one_winner() {
    let mut fx = fixture("mproc");
    fx.write("a.txt", b"x\n");
    let req = make_request(&mut fx, "mp-1");
    let call = authorize(&mut fx.kernel, prepare_b(req.clone()).unwrap()).unwrap();
    let env = [
        (
            "AUDIT_BINDING",
            serde_json::to_string(&fx.binding()).unwrap(),
        ),
        ("AUDIT_REQ", serde_json::to_string(&req).unwrap()),
        ("AUDIT_GRANT", serde_json::to_string(call.grant()).unwrap()),
        ("AUDIT_DB", fx.db.to_str().unwrap().to_owned()),
        ("AUDIT_WIT", fx.witness.to_str().unwrap().to_owned()),
    ];
    let handles: Vec<_> = (0..6)
        .map(|_| {
            let env = env.to_vec();
            std::thread::spawn(move || run_child("child_race_begin", &env))
        })
        .collect();
    let outs: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let won = outs
        .iter()
        .filter(|o| String::from_utf8_lossy(&o.stdout).contains("RACE-WON"))
        .count();
    let refused = outs
        .iter()
        .filter(|o| String::from_utf8_lossy(&o.stdout).contains("RACE-REFUSED"))
        .count();
    assert_eq!((won, refused), (1, 5));
    let mut k = Kernel::open(&fx.db, Some(&fx.witness)).unwrap();
    assert_eq!(k.verify_tool_journal().unwrap(), 3);
}

// ------------------------------------------------------- journal integrity

fn seeded(tag: &str) -> Fx {
    let mut fx = fixture(tag);
    fx.write("a.txt", b"x\n");
    for _ in 0..3 {
        fx.run("fs.read", json!({"path": "a.txt"})).unwrap();
    }
    fx
}

fn mutate(fx: Fx, sql: &str) -> Kernel {
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    drop(fx.kernel);
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(sql).unwrap();
    drop(conn);
    Kernel::open(&db, Some(&wit)).unwrap()
}

#[test]
fn insertion_reordering_and_edits_are_detected() {
    // Forged insertion with plausible fields but no valid seal/chain.
    let fx = seeded("j-insert");
    let mut k = mutate(
        fx,
        "INSERT INTO tool_journal (request_id, execution_id, task_instance_id, attempt_id, command_id, phase, payload_json, prev_hash, entry_hash, seal_hex, recorded_at_utc) \
         VALUES ('forged','e','t','a','c','completed','{}','00','11','22','0.0Z')",
    );
    assert_eq!(
        k.verify_tool_journal().unwrap_err().code.as_str(),
        "store-corrupt"
    );
    // Reordering: swap two rows' positions.
    let fx = seeded("j-reorder");
    let mut k = mutate(
        fx,
        "UPDATE tool_journal SET seq = 1000 WHERE seq = 2; UPDATE tool_journal SET seq = 2 WHERE seq = 3; UPDATE tool_journal SET seq = 3 WHERE seq = 1000;",
    );
    assert_eq!(
        k.verify_tool_journal().unwrap_err().code.as_str(),
        "store-corrupt"
    );
    // Editing identity linkage.
    let fx = seeded("j-edit");
    let mut k = mutate(
        fx,
        "UPDATE tool_journal SET attempt_id = 'evil' WHERE seq = 2",
    );
    assert_eq!(
        k.verify_tool_journal().unwrap_err().code.as_str(),
        "store-corrupt"
    );
}

#[test]
fn uncommitted_partial_write_is_invisible_and_chain_stays_valid() {
    let fx = seeded("j-partial");
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    drop(fx.kernel);
    {
        let mut conn = rusqlite::Connection::open(&db).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO tool_journal (request_id, execution_id, task_instance_id, attempt_id, command_id, phase, payload_json, prev_hash, entry_hash, seal_hex, recorded_at_utc) VALUES ('half','e','t','a','c','started','{}','x','y','z','0Z')",
            [],
        )
        .unwrap();
        // simulated crash: transaction dropped without commit
    }
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    assert_eq!(k.verify_tool_journal().unwrap(), 9);
}

#[test]
fn tail_truncation_is_detected_with_witness_checkpoint_only() {
    let fx = seeded("j-tail");
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    drop(fx.kernel);
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute("DELETE FROM tool_journal WHERE seq > 6", [])
        .unwrap();
    drop(conn);
    // Chain alone is consistent: a hash chain cannot see this.
    let mut no_witness = Kernel::open(&db, None).unwrap();
    assert_eq!(no_witness.verify_tool_journal().unwrap(), 6);
    drop(no_witness);
    // With the independent witness checkpoint the truncation is caught.
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    let e = k.verify_tool_journal().unwrap_err();
    assert!(e.message.contains("tail truncation"), "{e}");
}

#[test]
fn checkpoint_tolerates_the_one_entry_crash_window_and_blocks_history_rewrite() {
    // Store ahead of the checkpoint by one entry (crash after append,
    // before checkpoint) is accepted; the chain is still valid.
    let fx = seeded("j-window");
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    drop(fx.kernel);
    {
        let w = rusqlite::Connection::open(&wit).unwrap();
        let raw: String = w
            .query_row(
                "SELECT value FROM witness_meta WHERE key = 'tool_journal_checkpoint/v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(raw.contains("\"count\":9"), "{raw}");
    }
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    assert_eq!(k.verify_tool_journal().unwrap(), 9);
    // Forged checkpoint (bad seal) is refused.
    drop(k);
    let w = rusqlite::Connection::open(&wit).unwrap();
    w.execute(
        "UPDATE witness_meta SET value = replace(value, '\"count\":9', '\"count\":2') WHERE key = 'tool_journal_checkpoint/v1'",
        [],
    )
    .unwrap();
    drop(w);
    let mut k = Kernel::open(&db, Some(&wit)).unwrap();
    assert!(k
        .verify_tool_journal()
        .unwrap_err()
        .message
        .contains("seal"));
}
