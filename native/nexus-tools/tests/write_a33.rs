//! A3.3 write/edit tools: real filesystem, real Kernel, real journal.

mod common;

use common::*;
use nexus_tools::{
    authorize, execute, execute_write, CancellationToken, ToolErrorCode, WriteHooks,
};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

fn sha(s: &str) -> String {
    nexus_tools::write::sha256_bytes_hex(s.as_bytes())
}

fn wcode(r: &Result<nexus_tools::ToolExecutionOutcome, nexus_tools::ToolError>) -> String {
    match r {
        Ok(o) => o
            .result
            .error
            .as_ref()
            .map(|e| e.code.as_str().to_owned())
            .unwrap_or_else(|| "ok".to_owned()),
        Err(e) => e.code.as_str().to_owned(),
    }
}

fn phases(fx: &Fx) -> Vec<String> {
    fx.journal_phases()
}

// ------------------------------------------------------------ happy paths

#[test]
fn create_replace_and_edit_publish_atomically_and_verify() {
    let mut fx = fixture("w-happy");
    fx.approve_write(64 * 1024);
    let r = fx
        .run_write(
            "fs.write",
            json!({"path": "src/new.txt", "content": "hello\n", "mode": "create"}),
        )
        .map_err(|e| e.to_string());
    // parent must exist (no implicit mkdir)
    assert!(r.is_ok());
    assert_eq!(wcode(&Ok(r.unwrap())), "not-found");
    std::fs::create_dir_all(fx.ws.join("src")).unwrap();
    let r = fx
        .run_write(
            "fs.write",
            json!({"path": "src/new.txt", "content": "hello\n", "mode": "create"}),
        )
        .unwrap();
    assert!(r.result.error.is_none(), "{:?}", r.result.error);
    assert_eq!(fx.disk("src/new.txt").unwrap(), "hello\n");
    assert_eq!(
        std::fs::metadata(fx.ws.join("src/new.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
    let out = r.result.output.as_ref().unwrap();
    assert_eq!(out["state"], "verified");
    assert_eq!(out["postSha256"], sha("hello\n"));
    assert!(fx.tmp_leftovers().is_empty());
    assert!(phases(&fx).ends_with(&[
        "authorized".into(),
        "started".into(),
        "planned".into(),
        "prepared".into(),
        "applied".into(),
        "verified".into()
    ]));

    // Replace preserves the existing mode.
    std::fs::set_permissions(
        fx.ws.join("src/new.txt"),
        std::fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    let r = fx
        .run_write(
            "fs.write",
            json!({"path": "src/new.txt", "content": "v2\n", "mode": "replace",
                   "expectedSha256": sha("hello\n")}),
        )
        .unwrap();
    assert!(r.result.error.is_none());
    assert_eq!(fx.disk("src/new.txt").unwrap(), "v2\n");
    assert_eq!(
        std::fs::metadata(fx.ws.join("src/new.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );

    // Ordered edits, each oldText must match exactly once.
    fx.write("src/code.rs", b"fn a() {}\nfn b() {}\n");
    let r = fx
        .run_write(
            "fs.edit",
            json!({"path": "src/code.rs", "expectedSha256": sha("fn a() {}\nfn b() {}\n"),
                   "edits": [{"oldText": "fn a()", "newText": "fn alpha()"},
                             {"oldText": "fn alpha() {}", "newText": "fn alpha() { 1 }"}]}),
        )
        .unwrap();
    assert!(r.result.error.is_none(), "{:?}", r.result.error);
    assert_eq!(
        fx.disk("src/code.rs").unwrap(),
        "fn alpha() { 1 }\nfn b() {}\n"
    );
    assert!(fx.tmp_leftovers().is_empty());
    assert_eq!(
        fx.kernel.verify_tool_journal().unwrap() as usize,
        phases(&fx).len()
    );
}

// -------------------------------------------------------- conflict paths

#[test]
fn conflicts_never_overwrite_and_leave_no_artifacts() {
    let mut fx = fixture("w-conflict");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"original\n");
    // create over an existing file
    let r = fx.run_write(
        "fs.write",
        json!({"path": "a.txt", "content": "X", "mode": "create"}),
    );
    assert_eq!(wcode(&r), "conflict");
    // replace with a stale pre-image
    let r = fx.run_write(
        "fs.write",
        json!({"path": "a.txt", "content": "X", "mode": "replace", "expectedSha256": sha("other")}),
    );
    assert_eq!(wcode(&r), "conflict");
    // replace of an absent file
    let r = fx.run_write(
        "fs.write",
        json!({"path": "missing.txt", "content": "X", "mode": "replace", "expectedSha256": sha("x")}),
    );
    assert_eq!(wcode(&r), "conflict");
    // edit: stale hash, not found, ambiguous, no-op
    let h = sha("original\n");
    for (edits, why) in [
        (
            json!([{"oldText": "nope", "newText": "x"}]),
            "edit-0-not-found",
        ),
        (
            json!([{"oldText": "i", "newText": "x"}]),
            "edit-0-ambiguous",
        ),
        (
            json!([{"oldText": "original", "newText": "original"}]),
            "no-change",
        ),
    ] {
        let r = fx
            .run_write(
                "fs.edit",
                json!({"path": "a.txt", "expectedSha256": h, "edits": edits}),
            )
            .unwrap();
        assert_eq!(
            r.result.error.as_ref().unwrap().code.as_str(),
            "conflict",
            "{why}"
        );
        assert_eq!(r.journal.payload["conflict"], why);
    }
    let r = fx.run_write(
        "fs.edit",
        json!({"path": "a.txt", "expectedSha256": sha("stale"),
               "edits": [{"oldText": "original", "newText": "y"}]}),
    );
    assert_eq!(wcode(&r), "conflict");
    assert_eq!(fx.disk("a.txt").unwrap(), "original\n");
    assert!(fx.tmp_leftovers().is_empty());
    // every refusal is journaled as `conflict` with mutation=none
    let all = fx.kernel.list_tool_journal(None).unwrap();
    for e in all.iter().filter(|e| e.phase == "conflict") {
        assert_eq!(e.payload["mutation"], "none");
    }
}

// ------------------------------------------ path/policy refusals, no effect

#[test]
fn forbidden_targets_are_refused_with_zero_mutation() {
    let mut fx = fixture("w-paths");
    fx.approve_write(64 * 1024);
    fx.write("keep.txt", b"keep\n");
    fx.write(".git/config", b"[core]\n");
    fx.write(".env", b"TOKEN=1\n");
    fx.write("id_rsa", b"KEY\n");
    fx.write("node_modules/x/index.js", b"//\n");
    std::fs::create_dir_all(fx.ws.join("d")).unwrap();
    // symlink and hardlink pointing OUTSIDE the workspace
    let outside = fx.outside.join("secret.txt");
    symlink(&outside, &fx.ws.join("link.txt"));
    symlink(&fx.outside, &fx.ws.join("linkdir"));
    std::fs::hard_link(&outside, fx.ws.join("hl.txt")).unwrap();
    // FIFO
    let fifo = std::ffi::CString::new(fx.ws.join("pipe").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let before = std::fs::read_to_string(&outside).unwrap();

    let cases: Vec<(serde_json::Value, &str)> = vec![
        (
            json!({"path": ".git/config", "content": "x", "mode": "replace", "expectedSha256": sha("[core]\n")}),
            "hidden-path-refused",
        ),
        (
            json!({"path": ".env", "content": "x", "mode": "replace", "expectedSha256": sha("TOKEN=1\n")}),
            "hidden-path-refused",
        ),
        (
            json!({"path": "id_rsa", "content": "x", "mode": "replace", "expectedSha256": sha("KEY\n")}),
            "sensitive-path-refused",
        ),
        (
            json!({"path": "node_modules/x/index.js", "content": "x", "mode": "replace", "expectedSha256": sha("//\n")}),
            "hidden-path-refused",
        ),
        (
            json!({"path": "../outside/secret.txt", "content": "x", "mode": "replace", "expectedSha256": sha("x")}),
            "path-invalid",
        ),
        (
            json!({"path": "/etc/passwd", "content": "x", "mode": "replace", "expectedSha256": sha("x")}),
            "path-invalid",
        ),
        (
            json!({"path": "link.txt", "content": "PWNED", "mode": "replace", "expectedSha256": sha(&before)}),
            "symlink-refused",
        ),
        (
            json!({"path": "linkdir/secret.txt", "content": "PWNED", "mode": "replace", "expectedSha256": sha(&before)}),
            "symlink-refused",
        ),
        (
            json!({"path": "linkdir/new.txt", "content": "PWNED", "mode": "create"}),
            "symlink-refused",
        ),
        (
            json!({"path": "hl.txt", "content": "PWNED", "mode": "replace", "expectedSha256": sha(&before)}),
            "hardlink-refused",
        ),
        (
            json!({"path": "pipe", "content": "x", "mode": "replace", "expectedSha256": sha("x")}),
            "special-file-refused",
        ),
        (
            json!({"path": "no/such/dir/f.txt", "content": "x", "mode": "create"}),
            "not-found",
        ),
        (
            json!({"path": ".nexus-tmp-abc", "content": "x", "mode": "create"}),
            "hidden-path-refused",
        ),
        (
            json!({"path": ".", "content": "x", "mode": "create"}),
            "not-a-file",
        ),
    ];
    for (args, want) in cases {
        let r = fx.run_write("fs.write", args.clone());
        assert_eq!(wcode(&r), want, "{args}");
    }
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), before);
    assert_eq!(fx.disk("keep.txt").unwrap(), "keep\n");
    assert_eq!(fx.disk(".git/config").unwrap(), "[core]\n");
    assert_eq!(fx.disk(".env").unwrap(), "TOKEN=1\n");
    assert_eq!(std::fs::read_dir(&fx.outside).unwrap().count(), 1);
    assert!(fx.tmp_leftovers().is_empty());
    // No temp file escaped into any directory.
    assert!(!fx.ws.join("d").read_dir().unwrap().any(|e| e.is_ok()));
}

extern "C" {
    fn mkfifo(path: *const std::os::raw::c_char, mode: u32) -> i32;
}

// ----------------------------------------------- authority and escalation

#[test]
fn write_requires_independent_scope_and_read_grants_cannot_mutate() {
    let mut fx = fixture("w-authority");
    fx.write("a.txt", b"orig\n");
    // 1. No scope at all: preparation refuses; the model JSON alone is nothing.
    let r = fx.request("fs.write", json!({"path": "a.txt", "content": "x", "mode": "replace", "expectedSha256": sha("orig\n")}));
    let e = prepare_b(r.clone()).unwrap_err();
    assert_eq!(e.code.as_str(), "authorization-refused");
    // 2. A forged scope (never sealed by the Kernel) is refused by the Kernel.
    let b = fx.binding();
    let forged = nexus_kernel::WriteScopeBinding {
        command_id: fx.command.clone(),
        task_instance_id: fx.task.clone(),
        attempt_id: fx.attempt.clone(),
        lease_epoch: fx.epoch,
        store_incarnation: fx.incarnation.clone(),
        root_digest: b.root_digest.clone(),
        max_write_bytes: 1 << 20,
        approver_id: "attacker".into(),
        independent: true,
    };
    let p = nexus_tools::prepare_write(r.clone(), &b, &forged).unwrap();
    let e = authorize(&mut fx.kernel, p).unwrap_err();
    assert!(
        e.message.contains("scope-refused") || e.message.contains("no independent write scope"),
        "{e}"
    );
    assert_eq!(fx.disk("a.txt").unwrap(), "orig\n");

    // 3. Approver names a different workspace digest -> refused.
    let e = fx
        .kernel
        .bind_write_scope(&fx.command.clone(), "ap", true, &"0".repeat(64), 1000)
        .unwrap_err();
    assert_eq!(e.code.as_str(), "binding-mismatch");

    // 4. A *read* grant cannot be turned into a write: tool id / scope
    //    are sealed and re-derived.
    fx.approve_write(64 * 1024);
    let (read_call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    let mut g = read_call.grant().clone();
    g.tool_id = "fs.write".into(); // tamper
    g.scope = "write".into();
    let wr = fx.request("fs.write", json!({"path": "a.txt", "content": "PWN", "mode": "replace", "expectedSha256": sha("orig\n")}));
    let wp = fx.prepare_w(wr).unwrap();
    let forged_call = nexus_tools::AuthorizedToolCall::from_parts(wp, g);
    let res = execute_write(&mut fx.kernel, &forged_call, &cancel);
    assert!(res.is_err());
    // Genuine read grant presented with a write-prepared call: mismatch.
    let wr2 = fx.request("fs.write", json!({"path": "a.txt", "content": "PWN", "mode": "replace", "expectedSha256": sha("orig\n")}));
    let wp2 = fx.prepare_w(wr2).unwrap();
    let mixed = nexus_tools::AuthorizedToolCall::from_parts(wp2, read_call.grant().clone());
    assert!(execute_write(&mut fx.kernel, &mixed, &cancel).is_err());
    assert_eq!(fx.disk("a.txt").unwrap(), "orig\n");
    // 5. The read executor refuses to run a write grant as a read.
    let wr3 = fx.request("fs.write", json!({"path": "a.txt", "content": "PWN", "mode": "replace", "expectedSha256": sha("orig\n")}));
    let c3 = CancellationToken::new(&wr3.cancellation_id);
    let wp3 = fx.prepare_w(wr3).unwrap();
    let call3 = authorize(&mut fx.kernel, wp3).unwrap();
    let r = execute(&mut fx.kernel, &call3, &c3).unwrap();
    assert_eq!(
        r.result.error.as_ref().unwrap().code,
        ToolErrorCode::UnsupportedTool
    );
    assert_eq!(fx.disk("a.txt").unwrap(), "orig\n");
}

#[test]
fn stale_generation_wrong_attempt_and_revocation_block_mutation() {
    let mut fx = fixture("w-lease");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let args = json!({"path": "a.txt", "content": "NEW", "mode": "replace", "expectedSha256": sha("orig\n")});
    // authorize, then supersede the lease
    let r = fx.request("fs.write", args.clone());
    let c = CancellationToken::new(&r.cancellation_id);
    let p = fx.prepare_w(r).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    fx.kernel
        .acquire_generation(&fx.task.clone(), "native")
        .unwrap();
    let e = execute_write(&mut fx.kernel, &call, &c).unwrap_err();
    assert!(e.message.contains("stale-lease"), "{e}");
    assert_eq!(fx.disk("a.txt").unwrap(), "orig\n");
    // wrong attempt through a forged scope/binding
    let b = fx.binding();
    let mut sc = fx.scope();
    sc.attempt_id = "attempt-evil".into();
    let r = fx.request("fs.write", args.clone());
    let p = nexus_tools::prepare_write(r, &b, &sc).unwrap();
    assert!(authorize(&mut fx.kernel, p).is_err());
    assert_eq!(fx.disk("a.txt").unwrap(), "orig\n");
    assert!(!phases(&fx).iter().any(|p| p == "planned"));
}

#[test]
fn revocation_before_publication_aborts_with_no_mutation() {
    let mut fx = fixture("w-revoke");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    fx.kernel.revoke_tools(&fx.command.clone(), "test").unwrap();
    let r = fx.run_write(
        "fs.write",
        json!({"path": "a.txt", "content": "NEW", "mode": "replace", "expectedSha256": sha("orig\n")}),
    );
    assert!(r.is_err());
    assert_eq!(fx.disk("a.txt").unwrap(), "orig\n");
    assert!(fx.tmp_leftovers().is_empty());
}

// --------------------------------------- races, fencing, cancellation

struct Script<'a> {
    seen: Vec<String>,
    on_phase: Box<dyn FnMut(&str) + 'a>,
    fence_after: Option<usize>,
    fences: usize,
    fail_journal_at: Option<&'a str>,
}

impl WriteHooks for Script<'_> {
    fn journal(
        &mut self,
        phase: &str,
        _p: serde_json::Value,
    ) -> Result<(), nexus_tools::ToolError> {
        if self.fail_journal_at == Some(phase) {
            return Err(nexus_tools::ToolError::new(
                ToolErrorCode::IoError,
                "journal down",
            ));
        }
        self.seen.push(phase.to_owned());
        (self.on_phase)(phase);
        Ok(())
    }
    fn at(&mut self, point: &str) {
        (self.on_phase)(&format!("@{point}"));
    }
    fn fence(&mut self) -> Result<(), nexus_tools::ToolError> {
        self.fences += 1;
        match self.fence_after {
            Some(n) if self.fences > n => Err(nexus_tools::ToolError::new(
                ToolErrorCode::Revoked,
                "revoked",
            )),
            _ => Ok(()),
        }
    }
}

fn direct(
    fx: &mut Fx,
    args: serde_json::Value,
    tool: &str,
    cancel: &CancellationToken,
    hooks: &mut dyn WriteHooks,
) -> nexus_tools::ToolResultV1 {
    let r = fx.request(tool, args);
    let p = fx.prepare_w(r).unwrap();
    nexus_tools::run_write_call(
        &nexus_tools::AuthorizedToolCall::from_parts(p, dummy_grant()),
        cancel,
        hooks,
    )
    .unwrap()
}

fn dummy_grant() -> nexus_kernel::SealedToolGrant {
    nexus_kernel::SealedToolGrant {
        execution_id: "e".repeat(32),
        request_id: "r".into(),
        command_id: "c".into(),
        task_instance_id: "t".into(),
        attempt_id: "a".into(),
        lease_epoch: 1,
        store_incarnation: "i".into(),
        tool_id: "fs.write".into(),
        scope: "write".into(),
        tool_version: 1,
        args_digest: String::new(),
        workspace_root_digest: String::new(),
        workspace_root_dev: 0,
        workspace_root_ino: 0,
        budget_digest: String::new(),
        cancellation_id: "c".into(),
        issued_at_ms: 0,
        expires_at_ms: 0,
        nonce_hex: String::new(),
        tag_hex: String::new(),
    }
}

#[test]
fn concurrent_external_modification_is_detected_and_preserved() {
    let mut fx = fixture("w-race");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let target = fx.ws.join("a.txt");
    let cancel = CancellationToken::new("x");
    // An external writer replaces the file (rename) between our pre-image
    // read and publication.
    let mut hooks = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(move |p| {
            if p == "prepared" {
                let t = target.with_file_name("ext.tmp");
                std::fs::write(&t, "EXTERNAL EDIT\n").unwrap();
                std::fs::rename(&t, &target).unwrap();
            }
        }),
    };
    let res = direct(
        &mut fx,
        json!({"path": "a.txt", "content": "OURS\n", "mode": "replace", "expectedSha256": sha("orig\n")}),
        "fs.write",
        &cancel,
        &mut hooks,
    );
    assert_eq!(res.error.as_ref().unwrap().code, ToolErrorCode::Conflict);
    // The external edit is intact: never silently overwritten.
    assert_eq!(fx.disk("a.txt").unwrap(), "EXTERNAL EDIT\n");
    assert!(fx.tmp_leftovers().is_empty());
    assert_eq!(hooks.seen.last().unwrap(), "conflict");
    assert!(!hooks.seen.contains(&"applied".to_owned()));
}

#[test]
fn concurrent_create_race_conflicts() {
    let mut fx = fixture("w-createrace");
    fx.approve_write(64 * 1024);
    let target = fx.ws.join("n.txt");
    let cancel = CancellationToken::new("x");
    let mut hooks = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(move |p| {
            if p == "prepared" {
                std::fs::write(&target, "EXTERNAL\n").unwrap();
            }
        }),
    };
    let res = direct(
        &mut fx,
        json!({"path": "n.txt", "content": "OURS", "mode": "create"}),
        "fs.write",
        &cancel,
        &mut hooks,
    );
    assert_eq!(res.error.as_ref().unwrap().code, ToolErrorCode::Conflict);
    assert_eq!(fx.disk("n.txt").unwrap(), "EXTERNAL\n");
    assert!(fx.tmp_leftovers().is_empty());
}

#[test]
fn fence_and_cancellation_before_publication_abort_cleanly() {
    let mut fx = fixture("w-fence");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let args = json!({"path": "a.txt", "content": "NEW", "mode": "replace", "expectedSha256": sha("orig\n")});
    // fence #1 (before planned) ok, fence #2 (before publication) revoked
    let cancel = CancellationToken::new("x");
    let mut h = Script {
        seen: vec![],
        fence_after: Some(1),
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(|_| {}),
    };
    let res = direct(&mut fx, args.clone(), "fs.write", &cancel, &mut h);
    assert_eq!(res.error.as_ref().unwrap().code, ToolErrorCode::Revoked);
    assert_eq!(h.seen, vec!["planned", "prepared", "failed"]);
    assert_eq!(fx.disk("a.txt").unwrap(), "orig\n");
    assert!(fx.tmp_leftovers().is_empty());
    // cancellation token fired after `prepared`
    let c2 = CancellationToken::new("y");
    let c2b = c2.clone();
    let mut h = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(move |p| {
            if p == "prepared" {
                c2b.cancel();
            }
        }),
    };
    let res = direct(&mut fx, args.clone(), "fs.write", &c2, &mut h);
    assert_eq!(res.error.as_ref().unwrap().code, ToolErrorCode::Cancelled);
    assert_eq!(fx.disk("a.txt").unwrap(), "orig\n");
    assert!(fx.tmp_leftovers().is_empty());
}

#[test]
fn cancellation_during_publication_still_reports_the_applied_write() {
    let mut fx = fixture("w-cancel-late");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let c = CancellationToken::new("x");
    let c2 = c.clone();
    // Revocation + cancellation arrive right after `applied` is journaled.
    let mut h = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(move |p| {
            if p == "applied" {
                c2.cancel();
            }
        }),
    };
    let res = direct(
        &mut fx,
        json!({"path": "a.txt", "content": "NEW\n", "mode": "replace", "expectedSha256": sha("orig\n")}),
        "fs.write",
        &c,
        &mut h,
    );
    // Bytes were published: the result must say so, never "no changes".
    assert!(res.error.is_none(), "{:?}", res.error);
    assert_eq!(res.output.as_ref().unwrap()["state"], "verified");
    assert_eq!(fx.disk("a.txt").unwrap(), "NEW\n");
    assert_eq!(h.seen, vec!["planned", "prepared", "applied", "verified"]);
}

