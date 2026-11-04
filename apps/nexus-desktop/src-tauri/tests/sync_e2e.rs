//! Host ⇄ guest synchronization against the real staging store and the real Mac-side writeback
//! code (no VM, no network): staging, resume, verified writeback, conflicts, crashes, recovery.

use nexus_desktop_lib::sync::guest::GuestStore;
use nexus_desktop_lib::sync::host::*;
use nexus_desktop_lib::sync::manifest::{self, ChangeKind};
use nexus_desktop_lib::sync::registry::*;
use nexus_desktop_lib::sync::wire::*;
use serde_json::{json, Value};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

struct Env {
    _t: tempfile::TempDir,
    root: PathBuf,
    store: Store,
    guest: Arc<LocalGuest>,
    gpath: PathBuf,
    pid: String,
}

fn w(root: &Path, rel: &str, c: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, c).unwrap();
}
fn r(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap_or_else(|_| "<absent>".into())
}

fn env() -> Env {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("mac").join("myproj");
    std::fs::create_dir_all(&root).unwrap();
    w(&root, "src/main.rs", "fn main() {}\n");
    w(&root, "README.md", "# hi\n");
    w(&root, "old.txt", "old\n");
    w(&root, ".env", "SECRET=1\n");
    let store = Store::open(&t.path().join("appdata")).unwrap();
    let guest = Arc::new(LocalGuest(GuestStore::new(t.path().join("guest"))));
    let md = std::fs::metadata(&root).unwrap();
    let pid = "mac-0123456789abcdef".to_string();
    store
        .insert(Project {
            id: pid.clone(),
            label: "myproj".into(),
            root: root.to_string_lossy().into(),
            root_dev: md.dev(),
            root_ino: md.ino(),
            created_ms: 1,
            consent: Some(Consent {
                granted_at_ms: 1,
                scope: SCOPE_VERSION.into(),
                root: root.to_string_lossy().into(),
                apply_unverified: false,
            }),
            guest_id: Some("myproj-abc".into()),
            generation: 0,
            staged: false,
            last_sync_ms: None,
            staging: false,
            skipped: vec![],
            skipped_total: 0,
            file_count: 0,
            total_bytes: 0,
            runs: vec![],
        })
        .unwrap();
    Env {
        gpath: t
            .path()
            .join("guest")
            .join(&pid)
            .join("work")
            .join("myproj"),
        _t: t,
        root,
        store,
        guest,
        pid,
    }
}

impl Env {
    fn ctx(&self) -> Ctx<'_> {
        Ctx {
            store: &self.store,
            guest: self.guest.as_ref(),
            fault: Fault::None,
        }
    }
    fn ctx_with(&self, f: Fault) -> Ctx<'_> {
        Ctx {
            store: &self.store,
            guest: self.guest.as_ref(),
            fault: f,
        }
    }
    fn stage(&self) -> StageReport {
        stage_project(&self.ctx(), &self.pid).unwrap()
    }
}

fn good_run() -> Value {
    json!({"terminal": true, "state": "completed", "cancelRequested": false, "errorCode": null, "completion": "fulfilled",
           "codingOutcome": {"verification": "verified-passed", "checksFailedUnresolved": 0, "uncertainOperations": 0, "staleAfterEdit": false}})
}

#[test]
fn staging_filters_secrets_and_publishes_the_working_copy() {
    let e = env();
    let rep = e.stage();
    assert!(rep.created && !rep.unchanged);
    assert_eq!(r(&e.gpath, "src/main.rs"), "fn main() {}\n");
    assert!(!e.gpath.join(".env").exists(), "secrets never cross");
    let p = e.store.get(&e.pid).unwrap();
    assert!(p.staged && p.generation == 1 && p.skipped.iter().any(|s| s.path == ".env"));
    // staging again with nothing changed is a no-op
    assert!(e.stage().unchanged);
}

