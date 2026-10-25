//! M3B: checkpoints, pre-images and guarded restoration.
//! Part 1 drives the real observer/checkpoint/restore code against a disposable folder with a simulated
//! command (precise conflict cases). Part 2 runs real sandboxed commands (prints `NOT RUN` without a sandbox).

mod common;

use common::*;
use nexus_tools::checkpoint::{self, CheckpointPolicy, Mode};
use nexus_tools::observe::{self, EffectsRecord, ObserveBudget};
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::restore::{self, RestoreOptions, RestoreReport};
use nexus_tools::workspace::{Workspace, WorkspacePolicy};
use nexus_tools::{authorize, execute_process_in, CancellationToken};
use serde_json::json;
use std::path::{Path, PathBuf};

// ------------------------------------------------------------------------------ part 1: simulated

struct Sim {
    _t: tempfile::TempDir,
    root: PathBuf,
    store: PathBuf,
    eff: PathBuf,
    ws: Workspace,
}

fn sim(files: &[(&str, &str)]) -> Sim {
    let t = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(t.path()).unwrap().join("proj");
    std::fs::create_dir_all(&root).unwrap();
    for (p, c) in files {
        let f = root.join(p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, c).unwrap();
    }
    let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let base = t.path().join("data");
    Sim {
        store: base.join("_checkpoints"),
        eff: base.join("_effects"),
        _t: t,
        root,
        ws,
    }
}

fn pol(mode: Mode) -> CheckpointPolicy {
    CheckpointPolicy {
        mode,
        ..Default::default()
    }
}

/// Checkpoint, run `cmd` (a closure that mutates the folder), observe, and persist the record exactly the
/// way the process lifecycle does.
fn run_sim(s: &Sim, id: &str, p: &CheckpointPolicy, cmd: impl FnOnce(&Path)) -> EffectsRecord {
    let b = ObserveBudget::default();
    let pre = observe::observe(&s.ws, &b);
    let ck = checkpoint::create(&s.ws, &s.store, id, &pre, p);
    cmd(&s.root);
    let post = observe::observe(&s.ws, &b);
    let (mut fx, changed) = observe::diff(&pre, &post, &b);
    observe::hash_changed(&s.ws, &changed, &mut fx, &b);
    let recov = checkpoint::assess(ck.as_ref().ok(), &fx);
    let state = observe::ProcessState {
        exited: true,
        how: "exited".into(),
        exit_code: Some(0),
        settled: true,
    };
    let (outcome, reasons) = observe::judge(&pre, Some(&post), &state, true);
    let mut r = EffectsRecord {
        schema: observe::RECORD_SCHEMA.into(),
        execution_id: id.into(),
        task_instance_id: "task".into(),
        command_id: "cmd".into(),
        workspace: pre.root.clone(),
        grant: None,
        fs_scope: "workspace".into(),
        started_ms: 1,
        ended_ms: 2,
        pre: observe::ManifestBrief::of(&pre),
        post: Some(observe::ManifestBrief::of(&post)),
        process: state,
        post_state: observe::post_state_of(&post, &fx),
        checkpoint: ck.as_ref().ok().map(|i| i.brief()),
        recoverability: Some(recov),
        effects: fx,
        outcome,
        outcome_reasons: reasons,
        attribution: "temporal".into(),
        note: observe::ATTRIBUTION_NOTE.into(),
        digest: String::new(),
    };
    r.digest = r.compute_digest();
    observe::write_record(&s.eff, &r).unwrap();
    r
}

fn rest(s: &Sim, id: &str, dry: bool) -> RestoreReport {
    restore::restore(
        &s.ws,
        &s.store,
        &s.eff,
        id,
        RestoreOptions {
            dry_run: dry,
            max_operations: None,
        },
    )
}

fn read(root: &Path, p: &str) -> Option<String> {
    std::fs::read_to_string(root.join(p)).ok()
}

fn paths(v: &[restore::Item]) -> Vec<&str> {
    v.iter().map(|i| i.path.as_str()).collect()
}

#[test]
fn a_formatter_rewriting_several_files_is_fully_recoverable_and_restoring_twice_is_safe() {
    let s = sim(&[
        ("a.txt", "x   y\n"),
        ("src/b.txt", "p   q\n"),
        ("src/c.txt", "same\n"),
    ]);
    let r = run_sim(&s, "fmt-1", &pol(Mode::BestEffort), |root| {
        std::fs::write(root.join("a.txt"), "x y\n").unwrap();
        std::fs::write(root.join("src/b.txt"), "p q\n").unwrap();
    });
    let rc = r.recoverability.as_ref().unwrap();
    assert!(rc.complete, "{rc:?}");
    assert_eq!(rc.available, 2);
    assert_eq!(rc.pre_images["a.txt"], "available");
    let dry = rest(&s, "fmt-1", true);
    assert_eq!(dry.outcome, "completed", "{dry:?}");
    assert_eq!(
        read(&s.root, "a.txt").unwrap(),
        "x y\n",
        "a dry run changed the folder"
    );
    let rep = rest(&s, "fmt-1", false);
    assert_eq!(rep.outcome, "completed", "{rep:?}");
    assert_eq!(paths(&rep.restored), vec!["a.txt", "src/b.txt"]);
    assert_eq!(read(&s.root, "a.txt").unwrap(), "x   y\n");
    assert_eq!(read(&s.root, "src/b.txt").unwrap(), "p   q\n");
    assert_eq!(read(&s.root, "src/c.txt").unwrap(), "same\n");
    // again: nothing to do, nothing harmed
    let again = rest(&s, "fmt-1", false);
    assert!(
        again.restored.is_empty() && again.conflicted.is_empty(),
        "{again:?}"
    );
    assert_eq!(again.skipped.len(), 2);
}

