//! M6C: end-to-end developer acceptance through the full trusted path (Kernel-sealed grant,
//! authorization, workbench resolution, sandbox, in-place effects ledger) on a disposable
//! project. The model transport is not involved; actual programs run: python3 (generator),
//! node, git, a project-local script, and the host Rust toolchain when present.
//!
//! Prints `NOT RUN` when the host lacks the sandbox (the release battery runs with
//! `NEXUS_REQUIRE_SANDBOX=1`).

mod common;

use common::*;
use nexus_tools::grant::ExecPolicy;
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute_process_policy, CancellationToken};
use serde_json::json;

fn policy() -> CommandPolicy {
    CommandPolicy::standard(Toolchain::discover()).with_workbench()
}

fn ready(t: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available
        || !std::path::Path::new("/usr/bin/python3").exists()
        || !std::path::Path::new("/usr/bin/git").exists()
    {
        println!("NOT RUN ({t}): sandbox unavailable: {:?}", c.problems);
        return false;
    }
    let caps = {
        use nexus_tools::exec_contract::ExecBackend;
        nexus_tools::exec_contract::LinuxBwrapBackend.caps()
    };
    if !caps.pinned_root_mount {
        println!("NOT RUN ({t}): bubblewrap without --bind-fd");
        return false;
    }
    true
}

fn run(
    fx: &mut Fx,
    program: &str,
    args: serde_json::Value,
    exec: Option<ExecPolicy>,
) -> nexus_tools::ToolExecutionOutcome {
    fx.approve_process_fs(120_000, "workspace");
    let r = fx.request(
        "proc.run",
        json!({"program": program, "args": args, "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = policy();
    let p = fx.prepare_p(r, &pol).expect("prepare");
    let call = authorize(&mut fx.kernel, p).expect("authorize");
    let run_dir = fx.dir.path().join(format!("exec-{}", fx.command));
    // unique run root per call
    let run_dir = run_dir.join(format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    execute_process_policy(
        &mut fx.kernel,
        &call,
        &cancel,
        &pol,
        &run_dir,
        120_000,
        None,
        exec,
    )
    .expect("execute")
}

fn out(o: &nexus_tools::ToolExecutionOutcome) -> serde_json::Value {
    o.result.output.clone().unwrap_or_default()
}
fn text(v: &serde_json::Value) -> String {
    format!(
        "{}{}",
        v["stdout"].as_str().unwrap_or(""),
        v["stderr"].as_str().unwrap_or("")
    )
}
fn gw() -> Option<ExecPolicy> {
    Some(ExecPolicy {
        git_write: true,
        ..Default::default()
    })
}

#[test]
fn m6c_a_disposable_project_is_built_tested_and_committed_in_place() {
    if !ready("m6c") {
        return;
    }
    let mut fx = fixture("m6c-dev");
    // 1. the project skeleton, written by Nexus's own file path on the host fixture
    fx.write("spec.txt", b"name = widget\nversion = 1\n");
    fx.write(
        "gen.py",
        b"import pathlib\nspec = dict(l.split(' = ') for l in pathlib.Path('spec.txt').read_text().splitlines())\npathlib.Path('generated').mkdir(exist_ok=True)\npathlib.Path('generated/info.txt').write_text(f\"{spec['name']}-{spec['version']}\\n\")\nprint('generated')\n",
    );
    fx.write(
        "check.js",
        b"const fs=require('fs');const s=fs.readFileSync('generated/info.txt','utf8');if(s.trim()!=='widget-1'){console.error('bad: '+s);process.exit(1)}console.log('node-check-ok');\n",
    );
    fx.write(
        "tools/fmt.py",
        b"import sys,pathlib\np=pathlib.Path(sys.argv[1]);p.write_text(' '.join(p.read_text().split())+'\\n')\n",
    );
    fx.write("ugly.txt", b"a   b\n\n c\n");
    // a project-local executable script
    fx.write("scripts/hello.sh", b"#!/bin/sh\necho project-script-ok\n");
    {
        use std::os::unix::fs::PermissionsExt;
        let p = fx.ws.join("scripts/hello.sh");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    // 2. universal programs run in place: an interpreter generator, node, a project-local
    //    script by path, and a formatter invoked through python3
    let o = run(&mut fx, "python3", json!(["gen.py"]), None);
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
    assert_eq!(fx.disk("generated/info.txt").as_deref(), Some("widget-1\n"));
    let o = run(&mut fx, "node", json!(["check.js"]), None);
    assert!(
        text(&out(&o)).contains("node-check-ok"),
        "{}",
        text(&out(&o))
    );
    let o = run(&mut fx, "./scripts/hello.sh", json!([]), None);
    assert!(
        text(&out(&o)).contains("project-script-ok"),
        "{}",
        text(&out(&o))
    );
    let o = run(
        &mut fx,
        "python3",
        json!(["tools/fmt.py", "ugly.txt"]),
        None,
    );
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
    assert_eq!(fx.disk("ugly.txt").as_deref(), Some("a b c\n"));

    // 3. a program that is not installed fails actionably at resolution, and nothing falls
    //    back to host execution
    fx.approve_process_fs(120_000, "workspace");
    let r = fx.request(
        "proc.run",
        json!({"program": "nexus-missing-tool-m6c", "args": [], "cwd": "."}),
    );
    let pol = policy();
    let e = fx
        .prepare_p(r, &pol)
        .expect_err("a missing program must be refused at resolution");
    assert!(
        e.message
            .contains("not available inside the authorized runtime"),
        "{}",
        e.message
    );
    assert!(
        e.message.contains("does not fall back to host execution"),
        "{}",
        e.message
    );

    // 4. git: initialize, inspect, then - only under the Git-write grant - branch and commit
    let o = run(
        &mut fx,
        "sh",
        json!(["-c", "export GIT_AUTHOR_NAME=m6 GIT_AUTHOR_EMAIL=m6@example.invalid GIT_COMMITTER_NAME=m6 GIT_COMMITTER_EMAIL=m6@example.invalid; git init -q && git add -A && git status --porcelain | head -5; echo init-rc=$?"]),
        None,
    );
    assert!(text(&out(&o)).contains("init-rc=0"), "{}", text(&out(&o)));
    // without gitWrite the commit is refused by the read-only .git mount
    let o = run(
        &mut fx,
        "sh",
        json!(["-c", "export GIT_AUTHOR_NAME=m6 GIT_AUTHOR_EMAIL=m6@example.invalid GIT_COMMITTER_NAME=m6 GIT_COMMITTER_EMAIL=m6@example.invalid; git commit -q -m first; echo commit-rc=$?"]),
        None,
    );
    assert!(
        !text(&out(&o)).contains("commit-rc=0"),
        "commit without the grant must fail: {}",
        text(&out(&o))
    );
    // with gitWrite it succeeds, and the host repository is consistent
    let o = run(
        &mut fx,
        "sh",
        json!(["-c", "export GIT_AUTHOR_NAME=m6 GIT_AUTHOR_EMAIL=m6@example.invalid GIT_COMMITTER_NAME=m6 GIT_COMMITTER_EMAIL=m6@example.invalid; git commit -q -m first && git branch feature && echo committed; git log --oneline"]),
        gw(),
    );
    let t = text(&out(&o));
    assert!(t.contains("committed"), "{t}");
    let host_log = std::process::Command::new("/usr/bin/git")
        .args(["log", "--oneline"])
        .current_dir(&fx.ws)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&host_log.stdout).contains("first"));
    let host_branches = std::process::Command::new("/usr/bin/git")
        .args(["branch", "--list", "feature"])
        .current_dir(&fx.ws)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&host_branches.stdout).contains("feature"));

    // 5. modify, verify the next git operations see it, and the effects ledger recorded the runs
    fx.write("generated/info.txt", b"widget-2\n");
    let o = run(&mut fx, "git", json!(["status", "--porcelain"]), gw());
    assert!(
        text(&out(&o)).contains("generated/info.txt"),
        "{}",
        text(&out(&o))
    );
    let o = run(&mut fx, "git", json!(["diff", "--stat"]), gw());
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));

    // 6. unauthorized host paths stay invisible inside the sandbox
    let o = run(
        &mut fx,
        "sh",
        json!([
            "-c",
            "cat ../outside/secret.txt; echo outside-rc=$?; ls /home; echo home-rc=$?"
        ]),
        None,
    );
    let t = text(&out(&o));
    assert!(!t.contains(common::OUTSIDE_SECRET), "{t}");
    assert!(!t.contains("outside-rc=0"), "{t}");
}