#[test]
fn journal_failure_after_publication_is_reported_not_swallowed() {
    let mut fx = fixture("w-jfail");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let c = CancellationToken::new("x");
    let mut h = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: Some("applied"),
        on_phase: Box::new(|_| {}),
    };
    let r = fx.request("fs.write", json!({"path": "a.txt", "content": "NEW\n", "mode": "replace", "expectedSha256": sha("orig\n")}));
    let p = fx.prepare_w(r).unwrap();
    let out = nexus_tools::run_write_call(
        &nexus_tools::AuthorizedToolCall::from_parts(p, dummy_grant()),
        &c,
        &mut h,
    );
    assert!(out.is_err(), "must surface the uncertain outcome");
    // The file *was* replaced; recovery observation must say so.
    assert_eq!(fx.disk("a.txt").unwrap(), "NEW\n");
}

#[test]
fn multiple_writers_to_one_file_have_exactly_one_winner() {
    let mut fx = fixture("w-multi");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"base\n");
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    let (task, attempt, command, epoch, inc) = (
        fx.task.clone(),
        fx.attempt.clone(),
        fx.command.clone(),
        fx.epoch,
        fx.incarnation.clone(),
    );
    let b = fx.binding();
    let sc = fx.scope();
    let h0 = sha("base\n");
    let wsdir = fx.ws.clone();
    drop(fx.kernel);
    let mut hs = Vec::new();
    for i in 0..8 {
        let (db, wit, task, attempt, command, inc, b, sc, h0) = (
            db.clone(),
            wit.clone(),
            task.clone(),
            attempt.clone(),
            command.clone(),
            inc.clone(),
            b.clone(),
            sc.clone(),
            h0.clone(),
        );
        hs.push(std::thread::spawn(move || {
            let mut k = nexus_kernel::Kernel::open(&db, Some(&wit)).unwrap();
            let req = nexus_tools::ToolRequestV1 {
                schema_version: 1,
                request_id: format!("mw-{i}"),
                cancellation_id: format!("mwc-{i}"),
                task_instance_id: task,
                attempt_id: attempt,
                command_id: command,
                lease_epoch: epoch,
                store_incarnation: inc,
                tool_id: "fs.write".into(),
                tool_version: 1,
                args: json!({"path": "a.txt", "content": format!("writer {i}\n"), "mode": "replace", "expectedSha256": h0}),
                budgets: nexus_tools::ToolBudgets::default(),
            };
            let c = CancellationToken::new(&req.cancellation_id);
            let p = nexus_tools::prepare_write(req, &b, &sc).unwrap();
            let call = authorize(&mut k, p).unwrap();
            execute_write(&mut k, &call, &c).map(|o| o.result.error.is_none()).unwrap_or(false)
        }));
    }
    let wins = hs
        .into_iter()
        .map(|h| h.join().unwrap())
        .filter(|w| *w)
        .count();
    assert_eq!(
        wins, 1,
        "exactly one writer may replace the expected pre-image"
    );
    let final_text = std::fs::read_to_string(wsdir.join("a.txt")).unwrap();
    assert!(final_text.starts_with("writer "), "{final_text}");
    let leftovers = std::fs::read_dir(&wsdir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(".nexus-tmp-"))
        .count();
    assert_eq!(leftovers, 0);
}