#[test]
fn deleted_files_and_directories_come_back_with_mode_and_time() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let s = sim(&[
        ("tools/run.sh", "#!/bin/sh\n"),
        ("tools/sub/n.txt", "n\n"),
        ("keep.txt", "k\n"),
    ]);
    std::fs::set_permissions(
        s.root.join("tools/run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let before = std::fs::metadata(s.root.join("tools/run.sh"))
        .unwrap()
        .mtime();
    let r = run_sim(&s, "del-1", &pol(Mode::BestEffort), |root| {
        std::fs::remove_dir_all(root.join("tools")).unwrap();
    });
    assert!(r
        .effects
        .deleted
        .paths
        .contains(&"tools/run.sh".to_string()));
    let rep = rest(&s, "del-1", false);
    assert_eq!(rep.outcome, "completed", "{rep:?}");
    assert_eq!(read(&s.root, "tools/run.sh").unwrap(), "#!/bin/sh\n");
    assert_eq!(read(&s.root, "tools/sub/n.txt").unwrap(), "n\n");
    let md = std::fs::metadata(s.root.join("tools/run.sh")).unwrap();
    assert_eq!(md.permissions().mode() & 0o777, 0o755);
    assert_eq!(md.mtime(), before);
}

#[test]
fn created_files_are_removed_only_while_they_are_still_what_the_command_left() {
    let s = sim(&[("old.txt", "o\n")]);
    run_sim(&s, "cr-1", &pol(Mode::BestEffort), |root| {
        std::fs::create_dir_all(root.join("gen/deep")).unwrap();
        std::fs::write(root.join("gen/deep/a.txt"), "a\n").unwrap();
        std::fs::write(root.join("gen/b.txt"), "b\n").unwrap();
        std::fs::write(root.join("new.txt"), "n\n").unwrap();
    });
    // the user edits one created file and adds their own file inside a created directory
    std::fs::write(s.root.join("gen/b.txt"), "b edited by a person\n").unwrap();
    std::fs::write(s.root.join("gen/deep/mine.txt"), "mine\n").unwrap();
    let rep = rest(&s, "cr-1", false);
    assert_eq!(rep.outcome, "partial", "{rep:?}");
    assert_eq!(paths(&rep.conflicted), vec!["gen/b.txt"]);
    assert!(!s.root.join("new.txt").exists() && !s.root.join("gen/deep/a.txt").exists());
    assert_eq!(
        read(&s.root, "gen/b.txt").unwrap(),
        "b edited by a person\n"
    );
    assert_eq!(read(&s.root, "gen/deep/mine.txt").unwrap(), "mine\n");
    assert!(
        s.root.join("gen/deep").is_dir(),
        "a directory holding user data was removed"
    );
    assert_eq!(read(&s.root, "old.txt").unwrap(), "o\n");
}

#[test]
fn a_later_user_edit_is_a_conflict_and_is_preserved() {
    let s = sim(&[("a.txt", "one\n"), ("b.txt", "two\n"), ("c.txt", "three\n")]);
    run_sim(&s, "cf-1", &pol(Mode::BestEffort), |root| {
        std::fs::write(root.join("a.txt"), "ONE\n").unwrap();
        std::fs::write(root.join("b.txt"), "TWO\n").unwrap();
        std::fs::remove_file(root.join("c.txt")).unwrap();
    });
    std::fs::write(s.root.join("a.txt"), "ONE then edited by a person\n").unwrap();
    std::fs::write(s.root.join("c.txt"), "recreated by a person\n").unwrap();
    let rep = rest(&s, "cf-1", false);
    assert_eq!(paths(&rep.restored), vec!["b.txt"]);
    let mut c = paths(&rep.conflicted);
    c.sort();
    assert_eq!(c, vec!["a.txt", "c.txt"], "{rep:?}");
    assert_eq!(
        read(&s.root, "a.txt").unwrap(),
        "ONE then edited by a person\n"
    );
    assert_eq!(read(&s.root, "c.txt").unwrap(), "recreated by a person\n");
    assert_eq!(read(&s.root, "b.txt").unwrap(), "two\n");
    assert_eq!(rep.outcome, "partial");
}

#[test]
fn symlinks_are_recorded_never_followed_and_restored_conservatively() {
    let s = sim(&[("real.txt", "r\n")]);
    std::os::unix::fs::symlink("real.txt", s.root.join("ln")).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", s.root.join("evil")).unwrap();
    let r = run_sim(&s, "sl-1", &pol(Mode::BestEffort), |root| {
        std::fs::remove_file(root.join("ln")).unwrap();
        std::os::unix::fs::symlink("elsewhere", root.join("ln")).unwrap();
        std::os::unix::fs::symlink("/etc/shadow", root.join("made")).unwrap();
    });
    let idx = checkpoint::read_index(&s.store, "sl-1").unwrap();
    assert_eq!(idx.entries["evil"].kind, "l");
    assert!(
        idx.entries["evil"].blob.is_none(),
        "a symlink target's content must never be copied"
    );
    assert_eq!(idx.entries["evil"].target.as_deref(), Some("/etc/passwd"));
    assert!(r
        .effects
        .symlinks
        .iter()
        .any(|l| l.path == "made" && l.escapes_root));
    let rep = rest(&s, "sl-1", false);
    assert_eq!(
        std::fs::read_link(s.root.join("ln")).unwrap().to_str(),
        Some("real.txt")
    );
    assert!(std::fs::symlink_metadata(s.root.join("made")).is_err());
    assert!(std::fs::symlink_metadata(s.root.join("evil")).is_ok());
    assert!(rep.conflicted.is_empty(), "{rep:?}");
}

#[test]
fn hard_linked_files_are_flagged_and_never_rewritten() {
    let s = sim(&[("a.txt", "shared\n")]);
    std::fs::hard_link(s.root.join("a.txt"), s.root.join("b.txt")).unwrap();
    let r = run_sim(&s, "hl-1", &pol(Mode::BestEffort), |root| {
        std::fs::write(root.join("a.txt"), "changed through one name\n").unwrap();
    });
    let idx = checkpoint::read_index(&s.store, "hl-1").unwrap();
    assert!(idx.entries["a.txt"].hardlinked && idx.entries["b.txt"].hardlinked);
    assert!(
        r.effects
            .hardlink_risks
            .paths
            .contains(&"a.txt".to_string()),
        "{:?}",
        r.effects.hardlink_risks
    );
    let rep = rest(&s, "hl-1", false);
    assert_eq!(
        paths(&rep.conflicted),
        vec!["a.txt", "b.txt"]
            .into_iter()
            .filter(|p| rep.conflicted.iter().any(|c| c.path == *p))
            .collect::<Vec<_>>()
    );
    assert!(
        rep.conflicted
            .iter()
            .any(|c| c.path == "a.txt" && c.detail.contains("hard-linked")),
        "{rep:?}"
    );
    assert_eq!(
        read(&s.root, "a.txt").unwrap(),
        "changed through one name\n",
        "a hard-linked file must not be rewritten"
    );
}

#[test]
fn changes_inside_dependency_directories_are_never_claimed_recoverable() {
    let s = sim(&[("src/a.txt", "a\n"), ("node_modules/pkg/i.js", "1\n")]);
    let r = run_sim(&s, "bulk-1", &pol(Mode::BestEffort), |root| {
        std::fs::write(root.join("node_modules/pkg/i.js"), "22\n").unwrap();
        std::fs::write(root.join("src/a.txt"), "A\n").unwrap();
    });
    let rc = r.recoverability.as_ref().unwrap();
    assert!(!rc.complete);
    assert_eq!(rc.bulk_not_captured, 1);
    assert_eq!(rc.pre_images["src/a.txt"], "available");
    let idx = checkpoint::read_index(&s.store, "bulk-1").unwrap();
    assert!(idx
        .coverage
        .bulk_dirs_not_captured
        .contains(&"node_modules".to_string()));
    let rep = rest(&s, "bulk-1", false);
    assert!(
        rep.unrecoverable
            .iter()
            .any(|u| u.path == "node_modules" && u.detail.contains("bulk")),
        "{rep:?}"
    );
    assert_eq!(read(&s.root, "src/a.txt").unwrap(), "a\n");
    assert_eq!(rep.outcome, "partial");
}

#[test]
fn secret_shaped_files_are_never_copied_into_a_checkpoint() {
    let s = sim(&[
        ("config/secrets.json", "{\"k\":\"S3CRET\"}\n"),
        ("a.txt", "a\n"),
    ]);
    let r = run_sim(&s, "sec-1", &pol(Mode::BestEffort), |root| {
        std::fs::write(root.join("config/secrets.json"), "{}\n").unwrap();
    });
    let idx = checkpoint::read_index(&s.store, "sec-1").unwrap();
    assert_eq!(
        idx.entries["config/secrets.json"].excluded.as_deref(),
        Some("secret-shaped")
    );
    assert_eq!(idx.coverage.secret_shaped_excluded, 1);
    // no stored file contains the secret
    for e in std::fs::read_dir(s.store.join("sec-1/files"))
        .unwrap()
        .flatten()
    {
        assert!(!std::fs::read_to_string(e.path())
            .unwrap_or_default()
            .contains("S3CRET"));
    }
    let rc = r.recoverability.unwrap();
    if let Some(v) = rc.pre_images.get("config/secrets.json") {
        assert_eq!(v, "unavailable:secret-shaped");
    }
    let rep = rest(&s, "sec-1", false);
    assert!(!rep.restored.iter().any(|i| i.path.contains("secrets")));
}

#[test]
fn a_checkpoint_never_claims_completeness_when_content_was_excluded() {
    let s = sim(&[
        ("a.txt", "aaaa\n"),
        ("b.txt", "bbbb\n"),
        ("c.txt", "cccc\n"),
    ]);
    let mut p = pol(Mode::BestEffort);
    p.budget.max_bytes = 11; // room for two of the three files
    let r = run_sim(&s, "bud-1", &p, |root| {
        for f in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(root.join(f), "changed\n").unwrap();
        }
    });
    let idx = checkpoint::read_index(&s.store, "bud-1").unwrap();
    assert_eq!(idx.status, "incomplete");
    assert!(idx.reasons.contains(&"size-budget".to_string()));
    assert_eq!(idx.files_stored, 2);
    let rc = r.recoverability.unwrap();
    assert!(!rc.complete);
    assert_eq!(rc.unavailable, 1);
    let rep = rest(&s, "bud-1", false);
    assert_eq!(rep.restored.len(), 2);
    assert_eq!(rep.unrecoverable.len(), 1);
    assert_eq!(rep.checkpoint_status.as_deref(), Some("incomplete"));
    assert_eq!(rep.outcome, "partial");
}

