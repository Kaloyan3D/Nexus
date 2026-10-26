//! M3C: Landlock launch gate, recursive protected entries, pinned-root and mount verification, hard-link
//! policy and Git metadata. Real bubblewrap + Landlock + seccomp on disposable folders (prints `NOT RUN` when
//! the host lacks them; the release battery runs with `NEXUS_REQUIRE_SANDBOX=1`).

use nexus_tools::confine::{self, Plan};
use nexus_tools::confine_host;
use nexus_tools::inplace::{self, HardLinks, PrepareOptions};
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
        || !Path::new("/usr/bin/python3").exists()
    {
        println!(
            "NOT RUN ({t}): sandbox/Landlock/launch gate unavailable: {:?} abi={:?} gate={}",
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

fn world(files: &[(&str, &str)]) -> W {
    let t = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(t.path()).unwrap().join("proj");
    std::fs::create_dir_all(&root).unwrap();
    for (p, c) in files {
        let f = root.join(p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, c).unwrap();
    }
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

fn confine_spec(w: &W, net: bool) -> ConfineSpec {
    let shim = confine_host::locate_shim().expect("launch gate");
    let sha = confine_host::shim_is_trustworthy(&shim).unwrap();
    let r = nexus_tools::observe::root_identity(&w.ws).unwrap();
    ConfineSpec {
        shim,
        shim_sha256: sha,
        root: (r.dev, r.ino),
        min_abi: confine::MIN_ABI,
        require_scope: net,
    }
}

fn launch_with(
    w: &W,
    opts: &PrepareOptions,
    net: bool,
    script: &str,
    tweak: impl FnOnce(&mut SandboxSpec),
) -> Result<SandboxOutcome, ToolError> {
    let mount = inplace::prepare_with(&w.ws, opts)?;
    let mut env = BTreeMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), "/work/out".to_owned());
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let mut spec = SandboxSpec {
        id: format!("m3c{}x{seq}", std::process::id()),
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
        net,
        limits: SandboxLimits {
            wall_ms: 60_000,
            cpu_secs: 60,
            ..Default::default()
        },
        cgroup_base: cgroup_base().unwrap(),
        confine: Some(confine_spec(w, net)),
    };
    tweak(&mut spec);
    run_sandboxed(&spec, &mut Never)
}

fn launch(w: &W, script: &str) -> Result<SandboxOutcome, ToolError> {
    launch_with(w, &PrepareOptions::default(), false, script, |_| {})
}

fn text(o: &SandboxOutcome) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn mkfifo(p: &Path) {
    let c = std::ffi::CString::new(p.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
}

fn tree(root: &Path) -> Vec<String> {
    let mut out = vec![];
    let mut st = vec![root.to_path_buf()];
    while let Some(d) = st.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            out.push(p.strip_prefix(root).unwrap().to_string_lossy().into_owned());
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                st.push(p);
            }
        }
    }
    out.sort();
    out
}

// ------------------------------------------------------------------------------ M3C.1 Landlock

#[test]
fn the_launch_gate_applies_landlock_before_the_command_and_leaves_normal_work_alone() {
    if !ready("gate") {
        return;
    }
    let w = world(&[("src/a.txt", "a\n")]);
    let o = launch(
        &w,
        "grep NoNewPrivs /proc/self/status; ls /work 2>&1 | head -1; ls /work/src; mkdir -p d/e && echo ok > d/e/f.txt && cat d/e/f.txt; \
         echo x > /work/out/o.txt && cat /work/out/o.txt; echo t > /tmp/t && cat /tmp/t; ls / >/dev/null 2>&1; echo rc-ls-root=$?; echo gate-done",
    )
    .expect("run");
    let t = text(&o);
    assert!(t.contains("NoNewPrivs:\t1"), "{t}");
    // /work itself is not granted: Landlock (not only the mount layout) refuses to list it
    assert!(
        t.contains("Permission denied") || t.contains("cannot open"),
        "Landlock is not in effect: {t}"
    );
    assert!(t.contains("ok\n") && t.contains("gate-done"), "{t}");
    assert!(
        t.contains("rc-ls-root=2"),
        "listing / should be denied: {t}"
    );
    assert_eq!(
        std::fs::read_to_string(w.root.join("d/e/f.txt")).unwrap(),
        "ok\n"
    );
}

#[test]
fn landlock_scopes_abstract_unix_sockets_when_the_command_shares_the_host_network() {
    if !ready("scope") {
        return;
    }
    if confine::landlock_abi().unwrap_or(0) < confine::SCOPE_ABI {
        println!("NOT RUN (scope): Landlock ABI below {}", confine::SCOPE_ABI);
        return;
    }
    use std::os::linux::net::SocketAddrExt;
    let addr = std::os::unix::net::SocketAddr::from_abstract_name(format!(
        "nexus-m3c-{}",
        std::process::id()
    ))
    .unwrap();
    let l = std::os::unix::net::UnixListener::bind_addr(&addr).unwrap();
    let name = format!("nexus-m3c-{}", std::process::id());
    let probe = format!(
        "python3 -c \"import socket;s=socket.socket(socket.AF_UNIX);\ntry:\n s.connect('\\0{name}');print('CONNECTED')\nexcept Exception as e:\n print('BLOCKED',type(e).__name__)\"",
    );
    let w = world(&[("a.txt", "a\n")]);
    // negative control: the same command in the same shared network namespace WITHOUT the gate reaches it
    let ctl = launch_with(&w, &PrepareOptions::default(), true, &probe, |s| {
        s.confine = None
    })
    .expect("control");
    assert!(
        text(&ctl).contains("CONNECTED"),
        "the control did not reach the host socket: {}",
        text(&ctl)
    );
    let o = launch_with(&w, &PrepareOptions::default(), true, &probe, |_| {}).expect("gated");
    assert!(
        text(&o).contains("BLOCKED"),
        "an abstract socket outside the domain was reachable: {}",
        text(&o)
    );
    drop(l);
}

