//! A3.4 process lifecycle through the real Kernel + real sandbox.
//! Tests print `NOT RUN` and return when the host lacks the sandbox.

mod common;

use common::*;
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute, execute_process, CancellationToken};
use serde_json::json;
use std::time::Duration;

const PY: &str = "/usr/bin/python3";

fn sandbox_ok(t: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available || !std::path::Path::new(PY).exists() {
        println!("NOT RUN ({t}): sandbox unavailable: {:?}", c.problems);
        return false;
    }
    true
}

fn test_policy() -> CommandPolicy {
    CommandPolicy::offline_test(Toolchain::discover(), &[PY, "/usr/bin/sleep"])
}

fn run_dir(fx: &Fx) -> std::path::PathBuf {
    fx.dir.path().join("exec")
}

fn run_proc(
    fx: &mut Fx,
    program: &str,
    args: &[&str],
    tweak: impl FnOnce(&mut nexus_tools::ToolRequestV1),
) -> Result<nexus_tools::ToolExecutionOutcome, nexus_tools::ToolError> {
    let mut r = fx.request(
        "proc.run",
        json!({"program": program, "args": args, "cwd": "."}),
    );
    tweak(&mut r);
    let cancel = CancellationToken::new(&r.cancellation_id);
    let policy = test_policy();
    let p = fx.prepare_p(r, &policy)?;
    let call = authorize(&mut fx.kernel, p)?;
    let run = run_dir(fx);
    execute_process(&mut fx.kernel, &call, &cancel, &policy, &run, 600_000)
}

fn seed_workspace(fx: &Fx) {
    fx.write("src/main.rs", b"fn main() {}\n");
    fx.write("README.md", b"# demo\n");
    fx.write(".env", b"TOKEN=verysecret\n");
    fx.write("id_rsa", b"PRIVATE\n");
    fx.write(".git/config", b"[core]\n");
    fx.write("node_modules/x/index.js", b"//\n");
    fx.write("target/debug/artifact", b"bin\n");
    let _ = std::os::unix::fs::symlink(fx.outside.join("secret.txt"), fx.ws.join("link.txt"));
    let _ = std::fs::hard_link(fx.outside.join("secret.txt"), fx.ws.join("hl.txt"));
}

#[test]
fn sandboxed_process_sees_only_the_policy_filtered_snapshot_and_records_the_lifecycle() {
    if !sandbox_ok("proc-lifecycle") {
        return;
    }
    let mut fx = fixture("p-life");
    fx.approve_process(60_000);
    seed_workspace(&fx);
    let code = r#"
import os, json
files = []
for root, dirs, fs in os.walk("/work/src"):
    for f in fs: files.append(os.path.relpath(os.path.join(root, f), "/work/src"))
print(json.dumps(sorted(files)))
print("api_token = \"hunter2hunter2hunter2\"")
"#;
    let o = run_proc(&mut fx, PY, &["-c", code], |_| {}).expect("run");
    assert!(o.result.error.is_none(), "{:?}", o.result.error);
    let out = o.result.output.as_ref().unwrap();
    assert_eq!(out["verification"], "pass");
    assert_eq!(out["exitCode"], 0);
    assert_eq!(out["network"], "none");
    assert_eq!(out["writeBack"], "none");
    let stdout = out["stdout"].as_str().unwrap();
    let first = stdout.lines().next().unwrap();
    let files: Vec<String> = serde_json::from_str(first).unwrap();
    assert_eq!(files, vec!["README.md", "src/main.rs"], "{files:?}");
    // Output redaction applies before presentation and persistence.
    assert!(!stdout.contains("hunter2hunter2hunter2"));
    assert!(o.result.redaction.redacted);
    // Lifecycle journal.
    let phases = fx.journal_phases();
    assert_eq!(
        phases,
        vec!["authorized", "started", "prepared", "running", "exited"]
    );
    let entries = fx.kernel.list_tool_journal(None).unwrap();
    let dump =
        serde_json::to_string(&entries.iter().map(|e| &e.payload).collect::<Vec<_>>()).unwrap();
    assert!(!dump.contains("hunter2hunter2hunter2"), "secret persisted");
    assert!(!dump.contains("verysecret"));
    let prepared = entries.iter().find(|e| e.phase == "prepared").unwrap();
    assert_eq!(prepared.payload["snapshotFiles"], 2);
    assert!(prepared.payload["snapshotDigest"].as_str().unwrap().len() == 64);
    assert!(prepared.payload["sandboxDigest"].as_str().unwrap().len() == 64);
    assert_eq!(prepared.payload["sandbox"]["network"], "none");
    assert!(
        prepared.payload["snapshotSkipped"]["sensitive"]
            .as_u64()
            .unwrap()
            >= 2
    );
    // Real project untouched; no artifacts published back; run dir gone.
    assert_eq!(fx.disk("src/main.rs").unwrap(), "fn main() {}\n");
    assert!(!fx.ws.join("target/debug/new").exists());
    assert!(!run_dir(&fx).join("nexus-exec-x").exists());
    assert_eq!(
        std::fs::read_dir(run_dir(&fx))
            .map(|d| d.count())
            .unwrap_or(0),
        0
    );
    assert_eq!(
        fx.kernel.verify_tool_journal().unwrap() as usize,
        phases.len()
    );
}