// ------------------------------------------------------- limits & recovery

#[test]
fn oversized_content_and_scope_budget_are_enforced() {
    let mut fx = fixture("w-big");
    fx.approve_write(1000); // approver allowed only 1000 bytes
    let r = fx.run_write(
        "fs.write",
        json!({"path": "big.txt", "content": "x".repeat(5000), "mode": "create"}),
    );
    assert_eq!(wcode(&r), "file-too-large");
    assert!(fx.disk("big.txt").is_none());
    // Request cannot raise the budget above the approved scope.
    let mut req = fx.request(
        "fs.write",
        json!({"path": "big.txt", "content": "x".repeat(5000), "mode": "create"}),
    );
    req.budgets.max_write_bytes = 4 * 1024 * 1024;
    let p = fx.prepare_w(req).unwrap();
    assert_eq!(p.budgets().max_write_bytes, 1000);
    // Malformed arguments never reach the filesystem.
    for bad in [
        json!({"path": "m.txt", "content": "x", "mode": "upsert"}),
        json!({"path": "m.txt", "content": "x", "mode": "replace"}),
        json!({"path": "m.txt", "content": "x", "mode": "create", "expectedSha256": "00"}),
        json!({"path": "m.txt", "content": "a\u{0}b", "mode": "create"}),
        json!({"path": "m.txt", "content": "x", "mode": "create", "extra": 1}),
        json!({"path": "m.txt", "content": "x", "mode": "create", "fileMode": "4755"}),
    ] {
        let r = fx.request("fs.write", bad.clone());
        assert!(fx.prepare_w(r).is_err(), "{bad}");
    }
    let r = fx.request(
        "fs.edit",
        json!({"path": "m.txt", "expectedSha256": "zz", "edits": []}),
    );
    assert!(fx.prepare_w(r).is_err());
    assert!(fx.disk("m.txt").is_none());
}