#[test]
fn confinement_that_cannot_be_provided_refuses_the_command_and_never_downgrades() {
    if !ready("failclosed") {
        return;
    }
    let w = world(&[("a.txt", "a\n")]);
    let marker = "echo ran > ran.txt";
    // (1) a required Landlock ABI the kernel cannot give
    let e = launch_with(&w, &PrepareOptions::default(), false, marker, |s| {
        s.confine.as_mut().unwrap().min_abi = 99
    })
    .unwrap_err();
    assert!(
        e.message.contains("confinement refused") && e.message.contains("ABI"),
        "{}",
        e.message
    );
    // (2) a launch gate that is not the recorded one
    let e = launch_with(&w, &PrepareOptions::default(), false, marker, |s| {
        s.confine.as_mut().unwrap().shim_sha256 = "00".repeat(32)
    })
    .unwrap_err();
    assert!(e.message.contains("launch gate"), "{}", e.message);
    // (3) a launch gate that does not exist
    let e = launch_with(&w, &PrepareOptions::default(), false, marker, |s| {
        s.confine.as_mut().unwrap().shim = PathBuf::from("/nonexistent/nexus-confine")
    })
    .unwrap_err();
    assert!(e.message.contains("launch gate"), "{}", e.message);
    // (4) the workspace mounted is not the verified object
    let e = launch_with(&w, &PrepareOptions::default(), false, marker, |s| {
        s.confine.as_mut().unwrap().root.1 += 1
    })
    .unwrap_err();
    assert!(e.message.contains("verified object"), "{}", e.message);
    assert!(
        !w.root.join("ran.txt").exists(),
        "the command ran although confinement was refused"
    );
}

#[test]
fn the_launch_gate_closes_the_door_on_inherited_descriptors() {
    // The gate runs outside any sandbox here with a descriptor leaked into it: it must refuse first.
    let shim = confine_host::locate_shim().expect("gate");
    let leak = std::fs::File::open("/etc/hostname")
        .or_else(|_| std::fs::File::open("/etc/passwd"))
        .unwrap();
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let fd = leak.as_raw_fd();
    let mut c = std::process::Command::new(shim);
    c.args(["--min-abi", "3", "--", "/usr/bin/true"]);
    unsafe {
        c.pre_exec(move || {
            // keep it open across exec at a fixed slot
            let flags = libc::fcntl(fd, libc::F_GETFD);
            libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC);
            Ok(())
        });
    }
    let out = c.output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(confine::REFUSED_EXIT),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains("unexpected inherited descriptors"));
}

#[test]
fn plan_arguments_round_trip_and_unknown_arguments_are_refused() {
    let p = Plan {
        ro: vec!["/usr".into()],
        rw: vec!["/work/src".into()],
        dev: vec!["/dev".into()],
        min_abi: 3,
        require_scope: true,
        root: Some((7, 9)),
        expect: vec![
            confine::Expect::HiddenFile("a/.env".into()),
            confine::Expect::HiddenDir("b".into()),
            confine::Expect::ReadOnly("c/d".into(), 42),
        ],
    };
    let mut a = p.to_args();
    a.push("/usr/bin/true".into());
    let (q, cmd) = Plan::parse(&a).unwrap();
    assert_eq!(p, q);
    assert_eq!(cmd, vec!["/usr/bin/true"]);
    assert!(Plan::parse(&["--bogus".to_owned(), "--".to_owned(), "x".to_owned()]).is_err());
    assert!(Plan::parse(&["--min-abi".to_owned(), "3".to_owned()]).is_err());
}

// ------------------------------------------------------------------------------ M3C.2 protected entries

fn nested_world() -> W {
    let w = world(&[
        ("src/main.rs", "fn main(){}\n"),
        (".env", "TOP=1\n"),
        ("pkg/service/.env.local", "SECRET_NESTED=hunter2\n"),
        (
            "pkg/keys/id_rsa",
            "-----BEGIN PRIVATE KEY-----\nNESTEDKEY\n",
        ),
        ("deep/a/b/.npmrc", "//registry:_authToken=NESTEDTOKEN\n"),
        ("deep/ordinary.txt", "ordinary\n"),
        ("conf/.ssh/id_ed25519", "SSHKEY\n"),
    ]);
    std::os::unix::net::UnixListener::bind(w.root.join("deep/a/run.sock"))
        .map(std::mem::forget)
        .unwrap();
    mkfifo(&w.root.join("deep/pipe"));
    w
}