#[test]
fn a_file_changed_after_it_was_observed_is_reported_not_stored_as_consistent() {
    let s = sim(&[("a.txt", "one\n"), ("b.txt", "two\n")]);
    let b = ObserveBudget::default();
    let pre = observe::observe(&s.ws, &b);
    std::thread::sleep(std::time::Duration::from_millis(5));
    std::fs::write(
        s.root.join("a.txt"),
        "edited by a person while the checkpoint started\n",
    )
    .unwrap();
    let idx = checkpoint::create(&s.ws, &s.store, "race-1", &pre, &pol(Mode::BestEffort)).unwrap();
    assert_eq!(idx.status, "incomplete");
    assert!(
        idx.reasons
            .iter()
            .any(|r| r.starts_with("changed-since-observation:a.txt")),
        "{:?}",
        idx.reasons
    );
    assert!(idx.entries["a.txt"].blob.is_none());
    assert!(idx.entries["b.txt"].blob.is_some());
    assert!(idx.consistency.starts_with("Not an atomic snapshot"));
}

#[test]
fn insufficient_storage_is_explicit_and_leaves_nothing_behind() {
    let s = sim(&[("a.txt", "aaaa\n")]);
    let mut p = pol(Mode::BestEffort);
    p.force_copy = true;
    p.budget.min_free_bytes = u64::MAX / 2;
    let pre = observe::observe(&s.ws, &ObserveBudget::default());
    let e = checkpoint::create(&s.ws, &s.store, "full-1", &pre, &p).unwrap_err();
    assert_eq!(e.reasons, vec!["insufficient-storage"]);
    let left: Vec<_> = std::fs::read_dir(&s.store)
        .map(|d| d.flatten().map(|e| e.file_name()).collect())
        .unwrap_or_default();
    assert!(left.is_empty(), "partial checkpoint left behind: {left:?}");
}

