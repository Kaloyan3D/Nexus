//! Kernel confinement for in-place commands (M3C): Landlock composed with the bubblewrap mount namespace.
//!
//! Layers, outermost first (each is defense in depth for the others, none replaces another):
//!  1. Kernel authorization (sealed scope, grant, approval) - decides that the command may run at all.
//!  2. bubblewrap: user/pid/ipc/uts/(net) namespaces, a synthetic root, the verified workspace bound by
//!     descriptor, protected entries masked by mounts, seccomp deny-list, cgroup limits, supervisor.
//!  3. **This module**: the launch gate `nexus-confine` runs inside the namespace BEFORE the command and
//!     (a) checks that the namespace is exactly the intended mount specification, (b) closes every inherited
//!     descriptor, (c) applies a Landlock ruleset that grants only the sandbox's own paths, plus abstract-socket
//!     and signal scoping where the kernel has them, then (d) executes the command. Any failed check is a
//!     refusal (exit 197, `NEXUS-CONFINE-REFUSED:`) and the command never starts.
//!
//! What Landlock does and does not add. It cannot carve a denied sub-path out of a granted directory, so the
//! nested protected entries stay mount-level masks (verified by the gate). It confines the command to the
//! sandbox's own mounts even if a mount-level mistake exposed more, forbids writing outside them, and (ABI >= 6)
//! stops connections to abstract unix sockets and signals to processes outside the command's own domain.
//! Pathname unix sockets inside a granted directory remain reachable (Landlock gained RESOLVE_UNIX only in
//! ABI 9); that is why every socket in the workspace is masked by a mount instead.

use std::ffi::CString;
use std::os::fd::RawFd;

/// Protocol of the plan arguments between the host and the gate. The host refuses a gate that reports another.
pub const PROTOCOL: &str = "nexus-confine/1";
pub const REFUSED_PREFIX: &str = "NEXUS-CONFINE-REFUSED:";
pub const REFUSED_EXIT: i32 = 197;
/// Where the gate is mounted inside the sandbox.
pub const SANDBOX_PATH: &str = "/nexus/confine";
/// Where the workspace is mounted inside the sandbox.
pub const WORK_SRC: &str = "/work/src";
/// Lowest Landlock ABI accepted for an in-place command (3: filesystem rights incl. truncate and reparenting).
pub const MIN_ABI: u32 = 3;
/// ABI from which abstract-socket and signal scoping exist.
pub const SCOPE_ABI: u32 = 6;

// ---------------------------------------------------------------------------------------- landlock ABI

const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;

const FS_EXECUTE: u64 = 1 << 0;
const FS_WRITE_FILE: u64 = 1 << 1;
const FS_READ_FILE: u64 = 1 << 2;
const FS_READ_DIR: u64 = 1 << 3;
const FS_REFER: u64 = 1 << 13;
const FS_TRUNCATE: u64 = 1 << 14;
const FS_IOCTL_DEV: u64 = 1 << 15;
const SCOPE_ABSTRACT_UNIX: u64 = 1 << 0;
const SCOPE_SIGNAL: u64 = 1 << 1;
/// Rights that are meaningful for a non-directory.
const FILE_RIGHTS: u64 = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV;

/// The Landlock ABI of the running kernel (None = Landlock unavailable or disabled).
pub fn landlock_abi() -> Option<u32> {
    let r = unsafe {
        libc::syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            std::ptr::null::<u8>(),
            0usize,
            1u32, // LANDLOCK_CREATE_RULESET_VERSION
        )
    };
    (r > 0).then_some(r as u32)
}

fn all_fs(abi: u32) -> u64 {
    let mut m = (1u64 << 13) - 1; // bits 0..=12
    if abi >= 2 {
        m |= FS_REFER;
    }
    if abi >= 3 {
        m |= FS_TRUNCATE;
    }
    if abi >= 5 {
        m |= FS_IOCTL_DEV;
    }
    m
}

// ---------------------------------------------------------------------------------------- the plan

/// An expectation about the mount namespace that the gate verifies before the command may run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expect {
    /// An existing file/socket/fifo that must be replaced by the empty character device (`/dev/null`).
    HiddenFile(String),
    /// An existing directory that must be replaced by an empty mount of another filesystem.
    HiddenDir(String),
    /// An entry that must be the very object `ino` and be mounted read-only.
    ReadOnly(String, u64),
}