#[test]
fn permission_failure_leaves_target_and_directory_untouched() {
    let mut fx = fixture("w-perm");
    fx.approve_write(64 * 1024);
    std::fs::create_dir_all(fx.ws.join("ro")).unwrap();
    fx.write("ro/f.txt", b"orig\n");
    std::fs::set_permissions(fx.ws.join("ro"), std::fs::Permissions::from_mode(0o555)).unwrap();
    let r = fx.run_write(
        "fs.write",
        json!({"path": "ro/f.txt", "content": "NEW", "mode": "replace", "expectedSha256": sha("orig\n")}),
    );
    std::fs::set_permissions(fx.ws.join("ro"), std::fs::Permissions::from_mode(0o755)).unwrap();
    if unsafe { libc_geteuid() } != 0 {
        assert_eq!(wcode(&r), "write-failed");
    }
    assert_eq!(fx.disk("ro/f.txt").unwrap(), "orig\n");
    assert_eq!(std::fs::read_dir(fx.ws.join("ro")).unwrap().count(), 1);
    let last = fx.kernel.list_tool_journal(None).unwrap();
    let t = last.last().unwrap();
    assert!(t.phase == "failed" || t.phase == "completed" || t.phase == "verified");
}

extern "C" {
    #[link_name = "geteuid"]
    fn libc_geteuid() -> u32;
}