#[test]
fn command_policy_refuses_shells_substitution_and_unlisted_programs() {
    let mut fx = fixture("p-policy");
    fx.approve_process(60_000);
    let std_policy = CommandPolicy::standard(Toolchain::discover());
    let cases: Vec<(&str, Vec<&str>)> = vec![
        ("sh", vec!["-c", "id"]),
        ("/bin/sh", vec!["-c", "id"]),
        ("bash", vec![]),
        ("python3", vec!["-c", "pass"]),
        ("/usr/bin/python3", vec!["-c", "import os"]),
        ("cargo", vec!["install", "evil"]),
        (
            "cargo",
            vec!["check", "--offline", "--config", "build.rustc='sh'"],
        ),
        ("cargo", vec!["run", "--offline"]),
        (
            "cargo",
            vec!["check", "--offline", "--manifest-path", "/etc/x"],
        ),
        ("cargo", vec!["check", "--offline", "-p", "a;rm -rf /"]),
        ("cargo", vec!["check"]),
        ("npm", vec!["install"]),
        ("npm", vec!["run", "postinstall"]),
        ("npm", vec!["exec", "evil"]),
        ("npm", vec!["test", "--", "--eval=1"]),
        ("tsc", vec!["--outDir", "/etc"]),
        ("tsc", vec![]),
        ("make", vec![]),
        ("curl", vec!["http://example.com"]),
    ];
    for (prog, args) in cases {
        let r = fx.request("proc.run", json!({"program": prog, "args": args}));
        let b = fx.binding();
        let sc = fx.pscope();
        let e = nexus_tools::prepare_process(r, &b, &sc, &std_policy).unwrap_err();
        assert_eq!(e.code.as_str(), "command-refused", "{prog} {args:?}: {e}");
    }
    assert!(fx.journal_phases().is_empty(), "refusals mint no grant");
    // cwd traversal
    let r = fx.request(
        "proc.run",
        json!({"program": "cargo", "args": ["check", "--offline"], "cwd": "../x"}),
    );
    let b = fx.binding();
    let sc = fx.pscope();
    assert!(nexus_tools::prepare_process(r, &b, &sc, &std_policy).is_err());
    // Unknown JSON members never smuggle a shell string / env / mounts.
    for extra in ["shell", "env", "mounts", "network", "script"] {
        let mut a = json!({"program": "cargo", "args": ["check", "--offline"]});
        a[extra] = json!("x");
        let r = fx.request("proc.run", a);
        assert!(
            nexus_tools::prepare_process(r, &b, &sc, &std_policy).is_err(),
            "{extra}"
        );
    }
}

