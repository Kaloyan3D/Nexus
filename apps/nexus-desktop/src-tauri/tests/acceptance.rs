//! A6.1.4 P7 - real end-to-end autonomous acceptance runner (DEVELOPMENT).
//!
//! Drives the SAME native backend code the Desktop uses - the runtime supervisor, the
//! one-time provider connection and consent, project opening, the coding submission,
//! patch adoption - against a REAL provider run, then checks the definition of done:
//! no manual broker setup, no authorization command, no pinning, no per-tool approval;
//! source inspection, automated (not human) grants, sandboxed tests, corrections,
//! receipts and diff, persistence across a runtime restart, and an unmodified original
//! until the patch is explicitly adopted.
//!
//! Dialogs are SCRIPTED here (nobody is at the keyboard): that is stated in the report.
//! The fixture/provider distinction is explicit: this runner only ever talks to the
//! real provider and refuses to run without a real key file.
//!
//!   NEXUS_ACC_PROJECT=~/work/taskboard NEXUS_ACC_TASK="..." NEXUS_ACC_KEY_FILE=~/.nexus-a54/credentials.json \
//!   NEXUS_ACC_REPORT=/tmp/acc.json cargo test --test acceptance -- --ignored --nocapture

use nexus_client::intent_client as ic;
use nexus_desktop_lib::dialogs::ScriptedDialogs;
use nexus_desktop_lib::interactive::{code_submit, Runtime};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn sh(dir: &Path, cmd: &str) -> (bool, String) {
    let o = Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .current_dir(dir)
        .output()
        .unwrap();
    (
        o.status.success(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        ),
    )
}

fn fingerprint(dir: &Path) -> String {
    sh(dir, "find . -type f -not -path './.git/*' -not -path './target/*' | sort | xargs sha256sum | sha256sum").1
}

