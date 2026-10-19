//! D5: a shell pipeline's exit status must mean what it says. `cargo test | tail` used to be recorded
//! as a PASS whenever `tail` succeeded, whatever `cargo test` did (the Desktop showed green for a
//! failing suite). Through the real Kernel and sandbox. Without the sandbox the tests print `NOT RUN`
//! - unless `NEXUS_REQUIRE_SANDBOX` is set, which turns a skip into a failure.

mod common;

use common::*;
use nexus_tools::process::{
    apply_pipefail, script_has_pipeline, verdict, CommandPolicy, Pipefail, ResolvedCommand,
    Toolchain,
};
use nexus_tools::{authorize, execute_process, CancellationToken};
use serde_json::{json, Value};
use std::time::Duration;

fn policy() -> CommandPolicy {
    CommandPolicy::standard(Toolchain::discover()).with_workbench()
}

fn ready() -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available || !std::path::Path::new("/usr/bin/sh").exists() {
        println!("NOT RUN: sandbox unavailable: {:?}", c.problems);
        assert!(
            std::env::var_os("NEXUS_REQUIRE_SANDBOX").is_none(),
            "NEXUS_REQUIRE_SANDBOX is set but the sandbox is unavailable: {:?}",
            c.problems
        );
        return false;
    }
    true
}

fn sh(fx: &mut Fx, script: &str) -> Value {
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", script], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = policy();
    let p = fx.prepare_p(r, &pol).expect("prepared");
    let call = authorize(&mut fx.kernel, p).expect("authorized");
    let run = fx.dir.path().join("exec");
    let o = execute_process(&mut fx.kernel, &call, &cancel, &pol, &run, 600_000).expect("ran");
    o.result.output.expect("output")
}

#[test]
fn a_failing_upstream_command_is_a_failure_even_when_tail_or_grep_succeeds() {
    if !ready() {
        return;
    }
    let mut fx = fixture("d5-fail");
    fx.approve_process(60_000);
    // the shape of `cargo test 2>&1 | tail -20`: the producer fails, the filter succeeds
    let o = sh(
        &mut fx,
        "(echo 'test result: FAILED. 61 passed; 4 failed'; exit 101) 2>&1 | tail -n 1",
    );
    assert_eq!(o["exitCode"], 101, "{o}");
    assert_eq!(o["verification"], "fail", "{o}");
    assert_eq!(o["pipefail"], "applied");
    assert!(o["stdout"].as_str().unwrap().contains("FAILED"));
    // the same through grep, and through a three-stage pipeline
    let o = sh(&mut fx, "(echo x; exit 2) | grep x");
    assert_eq!(
        (o["exitCode"].clone(), o["verification"].clone()),
        (json!(2), json!("fail")),
        "{o}"
    );
    let o = sh(&mut fx, "(echo x; exit 7) | grep x | head -n 1");
    assert_eq!(o["verification"], "fail", "{o}");
    // a stage that cannot even start
    let o = sh(&mut fx, "definitely-not-a-command-d5 2>/dev/null | cat");
    assert_eq!(o["verification"], "fail", "{o}");
}

#[test]
fn a_genuinely_successful_pipeline_is_still_a_pass() {
    if !ready() {
        return;
    }
    let mut fx = fixture("d5-pass");
    fx.approve_process(60_000);
    let o = sh(&mut fx, "(echo one; echo two) | tail -n 1");
    assert_eq!(o["exitCode"], 0, "{o}");
    assert_eq!(o["verification"], "pass", "{o}");
    assert_eq!(o["pipefail"], "applied");
    assert_eq!(o["stdout"].as_str().unwrap().trim(), "two");
    // `||` is not a pipeline
    let o = sh(&mut fx, "false || echo recovered");
    assert_eq!(o["verification"], "pass", "{o}");
    assert_eq!(o["pipefail"], "not-applicable");
}

#[test]
fn a_producer_cut_off_by_head_is_unverified_not_passed_and_not_failed() {
    if !ready() {
        return;
    }
    let mut fx = fixture("d5-sigpipe");
    fx.approve_process(60_000);
    // `yes | head -n 1`: yes dies of SIGPIPE (141): its own result is unknown
    let o = sh(&mut fx, "yes | head -n 1");
    assert_eq!(o["exitCode"], 141, "{o}");
    assert_eq!(o["verification"], "unverified", "{o}");
}

