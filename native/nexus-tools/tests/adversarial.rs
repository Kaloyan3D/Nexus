//! A3.1 adversarial suite: real filesystem, real Kernel, real journal.

mod common;

use common::*;
use nexus_kernel::Kernel;
use nexus_tools::workspace::{RelPath, Workspace, WorkspacePolicy};
use nexus_tools::{
    authorize, execute, tool_events_from_journal, CancellationToken, ToolBudgets, ToolEventStatus,
};
use serde_json::json;

// ---------------------------------------------------------------- happy path

#[test]
fn list_read_search_work_and_are_deterministic() {
    let mut fx = fixture("happy");
    fx.write("src/b.rs", b"fn beta() {}\n// needle here\n");
    fx.write("src/a.rs", b"fn alpha() {}\n");
    fx.write("README.md", b"# readme\nneedle again\n");
    let l = fx.run("fs.list", json!({"path": "."})).unwrap();
    let names: Vec<_> = l.result.output.as_ref().unwrap()["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, vec!["README.md", "src"]);

    let r = fx.run("fs.read", json!({"path": "src/b.rs"})).unwrap();
    assert_eq!(
        r.result.output.as_ref().unwrap()["content"],
        "fn beta() {}\n// needle here\n"
    );
    let r = fx
        .run(
            "fs.read",
            json!({"path": "src/b.rs", "startLine": 2, "maxLines": 1}),
        )
        .unwrap();
    assert_eq!(
        r.result.output.as_ref().unwrap()["content"],
        "// needle here\n"
    );

    let s1 = fx.run("fs.search", json!({"query": "needle"})).unwrap();
    let s2 = fx.run("fs.search", json!({"query": "needle"})).unwrap();
    assert_eq!(s1.result.output_digest, s2.result.output_digest);
    assert_eq!(s1.result.output, s2.result.output);
    let m = s1.result.output.as_ref().unwrap()["matches"]
        .as_array()
        .unwrap()
        .clone();
    let paths: Vec<_> = m.iter().map(|x| x["path"].as_str().unwrap()).collect();
    assert_eq!(paths, vec!["README.md", "src/b.rs"]);
    // Journal: three phases per execution, all verified.
    assert_eq!(fx.kernel.verify_tool_journal().unwrap(), 5 * 3);
}

// ----------------------------------------------------------- path traversal

#[test]
fn traversal_and_encoded_forms_are_refused_with_zero_fs_access() {
    let mut fx = fixture("trav");
    fx.write("a.txt", b"ok\n");
    for bad in [
        "../outside/secret.txt",
        "a/../../outside/secret.txt",
        "..",
        "./../x",
        "/etc/passwd",
        "/proc/self/environ",
        "/dev/zero",
        "..\\outside\\secret.txt",
        "%2e%2e/outside/secret.txt",
        "a/%2E%2E/b",
        "a%2fb",
        "~/.ssh/id_rsa",
        "a\0b",
        "sub/../a.txt",
    ] {
        let r = fx.request("fs.read", json!({"path": bad}));
        let cancel = CancellationToken::new(&r.cancellation_id);
        let call = authorize(&mut fx.kernel, prepare_b(r).unwrap()).unwrap();
        let res = execute(&mut fx.kernel, &call, &cancel).unwrap();
        assert_eq!(
            res.result.error.as_ref().map(|e| e.code.as_str()),
            Some("path-invalid"),
            "path {bad:?}"
        );
        assert_eq!(call.prepared().workspace().access_count(), 0, "{bad:?}");
    }
}

#[test]
fn env_vars_are_not_expanded() {
    let mut fx = fixture("env");
    fx.write("real.txt", b"x\n");
    let r = fx.run("fs.read", json!({"path": "$HOME/real.txt"}));
    assert_eq!(err_code(&r), "not-found");
    let r = fx.run("fs.read", json!({"path": "${PWD}"}));
    assert_eq!(err_code(&r), "not-found");
}

#[test]
fn forbidden_workspace_roots_are_refused() {
    for root in ["/proc", "/sys", "/dev", "/", "relative/dir", "/proc/self"] {
        assert!(
            Workspace::open_root(root, WorkspacePolicy::default()).is_err(),
            "{root}"
        );
    }
}

// ---------------------------------------------------------------- symlinks

#[test]
fn symlink_escapes_are_never_followed() {
    let mut fx = fixture("sym");
    fx.write("inside.txt", b"inside\n");
    symlink(&fx.outside.join("secret.txt"), &fx.ws.join("link-file"));
    symlink(&fx.outside, &fx.ws.join("link-dir"));
    symlink(
        std::path::Path::new("/etc/hostname"),
        &fx.ws.join("link-etc"),
    );
    symlink(std::path::Path::new("."), &fx.ws.join("loop"));
    for p in [
        "link-file",
        "link-dir/secret.txt",
        "link-etc",
        "loop/inside.txt",
    ] {
        let r = fx.run("fs.read", json!({"path": p}));
        assert_eq!(err_code(&r), "symlink-refused", "{p}");
    }
    let r = fx.run("fs.list", json!({"path": "link-dir"}));
    assert_eq!(err_code(&r), "symlink-refused");
    // Search must neither follow nor leak.
    let s = fx
        .run("fs.search", json!({"query": OUTSIDE_SECRET}))
        .unwrap();
    assert!(s.result.output.as_ref().unwrap()["matches"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(s.result.stats.skipped_symlinks >= 4);
    // Listing reports the symlink without following it.
    let l = fx.run("fs.list", json!({})).unwrap();
    let kinds: Vec<_> = l.result.output.as_ref().unwrap()["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["name"].as_str().unwrap().starts_with("link"))
        .map(|e| e["kind"].as_str().unwrap().to_owned())
        .collect();
    assert!(kinds.iter().all(|k| k == "symlink"));
}

#[test]
fn symlinked_workspace_root_ancestors_are_resolved_by_canonical_identity() {
    let fx = fixture("rootsym");
    let alias = fx.dir.path().join("alias");
    symlink(&fx.ws, &alias);
    // The issuer may name the root through a symlink; the pinned identity
    // is the real directory, and the final component is opened O_NOFOLLOW.
    let a = Workspace::open_root(alias.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let b = Workspace::open_root(fx.ws.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    assert_eq!((a.root_dev(), a.root_ino()), (b.root_dev(), b.root_ino()));
}

// ------------------------------------------------------ TOCTOU / replacement

#[test]
fn file_replaced_by_symlink_race_never_leaks() {
    let fx = fixture("race-file");
    std::fs::write(fx.ws.join("target.txt"), "benign\n").unwrap();
    let ws = Workspace::open_root(fx.ws.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let t = {
        let stop = stop.clone();
        let wsdir = fx.ws.clone();
        let secret = fx.outside.join("secret.txt");
        std::thread::spawn(move || {
            let link = wsdir.join("target.txt");
            let tmp = wsdir.join("swap.tmp");
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = std::fs::remove_file(&tmp);
                let _ = std::os::unix::fs::symlink(&secret, &tmp);
                let _ = std::fs::rename(&tmp, &link); // atomic replace -> symlink
                let _ = std::fs::write(wsdir.join("benign.tmp"), "benign\n");
                let _ = std::fs::rename(wsdir.join("benign.tmp"), &link); // back to file
            }
        })
    };
    let rel = RelPath::parse("target.txt").unwrap();
    let mut ok = 0u32;
    let mut refused = 0u32;
    for _ in 0..30_000 {
        match ws.open_file(&rel) {
            Ok(o) => {
                use std::io::Read;
                let mut s = String::new();
                std::fs::File::from(o.fd).read_to_string(&mut s).unwrap();
                assert!(!s.contains(OUTSIDE_SECRET), "leaked via race");
                ok += 1;
            }
            Err(e) => {
                assert!(
                    matches!(
                        e.code.as_str(),
                        "symlink-refused" | "race-detected" | "not-found"
                    ),
                    "unexpected {e}"
                );
                refused += 1;
            }
        }
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    t.join().unwrap();
    assert!(ok + refused == 30_000);
}

#[test]
fn directory_replaced_by_symlink_race_never_leaks() {
    let fx = fixture("race-dir");
    std::fs::create_dir_all(fx.ws.join("d")).unwrap();
    std::fs::write(fx.ws.join("d/secret.txt"), "benign\n").unwrap();
    let ws = Workspace::open_root(fx.ws.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let t = {
        let stop = stop.clone();
        let wsdir = fx.ws.clone();
        let outside = fx.outside.clone();
        std::thread::spawn(move || {
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                let tmp = wsdir.join("d.swap");
                let _ = std::fs::remove_file(&tmp);
                let _ = std::os::unix::fs::symlink(&outside, &tmp);
                // rename over a directory fails; emulate replacement by
                // moving the real dir aside and putting the symlink in.
                let _ = std::fs::rename(wsdir.join("d"), wsdir.join("d.real"));
                let _ = std::fs::rename(&tmp, wsdir.join("d"));
                let _ = std::fs::remove_file(wsdir.join("d"));
                let _ = std::fs::rename(wsdir.join("d.real"), wsdir.join("d"));
            }
        })
    };
    let rel = RelPath::parse("d/secret.txt").unwrap();
    for _ in 0..30_000 {
        if let Ok(o) = ws.open_file(&rel) {
            use std::io::Read;
            let mut s = String::new();
            std::fs::File::from(o.fd).read_to_string(&mut s).unwrap();
            assert!(!s.contains(OUTSIDE_SECRET), "leaked via directory swap");
        }
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    t.join().unwrap();
}

// ------------------------------------------------- authorization refusals

fn assert_no_start(fx: &Fx) {
    assert!(!fx.journal_phases().iter().any(|p| p == "started"));
}
use common::Fx;

#[test]
fn foreign_or_replaced_workspace_root_is_refused_before_any_read() {
    let mut fx = fixture("ws-mismatch");
    fx.write("a.txt", b"a\n");
    let other = fx.dir.path().join("other-ws");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("a.txt"), "OTHER-WS\n").unwrap();
    // A binding pointing at a different directory (forged root) cannot be
    // prepared: identity differs from the sealed Controller binding.
    let mut forged = fx.binding();
    forged.root_path = other.to_str().unwrap().to_owned();
    let r = fx.request("fs.read", json!({"path": "a.txt"}));
    let e = nexus_tools::prepare(r, &forged).unwrap_err();
    assert_eq!(e.code.as_str(), "workspace-mismatch");
    // Root replacement: move the authorized dir away, put another in place.
    let moved = fx.dir.path().join("moved-ws");
    std::fs::rename(&fx.ws, &moved).unwrap();
    std::fs::create_dir_all(&fx.ws).unwrap();
    std::fs::write(fx.ws.join("a.txt"), "REPLACED\n").unwrap();
    let r = fx.request("fs.read", json!({"path": "a.txt"}));
    let e = fx.prepare_req(r).unwrap_err();
    assert_eq!(e.code.as_str(), "workspace-mismatch", "{e}");
    assert_no_start(&fx);
}

#[test]
fn stale_attempt_generation_is_refused_before_any_read() {
    let mut fx = fixture("stale");
    fx.write("a.txt", b"a\n");
    let (call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    // A newer generation supersedes the lease after authorization.
    fx.kernel
        .acquire_generation(&fx.task.clone(), "native")
        .unwrap();
    let r = execute(&mut fx.kernel, &call, &cancel);
    let e = r.unwrap_err();
    assert_eq!(e.code.as_str(), "authorization-refused");
    assert!(e.message.contains("stale-lease"), "{e}");
    assert_eq!(call.prepared().workspace().access_count(), 0);
    assert_no_start(&fx);
    // And a fresh request that still carries the old epoch cannot even be authorized.
    let r = fx.request("fs.read", json!({"path": "a.txt"}));
    let p = prepare_b(r).unwrap();
    let e = authorize(&mut fx.kernel, p).unwrap_err();
    assert!(e.message.contains("stale-lease"), "{e}");
}

#[test]
fn forged_requests_and_grants_are_refused() {
    let mut fx = fixture("forge");
    fx.write("a.txt", b"a\n");

    // Unknown command identity.
    let mut r = fx.request("fs.read", json!({"path": "a.txt"}));
    r.command_id = "cmd-never-accepted".into();
    // The Controller binding belongs to the real command, so preparing a
    // request for another command cannot even start.
    let b = fx.binding();
    let e = nexus_tools::prepare(r.clone(), &b).unwrap_err();
    assert_eq!(e.code.as_str(), "workspace-mismatch");
    // Even a hand-forged binding for the unknown command is refused by the
    // Kernel: it has no sealed binding and no accepted receipt for it.
    let mut fb = b.clone();
    fb.command_id = "cmd-never-accepted".into();
    let e = authorize(&mut fx.kernel, nexus_tools::prepare(r, &fb).unwrap()).unwrap_err();
    assert_eq!(e.code.as_str(), "authorization-refused");

    // Wrong attempt for a real command.
    let mut r = fx.request("fs.read", json!({"path": "a.txt"}));
    r.attempt_id = "attempt-evil".into();
    let b = fx.binding();
    assert_eq!(
        nexus_tools::prepare(r.clone(), &b)
            .unwrap_err()
            .code
            .as_str(),
        "workspace-mismatch"
    );
    // A forged binding that claims the evil attempt is caught by the Kernel
    // (the sealed binding for the real command says otherwise).
    let mut fb = b.clone();
    fb.attempt_id = "attempt-evil".into();
    let e = authorize(&mut fx.kernel, nexus_tools::prepare(r, &fb).unwrap()).unwrap_err();
    assert!(e.message.contains("binding-mismatch"), "{e}");

    // Arbitrary JSON with unknown / extra fields cannot even deserialize.
    let raw = json!({
        "schemaVersion": 1, "requestId": "x", "cancellationId": "x", "taskInstanceId": "t",
        "attemptId": "a", "commandId": "c", "leaseEpoch": 1, "storeIncarnation": "i",
        "toolId": "fs.read", "toolVersion": 1, "args": {"path": "a.txt"},
        "budgets": ToolBudgets::default(), "workspaceRoot": "/tmp", "grant": "trust-me"
    });
    assert!(serde_json::from_value::<nexus_tools::ToolRequestV1>(raw).is_err());

    // Altered grant fields (tag left intact) fail the seal.
    for mutate in 0..4 {
        let (call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
        let mut g = call.grant().clone();
        match mutate {
            0 => g.expires_at_ms += 3_600_000,
            1 => g.attempt_id = "attempt-evil".into(),
            2 => g.lease_epoch += 1,
            _ => g.tag_hex = "00".repeat(32),
        }
        // Rebuild a call carrying the forged grant over the same prepared request.
        let p = prepare_b(call.prepared().request().clone()).unwrap();
        let forged = nexus_tools::AuthorizedToolCall::from_parts(p, g);
        let res = execute(&mut fx.kernel, &forged, &cancel);
        assert!(res.is_err(), "mutation {mutate} must be refused");
        assert_eq!(forged.prepared().workspace().access_count(), 0);
    }
    assert_no_start(&fx);
}

#[test]
fn arguments_swapped_after_authorization_are_refused() {
    let mut fx = fixture("argswap");
    fx.write("safe.txt", b"safe\n");
    fx.write("other.txt", b"OTHER\n");
    let (call, cancel) = fx.authorized("fs.read", json!({"path": "safe.txt"}));
    let mut r = call.prepared().request().clone();
    r.args = json!({"path": "other.txt"});
    let swapped =
        nexus_tools::AuthorizedToolCall::from_parts(prepare_b(r).unwrap(), call.grant().clone());
    let e = execute(&mut fx.kernel, &swapped, &cancel).unwrap_err();
    assert!(e.message.contains("binding-mismatch"), "{e}");
    assert_eq!(swapped.prepared().workspace().access_count(), 0);
}

#[test]
fn budget_inflation_after_authorization_is_refused() {
    let mut fx = fixture("budgetswap");
    fx.write("a.txt", b"a\n");
    let (call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    let mut r = call.prepared().request().clone();
    r.budgets.max_file_bytes = 8 * 1024 * 1024;
    let inflated =
        nexus_tools::AuthorizedToolCall::from_parts(prepare_b(r).unwrap(), call.grant().clone());
    let e = execute(&mut fx.kernel, &inflated, &cancel).unwrap_err();
    assert!(e.message.contains("binding-mismatch"), "{e}");
}

#[test]
fn replay_and_duplicate_execution_are_refused() {
    let mut fx = fixture("replay");
    fx.write("a.txt", b"a\n");
    let (call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    execute(&mut fx.kernel, &call, &cancel).unwrap();
    // Same grant again: exactly-once start.
    let again = execute(&mut fx.kernel, &call, &cancel).unwrap_err();
    assert!(again.message.contains("command-conflict"), "{again}");
    // Re-presenting through a fresh prepared view of the same request too.
    let p = prepare_b(call.prepared().request().clone()).unwrap();
    let dup = nexus_tools::AuthorizedToolCall::from_parts(p, call.grant().clone());
    let e = execute(&mut fx.kernel, &dup, &cancel).unwrap_err();
    assert!(e.message.contains("command-conflict"), "{e}");
    assert_eq!(dup.prepared().workspace().access_count(), 0);
    // Re-authorizing the same request id is also a conflict.
    let p = prepare_b(call.prepared().request().clone()).unwrap();
    let e = authorize(&mut fx.kernel, p).unwrap_err();
    assert!(e.message.contains("command-conflict"), "{e}");
    let phases = fx.journal_phases();
    assert_eq!(phases, vec!["authorized", "started", "completed"]);
}

#[test]
fn cancelled_command_and_fenced_intent_refuse_authority() {
    let mut fx = fixture("fence");
    fx.write("a.txt", b"a\n");
    // Pre-cancelled token: nothing is started.
    let (call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    cancel.cancel();
    let e = execute(&mut fx.kernel, &call, &cancel).unwrap_err();
    assert_eq!(e.code.as_str(), "cancelled");
    assert_eq!(call.prepared().workspace().access_count(), 0);
    assert_no_start(&fx);
    // Wrong cancellation identity.
    let (call, _c) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    let wrong = CancellationToken::new("someone-elses-token");
    let e = execute(&mut fx.kernel, &call, &wrong).unwrap_err();
    assert_eq!(e.code.as_str(), "authorization-refused");
    assert_no_start(&fx);
}

#[test]
fn dispatch_stays_disabled_and_only_scoped_mutating_tools_exist() {
    assert!(!Kernel::dispatch_enabled());
    let d = nexus_tools::descriptors();
    let ids: Vec<_> = d.iter().map(|d| d.id).collect();
    assert_eq!(
        ids,
        vec!["fs.list", "fs.read", "fs.search", "fs.write", "fs.edit"]
    );
    for t in &d {
        assert_eq!(t.read_only, !t.requires_write_scope, "{}", t.id);
    }
    let mut fx = fixture("nowrite");
    // No shell/exec/delete tool can even be named.
    for t in ["shell.exec", "fs.delete", "fs.move", "fs.chmod"] {
        let r = fx.request(t, json!({}));
        assert_eq!(prepare_b(r).unwrap_err().code.as_str(), "unsupported-tool");
    }
    // Mutating tools cannot be prepared through the read path.
    let r = fx.request(
        "fs.write",
        json!({"path": "a.txt", "content": "x", "mode": "create"}),
    );
    let e = prepare_b(r).unwrap_err();
    assert_eq!(e.code.as_str(), "authorization-refused");
}

// ----------------------------------------------------------------- limits

#[test]
fn oversized_files_are_refused_without_reading() {
    let mut fx = fixture("big");
    fx.write("big.txt", &vec![b'x'; 200_000]);
    let mut r = fx.request("fs.read", json!({"path": "big.txt"}));
    r.budgets.max_file_bytes = 100_000;
    let o = fx.run_request(r).unwrap();
    assert_eq!(
        o.result.error.as_ref().unwrap().code.as_str(),
        "file-too-large"
    );
    assert_eq!(o.result.stats.bytes_read, 0);
    // Default ceiling clamps hostile budget requests.
    let mut r = fx.request("fs.read", json!({"path": "big.txt"}));
    r.budgets.max_file_bytes = u64::MAX;
    let p = prepare_b(r).unwrap();
    assert_eq!(p.budgets().max_file_bytes, 8 * 1024 * 1024);
}

#[test]
fn large_directory_and_entry_budgets() {
    let mut fx = fixture("dirbig");
    for i in 0..60 {
        fx.write(&format!("d/f{i:03}.txt"), b"x\n");
    }
    let mut r = fx.request("fs.list", json!({"path": "d"}));
    r.budgets.max_dir_entries_scan = 10;
    let o = fx.run_request(r).unwrap();
    assert_eq!(
        o.result.error.as_ref().unwrap().code.as_str(),
        "directory-too-large"
    );
    let mut r = fx.request("fs.list", json!({"path": "d"}));
    r.budgets.max_entries = 5;
    let o = fx.run_request(r).unwrap();
    let ents = o.result.output.as_ref().unwrap()["entries"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(ents, 5);
    assert!(o.result.truncation.truncated);
    assert_eq!(o.result.truncation.reasons, vec!["max-entries"]);
    assert_eq!(o.result.status, nexus_tools::ResultStatus::Truncated);
}

#[test]
fn binary_and_invalid_utf8_are_handled_safely() {
    let mut fx = fixture("bin");
    fx.write(
        "bin.dat",
        &[0u8, 1, 2, 3, b'n', b'e', b'e', b'd', b'l', b'e'],
    );
    fx.write("latin1.txt", b"ok line\nbad \xff\xfe line needle\n");
    fx.write("good.txt", b"needle ok\n");
    let r = fx.run("fs.read", json!({"path": "bin.dat"}));
    assert_eq!(err_code(&r), "binary-file");
    let r = fx.run("fs.read", json!({"path": "latin1.txt"}));
    assert_eq!(err_code(&r), "invalid-utf8");
    assert!(r
        .as_ref()
        .unwrap()
        .result
        .error
        .as_ref()
        .unwrap()
        .message
        .contains("line 2"));
    let s = fx.run("fs.search", json!({"query": "needle"})).unwrap();
    assert_eq!(s.result.stats.skipped_binary, 1);
    assert_eq!(s.result.stats.skipped_invalid_utf8, 1);
    let paths: Vec<_> = s.result.output.as_ref().unwrap()["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["path"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(paths, vec!["good.txt"]);
}

#[test]
fn credential_and_hidden_files_are_never_read_or_searched() {
    let mut fx = fixture("cred");
    let marker = "CRED-MARKER-77";
    for p in [
        ".env",
        ".env.production",
        "id_rsa",
        "keys/server.pem",
        "deploy.key",
        ".ssh/config",
        ".aws/credentials",
        "credentials.json",
        ".npmrc",
        ".git/config",
        ".hidden",
        "config/.secret",
    ] {
        fx.write(p, format!("{marker}\n").as_bytes());
    }
    fx.write(".gitignore", b"target\n");
    fx.write(".env.example", b"KEY=\n");
    fx.write("plain.txt", b"visible\n");
    for p in [
        ".env",
        ".env.production",
        "id_rsa",
        "keys/server.pem",
        "deploy.key",
        ".ssh/config",
        ".aws/credentials",
        "credentials.json",
        ".npmrc",
        ".git/config",
    ] {
        let r = fx.run("fs.read", json!({"path": p}));
        assert_eq!(err_code(&r), "sensitive-path-refused", "{p}");
    }
    for p in [".hidden", "config/.secret"] {
        let r = fx.run("fs.read", json!({"path": p}));
        assert_eq!(err_code(&r), "hidden-path-refused", "{p}");
    }
    // Allowlisted dotfiles remain readable.
    assert_eq!(
        err_code(&fx.run("fs.read", json!({"path": ".gitignore"}))),
        "ok"
    );
    assert_eq!(
        err_code(&fx.run("fs.read", json!({"path": ".env.example"}))),
        "ok"
    );
    // Search and list do not surface them.
    let s = fx.run("fs.search", json!({"query": marker})).unwrap();
    assert!(s.result.output.as_ref().unwrap()["matches"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(s.result.stats.skipped_sensitive >= 5);
    let l = fx.run("fs.list", json!({})).unwrap();
    let names: Vec<_> = l.result.output.as_ref().unwrap()["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(!names.contains(&".env".to_owned()));
    assert!(!names.contains(&"id_rsa".to_owned()));
    assert!(names.contains(&".gitignore".to_owned()));
    assert!(names.contains(&"plain.txt".to_owned()));
}

#[test]
fn fifo_socket_and_special_files_are_refused_without_blocking() {
    use std::os::unix::net::UnixListener;
    let mut fx = fixture("special");
    let fifo = std::ffi::CString::new(fx.ws.join("pipe").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc_mkfifo(fifo.as_ptr()) }, 0);
    let _sock = UnixListener::bind(fx.ws.join("sock")).unwrap();
    fx.write("plain.txt", b"needle\n");
    let started = std::time::Instant::now();
    for p in ["pipe", "sock"] {
        let r = fx.run("fs.read", json!({"path": p}));
        assert_eq!(err_code(&r), "special-file-refused", "{p}");
    }
    let s = fx.run("fs.search", json!({"query": "needle"})).unwrap();
    assert_eq!(s.result.stats.skipped_special, 2);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "blocked on FIFO"
    );
    let l = fx.run("fs.list", json!({})).unwrap();
    let kinds: Vec<_> = l.result.output.as_ref().unwrap()["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| ["pipe", "sock"].contains(&e["name"].as_str().unwrap()))
        .map(|e| e["kind"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(kinds, vec!["special", "special"]);
}

extern "C" {
    #[link_name = "mkfifo"]
    fn libc_mkfifo(path: *const std::os::raw::c_char) -> i32;
}

#[test]
fn recursive_search_exhaustion_is_bounded() {
    let mut fx = fixture("exhaust");
    // Deep nest beyond max depth.
    let mut deep = String::new();
    for i in 0..40 {
        deep.push_str(&format!("d{i}/"));
    }
    fx.write(&format!("{deep}leaf.txt"), b"needle deep\n");
    // Wide tree beyond max files.
    for i in 0..120 {
        fx.write(&format!("wide/f{i:03}.txt"), b"nothing\n");
    }
    // Directory cycle through symlink.
    symlink(std::path::Path::new("."), &fx.ws.join("cycle"));
    let mut r = fx.request("fs.search", json!({"query": "needle"}));
    r.budgets.max_files = 50;
    r.budgets.max_depth = 8;
    let o = fx.run_request(r).unwrap();
    assert!(o.result.truncation.truncated);
    assert!(o.result.stats.files_scanned <= 50);
    assert!(o.result.stats.dirs_visited <= 500);
    let reasons = &o.result.truncation.reasons;
    assert!(
        reasons.iter().any(|x| x == "max-files" || x == "max-depth"),
        "{reasons:?}"
    );
    // A tight dirs budget also stops traversal.
    let mut r = fx.request("fs.search", json!({"query": "needle"}));
    r.budgets.max_dirs = 3;
    let o = fx.run_request(r).unwrap();
    assert!(o.result.stats.dirs_visited <= 3);
    assert!(o.result.truncation.reasons.iter().any(|x| x == "max-dirs"));
}

#[test]
fn output_is_truncated_not_unbounded() {
    let mut fx = fixture("trunc");
    let mut big = String::new();
    for i in 0..5000 {
        big.push_str(&format!("needle line number {i}\n"));
    }
    fx.write("big.txt", big.as_bytes());
    let mut r = fx.request("fs.read", json!({"path": "big.txt"}));
    r.budgets.max_output_bytes = 1000;
    let o = fx.run_request(r).unwrap();
    let content = o.result.output.as_ref().unwrap()["content"]
        .as_str()
        .unwrap()
        .len();
    assert!(content <= 1000);
    assert!(o.result.truncation.truncated);
    assert!(o.result.output.as_ref().unwrap()["nextLine"].is_number());
    let mut r = fx.request("fs.search", json!({"query": "needle", "maxMatches": 7}));
    r.budgets.max_output_bytes = 1024 * 1024;
    let o = fx.run_request(r).unwrap();
    assert_eq!(o.result.stats.matches_returned, 7);
    assert!(o
        .result
        .truncation
        .reasons
        .contains(&"max-matches".to_owned()));
}

#[test]
fn long_lines_are_clipped_on_char_boundaries() {
    let mut fx = fixture("clip");
    fx.write("long.txt", "é".repeat(5000).as_bytes());
    let mut r = fx.request("fs.read", json!({"path": "long.txt"}));
    r.budgets.max_line_bytes = 101; // odd: must back off to a boundary
    let o = fx.run_request(r).unwrap();
    let c = o.result.output.as_ref().unwrap()["content"]
        .as_str()
        .unwrap();
    let body = c
        .trim_end()
        .strip_suffix("[TRUNCATED:nexus]")
        .expect("inline marker");
    assert_eq!(body.trim_end().chars().count(), 50);
    assert!(o
        .result
        .truncation
        .reasons
        .contains(&"line-truncated".to_owned()));
}

// ----------------------------------------------- journal & records

#[test]
fn journal_is_redacted_chained_and_tamper_evident() {
    let mut fx = fixture("journal");
    fx.write("a.txt", b"FILE-BODY-SECRET-123\nTOKEN=abc\n");
    fx.run("fs.read", json!({"path": "a.txt"})).unwrap();
    fx.run("fs.search", json!({"query": "FILE-BODY-SECRET-123"}))
        .unwrap();
    fx.run("fs.read", json!({"path": ".env"})).unwrap(); // refused, still journaled
    let all = fx.kernel.list_tool_journal(Some(&fx.task)).unwrap();
    assert_eq!(all.len(), 9);
    let dump = serde_json::to_string(&all.iter().map(|e| &e.payload).collect::<Vec<_>>()).unwrap();
    assert!(
        !dump.contains("FILE-BODY-SECRET-123"),
        "content or query leaked into journal"
    );
    assert!(!dump.contains("TOKEN=abc"));
    assert_eq!(fx.kernel.verify_tool_journal().unwrap(), 9);
    // Identity linkage on every row.
    for e in &all {
        assert_eq!(e.task_instance_id, fx.task);
        assert_eq!(e.attempt_id, fx.attempt);
        assert_eq!(e.command_id, fx.command);
    }
    // Provenance: refusals are distinguishable from success.
    let last = all.last().unwrap();
    assert_eq!(last.payload["resultStatus"], "error");
    assert_eq!(last.payload["errorCode"], "sensitive-path-refused");
    assert_eq!(last.payload["provenance"]["aiInitiated"], false);

    // Tamper with a completed payload directly in SQLite.
    let db = fx.db.clone();
    drop(fx.kernel);
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute(
        "UPDATE tool_journal SET payload_json = replace(payload_json, 'error', 'ok__') WHERE seq = (SELECT MAX(seq) FROM tool_journal)",
        [],
    )
    .unwrap();
    drop(conn);
    let mut k = Kernel::open(&db, Some(&fx.witness)).unwrap();
    let e = k.verify_tool_journal().unwrap_err();
    assert_eq!(e.code.as_str(), "store-corrupt");
}

#[test]
fn deleting_a_mid_chain_row_is_detected() {
    let mut fx = fixture("journal-del");
    fx.write("a.txt", b"x\n");
    fx.run("fs.read", json!({"path": "a.txt"})).unwrap();
    fx.run("fs.read", json!({"path": "a.txt"})).unwrap();
    let db = fx.db.clone();
    drop(fx.kernel);
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute("DELETE FROM tool_journal WHERE seq = 2", [])
        .unwrap();
    drop(conn);
    let mut k = Kernel::open(&db, Some(&fx.witness)).unwrap();
    assert_eq!(
        k.verify_tool_journal().unwrap_err().code.as_str(),
        "store-corrupt"
    );
}

#[test]
fn events_distinguish_authorized_started_completed_failed() {
    let mut fx = fixture("events");
    fx.write("a.txt", b"x\n");
    let (call, _c) = fx.authorized("fs.read", json!({"path": "a.txt"})); // authorized only
    let _ = call;
    fx.run("fs.read", json!({"path": "a.txt"})).unwrap();
    fx.run("fs.read", json!({"path": "missing.txt"})).unwrap();
    let ev = tool_events_from_journal(&fx.kernel.list_tool_journal(None).unwrap());
    let st: Vec<_> = ev.iter().map(|e| e.status).collect();
    assert_eq!(
        st,
        vec![
            ToolEventStatus::Authorized,
            ToolEventStatus::Completed,
            ToolEventStatus::Failed
        ]
    );
    assert!(ev.iter().all(|e| !e.ai_initiated));
    assert_eq!(ev[2].error_code.as_deref(), Some("not-found"));
}

#[test]
fn concurrent_kernels_journal_exactly_once_and_stay_chained() {
    let fx = fixture("conc");
    std::fs::write(fx.ws.join("a.txt"), "needle\n").unwrap();
    let db = fx.db.clone();
    let witness = fx.witness.clone();
    let (task, attempt, command, epoch, inc) = (
        fx.task.clone(),
        fx.attempt.clone(),
        fx.command.clone(),
        fx.epoch,
        fx.incarnation.clone(),
    );
    drop(fx.kernel);
    let mut handles = Vec::new();
    for n in 0..8 {
        let (db, witness, task, attempt, command, inc) = (
            db.clone(),
            witness.clone(),
            task.clone(),
            attempt.clone(),
            command.clone(),
            inc.clone(),
        );
        handles.push(std::thread::spawn(move || {
            let mut k = Kernel::open(&db, Some(&witness)).unwrap();
            let mut oks = 0;
            for i in 0..5 {
                let req = nexus_tools::ToolRequestV1 {
                    schema_version: 1,
                    request_id: format!("conc-{n}-{i}"),
                    cancellation_id: format!("cc-{n}-{i}"),
                    task_instance_id: task.clone(),
                    attempt_id: attempt.clone(),
                    command_id: command.clone(),
                    lease_epoch: epoch,
                    store_incarnation: inc.clone(),
                    tool_id: "fs.search".into(),
                    tool_version: 1,
                    args: json!({"query": "needle"}),
                    budgets: ToolBudgets::default(),
                };
                let c = CancellationToken::new(&req.cancellation_id);
                let call = authorize(&mut k, prepare_b(req).unwrap()).unwrap();
                let o = execute(&mut k, &call, &c).unwrap();
                assert_eq!(o.result.stats.matches_returned, 1);
                oks += 1;
            }
            oks
        }));
    }
    let total: i32 = handles.into_iter().map(|h| h.join().unwrap()).sum();
    assert_eq!(total, 40);
    let mut k = Kernel::open(&db, Some(&witness)).unwrap();
    assert_eq!(k.verify_tool_journal().unwrap(), 40 * 3);
}

#[test]
fn concurrent_duplicate_authorization_has_exactly_one_winner() {
    let fx = fixture("dupwin");
    std::fs::write(fx.ws.join("a.txt"), "x\n").unwrap();
    let (db, witness) = (fx.db.clone(), fx.witness.clone());
    let mk = move || nexus_tools::ToolRequestV1 {
        schema_version: 1,
        request_id: "same-request".into(),
        cancellation_id: "c".into(),
        task_instance_id: fx.task.clone(),
        attempt_id: fx.attempt.clone(),
        command_id: fx.command.clone(),
        lease_epoch: fx.epoch,
        store_incarnation: fx.incarnation.clone(),
        tool_id: "fs.read".into(),
        tool_version: 1,
        args: json!({"path": "a.txt"}),
        budgets: ToolBudgets::default(),
    };
    drop(fx.kernel);
    let mut hs = Vec::new();
    for _ in 0..6 {
        let (db, witness, req) = (db.clone(), witness.clone(), mk());
        hs.push(std::thread::spawn(move || {
            let mut k = Kernel::open(&db, Some(&witness)).unwrap();
            authorize(&mut k, prepare_b(req).unwrap()).is_ok()
        }));
    }
    let winners = hs
        .into_iter()
        .map(|h| h.join().unwrap())
        .filter(|w| *w)
        .count();
    assert_eq!(winners, 1);
}
