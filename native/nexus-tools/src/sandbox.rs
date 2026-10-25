//! Linux process sandbox (A3.4).
//!
//! Boundary (all mandatory; failure to establish ANY of them refuses to
//! run, there is no unsandboxed fallback):
//!
//! * **bubblewrap** (reviewed, widely deployed) creates new *user*,
//!   *mount*, *PID*, *network*, *IPC*, *UTS* and *cgroup* namespaces,
//!   `--disable-userns` (no nested user namespaces), `--cap-drop ALL`,
//!   `--new-session`, `--die-with-parent`, `--clearenv` and an explicit
//!   environment.
//! * **Filesystem**: a minimal synthetic root. Only `/usr` (read-only),
//!   `/proc` (of the new PID namespace), `/dev` (bwrap's minimal devtmpfs),
//!   tmpfs `/tmp` and `/work/out` (size-limited), the *staged snapshot* at
//!   `/work/src` (read-only) and explicitly listed toolchain directories
//!   (read-only) exist. The host root, the real workspace, `$HOME`, SSH
//!   keys, daemon state, capability files and sockets are not mapped.
//! * **Network**: a fresh network namespace with only a private loopback.
//!   Host loopback services are unreachable.
//! * **seccomp**: a BPF filter (deny-list of kernel-attack-surface and
//!   escape syscalls; `clone3` forced to `ENOSYS`) installed by bwrap
//!   before exec, with `no_new_privs`.
//! * **Resource limits**: `prlimit` inside the new user namespace
//!   (`RLIMIT_NPROC` is accounted per user namespace on Linux >= 5.14,
//!   `RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE`, no core
//!   dumps), tmpfs size caps, a wall-clock deadline, and supervisor polling
//!   of the execution's cgroup (process count and resident memory).
//! * **Supervision**: every execution runs in its own cgroup v2 directory
//!   (membership tracking and `cgroup.kill`), and bwrap + PDEATHSIG tear the
//!   PID namespace down if the supervisor dies.
//!
//! Honest limits: the seccomp filter is a deny-list (weaker than an
//! allow-list); memory is enforced by `RLIMIT_AS` per process plus polling
//! (not kernel `memory.max`) unless the cgroup memory controller is
//! delegated; CPU is bounded by `RLIMIT_CPU` and wall clock, not throttled;
//! kernel vulnerabilities in the shared kernel are out of scope.

use crate::result::{ToolError, ToolErrorCode};
use std::collections::BTreeMap;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const SANDBOX_VERSION: u32 = 1;
const BWRAP: &str = "/usr/bin/bwrap";
const PRLIMIT: &str = "/usr/bin/prlimit";

/// How aggregate memory / process-count limits are enforced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResourceBackend {
    /// Kernel cgroup limits via a transient systemd user scope when the
    /// host provides them, otherwise rlimit + supervisor polling
    /// (explicitly labelled, NOT equivalent).
    #[default]
    Auto,
    /// Require kernel-enforced limits; refuse otherwise.
    KernelScope,
    /// Force rlimit + polling (offline testing only).
    Polling,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxLimits {
    pub backend: ResourceBackend,
    pub wall_ms: u64,
    pub cpu_secs: u64,
    /// Resident-memory ceiling for the whole execution (polled).
    pub memory_bytes: u64,
    /// Per-process address-space ceiling (RLIMIT_AS).
    pub address_space_bytes: u64,
    pub max_procs: u64,
    pub max_fsize_bytes: u64,
    pub max_open_files: u64,
    pub scratch_bytes: u64,
    pub tmp_bytes: u64,
    pub stdout_cap: usize,
    pub stderr_cap: usize,
}