#[test]
fn read_and_write_grants_cannot_start_a_process_and_scopes_do_not_cross() {
    let mut fx = fixture("p-escalate");
    fx.write("a.txt", b"x\n");
    let std_policy = CommandPolicy::standard(Toolchain::discover());
    let proc_req = |fx: &mut Fx| {
        fx.request(
            "proc.run",
            json!({"program": "cargo", "args": ["check", "--offline"]}),
        )
    };
    // No process scope: preparation through the read path is refused, and
    // the Kernel refuses to seal without an independent scope.
    let r = proc_req(&mut fx);
    assert_eq!(
        prepare_b(r.clone()).unwrap_err().code.as_str(),
        "authorization-refused"
    );
    // A write scope is not a process scope.
    fx.approve_write(1 << 20);
    let b = fx.binding();
    let forged = nexus_kernel::ProcessScopeBinding {
        command_id: fx.command.clone(),
        task_instance_id: fx.task.clone(),
        attempt_id: fx.attempt.clone(),
        lease_epoch: fx.epoch,
        store_incarnation: fx.incarnation.clone(),
        root_digest: b.root_digest.clone(),
        max_wall_ms: 60_000,
        approver_id: "attacker".into(),
        independent: true,
        fs_scope: "scratch".into(),
        grant_id: String::new(),
        grant_version: 0,
        grant_digest: String::new(),
        net_scope: String::new(),
        approval: String::new(),
    };
    if std_policy
        .resolve(&nexus_tools::ProcessArgs {
            program: "cargo".into(),
            args: vec!["check".into(), "--offline".into()],
            cwd: ".".into(),
        })
        .is_ok()
    {
        let p = nexus_tools::prepare_process(proc_req(&mut fx), &b, &forged, &std_policy).unwrap();
        let e = authorize(&mut fx.kernel, p).unwrap_err();
        assert!(e.message.contains("no independent process scope"), "{e}");
    }
    // A genuine process scope does not authorize writes (and vice versa).
    fx.approve_process(60_000);
    let r = fx.request(
        "fs.write",
        json!({"path": "n.txt", "content": "x", "mode": "create"}),
    );
    let p = fx.prepare_w(r).unwrap();
    let c = authorize(&mut fx.kernel, p);
    assert!(c.is_ok()); // write scope exists: this is the write path, unrelated to process
                        // A read grant paired with a process-prepared call is refused.
    let (read_call, cancel) = fx.authorized("fs.read", json!({"path": "a.txt"}));
    let policy = test_policy();
    let r = fx.request("proc.run", json!({"program": PY, "args": ["-c", "pass"]}));
    let pp = fx.prepare_p(r, &policy).unwrap();
    let mixed = nexus_tools::AuthorizedToolCall::from_parts(pp, read_call.grant().clone());
    let run = run_dir(&fx);
    assert!(execute_process(&mut fx.kernel, &mixed, &cancel, &policy, &run, 1000).is_err());
    // A process grant cannot be run by the read executor.
    let r = fx.request("proc.run", json!({"program": PY, "args": ["-c", "pass"]}));
    let c2 = CancellationToken::new(&r.cancellation_id);
    let pp = fx.prepare_p(r, &policy).unwrap();
    let call = authorize(&mut fx.kernel, pp).unwrap();
    let res = execute(&mut fx.kernel, &call, &c2).unwrap();
    assert_eq!(
        res.result.error.as_ref().unwrap().code.as_str(),
        "unsupported-tool"
    );
}

#[test]
fn forged_altered_replayed_and_stale_process_grants_are_refused() {
    if !sandbox_ok("proc-forge") {
        return;
    }
    let mut fx = fixture("p-forge");
    fx.approve_process(60_000);
    let policy = test_policy();
    let mk = |fx: &mut Fx, code: &str| {
        let r = fx.request("proc.run", json!({"program": PY, "args": ["-c", code]}));
        let c = CancellationToken::new(&r.cancellation_id);
        let p = fx.prepare_p(r, &policy).unwrap();
        (authorize(&mut fx.kernel, p).unwrap(), c)
    };
    let run = run_dir(&fx);
    // Altered arguments after authorization.
    let (call, c) = mk(&mut fx, "print(1)");
    let mut r2 = call.prepared().request().clone();
    r2.args = json!({"program": PY, "args": ["-c", "print(2)"]});
    let swapped = nexus_tools::AuthorizedToolCall::from_parts(
        fx.prepare_p(r2, &policy).unwrap(),
        call.grant().clone(),
    );
    let e = execute_process(&mut fx.kernel, &swapped, &c, &policy, &run, 60_000).unwrap_err();
    assert!(e.message.contains("binding-mismatch"), "{e}");
    // Tampered grant fields.
    let (call, c) = mk(&mut fx, "print(1)");
    let mut g = call.grant().clone();
    g.scope = "read".into();
    let forged = nexus_tools::AuthorizedToolCall::from_parts(
        fx.prepare_p(call.prepared().request().clone(), &policy)
            .unwrap(),
        g,
    );
    assert!(execute_process(&mut fx.kernel, &forged, &c, &policy, &run, 60_000).is_err());
    // Replay.
    let (call, c) = mk(&mut fx, "print(1)");
    execute_process(&mut fx.kernel, &call, &c, &policy, &run, 60_000).unwrap();
    let again = execute_process(&mut fx.kernel, &call, &c, &policy, &run, 60_000).unwrap_err();
    assert!(again.message.contains("command-conflict"), "{again}");
    // Stale generation.
    let (call, c) = mk(&mut fx, "print(1)");
    fx.kernel
        .acquire_generation(&fx.task.clone(), "native")
        .unwrap();
    let e = execute_process(&mut fx.kernel, &call, &c, &policy, &run, 60_000).unwrap_err();
    assert!(e.message.contains("stale-lease"), "{e}");
    // Nothing ran for any refused request.
    let started = fx
        .journal_phases()
        .iter()
        .filter(|p| *p == "running")
        .count();
    assert_eq!(started, 1);
}