#[test]
fn nested_secrets_sockets_and_fifos_are_masked_at_every_depth_and_nothing_is_created() {
    if !ready("nested") {
        return;
    }
    let w = nested_world();
    let before = tree(&w.root);
    let o = launch(
        &w,
        r#"for f in .env pkg/service/.env.local pkg/keys/id_rsa deep/a/b/.npmrc conf/.ssh/id_ed25519; do
  printf '%s: ' "$f"; cat "$f" 2>&1 | head -c 80; echo "[rc=$?]"; done
python3 - <<'PY'
import socket, os, stat
s = socket.socket(socket.AF_UNIX)
try:
    s.connect("deep/a/run.sock"); print("SOCKET-CONNECTED")
except Exception as e:
    print("socket-blocked", type(e).__name__)
print("fifo-mode", oct(stat.S_IFMT(os.lstat("deep/pipe").st_mode)))
print("ordinary", open("deep/ordinary.txt").read().strip())
PY
echo changed > deep/ordinary.txt; echo write-ordinary-rc=$?"#,
    )
    .expect("run");
    let t = text(&o);
    for secret in ["hunter2", "NESTEDKEY", "NESTEDTOKEN", "SSHKEY", "TOP=1"] {
        assert!(!t.contains(secret), "{secret} was readable: {t}");
    }
    assert!(!t.contains("SOCKET-CONNECTED"), "{t}");
    assert!(t.contains("socket-blocked"), "{t}");
    assert!(
        t.contains("ordinary ordinary") && t.contains("write-ordinary-rc=0"),
        "{t}"
    );
    assert_eq!(
        std::fs::read_to_string(w.root.join("deep/ordinary.txt")).unwrap(),
        "changed\n"
    );
    // the host files are untouched and masking created nothing in the project
    assert_eq!(
        std::fs::read_to_string(w.root.join("pkg/service/.env.local")).unwrap(),
        "SECRET_NESTED=hunter2\n"
    );
    assert_eq!(
        tree(&w.root),
        before,
        "the run changed the set of entries in the project"
    );
    // a SECOND command in the same workspace is masked just the same (the listing must not depend on a
    // read offset shared with an earlier scan)
    let again = launch(
        &w,
        "cat pkg/service/.env.local deep/a/b/.npmrc 2>&1; echo rc=$?",
    )
    .expect("second run");
    assert!(
        !text(&again).contains("hunter2") && !text(&again).contains("NESTEDTOKEN"),
        "{}",
        text(&again)
    );
    // the audit says what was masked
    let m = inplace::prepare(&w.ws).unwrap();
    let hidden = m.summary["hidden"].to_string();
    for p in [
        "pkg/service/.env.local",
        "pkg/keys/id_rsa",
        "deep/a/b/.npmrc",
        "deep/a/run.sock",
        "deep/pipe",
        ".env",
    ] {
        assert!(hidden.contains(p), "{p} not masked: {hidden}");
    }
    assert_eq!(m.summary["hiddenScan"], "recursive");
}

#[test]
fn a_secret_stored_under_an_ordinary_name_is_not_detected_and_the_guarantee_says_so() {
    // The classifier is filename-based. This test pins the documented limit instead of hiding it.
    if !ready("ordinary-name") {
        return;
    }
    let w = world(&[("notes/todo.txt", "password=OrdinaryNameSecret\n")]);
    let o = launch(&w, "cat notes/todo.txt").expect("run");
    assert!(text(&o).contains("OrdinaryNameSecret"), "{}", text(&o));
}