#[test]
fn a_missing_or_corrupted_checkpoint_refuses_or_reports_never_manufactures_recoverability() {
    for case in [
        "index-missing",
        "index-tampered",
        "blob-corrupt",
        "blob-missing",
        "other-workspace",
    ] {
        let s = sim(&[("a.txt", "one\n"), ("b.txt", "two\n")]);
        let id = format!("bad-{case}");
        run_sim(&s, &id, &pol(Mode::BestEffort), |root| {
            std::fs::write(root.join("a.txt"), "ONE\n").unwrap();
            std::fs::write(root.join("b.txt"), "TWO\n").unwrap();
        });
        let ck = s.store.join(&id);
        let idx = checkpoint::read_index(&s.store, &id).unwrap();
        let blob_of = |p: &str| ck.join("files").join(idx.entries[p].blob.clone().unwrap());
        match case {
            "index-missing" => std::fs::remove_file(ck.join("index.json")).unwrap(),
            "index-tampered" => {
                let t = std::fs::read_to_string(ck.join("index.json"))
                    .unwrap()
                    .replace("\"complete\"", "\"incomplete\"");
                std::fs::write(ck.join("index.json"), t).unwrap();
            }
            "blob-corrupt" => std::fs::write(blob_of("a.txt"), "evil\n").unwrap(),
            "blob-missing" => std::fs::remove_file(blob_of("a.txt")).unwrap(),
            _ => {}
        }
        let rep = if case == "other-workspace" {
            // a different folder with another identity
            let other = sim(&[("a.txt", "ONE\n")]);
            restore::restore(&other.ws, &s.store, &s.eff, &id, RestoreOptions::default())
        } else {
            rest(&s, &id, false)
        };
        match case {
            "index-missing" | "index-tampered" | "other-workspace" => {
                assert_eq!(rep.outcome, "refused", "{case}: {rep:?}");
                assert_eq!(read(&s.root, "a.txt").unwrap(), "ONE\n");
            }
            _ => {
                assert!(
                    rep.unrecoverable.iter().any(|u| u.path == "a.txt"),
                    "{case}: {rep:?}"
                );
                assert_eq!(
                    read(&s.root, "a.txt").unwrap(),
                    "ONE\n",
                    "{case}: a corrupt pre-image was applied"
                );
                assert_eq!(
                    read(&s.root, "b.txt").unwrap(),
                    "two\n",
                    "{case}: the intact file was restored"
                );
                assert!(
                    std::fs::read_dir(&s.root).unwrap().flatten().all(|e| !e
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".nexus-restore")),
                    "temp file left"
                );
            }
        }
    }
}

#[test]
fn restoration_can_be_interrupted_and_resumed_without_harm() {
    let files: Vec<(String, String)> = (0..6)
        .map(|i| (format!("f{i}.txt"), format!("orig {i}\n")))
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let s = sim(&refs);
    run_sim(&s, "res-1", &pol(Mode::BestEffort), |root| {
        for (p, _) in &files {
            std::fs::write(root.join(p), "changed!\n").unwrap();
        }
    });
    let first = restore::restore(
        &s.ws,
        &s.store,
        &s.eff,
        "res-1",
        RestoreOptions {
            dry_run: false,
            max_operations: Some(2),
        },
    );
    assert!(first.stopped_at_operation_limit);
    assert_eq!(first.restored.len(), 2);
    assert_eq!(first.outcome, "partial");
    let second = rest(&s, "res-1", false);
    assert_eq!(second.restored.len(), 4, "{second:?}");
    assert_eq!(second.skipped.len(), 2);
    for (p, c) in &files {
        assert_eq!(&read(&s.root, p).unwrap(), c);
    }
}