#[test]
#[ignore = "real-provider acceptance; needs NEXUS_ACC_PROJECT, NEXUS_ACC_TASK, NEXUS_ACC_KEY_FILE"]
fn real_provider_autonomous_acceptance() {
    let (Some(project), Some(task), Some(key_file)) = (
        env("NEXUS_ACC_PROJECT"),
        env("NEXUS_ACC_TASK"),
        env("NEXUS_ACC_KEY_FILE"),
    ) else {
        println!("NOT RUN: set NEXUS_ACC_PROJECT, NEXUS_ACC_TASK, NEXUS_ACC_KEY_FILE");
        return;
    };
    let started = Instant::now();
    let report = std::cell::RefCell::new(
        json!({ "kind": "provider", "dialogs": "scripted", "project": project, "checks": {} }),
    );
    let check = |name: &str, ok: bool, detail: String| {
        println!("{} {name}: {detail}", if ok { "PASS" } else { "FAIL" });
        report.borrow_mut()["checks"][name] = json!({ "ok": ok, "detail": detail });
        assert!(ok, "{name} failed (see the report)");
    };
    // a fresh disposable copy of the project: adoption modifies THIS, never the user's folder
    let work = tempfile::tempdir().unwrap();
    let copy: PathBuf = work.path().join("project");
    assert!(
        sh(
            work.path(),
            &format!("cp -a '{project}' '{}'", copy.display())
        )
        .0
    );
    let origin_fp = fingerprint(&copy);
    let key = std::fs::read_to_string(&key_file)
        .map(|s| {
            serde_json::from_str::<serde_json::Value>(&s)
                .ok()
                .and_then(|v| {
                    v.as_object().and_then(|o| {
                        o.values()
                            .next()
                            .and_then(|x| x.as_str().map(str::to_owned))
                    })
                })
                .unwrap_or(s.trim().to_owned())
        })
        .unwrap();

    // 1. the normal entry point: a brand-new home, nothing configured
    let home = tempfile::tempdir().unwrap();
    std::env::remove_var("NEXUS_BROKER_SOCKET");
    std::env::remove_var("NEXUS_SOCKET");
    std::env::set_var("NEXUS_HOME", home.path().join("nexus"));
    let rt = Runtime::new();
    check(
        "interactive-mode",
        !rt.external,
        "no operator-run broker is named".into(),
    );
    rt.start_blocking();
    let st = rt.state();
    check(
        "runtime-started-automatically",
        st.phase == "ready",
        format!("{:?}", st.message),
    );
    let dialogs = ScriptedDialogs {
        confirm: true,
        secret: Some(key),
        ..Default::default()
    };
    dialogs
        .folders
        .lock()
        .unwrap()
        .push(copy.to_string_lossy().into_owned());

    // 2. one-time provider connection + consent (the ONLY setup)
    let conn = rt.provider_connect(&dialogs).expect("connect");
    check(
        "provider-connected-once",
        conn.verified,
        conn.checks.join(" | "),
    );
    let consent = rt.provider_consent(&dialogs).expect("consent");
    check(
        "consent-given-once",
        consent.given,
        "native confirmation (scripted)".into(),
    );

    // 3. open a fresh project: no CLI registration, no pin, no operator
    let opened = rt.project_pick(&dialogs).expect("open project");
    let pid = opened["project"]["projectId"].as_str().unwrap().to_owned();
    check(
        "project-opened-and-detected",
        opened["project"]["kinds"]
            .as_array()
            .is_some_and(|k| !k.is_empty()),
        opened["project"]["kinds"].to_string(),
    );
    check(
        "project-snapshot",
        opened["snapshot"]["files"].as_u64().unwrap_or(0) > 0,
        opened["snapshot"].to_string(),
    );

    // 4. submit a multi-file task: text + project identity only
    let reply = code_submit(task.clone(), pid.clone(), ic::fresh_key("acc")).expect("submit");
    let run_id = reply.run.run_id.clone();
    let sock = ic::default_broker_socket();
    let deadline = Instant::now()
        + Duration::from_secs(
            env("NEXUS_ACC_TIMEOUT_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(2700),
        );
    let mut saw_pending = false;
    let mut max_turn = 0;
    let run = loop {
        let r = ic::status(&sock, &run_id).expect("status");
        saw_pending |= r.pending_approval.is_some();
        max_turn = max_turn.max(r.turn);
        if r.terminal {
            break r;
        }
        assert!(
            Instant::now() < deadline,
            "the run did not finish in time: {r:?}"
        );
        std::thread::sleep(Duration::from_secs(2));
    };
    report.borrow_mut()["run"] = json!({ "runId": run_id, "state": run.state, "turns": run.turn, "toolCalls": run.tool_calls, "edits": run.edits_used, "commands": run.tests_used,
        "inputTokens": run.usage_input_tokens, "outputTokens": run.usage_output_tokens, "errorCode": run.error_code, "seconds": started.elapsed().as_secs() });
    let o = run.coding_outcome.clone();
    check(
        "run-completed",
        run.state == "completed",
        format!("state={} error={:?}", run.state, run.error_code),
    );
    check(
        "verified-passed",
        o.as_ref()
            .is_some_and(|o| o.verification == "verified-passed" && !o.stale_after_edit),
        format!("{o:?}"),
    );
    let reads = run
        .tool_activity
        .iter()
        .filter(|a| {
            a.tool.starts_with("fs_")
                && a.status == "executed"
                && (a.tool == "fs_read" || a.tool == "fs_list" || a.tool == "fs_search")
        })
        .count();
    check(
        "model-inspected-sources",
        reads >= 2,
        format!("{reads} read-only calls"),
    );
    let muts: Vec<_> = run
        .tool_activity
        .iter()
        .filter(|a| a.tool == "fs_edit" || a.tool == "fs_write" || a.tool == "proc_run")
        .collect();
    check(
        "changes-and-commands-ran-under-automated-policy",
        !muts.is_empty()
            && muts
                .iter()
                .filter(|a| a.status == "executed")
                .all(|a| a.approval_actor.as_deref() == Some("automated-policy")),
        format!("{} operations", muts.len()),
    );
    check(
        "no-human-approval-was-ever-needed",
        !saw_pending && run.pending_approval.is_none(),
        "no pending approval observed".into(),
    );
    let failed_runs = run
        .tool_activity
        .iter()
        .filter(|a| a.tool == "proc_run" && a.verification.as_deref() == Some("fail"))
        .count();
    report.borrow_mut()["run"]["failedTestRunsBeforeFix"] = json!(failed_runs);
    check(
        "tests-ran-in-sandbox",
        run.tests_used >= 1
            && run
                .tool_activity
                .iter()
                .any(|a| a.tool == "proc_run" && a.verification.as_deref() == Some("pass")),
        format!(
            "{} commands, {failed_runs} failing before the fix",
            run.tests_used
        ),
    );

    // 5. receipts, diff, original untouched
    let diff = ic::diff(&sock, &run_id).expect("diff");
    check(
        "diff-available",
        !diff.files.is_empty() && !diff.diff.is_empty(),
        format!("{} files", diff.files.len()),
    );
    check(
        "original-unchanged-before-adoption",
        fingerprint(&copy) == origin_fp,
        "byte-identical".into(),
    );
    // independent verification: the patch applies to a clean clone of the ORIGINAL and the project's own tests pass
    let verify = env("NEXUS_ACC_VERIFY").unwrap_or_else(|| "cargo test --offline".into());
    let clone: PathBuf = work.path().join("verify");
    assert!(
        sh(
            work.path(),
            &format!("cp -a '{project}' '{}'", clone.display())
        )
        .0
    );
    std::fs::write(work.path().join("p.diff"), &diff.diff).unwrap();
    let (applied, out) = sh(
        &clone,
        &format!("git apply '{}/p.diff' 2>&1", work.path().display()),
    );
    check(
        "patch-applies-to-a-clean-clone",
        applied,
        out.lines().last().unwrap_or("").to_owned(),
    );
    let (passed, out) = sh(&clone, &verify);
    check(
        "independent-verification-passes",
        passed,
        out.lines().rev().take(3).collect::<Vec<_>>().join(" | "),
    );

    // 6. persistence and recovery: the whole runtime restarts, history and evidence survive
    let before = (run.state.clone(), diff.diff_digest.clone());
    nexus_runtime::stop(rt.home.as_ref().unwrap()).expect("stop");
    rt.start_blocking();
    let again = ic::status(&sock, &run_id).expect("status after restart");
    let diff2 = ic::diff(&sock, &run_id).expect("diff after restart");
    check(
        "persisted-across-restart",
        again.state == before.0
            && diff2.diff_digest == before.1
            && again.coding_outcome == run.coding_outcome,
        "same state, outcome and diff digest".into(),
    );

    // 7. adoption is explicit, confirmed and all-or-nothing
    let adopted = rt.adopt_patch(&dialogs, &run_id).expect("adopt");
    check(
        "adoption-applied-after-confirmation",
        adopted["applied"].as_array().is_some_and(|a| !a.is_empty()),
        adopted.to_string(),
    );
    let (ok, out) = sh(&copy, &verify);
    check(
        "adopted-folder-passes-its-tests",
        ok,
        out.lines().rev().take(2).collect::<Vec<_>>().join(" | "),
    );
    let refused = rt.adopt_patch(&dialogs, &run_id);
    check(
        "second-adoption-is-refused-folder-changed",
        refused.is_err(),
        format!("{refused:?}"),
    );

    report.borrow_mut()["totalSeconds"] = json!(started.elapsed().as_secs());
    report.borrow_mut()["maxTurn"] = json!(max_turn);
    if let Some(p) = env("NEXUS_ACC_REPORT") {
        std::fs::write(p, serde_json::to_string_pretty(&*report.borrow()).unwrap()).unwrap();
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&report.borrow()["run"]).unwrap()
    );
    let _ = nexus_runtime::stop(rt.home.as_ref().unwrap());
}