#[test]
fn a_directory_swapped_for_a_link_after_the_scan_is_caught_before_the_command_runs() {
    if !ready("swap") {
        return;
    }
    let w = world(&[("keep/x.txt", "x\n"), ("vault/.env", "VAULTSECRET\n")]);
    // scan + mount plan, then (race) replace the directory with a symlink, then launch
    let mount = inplace::prepare(&w.ws).unwrap();
    std::fs::rename(w.root.join("vault"), w.root.join("vault_real")).unwrap();
    std::os::unix::fs::symlink("vault_real", w.root.join("vault")).unwrap();
    let mut env = BTreeMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    let spec = SandboxSpec {
        id: format!(
            "m3c{}race{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ),
        program: "/usr/bin/sh".into(),
        args: vec!["-c".into(), "echo ran > ran.txt; cat vault/.env".into()],
        src_dir: PathBuf::new(),
        cwd: "/work/src".into(),
        env,
        ro_binds: vec![],
        rw_binds: vec![],
        src_writable: true,
        pinned_root: Some(mount.root_fd()),
        protect: mount.protect(),
        fd_ro_binds: mount.fd_ro_binds(),
        net: false,
        limits: SandboxLimits {
            wall_ms: 30_000,
            ..Default::default()
        },
        cgroup_base: cgroup_base().unwrap(),
        confine: Some(confine_spec(&w, false)),
    };
    let r = run_sandboxed(&spec, &mut Never);
    match r {
        Err(e) => assert!(
            e.message.contains("confinement refused") || e.message.contains("spawn"),
            "{}",
            e.message
        ),
        Ok(o) => assert!(
            !text(&o).contains("VAULTSECRET"),
            "the swapped path exposed a secret: {}",
            text(&o)
        ),
    }
    assert!(
        !w.root.join("ran.txt").exists(),
        "the command ran after the mount plan was invalidated"
    );
}

#[test]
fn an_entry_that_disappears_between_the_scan_and_the_launch_never_exposes_anything() {
    if !ready("vanish") {
        return;
    }
    let w = world(&[("a/.env", "GONE\n"), ("a/ok.txt", "ok\n")]);
    let mount = inplace::prepare(&w.ws).unwrap();
    std::fs::remove_file(w.root.join("a/.env")).unwrap();
    let mut env = BTreeMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    let spec = SandboxSpec {
        id: format!(
            "m3c{}vanish{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ),
        program: "/usr/bin/sh".into(),
        args: vec!["-c".into(), "cat a/ok.txt".into()],
        src_dir: PathBuf::new(),
        cwd: "/work/src".into(),
        env,
        ro_binds: vec![],
        rw_binds: vec![],
        src_writable: true,
        pinned_root: Some(mount.root_fd()),
        protect: mount.protect(),
        fd_ro_binds: mount.fd_ro_binds(),
        net: false,
        limits: SandboxLimits {
            wall_ms: 30_000,
            ..Default::default()
        },
        cgroup_base: cgroup_base().unwrap(),
        confine: Some(confine_spec(&w, false)),
    };
    // either bubblewrap refuses the mask of a missing path or it creates an empty placeholder; in neither case
    // is anything exposed. The M3A observation reports a created placeholder like any other new file.
    let r = run_sandboxed(&spec, &mut Never);
    if let Ok(o) = &r {
        assert!(!text(o).contains("GONE"));
    }
    let placeholder = w.root.join("a/.env");
    if placeholder.exists() {
        assert_eq!(
            std::fs::read(&placeholder).unwrap().len(),
            0,
            "a placeholder must be empty"
        );
    }
}

// ------------------------------------------------------------------------------ M3C.3 mount safety

#[test]
fn an_unexpected_mount_below_the_workspace_is_refused_by_the_gate() {
    if !ready("extra-mount") {
        return;
    }
    let w = world(&[("a.txt", "a\n")]);
    let extra = tempfile::tempdir().unwrap();
    std::fs::write(extra.path().join("host-file.txt"), "HOSTONLY\n").unwrap();
    let e = launch_with(
        &w,
        &PrepareOptions::default(),
        false,
        "cat extra/host-file.txt; echo ran > ran.txt",
        |s| {
            s.rw_binds
                .push((extra.path().to_path_buf(), "/work/src/extra".to_owned()));
        },
    )
    .unwrap_err();
    assert!(e.message.contains("unexpected mount"), "{}", e.message);
    assert!(!w.root.join("ran.txt").exists());
}

#[test]
fn the_mounted_workspace_is_the_pinned_object_even_after_the_path_is_replaced() {
    if !ready("pinned") {
        return;
    }
    let w = world(&[("marker.txt", "REAL\n")]);
    let mount = inplace::prepare(&w.ws).unwrap();
    // the path now leads to a different directory
    let moved = w.root.with_file_name("proj-moved");
    std::fs::rename(&w.root, &moved).unwrap();
    std::fs::create_dir_all(&w.root).unwrap();
    std::fs::write(w.root.join("marker.txt"), "IMPOSTOR\n").unwrap();
    let mut env = BTreeMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    let spec = SandboxSpec {
        id: format!(
            "m3c{}pin{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ),
        program: "/usr/bin/sh".into(),
        args: vec!["-c".into(), "cat marker.txt; echo new > created.txt".into()],
        src_dir: PathBuf::new(),
        cwd: "/work/src".into(),
        env,
        ro_binds: vec![],
        rw_binds: vec![],
        src_writable: true,
        pinned_root: Some(mount.root_fd()),
        protect: mount.protect(),
        fd_ro_binds: mount.fd_ro_binds(),
        net: false,
        limits: SandboxLimits {
            wall_ms: 30_000,
            ..Default::default()
        },
        cgroup_base: cgroup_base().unwrap(),
        confine: Some(confine_spec(&w, false)),
    };
    let o = run_sandboxed(&spec, &mut Never).expect("run");
    assert!(
        text(&o).contains("REAL") && !text(&o).contains("IMPOSTOR"),
        "{}",
        text(&o)
    );
    assert!(moved.join("created.txt").exists() && !w.root.join("created.txt").exists());
}

// ------------------------------------------------------------------------------ M3C.4 hard links

#[test]
fn hard_linked_files_are_readable_but_cannot_be_written_through_the_workspace_name() {
    if !ready("hardlink") {
        return;
    }
    let outside = tempfile::tempdir().unwrap();
    let alias = outside.path().join("precious.txt");
    std::fs::write(&alias, "outside content\n").unwrap();
    let w = world(&[("ordinary.txt", "o\n"), ("two/a.txt", "pair\n")]);
    std::fs::hard_link(&alias, w.root.join("linked.txt")).unwrap();
    std::fs::hard_link(w.root.join("two/a.txt"), w.root.join("two/b.txt")).unwrap();
    let o = launch(
        &w,
        "cat linked.txt; echo more >> linked.txt; echo append-rc=$?; echo z > two/b.txt; echo b-rc=$?; \
         rm linked.txt; echo rm-rc=$?; ln linked.txt copy.txt; echo ln-rc=$?; echo ok >> ordinary.txt; echo ordinary-rc=$?",
    )
    .expect("run");
    let t = text(&o);
    assert!(
        t.contains("outside content"),
        "reading must keep working: {t}"
    );
    assert!(t.contains("append-rc=1") && t.contains("b-rc=1"), "{t}");
    assert!(t.contains("ordinary-rc=0"), "{t}");
    assert_eq!(
        std::fs::read_to_string(&alias).unwrap(),
        "outside content\n",
        "the file outside the workspace changed"
    );
    assert_eq!(
        std::fs::read_to_string(w.root.join("two/a.txt")).unwrap(),
        "pair\n"
    );
    let m = inplace::prepare(&w.ws).unwrap();
    let listed = m.summary["hardLinkedReadOnly"].to_string();
    assert!(
        listed.contains("linked.txt") && listed.contains("two/a.txt"),
        "{listed}"
    );
}

#[test]
fn the_operator_can_allow_hard_link_writes_and_the_record_says_so() {
    if !ready("hardlink-allow") {
        return;
    }
    let outside = tempfile::tempdir().unwrap();
    let alias = outside.path().join("p.txt");
    std::fs::write(&alias, "orig\n").unwrap();
    let w = world(&[("a.txt", "a\n")]);
    std::fs::hard_link(&alias, w.root.join("l.txt")).unwrap();
    let opts = PrepareOptions {
        hard_links: HardLinks::Allow,
        ..Default::default()
    };
    let o = launch_with(&w, &opts, false, "echo added >> l.txt", |_| {}).expect("run");
    assert_eq!(o.exit, nexus_tools::sandbox::ExitKind::Exited(0));
    // the documented consequence: the alias outside the workspace changed too
    assert_eq!(std::fs::read_to_string(&alias).unwrap(), "orig\nadded\n");
    let m = inplace::prepare_with(&w.ws, &opts).unwrap();
    assert_eq!(m.summary["hardLinks"], "allowed-by-operator");
}

#[test]
fn too_many_protected_entries_refuse_the_run_instead_of_protecting_some_of_them() {
    let files: Vec<(String, String)> = (0..40)
        .map(|i| (format!("f{i}.txt"), "x\n".to_owned()))
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let w = world(&refs);
    for i in 0..40 {
        std::fs::hard_link(
            w.root.join(format!("f{i}.txt")),
            w.root.join(format!("l{i}.txt")),
        )
        .unwrap();
    }
    let e = inplace::prepare_with(
        &w.ws,
        &PrepareOptions {
            max_protect: 10,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        e.message.contains("protected entries") && e.message.contains("nothing was run"),
        "{}",
        e.message
    );
}

#[test]
fn dependency_directories_are_not_scanned_for_hard_links_but_the_count_is_reported() {
    let w = world(&[("src/a.rs", "a\n"), ("node_modules/p/i.js", "1\n")]);
    std::fs::hard_link(
        w.root.join("node_modules/p/i.js"),
        w.root.join("node_modules/p/j.js"),
    )
    .unwrap();
    let m = inplace::prepare(&w.ws).unwrap();
    assert_eq!(m.summary["hardLinkedInDependencyDirs"], 2);
    assert_eq!(m.summary["hardLinkedReadOnly"].as_array().unwrap().len(), 0);
}

// ------------------------------------------------------------------------------ M3C.5 Git

fn git(dir: &Path, args: &[&str]) {
    let s = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        s.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&s.stderr)
    );
}

#[test]
fn git_metadata_is_readable_but_hooks_and_config_cannot_be_changed_by_a_command() {
    if !ready("git") || !Path::new("/usr/bin/git").exists() {
        return;
    }
    let w = world(&[("a.txt", "a\n"), ("vendor/lib/x.txt", "x\n")]);
    git(&w.root, &["init", "-q"]);
    git(&w.root, &["add", "a.txt"]);
    git(&w.root, &["commit", "-q", "-m", "first"]);
    git(&w.root.join("vendor/lib"), &["init", "-q"]); // a nested repository
    let o = launch(
        &w,
        "git -c safe.directory='*' log --oneline | head -1; git -c safe.directory='*' status --short | head -3; \
         echo '#!/bin/sh' > .git/hooks/pre-commit; echo hook-rc=$?; echo '[core]' >> .git/config; echo config-rc=$?; \
         echo x > vendor/lib/.git/hooks/post-checkout; echo nested-hook-rc=$?; \
         git -c safe.directory='*' commit --allow-empty -q -m second 2>&1 | head -2; echo commit-rc=$?; echo changed >> a.txt; echo a-rc=$?",
    )
    .expect("run");
    let t = text(&o);
    assert!(t.contains("first"), "git log must work read-only: {t}");
    assert!(
        t.contains("hook-rc=1") && t.contains("config-rc=1") && t.contains("nested-hook-rc=1"),
        "{t}"
    );
    assert!(t.contains("a-rc=0"), "ordinary files stay writable: {t}");
    assert!(
        !w.root.join(".git/hooks/pre-commit").exists(),
        "a hook was planted"
    );
    assert!(
        !w.root.join("vendor/lib/.git/hooks/post-checkout").exists(),
        "a nested hook was planted"
    );
    let cfg = std::fs::read_to_string(w.root.join(".git/config")).unwrap();
    assert!(!cfg.contains("[core]\n[core]"), "{cfg}");
    let m = inplace::prepare(&w.ws).unwrap();
    assert!(m.summary["readOnly"]
        .to_string()
        .contains("vendor/lib/.git"));
    assert_eq!(m.summary["git"]["kind"], "directory");
}

#[test]
fn a_linked_worktree_is_read_only_and_its_target_is_never_mounted() {
    if !ready("worktree") || !Path::new("/usr/bin/git").exists() {
        return;
    }
    let main = world(&[("a.txt", "a\n")]);
    git(&main.root, &["init", "-q"]);
    git(&main.root, &["add", "a.txt"]);
    git(&main.root, &["commit", "-q", "-m", "first"]);
    let wt = main.root.with_file_name("wt");
    git(
        &main.root,
        &[
            "worktree",
            "add",
            "-q",
            wt.to_str().unwrap(),
            "-b",
            "feature",
        ],
    );
    let ws = Workspace::open_root(wt.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let w = W {
        _t: tempfile::tempdir().unwrap(),
        root: wt.clone(),
        ws,
    };
    let m = inplace::prepare(&w.ws).unwrap();
    assert_eq!(m.summary["git"]["kind"], "linked-worktree-file");
    let o = launch(
        &w,
        "echo gitdir: /tmp > .git; echo gitfile-rc=$?; ls .git/worktrees 2>&1 | head -1; echo done",
    )
    .expect("run");
    let t = text(&o);
    assert!(
        t.contains("gitfile-rc=1"),
        "the .git file must be read-only: {t}"
    );
    assert!(std::fs::read_to_string(wt.join(".git"))
        .unwrap()
        .starts_with("gitdir: "));
}

#[test]
fn a_hostile_git_file_cannot_expose_a_directory_of_the_host() {
    if !ready("hostile-git") {
        return;
    }
    let host = tempfile::tempdir().unwrap();
    std::fs::write(host.path().join("secret.txt"), "HOSTSECRET\n").unwrap();
    let w = world(&[("a.txt", "a\n")]);
    std::fs::write(
        w.root.join(".git"),
        format!("gitdir: {}\n", host.path().display()),
    )
    .unwrap();
    let probe = format!("ls {} 2>&1; cat {}/secret.txt 2>&1; git -c safe.directory='*' status 2>&1 | head -2; echo done", host.path().display(), host.path().display());
    let o = launch(&w, &probe).expect("run");
    let t = text(&o);
    assert!(
        !t.contains("HOSTSECRET"),
        "the gitdir target was reachable: {t}"
    );
    assert!(
        t.contains("No such file"),
        "the target directory must not exist in the sandbox: {t}"
    );
    let m = inplace::prepare(&w.ws).unwrap();
    assert_eq!(m.summary["git"]["kind"], "linked-worktree-file");
    assert_eq!(
        m.summary["git"]["gitdirTarget"],
        host.path().to_string_lossy().as_ref()
    );
}

// ------------------------------------------------------------------------------------ benchmark

fn build_tree(root: &Path, src: usize, dep: usize) {
    for i in 0..src {
        let d = root.join(format!("src/mod{}/sub{}", i % 40, i % 7));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("f{i}.rs")), "fn f() {}\n").unwrap();
    }
    for i in 0..dep {
        let d = root.join(format!("node_modules/pkg{}/lib{}", i % 500, i % 11));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("i{i}.js")), "x\n").unwrap();
    }
}

