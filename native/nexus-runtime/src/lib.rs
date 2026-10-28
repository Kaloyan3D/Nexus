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
    /// Nexus's own Node.js (`<install>/node`), verified at start-up, when this is an installed build.
    /// `None` in a development checkout (the Node on PATH is used there).
    pub private_node_dir: Option<PathBuf>,
    /// Which Node runs the Registry bridge, for diagnostics.
    pub node_info: NodeInfo,
}

/// Which Node.js the runtime uses, and what it is.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    /// `bundled` (shipped with Nexus, verified) | `system` (found on PATH; development layout only)
    pub source: &'static str,
    pub version: Option<String>,
}

/// Environment variable through which children learn where the verified private Node.js is
/// (the same name `nexus_tools::process::PRIVATE_NODE_ENV`, pinned by a test).
pub const PRIVATE_NODE_ENV: &str = "NEXUS_PRIVATE_NODE_DIR";

/// `<install>/node/nexus-node.json`, written at packaging time.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeManifest {
    schema_version: u32,
    version: String,
    arch: String,
    node_sha256: String,
}

/// Verify the private Node.js next to an installed build. `Ok(None)` = this is not an installed build (no
/// manifest). Anything wrong with an installed build's Node is an ERROR: there is no silent fallback to a
/// Node found on PATH, because a bundled runtime that fails verification is a broken or tampered install.
fn verify_private_node(bin_dir: &Path) -> Result<Option<(PathBuf, PathBuf, String)>, String> {
    verify_private_node_with(bin_dir, SUPPORTED_NODE_PREFIX)
}

/// Release 1 ships Node.js 24 LTS and accepts nothing else as its private runtime.
const SUPPORTED_NODE_PREFIX: &str = "v24.";

