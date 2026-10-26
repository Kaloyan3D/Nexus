//! A6.1.4 runtime supervisor (interactive profile).
//!
//! Opening Nexus must not mean running scripts. This crate owns the lifecycle of the
//! two native processes the Desktop needs, as the SAME unprivileged user:
//!
//! * `nexusd` (the Kernel daemon) with the automated workspace policy, and
//! * `nexus-broker` with the interactive profile (consent-derived authorization,
//!   project onboarding),
//!
//! plus the one-time provider connection. It never raises privilege, never touches
//! another user's state, and refuses a home directory that is not private to the
//! current user. OS peer-credential checks inside the daemon and broker are
//! unchanged: they still accept only this user's uid.

pub mod engine_choice;

use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const CRED_REF: &str = "credential://connections/conn-opencode-go-native";

/// The data home: every file Nexus owns for this user.
#[derive(Debug, Clone)]
pub struct Home {
    pub root: PathBuf,
}

impl Home {
    pub fn resolve() -> Result<Home, String> {
        if let Some(h) = std::env::var_os("NEXUS_HOME").filter(|v| !v.is_empty()) {
            return Ok(Home {
                root: PathBuf::from(h),
            });
        }
        let base = std::env::var_os("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .ok_or("no HOME or XDG_DATA_HOME: cannot choose a data directory")?;
        Ok(Home {
            root: base.join("nexus"),
        })
    }
    pub fn daemon_dir(&self) -> PathBuf {
        self.root.join("daemon")
    }
    pub fn daemon_socket(&self) -> PathBuf {
        self.daemon_dir().join("n.sock")
    }
    pub fn issuer_cap(&self) -> PathBuf {
        self.daemon_dir().join("issuer.cap")
    }
    /// The approver credential lives in its own private directory, apart from the issuer's and the
    /// daemon's. Only the trusted terminal approver reads it; the broker, the renderer and the model do not.
    pub fn approver_dir(&self) -> PathBuf {
        self.root.join("approver")
    }
    pub fn approver_cap(&self) -> PathBuf {
        self.approver_dir().join("approver.cap")
    }
    pub fn broker_dir(&self) -> PathBuf {
        self.root.join("broker")
    }
    pub fn broker_socket(&self) -> PathBuf {
        self.root.join("broker.sock")
    }
    pub fn registry_data(&self) -> PathBuf {
        self.root.join("registry")
    }
    pub fn projects_registry(&self) -> PathBuf {
        self.root.join("projects")
    }
    pub fn snapshots(&self) -> PathBuf {
        self.root.join("snapshots")
    }
    pub fn code_base(&self) -> PathBuf {
        self.root.join("code-base")
    }
    pub fn envs(&self) -> PathBuf {
        self.root.join("envs")
    }
    pub fn worktrees(&self) -> PathBuf {
        self.code_base().join("worktrees")
    }
    pub fn transcripts(&self) -> PathBuf {
        self.root.join("transcripts")
    }
    pub fn credentials(&self) -> PathBuf {
        self.root.join("credentials.json")
    }
    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub fn run_dir(&self) -> PathBuf {
        self.root.join("run")
    }
    fn state_file(&self) -> PathBuf {
        self.run_dir().join("runtime.json")
    }
    fn lock_file(&self) -> PathBuf {
        self.run_dir().join("supervisor.lock")
    }
}

/// Where the native binaries and the Registry/Controller scripts are.
#[derive(Debug, Clone)]
pub struct Tools {
    pub nexusd: PathBuf,
    pub broker: PathBuf,
    pub node: PathBuf,
    pub repo_root: PathBuf,
    /// The trusted terminal approver, when installed next to the other binaries (for the hint shown to the user).
    pub approver: Option<PathBuf>,
    /// The launch gate for in-place commands, from the same directory as `nexusd` (they are released together;
    /// the daemon checks that it speaks the protocol it needs). Absent = in-place commands are refused by the
    /// daemon with a message that names it.
    pub confine: Option<PathBuf>,
    /// The network gatekeeper for Controlled Internet, from the same directory. Absent = Controlled Internet is
    /// reported unavailable by the daemon (never replaced by direct networking).
    pub egress: Option<PathBuf>,
}

impl Tools {
    /// `NEXUS_BIN_DIR` or the directory of the running executable for the binaries;
    /// `NEXUS_REPO_ROOT` or an ancestor of the executable (or cwd) containing
    /// `config/registry/native-intent-bridge.cjs`; `node` from PATH.
    pub fn discover() -> Result<Tools, String> {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(Path::to_path_buf));
        let bin_dir = std::env::var_os("NEXUS_BIN_DIR")
            .map(PathBuf::from)
            .or(exe_dir.clone())
            .ok_or("cannot locate the Nexus binaries")?;
        let find = |name: &str| -> Result<PathBuf, String> {
            let p = bin_dir.join(name);
            if p.is_file() {
                return Ok(p);
            }
            // development layout: native/target/{debug,release}
            for anc in exe_dir.iter().flat_map(|d| d.ancestors()) {
                for prof in ["debug", "release"] {
                    let c = anc.join("native/target").join(prof).join(name);
                    if c.is_file() {
                        return Ok(c);
                    }
                }
            }
            Err(format!("{name} not found (set NEXUS_BIN_DIR)"))
        };
        let marker = "config/registry/native-intent-bridge.cjs";
        let repo_root = std::env::var_os("NEXUS_REPO_ROOT")
            .map(PathBuf::from)
            .filter(|r| r.join(marker).is_file())
            .or_else(|| {
                exe_dir
                    .iter()
                    .flat_map(|d| d.ancestors().map(Path::to_path_buf).collect::<Vec<_>>())
                    .chain(
                        std::env::current_dir()
                            .ok()
                            .iter()
                            .flat_map(|d| d.ancestors().map(Path::to_path_buf).collect::<Vec<_>>()),
                    )
                    .find(|a| a.join(marker).is_file())
            })
            .ok_or("the Registry/Controller bridge was not found (set NEXUS_REPO_ROOT)")?;
        let node = path_lookup("node").ok_or("node was not found on PATH")?;
        Ok(Tools {
            nexusd: find("nexusd")?,
            broker: find("nexus-broker")?,
            node,
            repo_root,
            approver: find("nexus-approver").ok(),
            confine: find("nexus-confine").ok(),
            egress: find("nexus-egress").ok(),
        })
    }
}

