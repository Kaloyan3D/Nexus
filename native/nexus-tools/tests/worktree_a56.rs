//! A5.6 isolated Git working copies: creation, source safety, crash safety
//! and reviewable diffs. Real `git`, throwaway repositories, no network.
use nexus_tools::gitwt::{self, create, diff, inspect_source, remove, sweep_stale};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .expect("git");
    assert!(
        o.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
}

fn repo() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let r = d.path().join("src-repo");
    std::fs::create_dir_all(r.join("src")).unwrap();
    std::fs::write(
        r.join("src/lib.rs"),
        "pub fn add(a: i32, b: i32) -> i32 { a - b }\n",
    )
    .unwrap();
    std::fs::write(r.join("README.md"), "# demo\n").unwrap();
    git(&r, &["init", "-q"]);
    git(&r, &["add", "-A"]);
    git(&r, &["commit", "-qm", "init"]);
    (d, r)
}

fn roots() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("wt");
    std::fs::create_dir_all(&p).unwrap();
    (d, p)
}

/// Every file (path, mode, content hash) under `p`, including `.git`.
fn snapshot(p: &Path) -> Vec<(String, u32, String)> {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    let mut out = Vec::new();
    fn walk(base: &Path, d: &Path, out: &mut Vec<(String, u32, String)>) {
        let mut ents: Vec<_> = std::fs::read_dir(d).unwrap().flatten().collect();
        ents.sort_by_key(|e| e.file_name());
        for e in ents {
            let md = std::fs::symlink_metadata(e.path()).unwrap();
            let rel = e.path().strip_prefix(base).unwrap().display().to_string();
            if md.is_dir() {
                walk(base, &e.path(), out);
            } else if md.is_file() {
                let h = hex::encode(Sha256::digest(std::fs::read(e.path()).unwrap()));
                out.push((rel, md.permissions().mode(), h));
            } else {
                out.push((rel, 0, "link".into()));
            }
        }
    }
    walk(p, p, &mut out);
    out
}

#[test]
fn a_clean_source_yields_an_isolated_detached_checkout_and_the_source_is_untouched() {
    let (_d, src) = repo();
    let (_w, root) = roots();
    let before = snapshot(&src);
    let info = create(&src, &root, "task-aaaa1111").expect("created");
    assert_eq!(
        info.path,
        std::fs::canonicalize(&root).unwrap().join("task-aaaa1111")
    );
    assert_eq!(info.source.commit.len(), 40);
    assert_eq!(
        std::fs::read_to_string(info.path.join("src/lib.rs")).unwrap(),
        "pub fn add(a: i32, b: i32) -> i32 { a - b }\n"
    );
    // detached at exactly the recorded commit, no remote, hooks neutralized
    let head = Command::new("git")
        .current_dir(&info.path)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&head.stdout).trim(),
        info.source.commit
    );
    let remotes = Command::new("git")
        .current_dir(&info.path)
        .args(["remote"])
        .output()
        .unwrap();
    assert!(
        remotes.stdout.is_empty(),
        "the copy has no remote to fetch from or push to"
    );
    let sym = Command::new("git")
        .current_dir(&info.path)
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
        .unwrap();
    assert!(
        !sym.status.success(),
        "HEAD is detached, no branch is created or moved"
    );
    // the source repository is byte-for-byte unchanged (no .git/worktrees entry either)
    assert_eq!(before, snapshot(&src), "source must be untouched");
    assert!(!src.join(".git/worktrees").exists());
    // a modification in the copy never reaches the source
    std::fs::write(info.path.join("src/lib.rs"), "changed\n").unwrap();
    assert_eq!(before, snapshot(&src));
    // objects are copied, not hard-linked to the source
    let o = std::fs::read_dir(src.join(".git/objects"))
        .unwrap()
        .flatten()
        .find(|e| e.file_name().len() == 2)
        .unwrap();
    let f = std::fs::read_dir(o.path())
        .unwrap()
        .flatten()
        .next()
        .unwrap();
    use std::os::unix::fs::MetadataExt;
    assert_eq!(std::fs::metadata(f.path()).unwrap().nlink(), 1);
}

