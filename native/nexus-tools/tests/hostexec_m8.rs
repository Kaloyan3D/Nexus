//! M8 Full Access host backend: real host programs, real cwd, honest evidence.
//! These run unsandboxed by design, in disposable temp projects only.

use nexus_tools::authorization::GrantRef;
use nexus_tools::contract::{ProcessArgs, ToolBudgets};
use nexus_tools::exec::CancellationToken;
use nexus_tools::exec_contract::FsScope;
use nexus_tools::process::{run_process, CommandPolicy, ProcessContext, ProcessHooks, Toolchain};
use nexus_tools::result::{ToolError, ToolResultV1};
use nexus_tools::workspace::{Workspace, WorkspacePolicy};
use std::path::PathBuf;

struct Hooks;
impl ProcessHooks for Hooks {
    fn journal(&mut self, _phase: &str, _payload: serde_json::Value) -> Result<(), ToolError> {
        Ok(())
    }
    fn fence(&mut self) -> Result<(), ToolError> {
        Ok(())
    }
}

struct W {
    _t: tempfile::TempDir,
    root: PathBuf,
    outside: PathBuf,
    ws: Workspace,
}

fn world() -> W {
    let t = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(t.path()).unwrap();
    let root = base.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.txt"), "a\n").unwrap();
    let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    W {
        outside: base.join("outside.txt"),
        _t: t,
        root,
        ws,
    }
}

fn run(w: &W, program: &str, args: &[&str], net: &str, cancel: &CancellationToken) -> ToolResultV1 {
    let policy = CommandPolicy::standard(Toolchain::discover()).with_workbench();
    let budgets = ToolBudgets::default();
    let grant = GrantRef {
        grant_id: "grt_m8".into(),
        version: 1,
        digest: "d".repeat(64),
        fs: "full".into(),
        net: net.into(),
        approval: "auto".into(),
    };
    let ctx = ProcessContext {
        ws: &w.ws,
        env: None,
        run_root: &w.root,
        execution_id: "m8-test",
        policy: &policy,
        budgets: &budgets,
        scope_max_wall_ms: 30_000,
        fs_scope: FsScope::Full,
        grant: Some(&grant),
        task_instance_id: "task-m8",
        command_id: "cmd-m8",
    };
    let a = ProcessArgs {
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: ".".into(),
    };
    run_process(&ctx, &a, cancel, &mut Hooks).expect("run_process")
}

#[test]
fn m8_host_runs_real_programs_in_real_cwd_and_reports_effects() {
    let w = world();
    let r = run(
        &w,
        "sh",
        &["-c", "echo hello-host; echo made > made.txt; exit 3"],
        "full",
        &CancellationToken::new("c1"),
    );
    assert_eq!(r.status, nexus_tools::result::ResultStatus::Ok, "{r:?}");
    let out = r.output.expect("output");
    assert_eq!(out["backend"], "host");
    assert_eq!(out["fsScope"], "full");
    assert_eq!(out["exitCode"], 3);
    assert!(
        out["stdout"].as_str().unwrap().contains("hello-host"),
        "{out}"
    );
    assert_eq!(out["effects"]["created"], 1, "{out}");
    assert_eq!(out["effects"]["recoverable"], false);
    assert!(
        w.root.join("made.txt").exists(),
        "real file in real project"
    );
}

#[test]
fn m8_host_can_reach_outside_the_project_unlike_workspace_scope() {
    let w = world();
    let r = run(
        &w,
        "sh",
        &["-c", "echo outside > ../outside.txt"],
        "full",
        &CancellationToken::new("c2"),
    );
    assert_eq!(r.status, nexus_tools::result::ResultStatus::Ok, "{r:?}");
    assert!(
        w.outside.exists(),
        "host authority reaches outside the project"
    );
    let out = r.output.expect("output");
    assert!(
        out["effects"]["outsideProjectEffects"]
            .as_str()
            .unwrap()
            .contains("not observed"),
        "{out}"
    );
}

#[test]
fn m8_full_without_full_network_is_refused_not_emulated() {
    let w = world();
    for net in ["offline", "controlled", "install"] {
        let r = run(
            &w,
            "sh",
            &["-c", "echo nope"],
            net,
            &CancellationToken::new("c3"),
        );
        assert_eq!(
            r.status,
            nexus_tools::result::ResultStatus::Error,
            "{net}: {r:?}"
        );
        let msg = r.error.expect("error").message;
        assert!(msg.contains("net=full"), "{net}: {msg}");
    }
    assert!(!w.root.join("nope").exists());
}

#[test]
fn m8_missing_program_fails_actionably_without_fallback() {
    let w = world();
    let r = run(
        &w,
        "nexus-no-such-tool-m8",
        &[],
        "full",
        &CancellationToken::new("c4"),
    );
    assert_eq!(r.status, nexus_tools::result::ResultStatus::Error, "{r:?}");
    let msg = r.error.expect("error").message;
    assert!(
        msg.contains("not installed") || msg.contains("does not exist"),
        "{msg}"
    );
    assert!(msg.contains("no other backend was substituted"), "{msg}");
}

#[test]
fn m8_cancellation_kills_the_host_process_group() {
    let w = world();
    let cancel = CancellationToken::new("c5");
    let c2 = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        c2.cancel();
    });
    let started = std::time::Instant::now();
    let r = run(&w, "sh", &["-c", "sleep 30"], "full", &cancel);
    t.join().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    let out = r.output.expect("output");
    assert_eq!(out["reason"], "cancelled", "{out}");
}