/// Runs inside a user+mount namespace where DIR is a 64 KiB tmpfs.
#[test]
fn child_disk_full() {
    if std::env::var("A33_CHILD").as_deref() != Ok("diskfull") {
        return;
    }
    let dir = std::env::var("A33_DIR").unwrap();
    let ws =
        nexus_tools::Workspace::open_root(&dir, nexus_tools::WorkspacePolicy::default()).unwrap();
    std::fs::write(format!("{dir}/a.txt"), "orig\n").unwrap();
    let budgets = nexus_tools::ToolBudgets {
        max_write_bytes: 4 * 1024 * 1024,
        ..Default::default()
    };
    let args = nexus_tools::ToolArgs::parse(
        nexus_tools::ToolId::FsWrite,
        &json!({"path": "a.txt", "content": "z".repeat(1_000_000), "mode": "replace",
                "expectedSha256": sha("orig\n")}),
    )
    .unwrap();
    let mut h = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(|_| {}),
    };
    let cancel = CancellationToken::new("x");
    let res = nexus_tools::write::run_write(&ws, &args, &budgets, &"e".repeat(32), &cancel, &mut h)
        .unwrap();
    let code = res
        .error
        .as_ref()
        .map(|e| e.code.as_str().to_owned())
        .unwrap_or_default();
    let intact = std::fs::read_to_string(format!("{dir}/a.txt")).unwrap() == "orig\n";
    let clean = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .all(|e| !e.file_name().to_string_lossy().starts_with(".nexus-tmp-"));
    assert_eq!(code, "write-failed");
    assert!(intact, "target must be untouched after ENOSPC");
    assert!(clean, "partial temp file must be removed");
    assert_eq!(h.seen.last().unwrap(), "failed");
    println!("DISK-FULL-OK");
}