// ---- P4: crash recovery and cancellation against the real provider ------------------

struct Rig {
    rt: Runtime,
    _home: tempfile::TempDir,
    work: tempfile::TempDir,
    copy: PathBuf,
    pid: String,
    sock: PathBuf,
}

fn rig(project: &str, key_file: &str) -> Rig {
    let work = tempfile::tempdir().unwrap();
    let copy: PathBuf = work.path().join("project");
    assert!(
        sh(
            work.path(),
            &format!("cp -a '{project}' '{}'", copy.display())
        )
        .0
    );
    let key = std::fs::read_to_string(key_file)
        .map(|s| {
            serde_json::from_str::<serde_json::Value>(&s)
                .ok()
                .and_then(|v| {
                    v.as_object().and_then(|o| {
                        o.values()
                            .next()
                            .and_then(|x| x.as_str().map(str::to_owned))
                    })
                })
                .unwrap_or(s.trim().to_owned())
        })
        .unwrap();
    let home = tempfile::tempdir().unwrap();
    std::env::remove_var("NEXUS_BROKER_SOCKET");
    std::env::remove_var("NEXUS_SOCKET");
    std::env::set_var("NEXUS_HOME", home.path().join("nexus"));
    let rt = Runtime::new();
    rt.start_blocking();
    assert_eq!(rt.state().phase, "ready");
    let dialogs = ScriptedDialogs {
        confirm: true,
        secret: Some(key),
        ..Default::default()
    };
    dialogs
        .folders
        .lock()
        .unwrap()
        .push(copy.to_string_lossy().into_owned());
    assert!(rt.provider_connect(&dialogs).expect("connect").verified);
    assert!(rt.provider_consent(&dialogs).expect("consent").given);
    let pid = rt.project_pick(&dialogs).expect("open")["project"]["projectId"]
        .as_str()
        .unwrap()
        .to_owned();
    Rig {
        rt,
        _home: home,
        work,
        copy,
        pid,
        sock: ic::default_broker_socket(),
    }
}

