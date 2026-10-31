use super::evidence::*;
use super::persistence;
use super::shadow::ShadowRecorder;
use nexus_client::intent_client::ToolActivity;
use serde_json::json;
use std::collections::BTreeMap;

pub(crate) const RUN: &str = "run_00000000000000000000000000000001";

pub(crate) fn act(index: u32, tool: &str, status: &str, exec: Option<&str>) -> ToolActivity {
    ToolActivity {
        index,
        turn: 1,
        call_id: format!("call{index}"),
        tool: tool.into(),
        args_summary: "summary".into(),
        status: status.into(),
        execution_id: exec.map(str::to_owned),
        journal_seq: exec.map(|_| index as i64 * 10),
        args_digest: Some(format!("d{index}")),
        result_digest: Some("r".into()),
        ..Default::default()
    }
}

pub(crate) fn proc_facts(args: serde_json::Value, exit: i64, verdict: &str) -> ReceiptFacts {
    let out = json!({
        "exitCode": exit, "verification": verdict, "pipefail": "not-applicable",
        "stdout": "SECRET-OUTPUT-xyz", "backend": "sandbox"
    });
    let legacy = crate::inspect::is_verification_command(&args);
    ReceiptFacts::from_result("proc_run", &args, Some(&out), Some(legacy))
}

fn proc_facts_pf(
    args: serde_json::Value,
    exit: i64,
    verdict: &str,
    pipefail: &str,
) -> ReceiptFacts {
    let out = json!({ "exitCode": exit, "verification": verdict, "pipefail": pipefail, "stdout": "SECRET-OUTPUT-xyz", "backend": "sandbox" });
    let legacy = crate::inspect::is_verification_command(&args);
    ReceiptFacts::from_result("proc_run", &args, Some(&out), Some(legacy))
}

pub(crate) fn cmd(program: &str, args: &[&str]) -> serde_json::Value {
    json!({ "program": program, "args": args })
}

fn run_one(
    dir: &std::path::Path,
    a: ToolActivity,
    f: Option<ReceiptFacts>,
) -> super::ledger::Ledger {
    let rec = ShadowRecorder::new(dir, RUN, true);
    rec.set_task("task_1", "inst_1");
    let mut facts = BTreeMap::new();
    if let Some(f) = f {
        facts.insert(a.index, f);
    }
    rec.observe(&[a], &facts);
    persistence::load(dir, RUN).ledger
}

#[test]
fn executed_check_is_attributed_to_its_receipt() {
    let d = tempfile::tempdir().unwrap();
    let l = run_one(
        d.path(),
        act(1, "proc_run", "executed", Some("exec-1")),
        Some(proc_facts(cmd("cargo", &["test"]), 0, "pass")),
    );
    let r = l.records()[0].clone();
    assert_eq!(r.schema_version, SCHEMA_VERSION);
    assert_eq!(r.run_id, RUN);
    assert_eq!(r.task_id.as_deref(), Some("task_1"));
    assert_eq!(r.task_instance_id.as_deref(), Some("inst_1"));
    assert_eq!(r.receipt.execution_id.as_deref(), Some("exec-1"));
    assert_eq!(r.receipt.journal_seq, Some(10));
    assert_eq!(r.receipt.args_digest.as_deref(), Some("d1"));
    assert_eq!(r.provenance.source, "kernel-receipt");
    assert_eq!(r.provenance.backend.as_deref(), Some("sandbox"));
    assert!(r.is_execution_evidence() && r.is_check_process_exit_zero());
    assert_eq!(r.evidence_id, evidence_id(RUN, 1, Some("exec-1")));
}

#[test]
fn failed_command_is_never_promoted() {
    let d = tempfile::tempdir().unwrap();
    let l = run_one(
        d.path(),
        act(1, "proc_run", "failed", Some("exec-1")),
        Some(proc_facts(cmd("cargo", &["test"]), 101, "fail")),
    );
    let r = l.records()[0];
    assert_eq!(r.execution, ExecutionState::ToolFailed);
    assert_eq!(
        r.check.as_ref().unwrap().outcome,
        CheckOutcome::ProcessFailed
    );
    assert!(!r.is_check_process_exit_zero());
    assert_eq!(l.check_exit_zero_count(), 0);
    // even a (contradictory) zero verdict on a failed tool call is not an exit-zero check
    let l = run_one(
        tempfile::tempdir().unwrap().path(),
        act(1, "proc_run", "failed", Some("exec-1")),
        Some(proc_facts(cmd("cargo", &["test"]), 0, "pass")),
    );
    assert_eq!(l.check_exit_zero_count(), 0);
}

#[test]
fn refused_proposal_is_not_execution_evidence() {
    let d = tempfile::tempdir().unwrap();
    // facts must be ignored for a call that never ran
    let l = run_one(
        d.path(),
        act(1, "proc_run", "refused", None),
        Some(proc_facts(cmd("cargo", &["test"]), 0, "pass")),
    );
    let r = l.records()[0];
    assert_eq!(r.execution, ExecutionState::Refused);
    assert!(r.process.is_none() && r.mutation.is_none());
    assert!(
        r.check.is_none(),
        "a call that never ran has no check assessment"
    );
    assert!(!r.is_execution_evidence() && !r.is_check_process_exit_zero());
    assert_eq!(r.provenance.source, "broker-outcome");
}

#[test]
fn composed_shell_checks_are_never_trusted_pass_evidence() {
    for script in [
        "npm test || true",
        "cd native && cargo test",
        "npm test; true",
        "FOO=1 npm test",
        "echo ok && npm test",
        // filters that can change or fail the status, redirects to files, extra stages
        "npm test | grep ok",
        "npm test | tee out.txt",
        "npm test > out.txt",
        "npm test 2>&1 > out.txt",
        "npm test | head -n 5 > out.txt",
        "npm test | head -n 5 | sort",
        "npm test | head -n 5 || true",
        "cat x | npm test",
        "npm test |",
        "npm test | head -n $N",
        "npm test | head -n 5 &",
    ] {
        let d = tempfile::tempdir().unwrap();
        let args = cmd("sh", &["-c", script]);
        let l = run_one(
            d.path(),
            act(1, "proc_run", "executed", Some("e1")),
            Some(proc_facts(args, 0, "pass")),
        );
        let r = l.records()[0];
        assert!(!r.is_check_process_exit_zero(), "{script}");
        assert_eq!(
            r.check.as_ref().unwrap().outcome,
            CheckOutcome::Inconclusive {
                reason: "shell-composition".into()
            },
            "{script}"
        );
    }
    // the legacy classifier calls `npm test || true` a check: that difference is recorded
    let l = run_one(
        tempfile::tempdir().unwrap().path(),
        act(1, "proc_run", "executed", Some("e1")),
        Some(proc_facts(
            cmd("sh", &["-c", "npm test || true"]),
            0,
            "pass",
        )),
    );
    let s = l.records()[0].shadow.clone().unwrap();
    assert!(s.legacy_is_check && !s.evidence_is_check);
    assert_eq!(s.difference.as_deref(), Some("legacy-broader"));
    assert_eq!(l.shadow_differences().len(), 1);
}

#[test]
fn only_plain_direct_checks_are_recognized() {
    let rec = |p, a: &[&str]| classify_command(&cmd(p, a));
    for (p, a) in [
        ("cargo", &["test", "-p", "x"][..]),
        ("npm", &["test"]),
        ("npm", &["run", "build"]),
        ("python3", &["-m", "pytest", "-q"]),
        ("go", &["test", "./..."]),
        ("node", &["--test"]),
        ("node", &["--test", "test/"]),
        ("sh", &["-c", "cargo test --offline"]),
    ] {
        assert!(
            matches!(rec(p, a), Recognition::Recognized { .. }),
            "{p} {a:?}"
        );
    }
    for (p, a) in [
        ("cargo", &["test", "--no-run"][..]),
        ("pytest", &["--collect-only"]),
        ("npx", &["jest", "--passWithNoTests"]),
        ("npm", &["test", "--", "--help"]),
    ] {
        assert!(
            matches!(rec(p, a), Recognition::Indeterminate { .. }),
            "{p} {a:?}"
        );
    }
    for (p, a) in [
        ("npm", &["ci"][..]),
        ("ls", &["-la"]),
        ("node", &["x.js"]),
        ("node", &["--version"]),
        ("cargo", &["fetch"]),
    ] {
        assert_eq!(rec(p, a), Recognition::NotRecognized, "{p} {a:?}");
    }
    // unverified (e.g. pipeline without pipefail) is inconclusive even for a plain check
    let l = run_one(
        tempfile::tempdir().unwrap().path(),
        act(1, "proc_run", "executed", Some("e1")),
        Some(proc_facts(cmd("cargo", &["test"]), 0, "unverified")),
    );
    assert!(matches!(
        l.records()[0].check.as_ref().unwrap().outcome,
        CheckOutcome::Inconclusive { .. }
    ));
}

#[test]
fn mutation_receipt_is_recorded_with_hashes_only() {
    let out = json!({"path": "src/a.rs", "operation": "modify", "preSha256": "aa", "postSha256": "bb",
                     "content": "TOP-SECRET-FILE-CONTENT"});
    let f = ReceiptFacts::from_result(
        "fs_edit",
        &json!({"path": "src/a.rs", "newText": "TOP-SECRET-FILE-CONTENT"}),
        Some(&out),
        None,
    );
    let d = tempfile::tempdir().unwrap();
    let l = run_one(d.path(), act(1, "fs_edit", "executed", Some("e1")), Some(f));
    let m = l.records()[0].mutation.clone().unwrap();
    assert_eq!(m.pre_sha256.as_deref(), Some("aa"));
    assert_eq!(m.post_sha256.as_deref(), Some("bb"));
    assert_eq!(l.records()[0].kind, ObservationKind::FileMutation);
}

