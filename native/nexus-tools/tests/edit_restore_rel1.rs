//! Release 1: guarded restoration of the files Nexus's edit tools wrote in a Direct workspace.
//! Real files, a real Direct store, the real descriptor-relative primitives. Each test names a promise:
//! originals come back; created files go only when unchanged; anything you changed is never touched.

use nexus_tools::direct::Store;
use nexus_tools::edit_restore::{restore_edits, EditRestoreReport};
use nexus_tools::workspace::{Workspace, WorkspacePolicy};
use sha2::{Digest, Sha256};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

struct Fx {
    _tmp: tempfile::TempDir,
    root: std::path::PathBuf,
    store: Store,
    ws: Workspace,
}

fn fx() -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    std::fs::create_dir_all(&root).unwrap();
    let base = tmp.path().join("base");
    std::fs::create_dir_all(&base).unwrap();
    let store = Store::create(&base, "task-aaaaaaaaaaaaaaaaaaaa", root.to_str().unwrap()).unwrap();
    let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    Fx {
        _tmp: tmp,
        root,
        store,
        ws,
    }
}

impl Fx {
    /// What the edit tool does: keep the original (first touch), write the new content, verify it.
    fn edit(&self, path: &str, new: &[u8]) {
        let f = self.root.join(path);
        let pre = std::fs::read(&f).ok();
        let mode = pre.as_ref().and_then(|_| {
            std::fs::metadata(&f)
                .ok()
                .map(|m| m.permissions().mode() & 0o7777)
        });
        self.store.record_pre(path, pre.as_deref(), mode).unwrap();
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, new).unwrap();
        self.store.record_post(path, Some(&sha(new))).unwrap();
    }
    fn delete(&self, path: &str) {
        let f = self.root.join(path);
        let pre = std::fs::read(&f).unwrap();
        let mode = std::fs::metadata(&f).unwrap().permissions().mode() & 0o7777;
        self.store.record_pre(path, Some(&pre), Some(mode)).unwrap();
        std::fs::remove_file(&f).unwrap();
        self.store.record_post(path, None).unwrap();
    }
    fn preview(&self) -> EditRestoreReport {
        restore_edits(&self.ws, &self.store, true)
    }
    fn apply(&self) -> EditRestoreReport {
        restore_edits(&self.ws, &self.store, false)
    }
    fn read(&self, p: &str) -> String {
        std::fs::read_to_string(self.root.join(p)).unwrap()
    }
}

fn paths(v: &[nexus_tools::edit_restore::Item]) -> Vec<&str> {
    v.iter().map(|i| i.path.as_str()).collect()
}