#[test]
fn timeout_budget_and_scope_cap_are_enforced() {
    if !sandbox_ok("proc-timeout") {
        return;
    }
    let mut fx = fixture("p-timeout");
    fx.approve_process(1_500); // approver caps wall time at 1.5 s
    let t = std::time::Instant::now();
    let o = run_proc(&mut fx, "/usr/bin/sleep", &["60"], |r| {
        r.budgets.proc_wall_ms = 600_000; // request more: clamped by scope
    })
    .unwrap();
    assert!(t.elapsed() < Duration::from_secs(15));
    let out = o.result.output.as_ref().unwrap();
    assert_eq!(out["reason"], "timeout");
    assert_eq!(out["verification"], "fail");
    let last = fx.kernel.list_tool_journal(None).unwrap().pop().unwrap();
    assert_eq!(last.phase, "exited");
    assert_eq!(last.payload["reason"], "timeout");
}

#[test]
fn revocation_and_token_cancellation_stop_the_process_tree_and_are_journaled() {
    if !sandbox_ok("proc-cancel") {
        return;
    }
    let mut fx = fixture("p-cancel");
    fx.approve_process(60_000);
    let (db, wit, cmd) = (fx.db.clone(), fx.witness.clone(), fx.command.clone());
    let policy = test_policy();
    // 1. authoritative revocation from another kernel handle mid-run
    let r = fx.request(
        "proc.run",
        json!({"program": "/usr/bin/sleep", "args": ["120"]}),
    );
    let c = CancellationToken::new(&r.cancellation_id);
    let p = fx.prepare_p(r, &policy).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        let mut k = nexus_kernel::Kernel::open(&db, Some(&wit)).unwrap();
        k.revoke_tools(&cmd, "test-revoke").unwrap();
    });
    let run = run_dir(&fx);
    let started = std::time::Instant::now();
    let o = execute_process(&mut fx.kernel, &call, &c, &policy, &run, 600_000).unwrap();
    t.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(20));
    let last = fx.kernel.list_tool_journal(None).unwrap().pop().unwrap();
    assert_eq!(last.phase, "cancelled", "{:?}", o.result.output);
    assert_eq!(last.payload["reason"], "revoked");
    assert_eq!(last.payload["processStarted"], true);
    // 2. caller token
    let mut fx = fixture("p-cancel2");
    fx.approve_process(60_000);
    let r = fx.request(
        "proc.run",
        json!({"program": "/usr/bin/sleep", "args": ["120"]}),
    );
    let c = CancellationToken::new(&r.cancellation_id);
    let c2 = c.clone();
    let p = fx.prepare_p(r, &policy).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        c2.cancel();
    });
    let run = run_dir(&fx);
    execute_process(&mut fx.kernel, &call, &c, &policy, &run, 600_000).unwrap();
    t.join().unwrap();
    let last = fx.kernel.list_tool_journal(None).unwrap().pop().unwrap();
    assert_eq!(last.phase, "cancelled");
    assert_eq!(last.payload["reason"], "cancelled");
}