fn wait_calls(sock: &Path, run: &str, calls: u32, secs: u64) -> ic::IntentRun {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        let r = ic::status(sock, run).unwrap();
        if r.tool_calls >= calls || r.terminal {
            return r;
        }
        assert!(
            Instant::now() < end,
            "never reached {calls} tool calls: {r:?}"
        );
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[test]
#[ignore = "real-provider recovery acceptance; needs NEXUS_ACC_PROJECT, NEXUS_ACC_TASK, NEXUS_ACC_KEY_FILE"]
fn real_provider_crash_recovery_and_cancellation() {
    let (Some(project), Some(task), Some(key_file)) = (
        env("NEXUS_ACC_PROJECT"),
        env("NEXUS_ACC_TASK"),
        env("NEXUS_ACC_KEY_FILE"),
    ) else {
        println!("NOT RUN: set NEXUS_ACC_PROJECT, NEXUS_ACC_TASK, NEXUS_ACC_KEY_FILE");
        return;
    };
    let g = rig(&project, &key_file);
    let before = fingerprint(&g.copy);

    // A. cancellation: stop a live run mid-way
    let r = code_submit(task.clone(), g.pid.clone(), ic::fresh_key("acc-cancel"))
        .unwrap()
        .run;
    let mid = wait_calls(&g.sock, &r.run_id, 3, 300);
    assert!(
        !mid.terminal,
        "the task finished before it could be cancelled; use a longer task"
    );
    ic::cancel(&g.sock, &r.run_id).unwrap();
    let end = Instant::now() + Duration::from_secs(120);
    let cancelled = loop {
        let x = ic::status(&g.sock, &r.run_id).unwrap();
        if x.terminal {
            break x;
        }
        assert!(Instant::now() < end, "cancel did not take effect: {x:?}");
        std::thread::sleep(Duration::from_millis(300));
    };
    println!(
        "PASS cancellation: state={} calls={}",
        cancelled.state, cancelled.tool_calls
    );
    assert_ne!(cancelled.state, "completed");
    let after = ic::status(&g.sock, &r.run_id).unwrap();
    assert_eq!(
        after.tool_calls, cancelled.tool_calls,
        "nothing executes after the run ended"
    );

    // B. crash: kill the daemon and broker with SIGKILL mid-run
    let r2 = code_submit(task.clone(), g.pid.clone(), ic::fresh_key("acc-crash"))
        .unwrap()
        .run;
    let mid = wait_calls(&g.sock, &r2.run_id, 4, 300);
    assert!(
        !mid.terminal,
        "the task finished before the crash; use a longer task"
    );
    let st = nexus_runtime::status(g.rt.home.as_ref().unwrap());
    for p in [st.broker_pid, st.daemon_pid].into_iter().flatten() {
        unsafe { libc_kill(p as i32) };
    }
    std::thread::sleep(Duration::from_secs(1));
    g.rt.start_blocking();
    assert_eq!(
        g.rt.state().phase,
        "ready",
        "the supervisor restarted the runtime"
    );
    let rec = ic::status(&g.sock, &r2.run_id).unwrap();
    println!(
        "PASS crash-recovery: state={} error={:?} calls_at_crash>={} calls_after={}",
        rec.state, rec.error_code, mid.tool_calls, rec.tool_calls
    );
    assert!(
        rec.terminal,
        "a run the broker lost is closed by startup recovery: {rec:?}"
    );
    assert_ne!(rec.state, "completed");
    std::thread::sleep(Duration::from_secs(3));
    let later = ic::status(&g.sock, &r2.run_id).unwrap();
    assert_eq!(
        later.tool_calls, rec.tool_calls,
        "nothing was re-executed or resumed behind the user's back"
    );
    assert_eq!(
        fingerprint(&g.copy),
        before,
        "the original is untouched by cancelled and crashed runs"
    );

    // C. a NEW run on the same project works and completes (resumption = start again from current state)
    let r3 = code_submit(task, g.pid.clone(), ic::fresh_key("acc-again"))
        .unwrap()
        .run;
    let end = Instant::now() + Duration::from_secs(1800);
    let done = loop {
        let x = ic::status(&g.sock, &r3.run_id).unwrap();
        if x.terminal {
            break x;
        }
        assert!(Instant::now() < end, "the fresh run did not finish");
        std::thread::sleep(Duration::from_secs(2));
    };
    println!(
        "PASS fresh-run-after-recovery: state={} outcome={:?}",
        done.state,
        done.coding_outcome.as_ref().map(|o| o.verification.clone())
    );
    assert_eq!(done.state, "completed");
    let _ = &g.work;
    let _ = nexus_runtime::stop(g.rt.home.as_ref().unwrap());
}

unsafe fn libc_kill(pid: i32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}