#[test]
fn dirty_ambiguous_and_hostile_sources_are_refused_explicitly() {
    let (_w, root) = roots();
    // dirty tracked file
    let (_d, src) = repo();
    std::fs::write(src.join("README.md"), "edited\n").unwrap();
    assert_eq!(
        create(&src, &root, "t-dirty1").unwrap_err().code,
        "dirty-source"
    );
    // untracked file
    let (_d2, src2) = repo();
    std::fs::write(src2.join("new.txt"), "x").unwrap();
    assert_eq!(inspect_source(&src2).unwrap_err().code, "dirty-source");
    // unborn HEAD
    let d3 = tempfile::tempdir().unwrap();
    git(d3.path(), &["init", "-q"]);
    assert_eq!(
        inspect_source(d3.path()).unwrap_err().code,
        "ambiguous-source"
    );
    // not a repository / missing
    assert_eq!(
        inspect_source(&PathBuf::from("/nonexistent-nexus-src"))
            .unwrap_err()
            .code,
        "ambiguous-source"
    );
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(
        inspect_source(plain.path()).unwrap_err().code,
        "ambiguous-source"
    );
    // linked worktree (.git is a file), symlinked .git, bare repo
    let (_d4, src4) = repo();
    let lw = src4.parent().unwrap().join("linked");
    git(
        &src4,
        &["worktree", "add", "-q", "--detach", lw.to_str().unwrap()],
    );
    assert_eq!(inspect_source(&lw).unwrap_err().code, "ambiguous-source");
    let (_d5, src5) = repo();
    let moved = src5.parent().unwrap().join("realgit");
    std::fs::rename(src5.join(".git"), &moved).unwrap();
    std::os::unix::fs::symlink(&moved, src5.join(".git")).unwrap();
    assert_eq!(inspect_source(&src5).unwrap_err().code, "ambiguous-source");
    let (_d6, src6) = repo();
    let bare = src6.parent().unwrap().join("bare.git");
    git(
        src6.parent().unwrap(),
        &[
            "clone",
            "-q",
            "--bare",
            src6.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
    assert!(inspect_source(&bare).is_err());
    // alternates
    let (_d7, src7) = repo();
    std::fs::write(
        src7.join(".git/objects/info/alternates"),
        "/elsewhere/objects\n",
    )
    .unwrap();
    assert_eq!(inspect_source(&src7).unwrap_err().code, "ambiguous-source");
    // submodules
    let (_d8, src8) = repo();
    std::fs::write(
        src8.join(".gitmodules"),
        "[submodule \"x\"]\n\tpath = x\n\turl = ./x\n",
    )
    .unwrap();
    git(&src8, &["add", ".gitmodules"]);
    git(&src8, &["commit", "-qm", "sub"]);
    assert_eq!(inspect_source(&src8).unwrap_err().code, "ambiguous-source");
    // nothing partial was left behind by any refusal
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
}

#[test]
fn repository_config_that_can_run_programs_is_refused_and_never_executed() {
    let (_w, root) = roots();
    let marker = tempfile::tempdir().unwrap();
    for (i, (k, v)) in [
        ("core.fsmonitor", "touch MARK"),
        ("core.hooksPath", "hooks-evil"),
        ("filter.evil.clean", "touch MARK"),
        ("diff.external", "touch MARK"),
        ("diff.evil.textconv", "touch MARK"),
        ("merge.evil.driver", "touch MARK"),
        ("credential.helper", "touch MARK"),
        ("core.sshCommand", "touch MARK"),
        ("include.path", "../evil.cfg"),
        ("url.http://x/.insteadOf", "y"),
        ("alias.status", "!touch MARK"),
    ]
    .iter()
    .enumerate()
    {
        let (_d, src) = repo();
        let m = marker.path().join(format!("mark{i}"));
        git(
            &src,
            &[
                "config",
                "--local",
                k,
                &v.replace("MARK", m.to_str().unwrap()),
            ],
        );
        let e = create(&src, &root, &format!("t-cfg{i}")).unwrap_err();
        assert_eq!(e.code, "ambiguous-source", "{k}: {e}");
        assert!(!m.exists(), "{k}: a configured program ran");
    }
    // hooks in the source's .git/hooks are never run and never copied
    let (_d, src) = repo();
    let m = marker.path().join("hook-ran");
    for h in [
        "post-checkout",
        "post-merge",
        "pre-commit",
        "reference-transaction",
    ] {
        let p = src.join(".git/hooks").join(h);
        std::fs::write(&p, format!("#!/bin/sh\ntouch {}\n", m.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let info = create(&src, &root, "t-hooks1").expect("hooks do not block creation");
    assert!(!m.exists(), "a source hook executed");
    assert!(
        !info.path.join(".git/hooks/post-checkout").exists(),
        "hooks are not copied"
    );
}

#[test]
fn creation_is_atomic_crash_safe_and_never_reuses_a_destination() {
    let (_d, src) = repo();
    let (_w, root) = roots();
    create(&src, &root, "t-once0001").unwrap();
    assert_eq!(
        create(&src, &root, "t-once0001").unwrap_err().code,
        "exists"
    );
    for bad in ["", "../x", "a/b", "a b", ".hidden", &"x".repeat(65), "t\0"] {
        assert_eq!(
            create(&src, &root, bad).unwrap_err().code,
            "bad-task-id",
            "{bad:?}"
        );
    }
    // a crash between clone and publish leaves only a .creating-* directory
    std::fs::create_dir_all(root.join(".creating-t-crash-abc/partial")).unwrap();
    assert!(!root.join("t-crash").exists());
    assert_eq!(sweep_stale(&root), 1);
    assert!(!root.join(".creating-t-crash-abc").exists());
    assert!(
        root.join("t-once0001").is_dir(),
        "published copies are never swept"
    );
    // a root overlapping the source is refused
    assert_eq!(
        create(&src, &src.join("src"), "t-ovl00001")
            .unwrap_err()
            .code,
        "bad-root"
    );
    assert_eq!(
        create(&src, src.parent().unwrap(), "t-ovl00002")
            .unwrap_err()
            .code,
        "bad-root"
    );
    // explicit operator removal
    remove(&root, "t-once0001").unwrap();
    assert!(!root.join("t-once0001").exists());
    assert_eq!(remove(&root, "../x").unwrap_err().code, "bad-task-id");
    assert_eq!(remove(&root, "t-gone0001").unwrap_err().code, "not-found");
}

#[test]
fn the_diff_lists_added_modified_deleted_and_renamed_files_and_commits_nothing() {
    let (_d, src) = repo();
    let (_w, root) = roots();
    let info = create(&src, &root, "t-diff0001").unwrap();
    let wt = &info.path;
    let clean = diff(wt, &info.source.commit).unwrap();
    assert!(clean.files.is_empty() && clean.diff.is_empty());
    std::fs::write(
        wt.join("src/lib.rs"),
        "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
    )
    .unwrap();
    std::fs::write(wt.join("src/new.rs"), "pub fn f() {}\n").unwrap();
    std::fs::remove_file(wt.join("README.md")).unwrap();
    let r = diff(wt, &info.source.commit).unwrap();
    let by: std::collections::BTreeMap<_, _> = r
        .files
        .iter()
        .map(|f| (f.path.clone(), f.status.clone()))
        .collect();
    assert_eq!(by["src/lib.rs"], "modified");
    assert_eq!(by["src/new.rs"], "added");
    assert_eq!(by["README.md"], "deleted");
    let lib = r.files.iter().find(|f| f.path == "src/lib.rs").unwrap();
    assert_eq!((lib.additions, lib.deletions), (Some(1), Some(1)));
    assert!(r
        .diff
        .contains("-pub fn add(a: i32, b: i32) -> i32 { a - b }"));
    assert!(r
        .diff
        .contains("+pub fn add(a: i32, b: i32) -> i32 { a + b }"));
    assert_eq!(r.diff_digest.len(), 64);
    // deterministic and repeatable
    assert_eq!(
        diff(wt, &info.source.commit).unwrap().diff_digest,
        r.diff_digest
    );
    // nothing was committed: HEAD is still the base commit, the source is untouched
    let head = Command::new("git")
        .current_dir(wt)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&head.stdout).trim(),
        info.source.commit
    );
    let before = snapshot(&src);
    let _ = diff(wt, &info.source.commit).unwrap();
    assert_eq!(before, snapshot(&src));
    // a big diff is bounded and flagged
    std::fs::write(wt.join("src/big.rs"), "x\n".repeat(400_000)).unwrap();
    let big = diff(wt, &info.source.commit).unwrap();
    assert!(big.diff_truncated && big.diff.len() <= gitwt::MAX_DIFF_BYTES);
    assert!(diff(wt, "not-a-commit").is_err());
    assert!(diff(Path::new("/tmp"), &info.source.commit).is_err());
}

/// Audit of the clone-based isolation (A5.6 security closure): a hostile but
/// accepted source still yields a copy that shares nothing writable with it.
#[test]
fn clone_isolation_audit_no_shared_inodes_alternates_remotes_hooks_or_source_writes() {
    use std::collections::HashSet;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let (_w, root) = roots();
    let (_d, src) = repo();
    // A source hook (must never be copied or run), a committed symlink out of
    // the tree, an executable file, an ignored FIFO and an ignored secret.
    let hook = src.join(".git/hooks/post-checkout");
    std::fs::write(
        &hook,
        format!("#!/bin/sh\ntouch {}/HOOK-RAN\n", src.display()),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink("/etc", src.join("etc_link")).unwrap();
    std::fs::write(src.join("run.sh"), "#!/bin/sh\necho hi\n").unwrap();
    std::fs::set_permissions(src.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(src.join(".gitignore"), "target/\n.env\nfifo\n").unwrap();
    std::fs::write(src.join(".env"), "SECRET=abc\n").unwrap();
    let _ = Command::new("mkfifo").arg(src.join("fifo")).status();
    git(&src, &["add", "-A"]);
    git(&src, &["commit", "-qm", "more"]);
    let before = snapshot(&src);

    let info = create(&src, &root, "t-audit1").unwrap();
    let cp = &info.path;
    // 1. the source (working tree AND .git) is byte-identical, and no hook ran
    assert_eq!(snapshot(&src), before);
    assert!(!src.join("HOOK-RAN").exists() && !cp.join("HOOK-RAN").exists());
    // 2. no shared inodes (hardlinked objects would let a write reach the source)
    let inodes = |p: &Path| -> HashSet<(u64, u64)> {
        let mut s = HashSet::new();
        fn walk(d: &Path, s: &mut HashSet<(u64, u64)>) {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let md = std::fs::symlink_metadata(e.path()).unwrap();
                if md.is_dir() {
                    walk(&e.path(), s);
                } else if md.is_file() {
                    assert_eq!(md.nlink(), 1, "{:?} is hardlinked", e.path());
                    s.insert((md.dev(), md.ino()));
                }
            }
        }
        walk(p, &mut s);
        s
    };
    assert!(
        inodes(cp).is_disjoint(&inodes(&src)),
        "copy shares inodes with the source"
    );
    // 3. no alternates, no remote, no hooks, no includes, hardened local config
    assert!(!cp.join(".git/objects/info/alternates").exists());
    let cfg = std::fs::read_to_string(cp.join(".git/config")).unwrap();
    assert!(!cfg.contains("[remote") && !cfg.contains("url ="), "{cfg}");
    assert!(
        !cfg.contains("[include") && cfg.contains("hooksPath = /dev/null"),
        "{cfg}"
    );
    let hooks: Vec<_> = std::fs::read_dir(cp.join(".git/hooks"))
        .map(|d| d.flatten().collect())
        .unwrap_or_default();
    assert!(
        hooks.is_empty(),
        "hooks copied into the working copy: {hooks:?}"
    );
    // 4. content fidelity: symlink kept as a link (not followed), mode kept,
    //    ignored files (secret, FIFO) NOT copied
    assert!(std::fs::symlink_metadata(cp.join("etc_link"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::metadata(cp.join("run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0o111
    );
    assert!(!cp.join(".env").exists() && !cp.join("fifo").exists());
    // 5. ownership and permissions: ours, not group/world writable
    let me = unsafe { libc::geteuid() };
    for p in [cp.clone(), cp.join(".git"), cp.join("src/lib.rs")] {
        let md = std::fs::symlink_metadata(&p).unwrap();
        assert_eq!(md.uid(), me, "{p:?}");
        assert_eq!(
            md.permissions().mode() & 0o022,
            0,
            "{p:?} is group/world writable"
        );
    }
    // 6. the copy has no path back to the source (cannot push/fetch)
    let o = Command::new("git")
        .current_dir(cp)
        .args(["remote"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&o.stdout).trim().is_empty());
    // 7. editing inside the copy (as an approved write would) leaves the source alone
    std::fs::write(cp.join("src/lib.rs"), "changed\n").unwrap();
    let rep = diff(cp, &info.source.commit).unwrap();
    assert_eq!(rep.files.len(), 1);
    assert_eq!(
        snapshot(&src),
        before,
        "source changed after copy edit + diff"
    );
    // 8. cleanup is scoped: traversal ids are refused, removal touches only that copy
    assert!(remove(&root, "../src-repo").is_err() && remove(&root, "..").is_err());
    assert_eq!(snapshot(&src), before);
    remove(&root, "t-audit1").unwrap();
    assert!(!cp.exists());
    assert_eq!(snapshot(&src), before, "source changed after removal");
    // 9. a refused (dirty) source and a stale half-built copy leave the source untouched too
    std::fs::write(src.join("README.md"), "edited\n").unwrap();
    let dirty = snapshot(&src);
    assert!(create(&src, &root, "t-audit2").is_err());
    std::fs::create_dir_all(root.join(".creating-t-audit3-aa")).unwrap();
    assert_eq!(sweep_stale(&root), 1);
    assert_eq!(snapshot(&src), dirty);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
}