#[test]
fn a_command_that_rewrites_thousands_of_files_is_fully_restorable() {
    let n = 1_200; // more than the old 500-path record cap
    let files: Vec<(String, String)> = (0..n)
        .map(|i| (format!("d{}/f{i}.txt", i % 10), format!("orig {i}\n")))
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let s = sim(&refs);
    let r = run_sim(&s, "big-1", &pol(Mode::BestEffort), |root| {
        for (p, _) in &files {
            std::fs::write(root.join(p), "changed!!\n").unwrap();
        }
    });
    assert!(
        !r.effects.modified.truncated,
        "{}",
        r.effects.modified.count
    );
    assert!(r.recoverability.as_ref().unwrap().complete);
    let rep = rest(&s, "big-1", false);
    assert_eq!(
        rep.outcome,
        "completed",
        "restored {} conflicted {}",
        rep.restored.len(),
        rep.conflicted.len()
    );
    assert_eq!(rep.restored.len(), n);
    assert_eq!(read(&s.root, "d3/f13.txt").unwrap(), "orig 13\n");
}

#[test]
fn a_workspace_whose_identity_changed_is_never_touched() {
    let s = sim(&[("a.txt", "one\n")]);
    run_sim(&s, "id-1", &pol(Mode::BestEffort), |root| {
        std::fs::write(root.join("a.txt"), "ONE\n").unwrap();
    });
    // the folder is replaced by another one at the same path
    let moved = s.root.with_file_name("proj-old");
    std::fs::rename(&s.root, &moved).unwrap();
    std::fs::create_dir_all(&s.root).unwrap();
    std::fs::write(s.root.join("a.txt"), "ONE\n").unwrap();
    let ws2 = Workspace::open_root(s.root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let rep = restore::restore(&ws2, &s.store, &s.eff, "id-1", RestoreOptions::default());
    assert_eq!(rep.refused.as_deref(), Some("workspace-identity-changed"));
    assert_eq!(read(&s.root, "a.txt").unwrap(), "ONE\n");
}

#[test]
fn retention_quota_and_startup_sweep_clean_up_without_touching_active_checkpoints() {
    let s = sim(&[("a.txt", "aaaa\n")]);
    for i in 0..3 {
        run_sim(&s, &format!("gc-{i}"), &pol(Mode::BestEffort), |_| {});
        checkpoint::finish(&s.store, &format!("gc-{i}"));
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // an unpublished leftover and an ACTIVE execution
    std::fs::create_dir_all(s.store.join("dead.partial/files")).unwrap();
    let mut b = checkpoint::CheckpointBudget {
        store_quota_bytes: 5, // one 5-byte checkpoint fits
        ..Default::default()
    };
    let rep = checkpoint::gc(&s.store, &b);
    assert_eq!(rep.removed, 2, "{rep:?}");
    assert!(
        !s.store.join("gc-0").exists() && s.store.join("gc-2").exists(),
        "the newest must survive"
    );
    std::fs::write(s.store.join("gc-2/ACTIVE"), b"1").unwrap();
    b.store_quota_bytes = 0;
    b.retention_secs = 0;
    std::thread::sleep(std::time::Duration::from_millis(1100));
    checkpoint::gc(&s.store, &b);
    assert!(
        s.store.join("gc-2").exists(),
        "an ACTIVE checkpoint was collected"
    );
    checkpoint::startup_sweep(&s.store, &b);
    assert!(!s.store.join("dead.partial").exists());
    assert!(
        !s.store.join("gc-2").exists(),
        "after the sweep the stale ACTIVE marker no longer protects it"
    );
}

#[test]
fn the_store_is_private_and_blobs_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let s = sim(&[("a.txt", "a\n")]);
    run_sim(&s, "perm-1", &pol(Mode::BestEffort), |_| {});
    let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(s.store.clone()), 0o700);
    assert_eq!(mode(s.store.join("perm-1")), 0o700);
    assert_eq!(mode(s.store.join("perm-1/files")), 0o700);
    assert_eq!(mode(s.store.join("perm-1/index.json")), 0o600);
    for e in std::fs::read_dir(s.store.join("perm-1/files"))
        .unwrap()
        .flatten()
    {
        assert_eq!(mode(e.path()), 0o600);
    }
    // the store is outside the workspace root
    assert!(!s.store.starts_with(&s.root));
}

// ------------------------------------------------------------------------------ part 2: real sandbox