#[test]
fn replay_does_not_duplicate_evidence() {
    let d = tempfile::tempdir().unwrap();
    for _ in 0..3 {
        // a restarted recorder replays the same authoritative event
        run_one(
            d.path(),
            act(1, "proc_run", "executed", Some("e1")),
            Some(proc_facts(cmd("cargo", &["test"]), 0, "pass")),
        );
    }
    let raw = std::fs::read_to_string(d.path().join("verification").join(format!("{RUN}.jsonl")))
        .unwrap();
    assert_eq!(raw.lines().count(), 1);
    // same recorder observing the same slice twice
    let rec = ShadowRecorder::new(d.path(), RUN, true);
    let a = act(1, "proc_run", "executed", Some("e1"));
    rec.observe(std::slice::from_ref(&a), &BTreeMap::new());
    rec.observe(&[a], &BTreeMap::new());
    assert_eq!(rec.len(), 1);
}

#[test]
fn evidence_survives_reload_and_reconstruction_is_deterministic() {
    let d = tempfile::tempdir().unwrap();
    let rec = ShadowRecorder::new(d.path(), RUN, true);
    let acts = vec![
        act(1, "fs_edit", "executed", Some("e1")),
        act(2, "proc_run", "executed", Some("e2")),
        act(3, "proc_run", "failed", Some("e3")),
        act(4, "fs_read", "executed", Some("e4")), // not verification-relevant
    ];
    let mut facts = BTreeMap::new();
    facts.insert(2, proc_facts(cmd("cargo", &["test"]), 0, "pass"));
    facts.insert(3, proc_facts(cmd("cargo", &["test"]), 1, "fail"));
    rec.observe(&acts, &facts);
    let a = persistence::load(d.path(), RUN);
    let b = persistence::load(d.path(), RUN);
    assert!(a.is_intact());
    assert_eq!(a.ledger.len(), 3);
    let ids = |l: &persistence::Loaded| {
        l.ledger
            .records()
            .iter()
            .map(|r| r.evidence_id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&a), ids(&b));
    assert_eq!(a.ledger.check_exit_zero_count(), 1);
    assert_eq!(
        a.ledger
            .records()
            .iter()
            .map(|r| r.call_index)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
}

#[test]
fn corrupt_or_incomplete_evidence_is_not_read_as_success() {
    let d = tempfile::tempdir().unwrap();
    run_one(
        d.path(),
        act(1, "proc_run", "executed", Some("e1")),
        Some(proc_facts(cmd("cargo", &["test"]), 0, "pass")),
    );
    let p = d.path().join("verification").join(format!("{RUN}.jsonl"));
    let good = std::fs::read_to_string(&p).unwrap();
    // tampered body: exit code flipped keeps the line well-formed but the checksum fails
    let tampered = good.replace(
        "\\\"kernelVerdict\\\":\\\"pass\\\"",
        "\\\"kernelVerdict\\\":\\\"PASS\\\"",
    );
    assert_ne!(tampered, good);
    // torn write
    let torn = &good[..good.len() / 2];
    // a future schema version
    let future = good.replacen("\"v\":2", "\"v\":9", 1);
    for (bad, reason) in [
        (tampered, "checksum-mismatch"),
        (torn.to_owned(), "damaged"),
        (future, "unsupported-version"),
    ] {
        std::fs::write(&p, bad).unwrap();
        let l = persistence::load(d.path(), RUN);
        assert!(!l.is_intact());
        assert_eq!(l.unreadable[0].reason, reason);
        assert_eq!(l.ledger.len(), 0);
        assert_eq!(l.ledger.check_exit_zero_count(), 0);
    }
    // a missing log is empty, not a success
    let l = persistence::load(d.path(), "run_00000000000000000000000000000002");
    assert!(l.ledger.is_empty());
    // a run id that is not a safe file name is refused
    assert!(persistence::load(d.path(), "../x").ledger.is_empty());
}

#[test]
fn cancelled_and_uncertain_calls_keep_truthful_outcomes() {
    let d = tempfile::tempdir().unwrap();
    let rec = ShadowRecorder::new(d.path(), RUN, true);
    let mut c = act(1, "proc_run", "cancelled", None);
    c.error_code = None;
    let mut c2 = act(2, "proc_run", "failed", Some("e2"));
    c2.error_code = Some("run-cancelled".into());
    let u = act(3, "fs_write", "uncertain", None);
    let mut facts = BTreeMap::new();
    facts.insert(1, proc_facts(cmd("cargo", &["test"]), 0, "pass"));
    rec.observe(&[c, c2, u], &facts);
    let l = persistence::load(d.path(), RUN).ledger;
    let st: Vec<_> = l.records().iter().map(|r| r.execution).collect();
    assert_eq!(
        st,
        vec![
            ExecutionState::Cancelled,
            ExecutionState::Cancelled,
            ExecutionState::Uncertain
        ]
    );
    assert_eq!(l.check_exit_zero_count(), 0);
    assert!(l.records().iter().all(|r| r.mutation.is_none()));
}

#[test]
fn ledger_never_copies_arguments_or_output() {
    let d = tempfile::tempdir().unwrap();
    let args = json!({"program": "sh", "args": ["-c", "API_TOKEN=sk-live-123 npm test"], "env": {"K": "sk-live-123"}});
    let out = json!({"exitCode": 0, "verification": "pass", "stdout": "SECRET-OUTPUT-xyz sk-live-123",
                     "stderr": "sk-live-123"});
    let f = ReceiptFacts::from_result("proc_run", &args, Some(&out), Some(true));
    run_one(
        d.path(),
        act(1, "proc_run", "executed", Some("e1")),
        Some(f),
    );
    let raw = std::fs::read_to_string(d.path().join("verification").join(format!("{RUN}.jsonl")))
        .unwrap();
    for needle in [
        "sk-live-123",
        "SECRET-OUTPUT",
        "API_TOKEN",
        "npm test",
        "stdout",
    ] {
        assert!(!raw.contains(needle), "{needle}");
    }
}

#[test]
fn legacy_activity_records_and_absent_logs_remain_readable() {
    // a ToolActivity written before any verification field existed
    let old = r#"{"index":1,"turn":1,"callId":"c","tool":"proc_run","argsSummary":"x","status":"executed","errorCode":null,"resultBytes":3,"resultDigest":null,"truncated":false,"executionId":null,"journalSeq":null,"argsDigest":null}"#;
    let a: ToolActivity = serde_json::from_str(old).unwrap();
    // without a receipt it is recorded as broker-outcome, never as execution evidence
    let d = tempfile::tempdir().unwrap();
    let l = run_one(d.path(), a, None);
    assert!(!l.records()[0].is_execution_evidence());
    assert!(persistence::load(d.path(), "run_00000000000000000000000000000009").is_intact());
}

#[test]
fn persistence_failure_is_a_diagnostic_not_a_panic_or_success() {
    let d = tempfile::tempdir().unwrap();
    // a regular file where the log directory must be
    std::fs::write(d.path().join("verification"), b"x").unwrap();
    let rec = ShadowRecorder::new(d.path(), RUN, true);
    rec.observe(
        &[act(1, "proc_run", "executed", Some("e1"))],
        &BTreeMap::new(),
    );
    assert_eq!(
        rec.len(),
        0,
        "unpersisted evidence must not be kept as recorded"
    );
}

#[test]
fn schema_carries_no_requirement_verdict() {
    let f = proc_facts(cmd("cargo", &["test"]), 0, "pass");
    let l = run_one(
        tempfile::tempdir().unwrap().path(),
        act(1, "proc_run", "executed", Some("e1")),
        Some(f),
    );
    let j = serde_json::to_string(l.records()[0])
        .unwrap()
        .to_lowercase();
    for w in ["satisf", "requirement", "correct", "\"passed\""] {
        assert!(!j.contains(w), "{w}");
    }
}

#[test]
fn a_record_appended_after_a_torn_line_is_not_lost() {
    let d = tempfile::tempdir().unwrap();
    run_one(
        d.path(),
        act(1, "proc_run", "executed", Some("e1")),
        Some(proc_facts(cmd("cargo", &["test"]), 0, "pass")),
    );
    let p = d.path().join("verification").join(format!("{RUN}.jsonl"));
    let good = std::fs::read_to_string(&p).unwrap();
    // crash mid-write of a second record: no newline
    std::fs::write(&p, format!("{good}{}", good[..good.len() / 2].trim_end())).unwrap();
    let rec = ShadowRecorder::new(d.path(), RUN, true);
    rec.observe(
        &[act(2, "fs_edit", "executed", Some("e2"))],
        &BTreeMap::new(),
    );
    let l = persistence::load(d.path(), RUN);
    assert_eq!(l.ledger.len(), 2, "the good records survive");
    assert_eq!(
        l.unreadable.len(),
        1,
        "the torn line is reported, not interpreted"
    );
}

// ─── Phase 03: target identity and freshness ────────────────────────────────

pub(crate) mod phase03 {
    use super::*;
    use crate::verification::freshness::{self, Freshness};
    use crate::verification::shadow::FinalChangeSet;
    use crate::verification::target::{Baseline, WorkspaceBinding, WorkspaceKind};

    const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

    pub(crate) fn isolated() -> WorkspaceBinding {
        WorkspaceBinding {
            kind: WorkspaceKind::Isolated,
            task_instance_id: Some("inst_1".into()),
            baseline_commit: Some(HEAD.into()),
            baseline: Baseline::Fresh,
            in_place_execution: false,
        }
    }

    pub(crate) struct Run {
        /// the workspace directory the run-end attestation reads
        pub(crate) root: tempfile::TempDir,
        pub(crate) dir: tempfile::TempDir,
        pub(crate) rec: ShadowRecorder,
        pub(crate) acts: Vec<ToolActivity>,
        pub(crate) facts: BTreeMap<u32, ReceiptFacts>,
    }

    impl Run {
        pub(crate) fn new(b: WorkspaceBinding) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = tempfile::tempdir().unwrap();
            let rec = ShadowRecorder::new(dir.path(), RUN, true);
            rec.set_task("task_1", "inst_1");
            rec.set_workspace(b, Some(root.path()));
            Self {
                root,
                dir,
                rec,
                acts: vec![],
                facts: BTreeMap::new(),
            }
        }
        pub(crate) fn push(&mut self, mut a: ToolActivity, f: Option<ReceiptFacts>) -> u32 {
            a.index = self.acts.len() as u32 + 1;
            a.execution_id = a.execution_id.or_else(|| {
                (a.status == "executed" || a.status == "failed")
                    .then(|| format!("exec-{}", a.index))
            });
            a.journal_seq = a.execution_id.as_ref().map(|_| a.index as i64);
            if let Some(f) = f {
                self.facts.insert(a.index, f);
            }
            let i = a.index;
            self.acts.push(a);
            self.rec.observe(&self.acts, &self.facts);
            i
        }
        pub(crate) fn edit(
            &mut self,
            path: &str,
            op: &str,
            pre: Option<&str>,
            post: Option<&str>,
        ) -> u32 {
            let out = json!({"path": path, "operation": op, "preSha256": pre, "postSha256": post});
            let f = ReceiptFacts::from_result("fs_edit", &json!({}), Some(&out), None);
            let mut a = act(0, "fs_edit", "executed", None);
            a.args_digest = Some(format!("edit-{path}-{post:?}"));
            self.push(a, Some(f))
        }
        /// An edit whose receipt hash is the real hash of the bytes now on disk.
        pub(crate) fn edit_real(&mut self, path: &str, content: &str) -> u32 {
            use sha2::{Digest, Sha256};
            let f = self.root.path().join(path);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            let pre = f.exists().then(|| "pre".to_owned());
            std::fs::write(&f, content).unwrap();
            let post = hex::encode(Sha256::digest(content.as_bytes()));
            self.edit(
                path,
                if pre.is_some() { "edit" } else { "create" },
                pre.as_deref(),
                Some(&post),
            )
        }
        pub(crate) fn check(
            &mut self,
            program: &str,
            args: &[&str],
            exit: i64,
            verdict: &str,
        ) -> u32 {
            let status = if verdict == "fail" {
                "failed"
            } else {
                "executed"
            };
            let mut a = act(0, "proc_run", status, None);
            a.args_digest = Some(format!("{program} {args:?}"));
            self.push(a, Some(proc_facts(cmd(program, args), exit, verdict)))
        }
        pub(crate) fn report(&self) -> Vec<freshness::FreshnessEntry> {
            self.rec.freshness_report()
        }
        pub(crate) fn state_of(&self, idx: u32) -> Freshness {
            self.report()
                .into_iter()
                .find(|e| e.call_index == idx)
                .unwrap()
                .freshness
        }
        pub(crate) fn finish(&self, paths: &[&str], truncated: bool) {
            let p: Vec<String> = paths.iter().map(|s| (*s).to_owned()).collect();
            self.rec.finish(&FinalChangeSet {
                available: true,
                truncated,
                paths: &p,
                diff_digest: Some("dd"),
            });
        }
    }

    #[test]
    fn a_passing_check_stays_current_without_relevant_changes() {
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 0, "pass");
        assert_eq!(r.state_of(c), Freshness::Current);
        // mutation-free tools in between change nothing
        r.push(act(0, "fs_read", "executed", None), None);
        assert_eq!(r.state_of(c), Freshness::Current);
    }

    #[test]
    fn an_authorized_edit_stales_earlier_evidence_and_a_rerun_is_current() {
        let mut r = Run::new(isolated());
        let c1 = r.check("cargo", &["test"], 0, "pass");
        r.edit("src/a.rs", "edit", Some("h0"), Some("h1"));
        assert!(matches!(r.state_of(c1), Freshness::Stale { .. }));
        let c2 = r.check("cargo", &["test"], 0, "pass");
        assert!(
            matches!(r.state_of(c1), Freshness::Stale { .. }),
            "history is kept, not rewritten"
        );
        assert_eq!(r.state_of(c2), Freshness::Current);
        // the original result is still reported as it was
        let rep = r.report();
        assert_eq!(rep[0].original_result, "process-exited-zero");
        assert_ne!(rep[0].recorded_target, rep[1].recorded_target);
        assert_eq!(rep[1].recorded_target, rep[1].current_target);
        // no tool was run to produce any of this
        assert_eq!(persistence::load(r.dir.path(), RUN).ledger.len(), 3);
    }

    #[test]
    fn a_failed_check_stays_a_failure_after_later_edits() {
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 101, "fail");
        assert_eq!(r.state_of(c), Freshness::Current);
        assert_eq!(r.report()[0].original_result, "process-failed");
        r.edit("src/a.rs", "edit", Some("h0"), Some("h1"));
        assert!(matches!(r.state_of(c), Freshness::Stale { .. }));
        let rec = persistence::load(r.dir.path(), RUN).ledger;
        let f = rec
            .records()
            .into_iter()
            .find(|e| e.call_index == c)
            .unwrap();
        assert_eq!(
            f.check.as_ref().unwrap().outcome,
            CheckOutcome::ProcessFailed
        );
    }

    #[test]
    fn unchanged_git_head_does_not_make_edited_source_current() {
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 0, "pass");
        r.edit("src/a.rs", "edit", Some("h0"), Some("h1"));
        let l = persistence::load(r.dir.path(), RUN).ledger;
        // every record names the SAME baseline commit; identity still differs
        let commits: std::collections::BTreeSet<_> = l
            .records()
            .iter()
            .filter_map(|e| e.target.as_ref()?.workspace.baseline_commit.clone())
            .collect();
        assert_eq!(commits.len(), 1);
        assert!(matches!(r.state_of(c), Freshness::Stale { .. }));
    }

    #[test]
    fn a_new_untracked_file_and_a_revert_are_content_identities() {
        let mut r = Run::new(isolated());
        let c0 = r.check("cargo", &["test"], 0, "pass");
        r.edit("src/new.rs", "create", None, Some("n1")); // untracked file
        assert!(matches!(r.state_of(c0), Freshness::Stale { .. }));
        let c1 = r.check("cargo", &["test"], 0, "pass");
        r.edit("src/new.rs", "delete", Some("n1"), None); // gone again
                                                          // back to the starting content: the first check applies again, the second does not
        assert_eq!(r.state_of(c0), Freshness::Current);
        assert!(matches!(r.state_of(c1), Freshness::Stale { .. }));
        // A -> B -> A on a pre-existing file
        r.edit("src/a.rs", "edit", Some("a"), Some("b"));
        r.edit("src/a.rs", "edit", Some("b"), Some("a"));
        assert_eq!(r.state_of(c0), Freshness::Current);
    }

    #[test]
    fn unknown_scope_never_yields_a_narrow_or_current_claim() {
        let mut r = Run::new(isolated());
        let out = r.check(
            "cargo",
            &["test", "--manifest-path", "/elsewhere/Cargo.toml"],
            0,
            "pass",
        );
        assert!(matches!(r.state_of(out), Freshness::Indeterminate { .. }));
        let up = r.check(
            "cargo",
            &["test", "--manifest-path=../x/Cargo.toml"],
            0,
            "pass",
        );
        assert!(matches!(r.state_of(up), Freshness::Indeterminate { .. }));
        // a package filter or subdirectory does NOT narrow the scope: an edit anywhere stales it
        let sub = r.check("cargo", &["test", "-p", "a"], 0, "pass");
        assert_eq!(r.state_of(sub), Freshness::Current);
        r.edit("crates/b/src/lib.rs", "edit", Some("x"), Some("y"));
        assert!(matches!(r.state_of(sub), Freshness::Stale { .. }));
    }

    #[test]
    fn opaque_shell_and_interrupted_checks_are_never_trusted_results() {
        let mut r = Run::new(isolated());
        r.check("sh", &["-c", "npm test || true"], 0, "pass");
        let mut cancelled = act(0, "proc_run", "cancelled", None);
        cancelled.error_code = None;
        r.push(cancelled, None);
        let mut unc = act(0, "proc_run", "uncertain", None);
        unc.error_code = Some("tool-outcome-uncertain".into());
        r.push(unc, None);
        assert!(r.report().is_empty(), "{:?}", r.report());
    }

    #[test]
    fn incomplete_source_identity_is_indeterminate_never_current() {
        // a receipt with no post-image hash
        let mut r = Run::new(isolated());
        let c0 = r.check("cargo", &["test"], 0, "pass");
        r.edit("src/a.rs", "edit", Some("a"), None);
        let c1 = r.check("cargo", &["test"], 0, "pass");
        for c in [c0, c1] {
            assert!(
                matches!(r.state_of(c), Freshness::Indeterminate { .. }),
                "{c}"
            );
        }
        // a write whose outcome is unknown poisons identity for the rest of the run
        let mut r = Run::new(isolated());
        let c0 = r.check("cargo", &["test"], 0, "pass");
        r.push(act(0, "fs_write", "uncertain", None), None);
        let c1 = r.check("cargo", &["test"], 0, "pass");
        assert!(matches!(r.state_of(c0), Freshness::Indeterminate { .. }));
        assert!(matches!(r.state_of(c1), Freshness::Indeterminate { .. }));
    }

    #[test]
    fn other_possible_writers_make_equal_identities_indeterminate_but_changes_still_stale() {
        for (kind, in_place) in [
            (WorkspaceKind::Direct, false),
            (WorkspaceKind::Isolated, true),
            (WorkspaceKind::Unknown, false),
        ] {
            let mut b = isolated();
            b.kind = kind;
            b.in_place_execution = in_place;
            let mut r = Run::new(b);
            let c = r.check("cargo", &["test"], 0, "pass");
            assert!(
                matches!(r.state_of(c), Freshness::Indeterminate { .. }),
                "{kind:?}"
            );
            r.edit("src/a.rs", "edit", Some("a"), Some("b"));
            assert!(matches!(r.state_of(c), Freshness::Stale { .. }), "{kind:?}");
        }
        // a background job in the run
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 0, "pass");
        r.push(act(0, "job_start", "executed", None), None);
        assert!(
            matches!(r.state_of(c), Freshness::Indeterminate { .. }),
            "a job may write at any time after it starts, so earlier evidence is no longer demonstrably current"
        );
        let c2 = r.check("cargo", &["test"], 0, "pass");
        assert!(matches!(r.state_of(c2), Freshness::Indeterminate { .. }));
    }

    #[test]
    fn a_change_no_receipt_explains_found_at_run_end_is_not_current() {
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 0, "pass");
        r.edit("src/a.rs", "edit", Some("a"), Some("b"));
        let c2 = r.check("cargo", &["test"], 0, "pass");
        // the daemon's change set holds src/a.rs (receipted) and src/sneaky.rs (not)
        r.finish(&["src/a.rs", "src/sneaky.rs"], false);
        assert!(matches!(r.state_of(c2), Freshness::Indeterminate { .. }));
        assert!(matches!(r.state_of(c), Freshness::Stale { .. }));
        // the boundary record says why
        let l = persistence::load(r.dir.path(), RUN).ledger;
        let b = l
            .records()
            .into_iter()
            .find_map(|e| e.boundary.clone())
            .unwrap();
        assert!(b.cross_check);
        assert_eq!(b.unreceipted_paths, 1);
        // an explained change set whose file contents match their receipts leaves it current
        let mut r = Run::new(isolated());
        r.edit_real("src/a.rs", "fn a() {}\n");
        let c = r.check("cargo", &["test"], 0, "pass");
        assert_eq!(r.report()[0].basis, freshness::Basis::ReceiptConsistent);
        r.finish(&["src/a.rs"], false);
        assert_eq!(r.state_of(c), Freshness::Current);
        assert_eq!(r.report()[0].basis, freshness::Basis::Attested);
        // a truncated change set cannot cross-check: said so, not guessed either way
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 0, "pass");
        r.finish(&["x"], true);
        assert_eq!(r.state_of(c), Freshness::Current);
        let l = persistence::load(r.dir.path(), RUN).ledger;
        let b = l
            .records()
            .into_iter()
            .find_map(|e| e.boundary.clone())
            .unwrap();
        assert!(!b.cross_check && b.unavailable.as_deref() == Some("change-set-truncated"));
    }

    #[test]
    fn version_1_records_are_readable_and_never_current() {
        let dir = tempfile::tempdir().unwrap();
        // a record exactly as the Phase 01/02 build wrote it: no target, no scope, schema 1
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 0, "pass");
        let l = persistence::load(r.dir.path(), RUN).ledger;
        let mut v: serde_json::Value =
            serde_json::to_value(l.records().into_iter().find(|e| e.call_index == c).unwrap())
                .unwrap();
        let o = v.as_object_mut().unwrap();
        o.remove("target");
        o["schemaVersion"] = json!(1);
        let chk = o["check"].as_object_mut().unwrap();
        chk.remove("scope");
        chk.remove("identity");
        let p = dir.path().join("verification").join(format!("{RUN}.jsonl"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            &p,
            format!("{}\n", persistence::encode_raw(v.to_string(), 1).unwrap()),
        )
        .unwrap();
        let loaded = persistence::load(dir.path(), RUN);
        assert!(loaded.is_intact(), "{:?}", loaded.unreadable);
        assert_eq!(loaded.ledger.len(), 1);
        let rep = freshness::report(&loaded.ledger);
        assert_eq!(rep.len(), 1);
        assert!(
            matches!(&rep[0].freshness, Freshness::Indeterminate { reason } if reason == "no-target-identity-recorded"),
            "{:?}",
            rep[0].freshness
        );
        // new records appended after old ones coexist
        let rec = ShadowRecorder::new(dir.path(), RUN, true);
        rec.set_workspace(isolated(), None);
        rec.observe(
            &[act(2, "proc_run", "executed", Some("e2"))],
            &BTreeMap::from([(2, proc_facts(cmd("cargo", &["test"]), 0, "pass"))]),
        );
        assert_eq!(persistence::load(dir.path(), RUN).ledger.len(), 2);
    }

    #[test]
    fn replay_preserves_identity_and_adds_nothing() {
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 0, "pass");
        r.edit("src/a.rs", "edit", Some("a"), Some("b"));
        let c2 = r.check("cargo", &["test"], 0, "pass");
        r.finish(&["src/a.rs"], false);
        let before = r.report();
        let lines_before = std::fs::read_to_string(
            r.dir
                .path()
                .join("verification")
                .join(format!("{RUN}.jsonl")),
        )
        .unwrap()
        .lines()
        .count();
        // a restarted recorder replays the whole activity: nothing is added, identity is rebuilt
        let again = ShadowRecorder::new(r.dir.path(), RUN, true);
        again.set_task("task_1", "inst_1");
        again.set_workspace(isolated(), None);
        again.observe(&r.acts, &r.facts);
        again.finish(&FinalChangeSet {
            available: true,
            truncated: false,
            paths: &["src/a.rs".to_owned()],
            diff_digest: Some("dd"),
        });
        let lines_after = std::fs::read_to_string(
            r.dir
                .path()
                .join("verification")
                .join(format!("{RUN}.jsonl")),
        )
        .unwrap()
        .lines()
        .count();
        assert_eq!(lines_before, lines_after);
        let strip = |v: Vec<freshness::FreshnessEntry>| {
            v.into_iter()
                .map(|e| {
                    (
                        e.call_index,
                        e.recorded_target,
                        e.current_target,
                        e.freshness,
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(strip(before), strip(again.freshness_report()));
        // and a mutation made after the restart continues the same identity chain
        let mut acts = r.acts.clone();
        let mut a = act(4, "fs_edit", "executed", Some("e4"));
        a.args_digest = Some("x".into());
        acts.push(a);
        let mut facts = r.facts.clone();
        let out =
            json!({"path": "src/a.rs", "operation": "edit", "preSha256": "b", "postSha256": "c"});
        facts.insert(
            4,
            ReceiptFacts::from_result("fs_edit", &json!({}), Some(&out), None),
        );
        again.observe(&acts, &facts);
        let rep = again.freshness_report();
        assert!(
            rep.iter()
                .all(|e| matches!(e.freshness, Freshness::Stale { .. })),
            "{rep:?}"
        );
        let _ = (c, c2);
    }

    #[test]
    fn diagnostics_read_like_the_spec_and_hold_no_content() {
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 0, "pass");
        r.edit("src/a.rs", "edit", Some("a"), Some("b"));
        let e = r.report().into_iter().find(|e| e.call_index == c).unwrap();
        let text = e.to_string();
        for needle in [
            "Check: cargo-test",
            "Execution: exec-",
            "Original result: process-exited-zero",
            "Recorded target: source:",
            "Current target: source:",
            "Freshness: stale",
        ] {
            assert!(text.contains(needle), "{needle} in\n{text}");
        }
    }

    #[test]
    fn target_records_name_what_is_not_observed() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 0, "pass");
        let l = persistence::load(r.dir.path(), RUN).ledger;
        let t = l.records()[0].target.clone().unwrap();
        assert_eq!(t.version, 1);
        assert_eq!(t.source_model, "receipt-delta/v1");
        assert!(
            t.environment.is_none() && t.runtime.is_none(),
            "unobserved stays unknown"
        );
        assert_eq!(t.workspace.baseline_commit.as_deref(), Some(HEAD));
    }

    #[test]
    fn an_outside_write_to_an_already_receipted_path_is_not_current() {
        // the changed PATH is the same either way; only the bytes differ
        let mut r = Run::new(isolated());
        r.edit_real("src/app.tsx", "const v = 'B';\n");
        let c = r.check("cargo", &["test"], 0, "pass");
        std::fs::write(r.root.path().join("src/app.tsx"), "const v = 'C';\n").unwrap();
        r.finish(&["src/app.tsx"], false);
        let l = persistence::load(r.dir.path(), RUN).ledger;
        let b = l
            .records()
            .into_iter()
            .find_map(|e| e.boundary.clone())
            .unwrap();
        assert_eq!(b.unreceipted_paths, 0, "membership sees nothing wrong");
        assert_eq!(
            b.attestation,
            crate::verification::attest::Attestation::Mismatch { paths: 1 }
        );
        assert!(
            matches!(r.state_of(c), Freshness::Indeterminate { reason } if reason.contains("differs-from-its-receipt"))
        );
    }

    #[test]
    fn attestation_confirms_absence_for_deletes_and_refuses_unsafe_reads() {
        use crate::verification::attest::{attest, Attestation};
        let root = tempfile::tempdir().unwrap();
        // a receipted delete: the file must be gone
        assert_eq!(
            attest(root.path(), [("gone.rs", None)]),
            Attestation::Attested { files: 1 }
        );
        std::fs::write(root.path().join("gone.rs"), "x").unwrap();
        assert_eq!(
            attest(root.path(), [("gone.rs", None)]),
            Attestation::Mismatch { paths: 1 }
        );
        // a symlink in the path is never followed
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        assert!(matches!(
            attest(root.path(), [("link/secret", Some("00"))]),
            Attestation::Unavailable { .. }
        ));
        std::os::unix::fs::symlink(outside.path().join("secret"), root.path().join("leaf"))
            .unwrap();
        assert!(matches!(
            attest(root.path(), [("leaf", Some("00"))]),
            Attestation::Unavailable { .. }
        ));
        // no workspace directory known: nothing is claimed
        let mut r = Run::new(isolated());
        let rec = ShadowRecorder::new(r.dir.path(), "run_00000000000000000000000000000077", true);
        rec.set_workspace(isolated(), None);
        let _ = &mut r;
        rec.finish(&FinalChangeSet {
            available: true,
            truncated: false,
            paths: &[],
            diff_digest: None,
        });
        let l = persistence::load(r.dir.path(), "run_00000000000000000000000000000077").ledger;
        let b = l
            .records()
            .into_iter()
            .find_map(|e| e.boundary.clone())
            .unwrap();
        assert!(matches!(b.attestation, Attestation::Unavailable { .. }));
    }

    // ─── Phase 04: reconciliation ───────────────────────────────────────────

    use crate::verification::reconcile::{evaluate, RunFacts};

    fn summary(r: &Run) -> nexus_client::intent_client::VerificationSummary {
        evaluate(
            r.dir.path(),
            RUN,
            &RunFacts {
                code_run: true,
                tool_calls: r.acts.len() as u32,
            },
        )
    }

    fn done(r: &Run, paths: &[&str]) {
        r.finish(paths, false);
    }

    #[test]
    fn a_change_without_any_check_is_unverified() {
        let mut r = Run::new(isolated());
        r.edit_real("src/a.rs", "fn a() {}\n");
        done(&r, &["src/a.rs"]);
        let s = summary(&r);
        assert_eq!(s.verdict, "unverified");
        assert_eq!((s.current_passing, s.checks.len()), (0, 0));
        assert_eq!(s.acceptance, "not-assessed");
        // a run that did nothing verifiable is unverified, never verified
        let r = Run::new(isolated());
        done(&r, &[]);
        assert_eq!(summary(&r).verdict, "unverified");
    }

    #[test]
    fn one_current_check_is_scoped_evidence_not_task_correctness() {
        let mut r = Run::new(isolated());
        r.edit_real("src/a.rs", "fn a() {}\n");
        r.check("cargo", &["test"], 0, "pass");
        done(&r, &["src/a.rs"]);
        let s = summary(&r);
        assert_eq!(s.verdict, "verified-within-scope");
        assert_eq!((s.current_passing, s.stale, s.indeterminate), (1, 0, 0));
        assert_eq!(s.checks[0].check, "cargo-test");
        assert_eq!(
            (
                s.checks[0].result.as_str(),
                s.checks[0].freshness.as_str(),
                s.checks[0].basis.as_str()
            ),
            ("process-exited-zero", "current", "attested")
        );
        assert_eq!(
            s.acceptance, "not-assessed",
            "a passing check is not acceptance"
        );
        for l in [
            "no-acceptance-contract",
            "environment-and-toolchain-unobserved",
        ] {
            assert!(
                s.limitations.iter().any(|x| x == l),
                "{l}: {:?}",
                s.limitations
            );
        }
        let j = serde_json::to_string(&s).unwrap().to_lowercase();
        for w in ["task-satisfied", "requirements-met", "\"verified\""] {
            assert!(!j.contains(w), "{w}");
        }
    }

    #[test]
    fn a_later_mutation_makes_the_passing_check_stale_and_the_run_unverified() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 0, "pass");
        r.edit_real("src/a.rs", "fn a() {}\n");
        done(&r, &["src/a.rs"]);
        let s = summary(&r);
        assert_eq!(s.verdict, "unverified");
        assert_eq!((s.current_passing, s.stale), (0, 1));
        assert_eq!(s.checks[0].freshness, "stale");
        assert_eq!(
            s.checks[0].result, "process-exited-zero",
            "history is not rewritten"
        );
    }

    #[test]
    fn an_externally_modified_receipted_file_is_inconclusive_not_verified() {
        let mut r = Run::new(isolated());
        r.edit_real("src/app.tsx", "B\n");
        r.check("cargo", &["test"], 0, "pass");
        std::fs::write(r.root.path().join("src/app.tsx"), "C\n").unwrap();
        done(&r, &["src/app.tsx"]);
        let s = summary(&r);
        assert_eq!(s.verdict, "inconclusive");
        assert_eq!((s.current_passing, s.indeterminate), (0, 1));
    }

    #[test]
    fn a_current_failure_is_reported_as_failed_verification() {
        let mut r = Run::new(isolated());
        r.edit_real("src/a.rs", "fn a() {}\n");
        r.check("cargo", &["test"], 101, "fail");
        r.check("cargo", &["clippy"], 0, "pass");
        done(&r, &["src/a.rs"]);
        let s = summary(&r);
        assert_eq!(
            s.verdict, "failed-verification",
            "a pass elsewhere does not cancel a failure"
        );
        assert_eq!((s.current_failing, s.current_passing), (1, 1));
    }

    #[test]
    fn a_rerun_of_the_same_check_supersedes_an_older_failure_but_history_stays() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        r.edit_real("src/a.rs", "fn a() {}\n");
        r.check("cargo", &["test"], 0, "pass");
        done(&r, &["src/a.rs"]);
        let s = summary(&r);
        assert_eq!(s.verdict, "verified-within-scope");
        assert_eq!(s.checks.len(), 1, "one line per check identity");
        assert!(
            s.limitations
                .iter()
                .any(|l| l == "earlier-failures-superseded-by-rerun:1"),
            "{:?}",
            s.limitations
        );
        let l = persistence::load(r.dir.path(), RUN).ledger;
        assert_eq!(
            l.records().iter().filter(|e| e.check.is_some()).count(),
            2,
            "both executions remain recorded"
        );
        // a DIFFERENT check passing does not supersede a failure of another one (case 5 above)
        // and a stale failure that was never rerun does not make the current source "failed"
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        r.edit_real("src/a.rs", "fn a() {}\n");
        done(&r, &["src/a.rs"]);
        assert_eq!(summary(&r).verdict, "unverified");
    }

    #[test]
    fn opaque_and_interrupted_commands_never_become_trusted_passes() {
        let mut r = Run::new(isolated());
        r.check("sh", &["-c", "npm test || true"], 0, "pass");
        r.push(act(0, "proc_run", "cancelled", None), None);
        let mut unc = act(0, "proc_run", "uncertain", None);
        unc.error_code = Some("tool-outcome-uncertain".into());
        r.push(unc, None);
        done(&r, &[]);
        let s = summary(&r);
        assert_eq!(s.verdict, "unverified");
        assert_eq!(s.current_passing, 0);
        for l in [
            "opaque-check-commands-not-trusted:1",
            "interrupted-commands:2",
        ] {
            assert!(
                s.limitations.iter().any(|x| x == l),
                "{l}: {:?}",
                s.limitations
            );
        }
    }

    #[test]
    fn a_partly_current_run_is_partially_verified_and_indeterminate_alone_is_inconclusive() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["clippy"], 0, "pass");
        r.edit_real("src/a.rs", "fn a() {}\n");
        r.check("cargo", &["test"], 0, "pass");
        done(&r, &["src/a.rs"]);
        let s = summary(&r);
        assert_eq!(s.verdict, "partially-verified");
        assert_eq!((s.current_passing, s.stale), (1, 1));
        // Direct Workspace: source attestation unavailable
        let mut b = isolated();
        b.kind = WorkspaceKind::Direct;
        let mut r = Run::new(b);
        r.check("cargo", &["test"], 0, "pass");
        done(&r, &[]);
        let s = summary(&r);
        assert_eq!(s.verdict, "inconclusive");
        assert_eq!(s.checks[0].freshness, "indeterminate");
        assert!(s.checks[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("direct-workspace"));
    }

    #[test]
    fn legacy_evidence_without_target_metadata_is_inconclusive() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Run::new(isolated());
        let c = r.check("cargo", &["test"], 0, "pass");
        let l = persistence::load(r.dir.path(), RUN).ledger;
        let mut v =
            serde_json::to_value(l.records().into_iter().find(|e| e.call_index == c).unwrap())
                .unwrap();
        let o = v.as_object_mut().unwrap();
        o.remove("target");
        o["schemaVersion"] = json!(1);
        let p = dir.path().join("verification").join(format!("{RUN}.jsonl"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            &p,
            format!("{}\n", persistence::encode_raw(v.to_string(), 1).unwrap()),
        )
        .unwrap();
        let s = evaluate(
            dir.path(),
            RUN,
            &RunFacts {
                code_run: true,
                tool_calls: 1,
            },
        );
        assert_eq!(s.verdict, "inconclusive");
        assert_eq!(
            s.checks[0].reason.as_deref(),
            Some("no-target-identity-recorded")
        );
    }

    #[test]
    fn a_damaged_or_missing_ledger_never_becomes_verification() {
        let mut r = Run::new(isolated());
        r.edit_real("src/a.rs", "fn a() {}\n");
        r.check("cargo", &["test"], 0, "pass");
        done(&r, &["src/a.rs"]);
        assert_eq!(summary(&r).verdict, "verified-within-scope");
        let p = r
            .dir
            .path()
            .join("verification")
            .join(format!("{RUN}.jsonl"));
        let good = std::fs::read_to_string(&p).unwrap();
        // one record damaged: everything from this ledger is inconclusive, however good the rest looks
        let mut lines: Vec<&str> = good.lines().collect();
        let broken = lines[1][..lines[1].len() / 2].to_owned();
        lines[1] = &broken;
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        let s = summary(&r);
        assert_eq!(s.verdict, "inconclusive");
        assert_eq!(s.ledger, "damaged");
        assert!(s
            .limitations
            .iter()
            .any(|l| l.starts_with("ledger-damaged")));
        // gone entirely although the run made tool calls
        std::fs::remove_file(&p).unwrap();
        let s = summary(&r);
        assert_eq!(
            (s.verdict.as_str(), s.ledger.as_str()),
            ("inconclusive", "absent")
        );
        // gone for a run that made no tool calls: nothing to lose, nothing verified
        let s = evaluate(
            r.dir.path(),
            RUN,
            &RunFacts {
                code_run: true,
                tool_calls: 0,
            },
        );
        assert_eq!(s.verdict, "unverified");
        // not a coding run at all
        let s = evaluate(
            r.dir.path(),
            RUN,
            &RunFacts {
                code_run: false,
                tool_calls: 3,
            },
        );
        assert_eq!(s.verdict, "not-applicable");
    }

    #[test]
    fn repeated_finalization_and_replay_give_the_identical_summary() {
        let mut r = Run::new(isolated());
        r.edit_real("src/a.rs", "fn a() {}\n");
        r.check("cargo", &["test"], 0, "pass");
        done(&r, &["src/a.rs"]);
        let first = summary(&r);
        done(&r, &["src/a.rs"]);
        assert_eq!(first, summary(&r), "finalizing twice changes nothing");
        // a restarted recorder replays everything and finalizes again
        let again = ShadowRecorder::new(r.dir.path(), RUN, true);
        again.set_task("task_1", "inst_1");
        again.set_workspace(isolated(), Some(r.root.path()));
        again.observe(&r.acts, &r.facts);
        again.finish(&FinalChangeSet {
            available: true,
            truncated: false,
            paths: &["src/a.rs".to_owned()],
            diff_digest: Some("dd"),
        });
        assert_eq!(first, summary(&r));
        assert!(first.evidence_digest.is_some());
        let lines = std::fs::read_to_string(
            r.dir
                .path()
                .join("verification")
                .join(format!("{RUN}.jsonl")),
        )
        .unwrap()
        .lines()
        .count();
        assert_eq!(lines, 3, "edit + check + boundary, once each");
    }

    // ─── Phase 05: feedback eligibility, identity and journal ───────────────

    use crate::verification::feedback::{self, Decision, Facts, JournalEntry, Stage};

    fn facts() -> Facts<'static> {
        Facts {
            task_instance: "inst_1",
            can_act: true,
            cancelled: false,
            room_for_another_turn: true,
            attested: true,
        }
    }

    fn decide(r: &Run) -> Decision {
        feedback::decide(r.dir.path(), RUN, &facts())
    }

    fn eligible(r: &Run) -> feedback::Eligible {
        match decide(r) {
            Decision::Eligible(e) => e,
            d => panic!("expected eligible, got {d:?}"),
        }
    }

    fn why(r: &Run) -> &'static str {
        match decide(r) {
            Decision::Ineligible(w) => w,
            d => panic!("expected ineligible, got {d:?}"),
        }
    }

    fn deliver(r: &Run, e: &feedback::Eligible) {
        let en = |stage| JournalEntry {
            key: e.key.clone(),
            stage,
            checks: e.checks.clone(),
        };
        feedback::record(r.dir.path(), RUN, &en(Stage::Prepared)).unwrap();
        feedback::record(r.dir.path(), RUN, &en(Stage::Admitted)).unwrap();
    }

    #[test]
    fn a_current_failing_check_is_eligible_with_a_concise_factual_message() {
        let mut r = Run::new(isolated());
        r.edit_real("src/a.rs", "fn a() {}\n");
        r.check("cargo", &["test"], 101, "fail");
        let e = eligible(&r);
        for needle in [
            "Nexus verification feedback",
            "Check: cargo-test",
            "Execution: exec-",
            "Result: failed (exit status 101)",
            "Freshness: current",
            "remains unresolved",
            "Do not claim this check passed without new execution evidence",
        ] {
            assert!(e.message.contains(needle), "{needle}\n{}", e.message);
        }
        assert!(e.message.len() < 1200, "concise: {} bytes", e.message.len());
        for leak in ["capability", "grant", "token", "approval"] {
            assert!(!e.message.to_lowercase().contains(leak), "{leak}");
        }
    }

    #[test]
    fn no_failure_means_no_feedback_and_no_invented_obligation() {
        let mut r = Run::new(isolated());
        assert_eq!(
            why(&r),
            "evidence-unavailable",
            "no log yet: fail closed, nothing is invented"
        );
        r.edit_real("src/a.rs", "fn a() {}\n");
        assert_eq!(
            why(&r),
            "no-current-failing-check",
            "a change without checks creates no obligation"
        );
        r.check("cargo", &["test"], 0, "pass");
        assert_eq!(
            why(&r),
            "no-current-failing-check",
            "a pass needs no feedback"
        );
        // an opaque command that failed is not a trusted check either
        r.check("sh", &["-c", "npm test || true"], 1, "fail");
        assert_eq!(why(&r), "no-current-failing-check");
    }

    #[test]
    fn the_same_state_is_never_fed_back_twice_but_observation_is_not_delivery() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        let e = eligible(&r);
        feedback::record(
            r.dir.path(),
            RUN,
            &JournalEntry {
                key: e.key.clone(),
                stage: Stage::Observed,
                checks: e.checks.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            eligible(&r).key,
            e.key,
            "an observation does not count as delivered"
        );
        deliver(&r, &e);
        assert_eq!(why(&r), "already-delivered-for-equivalent-state");
        // a repeated final answer, a replay, a reading tool: nothing relevant changed
        r.push(act(0, "fs_read", "executed", None), None);
        r.push(act(0, "fs_list", "executed", None), None);
        r.rec.observe(&r.acts, &r.facts);
        assert_eq!(why(&r), "already-delivered-for-equivalent-state");
        // rerunning the same check on the same source is not a new state either
        r.check("cargo", &["test"], 101, "fail");
        assert_eq!(why(&r), "already-delivered-for-equivalent-state");
    }

    #[test]
    fn a_changed_relevant_state_with_a_new_failure_may_be_fed_back_once_more() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        let first = eligible(&r);
        deliver(&r, &first);
        r.edit_real("src/a.rs", "fn a() { 1 }\n");
        assert_eq!(
            why(&r),
            "no-current-failing-check",
            "the old failure is stale; an edit alone is not new evidence"
        );
        r.check("cargo", &["test"], 101, "fail");
        let second = eligible(&r);
        assert_ne!(first.key, second.key);
        deliver(&r, &second);
        assert_eq!(why(&r), "already-delivered-for-equivalent-state");
    }

    #[test]
    fn a_rerun_that_passes_resolves_the_failure_and_stale_failures_are_not_current() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        let e = eligible(&r);
        deliver(&r, &e);
        r.edit_real("src/a.rs", "fn a() {}\n");
        assert_eq!(
            why(&r),
            "no-current-failing-check",
            "a stale failure is not presented as current"
        );
        r.check("cargo", &["test"], 0, "pass");
        assert_eq!(why(&r), "no-current-failing-check");
        feedback::settle(r.dir.path(), RUN);
        let j = feedback::load_journal(r.dir.path(), RUN);
        assert!(j.has(&e.key, Stage::Resolved));
        feedback::settle(r.dir.path(), RUN);
        assert_eq!(
            feedback::load_journal(r.dir.path(), RUN).entries.len(),
            j.entries.len(),
            "settling twice adds nothing"
        );
    }

    #[test]
    fn other_writers_and_missing_or_damaged_state_never_license_feedback() {
        let mut b = isolated();
        b.kind = WorkspaceKind::Direct;
        let mut r = Run::new(b);
        r.check("cargo", &["test"], 101, "fail");
        assert_eq!(
            why(&r),
            "no-current-failing-check",
            "Direct Workspace: failure freshness is indeterminate"
        );
        // damaged evidence
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        let p = r
            .dir
            .path()
            .join("verification")
            .join(format!("{RUN}.jsonl"));
        let good = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, &good[..good.len() / 2]).unwrap();
        assert_eq!(why(&r), "evidence-unavailable");
        std::fs::remove_file(&p).unwrap();
        assert_eq!(why(&r), "evidence-unavailable");
        // damaged journal: cannot tell what was already said, so nothing more is said
        std::fs::write(&p, good).unwrap();
        let j = r
            .dir
            .path()
            .join("verification")
            .join(format!("{RUN}{}", feedback::JOURNAL_SUFFIX));
        std::fs::write(&j, "{garbage}\n").unwrap();
        assert_eq!(why(&r), "feedback-journal-unreadable");
    }

    #[test]
    fn environment_and_verifier_failures_are_not_reported_as_source_defects() {
        // verified by the shell protocol: the shell could not run the command at all
        for exit in [126, 127] {
            let mut r = Run::new(isolated());
            r.check("sh", &["-c", "cargo test"], exit, "fail");
            assert_eq!(why(&r), "environment-or-verifier-failure", "{exit}");
        }
        // killed by a signal (timeout, OOM): the check did not finish
        let mut r = Run::new(isolated());
        let out = json!({"exitCode": null, "signal": "SIGKILL", "verification": "fail", "pipefail": "not-applicable"});
        let args = cmd("cargo", &["test"]);
        let f = ReceiptFacts::from_result("proc_run", &args, Some(&out), Some(true));
        r.push(act(0, "proc_run", "failed", None), Some(f));
        assert_eq!(why(&r), "environment-or-verifier-failure");
        // a real failure next to an environment one is still reported, alone
        r.check("cargo", &["clippy"], 1, "fail");
        let e = eligible(&r);
        assert_eq!(e.checks.len(), 1);
        assert!(e.message.contains("cargo-clippy") && !e.message.contains("cargo-test"));
    }

    #[test]
    fn cancellation_limits_and_missing_capability_prevent_a_continuation() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        let d = |f: Facts| feedback::decide(r.dir.path(), RUN, &f);
        assert_eq!(
            d(Facts {
                cancelled: true,
                ..facts()
            }),
            Decision::Ineligible("cancelled")
        );
        assert_eq!(
            d(Facts {
                room_for_another_turn: false,
                ..facts()
            }),
            Decision::Ineligible("user-limit-reached")
        );
        assert_eq!(
            d(Facts {
                can_act: false,
                ..facts()
            }),
            Decision::Ineligible("no-capability-to-act")
        );
        assert!(matches!(d(facts()), Decision::Eligible(_)));
    }

    #[test]
    fn a_crash_after_admission_is_uncertain_never_resent_and_failed_writes_deliver_nothing() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        let e = eligible(&r);
        deliver(&r, &e);
        // the process died before any provider answer: a fresh load sees it in flight
        let j = feedback::load_journal(r.dir.path(), RUN);
        assert_eq!(j.in_flight().len(), 1);
        feedback::settle(r.dir.path(), RUN);
        let j = feedback::load_journal(r.dir.path(), RUN);
        assert!(j.has(&e.key, Stage::OutcomeUncertain));
        assert!(j.in_flight().is_empty());
        assert_eq!(
            why(&r),
            "already-delivered-for-equivalent-state",
            "uncertain is never re-sent"
        );
        // a journal that cannot be written: no admission, hence no delivery
        let blocked = tempfile::tempdir().unwrap();
        std::fs::write(blocked.path().join("verification"), b"x").unwrap();
        let en = JournalEntry {
            key: e.key.clone(),
            stage: Stage::Admitted,
            checks: e.checks.clone(),
        };
        assert!(feedback::record(blocked.path(), RUN, &en).is_err());
    }

    #[test]
    fn many_failures_stay_concise_and_policy_parses_only_known_words() {
        let mut r = Run::new(isolated());
        for p in ["a", "b", "c", "d", "e", "f", "g"] {
            r.check("cargo", &["test", "-p", p], 1, "fail");
        }
        let e = eligible(&r);
        assert_eq!(e.checks.len(), 7);
        assert!(e.message.contains("and 2 more failing checks") && e.message.len() < 2500);
        use feedback::FeedbackPolicy as P;
        assert_eq!(P::parse("Active"), Some(P::Active));
        assert_eq!(P::parse(" observe "), Some(P::Observe));
        assert_eq!(P::parse("force"), None);
        assert_eq!(
            P::default(),
            P::Observe,
            "non-interfering unless the broker owner says otherwise"
        );
    }

    // ─── Phase 05 hardening ─────────────────────────────────────────────────

    #[test]
    fn a_failure_is_reported_only_when_the_receipted_contents_are_confirmed_just_now() {
        let mut r = Run::new(isolated());
        r.edit_real("src/app.tsx", "B\n");
        r.check("cargo", &["test"], 101, "fail");
        let attested = |r: &Run| {
            matches!(
                r.rec.attest_now(),
                crate::verification::attest::Attestation::Attested { .. }
            )
        };
        assert!(attested(&r));
        let d = |r: &Run, ok| {
            feedback::decide(
                r.dir.path(),
                RUN,
                &Facts {
                    attested: ok,
                    ..facts()
                },
            )
        };
        assert!(matches!(d(&r, attested(&r)), Decision::Eligible(_)));
        // an outside writer changes the already-receipted file after the failed check
        std::fs::write(r.root.path().join("src/app.tsx"), "C\n").unwrap();
        assert!(!attested(&r), "the content no longer matches its receipt");
        assert_eq!(
            d(&r, attested(&r)),
            Decision::Ineligible("failing-check-content-not-attested")
        );
        // and when the contents cannot be read safely at all, the uncertainty is kept
        let mut r2 = Run::new(isolated());
        r2.check("cargo", &["test"], 101, "fail");
        r2.edit("src/a.rs", "edit", Some("a"), Some("b"));
        let ok = matches!(
            r2.rec.attest_now(),
            crate::verification::attest::Attestation::Attested { .. }
        );
        assert!(!ok, "a receipted file that is not on disk is not attested");
    }

    #[test]
    fn failure_classes_follow_the_evidence_not_the_exit_code_alone() {
        use crate::verification::evidence::Invocation::{Direct, Shell};
        use feedback::{classify_failure as c, FailureClass as F};
        assert_eq!(c(Some(101), None, Some(Direct), None), F::Observed);
        assert_eq!(c(Some(1), None, Some(Shell), None), F::Observed);
        // the shell reporting about its inner command: verified invocation failure
        assert_eq!(c(Some(127), None, Some(Shell), None), F::InvocationFailure);
        assert_eq!(c(Some(126), None, Some(Shell), None), F::InvocationFailure);
        // a program started directly that exits 127 is speaking for itself: ambiguous, not "environment"
        assert_eq!(c(Some(127), None, Some(Direct), None), F::Ambiguous);
        assert_eq!(
            c(Some(127), None, None, None),
            F::Ambiguous,
            "older records without the invocation mode"
        );
        // killed: no verdict at all
        assert_eq!(
            c(None, Some("SIGKILL"), Some(Direct), None),
            F::DidNotComplete
        );
        // a package-manager script runner returns the SHELL's status for a command inside its script
        for fam in ["npm-build", "npm-test", "pnpm-test", "yarn-test"] {
            assert_eq!(
                c(Some(127), None, Some(Direct), Some(fam)),
                F::InvocationFailure,
                "{fam}"
            );
            assert_eq!(
                c(Some(126), None, Some(Direct), Some(fam)),
                F::InvocationFailure,
                "{fam}"
            );
            assert_eq!(
                c(Some(1), None, Some(Direct), Some(fam)),
                F::Observed,
                "{fam}: an ordinary failure stays one"
            );
        }
        // other directly started programs keep the ambiguous class
        assert_eq!(
            c(Some(127), None, Some(Direct), Some("cargo-test")),
            F::Ambiguous
        );
        assert_eq!(
            c(Some(127), None, Some(Direct), Some("node-test")),
            F::Ambiguous
        );
        assert_eq!(
            c(Some(1), Some("SIGTERM"), Some(Shell), None),
            F::DidNotComplete
        );
    }

    #[test]
    fn invocation_failures_are_withheld_and_ambiguous_ones_are_reported_without_a_cause() {
        // a shell-wrapped single command that the shell could not find
        let mut r = Run::new(isolated());
        r.check("sh", &["-c", "cargo test"], 127, "fail");
        assert_eq!(why(&r), "environment-or-verifier-failure");
        // the same status from a directly started program is reported, honestly qualified
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 127, "fail");
        let e = eligible(&r);
        assert!(
            e.message.contains("Cause: not established"),
            "{}",
            e.message
        );
        assert!(e.message.contains("exit status 127"));
        // an ordinary observed failure carries no such qualifier
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        assert!(!eligible(&r).message.contains("Cause:"));
    }

    #[test]
    fn the_compaction_note_is_core_derived_and_exists_only_after_a_delivery() {
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 101, "fail");
        assert_eq!(
            feedback::compaction_note(r.dir.path(), RUN),
            None,
            "nothing delivered, nothing added"
        );
        let e = eligible(&r);
        feedback::record(
            r.dir.path(),
            RUN,
            &JournalEntry {
                key: e.key.clone(),
                stage: Stage::Observed,
                checks: e.checks.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            feedback::compaction_note(r.dir.path(), RUN),
            None,
            "an observation is not a delivery"
        );
        deliver(&r, &e);
        let n = feedback::compaction_note(r.dir.path(), RUN).unwrap();
        assert!(
            n.contains("cargo-test (tool call #1)") && n.contains("not repeated"),
            "{n}"
        );
        // once the failure no longer stands the note says so
        r.edit_real("src/a.rs", "fn a() {}\n");
        r.check("cargo", &["test"], 0, "pass");
        let n = feedback::compaction_note(r.dir.path(), RUN).unwrap();
        assert!(n.contains("no failing check stands"), "{n}");
    }

    // ─── Found by the first live provider run ───────────────────────────────

    /// The shape the real Kernel reported for the model's scratch file: created, then deleted, the
    /// delete receipt carrying the hash of EMPTY content as its post-image.
    #[test]
    fn a_kernel_delete_receipt_means_the_file_is_gone_whatever_hash_it_carries() {
        const EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let mut r = Run::new(isolated());
        r.edit_real("src/duration.js", "fixed\n");
        let before = r.report().len();
        // scratch file: create, then delete (the real receipts, exactly)
        r.edit(
            "src/duration.js.fixed",
            "create",
            None,
            Some("0518360fd79e"),
        );
        r.edit(
            "src/duration.js.fixed",
            "delete",
            Some("0518360fd79e"),
            Some(EMPTY),
        );
        let c = r.check("cargo", &["test"], 0, "pass");
        r.finish(&["src/duration.js"], false);
        let l = persistence::load(r.dir.path(), RUN).ledger;
        let b = l
            .records()
            .into_iter()
            .find_map(|e| e.boundary.clone())
            .unwrap();
        assert!(
            matches!(
                b.attestation,
                crate::verification::attest::Attestation::Attested { .. }
            ),
            "an honest create+delete must attest: {:?}",
            b.attestation
        );
        assert_eq!(r.state_of(c), Freshness::Current);
        let _ = before;
        // the scratch file left no trace in the source identity: same digest as without it
        let mut clean = Run::new(isolated());
        clean.edit_real("src/duration.js", "fixed\n");
        let digest = |run: &Run| {
            let l = persistence::load(run.dir.path(), RUN).ledger;
            l.records()
                .last()
                .and_then(|e| e.target.clone())
                .map(|t| t.source)
        };
        clean.check("cargo", &["test"], 0, "pass");
        assert_eq!(
            match digest(&r) {
                Some(crate::verification::target::SourceIdentity::ReceiptDelta {
                    digest, ..
                }) => digest,
                o => panic!("{o:?}"),
            },
            match digest(&clean) {
                Some(crate::verification::target::SourceIdentity::ReceiptDelta {
                    digest, ..
                }) => digest,
                o => panic!("{o:?}"),
            },
        );
        // and a file that is NOT supposed to exist but does is still caught
        std::fs::write(r.root.path().join("src/duration.js.fixed"), "back\n").unwrap();
        assert!(matches!(
            r.rec.attest_now(),
            crate::verification::attest::Attestation::Mismatch { .. }
        ));
    }

    #[test]
    fn node_test_is_a_recognized_check_and_its_failure_is_actionable() {
        assert!(matches!(
            classify_command(&cmd("node", &["--test"])),
            Recognition::Recognized { family } if family == "node-test"
        ));
        let mut r = Run::new(isolated());
        r.edit_real("src/a.js", "x\n");
        r.check("node", &["--test"], 1, "fail");
        let e = eligible(&r);
        assert!(e.message.contains("Check: node-test") && e.message.contains("exit status 1"));
        let mut r = Run::new(isolated());
        r.check("node", &["--test"], 0, "pass");
        r.finish(&[], false);
        assert_eq!(summary(&r).verdict, "verified-within-scope");
    }

    // ─── Found by the live campaign: checks piped through head/tail ──────────

    fn sh(script: &str) -> serde_json::Value {
        cmd("sh", &["-c", script])
    }

    #[test]
    fn a_check_piped_only_through_head_or_tail_is_recognized_with_the_checks_own_identity() {
        use crate::verification::evidence::{check_digest, invocation_of, Invocation};
        for script in [
            "npm test 2>&1 | head -n 100",
            "npm test 2>&1 | tail -n 20",
            "npm test | head -50",
            "npm test|head -n 5",
            "cargo test --offline 2>&1 | tail -30",
            "node --test 2>&1 | head -n 80 | tail -n 20",
            "npm test 2>&1",
        ] {
            assert!(
                matches!(
                    classify_command(&sh(script)),
                    Recognition::Recognized { .. }
                ),
                "{script}"
            );
        }
        assert_eq!(
            invocation_of(&sh("npm test 2>&1 | head -n 100")),
            Invocation::ShellPipeline
        );
        assert_eq!(invocation_of(&sh("npm test 2>&1")), Invocation::Shell);
        assert_eq!(invocation_of(&cmd("npm", &["test"])), Invocation::Direct);
        // the same check, however its output is truncated or wrapped
        let id = check_digest(&cmd("npm", &["test"])).unwrap();
        for script in [
            "npm test",
            "npm test 2>&1 | head -n 100",
            "npm test | tail -5",
        ] {
            assert_eq!(check_digest(&sh(script)).unwrap(), id, "{script}");
        }
        assert_ne!(check_digest(&sh("npm run build | head")).unwrap(), id);
        assert_ne!(
            check_digest(&json!({"program":"npm","args":["test"],"cwd":"sub"})).unwrap(),
            id
        );
    }

    #[test]
    fn a_pipeline_result_is_trusted_only_when_the_kernel_applied_pipefail() {
        let pipe = sh("npm test 2>&1 | head -n 100");
        // pipefail applied: the status is the check's
        let mut r = Run::new(isolated());
        let ok = r.push(
            act(0, "proc_run", "executed", None),
            Some(proc_facts_pf(pipe.clone(), 0, "pass", "applied")),
        );
        assert_eq!(r.state_of(ok), Freshness::Current);
        assert_eq!(r.report()[0].original_result, "process-exited-zero");
        let mut r = Run::new(isolated());
        r.push(
            act(0, "proc_run", "failed", None),
            Some(proc_facts_pf(pipe.clone(), 1, "fail", "applied")),
        );
        assert_eq!(r.report()[0].original_result, "process-failed");
        // pipefail unavailable: the status proves nothing about the first stage
        let mut r = Run::new(isolated());
        r.push(
            act(0, "proc_run", "executed", None),
            Some(proc_facts_pf(pipe.clone(), 0, "pass", "unsupported")),
        );
        assert!(
            r.report().is_empty(),
            "an unattributable pipeline is not a trusted result"
        );
        let l = persistence::load(r.dir.path(), RUN).ledger;
        assert!(matches!(
            &l.records()[0].check.as_ref().unwrap().outcome,
            CheckOutcome::Inconclusive { reason } if reason == "pipeline-status-not-attributable"
        ));
        // pipefail applied but the Kernel says unverified (a stage was cut off by SIGPIPE)
        let mut r = Run::new(isolated());
        r.push(
            act(0, "proc_run", "executed", None),
            Some(proc_facts_pf(pipe, 141, "unverified", "applied")),
        );
        assert!(r.report().is_empty());
    }

    #[test]
    fn a_rerun_with_different_truncation_is_the_same_check_and_supersedes_the_failure() {
        let mut r = Run::new(isolated());
        r.edit_real("src/a.js", "x\n");
        r.push(
            act(0, "proc_run", "failed", None),
            Some(proc_facts_pf(
                sh("npm test 2>&1 | head -n 80"),
                1,
                "fail",
                "applied",
            )),
        );
        let e = eligible(&r);
        assert!(e.message.contains("Check: npm-test"), "{}", e.message);
        r.edit_real("src/a.js", "y\n");
        r.push(
            act(0, "proc_run", "executed", None),
            Some(proc_facts_pf(
                sh("npm test 2>&1 | head -n 100"),
                0,
                "pass",
                "applied",
            )),
        );
        r.finish(&["src/a.js"], false);
        let s = summary(&r);
        assert_eq!(s.verdict, "verified-within-scope", "{s:#?}");
        assert_eq!(s.checks.len(), 1, "one check identity");
        assert!(s
            .limitations
            .iter()
            .any(|l| l.starts_with("earlier-failures-superseded")));
    }

    #[test]
    fn a_pipelined_command_the_shell_could_not_run_is_an_invocation_failure() {
        let mut r = Run::new(isolated());
        r.push(
            act(0, "proc_run", "failed", None),
            Some(proc_facts_pf(
                sh("npm test 2>&1 | head -n 80"),
                127,
                "fail",
                "applied",
            )),
        );
        assert_eq!(why(&r), "environment-or-verifier-failure");
    }

    /// The live campaign's A05 case: `npm run build` ran `tsc`, which is not installed. npm returns the
    /// shell's 127. That is a missing tool, not a failed check, so no feedback is owed.
    #[test]
    fn a_package_script_runner_exiting_126_or_127_is_a_missing_tool_not_a_failed_check() {
        for (prog, args, exit) in [
            ("npm", &["run", "build"][..], 127),
            ("npm", &["test"][..], 127),
            ("npm", &["run", "build"][..], 126),
        ] {
            let mut r = Run::new(isolated());
            r.check(prog, args, exit, "fail");
            assert_eq!(
                why(&r),
                "environment-or-verifier-failure",
                "{prog} {args:?} {exit}"
            );
        }
        // an ordinary failing npm check is still actionable, and cargo's own 127 stays reported-with-caveat
        let mut r = Run::new(isolated());
        r.check("npm", &["test"], 1, "fail");
        assert!(matches!(decide(&r), Decision::Eligible(_)));
        let mut r = Run::new(isolated());
        r.check("cargo", &["test"], 127, "fail");
        assert!(eligible(&r).message.contains("Cause: not established"));
    }
}