fn path_lookup(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")?
        .to_string_lossy()
        .split(':')
        .map(|d| Path::new(d).join(name))
        .find(|p| p.is_file())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// The home does not exist or was never set up.
    NotBootstrapped,
    Stopped,
    Ready,
    /// Something is running but not healthy (message says what).
    Degraded(String),
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    pub home: String,
    pub broker_socket: String,
    pub daemon_pid: Option<u32>,
    pub broker_pid: Option<u32>,
    /// A credential file exists and the Registry route was verified at connect time.
    pub provider_connected: bool,
    pub started_by_this_process: bool,
}

fn uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn private_dir(p: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::symlink_metadata(p) {
        Ok(m) => {
            if !m.is_dir() || m.file_type().is_symlink() {
                return Err(format!("{} is not a real directory", p.display()));
            }
            if m.uid() != uid() {
                return Err(format!("{} is not owned by you", p.display()));
            }
            if m.mode() & 0o077 != 0 {
                std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))
                    .map_err(|e| format!("cannot make {} private: {e}", p.display()))?;
            }
            Ok(())
        }
        Err(_) => std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(p)
            .map_err(|e| format!("cannot create {}: {e}", p.display())),
    }
}

/// Create the home layout (idempotent). Refuses a home that is not private to the user.
pub fn bootstrap(home: &Home) -> Result<(), String> {
    // every ancestor below the home itself is ours; the home must be too
    private_dir(&home.root)?;
    for d in [
        home.daemon_dir(),
        home.approver_dir(),
        home.broker_dir(),
        home.registry_data(),
        home.projects_registry(),
        home.snapshots(),
        home.envs(),
        home.code_base(),
        home.worktrees(),
        home.transcripts(),
        home.logs(),
        home.run_dir(),
    ] {
        private_dir(&d)?;
    }
    Ok(())
}