#[test]
fn disk_full_partial_write_is_cleaned_up() {
    let dir = tempfile::tempdir().unwrap();
    let exe = std::env::current_exe().unwrap();
    let script = format!(
        "mount -t tmpfs -o size=64k tmpfs '{}' && exec \"$0\" \"$@\"",
        dir.path().display()
    );
    let out = std::process::Command::new("unshare")
        .args(["-rm", "sh", "-c", &script])
        .arg(exe)
        .args([
            "--exact",
            "child_disk_full",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("A33_CHILD", "diskfull")
        .env("A33_DIR", dir.path())
        .output();
    let Ok(out) = out else {
        eprintln!("SKIP: unshare unavailable");
        return;
    };
    let so = String::from_utf8_lossy(&out.stdout);
    let se = String::from_utf8_lossy(&out.stderr);
    if se.contains("not permitted") || se.contains("unshare failed") || se.contains("mount:") {
        eprintln!("SKIP: namespaces unavailable: {se}");
        return;
    }
    assert!(
        out.status.success() && so.contains("DISK-FULL-OK"),
        "{so}\n{se}"
    );
}

#[test]
fn replay_after_restart_and_journal_have_no_content() {
    let mut fx = fixture("w-replay");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let args = json!({"path": "a.txt", "content": "SECRET-NEW-CONTENT\n", "mode": "replace", "expectedSha256": sha("orig\n")});
    let r = fx.request("fs.write", args);
    let c = CancellationToken::new(&r.cancellation_id);
    let p = fx.prepare_w(r.clone()).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    execute_write(&mut fx.kernel, &call, &c).unwrap();
    let grant = call.grant().clone();
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    let b = fx.binding();
    let sc = fx.scope();
    drop(fx.kernel);
    let mut k = nexus_kernel::Kernel::open(&db, Some(&wit)).unwrap();
    let again = nexus_tools::AuthorizedToolCall::from_parts(
        nexus_tools::prepare_write(r, &b, &sc).unwrap(),
        grant,
    );
    let e = execute_write(&mut k, &again, &c).unwrap_err();
    assert!(e.message.contains("command-conflict"), "{e}");
    // File content never reaches the journal.
    let dump = serde_json::to_string(
        &k.list_tool_journal(None)
            .unwrap()
            .iter()
            .map(|e| e.payload.clone())
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert!(!dump.contains("SECRET-NEW-CONTENT"));
    assert!(dump.contains(&sha("SECRET-NEW-CONTENT\n")));
}

#[test]
fn recovery_observation_classifies_without_modifying_the_target() {
    let fx = fixture("w-observe");
    fx.write("a.txt", b"orig\n");
    let ws = nexus_tools::Workspace::open_root(
        fx.ws.to_str().unwrap(),
        nexus_tools::WorkspacePolicy::default(),
    )
    .unwrap();
    let planned = json!({"path": "a.txt", "preSha256": sha("orig\n"), "postSha256": sha("new\n"), "tmpName": ".nexus-tmp-zzz"});
    std::fs::write(fx.ws.join(".nexus-tmp-zzz"), "half").unwrap();
    let o = nexus_tools::write::observe_for_recovery(&ws, &planned, &json!({}));
    assert_eq!(o["observed"], "pre-image-intact");
    assert_eq!(o["mutation"], "none");
    assert_eq!(o["tmpRemoved"], true);
    assert!(!fx.ws.join(".nexus-tmp-zzz").exists());
    std::fs::write(fx.ws.join("a.txt"), "new\n").unwrap();
    let o = nexus_tools::write::observe_for_recovery(&ws, &planned, &json!({}));
    assert_eq!(o["observed"], "post-image-present");
    assert_eq!(o["mutation"], "applied-unverified");
    std::fs::write(fx.ws.join("a.txt"), "someone else\n").unwrap();
    let o = nexus_tools::write::observe_for_recovery(&ws, &planned, &json!({}));
    assert_eq!(o["observed"], "diverged");
    assert_eq!(o["mutation"], "uncertain");
    assert_eq!(fx.disk("a.txt").unwrap(), "someone else\n");
}

#[test]
fn temp_artifacts_are_private_and_names_cannot_be_targeted() {
    // The temp prefix is hidden: neither readable nor writable via tools.
    let mut fx = fixture("w-tmpname");
    fx.approve_write(1024);
    let n = nexus_tools::write::temp_name(&"a".repeat(32));
    assert!(n.starts_with(".nexus-tmp-"));
    let r = fx.run_write(
        "fs.write",
        json!({"path": n, "content": "x", "mode": "create"}),
    );
    assert_eq!(wcode(&r), "hidden-path-refused");
}

// ============ A3.3 final audit: reversal must never destroy newer data =====

fn all_file_contents(dir: &std::path::Path) -> Vec<String> {
    all_file_contents_recursive(dir)
}

#[test]
fn reversal_never_destroys_a_foreign_replacement_made_during_the_exchange_window() {
    // 1. external writer changes the file before our exchange (mismatch);
    // 2. after our exchange, ANOTHER external writer atomically replaces
    //    the name with a newer file E. Our reversal must not delete E.
    let mut fx = fixture("w-cas-foreign");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let target = fx.ws.join("a.txt");
    let cancel = CancellationToken::new("x");
    let mut h = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(move |p| {
            if p == "prepared" {
                let t = target.with_file_name("x1.tmp");
                std::fs::write(&t, "EARLIER EXTERNAL\n").unwrap();
                std::fs::rename(&t, &target).unwrap();
            }
            if p == "@after-exchange" {
                let t = target.with_file_name("x2.tmp");
                std::fs::write(&t, "NEWER EXTERNAL\n").unwrap();
                std::fs::rename(&t, &target).unwrap();
            }
        }),
    };
    let res = direct(
        &mut fx,
        json!({"path": "a.txt", "content": "OURS\n", "mode": "replace", "expectedSha256": sha("orig\n")}),
        "fs.write",
        &cancel,
        &mut h,
    );
    assert_eq!(res.error.as_ref().unwrap().code, ToolErrorCode::Conflict);
    // The newest external state is what the name holds...
    assert_eq!(fx.disk("a.txt").unwrap(), "NEWER EXTERNAL\n");
    // ...and the displaced earlier external state still exists (preserved).
    let all = all_file_contents(&fx.ws);
    assert!(all.contains(&"EARLIER EXTERNAL\n".to_owned()), "{all:?}");
    assert!(
        !all.iter().any(|c| c == "OURS\n"),
        "our rejected content must not be published"
    );
}

#[test]
fn in_place_write_into_our_inode_during_the_window_is_preserved() {
    let mut fx = fixture("w-cas-inplace");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let target = fx.ws.join("a.txt");
    let cancel = CancellationToken::new("x");
    let mut h = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(move |p| {
            if p == "prepared" {
                let t = target.with_file_name("x1.tmp");
                std::fs::write(&t, "EXTERNAL BEFORE\n").unwrap();
                std::fs::rename(&t, &target).unwrap();
            }
            if p == "@after-exchange" {
                // A writer that opens by name now lands in OUR inode.
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&target)
                    .unwrap();
                f.write_all(b"APPENDED BY EXTERNAL\n").unwrap();
            }
        }),
    };
    let res = direct(
        &mut fx,
        json!({"path": "a.txt", "content": "OURS\n", "mode": "replace", "expectedSha256": sha("orig\n")}),
        "fs.write",
        &cancel,
        &mut h,
    );
    assert_eq!(res.error.as_ref().unwrap().code, ToolErrorCode::Conflict);
    assert_eq!(fx.disk("a.txt").unwrap(), "EXTERNAL BEFORE\n");
    let all = all_file_contents(&fx.ws);
    assert!(
        all.iter().any(|c| c.contains("APPENDED BY EXTERNAL")),
        "the external in-place write was destroyed: {all:?}"
    );
}

#[test]
fn in_place_write_into_published_file_is_reported_not_hidden() {
    // Success path: matching pre-image, but a writer lands in the new
    // inode right after publication. Verification must not claim success
    // and nothing may be deleted.
    let mut fx = fixture("w-cas-inplace-ok");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let target = fx.ws.join("a.txt");
    let cancel = CancellationToken::new("x");
    let mut h = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(move |p| {
            if p == "@after-exchange" {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&target)
                    .unwrap();
                f.write_all(b"LATE WRITER\n").unwrap();
            }
        }),
    };
    let res = direct(
        &mut fx,
        json!({"path": "a.txt", "content": "OURS\n", "mode": "replace", "expectedSha256": sha("orig\n")}),
        "fs.write",
        &cancel,
        &mut h,
    );
    assert_eq!(
        res.error.as_ref().unwrap().code,
        ToolErrorCode::PublishedUnverified
    );
    assert_eq!(fx.disk("a.txt").unwrap(), "OURS\nLATE WRITER\n");
    assert_eq!(h.seen.last().unwrap(), "failed");
}