impl Expect {
    pub fn rel(&self) -> &str {
        match self {
            Expect::HiddenFile(r) | Expect::HiddenDir(r) | Expect::ReadOnly(r, _) => r,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Plan {
    /// Read + execute (system trees, read-only binds).
    pub ro: Vec<String>,
    /// Everything (the workspace, scratch tmpfs, project-scoped read-write binds).
    pub rw: Vec<String>,
    /// Device nodes: read, write, ioctl.
    pub dev: Vec<String>,
    pub min_abi: u32,
    /// Abstract-socket and signal scoping is REQUIRED (the command shares the host network namespace).
    pub require_scope: bool,
    /// `(dev, ino)` of the workspace directory that must be mounted at `WORK_SRC`.
    pub root: Option<(u64, u64)>,
    pub expect: Vec<Expect>,
    /// Controlled Internet: the unix socket of the egress service (inside the sandbox), the loopback port of
    /// the HTTP proxy bridge, and loopback ports forwarded to granted services on the user's machine.
    pub egress_sock: Option<String>,
    pub bridge_http: Option<u16>,
    pub bridge_forward: Vec<u16>,
}

impl Plan {
    pub fn to_args(&self) -> Vec<String> {
        let mut a = vec!["--min-abi".to_owned(), self.min_abi.to_string()];
        if self.require_scope {
            a.push("--scope".into());
        }
        if let Some((d, i)) = self.root {
            a.push("--root".into());
            a.push(format!("{d}:{i}"));
        }
        for (flag, v) in [("--ro", &self.ro), ("--rw", &self.rw), ("--dev", &self.dev)] {
            for p in v {
                a.push(flag.into());
                a.push(p.clone());
            }
        }
        if let Some(sock) = &self.egress_sock {
            a.push("--egress-sock".into());
            a.push(sock.clone());
        }
        if let Some(p) = self.bridge_http {
            a.push("--bridge-http".into());
            a.push(p.to_string());
        }
        for p in &self.bridge_forward {
            a.push("--bridge-forward".into());
            a.push(p.to_string());
        }
        for e in &self.expect {
            match e {
                Expect::HiddenFile(r) => {
                    a.push("--hidden-file".into());
                    a.push(r.clone());
                }
                Expect::HiddenDir(r) => {
                    a.push("--hidden-dir".into());
                    a.push(r.clone());
                }
                Expect::ReadOnly(r, ino) => {
                    a.push("--readonly".into());
                    a.push(ino.to_string());
                    a.push(r.clone());
                }
            }
        }
        a.push("--".into());
        a
    }

    /// Parse the gate's arguments; returns the plan and the command to execute.
    pub fn parse(args: &[String]) -> Result<(Plan, Vec<String>), String> {
        let mut p = Plan::default();
        let mut i = 0;
        let need = |i: usize, n: usize| -> Result<(), String> {
            if i + n < args.len() {
                Ok(())
            } else {
                Err("truncated confinement arguments".into())
            }
        };
        while i < args.len() {
            match args[i].as_str() {
                "--" => return Ok((p, args[i + 1..].to_vec())),
                "--scope" => {
                    p.require_scope = true;
                    i += 1;
                }
                "--min-abi" => {
                    need(i, 1)?;
                    p.min_abi = args[i + 1].parse().map_err(|_| "bad --min-abi")?;
                    i += 2;
                }
                "--root" => {
                    need(i, 1)?;
                    let (d, n) = args[i + 1].split_once(':').ok_or("bad --root")?;
                    p.root = Some((
                        d.parse().map_err(|_| "bad --root")?,
                        n.parse().map_err(|_| "bad --root")?,
                    ));
                    i += 2;
                }
                "--ro" | "--rw" | "--dev" => {
                    need(i, 1)?;
                    let v = args[i + 1].clone();
                    match args[i].as_str() {
                        "--ro" => p.ro.push(v),
                        "--rw" => p.rw.push(v),
                        _ => p.dev.push(v),
                    }
                    i += 2;
                }
                "--hidden-file" | "--hidden-dir" => {
                    need(i, 1)?;
                    let v = args[i + 1].clone();
                    p.expect.push(if args[i] == "--hidden-file" {
                        Expect::HiddenFile(v)
                    } else {
                        Expect::HiddenDir(v)
                    });
                    i += 2;
                }
                "--egress-sock" => {
                    need(i, 1)?;
                    p.egress_sock = Some(args[i + 1].clone());
                    i += 2;
                }
                "--bridge-http" => {
                    need(i, 1)?;
                    p.bridge_http = Some(args[i + 1].parse().map_err(|_| "bad --bridge-http")?);
                    i += 2;
                }
                "--bridge-forward" => {
                    need(i, 1)?;
                    p.bridge_forward
                        .push(args[i + 1].parse().map_err(|_| "bad --bridge-forward")?);
                    i += 2;
                }
                "--readonly" => {
                    need(i, 2)?;
                    p.expect.push(Expect::ReadOnly(
                        args[i + 2].clone(),
                        args[i + 1].parse().map_err(|_| "bad --readonly")?,
                    ));
                    i += 3;
                }
                other => return Err(format!("unknown confinement argument {other}")),
            }
        }
        Err("no command after the confinement arguments".into())
    }
}

// ---------------------------------------------------------------------------------------- the gate

fn refuse(why: &str) -> ! {
    eprintln!("{REFUSED_PREFIX} {why}");
    std::process::exit(REFUSED_EXIT)
}

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| refuse("path contains NUL"))
}

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

/// openat2 with BENEATH | NO_SYMLINKS | NO_MAGICLINKS | NO_XDEV disabled (masks ARE other mounts).
fn open_beneath(dirfd: RawFd, rel: &str, flags: i32) -> Result<RawFd, i32> {
    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_NO_SYMLINKS: u64 = 0x04;
    const RESOLVE_BENEATH: u64 = 0x08;
    let how = OpenHow {
        flags: flags as u64,
        mode: 0,
        resolve: RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH,
    };
    let c = cstr(rel);
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            dirfd,
            c.as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(libc::EIO))
    } else {
        Ok(fd as RawFd)
    }
}

