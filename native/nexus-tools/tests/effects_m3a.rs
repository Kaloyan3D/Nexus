//! M3A: filesystem observation and the command effects ledger, with the real Kernel and the real sandbox.
//! Prints `NOT RUN` when the host lacks the sandbox (the release battery runs with `NEXUS_REQUIRE_SANDBOX=1`).

mod common;

use common::*;
use nexus_tools::observe::{self, ObserveBudget};
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute_process_in, CancellationToken};
use serde_json::json;
use std::time::Duration;

fn policy() -> CommandPolicy {
    CommandPolicy::standard(Toolchain::discover()).with_workbench()
}

fn ready(t: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available || !std::path::Path::new("/usr/bin/python3").exists() {
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
    script: &str,
    pol: &CommandPolicy,
) -> Result<nexus_tools::ToolExecutionOutcome, nexus_tools::ToolError> {
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", script], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let p = fx.prepare_p(r, pol)?;
    let call = authorize(&mut fx.kernel, p)?;
    let dir = fx.dir.path().join("exec");
    execute_process_in(&mut fx.kernel, &call, &cancel, pol, &dir, 120_000, None)
}

fn out(o: &nexus_tools::ToolExecutionOutcome) -> serde_json::Value {
    o.result.output.clone().unwrap_or_default()
}

fn paths(v: &serde_json::Value, k: &str) -> Vec<String> {
    v["effects"][k]["paths"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn ledger(fx: &Fx, v: &serde_json::Value) -> observe::EffectsRecord {
    let id = v["effects"]["executionId"].as_str().expect("execution id");
    observe::read_record(&observe::effects_dir(&fx.dir.path().join("exec")), id)
        .expect("ledger record on disk")
}

#[test]
fn nested_files_edits_deletes_and_a_formatter_are_reported_exactly() {
    if !ready("effects") {
        return;
    }
    let mut fx = fixture("m3a-basic");
    fx.write("src/a.txt", b"one   two\n");
    fx.write("src/b.txt", b"keep\n");
    fx.write("old/gone.txt", b"bye\n");
    fx.write("docs/x.txt", b"x\n");
    fx.approve_process_fs(60_000, "workspace");
    let o = run(
        &mut fx,
        "mkdir -p deep/er/est && echo hi > deep/er/est/n.txt && echo top > t.txt \
         && sed -i 's/  */ /g' src/a.txt && rm old/gone.txt && mv docs/x.txt docs/y.txt",
        &policy(),
    )
    .expect("run");
    let v = out(&o);
    assert_eq!(v["verification"], "pass", "{v}");
    assert_eq!(v["effects"]["outcome"], "observed", "{v}");
    assert_eq!(v["effects"]["attribution"], "temporal");
    assert_eq!(v["effects"]["outcomeReasons"], json!([]), "{v}");
    let created = paths(&v, "created");
    assert!(
        created.contains(&"deep/er/est/n.txt".to_string()),
        "{created:?}"
    );
    assert!(created.contains(&"t.txt".to_string()), "{created:?}");
    assert!(created.contains(&"docs/y.txt".to_string()), "{created:?}");
    assert_eq!(paths(&v, "modified"), vec!["src/a.txt"]);
    let deleted = paths(&v, "deleted");
    assert!(deleted.contains(&"old/gone.txt".to_string()), "{deleted:?}");
    assert!(deleted.contains(&"docs/x.txt".to_string()), "{deleted:?}");
    assert!(!paths(&v, "modified").contains(&"src/b.txt".to_string()));
    let dirs = paths(&v, "createdDirs");
    assert!(dirs.contains(&"deep/er/est".to_string()), "{dirs:?}");
    // the rename is reported as delete + create, with the identity hint
    let rec = ledger(&fx, &v);
    assert!(
        rec.effects
            .likely_renames
            .iter()
            .any(|r| r.from == "docs/x.txt" && r.to == "docs/y.txt"),
        "{:?}",
        rec.effects.likely_renames
    );
    // post hashes are exact
    use sha2::{Digest, Sha256};
    assert_eq!(
        rec.effects.post_sha256.get("src/a.txt").unwrap(),
        &hex::encode(Sha256::digest(b"one two\n"))
    );
    assert_eq!(rec.digest, rec.compute_digest());
    // the journal carries the boundary and the bounded summary, not the full record
    let j = fx.kernel.list_tool_journal(None).unwrap();
    let prepared = j.iter().rev().find(|e| e.phase == "prepared").unwrap();
    assert_eq!(
        prepared.payload["observation"]["preManifestPersisted"],
        true
    );
    assert_eq!(prepared.payload["observation"]["attribution"], "temporal");
    let exited = j.iter().rev().find(|e| e.phase == "exited").unwrap();
    assert_eq!(exited.payload["effects"]["outcome"], "observed");
    assert_eq!(exited.payload["effects"]["digest"], rec.digest);
    // the pre-manifest was consumed
    let dir = observe::effects_dir(&fx.dir.path().join("exec"));
    assert!(
        !dir.join(format!("{}.pre.json.gz", rec.execution_id))
            .exists(),
        "pre-manifest left behind"
    );
    // owner-only evidence
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn successive_commands_each_describe_only_their_own_changes() {
    if !ready("successive") {
        return;
    }
    let mut fx = fixture("m3a-succ");
    fx.approve_process_fs(60_000, "workspace");
    let o1 = run(&mut fx, "echo 1 > first.txt", &policy()).unwrap();
    fx.approve_process_fs(60_000, "workspace");
    let o2 = run(&mut fx, "echo 2 > second.txt", &policy()).unwrap();
    assert_eq!(paths(&out(&o1), "created"), vec!["first.txt"]);
    assert_eq!(paths(&out(&o2), "created"), vec!["second.txt"]);
    assert_ne!(
        out(&o1)["effects"]["executionId"],
        out(&o2)["effects"]["executionId"]
    );
    assert_eq!(
        out(&o2)["effects"]["preDigest"],
        out(&o1)["effects"]["postDigest"]
    );
}

#[test]
fn dependency_directories_are_summarised_not_enumerated() {
    if !ready("bulk") {
        return;
    }
    let mut fx = fixture("m3a-bulk");
    fx.write("package.json", b"{}\n");
    fx.approve_process_fs(60_000, "workspace");
    let o = run(
        &mut fx,
        "mkdir -p node_modules/a node_modules/b && for i in $(seq 1 300); do echo $i > node_modules/a/f$i.js; done \
         && echo real > src.js",
        &policy(),
    )
    .unwrap();
    let v = out(&o);
    assert_eq!(v["effects"]["outcome"], "observed", "{v}");
    let all: Vec<String> = ["created", "modified", "deleted"]
        .iter()
        .flat_map(|k| paths(&v, k))
        .collect();
    assert!(all.contains(&"src.js".to_string()), "{all:?}");
    assert!(
        !all.iter().any(|p| p.starts_with("node_modules/")),
        "dependency files enumerated: {all:?}"
    );
    let bulk = v["effects"]["bulkChanged"].as_array().unwrap();
    assert!(
        bulk.iter().any(|b| b["path"] == "node_modules"),
        "no bulk summary: {v}"
    );
}

#[test]
fn an_observation_that_ran_out_of_budget_is_uncertain_and_never_reported_as_verified() {
    if !ready("budget") {
        return;
    }
    let mut fx = fixture("m3a-budget");
    for i in 0..30 {
        fx.write(&format!("d/f{i}.txt"), b"x\n");
    }
    fx.approve_process_fs(60_000, "workspace");
    let pol = policy().with_observe_budget(ObserveBudget {
        max_entries: 5,
        ..Default::default()
    });
    let o = run(&mut fx, "echo new > created.txt", &pol).unwrap();
    let v = out(&o);
    assert_eq!(v["effects"]["outcome"], "uncertain", "{v}");
    assert_eq!(v["effects"]["complete"], false);
    assert_eq!(
        v["verification"], "unverified",
        "exit 0 must not read as verified: {v}"
    );
    let reasons = serde_json::to_string(&v["effects"]["outcomeReasons"]).unwrap();
    assert!(reasons.contains("entry-budget"), "{reasons}");
}

#[test]
fn an_unreadable_directory_makes_the_observation_partial_not_silent() {
    if !ready("unreadable") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let mut fx = fixture("m3a-unreadable");
    fx.write("locked/secret_stuff.txt", b"x\n");
    fx.write("ok.txt", b"x\n");
    std::fs::set_permissions(fx.ws.join("locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
    fx.approve_process_fs(60_000, "workspace");
    let o = run(&mut fx, "echo new > created.txt", &policy());
    let _ = std::fs::set_permissions(fx.ws.join("locked"), std::fs::Permissions::from_mode(0o755));
    let o = o.unwrap();
    let v = out(&o);
    assert_eq!(v["effects"]["outcome"], "uncertain", "{v}");
    let reasons = serde_json::to_string(&v["effects"]["outcomeReasons"]).unwrap();
    assert!(reasons.contains("unreadable:locked"), "{reasons}");
    assert!(paths(&v, "created").contains(&"created.txt".to_string()));
}

#[test]
fn a_cancelled_command_still_leaves_an_honest_partial_record() {
    if !ready("cancel-fx") {
        return;
    }
    let mut fx = fixture("m3a-cancel");
    fx.approve_process_fs(60_000, "workspace");
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", "echo begun > begun.txt; (while true; do echo t >> ticks.txt; sleep 0.05; done) & wait"], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = policy();
    let p = fx.prepare_p(r, &pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let run_root = fx.dir.path().join("exec");
    let c2 = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        c2.cancel();
    });
    let o = execute_process_in(
        &mut fx.kernel,
        &call,
        &cancel,
        &pol,
        &run_root,
        120_000,
        None,
    )
    .unwrap();
    t.join().unwrap();
    let v = out(&o);
    assert_eq!(v["reason"], "cancelled", "{v}");
    assert_eq!(v["effects"]["outcome"], "partial", "{v}");
    let created = paths(&v, "created");
    assert!(
        created.contains(&"begun.txt".to_string()) && created.contains(&"ticks.txt".to_string()),
        "{created:?}"
    );
    let j = fx.kernel.list_tool_journal(None).unwrap();
    let c = j.iter().rev().find(|e| e.phase == "cancelled").unwrap();
    assert_eq!(c.payload["effects"]["outcome"], "partial");
}

#[test]
fn a_concurrent_user_edit_is_reported_as_temporal_not_as_the_commands_proven_work() {
    if !ready("concurrent") {
        return;
    }
    let mut fx = fixture("m3a-concurrent");
    fx.write("mine.txt", b"before\n");
    fx.approve_process_fs(60_000, "workspace");
    let ws = fx.ws.clone();
    let t = std::thread::spawn(move || {
        // edit while the command is running: wait for its first sign of life
        let t0 = std::time::Instant::now();
        while !ws.join("started.txt").exists() && t0.elapsed() < Duration::from_secs(30) {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::write(ws.join("mine.txt"), "user edit\n").unwrap();
        std::fs::write(ws.join("user-new.txt"), "u\n").unwrap();
    });
    let o = run(
        &mut fx,
        "echo up > started.txt; sleep 1.3; echo cmd > cmd.txt",
        &policy(),
    )
    .unwrap();
    t.join().unwrap();
    let v = out(&o);
    let all: Vec<String> = ["created", "modified"]
        .iter()
        .flat_map(|k| paths(&v, k))
        .collect();
    for p in ["mine.txt", "user-new.txt", "cmd.txt"] {
        assert!(all.contains(&p.to_string()), "{p} missing from {all:?}");
    }
    assert_eq!(v["effects"]["attribution"], "temporal");
    assert!(
        v["effects"]["note"]
            .as_str()
            .unwrap()
            .contains("does not prove"),
        "{v}"
    );
}

#[test]
fn the_model_cannot_set_or_widen_the_observation() {
    if !ready("args") {
        return;
    }
    let mut fx = fixture("m3a-args");
    fx.approve_process_fs(60_000, "workspace");
    for bad in ["observe", "budget", "effects", "maxEntries", "ledger"] {
        let r = fx.request(
            "proc.run",
            json!({"program": "sh", "args": ["-c", "true"], "cwd": ".", bad: {"maxEntries": 1}}),
        );
        let p = fx.prepare_p(r, &policy());
        assert!(p.is_err(), "'{bad}' must be refused as an unknown argument");
    }
}

#[test]
fn what_a_user_edits_after_a_command_is_an_outside_change_in_the_direct_evidence() {
    if !ready("direct") {
        return;
    }
    let mut fx = fixture("m3a-direct");
    fx.write("keep.txt", b"keep\n");
    fx.approve_process_fs(60_000, "workspace");
    let o = run(
        &mut fx,
        "echo generated > gen.txt && echo changed >> keep.txt && rm keep.txt && echo again > again.txt",
        &policy(),
    )
    .unwrap();
    let rec = ledger(&fx, &out(&o));
    let base = tempfile::tempdir().unwrap();
    let root = fx.ws.to_string_lossy().into_owned();
    let store = nexus_tools::direct::Store::create(base.path(), "task-direct-1", &root).unwrap();
    store.record_command_effects(&rec).unwrap();
    store.record_command_effects(&rec).unwrap(); // idempotent
    assert_eq!(store.observed().unwrap().len(), 1);
    // nothing outside yet
    assert!(nexus_tools::direct::external_changes(&store, &root)
        .unwrap()
        .is_empty());
    let d = nexus_tools::direct::diff(&store, &root).unwrap();
    let gen = d
        .files
        .iter()
        .find(|f| f.path == "gen.txt")
        .expect("created file listed");
    assert_eq!(
        (
            gen.status.as_str(),
            gen.origin.as_str(),
            gen.attribution.as_str()
        ),
        ("added", "command", "temporal")
    );
    assert!(gen.pre_image);
    assert!(d.diff.contains("+generated"), "{}", d.diff);
    let del = d
        .files
        .iter()
        .find(|f| f.path == "keep.txt")
        .expect("deleted file listed");
    assert_eq!((del.status.as_str(), del.pre_image), ("deleted", false));
    assert_eq!(d.command_evidence.executions, 1);
    // the user edits the generated file afterwards
    std::fs::write(fx.ws.join("gen.txt"), "user was here\n").unwrap();
    let ext = nexus_tools::direct::external_changes(&store, &root).unwrap();
    assert_eq!(ext, vec!["gen.txt"], "{ext:?}");
    let d = nexus_tools::direct::diff(&store, &root).unwrap();
    assert!(
        d.files
            .iter()
            .find(|f| f.path == "gen.txt")
            .unwrap()
            .external_change
    );
}

#[test]
fn a_tool_write_inside_the_command_window_makes_attribution_ambiguous() {
    // synthetic record: no sandbox needed
    let proj = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(proj.path()).unwrap();
    let root_s = root.to_string_lossy().into_owned();
    let base = tempfile::tempdir().unwrap();
    let store = nexus_tools::direct::Store::create(base.path(), "task-amb-1", &root_s).unwrap();
    std::fs::write(root.join("both.txt"), "v1\n").unwrap();
    store.record_pre("both.txt", Some(b"v0\n"), None).unwrap();
    store.record_post("both.txt", Some("deadbeef")).unwrap();
    let now = observe::now_ms();
    let mut rec = synthetic(now.saturating_sub(5_000), now + 5_000);
    rec.effects.modified = observe_list(&["both.txt"]);
    rec.effects.created = observe_list(&["only-command.txt"]);
    std::fs::write(root.join("only-command.txt"), "c\n").unwrap();
    store.record_command_effects(&rec).unwrap();
    let o = store.observed().unwrap();
    let both = o[0].paths.iter().find(|p| p.path == "both.txt").unwrap();
    let only = o[0]
        .paths
        .iter()
        .find(|p| p.path == "only-command.txt")
        .unwrap();
    assert!(both.ambiguous && !only.ambiguous);
    let d = nexus_tools::direct::diff(&store, &root_s).unwrap();
    assert!(d.command_evidence.incomplete);
}

fn observe_list(p: &[&str]) -> observe::PathList {
    observe::PathList {
        count: p.len() as u64,
        paths: p.iter().map(|s| s.to_string()).collect(),
        truncated: false,
    }
}

fn synthetic(start: u64, end: u64) -> observe::EffectsRecord {
    let brief = observe::ManifestBrief {
        digest: "d".into(),
        entries: 0,
        bulk_dirs: 0,
        complete: true,
        reasons: vec![],
        bulk_truncated: 0,
    };
    let mut r = observe::EffectsRecord {
        schema: observe::RECORD_SCHEMA.into(),
        execution_id: "exec-synthetic".into(),
        task_instance_id: "task".into(),
        command_id: "cmd".into(),
        workspace: observe::RootId { dev: 1, ino: 2 },
        grant: None,
        fs_scope: "workspace".into(),
        started_ms: start,
        ended_ms: end,
        pre: brief.clone(),
        post: Some(brief),
        process: observe::ProcessState {
            exited: true,
            how: "exited".into(),
            exit_code: Some(0),
            settled: true,
        },
        effects: Default::default(),
        checkpoint: None,
        recoverability: None,
        post_state: Default::default(),
        timing_ms: Default::default(),
        outcome: "observed".into(),
        outcome_reasons: vec![],
        attribution: "temporal".into(),
        note: observe::ATTRIBUTION_NOTE.into(),
        digest: String::new(),
    };
    r.digest = r.compute_digest();
    r
}

// ------------------------------------------------------------------------------------ benchmark

fn build_tree(root: &std::path::Path, src_files: usize, dep_files: usize) {
    for i in 0..src_files {
        let d = root.join(format!("src/mod{}/sub{}", i % 40, i % 7));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("f{i}.rs")), format!("fn f{i}() {{}}\n")).unwrap();
    }
    for i in 0..dep_files {
        let d = root.join(format!("node_modules/pkg{}/lib{}", i % 500, i % 11));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("i{i}.js")), "x\n").unwrap();
    }
}

/// `cargo test -p nexus-tools --test effects_m3a --release -- --ignored --nocapture bench_observation`
#[test]
#[ignore]
fn bench_observation() {
    for (name, src, dep) in [
        ("small", 1_000usize, 0usize),
        ("medium", 20_000, 0),
        ("large", 20_000, 130_000),
    ] {
        let t = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(t.path()).unwrap();
        build_tree(&root, src, dep);
        let ws = nexus_tools::workspace::Workspace::open_root(
            root.to_str().unwrap(),
            nexus_tools::workspace::WorkspacePolicy::default(),
        )
        .unwrap();
        let b = ObserveBudget::default();
        let t0 = std::time::Instant::now();
        let pre = observe::observe(&ws, &b);
        let obs_ms = t0.elapsed().as_millis();
        // a small change, then post observation + diff + hash of the changed files
        std::fs::write(root.join("src/mod0/sub0/new.rs"), "fn n() {}\n").unwrap();
        std::fs::write(root.join("src/mod1/sub1/f1.rs"), "fn changed() {}\n").unwrap();
        let t1 = std::time::Instant::now();
        let post = observe::observe(&ws, &b);
        let (mut fx, _) = observe::diff(&pre, &post, &b);
        let ch: Vec<String> = fx
            .created
            .paths
            .iter()
            .chain(fx.modified.paths.iter())
            .cloned()
            .collect();
        observe::hash_changed(&ws, &ch, &mut fx, &b);
        let cycle_ms = t1.elapsed().as_millis();
        let rec_bytes = serde_json::to_vec(&fx).unwrap().len();
        let pre_gz = {
            let d = tempfile::tempdir().unwrap();
            observe::write_pre(d.path(), "bench", &pre).unwrap();
            std::fs::metadata(d.path().join("bench.pre.json.gz"))
                .unwrap()
                .len()
        };
        println!(
            "BENCH {name}: src_files={src} dep_files={dep} entries={} bulk_dirs={} pre_observe_ms={obs_ms} \
             post_observe+diff+hash_ms={cycle_ms} created={} modified={} complete={} pre_manifest_gz_bytes={pre_gz} effects_json_bytes={rec_bytes}",
            brief_entries(&pre),
            observe::ManifestBrief::of(&pre).bulk_dirs,
            fx.created.count,
            fx.modified.count,
            post.completeness.complete,
        );
    }
}

fn brief_entries(m: &observe::Manifest) -> u64 {
    observe::ManifestBrief::of(m).entries
}