#[test]
fn an_edited_file_is_put_back_with_its_original_content_and_mode() {
    let f = fx();
    std::fs::write(f.root.join("a.txt"), "original\n").unwrap();
    std::fs::set_permissions(f.root.join("a.txt"), std::fs::Permissions::from_mode(0o640)).unwrap();
    f.edit("a.txt", b"nexus was here\n");
    let pv = f.preview();
    assert_eq!(paths(&pv.restored), ["a.txt"]);
    assert_eq!(
        f.read("a.txt"),
        "nexus was here\n",
        "a preview changes nothing"
    );
    let r = f.apply();
    assert_eq!(r.outcome, "completed", "{r:?}");
    assert_eq!(f.read("a.txt"), "original\n");
    assert_eq!(
        std::fs::metadata(f.root.join("a.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o640
    );
    // running it again is safe: the file already reads as original
    let again = f.apply();
    assert_eq!(paths(&again.skipped), ["a.txt"], "{again:?}");
    assert!(again.restored.is_empty());
    // no temporary files are left behind
    let names: Vec<_> = std::fs::read_dir(&f.root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["a.txt"], "{names:?}");
}

#[test]
fn a_file_nexus_created_is_removed_only_while_it_is_unchanged() {
    let f = fx();
    f.edit("new.txt", b"made by nexus\n");
    assert_eq!(paths(&f.preview().restored), ["new.txt"]);
    let r = f.apply();
    assert_eq!(r.outcome, "completed");
    assert!(!f.root.join("new.txt").exists());

    // you changed it afterwards: it is YOURS now; never deleted
    let g = fx();
    g.edit("new.txt", b"made by nexus\n");
    std::fs::write(g.root.join("new.txt"), "made by nexus\nplus my own work\n").unwrap();
    let r = g.apply();
    assert_eq!(paths(&r.conflicted), ["new.txt"], "{r:?}");
    assert_eq!(r.outcome, "nothing-restored");
    assert_eq!(g.read("new.txt"), "made by nexus\nplus my own work\n");
}

#[test]
fn a_file_nexus_deleted_is_recreated_unless_something_stands_there_now() {
    let f = fx();
    std::fs::write(f.root.join("gone.txt"), "keep me\n").unwrap();
    f.delete("gone.txt");
    assert_eq!(paths(&f.apply().restored), ["gone.txt"]);
    assert_eq!(f.read("gone.txt"), "keep me\n");

    let g = fx();
    std::fs::write(g.root.join("gone.txt"), "keep me\n").unwrap();
    g.delete("gone.txt");
    std::fs::write(g.root.join("gone.txt"), "a different file I made\n").unwrap();
    let r = g.apply();
    assert_eq!(paths(&r.conflicted), ["gone.txt"]);
    assert_eq!(g.read("gone.txt"), "a different file I made\n");
}

#[test]
fn what_you_changed_after_nexus_is_never_overwritten_and_the_rest_still_restores() {
    let f = fx();
    std::fs::write(f.root.join("mine.txt"), "v0\n").unwrap();
    std::fs::write(f.root.join("theirs.txt"), "t0\n").unwrap();
    f.edit("mine.txt", b"v1 by nexus\n");
    f.edit("theirs.txt", b"t1 by nexus\n");
    std::fs::write(f.root.join("mine.txt"), "v2 by me\n").unwrap();
    let r = f.apply();
    assert_eq!(paths(&r.conflicted), ["mine.txt"]);
    assert_eq!(paths(&r.restored), ["theirs.txt"]);
    assert_eq!(r.outcome, "partial");
    assert_eq!(f.read("mine.txt"), "v2 by me\n");
    assert_eq!(f.read("theirs.txt"), "t0\n");
    // a file you removed afterwards stays removed
    let g = fx();
    std::fs::write(g.root.join("x.txt"), "x0\n").unwrap();
    g.edit("x.txt", b"x1\n");
    std::fs::remove_file(g.root.join("x.txt")).unwrap();
    assert_eq!(paths(&g.apply().conflicted), ["x.txt"]);
    assert!(!g.root.join("x.txt").exists());
}

#[test]
fn a_stale_preview_is_detected_by_its_digest() {
    let f = fx();
    std::fs::write(f.root.join("a.txt"), "o\n").unwrap();
    f.edit("a.txt", b"n\n");
    let reviewed = f.preview().confirm_digest();
    assert_eq!(
        f.preview().confirm_digest(),
        reviewed,
        "a preview of an unchanged state is stable"
    );
    std::fs::write(f.root.join("a.txt"), "someone edited it after the review\n").unwrap();
    assert_ne!(
        f.preview().confirm_digest(),
        reviewed,
        "a change since the review must change the digest"
    );
}

#[test]
fn links_and_hard_links_are_never_followed_rewritten_or_removed() {
    let f = fx();
    let outside = f._tmp.path().join("outside.txt");
    std::fs::write(&outside, "do not touch\n").unwrap();
    // a file Nexus edited was replaced by a symlink to a file outside the workspace
    std::fs::write(f.root.join("l.txt"), "l0\n").unwrap();
    f.edit("l.txt", b"l1\n");
    std::fs::remove_file(f.root.join("l.txt")).unwrap();
    symlink(&outside, f.root.join("l.txt")).unwrap();
    let r = f.apply();
    assert_eq!(paths(&r.conflicted), ["l.txt"], "{r:?}");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "do not touch\n");
    assert!(std::fs::symlink_metadata(f.root.join("l.txt"))
        .unwrap()
        .file_type()
        .is_symlink());

    // a created file that gained a second name
    let g = fx();
    g.edit("h.txt", b"h1\n");
    std::fs::hard_link(g.root.join("h.txt"), g.root.join("h-alias.txt")).unwrap();
    let r = g.apply();
    assert_eq!(paths(&r.conflicted), ["h.txt"], "{r:?}");
    assert_eq!(g.read("h.txt"), "h1\n");
    assert_eq!(g.read("h-alias.txt"), "h1\n");

    // a parent folder swapped for a symlink to a folder outside: not followed, nothing outside is touched
    let h = fx();
    std::fs::create_dir(h.root.join("d")).unwrap();
    std::fs::write(h.root.join("d/f.txt"), "f0\n").unwrap();
    h.edit("d/f.txt", b"f1\n");
    let elsewhere = h._tmp.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("f.txt"), "f1\n").unwrap();
    std::fs::rename(h.root.join("d"), h._tmp.path().join("d-moved")).unwrap();
    symlink(&elsewhere, h.root.join("d")).unwrap();
    let r = h.apply();
    assert_eq!(paths(&r.conflicted), ["d/f.txt"], "{r:?}");
    assert_eq!(
        std::fs::read_to_string(elsewhere.join("f.txt")).unwrap(),
        "f1\n",
        "followed a symlink out of the workspace"
    );
}