#[test]
fn host_changes_between_runs_refresh_the_engine_copy() {
    let e = env();
    e.stage();
    w(&e.root, "src/main.rs", "fn main() { println!(\"v2\"); }\n");
    w(&e.root, "new.txt", "n\n");
    std::fs::remove_file(e.root.join("old.txt")).unwrap();
    let rep = e.stage();
    assert!(!rep.unchanged && rep.generation == 2);
    assert!(r(&e.gpath, "src/main.rs").contains("v2"));
    assert_eq!(r(&e.gpath, "new.txt"), "n\n");
    assert!(!e.gpath.join("old.txt").exists());
}

#[test]
fn refresh_never_discards_unexported_engine_changes() {
    let e = env();
    e.stage();
    w(&e.gpath, "README.md", "# engine edit\n");
    w(&e.root, "other.txt", "host edit\n");
    let err = stage_project(&e.ctx(), &e.pid).unwrap_err();
    assert_eq!(err.code, "guest-has-unexported-changes");
    assert_eq!(r(&e.gpath, "README.md"), "# engine edit\n");
}

#[test]
fn interrupted_transfer_resumes_without_touching_the_accepted_baseline() {
    struct Flaky(LocalGuest, AtomicUsize);
    impl Guest for Flaky {
        fn call(&self, req: SyncReq) -> Result<Value, SyncErr> {
            if matches!(req, SyncReq::StageChunk { .. })
                && self.1.fetch_add(1, Ordering::SeqCst) == 1
            {
                return Err(SyncErr::new("transport", "link dropped"));
            }
            self.0.call(req)
        }
    }
    let e = env();
    e.stage(); // baseline generation 1
               // big file so a transfer takes several chunks
    let big: String = "x".repeat(700_000);
    w(&e.root, "big.txt", &big);
    w(&e.root, "src/main.rs", "fn main() { /* 2 */ }\n");
    let flaky = Flaky(
        LocalGuest(GuestStore::new(e._t.path().join("guest"))),
        AtomicUsize::new(0),
    );
    let c = Ctx {
        store: &e.store,
        guest: &flaky,
        fault: Fault::None,
    };
    assert!(stage_project(&c, &e.pid).is_err());
    // the accepted state is unchanged
    assert_eq!(e.store.get(&e.pid).unwrap().generation, 1);
    assert!(!e.gpath.join("big.txt").exists());
    let st: StageStatus = serde_json::from_value(
        e.guest
            .call(SyncReq::StageStatus {
                project_id: e.pid.clone(),
            })
            .unwrap(),
    )
    .unwrap();
    assert!(st.in_progress.is_some(), "the partial transfer is detected");
    // retry resumes and completes
    let rep = stage_project(&c, &e.pid).unwrap();
    assert_eq!(rep.generation, 2);
    assert_eq!(r(&e.gpath, "big.txt").len(), 700_000);
}

#[test]
fn corrupted_chunks_are_rejected() {
    let e = env();
    e.stage();
    let g = GuestStore::new(e._t.path().join("guest"));
    let data = b"hello";
    let entry = manifest::FileEntry {
        size: 5,
        sha256: "00".repeat(32),
        exec: false,
    };
    let ch = manifest::Change {
        path: "z.txt".into(),
        kind: ChangeKind::Add,
        old: None,
        new: Some(entry),
    };
    let base = manifest::digest(&e.store.baseline(&e.pid));
    use base64::Engine as _;
    g.stage_begin(&e.pid, "myproj", 2, Some(base), "t".repeat(64), 1)
        .unwrap();
    g.handle(SyncReq::StageChanges {
        project_id: e.pid.clone(),
        generation: 2,
        start: 0,
        changes: vec![ch],
    })
    .unwrap();
    let err = g
        .handle(SyncReq::StageChunk {
            project_id: e.pid.clone(),
            generation: 2,
            path: "z.txt".into(),
            offset: 0,
            data: base64::engine::general_purpose::STANDARD.encode(data),
        })
        .unwrap_err();
    assert_eq!(err.code, "hash-mismatch");
}

