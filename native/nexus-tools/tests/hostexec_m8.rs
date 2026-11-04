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

#[test]
fn m81_setsid_descendant_cannot_escape_cancellation() {
    let w = world();
    let cancel = CancellationToken::new("c6");
    let c2 = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        c2.cancel();
    });
    let r = run(
        &w,
        "sh",
        &[
            "-c",
            "setsid sh -c 'while true; do date +%s%N >> hb.txt; sleep 0.2; done' & sleep 30",
        ],
        "full",
        &cancel,
    );
    t.join().unwrap();
    let out = r.output.expect("output");
    assert_eq!(out["reason"], "cancelled", "{out}");
    if out["resourceEnforcement"] != "kernel-cgroup" {
        println!(
            "NOT RUN (escape assertion): no writable cgroup on this machine; enforcement={}",
            out["resourceEnforcement"]
        );
        return;
    }
    // the setsid descendant must be dead: the heartbeat stops growing
    let hb = w.root.join("hb.txt");
    let s1 = std::fs::metadata(&hb).map(|m| m.len()).unwrap_or(0);
    std::thread::sleep(std::time::Duration::from_millis(900));
    let s2 = std::fs::metadata(&hb).map(|m| m.len()).unwrap_or(0);
    assert_eq!(
        s1, s2,
        "setsid descendant survived cancellation (hb {s1} -> {s2})"
    );
    assert!(s1 > 0, "descendant actually ran before cancellation");
}

#[test]
fn m81_detached_descendant_is_reaped_when_the_command_exits() {
    let w = world();
    let r = run(
        &w,
        "sh",
        &[
            "-c",
            "setsid sh -c 'while true; do date +%s%N >> hb2.txt; sleep 0.2; done' & echo spawned",
        ],
        "full",
        &CancellationToken::new("c7"),
    );
    let out = r.output.expect("output");
    assert_eq!(out["exitCode"], 0, "{out}");
    if out["resourceEnforcement"] != "kernel-cgroup" {
        println!("NOT RUN (reap assertion): no writable cgroup on this machine");
        return;
    }
    std::thread::sleep(std::time::Duration::from_millis(400));
    let hb = w.root.join("hb2.txt");
    let s1 = std::fs::metadata(&hb).map(|m| m.len()).unwrap_or(0);
    std::thread::sleep(std::time::Duration::from_millis(800));
    let s2 = std::fs::metadata(&hb).map(|m| m.len()).unwrap_or(0);
    assert_eq!(
        s1, s2,
        "daemonized descendant outlived its command (hb {s1} -> {s2})"
    );
}

#[test]
fn orphan_reconciliation_preserves_another_live_supervisors_command() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let base = nexus_tools::sandbox::cgroup_base().expect("cgroup v2");
    let running = AtomicBool::new(false);
    let w = world();
    std::thread::scope(|scope| {
        let handle = scope.spawn(|| {
            let mut stop = || {
                running.store(true, Ordering::SeqCst);
                None
            };
            nexus_tools::host_exec::run_host(nexus_tools::host_exec::HostRun {
                program: "/usr/bin/sh".into(),
                argv: vec![
                    "sh".into(),
                    "-c".into(),
                    "sleep 0.3; echo still-supervised".into(),
                ],
                cwd: w.root.clone(),
                env: std::collections::BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                wall_ms: 5000,
                tail_bytes: 4096,
                should_stop: &mut stop,
            })
            .unwrap()
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !running.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        nexus_tools::host_exec::reap_orphan_host_cgroups(&base);
        let out = handle.join().unwrap();
        assert_eq!(out.resource_enforcement, "kernel-cgroup");
        assert_eq!(out.exit, nexus_tools::sandbox::ExitKind::Exited(0));
        assert!(String::from_utf8_lossy(&out.stdout).contains("still-supervised"));
    });
}

/// PIDs (other than this test process) whose command line contains `marker`.
fn procs_with(marker: &str) -> Vec<u32> {
    let me = std::process::id();
    let mut found = Vec::new();
    for e in std::fs::read_dir("/proc").unwrap().flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
            continue;
        };
        if pid == me {
            continue;
        }
        if let Ok(c) = std::fs::read(e.path().join("cmdline")) {
            if String::from_utf8_lossy(&c).contains(marker) {
                found.push(pid);
            }
        }
    }
    found
}