#[test]
fn snapshot_aborts_when_the_workspace_changes_during_staging() {
    use nexus_tools::stage::{stage_workspace, StageLimits};
    let fx = fixture("p-snap");
    for i in 0..200 {
        fx.write(&format!("d/f{i:03}.txt"), b"stable\n");
    }
    let ws = nexus_tools::Workspace::open_root(
        fx.ws.to_str().unwrap(),
        nexus_tools::WorkspacePolicy::default(),
    )
    .unwrap();
    let victim = fx.ws.join("d/f199.txt");
    let mut calls = 0;
    let dest = fx.dir.path().join("snap");
    let mut probe = || {
        calls += 1;
        // After the directory listing was taken, change a file that has
        // not been copied yet.
        if calls == 4 {
            std::fs::write(&victim, "stable\nCHANGED UNDER THE SNAPSHOT\n").unwrap();
        }
        Ok(())
    };
    let r = stage_workspace(&ws, &dest, &StageLimits::default(), &mut probe, &mut |_| {});
    let e = r.unwrap_err();
    assert_eq!(e.code.as_str(), "snapshot-failed");
    assert!(e.message.contains("changed during snapshot"), "{e}");
    // A quiet workspace produces a stable, reproducible digest.
    std::fs::write(&victim, "stable\n").unwrap();
    let d1 = stage_workspace(
        &ws,
        &fx.dir.path().join("s1"),
        &StageLimits::default(),
        &mut || Ok(()),
        &mut |_| {},
    )
    .unwrap();
    let d2 = stage_workspace(
        &ws,
        &fx.dir.path().join("s2"),
        &StageLimits::default(),
        &mut || Ok(()),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(d1.digest, d2.digest);
    assert_eq!(d1.files, 200, "{d1:?}");
    // Limits are enforced.
    let lim = StageLimits {
        max_files: 10,
        ..Default::default()
    };
    let e = stage_workspace(
        &ws,
        &fx.dir.path().join("s3"),
        &lim,
        &mut || Ok(()),
        &mut |_| {},
    )
    .unwrap_err();
    assert!(e.message.contains("file-count"), "{e}");
}

#[test]
fn concurrent_executions_are_isolated_and_all_recorded() {
    if !sandbox_ok("proc-concurrent") {
        return;
    }
    let mut fx = fixture("p-conc");
    fx.approve_process(60_000);
    fx.write("a.txt", b"x\n");
    let (db, wit) = (fx.db.clone(), fx.witness.clone());
    let b = fx.binding();
    let sc = fx.pscope();
    let (task, attempt, command, epoch, inc) = (
        fx.task.clone(),
        fx.attempt.clone(),
        fx.command.clone(),
        fx.epoch,
        fx.incarnation.clone(),
    );
    let run = run_dir(&fx);
    drop(fx.kernel);
    let mut hs = Vec::new();
    for i in 0..4 {
        let (db, wit, b, sc, task, attempt, command, inc, run) = (
            db.clone(),
            wit.clone(),
            b.clone(),
            sc.clone(),
            task.clone(),
            attempt.clone(),
            command.clone(),
            inc.clone(),
            run.clone(),
        );
        hs.push(std::thread::spawn(move || {
            let mut k = nexus_kernel::Kernel::open(&db, Some(&wit)).unwrap();
            let req = nexus_tools::ToolRequestV1 {
                schema_version: 1,
                request_id: format!("pc-{i}"),
                cancellation_id: format!("pcc-{i}"),
                task_instance_id: task,
                attempt_id: attempt,
                command_id: command,
                lease_epoch: epoch,
                store_incarnation: inc,
                tool_id: "proc.run".into(),
                tool_version: 1,
                args: json!({"program": PY, "args": ["-c", format!("open('/tmp/m','w').write('{i}'); print(open('/tmp/m').read())")]}),
                budgets: nexus_tools::ToolBudgets::default(),
            };
            let c = CancellationToken::new(&req.cancellation_id);
            let policy = test_policy();
            let p = nexus_tools::prepare_process(req, &b, &sc, &policy).unwrap();
            let call = authorize(&mut k, p).unwrap();
            let o = execute_process(&mut k, &call, &c, &policy, &run, 60_000).unwrap();
            o.result.output.unwrap()["stdout"].as_str().unwrap().trim().to_owned()
        }));
    }
    let mut outs: Vec<String> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    outs.sort();
    assert_eq!(outs, vec!["0", "1", "2", "3"]);
    let mut k = nexus_kernel::Kernel::open(&db, Some(&wit)).unwrap();
    assert_eq!(k.verify_tool_journal().unwrap(), 4 * 5);
}

#[test]
fn cargo_workflow_runs_offline_and_reports_missing_dependencies_honestly() {
    if !sandbox_ok("proc-cargo") {
        return;
    }
    let tc = Toolchain::discover();
    if tc.cargo_home_bin.is_none() || tc.rustup_home.is_none() {
        println!("NOT RUN (proc-cargo): no cargo toolchain discovered");
        return;
    }
    let policy = CommandPolicy::standard(tc);
    let mut fx = fixture("p-cargo");
    fx.approve_process(300_000);
    fx.write(
        "Cargo.toml",
        b"[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    );
    fx.write("src/main.rs", b"fn main() { println!(\"hi\"); }\n");
    // The snapshot is read-only, so cargo needs an existing lockfile and
    // `--locked` (it can never write Cargo.lock into the immutable input).
    fx.write(
        "Cargo.lock",
        b"# This file is automatically @generated by Cargo.\nversion = 3\n\n[[package]]\nname = \"demo\"\nversion = \"0.1.0\"\n",
    );
    let run = |fx: &mut Fx, args: Vec<&str>| {
        let r = fx.request("proc.run", json!({"program": "cargo", "args": args}));
        let c = CancellationToken::new(&r.cancellation_id);
        let p = fx.prepare_p(r, &policy).unwrap();
        let call = authorize(&mut fx.kernel, p).unwrap();
        let rd = run_dir(fx);
        execute_process(&mut fx.kernel, &call, &c, &policy, &rd, 300_000).unwrap()
    };
    let o = run(&mut fx, vec!["check", "--offline", "--locked"]);
    let out = o.result.output.as_ref().unwrap();
    assert_eq!(
        out["verification"], "pass",
        "cargo check failed inside the sandbox: {}",
        out["stderr"]
    );
    // The real project must have no target dir after the run.
    assert!(
        !fx.ws.join("target").exists(),
        "artifacts leaked into the project"
    );
    // A dependency cannot be fetched: honest failure, still offline.
    fx.write(
        "Cargo.toml",
        b"[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[dependencies]\nserde = \"1\"\n",
    );
    let o = run(&mut fx, vec!["check", "--offline", "--locked"]);
    let out = o.result.output.as_ref().unwrap();
    assert_eq!(out["verification"], "fail");
    assert_eq!(out["network"], "none");
}

// ============ A3.4 audit: snapshot consistency ===========================

fn set_times_ns(path: &std::path::Path, atime: (i64, i64), mtime: (i64, i64)) {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    let ts = [
        libc::timespec {
            tv_sec: atime.0,
            tv_nsec: atime.1,
        },
        libc::timespec {
            tv_sec: mtime.0,
            tv_nsec: mtime.1,
        },
    ];
    assert_eq!(
        unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), ts.as_ptr(), 0) },
        0
    );
}