fn median(v: &mut [u128]) -> u128 {
    v.sort();
    v[v.len() / 2]
}

/// `cargo test -p nexus-tools --release --test confine_m3c -- --ignored --nocapture bench_confinement`
#[test]
#[ignore]
fn bench_confinement() {
    assert!(ready("bench"));
    // 1. the launch itself: bubblewrap alone vs bubblewrap + launch gate (same tiny project, trivial command)
    let w = world(&[("a.txt", "a\n")]);
    let mut plain = vec![];
    let mut gated = vec![];
    for i in 0..30 {
        let t = std::time::Instant::now();
        launch_with(&w, &PrepareOptions::default(), false, "true", |s| {
            s.confine = None
        })
        .unwrap();
        let a = t.elapsed().as_micros();
        let t = std::time::Instant::now();
        launch_with(&w, &PrepareOptions::default(), false, "true", |_| {}).unwrap();
        let b = t.elapsed().as_micros();
        if i >= 5 {
            plain.push(a);
            gated.push(b);
        }
    }
    let (p, g) = (median(&mut plain), median(&mut gated));
    println!("BENCH launch (prepare+spawn+run `true`, median of 25): bwrap only {} ms, with launch gate {} ms, gate overhead {} ms", p / 1000, g / 1000, (g as i128 - p as i128) / 1000);
    // 2. mount preparation (recursive scan) by project size
    for (name, src, dep) in [
        ("small 1k", 1_000usize, 0usize),
        ("medium 20k", 20_000, 0),
        ("large 20k+130k deps", 20_000, 130_000),
    ] {
        let w = world(&[]);
        build_tree(&w.root, src, dep);
        std::fs::write(w.root.join("src/mod0/.env"), "S=1\n").unwrap();
        std::os::unix::net::UnixListener::bind(w.root.join("src/mod1/s.sock"))
            .map(std::mem::forget)
            .unwrap();
        let mut ts = vec![];
        let mut ex = 0;
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let m = inplace::prepare(&w.ws).unwrap();
            ts.push(t.elapsed().as_micros());
            ex = m.summary["entriesExamined"].as_u64().unwrap();
        }
        let full = {
            let t = std::time::Instant::now();
            launch(&w, "true").unwrap();
            t.elapsed().as_millis()
        };
        println!("BENCH mount-prepare {name}: entries examined {ex}, scan median {} ms; whole launch of `true` (scan + mounts + gate + run) {} ms", median(&mut ts) / 1000, full);
    }
}

