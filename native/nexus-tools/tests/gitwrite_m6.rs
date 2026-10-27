//! M6B: user-authorized Git writes. Real bubblewrap + Landlock + the launch gate over a real
//! on-disk Git repository (prints `NOT RUN` when the host lacks them; the release battery runs
//! with `NEXUS_REQUIRE_SANDBOX=1`).
//!
//! Contract: without the grant `.git` is read-only; with `git_write` commands may commit/branch
//! inside the workspace, while `.git/hooks` and `.git/config` stay read-only and external Git
//! metadata (linked worktrees) is never made writable.

use nexus_tools::confine::{self};
use nexus_tools::confine_host;
use nexus_tools::inplace::{self, PrepareOptions};
use nexus_tools::result::ToolError;
use nexus_tools::sandbox::{
    cgroup_base, run_sandboxed, ConfineSpec, SandboxControl, SandboxLimits, SandboxOutcome,
    SandboxSpec, StopReason,
};
use nexus_tools::workspace::{Workspace, WorkspacePolicy};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQ: AtomicU32 = AtomicU32::new(0);

fn ready(t: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available
        || c.landlock_abi.is_none()
        || !c.launch_gate
        || !Path::new("/usr/bin/git").exists()
    {
        println!(
            "NOT RUN ({t}): sandbox/Landlock/launch gate/git unavailable: {:?} abi={:?} gate={}",
            c.problems, c.landlock_abi, c.launch_gate
        );
        return false;
    }
    true
}