#[test]
fn commands_that_are_not_pipelines_run_exactly_as_before() {
    if !ready() {
        return;
    }
    let mut fx = fixture("d5-plain");
    fx.approve_process(60_000);
    let o = sh(&mut fx, "echo hi");
    assert_eq!(
        (
            o["exitCode"].clone(),
            o["verification"].clone(),
            o["pipefail"].clone()
        ),
        (json!(0), json!("pass"), json!("not-applicable")),
        "{o}"
    );
    let o = sh(&mut fx, "exit 3");
    assert_eq!(
        (
            o["exitCode"].clone(),
            o["verification"].clone(),
            o["pipefail"].clone()
        ),
        (json!(3), json!("fail"), json!("not-applicable")),
        "{o}"
    );
    // a non-pipeline command is never rewritten
    let mut rc = ResolvedCommand {
        program: "/usr/bin/sh".into(),
        argv: vec!["-c".into(), "echo hi".into()],
        ..Default::default()
    };
    assert_eq!(apply_pipefail(&mut rc), Pipefail::NotApplicable);
    assert_eq!(rc.argv, vec!["-c".to_owned(), "echo hi".to_owned()]);
}

#[test]
fn cancellation_keeps_its_classification_inside_a_pipeline() {
    if !ready() {
        return;
    }
    // (a wall-clock timeout cannot be provoked here: workbench commands get a long build allowance by
    // design; a timeout is `fail` by `verdict` below and by process_a34 for plain commands)
    // caller cancellation: the lifecycle is `cancelled`, as for a plain command
    let mut fx = fixture("d5-cancel");
    fx.approve_process(60_000);
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", "sleep 120 | cat"], "cwd": "."}),
    );
    let c = CancellationToken::new(&r.cancellation_id);
    let c2 = c.clone();
    let pol = policy();
    let p = fx.prepare_p(r, &pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let th = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        c2.cancel();
    });
    let run = fx.dir.path().join("exec");
    let started = std::time::Instant::now();
    execute_process(&mut fx.kernel, &call, &c, &pol, &run, 600_000).unwrap();
    th.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(20));
    let last = fx.kernel.list_tool_journal(None).unwrap().pop().unwrap();
    assert_eq!(last.phase, "cancelled");
    assert_eq!(last.payload["reason"], "cancelled");
    assert_eq!(last.payload["verification"], "fail");
}

// ---- pure checks (no sandbox needed): the decisions themselves

#[test]
fn pipelines_are_recognised_and_logical_or_is_not_one() {
    assert!(script_has_pipeline("cargo test 2>&1 | tail -20"));
    assert!(script_has_pipeline("a|b"));
    assert!(!script_has_pipeline("a || b"));
    assert!(!script_has_pipeline("echo hi"));
    assert!(script_has_pipeline("a || b | c"));
}

#[test]
fn the_verdict_never_reports_a_pass_it_cannot_back() {
    use Pipefail::*;
    assert_eq!(verdict(Some(0), NotApplicable), "pass");
    assert_eq!(verdict(Some(0), Applied), "pass");
    assert_eq!(verdict(Some(1), Applied), "fail");
    assert_eq!(verdict(Some(101), NotApplicable), "fail");
    // a shell without pipefail: a zero status proves nothing about the first stage
    assert_eq!(verdict(Some(0), Unsupported), "unverified");
    assert_eq!(verdict(Some(2), Unsupported), "fail");
    // SIGPIPE under pipefail: unknown; a plain `exit 141` of a non-pipeline is still a failure
    assert_eq!(verdict(Some(141), Applied), "unverified");
    assert_eq!(verdict(Some(141), NotApplicable), "fail");
    assert_eq!(verdict(None, Applied), "fail");
}

#[test]
fn a_shell_that_does_not_support_pipefail_is_detected_and_left_alone() {
    // a stand-in shell that rejects `set -o pipefail` like an old dash
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("oldsh");
    std::fs::write(&fake, "#!/bin/sh\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut rc = ResolvedCommand {
        program: fake.to_string_lossy().into_owned(),
        argv: vec!["-c".into(), "a | b".into()],
        shell_pipeline: true,
        ..Default::default()
    };
    assert_eq!(apply_pipefail(&mut rc), Pipefail::Unsupported);
    assert_eq!(
        rc.argv,
        vec!["-c".to_owned(), "a | b".to_owned()],
        "the script is not rewritten"
    );
    // and a real shell that supports it gets the option, once, before the script
    let mut rc = ResolvedCommand {
        program: "/usr/bin/sh".into(),
        argv: vec!["-c".into(), "a | b".into()],
        shell_pipeline: true,
        ..Default::default()
    };
    if apply_pipefail(&mut rc) == Pipefail::Applied {
        assert_eq!(rc.argv[1], "set -o pipefail\na | b");
    }
}