// ------------------------------------------------------------------------------------ M4A layouts

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn wt_opts() -> PrepareOptions {
    PrepareOptions {
        git_worktree: true,
        ..Default::default()
    }
}

#[test]
fn submodules_and_nested_repositories_are_read_only_and_git_still_reads_them() {
    if !ready("submodule") || !Path::new("/usr/bin/git").exists() {
        return;
    }
    let lib = world(&[("lib.txt", "library\n")]);
    assert!(
        git_ok(&lib.root, &["init", "-q"])
            && git_ok(&lib.root, &["add", "-A"])
            && git_ok(&lib.root, &["commit", "-q", "-m", "lib"])
    );
    let w = world(&[("main.txt", "main\n")]);
    assert!(git_ok(&w.root, &["init", "-q"]));
    assert!(
        git_ok(
            &w.root,
            &[
                "submodule",
                "add",
                "-q",
                lib.root.to_str().unwrap(),
                "vendor/lib"
            ]
        ),
        "submodule add failed"
    );
    assert!(git_ok(&w.root, &["add", "-A"]) && git_ok(&w.root, &["commit", "-q", "-m", "main"]));
    let m = inplace::prepare(&w.ws).unwrap();
    let ro = m.summary["readOnly"].to_string();
    assert!(
        ro.contains("vendor/lib/.git"),
        "the submodule's .git file must be read-only: {ro}"
    );
    let o = launch(
        &w,
        "git -c safe.directory='*' submodule status | head -2; git -c safe.directory='*' log --oneline | head -1; \
         cat vendor/lib/lib.txt; echo tamper > vendor/lib/.git; echo subgit-rc=$?; echo ok >> vendor/lib/lib.txt; echo sublib-rc=$?; \
         echo '[core]' >> .git/modules/vendor/lib/config; echo modcfg-rc=$?",
    )
    .expect("run");
    let t = text(&o);
    assert!(t.contains("library") && t.contains("main"), "{t}");
    assert!(
        t.contains("subgit-rc=1") && t.contains("modcfg-rc=1"),
        "{t}"
    );
    assert!(
        t.contains("sublib-rc=0"),
        "ordinary submodule files stay writable: {t}"
    );
}