#[test]
fn guest_refuses_paths_outside_its_root_and_protected_names() {
    let e = env();
    e.stage();
    let g = GuestStore::new(e._t.path().join("guest"));
    let base = manifest::digest(&e.store.baseline(&e.pid));
    for bad in [
        "../escape.txt",
        "/etc/passwd",
        ".git/config",
        "a/../../b",
        ".env",
        "x\\y",
    ] {
        g.stage_begin(&e.pid, "myproj", 2, Some(base.clone()), "t".repeat(64), 1)
            .unwrap();
        let en = manifest::FileEntry {
            size: 1,
            sha256: "a".repeat(64),
            exec: false,
        };
        let ch = manifest::Change {
            path: bad.into(),
            kind: ChangeKind::Add,
            old: None,
            new: Some(en),
        };
        let err = g
            .handle(SyncReq::StageChanges {
                project_id: e.pid.clone(),
                generation: 2,
                start: 0,
                changes: vec![ch],
            })
            .unwrap_err();
        assert!(
            err.code == "unsafe-path" || err.code == "bad-request",
            "{bad}: {err}"
        );
        g.stage_abort(&e.pid).unwrap();
    }
    for bad_id in ["../x", "A", "a/b", "", "-x"] {
        assert!(
            g.handle(SyncReq::StageStatus {
                project_id: bad_id.into()
            })
            .is_err(),
            "{bad_id}"
        );
    }
}