#[test]
fn only_paths_nexus_may_write_are_restorable() {
    let f = fx();
    // a hostile or damaged record naming paths that must never be written: refused, never touched
    let victim = f._tmp.path().join("victim.txt");
    std::fs::write(&victim, "safe\n").unwrap();
    std::fs::create_dir_all(f.root.join(".git")).unwrap();
    std::fs::write(f.root.join(".git/config"), "cfg\n").unwrap();
    for bad in [
        "../victim.txt",
        "/etc/passwd",
        ".git/config",
        "a/../../victim.txt",
        ".env",
        "node_modules/x.js",
    ] {
        f.store.record_pre(bad, Some(b"orig"), Some(0o644)).unwrap();
        f.store.record_post(bad, Some(&sha(b"new"))).unwrap();
    }
    let r = f.apply();
    assert!(r.restored.is_empty(), "{r:?}");
    assert_eq!(r.unrecoverable.len(), 6, "{r:?}");
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "safe\n");
    assert_eq!(
        std::fs::read_to_string(f.root.join(".git/config")).unwrap(),
        "cfg\n"
    );
}

#[test]
fn a_damaged_kept_original_is_reported_and_the_file_is_left_alone() {
    let f = fx();
    std::fs::write(f.root.join("a.txt"), "original\n").unwrap();
    f.edit("a.txt", b"edited\n");
    // damage every kept original under the store
    for e in std::fs::read_dir(f.store.dir().join("pre")).unwrap() {
        std::fs::write(e.unwrap().path(), b"corrupted").unwrap();
    }
    let r = f.apply();
    assert_eq!(paths(&r.unrecoverable), ["a.txt"], "{r:?}");
    assert_eq!(f.read("a.txt"), "edited\n");
}

#[test]
fn folders_nexus_created_are_removed_only_when_empty() {
    let f = fx();
    f.edit("src/new/a.txt", b"a\n");
    f.store
        .record_dirs(&["src".into(), "src/new".into()])
        .unwrap();
    let r = f.apply();
    assert!(!f.root.join("src").exists(), "{r:?}");
    // one holding a file of yours stays
    let g = fx();
    g.edit("src/new/a.txt", b"a\n");
    g.store
        .record_dirs(&["src".into(), "src/new".into()])
        .unwrap();
    std::fs::write(g.root.join("src/new/mine.txt"), "mine\n").unwrap();
    let r = g.apply();
    assert!(g.root.join("src/new/mine.txt").exists(), "{r:?}");
    assert!(!g.root.join("src/new/a.txt").exists());
    assert!(r.skipped.iter().any(|i| i.path == "src/new"), "{r:?}");
}

#[test]
fn nothing_is_in_the_report_but_what_a_person_can_confirm() {
    let f = fx();
    let r = f.apply();
    assert!(r.restored.is_empty() && r.conflicted.is_empty() && r.unrecoverable.is_empty());
    assert_eq!(r.outcome, "completed");
    assert!(Path::new(&f.root).is_dir());
}