/// M6 performance probe (manual): universal-resolution overhead, in-place command startup,
/// and Git operation latency on a small project. Run with `--ignored --nocapture`.
#[test]
#[ignore]
fn perf_m6_measurements() {
    if !ready("perf") {
        return;
    }
    // resolution is pure and runs once per command
    let pol = policy();
    let t = std::time::Instant::now();
    for _ in 0..1000 {
        let a = nexus_tools::contract::ProcessArgs {
            program: "git".into(),
            args: vec!["status".into()],
            cwd: ".".into(),
        };
        std::hint::black_box(pol.resolve(&a).unwrap());
    }
    println!("resolve git status: {:?} per call", t.elapsed() / 1000);

    let mut fx = fixture("m6c-perf");
    fx.write("a.txt", b"one\n");
    let mut times = vec![];
    for _ in 0..5 {
        let t = std::time::Instant::now();
        let o = run(&mut fx, "true", json!([]), None);
        assert_eq!(out(&o)["verification"], "pass");
        times.push(t.elapsed().as_millis());
    }
    println!("in-place `true` per command (ms): {times:?}");
    let o = run(
        &mut fx,
        "sh",
        json!(["-c", "export GIT_AUTHOR_NAME=m6 GIT_AUTHOR_EMAIL=m6@example.invalid GIT_COMMITTER_NAME=m6 GIT_COMMITTER_EMAIL=m6@example.invalid; git init -q && git add -A && git commit -q -m first"]),
        gw(),
    );
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
    for name in ["status", "log"] {
        let t = std::time::Instant::now();
        let o = run(&mut fx, "git", json!([name]), gw());
        assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
        println!("git {name} in place: {} ms", t.elapsed().as_millis());
    }
}