fn read_pids(home: &Home) -> (Option<u32>, Option<u32>, bool) {
    let v: serde_json::Value = std::fs::read_to_string(home.state_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    (
        v["daemonPid"].as_u64().map(|p| p as u32),
        v["brokerPid"].as_u64().map(|p| p as u32),
        v["supervisorPid"].as_u64() == Some(std::process::id() as u64),
    )
}

/// True when `pid` is alive and its command line names this home (never signal or trust
/// an unrelated process that reused the pid).
fn pid_is_ours(pid: u32, home: &Home) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|b| {
            String::from_utf8_lossy(&b)
                .replace('\0', " ")
                .contains(&home.root.to_string_lossy().into_owned())
        })
        .unwrap_or(false)
}

fn healthy(home: &Home) -> bool {
    nexus_client::intent_client::code_config(&home.broker_socket()).is_ok()
}

pub fn provider_connected(home: &Home) -> bool {
    let creds = std::fs::symlink_metadata(home.credentials())
        .map(|m| m.is_file() && m.mode() & 0o077 == 0 && m.uid() == uid() && m.len() > 20)
        .unwrap_or(false);
    let routes = home
        .registry_data()
        .join("registry/mode-configurations.json")
        .is_file();
    creds && routes
}

pub fn status(home: &Home) -> Status {
    let (dp, bp, mine) = read_pids(home);
    let alive = |p: Option<u32>| p.filter(|p| pid_is_ours(*p, home));
    let (dp, bp) = (alive(dp), alive(bp));
    let phase = if !home.root.exists() {
        Phase::NotBootstrapped
    } else if dp.is_none() && bp.is_none() {
        Phase::Stopped
    } else if healthy(home) {
        Phase::Ready
    } else {
        Phase::Degraded("the runtime is running but the broker does not answer".into())
    };
    Status {
        phase,
        home: home.root.to_string_lossy().into_owned(),
        broker_socket: home.broker_socket().to_string_lossy().into_owned(),
        daemon_pid: dp,
        broker_pid: bp,
        provider_connected: provider_connected(home),
        started_by_this_process: mine,
    }
}

#[allow(dead_code)]
struct Lock(std::fs::File);
impl Lock {
    fn take(home: &Home) -> Result<Lock, String> {
        use std::os::unix::io::AsRawFd;
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(home.lock_file())
            .map_err(|e| format!("cannot open the supervisor lock: {e}"))?;
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err("cannot lock the supervisor".into());
        }
        Ok(Lock(f))
    }
}

fn spawn(cmd: &mut Command, log: &Path) -> Result<std::process::Child, String> {
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(log)
        .map_err(|e| format!("cannot open {}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .process_group(0);
    cmd.spawn()
        .map_err(|e| format!("cannot start {:?}: {e}", cmd.get_program()))
}

fn wait_for<F: Fn() -> bool>(what: &str, secs: u64, f: F, hint: &Path) -> Result<(), String> {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "{what} did not become ready in {secs}s (see {})",
        hint.display()
    ))
}

fn tail(p: &Path) -> String {
    std::fs::read_to_string(p)
        .map(|s| {
            s.lines()
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" | ")
        })
        .unwrap_or_default()
}