#[test]
fn recovery_never_deletes_a_displaced_foreign_file() {
    // Crash right after the exchange: name holds our post-image, the temp
    // name holds the displaced file. If that file is NOT the expected
    // pre-image (and not our inode) it must be preserved, not unlinked.
    let fx = fixture("w-recover-displaced");
    let ws = nexus_tools::Workspace::open_root(
        fx.ws.to_str().unwrap(),
        nexus_tools::WorkspacePolicy::default(),
    )
    .unwrap();
    std::fs::write(fx.ws.join("a.txt"), "OURS\n").unwrap();
    std::fs::write(fx.ws.join(".nexus-tmp-zzz"), "FOREIGN CONTENT\n").unwrap();
    let planned = json!({"path": "a.txt", "preSha256": sha("orig\n"), "postSha256": sha("OURS\n"), "tmpName": ".nexus-tmp-zzz"});
    let prepared =
        json!({"tmpName": ".nexus-tmp-zzz", "postSha256": sha("OURS\n"), "tmpDev": 1, "tmpIno": 2});
    let o = nexus_tools::write::observe_for_recovery(&ws, &planned, &prepared);
    assert_eq!(o["observed"], "post-image-present");
    assert_eq!(o["mutation"], "applied-unverified");
    assert_eq!(o["displacedPreserved"], true, "{o}");
    assert_eq!(o["publishedOverUnexpectedPreImage"], true);
    let all = all_file_contents(&fx.ws);
    assert!(all.contains(&"FOREIGN CONTENT\n".to_owned()), "{all:?}");
    // And the expected pre-image displaced by a *successful* exchange is
    // safe to remove.
    std::fs::write(fx.ws.join(".nexus-tmp-yyy"), "orig\n").unwrap();
    let planned = json!({"path": "a.txt", "preSha256": sha("orig\n"), "postSha256": sha("OURS\n"), "tmpName": ".nexus-tmp-yyy"});
    let o = nexus_tools::write::observe_for_recovery(&ws, &planned, &prepared);
    assert_eq!(o["displacedRemoved"], true, "{o}");
    assert!(!fx.ws.join(".nexus-tmp-yyy").exists());
}

// ------------------------------------------------------------- metadata