fn fstat(fd: RawFd) -> libc::stat {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        refuse("fstat failed");
    }
    st
}

fn unescape_mountinfo(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\'
            && i + 3 < b.len()
            && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c))
        {
            out.push((b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0'));
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Descriptors other than 0-2 must not exist when the command starts.
fn check_descriptors() {
    let rd = match std::fs::read_dir("/proc/self/fd") {
        Ok(r) => r,
        Err(_) => refuse("cannot inspect inherited descriptors"),
    };
    let own_dir = format!("/proc/{}/fd", std::process::id());
    let mut extra = vec![];
    for e in rd.flatten() {
        let Ok(n) = e.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        if n > 2 {
            // the directory handle used for this very listing is not an inherited descriptor
            let t = std::fs::read_link(e.path()).ok();
            if t.as_deref().and_then(|p| p.to_str()) == Some(own_dir.as_str()) {
                continue;
            }
            extra.push(n);
        }
    }
    if !extra.is_empty() {
        refuse(&format!("unexpected inherited descriptors {extra:?}"));
    }
}

fn verify_mounts(plan: &Plan, root_dev: u64) {
    let root = open_beneath_abs(WORK_SRC);
    for e in &plan.expect {
        let rel = e.rel();
        let flags = libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let fd = match open_beneath(root, rel, flags) {
            Ok(fd) => fd,
            Err(_) => refuse(&format!(
                "protected entry {rel} cannot be opened without following a link"
            )),
        };
        let st = fstat(fd);
        match e {
            Expect::HiddenFile(_) => {
                let dev_null = libc::makedev(1, 3);
                if (st.st_mode & libc::S_IFMT) != libc::S_IFCHR || st.st_rdev != dev_null {
                    refuse(&format!("{rel} is not masked"));
                }
            }
            Expect::HiddenDir(_) => {
                if (st.st_mode & libc::S_IFMT) != libc::S_IFDIR || st.st_dev == root_dev {
                    refuse(&format!("{rel} is not masked"));
                }
                match std::fs::read_dir(format!("/proc/self/fd/{fd}")) {
                    Ok(mut d) => {
                        if d.next().is_some() {
                            refuse(&format!("{rel}: the mask is not empty"));
                        }
                    }
                    Err(_) => refuse(&format!("{rel}: the mask cannot be inspected")),
                }
            }
            Expect::ReadOnly(_, ino) => {
                let mut sv: libc::statvfs = unsafe { std::mem::zeroed() };
                let rc = unsafe { libc::fstatvfs(fd, &mut sv) };
                if st.st_ino != *ino || rc != 0 || (sv.f_flag & libc::ST_RDONLY) == 0 {
                    refuse(&format!("{rel} is not the expected read-only object"));
                }
            }
        }
        unsafe { libc::close(fd) };
    }
    // No mount below the workspace except the expected ones.
    let allowed: std::collections::BTreeSet<String> = plan
        .expect
        .iter()
        .map(|e| format!("{WORK_SRC}/{}", e.rel()))
        .collect();
    let mi = std::fs::read_to_string("/proc/self/mountinfo")
        .unwrap_or_else(|_| refuse("cannot read the mount table"));
    let prefix = format!("{WORK_SRC}/");
    for line in mi.lines() {
        if let Some(mp) = line.split(' ').nth(4) {
            let mp = unescape_mountinfo(mp);
            if mp.starts_with(&prefix) && !allowed.contains(&mp) {
                refuse(&format!("unexpected mount at {mp}"));
            }
        }
    }
    unsafe { libc::close(root) };
}

fn open_beneath_abs(path: &str) -> RawFd {
    let c = cstr(path);
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        refuse(&format!("{path} is not available"));
    }
    fd
}

#[repr(C, packed)]
struct PathBeneath {
    allowed_access: u64,
    parent_fd: i32,
}

fn add_path_rule(ruleset: RawFd, path: &str, rights: u64, abi: u32, must_exist: bool) {
    let c = cstr(path);
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        if must_exist {
            refuse(&format!("{path} is not available inside the sandbox"));
        }
        return;
    }
    let st = fstat(fd);
    let mut r = rights & all_fs(abi);
    if (st.st_mode & libc::S_IFMT) != libc::S_IFDIR {
        r &= FILE_RIGHTS;
    }
    let rule = PathBeneath {
        allowed_access: r,
        parent_fd: fd,
    };
    let rc = unsafe {
        libc::syscall(
            SYS_LANDLOCK_ADD_RULE,
            ruleset,
            1u32,
            &rule as *const PathBeneath,
            0u32,
        )
    };
    unsafe { libc::close(fd) };
    if rc != 0 {
        refuse(&format!(
            "Landlock rule for {path} failed: {}",
            std::io::Error::last_os_error()
        ));
    }
}

fn apply_landlock(plan: &Plan, abi: u32) {
    let scope = if abi >= SCOPE_ABI {
        SCOPE_ABSTRACT_UNIX | SCOPE_SIGNAL
    } else {
        0
    };
    let handled = all_fs(abi);
    // struct landlock_ruleset_attr { u64 fs; u64 net; u64 scoped; } (size by ABI)
    let attr: [u64; 3] = [handled, 0, scope];
    let size = if abi >= SCOPE_ABI {
        24
    } else if abi >= 4 {
        16
    } else {
        8
    };
    let fd = unsafe { libc::syscall(SYS_LANDLOCK_CREATE_RULESET, attr.as_ptr(), size, 0u32) };
    if fd < 0 {
        refuse(&format!(
            "Landlock ruleset creation failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let fd = fd as RawFd;
    let ro = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR;
    let dev = FS_READ_FILE | FS_WRITE_FILE | FS_READ_DIR | FS_TRUNCATE | FS_IOCTL_DEV;
    for p in &plan.ro {
        add_path_rule(fd, p, ro, abi, false);
    }
    for p in &plan.dev {
        add_path_rule(fd, p, dev, abi, true);
    }
    for p in &plan.rw {
        add_path_rule(fd, p, handled, abi, true);
    }
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        refuse("PR_SET_NO_NEW_PRIVS failed");
    }
    if unsafe { libc::syscall(SYS_LANDLOCK_RESTRICT_SELF, fd, 0u32) } != 0 {
        refuse(&format!(
            "Landlock restriction failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    unsafe { libc::close(fd) };
}

/// After restriction a directory that no rule grants must not be listable. If it is, Landlock is not effective.
fn self_test() {
    let c = cstr("/work");
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd >= 0 {
        refuse("Landlock is not effective (an ungranted directory could be read)");
    }
}

// ---------------------------------------------------------------------------------------- the bridge

/// Copy one connection both ways between a loopback client and the egress unix socket.
fn bridge_conn(client: std::net::TcpStream, sock: &str, forward: Option<u16>) {
    use std::io::Write;
    let Ok(mut up) = std::os::unix::net::UnixStream::connect(sock) else {
        return; // the egress service is gone: the connection fails, nothing else is tried
    };
    if let Some(p) = forward {
        if up
            .write_all(format!("NEXUS-FORWARD {p}\n").as_bytes())
            .is_err()
        {
            return;
        }
    }
    let (Ok(mut c2), Ok(mut u2)) = (client.try_clone(), up.try_clone()) else {
        return;
    };
    let mut c1 = client;
    let t = std::thread::spawn(move || {
        let _ = std::io::copy(&mut c1, &mut up);
        let _ = up.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut u2, &mut c2);
    let _ = c2.shutdown(std::net::Shutdown::Write);
    let _ = t.join();
}

/// Start the bridge in a child process of the gate (inside the sandbox, after Landlock). The command is
/// `exec`ed by the parent; the child lives as long as the sandbox and dies with it. Loopback only: the
/// sandbox has no other interface, so this is the ONLY way out.
fn start_bridge(plan: &Plan) {
    let Some(sock) = plan.egress_sock.clone() else {
        if plan.bridge_http.is_some() || !plan.bridge_forward.is_empty() {
            refuse("a bridge was requested without an egress socket");
        }
        return;
    };
    // the egress service must be there before the command starts
    if std::os::unix::net::UnixStream::connect(&sock).is_err() {
        refuse("the egress service is not reachable; Controlled Internet is unavailable and nothing was run");
    }
    let mut ls: Vec<(std::net::TcpListener, Option<u16>)> = Vec::new();
    let mut want: Vec<(u16, Option<u16>)> = Vec::new();
    if let Some(p) = plan.bridge_http {
        want.push((p, None));
    }
    for p in &plan.bridge_forward {
        want.push((*p, Some(*p)));
    }
    for (port, fwd) in want {
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => ls.push((l, fwd)),
            Err(e) => refuse(&format!(
                "cannot listen on 127.0.0.1:{port} for the network bridge: {e}"
            )),
        }
    }
    match unsafe { libc::fork() } {
        -1 => refuse("cannot start the network bridge"),
        0 => {
            // child: the bridge
            unsafe {
                libc::setsid();
                libc::signal(libc::SIGPIPE, libc::SIG_IGN);
                let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
                if null >= 0 {
                    libc::dup2(null, 0);
                    libc::dup2(null, 1);
                    libc::dup2(null, 2);
                }
            }
            let mut hs = Vec::new();
            for (l, fwd) in ls {
                let sock = sock.clone();
                hs.push(std::thread::spawn(move || {
                    for c in l.incoming().flatten() {
                        let sock = sock.clone();
                        std::thread::spawn(move || bridge_conn(c, &sock, fwd));
                    }
                }));
            }
            for h in hs {
                let _ = h.join();
            }
            unsafe { libc::_exit(0) };
        }
        _ => {} // parent: drop its copies of the listeners (close_range below) and run the command
    }
}

/// Entry point of `nexus-confine`.
pub fn shim_main(args: Vec<String>) -> ! {
    if args.first().map(String::as_str) == Some("--version") {
        println!("{PROTOCOL}");
        std::process::exit(0);
    }
    let (plan, cmd) = match Plan::parse(&args) {
        Ok(v) => v,
        Err(e) => refuse(&e),
    };
    if cmd.is_empty() {
        refuse("no command");
    }
    check_descriptors();
    let root = open_beneath_abs(WORK_SRC);
    let rst = fstat(root);
    if let Some((d, i)) = plan.root {
        if rst.st_dev as u64 != d || rst.st_ino as u64 != i {
            refuse("the mounted workspace is not the verified object");
        }
    }
    unsafe { libc::close(root) };
    verify_mounts(&plan, rst.st_dev as u64);
    let abi = match landlock_abi() {
        Some(a) if a >= plan.min_abi.max(MIN_ABI) => a,
        Some(a) => refuse(&format!(
            "Landlock ABI {a} is below the required {}",
            plan.min_abi.max(MIN_ABI)
        )),
        None => refuse("Landlock is unavailable on this kernel"),
    };
    if plan.require_scope && abi < SCOPE_ABI {
        refuse(&format!("scoping of abstract sockets and signals needs Landlock ABI {SCOPE_ABI} (this kernel: {abi})"));
    }
    apply_landlock(&plan, abi);
    self_test();
    start_bridge(&plan);
    // nothing but 0-2 may survive into the command
    unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) };
    let cargs: Vec<CString> = cmd.iter().map(|a| cstr(a)).collect();
    let mut ptrs: Vec<*const libc::c_char> = cargs.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    unsafe { libc::execv(ptrs[0], ptrs.as_ptr()) };
    eprintln!(
        "nexus-confine: cannot execute {}: {}",
        cmd[0],
        std::io::Error::last_os_error()
    );
    std::process::exit(127)
}