struct W {
    _t: tempfile::TempDir,
    root: PathBuf,
    ws: Workspace,
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    std::process::Command::new("/usr/bin/git")
        .args([
            "-c",
            "user.email=m6@example.invalid",
            "-c",
            "user.name=m6",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let o = std::process::Command::new("/usr/bin/git")
        .args([
            "-c",
            "user.email=m6@example.invalid",
            "-c",
            "user.name=m6",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

/// A real repository with one commit, plus an uncommitted new file.
fn repo() -> W {
    let t = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(t.path()).unwrap().join("proj");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    assert!(git_ok(&root, &["init", "-q"]));
    assert!(git_ok(&root, &["add", "-A"]));
    assert!(git_ok(&root, &["commit", "-q", "-m", "first"]));
    std::fs::write(root.join("b.txt"), "two\n").unwrap();
    let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    W { _t: t, root, ws }
}

struct Never;
impl SandboxControl for Never {
    fn should_stop(&mut self) -> Option<StopReason> {
        None
    }
    fn on_spawned(&mut self, _: u32, _: &str) -> Result<(), ToolError> {
        Ok(())
    }
}

fn launch_with(w: &W, opts: &PrepareOptions, script: &str) -> Result<SandboxOutcome, ToolError> {
    let mount = inplace::prepare_with(&w.ws, opts)?;
    let mut env = BTreeMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), "/work/out".to_owned());
    env.insert("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned());
    env.insert("GIT_AUTHOR_NAME".to_owned(), "m6".to_owned());
    env.insert(
        "GIT_AUTHOR_EMAIL".to_owned(),
        "m6@example.invalid".to_owned(),
    );
    env.insert("GIT_COMMITTER_NAME".to_owned(), "m6".to_owned());
    env.insert(
        "GIT_COMMITTER_EMAIL".to_owned(),
        "m6@example.invalid".to_owned(),
    );
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let shim = confine_host::locate_shim().expect("launch gate");
    let sha = confine_host::shim_is_trustworthy(&shim).unwrap();
    let r = nexus_tools::observe::root_identity(&w.ws).unwrap();
    let spec = SandboxSpec {
        id: format!("m6b{}x{seq}", std::process::id()),
        program: "/usr/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        src_dir: PathBuf::new(),
        cwd: "/work/src".into(),
        env,
        ro_binds: vec![],
        rw_binds: vec![],
        src_writable: true,
        pinned_root: Some(mount.root_fd()),
        protect: mount.protect(),
        fd_ro_binds: mount.fd_ro_binds(),
        egress: None,
        net: false,
        limits: SandboxLimits {
            wall_ms: 60_000,
            cpu_secs: 60,
            ..Default::default()
        },
        cgroup_base: cgroup_base().unwrap(),
        confine: Some(ConfineSpec {
            shim,
            shim_sha256: sha,
            root: (r.dev, r.ino),
            min_abi: confine::MIN_ABI,
            require_scope: false,
        }),
    };
    run_sandboxed(&spec, &mut Never)
}

fn text(o: &SandboxOutcome) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn gw_opts() -> PrepareOptions {
    PrepareOptions {
        git_write: true,
        ..Default::default()
    }
}

#[test]
fn without_the_grant_git_reads_but_cannot_write() {
    if !ready("ro") {
        return;
    }
    let w = repo();
    let o = launch_with(
        &w,
        &PrepareOptions::default(),
        "git status --porcelain; echo ---; git add b.txt; echo add-rc=$?; git log --oneline | head -2",
    )
    .expect("launch");
    let t = text(&o);
    assert!(t.contains("?? b.txt"), "{t}");
    assert!(!t.contains("add-rc=0"), "{t}");
    assert!(git_out(&w.root, &["status", "--porcelain"]).contains("?? b.txt"));
    assert_eq!(git_out(&w.root, &["log", "--oneline"]).lines().count(), 1);
}

#[test]
fn with_the_grant_git_commits_and_branches_but_hooks_and_config_stay_read_only() {
    if !ready("rw") {
        return;
    }
    let w = repo();
    let m = inplace::prepare_with(&w.ws, &gw_opts()).unwrap();
    let ro = m.summary["readOnly"].to_string();
    assert!(ro.contains(".git/config"), "{ro}");
    assert!(ro.contains(".git/hooks"), "{ro}");
    assert_eq!(m.summary["gitWrite"], true);
    let o = launch_with(
        &w,
        &gw_opts(),
        r#"set -x
git add b.txt && git commit -q -m second; echo commit-rc=$?
git branch feature-x; echo branch-rc=$?
echo tamper >> .git/config; echo config-rc=$?
echo tamper > .git/hooks/evil; echo hook-rc=$?
git config user.name planted; echo gitconfig-rc=$?
echo data > .git/planted; echo planted-rc=$?"#,
    )
    .expect("launch");
    let t = text(&o);
    for want in ["commit-rc=0", "branch-rc=0", "planted-rc=0"] {
        assert!(t.contains(want), "{want}: {t}");
    }
    for banned in ["config-rc=0", "hook-rc=0", "gitconfig-rc=0"] {
        assert!(!t.contains(banned), "{banned} must fail: {t}");
    }
    // the host sees a consistent repository with the new commit and branch
    let log = git_out(&w.root, &["log", "--oneline"]);
    assert_eq!(log.lines().count(), 2, "{log}");
    assert!(git_out(&w.root, &["branch", "--list", "feature-x"]).contains("feature-x"));
    assert!(git_ok(&w.root, &["fsck", "--strict"]));
    // config was not planted
    assert!(!git_out(&w.root, &["config", "user.name"]).contains("planted"));
}

#[test]
fn git_write_does_not_follow_pointers_or_environment_out_of_the_workspace() {
    if !ready("ptr") {
        return;
    }
    let w = repo();
    // a linked worktree of this repository: its `.git` is a FILE naming an external git dir
    let wt = w.root.parent().unwrap().join("linked");
    assert!(git_ok(
        &w.root,
        &["worktree", "add", "-q", wt.to_str().unwrap()]
    ));
    let ws2 = Workspace::open_root(wt.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let w2 = W {
        _t: tempfile::TempDir::new().unwrap(),
        root: wt.clone(),
        ws: ws2,
    };
    let _ = &w; // keep the main repo (and its .git/worktrees/*) alive
    let o = launch_with(
        &w2,
        &gw_opts(),
        "echo hi > new.txt; git add new.txt; echo add-rc=$?; git status --porcelain; echo status-rc=$?",
    )
    .expect("launch");
    let t = text(&o);
    // external metadata is unsupported for writing: the add must not succeed through the pointer,
    // and nothing in the main repository's git dir may change
    assert!(!t.contains("add-rc=0"), "{t}");
    assert!(!git_out(&w.root, &["status", "--porcelain"]).contains("new.txt"));
    // alternate git directories named by the environment stay outside the sandbox entirely
    let o = launch_with(
        &w,
        &gw_opts(),
        "GIT_DIR=/tmp/elsewhere git init -q /tmp/elsewhere 2>&1; echo rc=$?; ls /tmp/elsewhere 2>&1",
    )
    .expect("launch");
    let t = text(&o);
    assert!(!Path::new("/tmp/elsewhere").exists(), "{t}");
}

/// A1 characterization: `.git` does not exist before the command. What can ONE command do?
#[test]
fn a1_a_repo_created_by_the_command_itself_is_not_mount_protected_in_that_command() {
    if !ready("a1") {
        return;
    }
    // without gitWrite
    let t = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(t.path()).unwrap().join("proj");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let w = W { _t: t, root, ws };
    let script = "export GIT_AUTHOR_NAME=m6 GIT_AUTHOR_EMAIL=m6@example.invalid GIT_COMMITTER_NAME=m6 GIT_COMMITTER_EMAIL=m6@example.invalid; \
git init -q; echo init-rc=$?; \
printf '[core]\\n\\trepositoryformatversion = 0\\n[user]\\n\\tname = planted\\n' > .git/config; echo config-rc=$?; \
printf '#!/bin/sh\\necho hook-ran >> hook-marker.txt\\n' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit; echo hook-rc=$?; \
git add a.txt; git commit -q -m first; echo commit-rc=$?; ls hook-marker.txt 2>/dev/null; echo marker-rc=$?";
    let o = launch_with(&w, &PrepareOptions::default(), script).expect("launch");
    let txt = text(&o);
    // PINNED LIMITATION (A1): mounts are prepared from what exists before the command, so the
    // creating command itself is not protected. This assertion documents current reality; the
    // consent text states it and the execution result flags `gitMetadataCreated`.
    for want in [
        "init-rc=0",
        "config-rc=0",
        "hook-rc=0",
        "commit-rc=0",
        "marker-rc=0",
    ] {
        assert!(txt.contains(want), "creation window ({want}): {txt}");
    }
    // from the NEXT command on, the existing protection applies in full
    std::fs::write(w.root.join("c.txt"), "three\n").unwrap();
    let o = launch_with(
        &w,
        &PrepareOptions::default(),
        "echo x >> .git/config; echo cfg-rc=$?; git add c.txt; echo add-rc=$?",
    )
    .expect("launch");
    let txt = text(&o);
    assert!(!txt.contains("cfg-rc=0"), "{txt}");
    assert!(!txt.contains("add-rc=0"), "{txt}");
    // with gitWrite on a fresh project: hooks/config created in the same first command
    let t2 = tempfile::tempdir().unwrap();
    let root2 = std::fs::canonicalize(t2.path()).unwrap().join("proj");
    std::fs::create_dir_all(&root2).unwrap();
    std::fs::write(root2.join("a.txt"), "one\n").unwrap();
    let ws2 = Workspace::open_root(root2.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let w2 = W {
        _t: t2,
        root: root2,
        ws: ws2,
    };
    let o = launch_with(&w2, &gw_opts(), script).expect("launch");
    let txt2 = text(&o);
    // same creation window under the grant (hooks/config of a just-created repo)
    assert!(txt2.contains("commit-rc=0"), "{txt2}");
    // next command: commits work, hooks/config stay protected
    std::fs::write(w2.root.join("c.txt"), "three\n").unwrap();
    let o = launch_with(
        &w2,
        &gw_opts(),
        "export GIT_AUTHOR_NAME=m6 GIT_AUTHOR_EMAIL=m6@example.invalid GIT_COMMITTER_NAME=m6 GIT_COMMITTER_EMAIL=m6@example.invalid; git add c.txt && git commit -q -m second; echo commit2-rc=$?; echo x > .git/hooks/evil2; echo hook2-rc=$?; echo x >> .git/config; echo cfg2-rc=$?",
    )
    .expect("launch");
    let txt2 = text(&o);
    assert!(txt2.contains("commit2-rc=0"), "{txt2}");
    assert!(!txt2.contains("hook2-rc=0"), "{txt2}");
    assert!(!txt2.contains("cfg2-rc=0"), "{txt2}");
}