fn pwrite_same_size(path: &std::path::Path, byte: u8) {
    use std::os::unix::fs::FileExt;
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    let len = f.metadata().unwrap().len() as usize;
    f.write_at(&vec![byte; len], 0).unwrap();
}

#[test]
fn same_size_in_place_modification_with_restored_mtime_is_detected() {
    use nexus_tools::stage::{stage_workspace, StageLimits};
    use std::os::unix::fs::MetadataExt;
    let fx = fixture("p-snap-inplace");
    fx.write("a.txt", b"AAAAAAAAAAAAAAAA\n");
    fx.write("b.txt", b"BBBBBBBBBBBBBBBB\n");
    let ws = nexus_tools::Workspace::open_root(
        fx.ws.to_str().unwrap(),
        nexus_tools::WorkspacePolicy::default(),
    )
    .unwrap();
    let b = fx.ws.join("b.txt");
    let md = std::fs::metadata(&b).unwrap();
    let (ino, size) = (md.ino(), md.len());
    let (mt, mtn) = (md.mtime(), md.mtime_nsec());
    // (1) Modified after the directory listing, same inode, same size,
    // mtime restored: only ctime / content can reveal it.
    let mut n = 0;
    let victim = b.clone();
    let mut probe = || {
        n += 1;
        Ok(())
    };
    let mut hit = false;
    let mut observe = |rel: &str| {
        // First time a.txt finishes pass 1, rewrite b.txt in place.
        if rel == "a.txt" && !hit {
            hit = true;
            pwrite_same_size(&victim, b'Z');
            set_times_ns(&victim, (mt, mtn), (mt, mtn));
        }
    };
    let e = stage_workspace(
        &ws,
        &fx.dir.path().join("snap1"),
        &StageLimits::default(),
        &mut probe,
        &mut observe,
    )
    .unwrap_err();
    assert_eq!(e.code.as_str(), "snapshot-failed", "{e}");
    let after = std::fs::metadata(&b).unwrap();
    assert_eq!(
        (after.ino(), after.len()),
        (ino, size),
        "same inode and size by construction"
    );

    // (2) Torn read: a file is rewritten in place between the two read
    // passes of THAT file, mtime restored. Pass 2 must differ from pass 1.
    std::fs::write(&b, "BBBBBBBBBBBBBBBB\n").unwrap();
    let md = std::fs::metadata(&b).unwrap();
    let (mt, mtn) = (md.mtime(), md.mtime_nsec());
    let victim = b.clone();
    let mut fired = false;
    let mut observe = |rel: &str| {
        if rel == "b.txt" && !fired {
            fired = true;
            pwrite_same_size(&victim, b'Y');
            set_times_ns(&victim, (mt, mtn), (mt, mtn));
        }
    };
    let e = stage_workspace(
        &ws,
        &fx.dir.path().join("snap2"),
        &StageLimits::default(),
        &mut || Ok(()),
        &mut observe,
    )
    .unwrap_err();
    assert_eq!(e.code.as_str(), "snapshot-failed");
    assert!(
        e.message.contains("content differs") || e.message.contains("metadata changed"),
        "{e}"
    );

    // (3) A quiet workspace is staged exactly and reproducibly.
    std::fs::write(&b, "BBBBBBBBBBBBBBBB\n").unwrap();
    let r = stage_workspace(
        &ws,
        &fx.dir.path().join("snap3"),
        &StageLimits::default(),
        &mut || Ok(()),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(r.files, 2);
    assert_eq!(
        std::fs::read_to_string(fx.dir.path().join("snap3/b.txt")).unwrap(),
        "BBBBBBBBBBBBBBBB\n"
    );
}

#[test]
fn cross_file_snapshot_is_not_atomic_and_is_documented_as_such() {
    // A writer that changes file A *after* it was staged and before B is
    // staged yields a snapshot that never existed as a whole. This is the
    // exact, documented guarantee: per-file consistency only.
    use nexus_tools::stage::{stage_workspace, StageLimits};
    let fx = fixture("p-snap-cross");
    fx.write("a.txt", b"A-v1\n");
    fx.write("b.txt", b"B-v1\n");
    let ws = nexus_tools::Workspace::open_root(
        fx.ws.to_str().unwrap(),
        nexus_tools::WorkspacePolicy::default(),
    )
    .unwrap();
    let (a, b) = (fx.ws.join("a.txt"), fx.ws.join("b.txt"));
    let mut done = false;
    let mut observe = |rel: &str| {
        if rel == "b.txt" && !done {
            done = true;
            // b is being staged; a was fully staged earlier: change a now,
            // and b's *next* version is not touched.
            std::fs::write(&a, "A-v2\n").unwrap();
            let _ = &b;
        }
    };
    let r = stage_workspace(
        &ws,
        &fx.dir.path().join("snap"),
        &StageLimits::default(),
        &mut || Ok(()),
        &mut observe,
    )
    .unwrap();
    assert_eq!(r.files, 2);
    // Snapshot holds A-v1 + B-v1 while the workspace now holds A-v2: the
    // staged set matches no single instant of the workspace after the edit.
    assert_eq!(
        std::fs::read_to_string(fx.dir.path().join("snap/a.txt")).unwrap(),
        "A-v1\n"
    );
    assert_eq!(
        std::fs::read_to_string(fx.ws.join("a.txt")).unwrap(),
        "A-v2\n"
    );
}