#[test]
fn metadata_contract_executable_bit_preserved_and_unpreservable_state_refused() {
    let mut fx = fixture("w-meta");
    fx.approve_write(64 * 1024);
    // Executable scripts stay executable (permission bits are preserved).
    fx.write("run.sh", b"#!/bin/sh\necho one\n");
    std::fs::set_permissions(fx.ws.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let r = fx
        .run_write(
            "fs.write",
            json!({"path": "run.sh", "content": "#!/bin/sh\necho two\n", "mode": "replace",
                   "expectedSha256": sha("#!/bin/sh\necho one\n")}),
        )
        .unwrap();
    assert!(r.result.error.is_none());
    assert_eq!(
        std::fs::metadata(fx.ws.join("run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o755
    );
    // A new inode is created: the inode number changes (documented).
    // setuid/setgid/sticky targets are refused, not silently stripped.
    fx.write("suid.sh", b"x\n");
    std::fs::set_permissions(
        fx.ws.join("suid.sh"),
        std::fs::Permissions::from_mode(0o4755),
    )
    .unwrap();
    let r = fx
        .run_write(
            "fs.write",
            json!({"path": "suid.sh", "content": "y\n", "mode": "replace", "expectedSha256": sha("x\n")}),
        )
        .unwrap();
    assert_eq!(
        r.result.error.as_ref().unwrap().code,
        ToolErrorCode::Conflict
    );
    assert_eq!(r.journal.payload["conflict"], "special-mode-bits");
    assert_eq!(fx.disk("suid.sh").unwrap(), "x\n");
    // User xattrs (and ACLs, stored as xattrs) are refused, not dropped.
    fx.write("x.txt", b"x\n");
    let p = std::ffi::CString::new(fx.ws.join("x.txt").to_str().unwrap()).unwrap();
    let n = std::ffi::CString::new("user.nexus_test").unwrap();
    let rc = unsafe { setxattr(p.as_ptr(), n.as_ptr(), b"1".as_ptr().cast(), 1, 0) };
    if rc == 0 {
        let r = fx
            .run_write(
                "fs.write",
                json!({"path": "x.txt", "content": "y\n", "mode": "replace", "expectedSha256": sha("x\n")}),
            )
            .unwrap();
        assert_eq!(
            r.result.error.as_ref().unwrap().code,
            ToolErrorCode::Conflict
        );
        assert_eq!(r.journal.payload["conflict"], "xattr-present");
        assert_eq!(fx.disk("x.txt").unwrap(), "x\n");
    } else {
        eprintln!("SKIP xattr: filesystem does not support user xattrs");
    }
    // Create applies the requested bits exactly (umask-independent).
    let r = fx
        .run_write(
            "fs.write",
            json!({"path": "c.sh", "content": "#!/bin/sh\n", "mode": "create", "fileMode": "755"}),
        )
        .unwrap();
    assert!(r.result.error.is_none());
    assert_eq!(
        std::fs::metadata(fx.ws.join("c.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o755
    );
}

extern "C" {
    fn setxattr(
        path: *const std::os::raw::c_char,
        name: *const std::os::raw::c_char,
        value: *const std::os::raw::c_void,
        size: usize,
        flags: i32,
    ) -> i32;
}

#[test]
fn deterministic_publication_window_matrix_never_loses_data() {
    // Every injected external action at the post-exchange sync point must
    // leave every distinct external byte string on disk somewhere.
    for (case, action) in [
        ("replace", 0u8),
        ("inplace", 1),
        ("delete", 2),
        ("rename-away", 3),
    ] {
        let mut fx = fixture(&format!("w-matrix-{case}"));
        fx.approve_write(64 * 1024);
        fx.write("a.txt", b"orig\n");
        let target = fx.ws.join("a.txt");
        let cancel = CancellationToken::new("x");
        let t2 = target.clone();
        let mut h = Script {
            seen: vec![],
            fence_after: None,
            fences: 0,
            fail_journal_at: None,
            on_phase: Box::new(move |p| {
                if p == "prepared" {
                    // force the mismatch path
                    let t = t2.with_file_name("pre.tmp");
                    std::fs::write(&t, "MISMATCH\n").unwrap();
                    std::fs::rename(&t, &t2).unwrap();
                }
                if p == "@after-exchange" {
                    match action {
                        0 => {
                            let t = t2.with_file_name("e.tmp");
                            std::fs::write(&t, "E-REPLACED\n").unwrap();
                            std::fs::rename(&t, &t2).unwrap();
                        }
                        1 => {
                            use std::io::Write;
                            let mut f = std::fs::OpenOptions::new().append(true).open(&t2).unwrap();
                            f.write_all(b"E-APPEND\n").unwrap();
                        }
                        2 => {
                            std::fs::remove_file(&t2).unwrap();
                        }
                        _ => {
                            std::fs::rename(&t2, t2.with_file_name("moved-away.txt")).unwrap();
                        }
                    }
                }
            }),
        };
        let res = direct(
            &mut fx,
            json!({"path": "a.txt", "content": "OURS\n", "mode": "replace", "expectedSha256": sha("orig\n")}),
            "fs.write",
            &cancel,
            &mut h,
        );
        // Never reports success; never publishes our content as final.
        assert!(res.error.is_some(), "{case}");
        if action == 3 {
            // The external party moved OUR published file away, so the
            // reversal cannot be completed. The honest outcome is
            // "published-unverified"; nothing may be deleted.
            assert_eq!(
                res.error.as_ref().unwrap().code,
                ToolErrorCode::PublishedUnverified
            );
            let all = all_file_contents(&fx.ws);
            assert!(all.contains(&"MISMATCH\n".to_owned()), "{case}: {all:?}");
            continue;
        }
        let all = all_file_contents(&fx.ws);
        assert!(all.contains(&"MISMATCH\n".to_owned()), "{case}: {all:?}");
        match action {
            0 => assert!(all.contains(&"E-REPLACED\n".to_owned()), "{case}: {all:?}"),
            1 => assert!(
                all.iter().any(|c| c.contains("E-APPEND")),
                "{case}: {all:?}"
            ),
            _ => {}
        }
        assert!(
            !all.iter().any(|c| c == "OURS\n"),
            "{case}: rejected content must not survive unmodified: {all:?}"
        );
    }
}

// ============ A3.4 Phase 0: cleanup-unlink TOCTOU (directory writer) ======

#[cfg(feature = "crash-injection")]
#[test]
fn cleanup_cannot_remove_a_foreign_file_renamed_onto_the_temp_name() {
    // An adversary with write access to the *public* parent directory
    // learns the temp name and renames their own file onto it inside the
    // check-then-unlink window. Cleanup must never delete a file it did
    // not create.
    let mut fx = fixture("w-toctou");
    fx.approve_write(64 * 1024);
    fx.write("a.txt", b"orig\n");
    let ws_dir = fx.ws.clone();
    let victim = fx.ws.join("VICTIM.txt");
    std::fs::write(&victim, "FOREIGN DATA\n").unwrap();
    let public_tmp = ws_dir.join(nexus_tools::write::temp_name(&"e".repeat(32)));
    let (v2, p2) = (victim.clone(), public_tmp.clone());
    nexus_tools::mutate::set_between_check_and_unlink(Some(Box::new(move |_name| {
        // Atomically put the foreign file at the (known) public temp name.
        let _ = std::fs::rename(&v2, &p2);
    })));
    let cancel = CancellationToken::new("x");
    let mut h = Script {
        seen: vec![],
        fence_after: None,
        fences: 0,
        fail_journal_at: None,
        on_phase: Box::new(|_| {}),
    };
    let res = direct(
        &mut fx,
        json!({"path": "a.txt", "content": "NEW\n", "mode": "replace", "expectedSha256": sha("orig\n")}),
        "fs.write",
        &cancel,
        &mut h,
    );
    nexus_tools::mutate::set_between_check_and_unlink(None);
    assert!(res.error.is_none(), "{:?}", res.error);
    let all = all_file_contents_recursive(&ws_dir);
    assert!(
        all.contains(&"FOREIGN DATA\n".to_owned()),
        "a foreign file renamed onto the temp name was deleted: {all:?}"
    );
}

#[allow(dead_code)]
fn all_file_contents_recursive(dir: &std::path::Path) -> Vec<String> {
    let mut v = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let t = e.file_type().unwrap();
            if t.is_dir() {
                stack.push(e.path());
            } else if t.is_file() {
                if let Ok(s) = std::fs::read_to_string(e.path()) {
                    v.push(s);
                }
            }
        }
    }
    v.sort();
    v
}

#[test]
fn staged_recovery_preserves_displaced_foreign_file_inside_the_stage() {
    let fx = fixture("w-stage-recover");
    let ws = nexus_tools::Workspace::open_root(
        fx.ws.to_str().unwrap(),
        nexus_tools::WorkspacePolicy::default(),
    )
    .unwrap();
    std::fs::write(fx.ws.join("a.txt"), "OURS\n").unwrap();
    let stage = fx.ws.join(".nexus-stage-q");
    std::fs::create_dir(&stage).unwrap();
    std::fs::write(stage.join(".nexus-tmp-q"), "FOREIGN\n").unwrap();
    let planned = json!({"path": "a.txt", "preSha256": sha("orig\n"), "postSha256": sha("OURS\n"),
        "tmpName": ".nexus-tmp-q", "stageName": ".nexus-stage-q"});
    let prepared =
        json!({"tmpName": ".nexus-tmp-q", "stageName": ".nexus-stage-q", "tmpDev": 1, "tmpIno": 2});
    let o = nexus_tools::write::observe_for_recovery(&ws, &planned, &prepared);
    assert_eq!(o["displacedPreserved"], true, "{o}");
    assert_eq!(o["preservedAs"], ".nexus-stage-q/displaced");
    assert_eq!(
        std::fs::read_to_string(stage.join("displaced")).unwrap(),
        "FOREIGN\n"
    );
    // A stage whose temp is verifiably ours is removed entirely.
    let stage2 = fx.ws.join(".nexus-stage-r");
    std::fs::create_dir(&stage2).unwrap();
    std::fs::write(stage2.join(".nexus-tmp-r"), "half").unwrap();
    use std::os::unix::fs::MetadataExt;
    let md = std::fs::metadata(stage2.join(".nexus-tmp-r")).unwrap();
    let planned = json!({"path": "a.txt", "preSha256": sha("orig\n"), "postSha256": sha("OURS\n"),
        "tmpName": ".nexus-tmp-r", "stageName": ".nexus-stage-r"});
    let prepared = json!({"tmpName": ".nexus-tmp-r", "tmpDev": md.dev(), "tmpIno": md.ino()});
    let o = nexus_tools::write::observe_for_recovery(&ws, &planned, &prepared);
    assert_eq!(o["tmpRemoved"], true, "{o}");
    assert!(!stage2.exists());
}