#[test]
fn verified_run_is_written_back_exactly_once() {
    let e = env();
    e.stage();
    // the engine edits, creates, deletes (and renames = delete + add)
    w(&e.gpath, "src/main.rs", "fn main() { println!(\"hi\"); }\n");
    w(&e.gpath, "docs/new.md", "new\n");
    std::fs::remove_file(e.gpath.join("old.txt")).unwrap();
    std::fs::rename(e.gpath.join("README.md"), e.gpath.join("README.txt")).unwrap();
    let o = writeback_run(&e.ctx(), &e.pid, "run_1", &good_run()).unwrap();
    assert_eq!(o, Outcome::Applied { changed: 5 });
    assert!(r(&e.root, "src/main.rs").contains("println"));
    assert_eq!(r(&e.root, "docs/new.md"), "new\n");
    assert_eq!(r(&e.root, "old.txt"), "<absent>");
    assert_eq!(r(&e.root, "README.md"), "<absent>");
    assert_eq!(r(&e.root, "README.txt"), "# hi\n");
    assert_eq!(r(&e.root, ".env"), "SECRET=1\n", "untouched");
    let p = e.store.get(&e.pid).unwrap();
    assert_eq!(p.generation, 2);
    assert_eq!(p.run("run_1").unwrap().sync, SyncState::Applied);
    assert_eq!(
        e.store.baseline(&e.pid).get("docs/new.md").map(|x| x.size),
        Some(4)
    );
    // duplicate completion event / repeated attempt: no second write, same answer
    let before = std::fs::metadata(e.root.join("src/main.rs"))
        .unwrap()
        .modified()
        .unwrap();
    let again = writeback_run(&e.ctx(), &e.pid, "run_1", &good_run()).unwrap();
    assert_eq!(again, Outcome::Applied { changed: 5 });
    assert_eq!(
        std::fs::metadata(e.root.join("src/main.rs"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert_eq!(e.store.get(&e.pid).unwrap().generation, 2);
    // the engine's baseline moved with it: the next plan is empty and the next staging is a no-op
    let plan: ExportPlan = serde_json::from_value(
        e.guest
            .call(SyncReq::ExportPlan {
                project_id: e.pid.clone(),
            })
            .unwrap(),
    )
    .unwrap();
    assert!(plan.changes.is_empty());
    assert!(e.stage().unchanged);
}

#[test]
fn runs_that_do_not_qualify_never_touch_the_mac_folder() {
    let e = env();
    e.stage();
    w(&e.gpath, "src/main.rs", "BROKEN\n");
    let mut cases = vec![];
    let mut v = good_run();
    v["state"] = json!("cancelled");
    cases.push(("run_cancel", v));
    let mut v = good_run();
    v["state"] = json!("failed");
    v["errorCode"] = json!("provider");
    cases.push(("run_failed", v));
    let mut v = good_run();
    v["codingOutcome"]["verification"] = json!("no-test-executed");
    cases.push(("run_unverified", v));
    let mut v = good_run();
    v["codingOutcome"]["verification"] = json!("verified-failed");
    v["completion"] = json!("failing-checks");
    cases.push(("run_failing", v));
    let mut v = good_run();
    v["terminal"] = json!(false);
    cases.push(("run_live", v));
    let mut v = good_run();
    v["codingOutcome"]["uncertainOperations"] = json!(1);
    cases.push(("run_uncertain", v));
    for (id, run) in cases {
        let o = writeback_run(&e.ctx(), &e.pid, id, &run).unwrap();
        assert!(matches!(o, Outcome::NotApplied(_)), "{id}: {o:?}");
        assert_eq!(r(&e.root, "src/main.rs"), "fn main() {}\n", "{id}");
    }
    // and without standing consent even a perfect run is not applied
    e.store.update(&e.pid, |p| p.consent = None).unwrap();
    assert!(matches!(
        writeback_run(&e.ctx(), &e.pid, "run_noconsent", &good_run()).unwrap(),
        Outcome::NotApplied(_)
    ));
    assert_eq!(r(&e.root, "src/main.rs"), "fn main() {}\n");
}

#[test]
fn concurrent_host_edit_is_a_conflict_and_both_versions_survive() {
    let e = env();
    e.stage();
    w(&e.gpath, "src/main.rs", "// from nexus\n");
    w(&e.gpath, "added.txt", "nexus file\n");
    // the person edits the same file after staging
    w(&e.root, "src/main.rs", "// from the person\n");
    let o = writeback_run(&e.ctx(), &e.pid, "run_c", &good_run()).unwrap();
    match o {
        Outcome::Conflict(c) => assert!(c.iter().any(|x| x.path == "src/main.rs")),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        r(&e.root, "src/main.rs"),
        "// from the person\n",
        "the person's edit is untouched"
    );
    assert!(
        !e.root.join("added.txt").exists(),
        "nothing at all is applied on conflict"
    );
    let rec = e.store.get(&e.pid).unwrap().run("run_c").cloned().unwrap();
    assert_eq!(rec.sync, SyncState::Conflict);
    let saved = PathBuf::from(rec.saved_result.unwrap());
    assert_eq!(
        r(&saved, "src/main.rs"),
        "// from nexus\n",
        "Nexus's result is preserved"
    );
    // repeated attempts stay conflicted and stay safe
    assert!(matches!(
        writeback_run(&e.ctx(), &e.pid, "run_c", &good_run()).unwrap(),
        Outcome::Conflict(_)
    ));
    // a new task cannot be staged over an unresolved conflict
    assert_eq!(
        stage_project(&e.ctx(), &e.pid).unwrap_err().code,
        "sync-conflict"
    );
    // when the person restores the baseline content, a retry applies the preserved result
    w(&e.root, "src/main.rs", "fn main() {}\n");
    assert!(matches!(
        retry_conflict(&e.ctx(), &e.pid, "run_c").unwrap(),
        Outcome::Applied { .. }
    ));
    assert_eq!(r(&e.root, "src/main.rs"), "// from nexus\n");
}

#[test]
fn deleted_renamed_created_and_metadata_changes_on_the_mac_are_conflicts() {
    for scenario in 0..5 {
        let e = env();
        e.stage();
        w(&e.gpath, "README.md", "# nexus\n");
        let host = e.root.clone();
        match scenario {
            0 => std::fs::remove_file(host.join("README.md")).unwrap(),
            1 => std::fs::rename(host.join("README.md"), host.join("MOVED.md")).unwrap(),
            2 => {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    host.join("README.md"),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap()
            }
            3 => {
                std::fs::remove_file(host.join("README.md")).unwrap();
                std::os::unix::fs::symlink("/etc/hosts", host.join("README.md")).unwrap();
            }
            _ => {
                // engine creates a file; the person independently created a different one with a case-variant name
                w(&e.gpath, "Notes.md", "n\n");
                w(&host, "notes.md", "mine\n");
            }
        }
        let o = writeback_run(&e.ctx(), &e.pid, "run_x", &good_run()).unwrap();
        assert!(
            matches!(o, Outcome::Conflict(_)),
            "scenario {scenario}: {o:?}"
        );
        assert_ne!(r(&host, "README.md"), "# nexus\n", "scenario {scenario}");
        assert!(host.join("MOVED.md").exists() || scenario != 1);
    }
}

#[test]
fn a_crash_mid_apply_is_finished_after_restart_with_no_duplicate_write() {
    let e = env();
    e.stage();
    w(&e.gpath, "a.txt", "a\n");
    w(&e.gpath, "src/main.rs", "// edited\n");
    w(&e.gpath, "z.txt", "z\n");
    let o = writeback_run(
        &e.ctx_with(Fault::CrashBeforeOp(2)),
        &e.pid,
        "run_k",
        &good_run(),
    );
    assert_eq!(o.unwrap_err().code, "crash");
    // the Mac folder is half-written, the journal says so
    assert_eq!(r(&e.root, "a.txt"), "a\n");
    assert_eq!(r(&e.root, "z.txt"), "<absent>");
    assert_eq!(
        e.store.journal(&e.pid, "run_k").unwrap().state,
        JState::Applying
    );
    // "restart": a fresh Ctx recovers from the journal and the observed files
    let rec = recover_project(&e.ctx(), &e.pid);
    assert_eq!(rec.len(), 1);
    assert!(
        matches!(rec[0].1, Ok(Outcome::Applied { .. })),
        "{:?}",
        rec[0].1
    );
    assert_eq!(r(&e.root, "z.txt"), "z\n");
    assert_eq!(r(&e.root, "src/main.rs"), "// edited\n");
    assert_eq!(e.store.get(&e.pid).unwrap().generation, 2);
    assert_eq!(
        e.store.get(&e.pid).unwrap().run("run_k").unwrap().sync,
        SyncState::Applied
    );
    assert!(
        recover_project(&e.ctx(), &e.pid).is_empty(),
        "recovery is idempotent"
    );
    // no stray temporary files in the project
    let stray = walk_names(&e.root)
        .into_iter()
        .filter(|n| n.contains(".nexus-sync-"))
        .count();
    assert_eq!(stray, 0);
}

fn walk_names(d: &Path) -> Vec<String> {
    let mut v = vec![];
    for e in std::fs::read_dir(d).unwrap().flatten() {
        v.push(e.file_name().to_string_lossy().into_owned());
        if e.path().is_dir() {
            v.extend(walk_names(&e.path()));
        }
    }
    v
}

#[test]
fn disk_full_rolls_everything_back() {
    let e = env();
    e.stage();
    w(&e.gpath, "a.txt", "a\n");
    w(&e.gpath, "src/main.rs", "// edited\n");
    std::fs::remove_file(e.gpath.join("old.txt")).unwrap();
    let o = writeback_run(
        &e.ctx_with(Fault::IoErrorAtOp(2)),
        &e.pid,
        "run_d",
        &good_run(),
    )
    .unwrap();
    assert!(matches!(o, Outcome::Failed(_)), "{o:?}");
    assert_eq!(r(&e.root, "a.txt"), "<absent>");
    assert_eq!(r(&e.root, "src/main.rs"), "fn main() {}\n");
    assert_eq!(r(&e.root, "old.txt"), "old\n");
    let rec = e.store.get(&e.pid).unwrap().run("run_d").cloned().unwrap();
    assert_eq!(rec.sync, SyncState::Failed);
    assert!(rec.saved_result.is_some());
    assert_eq!(
        e.store.get(&e.pid).unwrap().generation,
        1,
        "baseline unchanged"
    );
}

#[test]
fn a_person_editing_during_writeback_is_never_overwritten() {
    let e = env();
    e.stage();
    w(&e.gpath, "a.txt", "a\n");
    w(&e.gpath, "src/main.rs", "// nexus\n");
    let o = writeback_run(
        &e.ctx_with(Fault::HostEditBeforeOp(
            1,
            "src/main.rs".into(),
            b"// person\n".to_vec(),
        )),
        &e.pid,
        "run_e",
        &good_run(),
    )
    .unwrap();
    assert!(matches!(o, Outcome::Conflict(_)), "{o:?}");
    assert_eq!(r(&e.root, "src/main.rs"), "// person\n");
    assert_eq!(
        r(&e.root, "a.txt"),
        "<absent>",
        "the earlier op was rolled back"
    );
}

#[test]
fn recovery_after_applied_but_before_the_engine_was_told() {
    struct DownGuest(LocalGuest, std::sync::atomic::AtomicBool);
    impl Guest for DownGuest {
        fn call(&self, req: SyncReq) -> Result<Value, SyncErr> {
            if matches!(req, SyncReq::ExportAck { .. }) && self.1.load(Ordering::SeqCst) {
                return Err(SyncErr::new("transport", "down"));
            }
            self.0.call(req)
        }
    }
    let e = env();
    e.stage();
    w(&e.gpath, "a.txt", "a\n");
    let dg = DownGuest(
        LocalGuest(GuestStore::new(e._t.path().join("guest"))),
        std::sync::atomic::AtomicBool::new(true),
    );
    let c = Ctx {
        store: &e.store,
        guest: &dg,
        fault: Fault::None,
    };
    assert!(matches!(
        writeback_run(&c, &e.pid, "run_a", &good_run()).unwrap(),
        Outcome::Applied { .. }
    ));
    assert!(!e.store.journal(&e.pid, "run_a").unwrap().acked);
    dg.1.store(false, Ordering::SeqCst);
    recover_project(&c, &e.pid);
    assert!(e.store.journal(&e.pid, "run_a").unwrap().acked);
    // the engine now agrees with the Mac
    let plan: ExportPlan = serde_json::from_value(
        e.guest
            .call(SyncReq::ExportPlan {
                project_id: e.pid.clone(),
            })
            .unwrap(),
    )
    .unwrap();
    assert!(plan.changes.is_empty());
    assert_eq!(r(&e.root, "a.txt"), "a\n");
}

#[test]
fn engine_proposing_protected_paths_is_refused() {
    let e = env();
    e.stage();
    // a hostile or buggy engine plants a file the Mac must never receive
    std::fs::create_dir_all(e.gpath.join(".git")).unwrap();
    w(&e.gpath, ".git/hooks/pre-commit", "evil");
    w(&e.gpath, "keys/id_rsa", "secret");
    w(&e.gpath, "ok.txt", "ok\n");
    let o = writeback_run(&e.ctx(), &e.pid, "run_g", &good_run()).unwrap();
    // scanning ignores them (they never become changes), so only the ordinary file is applied
    assert_eq!(o, Outcome::Applied { changed: 1 });
    assert!(!e.root.join(".git").exists());
    assert!(!e.root.join("keys/id_rsa").exists());
    // a plan that names a protected path directly is refused outright
    struct Evil(LocalGuest);
    impl Guest for Evil {
        fn call(&self, req: SyncReq) -> Result<Value, SyncErr> {
            let mut v = self.0.call(req.clone())?;
            if matches!(req, SyncReq::ExportPlan { .. }) {
                let c = manifest::Change {
                    path: ".git/config".into(),
                    kind: ChangeKind::Add,
                    old: None,
                    new: Some(manifest::FileEntry {
                        size: 1,
                        sha256: "a".repeat(64),
                        exec: false,
                    }),
                };
                let mut plan: ExportPlan = serde_json::from_value(v.clone()).unwrap();
                plan.changes.push(c);
                plan.plan_digest = manifest::change_digest(&plan.changes);
                v = serde_json::to_value(plan).unwrap();
            }
            Ok(v)
        }
    }
    w(&e.gpath, "ok2.txt", "ok\n");
    let evil = Evil(LocalGuest(GuestStore::new(e._t.path().join("guest"))));
    let c = Ctx {
        store: &e.store,
        guest: &evil,
        fault: Fault::None,
    };
    let o = writeback_run(&c, &e.pid, "run_h", &good_run()).unwrap();
    assert!(matches!(o, Outcome::Failed(_)), "{o:?}");
    assert!(!e.root.join("ok2.txt").exists());
    assert!(!e.root.join(".git").exists());
}

#[test]
fn project_registration_rejects_unsafe_roots() {
    let t = tempfile::tempdir().unwrap();
    let app = t.path().join("app");
    std::fs::create_dir_all(&app).unwrap();
    let home = t.path().join("home");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::create_dir_all(home.join("proj")).unwrap();
    let ok = validate_root(
        &home.join("proj"),
        Some(&std::fs::canonicalize(&home).unwrap()),
        &app,
    );
    assert!(ok.is_ok(), "{ok:?}");
    for bad in [
        home.clone(),
        home.join(".ssh"),
        app.clone(),
        PathBuf::from("/"),
        PathBuf::from("/etc"),
        t.path().join("missing"),
    ] {
        assert!(
            validate_root(&bad, Some(&std::fs::canonicalize(&home).unwrap()), &app).is_err(),
            "{bad:?}"
        );
    }
    let f = t.path().join("file");
    std::fs::write(&f, "x").unwrap();
    assert!(validate_root(&f, None, &app).is_err());
}

#[test]
fn qualification_requires_the_brokers_full_verdict() {
    assert!(qualifies(&good_run()).is_ok());
    for mutate in [
        |v: &mut Value| v["codingOutcome"] = Value::Null,
        |v: &mut Value| v["codingOutcome"]["staleAfterEdit"] = json!(true),
        |v: &mut Value| v["completion"] = json!("incomplete"),
        |v: &mut Value| v["cancelRequested"] = json!(true),
    ] {
        let mut v = good_run();
        mutate(&mut v);
        assert!(qualifies(&v).is_err());
    }
}

#[test]
fn opt_in_applies_unverified_results_but_never_failed_cancelled_or_errored_ones() {
    let unverified = || {
        let mut v = good_run();
        v["codingOutcome"]["verification"] = json!("no-test-executed");
        v
    };
    // strict by default: a project without tests is not applied, and the reason says so plainly
    let e = env();
    e.stage();
    w(&e.gpath, "README.md", "# nexus\n");
    match writeback_run(&e.ctx(), &e.pid, "run_s", &unverified()).unwrap() {
        Outcome::NotApplied(why) => assert!(why.contains("no test was run"), "{why}"),
        o => panic!("{o:?}"),
    }
    assert_eq!(r(&e.root, "README.md"), "# hi\n");
    // with the person's opt-in the same kind of run is applied
    let e = env();
    e.stage();
    e.store
        .update(&e.pid, |p| {
            p.consent.as_mut().unwrap().apply_unverified = true
        })
        .unwrap();
    w(&e.gpath, "README.md", "# nexus\n");
    assert!(matches!(
        writeback_run(&e.ctx(), &e.pid, "run_u", &unverified()).unwrap(),
        Outcome::Applied { .. }
    ));
    assert_eq!(r(&e.root, "README.md"), "# nexus\n");
    // ... but never failed checks, cancellation or errors
    for (id, mutate) in [
        (
            "failed_checks",
            (|v: &mut Value| v["codingOutcome"]["verification"] = json!("verified-failed"))
                as fn(&mut Value),
        ),
        ("failing_completion", |v| {
            v["completion"] = json!("failing-checks")
        }),
        ("cancelled", |v| v["state"] = json!("cancelled")),
        ("cancel_flag", |v| v["cancelRequested"] = json!(true)),
        ("error", |v| v["errorCode"] = json!("provider")),
        ("live", |v| v["terminal"] = json!(false)),
    ] {
        let e = env();
        e.stage();
        e.store
            .update(&e.pid, |p| {
                p.consent.as_mut().unwrap().apply_unverified = true
            })
            .unwrap();
        w(&e.gpath, "README.md", "# nexus\n");
        let mut v = unverified();
        mutate(&mut v);
        assert!(
            matches!(
                writeback_run(&e.ctx(), &e.pid, id, &v).unwrap(),
                Outcome::NotApplied(_)
            ),
            "{id}"
        );
        assert_eq!(r(&e.root, "README.md"), "# hi\n", "{id}");
    }
    // the opt-in still never overwrites a file the person changed
    let e = env();
    e.stage();
    e.store
        .update(&e.pid, |p| {
            p.consent.as_mut().unwrap().apply_unverified = true
        })
        .unwrap();
    w(&e.gpath, "README.md", "# nexus\n");
    w(&e.root, "README.md", "# person\n");
    assert!(matches!(
        writeback_run(&e.ctx(), &e.pid, "run_c", &unverified()).unwrap(),
        Outcome::Conflict(_)
    ));
    assert_eq!(r(&e.root, "README.md"), "# person\n");
}

#[test]
fn an_unresolved_unattested_check_blocks_writeback_under_every_policy() {
    let hazard = || {
        let mut v = good_run();
        v["codingOutcome"]["verification"] = json!("unattested-checks");
        v["codingOutcome"]["checksUnattestedUnresolved"] = json!(1);
        v["completion"] = json!("unattested-checks");
        v
    };
    for apply_unverified in [false, true] {
        let e = env();
        e.stage();
        if apply_unverified {
            e.store
                .update(&e.pid, |p| {
                    p.consent.as_mut().unwrap().apply_unverified = true
                })
                .unwrap();
        }
        w(&e.gpath, "README.md", "# nexus\n");
        assert!(
            matches!(
                writeback_run(&e.ctx(), &e.pid, "run_h", &hazard()).unwrap(),
                Outcome::NotApplied(ref why) if why.contains("compound command")
            ),
            "apply_unverified={apply_unverified}"
        );
        assert_eq!(r(&e.root, "README.md"), "# hi\n");
    }
}

#[test]
fn every_single_hazard_signal_blocks_each_policy_and_a_resolved_one_does_not() {
    type Mutator = fn(&mut Value);
    let signals: [(&str, Mutator); 4] = [
        ("count", |v| {
            v["codingOutcome"]["checksUnattestedUnresolved"] = json!(2)
        }),
        ("run_count", |v| v["unresolvedUnattestedChecks"] = json!(1)),
        ("verification", |v| {
            v["codingOutcome"]["verification"] = json!("unattested-checks")
        }),
        ("completion", |v| {
            v["completion"] = json!("unattested-checks")
        }),
    ];
    for apply_unverified in [false, true] {
        for (name, m) in signals {
            let mut v = good_run();
            m(&mut v);
            assert!(
                qualifies_with(&v, apply_unverified).is_err(),
                "{name} apply_unverified={apply_unverified}"
            );
        }
        // resolved: the counters are back to zero and the verdict is the normal one
        let mut v = good_run();
        v["codingOutcome"]["checksUnattestedUnresolved"] = json!(0);
        v["codingOutcome"]["checksUnattestedResolved"] = json!(1);
        assert!(
            qualifies_with(&v, apply_unverified).is_ok(),
            "apply_unverified={apply_unverified}"
        );
    }
    // an older engine that records no hazards behaves as before
    assert!(qualifies_with(&good_run(), true).is_ok());
}

#[test]
fn the_opt_in_never_applies_a_hazard_a_failed_check_an_uncertain_outcome_or_a_cancelled_run() {
    let base = || {
        let mut v = good_run();
        v["codingOutcome"]["verification"] = json!("no-test-executed");
        v
    };
    assert!(
        qualifies_with(&base(), true).is_ok(),
        "the opt-in's own case still applies"
    );
    type Mutator = fn(&mut Value);
    let cases: [(&str, Mutator); 8] = [
        ("hazard", |v| {
            v["codingOutcome"]["checksUnattestedUnresolved"] = json!(1)
        }),
        ("failed", |v| {
            v["codingOutcome"]["checksFailedUnresolved"] = json!(1)
        }),
        ("verified_failed", |v| {
            v["codingOutcome"]["verification"] = json!("verified-failed")
        }),
        ("uncertain", |v| {
            v["codingOutcome"]["verification"] = json!("uncertain")
        }),
        ("uncertain_ops", |v| {
            v["codingOutcome"]["uncertainOperations"] = json!(1)
        }),
        ("cancelled", |v| v["state"] = json!("cancelled")),
        ("cancel_requested", |v| v["cancelRequested"] = json!(true)),
        ("hazard_and_cancel", |v| {
            v["codingOutcome"]["checksUnattestedUnresolved"] = json!(1);
            v["cancelRequested"] = json!(true);
        }),
    ];
    for (name, m) in cases {
        let mut v = base();
        m(&mut v);
        assert!(qualifies_with(&v, true).is_err(), "{name}");
    }
}