impl Default for SandboxLimits {
    fn default() -> Self {
        Self {
            backend: ResourceBackend::Auto,
            wall_ms: 120_000,
            cpu_secs: 120,
            memory_bytes: 2 * 1024 * 1024 * 1024,
            address_space_bytes: 8 * 1024 * 1024 * 1024,
            max_procs: 256,
            max_fsize_bytes: 256 * 1024 * 1024,
            max_open_files: 1024,
            scratch_bytes: 512 * 1024 * 1024,
            tmp_bytes: 64 * 1024 * 1024,
            stdout_cap: 256 * 1024,
            stderr_cap: 256 * 1024,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SandboxSpec {
    /// Unique execution id (also names the cgroup).
    pub id: String,
    /// Absolute path of the program *inside* the sandbox.
    pub program: String,
    pub args: Vec<String>,
    /// Host directory with the staged snapshot; mounted read-only at
    /// `/work/src`.
    pub src_dir: PathBuf,
    /// Working directory inside the sandbox.
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    /// Extra read-only bind mounts `(host path, sandbox path)`.
    pub ro_binds: Vec<(PathBuf, String)>,
    /// Extra READ-WRITE bind mounts: project-scoped environment directories only
    /// (dependency installs, build caches). Never the workspace or the host.
    pub rw_binds: Vec<(PathBuf, String)>,
    /// The staged snapshot is a private per-execution copy; when true it is mounted
    /// writable so build tools can write their output next to the sources. Whatever is
    /// written there is discarded with the execution (there is no write-back).
    pub src_writable: bool,
    /// In-place mode (`FsScope::Workspace`): the supervisor's descriptor of the VERIFIED directory that
    /// is bound read-write at `/work/src` with `--bind-fd`. The descriptor is the object, so a path that is
    /// renamed or replaced after the check cannot change what is mounted. `src_dir` is ignored then.
    pub pinned_root: Option<std::os::fd::RawFd>,
    /// Sub-paths of the pinned root that are read-only or hidden (only entries that exist: masking an
    /// absent name would create it in the project). Read-only entries carry a descriptor opened
    /// descriptor-relatively with `O_NOFOLLOW`.
    pub protect: Vec<Protect>,
    /// Share the host network namespace (dependency installation only). Everything else
    /// runs in a fresh, empty network namespace.
    pub net: bool,
    pub limits: SandboxLimits,
    /// Host cgroup directory under which the execution cgroup is created.
    pub cgroup_base: PathBuf,
    /// M3C: run the command behind the in-sandbox launch gate (verification + Landlock). In-place only;
    /// Scratch runs keep their historical argv and digest.
    pub confine: Option<ConfineSpec>,
}

/// The launch gate of an in-place execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfineSpec {
    /// Host path of `nexus-confine` (mounted read-only at `confine::SANDBOX_PATH`).
    pub shim: PathBuf,
    pub shim_sha256: String,
    /// `(dev, ino)` of the verified workspace directory.
    pub root: (u64, u64),
    pub min_abi: u32,
    /// The command shares the host network namespace: abstract sockets and signals must be scoped.
    pub require_scope: bool,
}

impl ConfineSpec {
    /// The launch-gate plan for `spec`: what the namespace must look like and what Landlock grants.
    pub fn plan(&self, spec: &SandboxSpec) -> crate::confine::Plan {
        use crate::confine::{Expect, Plan};
        let mut ro: Vec<String> = vec!["/usr".into(), "/proc".into(), "/nexus".into()];
        if spec.net {
            ro.extend(
                NET_FILES
                    .iter()
                    .filter(|f| Path::new(f).exists())
                    .map(|f| (*f).to_owned()),
            );
        }
        ro.extend(spec.ro_binds.iter().map(|(_, s)| s.clone()));
        let mut rw: Vec<String> = vec!["/work/src".into(), "/work/out".into(), "/tmp".into()];
        rw.extend(spec.rw_binds.iter().map(|(_, s)| s.clone()));
        let expect = spec
            .protect
            .iter()
            .map(|p| match p.mode {
                crate::exec_contract::ProtectMode::HideFile => Expect::HiddenFile(p.rel.clone()),
                crate::exec_contract::ProtectMode::HideDir => Expect::HiddenDir(p.rel.clone()),
                crate::exec_contract::ProtectMode::ReadOnly => {
                    Expect::ReadOnly(p.rel.clone(), p.ino)
                }
            })
            .collect();
        Plan {
            ro,
            rw,
            dev: vec!["/dev".into()],
            min_abi: self.min_abi,
            require_scope: self.require_scope,
            root: Some(self.root),
            expect,
        }
    }
}

const NET_FILES: [&str; 6] = [
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/pki",
];

/// One protected sub-path of a pinned root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Protect {
    /// Root-relative path, normalized, no `..`.
    pub rel: String,
    pub mode: crate::exec_contract::ProtectMode,
    /// Required for `ReadOnly`: an `O_PATH` descriptor of the exact entry.
    pub fd: Option<std::os::fd::RawFd>,
    /// Inode of the entry a `ReadOnly` descriptor refers to (verified inside the sandbox before the command).
    pub ino: u64,
}

/// First descriptor number inside the supervisor's child for in-place mounts (3 is the seccomp program).
const FIRST_MOUNT_FD: i32 = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    Cancelled,
    Revoked(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitKind {
    Exited(i32),
    Signaled(i32),
    Timeout,
    MemoryLimit,
    ProcessLimit,
    Cancelled,
    Revoked(String),
}

impl ExitKind {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Exited(_) => "exited",
            Self::Signaled(_) => "signaled",
            Self::Timeout => "timeout",
            Self::MemoryLimit => "memory-limit",
            Self::ProcessLimit => "process-limit",
            Self::Cancelled => "cancelled",
            Self::Revoked(_) => "revoked",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SandboxOutcome {
    pub exit: ExitKind,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub wall_ms: u64,
    pub user_ms: u64,
    pub sys_ms: u64,
    pub max_rss_kb: u64,
    /// Inside the PID namespace bwrap (init) reports a signalled program as
    /// exit code 128+signal; this is that signal when the code is in range.
    pub signal_hint: Option<i32>,
    pub peak_rss_bytes: u64,
    pub peak_procs: u64,
    pub cgroup: String,
    /// `kernel-cgroup` (memory.max/pids.max enforced by the kernel) or
    /// `rlimit-polling` (per-process rlimits + 50 ms supervisor polling).
    pub resource_enforcement: &'static str,
    pub oom_killed: bool,
    pub pids_limit_hit: bool,
}

/// Callbacks from the supervisor (called from the supervising thread).
pub trait SandboxControl {
    /// Polled at <= 100 ms: authoritative fence / cancellation.
    fn should_stop(&mut self) -> Option<StopReason>;
    /// Called once, right after the process was spawned.
    fn on_spawned(&mut self, pid: u32, cgroup: &str) -> Result<(), ToolError>;
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCapabilities {
    pub available: bool,
    pub problems: Vec<String>,
    pub bwrap_version: Option<String>,
    pub cgroup_base: Option<String>,
    pub cgroup_memory_controller: bool,
    /// Aggregate memory/pids limits are enforced by the kernel (systemd
    /// user scope with MemoryMax/TasksMax). False => polling only.
    pub kernel_enforced_limits: bool,
    pub seccomp: bool,
    pub backend: &'static str,
    /// Landlock ABI of the kernel (None = unavailable) and whether the launch gate was found: both are needed
    /// for in-place (Workspace) execution.
    pub landlock_abi: Option<u32>,
    pub launch_gate: bool,
}

fn refuse(msg: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::SandboxUnavailable, msg)
}

pub fn cgroup_base() -> Option<PathBuf> {
    let raw = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let line = raw.lines().find(|l| l.starts_with("0::"))?;
    let rel = line.trim_start_matches("0::");
    let p = PathBuf::from("/sys/fs/cgroup").join(rel.trim_start_matches('/'));
    p.is_dir().then_some(p)
}

/// Leaf directory name used for an execution's cgroup and run directory.
pub fn cgroup_leaf_name(id: &str) -> String {
    format!("nexus-exec-{}", secure_name(id))
}

fn secure_name(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(40)
        .collect()
}

// ------------------------------------------------------------- seccomp

/// x86_64 syscall numbers denied with EPERM.
#[cfg(target_arch = "x86_64")]
const DENY_EPERM: &[u32] = &[
    101, // ptrace
    165, // mount
    166, // umount2
    155, // pivot_root
    161, // chroot
    308, // setns
    272, // unshare
    246, // kexec_load
    320, // kexec_file_load
    175, // init_module
    313, // finit_module
    176, // delete_module
    321, // bpf
    248, // add_key
    249, // request_key
    250, // keyctl
    298, // perf_event_open
    323, // userfaultfd
    425, // io_uring_setup
    426, // io_uring_enter
    427, // io_uring_register
    167, // swapon
    168, // swapoff
    169, // reboot
    163, // acct
    179, // quotactl
    164, // settimeofday
    227, // clock_settime
    159, // adjtimex
    305, // clock_adjtime
    304, // open_by_handle_at
    303, // name_to_handle_at
    310, // process_vm_readv
    311, // process_vm_writev
    312, // kcmp
    103, // syslog
    172, // iopl
    173, // ioperm
    135, // personality
    153, // vhangup
    428, // open_tree
    429, // move_mount
    430, // fsopen
    431, // fsconfig
    432, // fsmount
    433, // fspick
    442, // mount_setattr
];

/// Build the raw `struct sock_filter[]` for bwrap `--seccomp FD`.
#[cfg(target_arch = "x86_64")]
pub fn seccomp_program() -> Vec<u8> {
    const BPF_LD_W_ABS: u16 = 0x20;
    const BPF_JEQ_K: u16 = 0x15;
    const BPF_JGE_K: u16 = 0x35;
    const BPF_RET_K: u16 = 0x06;
    const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    let mut ins: Vec<(u16, u8, u8, u32)> = vec![
        (BPF_LD_W_ABS, 0, 0, 4), // arch
        (BPF_JEQ_K, 1, 0, AUDIT_ARCH_X86_64),
        (BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
        (BPF_LD_W_ABS, 0, 0, 0), // nr
    ];
    // x32 ABI: syscalls with bit 30 set arrive with AUDIT_ARCH_X86_64 and
    // would bypass a plain number match. Kill them outright.
    ins.push((BPF_JGE_K, 0, 1, 0x4000_0000)); // nr >= 0x40000000 ?
    ins.push((BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS));
    // Layout: [JEQ deny...][JEQ clone3][ALLOW][ERRNO EPERM][ERRNO ENOSYS]
    let n = DENY_EPERM.len();
    let total_jeq = n + 1;
    let first = ins.len();
    let allow_idx = first + total_jeq;
    let eperm_idx = allow_idx + 1;
    let enosys_idx = allow_idx + 2;
    for (i, nr) in DENY_EPERM.iter().enumerate() {
        let here = first + i;
        ins.push((BPF_JEQ_K, (eperm_idx - here - 1) as u8, 0, *nr));
    }
    let here = first + n;
    ins.push((BPF_JEQ_K, (enosys_idx - here - 1) as u8, 0, 435)); // clone3
    ins.push((BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
    ins.push((BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | 1)); // EPERM
    ins.push((BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | 38)); // ENOSYS
    let mut out = Vec::with_capacity(ins.len() * 8);
    for (code, jt, jf, k) in ins {
        out.extend_from_slice(&code.to_ne_bytes());
        out.push(jt);
        out.push(jf);
        out.extend_from_slice(&k.to_ne_bytes());
    }
    out
}

#[cfg(not(target_arch = "x86_64"))]
pub fn seccomp_program() -> Vec<u8> {
    Vec::new()
}

fn seccomp_fd() -> Result<std::os::fd::OwnedFd, ToolError> {
    let prog = seccomp_program();
    if prog.is_empty() {
        return Err(refuse(
            "no seccomp filter for this architecture; sandbox unavailable",
        ));
    }
    let name = std::ffi::CString::new("nexus-seccomp").unwrap();
    let fd = unsafe { libc::memfd_create(name.as_ptr(), 0) };
    if fd < 0 {
        return Err(refuse("memfd_create failed"));
    }
    let owned = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
    let n = unsafe { libc::write(fd, prog.as_ptr().cast(), prog.len()) };
    if n < 0 || n as usize != prog.len() {
        return Err(refuse("seccomp program write failed"));
    }
    unsafe { libc::lseek(fd, 0, libc::SEEK_SET) };
    Ok(owned)
}

// ----------------------------------------------------------- argv build

/// The exact bwrap argv for a spec (also hashed into the sandbox digest).
pub fn bwrap_argv(spec: &SandboxSpec) -> Vec<String> {
    let l = &spec.limits;
    let mut a: Vec<String> = Vec::new();
    let mut push = |s: &str| a.push(s.to_owned());
    for f in [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--disable-userns",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
    ] {
        push(f);
    }
    if !spec.net {
        push("--unshare-net");
    }
    push("--hostname");
    push("nexus-sandbox");
    push("--cap-drop");
    push("ALL");
    push("--seccomp");
    push("3");
    push("--ro-bind");
    push("/usr");
    push("/usr");
    for (l1, l2) in [
        ("usr/bin", "/bin"),
        ("usr/sbin", "/sbin"),
        ("usr/lib", "/lib"),
        ("usr/lib64", "/lib64"),
    ] {
        push("--symlink");
        push(l1);
        push(l2);
    }
    push("--proc");
    push("/proc");
    push("--dev");
    push("/dev");
    push("--size");
    a.push(l.tmp_bytes.to_string());
    a.push("--tmpfs".to_owned());
    a.push("/tmp".to_owned());
    a.push("--size".to_owned());
    a.push(l.scratch_bytes.to_string());
    a.push("--tmpfs".to_owned());
    a.push("/work/out".to_owned());
    if spec.pinned_root.is_some() {
        // In-place: the verified directory object itself (descriptor slot FIRST_MOUNT_FD).
        a.push("--bind-fd".to_owned());
        a.push(FIRST_MOUNT_FD.to_string());
        a.push("/work/src".to_owned());
        let mut slot = FIRST_MOUNT_FD + 1;
        for p in &spec.protect {
            let dest = format!("/work/src/{}", p.rel);
            match p.mode {
                crate::exec_contract::ProtectMode::ReadOnly => {
                    a.push("--ro-bind-fd".to_owned());
                    a.push(slot.to_string());
                    a.push(dest);
                    slot += 1;
                }
                crate::exec_contract::ProtectMode::HideFile => {
                    a.push("--ro-bind".to_owned());
                    a.push("/dev/null".to_owned());
                    a.push(dest);
                }
                crate::exec_contract::ProtectMode::HideDir => {
                    a.push("--tmpfs".to_owned());
                    a.push(dest);
                }
            }
        }
    } else {
        a.push(
            if spec.src_writable {
                "--bind"
            } else {
                "--ro-bind"
            }
            .to_owned(),
        );
        a.push(spec.src_dir.to_string_lossy().into_owned());
        a.push("/work/src".to_owned());
    }
    if spec.net {
        // name resolution and TLS trust only; no other host configuration
        for f in NET_FILES {
            if std::path::Path::new(f).exists() {
                a.push("--ro-bind".to_owned());
                a.push(f.to_owned());
                a.push(f.to_owned());
            }
        }
    }
    for (h, s) in &spec.ro_binds {
        a.push("--ro-bind".to_owned());
        a.push(h.to_string_lossy().into_owned());
        a.push(s.clone());
    }
    for (h, s) in &spec.rw_binds {
        a.push("--bind".to_owned());
        a.push(h.to_string_lossy().into_owned());
        a.push(s.clone());
    }
    for (k, v) in &spec.env {
        a.push("--setenv".to_owned());
        a.push(k.clone());
        a.push(v.clone());
    }
    if let Some(c) = &spec.confine {
        a.push("--ro-bind".to_owned());
        a.push(c.shim.to_string_lossy().into_owned());
        a.push(crate::confine::SANDBOX_PATH.to_owned());
    }
    // The synthetic root itself becomes read-only: only /tmp and /work/out
    // (size-limited tmpfs mounts) remain writable.
    a.push("--remount-ro".to_owned());
    a.push("/dev".to_owned());
    a.push("--remount-ro".to_owned());
    a.push("/".to_owned());
    a.push("--chdir".to_owned());
    a.push(spec.cwd.clone());
    a.push("--".to_owned());
    if let Some(c) = &spec.confine {
        // the launch gate: verifies the namespace, applies Landlock, then executes what follows `--`
        a.push(crate::confine::SANDBOX_PATH.to_owned());
        a.extend(c.plan(spec).to_args());
    }
    a.push(PRLIMIT.to_owned());
    a.push(format!("--nproc={}", l.max_procs));
    a.push(format!("--cpu={}", l.cpu_secs));
    a.push(format!("--as={}", l.address_space_bytes));
    a.push(format!("--fsize={}", l.max_fsize_bytes));
    a.push(format!("--nofile={}", l.max_open_files));
    a.push("--core=0".to_owned());
    a.push("--".to_owned());
    a.push(spec.program.clone());
    a.extend(spec.args.iter().cloned());
    a
}

/// Digest of the complete sandbox configuration (bwrap argv + filter).
pub fn sandbox_digest(spec: &SandboxSpec) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(format!("nexus-sandbox/{SANDBOX_VERSION}\n").as_bytes());
    for a in bwrap_argv(spec) {
        h.update(a.as_bytes());
        h.update([0]);
    }
    h.update(seccomp_program());
    if let Some(c) = &spec.confine {
        h.update(b"confine\0");
        h.update(c.shim_sha256.as_bytes());
    }
    hex::encode(h.finalize())
}

// ------------------------------------------------- kernel-enforced limits

const SYSTEMD_RUN: &str = "/usr/bin/systemd-run";

fn systemd_env(cmd: &mut Command) {
    // Only systemd-run needs these; bwrap `--clearenv` removes them before
    // the sandboxed program starts.
    for k in ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
}

/// True when a transient systemd *user* scope can enforce `MemoryMax` and
/// `TasksMax` (verified by observing `memory.max`/`pids.max` from inside).
pub fn kernel_limits_available() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        if !Path::new(SYSTEMD_RUN).exists() {
            return false;
        }
        let mut c = Command::new(SYSTEMD_RUN);
        c.env_clear().args([
            "--user", "--scope", "--collect", "--quiet", "-p", "MemoryMax=64M", "-p",
            "MemorySwapMax=0", "-p", "TasksMax=9", "--", "/usr/bin/sh", "-c",
            "p=/sys/fs/cgroup$(sed 's/0:://' /proc/self/cgroup); test \"$(cat $p/pids.max)\" = 9 && test \"$(cat $p/memory.max)\" = 67108864",
        ]);
        systemd_env(&mut c);
        c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        c.status().map(|s| s.success()).unwrap_or(false)
    })
}

/// Where systemd will place the scope for `unit` (derived from the
/// daemon's own user-manager cgroup), for recovery before spawn.
pub fn expected_scope_path(unit: &str) -> Option<PathBuf> {
    let base = cgroup_base()?;
    let mut p = base.as_path();
    loop {
        let name = p.file_name()?.to_str()?;
        if name.starts_with("user@") && name.ends_with(".service") {
            return Some(p.join("app.slice").join(format!("{unit}.scope")));
        }
        p = p.parent()?;
    }
}

fn locate_scope_cgroup(pid: u32, unit: &str) -> Option<PathBuf> {
    let want = format!("{unit}.scope");
    for _ in 0..500 {
        if let Ok(raw) = std::fs::read_to_string(format!("/proc/{pid}/cgroup")) {
            if let Some(l) = raw.lines().find(|l| l.starts_with("0::")) {
                let rel = l.trim_start_matches("0::");
                if rel.ends_with(&want) {
                    return Some(PathBuf::from("/sys/fs/cgroup").join(rel.trim_start_matches('/')));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

fn read_event(path: &Path, key: &str) -> u64 {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .find_map(|l| {
            let mut it = l.split_whitespace();
            (it.next() == Some(key)).then(|| it.next().and_then(|v| v.parse().ok()))?
        })
        .unwrap_or(0)
}

// ------------------------------------------------------------- preflight

/// Probe the host for every mandatory primitive by actually running a
/// minimal sandbox. Cached by callers; cheap enough to re-run.
static PROBE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn preflight() -> SandboxCapabilities {
    let mut problems = Vec::new();
    let mut caps = SandboxCapabilities {
        available: false,
        problems: Vec::new(),
        bwrap_version: None,
        cgroup_base: None,
        cgroup_memory_controller: false,
        kernel_enforced_limits: false,
        seccomp: cfg!(target_arch = "x86_64"),
        backend: "bubblewrap+seccomp+cgroup-v2",
        landlock_abi: crate::confine::landlock_abi(),
        launch_gate: crate::confine_host::locate_shim().is_some(),
    };
    if !cfg!(target_arch = "x86_64") {
        problems.push("seccomp filter is implemented for x86_64 only".to_owned());
    }
    if !Path::new(BWRAP).exists() {
        problems.push(format!("{BWRAP} not found"));
    }
    if !Path::new(PRLIMIT).exists() {
        problems.push(format!("{PRLIMIT} not found"));
    }
    if let Ok(o) = Command::new(BWRAP).arg("--version").output() {
        caps.bwrap_version = Some(String::from_utf8_lossy(&o.stdout).trim().to_owned());
    }
    match cgroup_base() {
        None => problems.push("cgroup v2 hierarchy not found".to_owned()),
        Some(base) => {
            caps.cgroup_base = Some(base.display().to_string());
            let probe = base.join(format!(
                "nexus-probe-{}-{}",
                std::process::id(),
                PROBE_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            ));
            match std::fs::create_dir(&probe) {
                Ok(()) => {
                    if !probe.join("cgroup.kill").exists() || !probe.join("cgroup.procs").exists() {
                        problems.push("cgroup.kill is unavailable (kernel < 5.14)".to_owned());
                    }
                    caps.cgroup_memory_controller = probe.join("memory.max").exists();
                    let _ = std::fs::remove_dir(&probe);
                }
                Err(e) => problems.push(format!("cannot create a cgroup: {e}")),
            }
        }
    }
    caps.kernel_enforced_limits = kernel_limits_available();
    if problems.is_empty() {
        // Functional probe: the full argv, a trivial program.
        let seq = PROBE_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("nexus-sbx-probe-{}-{seq}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let spec = SandboxSpec {
            id: format!("probe{}x{seq}", std::process::id()),
            program: "/usr/bin/true".to_owned(),
            args: vec![],
            src_dir: dir.clone(),
            cwd: "/work/src".to_owned(),
            env: BTreeMap::new(),
            ro_binds: vec![],
            rw_binds: vec![],
            src_writable: false,
            pinned_root: None,
            protect: Vec::new(),
            net: false,
            limits: SandboxLimits {
                wall_ms: 10_000,
                ..Default::default()
            },
            cgroup_base: cgroup_base().unwrap_or_default(),
            confine: None,
        };
        struct Never;
        impl SandboxControl for Never {
            fn should_stop(&mut self) -> Option<StopReason> {
                None
            }
            fn on_spawned(&mut self, _: u32, _: &str) -> Result<(), ToolError> {
                Ok(())
            }
        }
        match run_sandboxed(&spec, &mut Never) {
            Ok(o) if o.exit == ExitKind::Exited(0) => {}
            Ok(o) => problems.push(format!(
                "functional probe failed: {:?} {}",
                o.exit,
                String::from_utf8_lossy(&o.stderr)
                    .chars()
                    .take(200)
                    .collect::<String>()
            )),
            Err(e) => problems.push(format!("functional probe failed: {e}")),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    caps.available = problems.is_empty();
    caps.problems = problems;
    caps
}

// ---------------------------------------------------------------- run

fn read_cgroup_pids(cg: &Path) -> Vec<u32> {
    std::fs::read_to_string(cg.join("cgroup.procs"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect()
}

fn rss_bytes(pid: u32) -> u64 {
    let s = std::fs::read_to_string(format!("/proc/{pid}/statm")).unwrap_or_default();
    let pages: u64 = s
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    pages * 4096
}

/// Kill every process in a cgroup directory and remove it when empty.
/// Returns true when the cgroup is gone / empty.
pub fn kill_and_remove_cgroup(cg: &Path) -> bool {
    if !cg.exists() {
        return true;
    }
    let _ = std::fs::write(cg.join("cgroup.kill"), "1");
    for _ in 0..100 {
        if read_cgroup_pids(cg).is_empty() {
            return std::fs::remove_dir(cg).is_ok() || !cg.exists();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn spawn_reader<R: Read + Send + 'static>(
    mut r: R,
    cap: usize,
) -> std::thread::JoinHandle<(Vec<u8>, u64)> {
    std::thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut total = 0u64;
        let mut buf = [0u8; 16 * 1024];
        loop {
            match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    total += n as u64;
                    // Bounded buffering: keep only up to `cap`, keep
                    // draining so the child never blocks on a full pipe.
                    if kept.len() < cap {
                        let take = (cap - kept.len()).min(n);
                        kept.extend_from_slice(&buf[..take]);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        (kept, total)
    })
}

/// Longest excerpt of a helper's stderr kept in a refusal message.
const DIAGNOSTIC_MAX: usize = 300;

/// A bounded, printable, secret-redacted excerpt of helper output for an error message
/// (EM-04C2 S0). Control characters become spaces and runs of whitespace collapse; a value after
/// `token`/`secret`/`password`/`passwd`/`credential`/`apikey`/`api_key`/`authorization`/`bearer` and any
/// 24+ character run of base64/hex-like characters containing a digit is replaced by `<redacted>`.
pub fn sanitize_diagnostic(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut words: Vec<String> = Vec::new();
    let mut redact_next = false;
    for w in flat.split_whitespace() {
        let lower = w.to_ascii_lowercase();
        let keyed = [
            "token",
            "secret",
            "password",
            "passwd",
            "credential",
            "apikey",
            "api_key",
            "authorization",
            "bearer",
        ]
        .iter()
        .any(|k| lower.contains(k));
        let long_blob = w.len() >= 24
            && w.chars().any(|c| c.is_ascii_digit())
            && w.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-'));
        if redact_next {
            words.push("<redacted>".to_owned());
            redact_next = false;
        } else if keyed {
            // `name=value` and `name: value` both lose the value
            match w.split_once(['=', ':']) {
                Some((k, v)) if !v.is_empty() => words.push(format!("{k}=<redacted>")),
                _ => {
                    words.push(w.to_owned());
                    redact_next = true;
                }
            }
        } else if long_blob {
            words.push("<redacted>".to_owned());
        } else {
            words.push(w.to_owned());
        }
    }
    let joined = words.join(" ");
    joined.chars().take(DIAGNOSTIC_MAX).collect()
}

/// `"; systemd-run said: <excerpt>"` from a reader thread of the failed launcher, or the empty
/// string. Never blocks: a thread still reading after a short grace (a surviving grandchild holds
/// the pipe) is abandoned.
fn diagnostic_from(h: Option<std::thread::JoinHandle<(Vec<u8>, u64)>>) -> String {
    let Some(h) = h else { return String::new() };
    let until = Instant::now() + Duration::from_millis(300);
    while !h.is_finished() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !h.is_finished() {
        return String::new();
    }
    match h.join() {
        Ok((bytes, _)) => {
            let s = sanitize_diagnostic(&bytes);
            if s.is_empty() {
                String::new()
            } else {
                format!("; systemd-run said: {s}")
            }
        }
        Err(_) => String::new(),
    }
}

/// Run one program in the sandbox and supervise it to completion.
pub fn run_sandboxed(
    spec: &SandboxSpec,
    control: &mut dyn SandboxControl,
) -> Result<SandboxOutcome, ToolError> {
    if !cfg!(target_arch = "x86_64") {
        return Err(refuse("sandbox is implemented for x86_64 only"));
    }
    if !Path::new(BWRAP).exists() || !Path::new(PRLIMIT).exists() {
        return Err(refuse("bubblewrap/prlimit not found; refusing to run"));
    }
    if !spec.program.starts_with('/') {
        return Err(refuse("program must be an absolute in-sandbox path"));
    }
    if let Some(c) = &spec.confine {
        // Fail closed: the gate must exist, be ours and match the digest that was recorded.
        match crate::confine_host::shim_is_trustworthy(&c.shim) {
            Ok(sha) if sha == c.shim_sha256 => {}
            Ok(_) => {
                return Err(refuse(
                    "the launch gate changed after it was recorded; refusing to run",
                ))
            }
            Err(e) => return Err(refuse(format!("{e}; refusing to run"))),
        }
        if spec.pinned_root.is_none() {
            return Err(refuse("the launch gate needs a pinned workspace root"));
        }
    }
    if spec.pinned_root.is_none() && !spec.src_dir.is_dir() {
        return Err(refuse("staged snapshot directory is missing"));
    }
    // Descriptors handed to bubblewrap: the pinned root, then each read-only protected entry. They are
    // duplicated above any number the child setup uses, then placed in fixed slots before exec.
    let mut mount_srcs: Vec<std::os::fd::RawFd> = Vec::new();
    if let Some(r) = spec.pinned_root {
        mount_srcs.push(r);
        for p in &spec.protect {
            if p.mode == crate::exec_contract::ProtectMode::ReadOnly {
                match p.fd {
                    Some(f) => mount_srcs.push(f),
                    None => return Err(refuse("a read-only protected entry has no descriptor")),
                }
            }
        }
    } else if !spec.protect.is_empty() {
        return Err(refuse("protected entries need a pinned root"));
    }
    let mut mount_dups: Vec<std::os::fd::OwnedFd> = Vec::new();
    for f in &mount_srcs {
        let d = unsafe { libc::fcntl(*f, libc::F_DUPFD, 100) };
        if d < 0 {
            return Err(refuse("cannot duplicate a mount descriptor"));
        }
        mount_dups.push(unsafe { std::os::fd::OwnedFd::from_raw_fd(d) });
    }
    let mount_slots: Vec<(i32, i32)> = mount_dups
        .iter()
        .enumerate()
        .map(|(i, d)| (d.as_raw_fd(), FIRST_MOUNT_FD + i as i32))
        .collect();
    let first_free_fd: u32 = (FIRST_MOUNT_FD as u32) + mount_slots.len() as u32;
    let kernel_mode = match spec.limits.backend {
        ResourceBackend::Polling => false,
        ResourceBackend::KernelScope => {
            if !kernel_limits_available() {
                return Err(refuse(
                    "kernel-enforced resource limits are required but unavailable (nothing was run)",
                ));
            }
            true
        }
        ResourceBackend::Auto => kernel_limits_available(),
    };
    let unit = cgroup_leaf_name(&spec.id);
    // Polling mode creates (and joins) its own cgroup directory; kernel mode
    // lets systemd create the scope and we locate it after spawn.
    let own_cg = spec.cgroup_base.join(&unit);
    if !kernel_mode {
        std::fs::create_dir(&own_cg)
            .map_err(|e| refuse(format!("cannot create execution cgroup: {e}")))?;
    }
    let filter = match seccomp_fd() {
        Ok(f) => f,
        Err(e) => {
            if !kernel_mode {
                let _ = std::fs::remove_dir(&own_cg);
            }
            return Err(e);
        }
    };
    let filter_raw = filter.as_raw_fd();
    let procs_path =
        std::ffi::CString::new(own_cg.join("cgroup.procs").to_string_lossy().as_bytes())
            .map_err(|_| refuse("cgroup path contains NUL"))?;

    let l = &spec.limits;
    let mut cmd = if kernel_mode {
        let mut c = Command::new(SYSTEMD_RUN);
        c.env_clear();
        systemd_env(&mut c);
        // The aggregate bound covers resident memory AND the size-capped
        // tmpfs mounts (tmpfs pages are charged to the cgroup).
        let mem_max = l
            .memory_bytes
            .saturating_add(l.scratch_bytes)
            .saturating_add(l.tmp_bytes);
        c.args([
            "--user".to_owned(),
            "--scope".to_owned(),
            "--collect".to_owned(),
            "--quiet".to_owned(),
            format!("--unit={unit}"),
            "-p".to_owned(),
            format!("MemoryMax={mem_max}"),
            "-p".to_owned(),
            "MemorySwapMax=0".to_owned(),
            "-p".to_owned(),
            format!("TasksMax={}", l.max_procs + 16),
            "--".to_owned(),
            BWRAP.to_owned(),
        ]);
        c.args(bwrap_argv(spec));
        c
    } else {
        let mut c = Command::new(BWRAP);
        c.args(bwrap_argv(spec)).env_clear();
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        cmd.pre_exec(move || {
            // fd 3 = seccomp program; (polling mode) join the execution
            // cgroup; close every other inherited descriptor; die with the
            // supervisor.
            if filter_raw != 3 && libc::dup2(filter_raw, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if !kernel_mode {
                let fd = libc::open(procs_path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                if fd < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let zero = b"0";
                let w = libc::write(fd, zero.as_ptr().cast(), 1);
                libc::close(fd);
                if w != 1 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            for (src, slot) in &mount_slots {
                if libc::dup2(*src, *slot) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            libc::syscall(libc::SYS_close_range, first_free_fd, u32::MAX, 0u32);
            libc::prctl(
                libc::PR_SET_PDEATHSIG,
                libc::SIGKILL as libc::c_ulong,
                0,
                0,
                0,
            );
            Ok(())
        });
    }
    let started = Instant::now();
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            if !kernel_mode {
                let _ = std::fs::remove_dir(&own_cg);
            }
            return Err(refuse(format!("sandbox spawn failed: {e}")));
        }
    };
    drop(filter);
    drop(mount_dups);
    let pid = child.id();
    let out_h = child
        .stdout
        .take()
        .map(|s| spawn_reader(s, spec.limits.stdout_cap));
    let err_h = child
        .stderr
        .take()
        .map(|s| spawn_reader(s, spec.limits.stderr_cap));

    let cg: PathBuf = if kernel_mode {
        match locate_scope_cgroup(pid, &unit) {
            Some(p) => p,
            None => {
                unsafe { libc::kill(pid as i32, libc::SIGKILL) };
                let mut st = 0;
                unsafe { libc::waitpid(pid as i32, &mut st, 0) };
                // EM-04C2 S0: say WHY. What `systemd-run` printed is the only evidence of a
                // transient user-manager problem; it is bounded, stripped of control characters
                // and of anything that looks like a secret, and never contains the environment
                // (the command ran with a cleared one). The refusal itself is unchanged:
                // nothing was run and there is no unsandboxed fallback.
                let said = diagnostic_from(err_h);
                return Err(refuse(format!(
                    "systemd scope was not created; kernel-enforced limits unavailable (nothing was run){said}"
                )));
            }
        }
    } else {
        own_cg.clone()
    };
    let cg_str = cg.display().to_string();
    let mut forced: Option<ExitKind> = None;
    if let Err(e) = control.on_spawned(pid, &cg_str) {
        let _ = std::fs::write(cg.join("cgroup.kill"), "1");
        forced = Some(ExitKind::Revoked(e.message));
    }
    let deadline = started + Duration::from_millis(l.wall_ms);
    let poll_every = Duration::from_millis(if kernel_mode { 20 } else { 50 });
    let mut peak_rss = 0u64;
    let mut peak_procs = 0u64;
    let mut oom_seen = 0u64;
    let mut pids_hit = 0u64;
    let mut last_poll = Instant::now() - Duration::from_secs(1);
    let mut status: libc::c_int = 0;
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    loop {
        let r = unsafe { libc::wait4(pid as i32, &mut status, libc::WNOHANG, &mut ru) };
        if r == pid as i32 {
            break;
        }
        if r < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::Interrupted {
                break;
            }
        }
        if last_poll.elapsed() >= poll_every {
            last_poll = Instant::now();
            let pids = read_cgroup_pids(&cg);
            peak_procs = peak_procs.max(pids.len() as u64);
            if kernel_mode {
                // Kernel-maintained accounting (survives until the scope
                // is collected).
                let peak: u64 = std::fs::read_to_string(cg.join("memory.peak"))
                    .ok()
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                peak_rss = peak_rss.max(peak);
                oom_seen = oom_seen.max(read_event(&cg.join("memory.events"), "oom_kill"));
                pids_hit = pids_hit.max(read_event(&cg.join("pids.events"), "max"));
            } else {
                let rss: u64 = pids.iter().map(|p| rss_bytes(*p)).sum();
                peak_rss = peak_rss.max(rss);
                if forced.is_none() && rss > l.memory_bytes {
                    forced = Some(ExitKind::MemoryLimit);
                } else if forced.is_none() && pids.len() as u64 > l.max_procs + 8 {
                    forced = Some(ExitKind::ProcessLimit);
                }
            }
            if forced.is_none() {
                if Instant::now() >= deadline {
                    forced = Some(ExitKind::Timeout);
                } else if let Some(stop) = control.should_stop() {
                    forced = Some(match stop {
                        StopReason::Cancelled => ExitKind::Cancelled,
                        StopReason::Revoked(m) => ExitKind::Revoked(m),
                    });
                }
            }
            if forced.is_some() {
                let _ = std::fs::write(cg.join("cgroup.kill"), "1");
                unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    // Whatever happened, make sure nothing from this execution survives.
    oom_seen = oom_seen.max(read_event(&cg.join("memory.events"), "oom_kill"));
    pids_hit = pids_hit.max(read_event(&cg.join("pids.events"), "max"));
    let _ = std::fs::write(cg.join("cgroup.kill"), "1");
    let (stdout, stdout_bytes) = out_h
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();
    let (stderr, stderr_bytes) = err_h
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();
    let cleaned = if kernel_mode {
        // systemd collects the scope when it is empty.
        let mut ok = false;
        for _ in 0..200 {
            if !cg.exists() || read_cgroup_pids(&cg).is_empty() {
                ok = true;
                break;
            }
            let _ = std::fs::write(cg.join("cgroup.kill"), "1");
            std::thread::sleep(Duration::from_millis(10));
        }
        ok
    } else {
        kill_and_remove_cgroup(&cg)
    };
    let exit = match forced {
        Some(f) => f,
        None => {
            if oom_seen > 0 {
                ExitKind::MemoryLimit
            } else if libc::WIFEXITED(status) {
                ExitKind::Exited(libc::WEXITSTATUS(status))
            } else if libc::WIFSIGNALED(status) {
                ExitKind::Signaled(libc::WTERMSIG(status))
            } else {
                ExitKind::Signaled(0)
            }
        }
    };
    if !cleaned {
        return Err(ToolError::new(
            ToolErrorCode::SandboxUnavailable,
            "execution cgroup could not be emptied; leaving it for reconciliation",
        ));
    }
    if spec.confine.is_some() {
        if let ExitKind::Exited(c) = &exit {
            let said = String::from_utf8_lossy(&stderr);
            if *c == crate::confine::REFUSED_EXIT
                && said.starts_with(crate::confine::REFUSED_PREFIX)
            {
                let why = said
                    .trim_start_matches(crate::confine::REFUSED_PREFIX)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                return Err(ToolError::new(
                    ToolErrorCode::SandboxUnavailable,
                    format!("confinement refused: {why}; nothing was run and no weaker backend was used"),
                ));
            }
        }
    }
    let tv = |t: libc::timeval| (t.tv_sec as u64) * 1000 + (t.tv_usec as u64) / 1000;
    let hint = match &exit {
        ExitKind::Exited(c) if (129..=192).contains(c) => Some(c - 128),
        ExitKind::Signaled(s) => Some(*s),
        _ => None,
    };
    Ok(SandboxOutcome {
        exit,
        stdout_truncated: stdout_bytes as usize > l.stdout_cap,
        stderr_truncated: stderr_bytes as usize > l.stderr_cap,
        stdout,
        stderr,
        stdout_bytes,
        stderr_bytes,
        wall_ms: started.elapsed().as_millis() as u64,
        user_ms: tv(ru.ru_utime),
        sys_ms: tv(ru.ru_stime),
        max_rss_kb: ru.ru_maxrss.max(0) as u64,
        signal_hint: hint,
        peak_rss_bytes: peak_rss,
        peak_procs,
        cgroup: cg_str,
        resource_enforcement: if kernel_mode {
            "kernel-cgroup"
        } else {
            "rlimit-polling"
        },
        oom_killed: oom_seen > 0,
        pids_limit_hit: pids_hit > 0,
    })
}

#[cfg(test)]
mod diagnostics_tests {
    use super::*;

    #[test]
    fn a_diagnostic_is_bounded_printable_and_has_no_secrets() {
        let raw =
            b"Failed to start transient scope unit: Connection timed out\n\x1b[31mred\x1b[0m\0";
        let s = sanitize_diagnostic(raw);
        assert!(s.starts_with("Failed to start transient scope unit: Connection timed out"));
        assert!(!s.chars().any(|c| c.is_control()));
        // secrets: keyed values, bearer values and long opaque blobs
        let hostile = b"token=abc123 Authorization: Bearer sk-live-0123456789abcdef0123456789 password hunter2 \
                        XDG_RUNTIME_DIR=/run/user/1000 blob AAAAAAAAAAAAAAAAAAAAAAAAAAA1 ok";
        let s = sanitize_diagnostic(hostile);
        for leak in [
            "abc123",
            "sk-live",
            "0123456789abcdef",
            "hunter2",
            "AAAAAAAAAAAA",
        ] {
            assert!(!s.contains(leak), "{leak} leaked: {s}");
        }
        assert!(s.contains("<redacted>") && s.contains("ok"), "{s}");
        // bounded
        let big = vec![b'x'; 100_000];
        assert!(sanitize_diagnostic(&big).chars().count() <= DIAGNOSTIC_MAX);
        // empty and binary input are harmless
        assert_eq!(sanitize_diagnostic(b""), "");
        assert!(sanitize_diagnostic(&[0xff, 0xfe, 0x00])
            .chars()
            .all(|c| !c.is_control()));
    }

    #[test]
    fn the_refusal_text_keeps_its_stable_prefix_and_never_hangs() {
        // no reader: nothing is appended
        assert_eq!(diagnostic_from(None), "");
        // a finished reader is appended, redacted
        let h = std::thread::spawn(|| (b"boom token=XYZ".to_vec(), 14u64));
        let d = diagnostic_from(Some(h));
        assert_eq!(d, "; systemd-run said: boom token=<redacted>");
        // a reader that never finishes is abandoned within the grace period
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let h = std::thread::spawn(move || {
            let _ = rx.recv();
            (Vec::new(), 0u64)
        });
        let t = Instant::now();
        assert_eq!(diagnostic_from(Some(h)), "");
        assert!(t.elapsed() < Duration::from_secs(2));
        drop(tx);
    }
}