fn policy(mode: Mode) -> CommandPolicy {
    CommandPolicy::standard(Toolchain::discover())
        .with_workbench()
        .with_checkpoint(pol(mode))
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

fn restore_real(fx: &Fx, id: &str, dry: bool) -> RestoreReport {
    let ws = Workspace::open_root(fx.ws.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let run_root = fx.dir.path().join("exec");
    restore::restore(
        &ws,
        &checkpoint::store_dir(&run_root),
        &observe::effects_dir(&run_root),
        id,
        RestoreOptions {
            dry_run: dry,
            max_operations: None,
        },
    )
}

#[test]
fn a_real_command_is_checkpointed_before_it_runs_and_its_changes_are_restorable() {
    if !ready("real") {
        return;
    }
    let mut fx = fixture("m3b-real");
    fx.write("src/a.txt", b"x   y\n");
    fx.write("src/b.txt", b"keep\n");
    fx.write("old/gone.txt", b"bye\n");
    fx.approve_process_fs(60_000, "workspace");
    let o = run(
        &mut fx,
        "sed -i 's/  */ /g' src/a.txt && rm old/gone.txt && echo n > new.txt",
        &policy(Mode::BestEffort),
    )
    .unwrap();
    let v = out(&o);
    assert_eq!(v["verification"], "pass", "{v}");
    assert_eq!(v["effects"]["checkpoint"]["status"], "complete", "{v}");
    assert_eq!(v["effects"]["recoverability"]["complete"], true, "{v}");
    let id = v["effects"]["executionId"].as_str().unwrap().to_owned();
    // the journal states the checkpoint BEFORE the process existed
    let j = fx.kernel.list_tool_journal(None).unwrap();
    let prepared = j.iter().rev().find(|e| e.phase == "prepared").unwrap();
    assert_eq!(prepared.payload["checkpoint"]["status"], "complete");
    assert_eq!(prepared.payload["checkpoint"]["consistency"], "non-atomic");
    // the sandbox cannot see the store
    assert!(!fx.ws.join("_checkpoints").exists());
    let rep = restore_real(&fx, &id, false);
    assert_eq!(rep.outcome, "completed", "{rep:?}");
    assert_eq!(fx.disk("src/a.txt").unwrap(), "x   y\n");
    assert_eq!(fx.disk("old/gone.txt").unwrap(), "bye\n");
    assert!(!fx.ws.join("new.txt").exists());
}

#[test]
fn required_mode_refuses_a_command_when_the_checkpoint_cannot_be_complete() {
    if !ready("required") {
        return;
    }
    let mut fx = fixture("m3b-required");
    fx.write("a.txt", b"aaaa\n");
    fx.approve_process_fs(60_000, "workspace");
    let mut p = pol(Mode::Required);
    p.budget.max_bytes = 1; // cannot hold the file
    let pol = CommandPolicy::standard(Toolchain::discover())
        .with_workbench()
        .with_checkpoint(p);
    let o = run(&mut fx, "echo ran > ran.txt", &pol).unwrap();
    assert!(o.result.error.is_some(), "{:?}", o.result);
    assert!(o
        .result
        .error
        .as_ref()
        .unwrap()
        .message
        .contains("checkpoint-required"));
    assert!(
        !fx.ws.join("ran.txt").exists(),
        "the command ran although no complete checkpoint existed"
    );
    // best-effort (owner decision D4) runs the same command and says so
    fx.approve_process_fs(60_000, "workspace");
    let mut p = pol_be();
    p.budget.max_bytes = 1;
    let pol = CommandPolicy::standard(Toolchain::discover())
        .with_workbench()
        .with_checkpoint(p);
    let o = run(&mut fx, "echo ran > ran.txt", &pol).unwrap();
    let v = out(&o);
    assert_eq!(v["effects"]["checkpoint"]["status"], "incomplete", "{v}");
    assert_eq!(v["effects"]["recoverability"]["complete"], false);
    assert!(fx.ws.join("ran.txt").exists());
}

fn pol_be() -> CheckpointPolicy {
    pol(Mode::BestEffort)
}

#[test]
fn a_cancelled_command_leaves_a_checkpoint_that_still_restores_what_it_half_wrote() {
    if !ready("cancel") {
        return;
    }
    let mut fx = fixture("m3b-cancel");
    fx.write("log.txt", b"start\n");
    fx.approve_process_fs(60_000, "workspace");
    let r = fx.request("proc.run", json!({"program": "sh", "args": ["-c", "(while true; do echo tick >> log.txt; sleep 0.05; done) & wait"], "cwd": "."}));
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = policy(Mode::BestEffort);
    let p = fx.prepare_p(r, &pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let run_root = fx.dir.path().join("exec");
    let c2 = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1200));
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
    assert_eq!(v["effects"]["outcome"], "partial", "{v}");
    assert_eq!(v["effects"]["recoverability"]["complete"], true);
    let id = v["effects"]["executionId"].as_str().unwrap().to_owned();
    assert!(fx.disk("log.txt").unwrap().contains("tick"));
    let rep = restore_real(&fx, &id, false);
    assert_eq!(rep.outcome, "completed", "{rep:?}");
    assert_eq!(fx.disk("log.txt").unwrap(), "start\n");
}

#[test]
fn scratch_and_model_boundaries_are_unchanged_by_checkpoints() {
    if !ready("scratch") {
        return;
    }
    let mut fx = fixture("m3b-scratch");
    fx.write("a.txt", b"one\n");
    fx.approve_process(60_000); // scratch scope
    let o = run(
        &mut fx,
        "echo x > out.txt && echo changed > a.txt",
        &policy(Mode::Required),
    )
    .unwrap();
    let v = out(&o);
    assert_eq!(v["verification"], "pass");
    assert!(
        v.get("effects").is_none(),
        "scratch gained an effects record: {v}"
    );
    assert!(
        !fx.dir.path().join("exec/_checkpoints").exists(),
        "a scratch run created a checkpoint store"
    );
    assert_eq!(fx.disk("a.txt").unwrap(), "one\n");
    // the model cannot name a checkpoint, a mode, a restore or a path
    let mut fx = fixture("m3b-boundary");
    fx.approve_process_fs(60_000, "workspace");
    for bad in [
        "checkpoint",
        "restore",
        "checkpointMode",
        "preImage",
        "store",
    ] {
        let r = fx.request(
            "proc.run",
            json!({"program": "sh", "args": ["-c", "true"], "cwd": ".", bad: true}),
        );
        assert!(
            fx.prepare_p(r, &policy(Mode::BestEffort)).is_err(),
            "'{bad}' must be refused"
        );
    }
}

#[test]
fn the_sandboxed_command_cannot_reach_the_checkpoint_store() {
    if !ready("hidden") {
        return;
    }
    let mut fx = fixture("m3b-hidden");
    fx.write("a.txt", b"SECRET-PREIMAGE\n");
    fx.approve_process_fs(60_000, "workspace");
    let store = fx.dir.path().join("exec/_checkpoints");
    let o = run(
        &mut fx,
        &format!(
            "echo changed > a.txt; ls {} 2>&1; cat {}/*/files/* 2>&1; echo done",
            store.display(),
            store.display()
        ),
        &policy(Mode::BestEffort),
    )
    .unwrap();
    let t = format!(
        "{}{}",
        out(&o)["stdout"].as_str().unwrap_or(""),
        out(&o)["stderr"].as_str().unwrap_or("")
    );
    assert!(
        !t.contains("SECRET-PREIMAGE"),
        "the command read a pre-image: {t}"
    );
    assert!(
        t.contains("No such file") || t.contains("cannot access"),
        "{t}"
    );
}

#[test]
fn the_direct_evidence_diffs_command_modifications_and_deletions_against_the_pre_images() {
    let s = sim(&[("a.txt", "one\ntwo\n"), ("gone.txt", "bye\n")]);
    let r = run_sim(&s, "dd-1", &pol(Mode::BestEffort), |root| {
        std::fs::write(root.join("a.txt"), "one\nTWO\n").unwrap();
        std::fs::remove_file(root.join("gone.txt")).unwrap();
        std::fs::write(root.join("new.txt"), "n\n").unwrap();
    });
    let base = tempfile::tempdir().unwrap();
    let root_s = s.root.to_string_lossy().into_owned();
    let store = nexus_tools::direct::Store::create(base.path(), "task-dd-1", &root_s).unwrap();
    store.record_command_effects_in(&r, Some(&s.store)).unwrap();
    let d = nexus_tools::direct::diff(&store, &root_s).unwrap();
    let a = d.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(
        a.pre_image && a.origin == "command" && a.status == "modified",
        "{a:?}"
    );
    assert!(
        d.diff.contains("-two") && d.diff.contains("+TWO"),
        "{}",
        d.diff
    );
    let g = d.files.iter().find(|f| f.path == "gone.txt").unwrap();
    assert!(g.pre_image && g.status == "deleted", "{g:?}");
    assert!(d.diff.contains("-bye"), "{}", d.diff);
    // without the checkpoint reference the same evidence is honest about having no pre-image
    let store2 = nexus_tools::direct::Store::create(base.path(), "task-dd-2", &root_s).unwrap();
    store2.record_command_effects(&r).unwrap();
    let d2 = nexus_tools::direct::diff(&store2, &root_s).unwrap();
    assert!(
        !d2.files
            .iter()
            .find(|f| f.path == "a.txt")
            .unwrap()
            .pre_image
    );
}

// ------------------------------------------------------------------------------ benchmark

fn tree(root: &Path, src: usize, dep: usize) {
    for i in 0..src {
        let d = root.join(format!("src/mod{}/sub{}", i % 40, i % 7));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join(format!("f{i}.rs")),
            format!("fn f{i}() {{ /* {} */ }}\n", "x".repeat(200)),
        )
        .unwrap();
    }
    for i in 0..dep {
        let d = root.join(format!("node_modules/pkg{}/lib{}", i % 500, i % 11));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("i{i}.js")), "x\n").unwrap();
    }
}