fn start_daemon(home: &Home, tools: &Tools) -> Result<std::process::Child, String> {
    let me = uid().to_string();
    let dlog = home.logs().join("daemon.log");
    let mut d = Command::new(&tools.nexusd);
    if let Some(c) = &tools.confine {
        d.env("NEXUS_CONFINE_BIN", c);
    }
    if let Some(e) = &tools.egress {
        d.env("NEXUS_EGRESS_BIN", e);
    }
    d.arg("--db")
        .arg(home.daemon_dir().join("k.db"))
        .arg("--socket")
        .arg(home.daemon_socket())
        .arg("--cap")
        .arg(home.issuer_cap())
        .args(["--trust-mode", "shadow-test"])
        .arg("--witness")
        .arg(home.daemon_dir().join("k.wit.db"))
        .args([
            "--allowed-uids",
            &me,
            "--enable-model-pilot",
            "--enable-repo-code",
            "--enable-writes",
            "--enable-process",
            "--autonomous-workspace-policy",
            // standing permissions per project (a project without a grant behaves exactly as before)
            "--standing-grants",
            // Ask: pending operations are decided by the person in the trusted terminal approver
            // (`nexus-approver`), which alone holds this credential. Same OS user, separate credential.
            "--approver-same-user",
            "--approver-uids",
            &me,
        ])
        .arg("--approver-cap")
        .arg(home.approver_cap())
        .arg("--workspace-bases")
        .arg(home.code_base())
        .arg("--worktree-root")
        .arg(home.worktrees())
        .arg("--project-registry")
        .arg(home.projects_registry())
        .arg("--project-envs")
        .arg(home.envs());
    if let Some(dc) = std::env::var_os("NEXUS_DEP_CACHE").filter(|v| !v.is_empty()) {
        d.arg("--dep-cache").arg(dc);
    }
    let mut dchild = spawn(&mut d, &dlog)?;
    if let Err(e) = wait_for(
        "the Kernel daemon",
        30,
        || home.daemon_socket().exists() && home.issuer_cap().exists(),
        &dlog,
    ) {
        let _ = dchild.kill();
        return Err(format!("{e}: {}", tail(&dlog)));
    }
    Ok(dchild)
}

/// Start (or attach to) the runtime. Idempotent: a healthy runtime for this home is
/// reused; a half-started or stale one is stopped first.
pub fn start(home: &Home, tools: &Tools) -> Result<Status, String> {
    start_if(home, tools, || Ok(()))
}

/// `start`, except that a runtime that is already RUNNING (stale or unhealthy) is only
/// replaced when `may_replace` agrees. It runs under the supervisor lock, immediately
/// before anything is stopped; an `Err` leaves the running processes untouched.
pub fn start_if<F: FnOnce() -> Result<(), String>>(
    home: &Home,
    tools: &Tools,
    may_replace: F,
) -> Result<Status, String> {
    bootstrap(home)?;
    let _g = Lock::take(home)?;
    if healthy(home) && !matches!(freshness(home, tools), Freshness::Stale) {
        let st = status(home);
        if st.daemon_pid.is_some() {
            return Ok(st);
        }
        // The Kernel daemon died while the broker (and the work it is driving) is alive:
        // bring back only the daemon. It recovers its durable state; the broker's running
        // steps wait for it and then carry on.
        let _ = std::fs::remove_file(home.daemon_socket());
        let child = start_daemon(home, tools)?;
        let mut state: serde_json::Value = std::fs::read_to_string(home.state_file())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        state["daemonPid"] = serde_json::json!(child.id());
        state["supervisorPid"] = serde_json::json!(std::process::id());
        write_private(&home.state_file(), state.to_string().as_bytes())?;
        std::mem::forget(child);
        return Ok(status(home));
    }
    if status(home).broker_pid.is_some() || status(home).daemon_pid.is_some() {
        may_replace()?;
    }
    stop_inner(home);
    for f in [home.daemon_socket(), home.broker_socket()] {
        let _ = std::fs::remove_file(f);
    }
    let me = uid().to_string();
    let blog = home.logs().join("broker.log");
    let dchild = start_daemon(home, tools)?;
    let mut dchild = dchild;
    let mut b = Command::new(&tools.broker);
    b.arg("--state-dir")
        .arg(home.broker_dir())
        .arg("--socket")
        .arg(home.broker_socket())
        .arg("--daemon-socket")
        .arg(home.daemon_socket())
        .arg("--cap")
        .arg(home.issuer_cap())
        .arg("--credentials")
        .arg(home.credentials())
        .arg("--repo-root")
        .arg(&tools.repo_root)
        .arg("--registry-data-root")
        .arg(home.registry_data())
        .arg("--transcript-dir")
        .arg(home.transcripts())
        .args(["--allowed-uids", &me])
        .arg("--node")
        .arg(&tools.node)
        .arg("--project-registry")
        .arg(home.projects_registry())
        .arg("--project-snapshots")
        .arg(home.snapshots())
        .arg("--interactive-profile");
    if !home.credentials().exists() {
        // the broker needs the file to exist; it holds no secret until the provider is connected
        write_private(&home.credentials(), b"{}")?;
    }
    let mut bchild = spawn(&mut b, &blog)?;
    if let Err(e) = wait_for("the broker", 40, || healthy(home), &blog) {
        let _ = bchild.kill();
        let _ = dchild.kill();
        return Err(format!("{e}: {}", tail(&blog)));
    }
    let state = json!({
        "daemonPid": dchild.id(), "brokerPid": bchild.id(),
        "supervisorPid": std::process::id(), "startedAtMs": now_ms(),
        "home": home.root,
    });
    write_private(&home.state_file(), state.to_string().as_bytes())?;
    // the children are intentionally not waited on: they outlive this call, owned by the
    // supervisor through `stop`
    std::mem::forget(dchild);
    std::mem::forget(bchild);
    Ok(status(home))
}