#[test]
fn a_linked_worktree_gets_its_git_metadata_read_only_only_when_the_owner_allows_it() {
    if !ready("worktree-meta") || !Path::new("/usr/bin/git").exists() {
        return;
    }
    let main = world(&[("a.txt", "a\n")]);
    assert!(
        git_ok(&main.root, &["init", "-q"])
            && git_ok(&main.root, &["add", "-A"])
            && git_ok(&main.root, &["commit", "-q", "-m", "first"])
    );
    let wt = main.root.with_file_name("wt");
    assert!(git_ok(
        &main.root,
        &[
            "worktree",
            "add",
            "-q",
            wt.to_str().unwrap(),
            "-b",
            "feature"
        ]
    ));
    let ws = Workspace::open_root(wt.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
    let w = W {
        _t: tempfile::tempdir().unwrap(),
        root: wt.clone(),
        ws,
    };
    let probe = "git -c safe.directory='*' log --oneline 2>&1 | head -2; git -c safe.directory='*' status --short 2>&1 | head -2; \
                 echo x >> .git/../x.txt; echo hooks > \"$(sed 's/gitdir: //' .git)/hooks-test\" 2>/dev/null; echo write-rc=$?";
    // default (off): the main repository's .git is NOT mounted, git fails closed
    let off = launch(&w, probe).expect("run");
    assert!(
        text(&off).contains("not a git repository") || text(&off).contains("fatal"),
        "{}",
        text(&off)
    );
    // allowed: verified and mounted read-only
    let on = launch_with(&w, &wt_opts(), false, probe, |_| {}).expect("run");
    let t = text(&on);
    assert!(
        t.contains("first"),
        "git log must work with the verified metadata: {t}"
    );
    assert!(
        t.contains("write-rc=1") || t.contains("write-rc=2"),
        "the metadata must be read-only: {t}"
    );
    let m = inplace::prepare_with(&w.ws, &wt_opts()).unwrap();
    assert_eq!(m.summary["git"]["kind"], "linked-worktree-file");
    assert_eq!(
        m.summary["git"]["externalGitDir"],
        main.root.join(".git").to_string_lossy().as_ref()
    );
    assert!(!main
        .root
        .join(".git/worktrees")
        .join("wt")
        .join("hooks-test")
        .exists());
}

#[test]
fn forged_or_unsafe_git_pointers_are_never_mounted_even_when_the_owner_allows_worktrees() {
    if !ready("forged") {
        return;
    }
    let secret_repo = tempfile::tempdir().unwrap();
    let sr = std::fs::canonicalize(secret_repo.path()).unwrap();
    // a real-looking layout that does NOT point back at the victim worktree
    std::fs::create_dir_all(sr.join(".git/worktrees/x")).unwrap();
    std::fs::write(sr.join(".git/worktrees/x/gitdir"), "/somewhere/else/.git\n").unwrap();
    std::fs::write(sr.join(".git/SECRET"), "REPOSECRET\n").unwrap();
    let cases: Vec<(&str, String)> = vec![
        (
            "back-pointer mismatch",
            format!("gitdir: {}/.git/worktrees/x\n", sr.display()),
        ),
        ("the home of the user", "gitdir: /home\n".into()),
        ("not absolute", "gitdir: ../elsewhere\n".into()),
        (
            "a path with a link in it",
            format!("gitdir: {}/.git/../.git/worktrees/x\n", sr.display()),
        ),
        ("wrong layout", format!("gitdir: {}/.git\n", sr.display())),
        ("nonsense", "gitdir:\n".into()),
    ];
    for (name, content) in cases {
        let w = world(&[("a.txt", "a\n")]);
        std::fs::write(w.root.join(".git"), content).unwrap();
        let m = inplace::prepare_with(&w.ws, &wt_opts()).unwrap();
        let note = m.summary["git"]["externalGitDir"].to_string();
        assert!(note.contains("not mounted"), "{name}: {note}");
        let o = launch_with(
            &w,
            &wt_opts(),
            false,
            &format!(
                "cat {}/.git/SECRET 2>&1; ls /home 2>&1 | head -1",
                sr.display()
            ),
            |_| {},
        )
        .expect("run");
        assert!(
            !text(&o).contains("REPOSECRET"),
            "{name}: the forged pointer exposed a repository: {}",
            text(&o)
        );
    }
    // a symlink in place of the .git file is never followed
    let w = world(&[("a.txt", "a\n")]);
    std::os::unix::fs::symlink(sr.join(".git"), w.root.join(".git")).unwrap();
    let o = launch_with(
        &w,
        &wt_opts(),
        false,
        &format!(
            "cat {}/.git/SECRET 2>&1; cat .git/SECRET 2>&1",
            sr.display()
        ),
        |_| {},
    )
    .expect("run");
    assert!(!text(&o).contains("REPOSECRET"), "{}", text(&o));
}

#[test]
fn symlinks_in_the_project_never_lead_out_of_it() {
    if !ready("symlinks") {
        return;
    }
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("host.txt"), "HOSTONLY\n").unwrap();
    let w = world(&[("real/inner.txt", "inner\n")]);
    use std::os::unix::fs::symlink;
    symlink(outside.path(), w.root.join("to-outside-dir")).unwrap();
    symlink(
        outside.path().join("host.txt"),
        w.root.join("to-outside-file"),
    )
    .unwrap();
    symlink("/etc/passwd", w.root.join("to-etc")).unwrap();
    symlink("real", w.root.join("inside-link")).unwrap();
    symlink("loop-b", w.root.join("loop-a")).unwrap();
    symlink("loop-a", w.root.join("loop-b")).unwrap();
    symlink("does-not-exist", w.root.join("dangling")).unwrap();
    let o = launch(
        &w,
        "cat to-outside-file 2>&1 | head -1; cat to-outside-dir/host.txt 2>&1 | head -1; cat to-etc 2>&1 | head -1; cat inside-link/inner.txt; \
         cat loop-a 2>&1 | head -1; cat dangling 2>&1 | head -1; ln -s /etc/shadow made-link; ls -l made-link | wc -l; echo done",
    )
    .expect("run");
    let t = text(&o);
    assert!(
        !t.contains("HOSTONLY") && !t.contains("root:x:0"),
        "a link led out of the project: {t}"
    );
    assert!(t.contains("inner") && t.contains("done"), "{t}");
}