fn used(p: &Path) -> u64 {
    // blocks actually allocated under p (reflinked blocks are shared and still counted per file by du;
    // the filesystem-level number below is the one that shows real growth)
    let mut t = 0u64;
    let mut st = vec![p.to_path_buf()];
    while let Some(d) = st.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let m = e.metadata().unwrap();
            if m.is_dir() {
                st.push(e.path());
            } else {
                use std::os::unix::fs::MetadataExt;
                t += m.blocks() * 512;
            }
        }
    }
    t
}

fn fs_free(p: &Path) -> u64 {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    unsafe { libc::statvfs(c.as_ptr(), &mut s) };
    s.f_bavail * s.f_frsize
}

/// `cargo test -p nexus-tools --test checkpoint_m3b --release -- --ignored --nocapture bench_checkpoint`
/// Set `NEXUS_BENCH_DIR` to a directory on the filesystem under test (default: the system temp dir).
#[test]
#[ignore]
fn bench_checkpoint() {
    let base = std::env::var("NEXUS_BENCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    for (name, src, dep) in [
        ("1k", 1_000usize, 0usize),
        ("20k", 20_000, 0),
        ("large+deps", 20_000, 130_000),
    ] {
        for force_copy in [false, true] {
            for (shape, rewrite_pct) in [("sparse-edits", 1usize), ("rewrite-all", 100)] {
                let t = tempfile::tempdir_in(&base).unwrap();
                let root = std::fs::canonicalize(t.path()).unwrap().join("proj");
                std::fs::create_dir_all(&root).unwrap();
                tree(&root, src, dep);
                let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default())
                    .unwrap();
                let data = tempfile::tempdir_in(&base).unwrap();
                let store = data.path().join("_checkpoints");
                let eff = data.path().join("_effects");
                let mut p = pol(Mode::BestEffort);
                p.force_copy = force_copy;
                p.budget.max_bytes = u64::MAX / 4;
                p.budget.max_files = u64::MAX / 4;
                let b = ObserveBudget::default();
                let pre = observe::observe(&ws, &b);
                let free0 = fs_free(&base);
                let t0 = std::time::Instant::now();
                let idx = checkpoint::create(&ws, &store, "bench", &pre, &p).unwrap();
                let create_ms = t0.elapsed().as_millis();
                let free1 = fs_free(&base);
                let physical = free0.saturating_sub(free1);
                // the command: rewrite a share of the source files
                let n = src * rewrite_pct / 100;
                for i in 0..n {
                    let f = root.join(format!("src/mod{}/sub{}/f{i}.rs", i % 40, i % 7));
                    std::fs::write(f, format!("fn f{i}() {{ /* {} */ }}\n", "y".repeat(200)))
                        .unwrap();
                }
                let free2 = fs_free(&base);
                let post = observe::observe(&ws, &b);
                let (mut fx, ch) = observe::diff(&pre, &post, &b);
                observe::hash_changed(&ws, &ch, &mut fx, &b);
                let recov = checkpoint::finish_assess_for_bench(&idx, &fx);
                let state = observe::ProcessState {
                    exited: true,
                    how: "exited".into(),
                    exit_code: Some(0),
                    settled: true,
                };
                let (outcome, reasons) = observe::judge(&pre, Some(&post), &state, true);
                let mut r = EffectsRecord {
                    schema: observe::RECORD_SCHEMA.into(),
                    execution_id: "bench".into(),
                    task_instance_id: "t".into(),
                    command_id: "c".into(),
                    workspace: pre.root.clone(),
                    grant: None,
                    fs_scope: "workspace".into(),
                    started_ms: 1,
                    ended_ms: 2,
                    pre: observe::ManifestBrief::of(&pre),
                    post: Some(observe::ManifestBrief::of(&post)),
                    process: state,
                    post_state: observe::post_state_of(&post, &fx),
                    checkpoint: Some(idx.brief()),
                    recoverability: Some(recov),
                    effects: fx,
                    outcome,
                    outcome_reasons: reasons,
                    attribution: "temporal".into(),
                    note: String::new(),
                    digest: String::new(),
                };
                r.digest = r.compute_digest();
                observe::write_record(&eff, &r).unwrap();
                let t1 = std::time::Instant::now();
                let rep = restore::restore(&ws, &store, &eff, "bench", RestoreOptions::default());
                let restore_ms = t1.elapsed().as_millis();
                println!(
                    "BENCH {name} {shape} {}: files={} ckpt_create_ms={create_ms} ckpt_method={} fs_growth_at_checkpoint_bytes={physical} \
                     fs_growth_after_command_bytes={} store_allocated_bytes={} logical_bytes={} restore_ms={restore_ms} restored={} outcome={}",
                    if force_copy { "copy" } else { "auto" },
                    idx.files_stored, idx.method, free1.saturating_sub(free2), used(&store), idx.logical_bytes, rep.restored.len(), rep.outcome,
                );
            }
        }
    }
}