/// Regression for the intermittent hang (M4.4): every execution of one process shares its pid and start time,
/// and the leaf name's only distinguishing part was the wall clock, which two concurrent executions can read
/// as the same tick. The second `mkdir` then failed with EEXIST, the error was dropped, that run silently
/// lost its cgroup and a `setsid` descendant escaped and held the output pipe forever. Many executions start
/// at the same instant here, repeatedly, and each must keep kernel cgroup supervision and leave nothing behind.
#[test]
fn m81_simultaneous_executions_all_keep_cgroup_supervision_and_leave_no_descendant() {
    use std::sync::{Arc, Barrier};
    const ROUNDS: usize = 5;
    const N: usize = 16;
    // is a kernel cgroup offered here at all? (same escape hatch as the other cgroup assertions)
    {
        let w = world();
        let r = run(
            &w,
            "sh",
            &["-c", "echo probe"],
            "full",
            &CancellationToken::new("probe"),
        );
        let out = r.output.expect("output");
        if out["resourceEnforcement"] != "kernel-cgroup" {
            println!("NOT RUN (concurrency assertion): no writable cgroup on this machine");
            return;
        }
    }
    let marker = format!("m81sim{}x", std::process::id());
    for round in 0..ROUNDS {
        let barrier = Arc::new(Barrier::new(N));
        let handles: Vec<_> = (0..N)
            .map(|i| {
                let barrier = barrier.clone();
                let marker = marker.clone();
                std::thread::spawn(move || {
                    let w = world();
                    barrier.wait();
                    let script = format!(
                        "setsid sh -c ': {marker}-{round}-{i}; while true; do date +%s%N >> hb.txt; sleep 0.2; done' & echo spawned"
                    );
                    let r = run(
                        &w,
                        "sh",
                        &["-c", &script],
                        "full",
                        &CancellationToken::new(&format!("sim-{round}-{i}")),
                    );
                    let out = r.output.expect("output");
                    // the detached descendant must be dead: its heartbeat stops growing
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let hb = w.root.join("hb.txt");
                    let len = || std::fs::metadata(&hb).map(|m| m.len()).unwrap_or(0);
                    let s1 = len();
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    (
                        out["resourceEnforcement"].as_str().unwrap_or("").to_owned(),
                        out["exitCode"].as_i64(),
                        out["cgroup"].as_str().unwrap_or("").to_owned(),
                        s1,
                        len(),
                    )
                })
            })
            .collect();
        for (i, h) in handles.into_iter().enumerate() {
            let (enforcement, exit, cgroup, s1, s2) = h.join().expect("execution thread");
            assert_eq!(
                enforcement, "kernel-cgroup",
                "round {round} run {i} lost cgroup supervision: {cgroup}"
            );
            assert_eq!(exit, Some(0), "round {round} run {i}");
            assert_eq!(
                s1, s2,
                "round {round} run {i}: descendant survived (hb {s1} -> {s2})"
            );
        }
        assert_eq!(
            procs_with(&marker),
            Vec::<u32>::new(),
            "round {round}: processes left behind by finished executions"
        );
    }
}

/// Degraded mode: when a command is supervised only as a process group (no cgroup), a descendant that left
/// the group by `setsid` cannot be reached, and it keeps the output pipes open. The run must still return,
/// with what the command wrote, and say that output may be incomplete, rather than wait for ever.
#[test]
fn m81_process_group_only_supervision_never_waits_for_a_detached_descendants_pipe() {
    use nexus_tools::host_exec::{run_host_with, HostRun, Supervision};
    let w = world();
    let marker = format!("m81pg{}x", std::process::id());
    let script =
        format!("setsid sh -c ': {marker}; while true; do sleep 0.2; done' & echo spawned");
    let mut never_stop = || None;
    let started = std::time::Instant::now();
    let out = run_host_with(
        HostRun {
            program: "/usr/bin/sh".into(),
            argv: vec!["sh".into(), "-c".into(), script],
            cwd: w.root.clone(),
            env: std::collections::BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            wall_ms: 20_000,
            tail_bytes: 4096,
            should_stop: &mut never_stop,
        },
        Supervision::ProcessGroupOnly,
    )
    .expect("run");
    let took = started.elapsed();
    // the descendant is genuinely outside Nexus's reach, and is still running: clean it up ourselves
    let leaked = procs_with(&marker);
    for pid in &leaked {
        unsafe { libc_kill(*pid as i32) };
    }
    assert!(
        took < std::time::Duration::from_secs(5),
        "returned only after {took:?}"
    );
    assert!(
        !leaked.is_empty(),
        "the scenario did not leave a detached descendant"
    );
    assert_eq!(out.exit, nexus_tools::sandbox::ExitKind::Exited(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("spawned"));
    assert_eq!(out.resource_enforcement, "process-group-polling");
    assert!(
        out.cgroup.contains("process-group supervision requested")
            && out.cgroup.contains("output may be incomplete"),
        "{}",
        out.cgroup
    );
    // give the killed loop a moment, then nothing may remain
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(procs_with(&marker), Vec::<u32>::new());
}

unsafe fn libc_kill(pid: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, 9);
}