#[test]
fn the_launch_works_on_each_filesystem_available_here() {
    if !ready("filesystems") {
        return;
    }
    // tmpfs (the system temp dir here) and the user's home filesystem (btrfs on this machine)
    let mut bases: Vec<PathBuf> = vec![std::env::temp_dir()];
    if let Some(h) = std::env::var_os("HOME") {
        let p = PathBuf::from(h).join(".cache");
        if p.is_dir() {
            bases.push(p);
        }
    }
    for base in bases {
        let t = tempfile::tempdir_in(&base).unwrap();
        let root = std::fs::canonicalize(t.path()).unwrap().join("proj");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "a\n").unwrap();
        std::fs::write(root.join(".env"), "S=1\n").unwrap();
        let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
        let w = W {
            _t: t,
            root: root.clone(),
            ws,
        };
        let o = launch(&w, "cat .env 2>&1 | head -1; echo new > src/b.txt && cat src/b.txt && mkdir -p out/deep && echo z > out/deep/z.txt").expect("run");
        let tx = text(&o);
        assert!(
            !tx.contains("S=1") && tx.contains("new"),
            "{}: {tx}",
            base.display()
        );
        assert_eq!(
            std::fs::read_to_string(root.join("out/deep/z.txt")).unwrap(),
            "z\n"
        );
    }
}

/// A bind mount below the project root, made in a real (unprivileged) mount namespace: refused with a reason.
#[test]
fn a_bind_mount_inside_the_project_is_refused_with_an_actionable_reason() {
    if std::env::var("NEXUS_M4_INNER").is_ok() {
        let root = PathBuf::from(std::env::var("NEXUS_M4_ROOT").unwrap());
        let ws = Workspace::open_root(root.to_str().unwrap(), WorkspacePolicy::default()).unwrap();
        let e = inplace::prepare(&ws).unwrap_err();
        assert!(
            e.message
                .contains("a mount exists below the workspace root"),
            "{}",
            e.message
        );
        return;
    }
    if !ready("bindmount")
        || std::process::Command::new("unshare")
            .arg("-rm")
            .arg("true")
            .status()
            .map(|s| !s.success())
            .unwrap_or(true)
    {
        println!("NOT RUN (bindmount): unprivileged mount namespaces are unavailable");
        return;
    }
    let w = world(&[("a.txt", "a\n"), ("sub/keep.txt", "k\n")]);
    let other = tempfile::tempdir().unwrap();
    std::fs::write(other.path().join("exposed.txt"), "EXPOSED\n").unwrap();
    let exe = std::env::current_exe().unwrap();
    let st = std::process::Command::new("unshare")
        .args(["-rm", "sh", "-c"])
        .arg(format!(
            "mount --bind '{}' '{}/sub' && exec '{}' --exact a_bind_mount_inside_the_project_is_refused_with_an_actionable_reason --nocapture",
            other.path().display(),
            w.root.display(),
            exe.display()
        ))
        .env("NEXUS_M4_INNER", "1")
        .env("NEXUS_M4_ROOT", &w.root)
        .status()
        .unwrap();
    assert!(
        st.success(),
        "the refusal was not produced inside the mount namespace"
    );
}