/// Large files, where a reflink shares extents and a copy writes them: `cargo test ... --release -- --ignored
/// --nocapture bench_checkpoint_large_files` (set `NEXUS_BENCH_DIR`).
#[test]
#[ignore]
fn bench_checkpoint_large_files() {
    let base = std::env::var("NEXUS_BENCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    for force_copy in [false, true] {
        let t = tempfile::tempdir_in(&base).unwrap();
        let root = std::fs::canonicalize(t.path()).unwrap().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let block: Vec<u8> = (0..8 * 1024 * 1024u32)
            .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
            .collect();
        for i in 0..64 {
            std::fs::write(root.join(format!("big{i}.bin")), &block).unwrap();
        }
        let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
        let data = tempfile::tempdir_in(&base).unwrap();
        let store = data.path().join("_checkpoints");
        let mut p = pol(Mode::BestEffort);
        p.force_copy = force_copy;
        let pre = observe::observe(&ws, &ObserveBudget::default());
        unsafe { libc::sync() };
        let free0 = fs_free(&base);
        let t0 = std::time::Instant::now();
        let idx = checkpoint::create(&ws, &store, "bigbench", &pre, &p).unwrap();
        let ms = t0.elapsed().as_millis();
        unsafe { libc::sync() };
        let free1 = fs_free(&base);
        // rewrite 1 file of 64 (sparse edit) and see what the checkpoint costs afterwards
        std::fs::write(root.join("big0.bin"), vec![7u8; 8 * 1024 * 1024]).unwrap();
        unsafe { libc::sync() };
        let free2 = fs_free(&base);
        println!(
            "BENCH large-files 64x8MiB {}: ckpt_create_ms={ms} method={} logical_bytes={} reflinked_bytes={} copied_bytes={} fs_growth_at_checkpoint_bytes={} fs_growth_after_one_file_rewrite_bytes={}",
            if force_copy { "copy" } else { "auto" },
            idx.method, idx.logical_bytes, idx.reflinked_bytes, idx.copied_bytes,
            free0.saturating_sub(free1), free1.saturating_sub(free2),
        );
    }
}