fn verify_private_node_with(
    bin_dir: &Path,
    prefix: &str,
) -> Result<Option<(PathBuf, PathBuf, String)>, String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let Some(dir) = bin_dir.parent().map(|p| p.join("node")) else {
        return Ok(None);
    };
    let manifest_path = dir.join("nexus-node.json");
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let bad = |m: String| format!("the bundled Node.js failed verification: {m}; reinstall Nexus");
    let m: NodeManifest = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .map_err(|e| bad(format!("cannot read its manifest: {e}")))?,
    )
    .map_err(|e| bad(format!("its manifest is unreadable: {e}")))?;
    if m.schema_version != 1 || m.arch != "linux-x64" || !m.version.starts_with(prefix) {
        return Err(bad(format!(
            "unsupported manifest ({} {} schema {})",
            m.version, m.arch, m.schema_version
        )));
    }
    let node = dir.join("bin/node");
    let md =
        std::fs::symlink_metadata(&node).map_err(|e| bad(format!("bin/node is missing: {e}")))?;
    let me = unsafe { libc::geteuid() };
    if !md.is_file() || (md.uid() != 0 && md.uid() != me) || md.permissions().mode() & 0o022 != 0 {
        return Err(bad(
            "bin/node is not a regular file owned by root or you and closed to others".into(),
        ));
    }
    let mut f = std::fs::File::open(&node).map_err(|e| bad(e.to_string()))?;
    let mut head = [0u8; 20];
    // a file shorter than an ELF header is simply "not an executable of this kind"
    if f.read_exact(&mut head).is_err() {
        return Err(bad("bin/node is not an x86-64 Linux executable".into()));
    }
    // ELF, 64-bit, little-endian, machine x86-64
    if &head[..4] != b"\x7fELF"
        || head[4] != 2
        || head[5] != 1
        || u16::from_le_bytes([head[18], head[19]]) != 0x3e
    {
        return Err(bad("bin/node is not an x86-64 Linux executable".into()));
    }
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    let mut f = std::fs::File::open(&node).map_err(|e| bad(e.to_string()))?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| bad(e.to_string()))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    if hex::encode(h.finalize()) != m.node_sha256.to_ascii_lowercase() {
        return Err(bad("bin/node does not match its recorded digest".into()));
    }
    let out = Command::new(&node)
        .arg("--version")
        .env_clear()
        .stdin(Stdio::null())
        .output()
        .map_err(|e| bad(format!("it does not run: {e}")))?;
    let got = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if !out.status.success() || got != m.version {
        return Err(bad(format!("it reports {got:?}, expected {}", m.version)));
    }
    Ok(Some((dir, node, got)))
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
        // An installed build brings its own, verified Node.js and never looks at PATH; a development
        // checkout (no manifest next to the programs) uses the Node on PATH.
        let (node, private_node_dir, node_info) = match verify_private_node(&bin_dir)? {
            Some((dir, node, version)) => (
                node,
                Some(dir),
                NodeInfo {
                    source: "bundled",
                    version: Some(version),
                },
            ),
            None => (
                path_lookup("node").ok_or("node was not found on PATH")?,
                None,
                NodeInfo {
                    source: "system",
                    version: None,
                },
            ),
        };
        Ok(Tools {
            nexusd: find("nexusd")?,
            broker: find("nexus-broker")?,
            node,
            repo_root,
            approver: find("nexus-approver").ok(),
            confine: find("nexus-confine").ok(),
            egress: find("nexus-egress").ok(),
            private_node_dir,
            node_info,
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
    if let Some(n) = &tools.private_node_dir {
        d.env(PRIVATE_NODE_ENV, n);
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
    // M8: Full Access is an operator opt-in for the whole installation, off by
    // default. Even then, every project still needs its own fs=full + net=full
    // grant; this flag alone authorizes nothing.
    if std::env::var_os("NEXUS_ENABLE_HOST_EXEC").is_some_and(|v| v == "1") {
        d.arg("--enable-host-exec");
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
    if let Some(n) = &tools.private_node_dir {
        b.env(PRIVATE_NODE_ENV, n);
    }
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
    // A process this one started stays a zombie until it is waited for: reap it, so a stopped runtime leaves
    // nothing behind in the process table (ECHILD for a runtime started by someone else is expected and ignored).
    for pid in [bp, dp].into_iter().flatten() {
        for _ in 0..50 {
            let mut st = 0;
            let r = unsafe { libc::waitpid(pid as i32, &mut st, libc::WNOHANG) };
            if r != 0 {
                break; // reaped, or not our child
            }
            std::thread::sleep(Duration::from_millis(20));
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

#[cfg(test)]
mod node_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;

    fn host_node() -> Option<(PathBuf, String)> {
        let p = path_lookup("node")?;
        let v = String::from_utf8(Command::new(&p).arg("--version").output().ok()?.stdout).ok()?;
        Some((p, v.trim().to_owned()))
    }

    /// `<tmp>/bin/` (the programs) and `<tmp>/node/` (a copy of the host's node, with a manifest).
    fn install(
        manifest: impl FnOnce(&str, &str) -> String,
    ) -> Option<(tempfile::TempDir, PathBuf, String)> {
        let (hn, ver) = host_node()?;
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("bin")).unwrap();
        std::fs::create_dir_all(t.path().join("node/bin")).unwrap();
        let dst = t.path().join("node/bin/node");
        std::fs::copy(&hn, &dst).unwrap();
        std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sha = hex::encode(Sha256::digest(std::fs::read(&dst).unwrap()));
        std::fs::write(t.path().join("node/nexus-node.json"), manifest(&ver, &sha)).unwrap();
        let bin = t.path().join("bin");
        Some((t, bin, ver))
    }
    fn good(ver: &str, sha: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"version":"{ver}","arch":"linux-x64","nodeSha256":"{sha}"}}"#
        )
    }

    #[test]
    fn a_development_layout_has_no_private_node_and_uses_path() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("bin")).unwrap();
        assert!(verify_private_node(&t.path().join("bin"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_genuine_private_node_is_accepted_and_reports_its_version() {
        let Some((_t, bin, ver)) = install(good) else {
            return;
        };
        let prefix = &ver[..4]; // "v26." etc: the host's major stands in for the pinned one
        let (dir, node, got) = verify_private_node_with(&bin, prefix)
            .unwrap()
            .expect("installed layout");
        assert_eq!(got, ver);
        assert!(node.ends_with("node/bin/node") && dir.ends_with("node"));
        // the production rule only accepts Node 24
        if !ver.starts_with("v24.") {
            assert!(verify_private_node(&bin)
                .unwrap_err()
                .contains("unsupported manifest"));
        }
    }

    #[test]
    fn a_tampered_wrong_or_untrusted_private_node_is_an_error_never_a_fallback() {
        // wrong digest
        let Some((_t, bin, ver)) = install(|v, _| good(v, &"0".repeat(64))) else {
            return;
        };
        let p = &ver[..4];
        assert!(verify_private_node_with(&bin, p)
            .unwrap_err()
            .contains("recorded digest"));
        // the file changed after packaging
        let Some((t, bin, ver)) = install(good) else {
            return;
        };
        let mut b = std::fs::read(t.path().join("node/bin/node")).unwrap();
        let n = b.len() - 1;
        b[n] ^= 0xff;
        std::fs::write(t.path().join("node/bin/node"), b).unwrap();
        assert!(verify_private_node_with(&bin, &ver[..4])
            .unwrap_err()
            .contains("recorded digest"));
        // not an ELF
        let Some((t, bin, ver)) = install(good) else {
            return;
        };
        let script = b"#!/bin/sh\necho v0\n".to_vec();
        std::fs::write(t.path().join("node/bin/node"), &script).unwrap();
        std::fs::write(
            t.path().join("node/nexus-node.json"),
            good(&ver, &hex::encode(Sha256::digest(&script))),
        )
        .unwrap();
        assert!(verify_private_node_with(&bin, &ver[..4])
            .unwrap_err()
            .contains("x86-64 Linux executable"));
        // writable by others
        let Some((t, bin, ver)) = install(good) else {
            return;
        };
        std::fs::set_permissions(
            t.path().join("node/bin/node"),
            std::fs::Permissions::from_mode(0o777),
        )
        .unwrap();
        assert!(verify_private_node_with(&bin, &ver[..4])
            .unwrap_err()
            .contains("closed to others"));
        // a version the manifest does not match / unsupported
        let Some((_t, bin, ver)) = install(|_, s| good("v24.0.0", s)) else {
            return;
        };
        assert!(
            verify_private_node_with(&bin, "v24.")
                .unwrap_err()
                .contains("expected v24.0.0"),
            "{ver}"
        );
        // another architecture
        let Some((_t, bin, ver)) = install(|v, s| good(v, s).replace("linux-x64", "linux-arm64"))
        else {
            return;
        };
        assert!(verify_private_node_with(&bin, &ver[..4])
            .unwrap_err()
            .contains("unsupported manifest"));
        // a missing binary
        let Some((t, bin, ver)) = install(good) else {
            return;
        };
        std::fs::remove_file(t.path().join("node/bin/node")).unwrap();
        assert!(verify_private_node_with(&bin, &ver[..4])
            .unwrap_err()
            .contains("missing"));
    }

    #[test]
    fn the_environment_variable_name_matches_the_toolchains() {
        assert_eq!(PRIVATE_NODE_ENV, nexus_tools::process::PRIVATE_NODE_ENV);
    }
}