/// Is the running broker the installed build?
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Freshness {
    Current,
    /// The installed `nexus-broker` was replaced after this broker started (the broker
    /// refuses live work in that state).
    Stale,
    NotRunning,
    /// The check itself failed; never treated as stale.
    Unknown(String),
}

/// Ask the INSTALLED broker binary (`identity`, read-only) whether the broker recorded
/// for this home runs that same executable file. Exit 0 current, 3 stale, 4 none.
pub fn freshness(home: &Home, tools: &Tools) -> Freshness {
    match Command::new(&tools.broker)
        .args(["identity", "--state-dir"])
        .arg(home.broker_dir())
        .stdin(Stdio::null())
        .output()
    {
        Ok(o) => match o.status.code() {
            Some(0) => Freshness::Current,
            Some(3) => Freshness::Stale,
            Some(4) => Freshness::NotRunning,
            c => Freshness::Unknown(format!("identity check exited with {c:?}")),
        },
        Err(e) => Freshness::Unknown(format!("cannot run {}: {e}", tools.broker.display())),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut f = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn stop_inner(home: &Home) {
    let (dp, bp, _) = read_pids(home);
    // broker first (it holds the clients), then the daemon
    for pid in [bp, dp].into_iter().flatten() {
        if pid_is_ours(pid, home) {
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        }
    }
    let end = Instant::now() + Duration::from_secs(8);
    while Instant::now() < end && [bp, dp].into_iter().flatten().any(|p| pid_is_ours(p, home)) {
        std::thread::sleep(Duration::from_millis(100));
    }
    for pid in [bp, dp].into_iter().flatten() {
        if pid_is_ours(pid, home) {
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
    }
    let _ = std::fs::remove_file(home.state_file());
}

/// Stop the processes of THIS home (identified by pid file AND command line).
pub fn stop(home: &Home) -> Result<(), String> {
    private_dir(&home.run_dir())?;
    let _g = Lock::take(home)?;
    stop_inner(home);
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectReport {
    pub verified: bool,
    pub checks: Vec<String>,
}

/// The one-time provider connection: store the key privately, then verify the Registry
/// route (5 small billable requests) and bind the engineering mode. The key is never
/// printed, logged or passed on a command line.
pub fn connect_provider(
    home: &Home,
    tools: &Tools,
    api_key: &str,
) -> Result<ConnectReport, String> {
    if api_key.len() < 16
        || api_key.len() > 512
        || !api_key.bytes().all(|b| (0x21..=0x7e).contains(&b))
    {
        return Err("that does not look like an API key".into());
    }
    bootstrap(home)?;
    let reg = home.registry_data();
    let run = |args: &[&str]| -> Result<(bool, String), String> {
        let o = Command::new(&tools.node)
            .current_dir(&tools.repo_root)
            .args(args)
            .env_remove("OPENCODE_API_KEY")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("cannot run node: {e}"))?;
        Ok((
            o.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            ),
        ))
    };
    let script = |n: &str| {
        tools
            .repo_root
            .join("scripts")
            .join(n)
            .to_string_lossy()
            .into_owned()
    };
    let regs = reg.to_string_lossy().into_owned();
    if !reg.join("registry/routes.json").is_file() {
        let (ok, out) = run(&[
            &script("Setup-NativeOpenCodeGo.cjs"),
            "--data-root",
            &regs,
            "--apply",
        ])?;
        if !ok {
            return Err(format!(
                "provider setup failed: {}",
                out.lines().last().unwrap_or("")
            ));
        }
    }
    let body = json!({ CRED_REF: api_key }).to_string();
    write_private(&home.credentials(), body.as_bytes())?;
    let creds = home.credentials().to_string_lossy().into_owned();
    let (ok, out) = run(&[
        &script("Verify-NativeOpenCodeGoRoute.cjs"),
        "authorize",
        "--data-root",
        &regs,
        "--acknowledge-billable",
    ])?;
    if !ok {
        return Err(format!(
            "could not start route verification: {}",
            out.lines().last().unwrap_or("")
        ));
    }
    let (ok, out) = run(&[
        &script("Verify-NativeOpenCodeGoRoute.cjs"),
        "verify",
        "--data-root",
        &regs,
        "--credentials",
        &creds,
    ])?;
    let checks: Vec<String> = out
        .lines()
        .filter(|l| {
            l.starts_with("PASS")
                || l.starts_with("FAIL")
                || l.starts_with("route")
                || l.starts_with("engineering")
        })
        .map(str::to_owned)
        .collect();
    if !ok {
        return Ok(ConnectReport {
            verified: false,
            checks,
        });
    }
    Ok(ConnectReport {
        verified: true,
        checks,
    })
}

/// Phase 2: the explicit one-time setup of Nexus Adaptive for an installation whose provider is already
/// connected: (1) offline, idempotent: the adaptive model/route records; (2) a single-use authorization
/// record for exactly the stated list of billable requests; (3) the REAL Registry route verification
/// (every authorized effort is probed and must be acknowledged by the provider); (4) the explicit,
/// authorized save of the adaptive ModeConfiguration - only if the route verified. The key is read only
/// by the verification script from the private credentials file; it is never printed or passed on a
/// command line. Nothing is ever recorded as verified without the provider's answers.
pub fn enable_adaptive(home: &Home, tools: &Tools) -> Result<ConnectReport, String> {
    bootstrap(home)?;
    if !provider_connected(home) {
        return Err(
            "the provider is not connected yet: connect it first (one-time provider connection)"
                .into(),
        );
    }
    let reg = home.registry_data();
    let regs = reg.to_string_lossy().into_owned();
    let creds = home.credentials().to_string_lossy().into_owned();
    let run = |args: &[&str]| -> Result<(bool, String), String> {
        let o = Command::new(&tools.node)
            .current_dir(&tools.repo_root)
            .args(args)
            .env_remove("OPENCODE_API_KEY")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("cannot run node: {e}"))?;
        Ok((
            o.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            ),
        ))
    };
    let script = |n: &str| {
        tools
            .repo_root
            .join("scripts")
            .join(n)
            .to_string_lossy()
            .into_owned()
    };
    let (ok, out) = run(&[
        &script("Setup-NativeOpenCodeGo.cjs"),
        "--data-root",
        &regs,
        "--apply",
        "--adaptive",
    ])?;
    if !ok {
        return Err(format!(
            "adaptive setup failed: {}",
            out.lines().last().unwrap_or("")
        ));
    }
    let (ok, out) = run(&[
        &script("Verify-NativeOpenCodeGoRoute.cjs"),
        "authorize",
        "--data-root",
        &regs,
        "--acknowledge-billable",
        "--adaptive",
    ])?;
    if !ok {
        return Err(format!(
            "could not start the adaptive route verification: {}",
            out.lines().last().unwrap_or("")
        ));
    }
    let (ok, out) = run(&[
        &script("Verify-NativeOpenCodeGoRoute.cjs"),
        "verify",
        "--data-root",
        &regs,
        "--credentials",
        &creds,
        "--adaptive",
        "--save-adaptive-config",
    ])?;
    let checks: Vec<String> = out
        .lines()
        .filter(|l| {
            l.starts_with("PASS")
                || l.starts_with("FAIL")
                || l.starts_with("route")
                || l.starts_with("engineering")
                || l.starts_with("credential_present")
                || l.starts_with("adaptive")
        })
        .map(str::to_owned)
        .collect();
    Ok(ConnectReport {
        verified: ok,
        checks,
    })
}
