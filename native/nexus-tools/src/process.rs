//! Sandboxed process execution lifecycle (A3.4).
//!
//! ```text
//! authorized ─ started ─ prepared ─ running ─ exited | failed | cancelled
//!   (grant)   (consumed   (snapshot   (spawned   (explicit exit/termination
//!              once)       + sandbox   in the     reason, usage, bounded
//!                          digests     sandbox)   redacted output)
//!                          durable,
//!                          BEFORE spawn)         └─► interrupted (reconcile)
//! ```
//!
//! A model/caller-provided command is never authority: `program` is a
//! logical name resolved by [`CommandPolicy`], argv is validated against a
//! per-command allow-list, there is no shell and no `-c`, and the request
//! is only meaningful under a Kernel-sealed process grant.

use crate::contract::{ProcessArgs, ToolBudgets};
use crate::exec::CancellationToken;
use crate::mutate::crash_point;
use crate::redact::{Redaction, Redactor, LINE_TRUNCATED};
use crate::result::{ToolError, ToolErrorCode, ToolResultV1, ToolStats, Truncation};
use crate::sandbox::{
    bwrap_argv, kill_and_remove_cgroup, run_sandboxed, sandbox_digest, ExitKind, SandboxControl,
    SandboxLimits, SandboxSpec, StopReason,
};
use crate::stage::{stage_workspace, StageLimits};
use crate::workspace::Workspace;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PH_PREPARED: &str = "prepared";
pub const PH_RUNNING: &str = "running";
pub const PH_EXITED: &str = "exited";
pub const PH_FAILED: &str = "failed";
pub const PH_CANCELLED: &str = "cancelled";

/// Bounded persisted output tail (after redaction) per stream.
pub const PERSISTED_TAIL_BYTES: usize = 8 * 1024;

pub trait ProcessHooks {
    fn journal(&mut self, phase: &str, payload: serde_json::Value) -> Result<(), ToolError>;
    fn fence(&mut self) -> Result<(), ToolError>;
    fn at(&mut self, _point: &str) {}
    /// An in-place execution's effects record was persisted (before its end is journaled). The daemon feeds
    /// it to the Direct Workspace evidence of a task that has one; the default keeps nothing.
    fn effects(&mut self, _record: &crate::observe::EffectsRecord) {}
    /// The owner's checkpoint and hard-link policy for this execution (from the task's frozen grant). `None` =
    /// the daemon-wide defaults of the command policy. Only the daemon can supply it; no argument can.
    fn exec_policy(&mut self) -> Option<crate::grant::ExecPolicy> {
        None
    }
    /// Controlled Internet: the destination policy this execution holds (frozen grant, narrowed by the grant as
    /// it stands now). `None` = the task is not under Controlled Internet.
    fn net_policy(&mut self) -> Option<crate::netpolicy::NetPolicy> {
        None
    }
    /// Has the task's destination policy been narrowed (or withdrawn) since `started`? Widening never counts.
    fn net_narrowed(&mut self, _started: &crate::netpolicy::NetPolicy) -> bool {
        false
    }
}

// ------------------------------------------------------------ policy

#[derive(Debug, Clone, Default)]
pub struct ResolvedCommand {
    /// Logical name (`cargo`, `npm`, `tsc`, or a test-policy name).
    pub name: String,
    pub program: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub ro_binds: Vec<(PathBuf, String)>,
    /// Dependency installation: runs with the host network, may populate the project
    /// environment, and is only allowed when the project permits installs.
    pub install: bool,
    /// Wall-clock allowance this command class needs (installs and builds are longer).
    pub wall_ms: Option<u64>,
    /// A `sh -c` script that contains a pipeline: its exit status is only trustworthy with `pipefail`.
    pub shell_pipeline: bool,
}

impl ResolvedCommand {
    /// Human-readable, redacted command line for records and the GUI.
    pub fn display(&self) -> String {
        let mut red = Redaction::default();
        let mut r = Redactor::new();
        let mut s = self.name.clone();
        for a in &self.argv {
            s.push(' ');
            // Redact line by line (an argument may be a multi-line script)
            // and bound the displayed length.
            let shown: String = a
                .split('\n')
                .map(|l| r.line(l, &mut red))
                .collect::<Vec<_>>()
                .join("\\n");
            if shown.chars().count() > 160 {
                s.push_str(&shown.chars().take(160).collect::<String>());
                s.push('…');
            } else {
                s.push_str(&shown);
            }
        }
        s
    }
    pub fn argv_digest(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.name.as_bytes());
        for a in &self.argv {
            h.update([0]);
            h.update(a.as_bytes());
        }
        hex::encode(h.finalize())
    }
}

#[derive(Debug, Clone)]
pub struct Toolchain {
    pub cargo_home_bin: Option<PathBuf>,
    pub rustup_home: Option<PathBuf>,
}

impl Toolchain {
    pub fn discover() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let cargo_bin = std::env::var_os("CARGO_HOME")
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".cargo")))
            .map(|p| p.join("bin"));
        let rustup = std::env::var_os("RUSTUP_HOME")
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".rustup")));
        Self {
            cargo_home_bin: cargo_bin.filter(|p| p.is_dir()),
            rustup_home: rustup.filter(|p| p.is_dir()),
        }
    }
}

/// Concrete command policy. Only these workflows exist; the sandbox
/// enforces isolation independently of whether a name is "trusted".
#[derive(Debug, Clone)]
pub struct CommandPolicy {
    toolchain: Toolchain,
    /// Test-only: additional absolute programs allowed with free argv.
    /// Only constructible through [`CommandPolicy::offline_test`].
    test_programs: Vec<String>,
    /// Operator-provisioned, verified dependency cache (A3.5). `None`
    /// means cargo sees no vendored source (dependency-free projects only).
    dep_cache: Option<PathBuf>,
    /// Autonomy-first command set (`workbench.rs`) instead of the strict exact-argv one.
    workbench: bool,
    /// Resource budget of the filesystem observation of in-place commands (daemon configuration).
    observe: crate::observe::ObserveBudget,
    /// Checkpoint policy of in-place commands (daemon configuration; default off).
    checkpoint: crate::checkpoint::CheckpointPolicy,
    /// Existing hard-linked files in an in-place workspace (M3C.4).
    hard_links: crate::inplace::HardLinks,
    /// Explicit path of the in-sandbox launch gate (default: located next to the running executable).
    confine_shim: Option<PathBuf>,
    /// Nexus's own directories (never exposed through a linked worktree's git pointer).
    forbidden: Vec<PathBuf>,
    /// The egress service of Controlled Internet (daemon configuration).
    egress: crate::egress_host::EgressSettings,
}

fn arg_ok(a: &str) -> bool {
    !a.is_empty()
        && a.len() <= 128
        && a.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/@:=+-".contains(c))
        && !a.contains("..")
}

fn refuse_cmd(msg: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::CommandRefused, msg)
}

impl CommandPolicy {
    pub fn standard(toolchain: Toolchain) -> Self {
        Self {
            toolchain,
            dep_cache: None,
            test_programs: Vec::new(),
            workbench: false,
            observe: Default::default(),
            checkpoint: Default::default(),
            hard_links: Default::default(),
            confine_shim: None,
            forbidden: Vec::new(),
            egress: Default::default(),
        }
    }

    /// The workbench command set: ordinary development programs and arguments, bounded
    /// by the sandbox and the project environment rather than by exact argv shapes.
    pub fn with_workbench(mut self) -> Self {
        self.workbench = true;
        self
    }

    pub fn is_workbench(&self) -> bool {
        self.workbench
    }

    /// Set the observation budget (a daemon setting; no tool argument can reach it).
    pub fn with_observe_budget(mut self, b: crate::observe::ObserveBudget) -> Self {
        self.observe = b;
        self
    }

    pub fn observe_budget(&self) -> &crate::observe::ObserveBudget {
        &self.observe
    }

    /// Set the checkpoint policy (a daemon setting; no tool argument can reach it).
    pub fn with_checkpoint(mut self, p: crate::checkpoint::CheckpointPolicy) -> Self {
        self.checkpoint = p;
        self
    }

    /// Allow commands to write hard-linked files (operator decision, recorded in every execution).
    pub fn with_hard_links(mut self, h: crate::inplace::HardLinks) -> Self {
        self.hard_links = h;
        self
    }

    pub fn hard_links(&self) -> crate::inplace::HardLinks {
        self.hard_links
    }

    pub fn with_egress_settings(mut self, e: crate::egress_host::EgressSettings) -> Self {
        self.egress = e;
        self
    }

    pub fn egress_settings(&self) -> &crate::egress_host::EgressSettings {
        &self.egress
    }

    pub fn with_forbidden_paths(mut self, v: Vec<PathBuf>) -> Self {
        self.forbidden = v;
        self
    }

    pub fn forbidden_paths(&self) -> &[PathBuf] {
        &self.forbidden
    }

    /// Use this launch gate binary (tests, packaged installs).
    pub fn with_confine_shim(mut self, p: PathBuf) -> Self {
        self.confine_shim = Some(p);
        self
    }

    pub fn confine_shim(&self) -> Option<PathBuf> {
        self.confine_shim
            .clone()
            .or_else(crate::confine_host::locate_shim)
    }

    pub fn checkpoint_policy(&self) -> &crate::checkpoint::CheckpointPolicy {
        &self.checkpoint
    }

    pub(crate) fn toolchain_has_cargo(&self) -> bool {
        self.toolchain.cargo_home_bin.is_some()
    }

    pub(crate) fn toolchain_binds_pub(&self) -> Vec<(PathBuf, String)> {
        self.toolchain_binds()
    }

    /// Attach an operator-provisioned dependency cache directory.
    pub fn with_dep_cache(mut self, dir: PathBuf) -> Self {
        self.dep_cache = Some(dir);
        self
    }

    /// Offline test policy: also allows the listed absolute programs.
    pub fn offline_test(toolchain: Toolchain, programs: &[&str]) -> Self {
        Self {
            toolchain,
            dep_cache: None,
            test_programs: programs.iter().map(|s| s.to_string()).collect(),
            workbench: false,
            observe: Default::default(),
            checkpoint: Default::default(),
            hard_links: Default::default(),
            confine_shim: None,
            forbidden: Vec::new(),
            egress: Default::default(),
        }
    }

    fn env_base(&self) -> BTreeMap<String, String> {
        let mut e = BTreeMap::new();
        let mut path = String::new();
        if self.toolchain.cargo_home_bin.is_some() {
            path.push_str("/toolchain/cargo/bin:");
        }
        path.push_str("/usr/bin:/bin");
        e.insert("PATH".into(), path);
        e.insert("HOME".into(), "/work/out/home".into());
        e.insert("TMPDIR".into(), "/tmp".into());
        e.insert("LANG".into(), "C.UTF-8".into());
        e.insert("NO_COLOR".into(), "1".into());
        e.insert("CI".into(), "1".into());
        // Offline by construction (the network namespace has no route
        // anyway); these make the tools fail fast and honestly.
        e.insert("CARGO_NET_OFFLINE".into(), "true".into());
        e.insert("CARGO_HOME".into(), "/work/out/cargo-home".into());
        e.insert("CARGO_TARGET_DIR".into(), "/work/out/target".into());
        e.insert("npm_config_offline".into(), "true".into());
        e.insert("npm_config_cache".into(), "/work/out/npm-cache".into());
        e.insert("npm_config_update_notifier".into(), "false".into());
        e
    }

    fn toolchain_binds(&self) -> Vec<(PathBuf, String)> {
        let mut v = Vec::new();
        if let Some(b) = &self.toolchain.cargo_home_bin {
            v.push((b.clone(), "/toolchain/cargo/bin".to_owned()));
        }
        if let Some(r) = &self.toolchain.rustup_home {
            // Only what the proxies need: never the whole RUSTUP_HOME.
            let tc = r.join("toolchains");
            if tc.is_dir() {
                v.push((tc, "/work/out/rustup/toolchains".to_owned()));
            }
            let st = r.join("settings.toml");
            if st.is_file() {
                v.push((st, "/work/out/rustup/settings.toml".to_owned()));
            }
        }
        v
    }

    /// Validate and resolve. Pure: no filesystem, no process.
    pub fn resolve(&self, a: &ProcessArgs) -> Result<ResolvedCommand, ToolError> {
        if self.workbench {
            return crate::workbench::resolve(self, a);
        }
        let cwd_rel = crate::workspace::RelPath::parse(&a.cwd)
            .map_err(|e| refuse_cmd(format!("cwd refused: {}", e.message)))?;
        let cwd = if cwd_rel.is_root() {
            "/work/src".to_owned()
        } else {
            format!("/work/src/{}", cwd_rel.components().join("/"))
        };
        let mut env = self.env_base();
        let binds = self.toolchain_binds();
        let name = a.program.as_str();
        match name {
            "cargo" => {
                if self.toolchain.cargo_home_bin.is_none() {
                    return Err(refuse_cmd("cargo toolchain is not available on this host"));
                }
                // A writable RUSTUP_HOME on the scratch tmpfs; only the
                // toolchains directory and settings.toml are bound (ro).
                env.insert("RUSTUP_HOME".into(), "/work/out/rustup".into());
                let sub = a.args.first().map(String::as_str).unwrap_or("");
                if !["check", "test", "build", "fmt"].contains(&sub) {
                    return Err(refuse_cmd(
                        "cargo: only check, test, build and fmt are permitted",
                    ));
                }
                let mut offline = false;
                let mut i = 1;
                while i < a.args.len() {
                    let x = a.args[i].as_str();
                    match x {
                        "--offline" => offline = true,
                        "--locked" | "--workspace" | "--all" | "--all-targets" | "--release"
                        | "--lib" | "--bins" | "--tests" | "--no-fail-fast" | "--quiet"
                        | "--check" | "--frozen" => {}
                        "-p" | "--package" => {
                            i += 1;
                            match a.args.get(i) {
                                Some(n) if arg_ok(n) && !n.starts_with('-') => {}
                                _ => return Err(refuse_cmd("cargo: bad package name")),
                            }
                        }
                        other => {
                            return Err(refuse_cmd(format!(
                                "cargo: argument '{}' is not permitted",
                                other.chars().take(40).collect::<String>()
                            )))
                        }
                    }
                    i += 1;
                }
                if sub != "fmt" && !offline {
                    return Err(refuse_cmd(
                        "cargo: --offline is required (network access is never enabled)",
                    ));
                }
                Ok(ResolvedCommand {
                    name: "cargo".into(),
                    program: "/toolchain/cargo/bin/cargo".into(),
                    argv: a.args.clone(),
                    cwd,
                    env,
                    ro_binds: binds,
                    ..Default::default()
                })
            }
            "npm" => {
                let ok = matches!(
                    a.args
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>()
                        .as_slice(),
                    ["test"]
                        | ["test", "--offline"]
                        | ["run", "build"]
                        | ["run", "build", "--offline"]
                );
                if !ok {
                    return Err(refuse_cmd(
                        "npm: only `test` and `run build` (optionally --offline) are permitted",
                    ));
                }
                if !Path::new("/usr/bin/npm").exists() {
                    return Err(refuse_cmd("npm is not available on this host"));
                }
                Ok(ResolvedCommand {
                    name: "npm".into(),
                    program: "/usr/bin/npm".into(),
                    argv: a.args.clone(),
                    cwd,
                    env,
                    ro_binds: Vec::new(),
                    ..Default::default()
                })
            }
            "python3" => {
                // `python3 -m unittest|pytest|compileall` only: no `-c`, no script file, no
                // other module. The project's own tests run in the sandbox like `cargo test`.
                let a0 = a.args.first().map(String::as_str);
                let module = a.args.get(1).map(String::as_str).unwrap_or("");
                if a0 != Some("-m") || !["unittest", "pytest", "compileall"].contains(&module) {
                    return Err(refuse_cmd(
                        "python3: only `-m unittest`, `-m pytest` and `-m compileall` are permitted",
                    ));
                }
                let rest = &a.args[2..];
                let mut i = 0;
                while i < rest.len() {
                    let x = rest[i].as_str();
                    let flag_ok = matches!(
                        (module, x),
                        ("unittest", "discover" | "-v" | "-q" | "-f" | "-b")
                            | ("pytest", "-q" | "-x" | "-v" | "--tb=short" | "--no-header")
                            | ("compileall", "-q")
                    );
                    if flag_ok {
                        i += 1;
                        continue;
                    }
                    if module == "unittest" && ["-s", "-t", "-p", "-k"].contains(&x) {
                        match rest.get(i + 1) {
                            Some(v) if arg_ok(v) && !v.starts_with('-') && !v.starts_with('/') => {
                                i += 2;
                                continue;
                            }
                            _ => {
                                return Err(refuse_cmd("python3: bad value for a unittest option"))
                            }
                        }
                    }
                    // a positional: a dotted module name, or a relative path (no options, no abs)
                    if arg_ok(x) && !x.starts_with('-') && !x.starts_with('/') {
                        i += 1;
                        continue;
                    }
                    return Err(refuse_cmd(format!(
                        "python3: argument '{}' is not permitted",
                        x.chars().take(40).collect::<String>()
                    )));
                }
                let prog = ["/usr/bin/python3", "/usr/local/bin/python3"]
                    .iter()
                    .find(|p| Path::new(p).exists())
                    .ok_or_else(|| refuse_cmd("python3 is not available on this host"))?;
                env.insert("PYTHONDONTWRITEBYTECODE".into(), "1".into());
                env.insert("PYTHONPYCACHEPREFIX".into(), "/work/out/pycache".into());
                env.insert("PYTHONNOUSERSITE".into(), "1".into());
                env.insert("PYTHONUNBUFFERED".into(), "1".into());
                env.insert("PYTHONHASHSEED".into(), "0".into());
                Ok(ResolvedCommand {
                    name: "python3".into(),
                    program: (*prog).to_owned(),
                    argv: a.args.clone(),
                    cwd,
                    env,
                    ro_binds: Vec::new(),
                    ..Default::default()
                })
            }
            "node" => {
                // Node's built-in test runner only: `node --test [paths]`.
                if a.args.first().map(String::as_str) != Some("--test") {
                    return Err(refuse_cmd("node: only `--test [PATH...]` is permitted"));
                }
                for x in &a.args[1..] {
                    if !arg_ok(x) || x.starts_with('-') || x.starts_with('/') {
                        return Err(refuse_cmd("node: bad test path"));
                    }
                }
                let prog = ["/usr/bin/node", "/usr/local/bin/node"]
                    .iter()
                    .find(|p| Path::new(p).exists())
                    .ok_or_else(|| refuse_cmd("node is not available on this host"))?;
                Ok(ResolvedCommand {
                    name: "node".into(),
                    program: (*prog).to_owned(),
                    argv: a.args.clone(),
                    cwd,
                    env,
                    ro_binds: Vec::new(),
                    ..Default::default()
                })
            }
            "tsc" => {
                let mut i = 0;
                let mut no_emit = false;
                while i < a.args.len() {
                    match a.args[i].as_str() {
                        "--noEmit" => no_emit = true,
                        "-p" | "--project" => {
                            i += 1;
                            match a.args.get(i) {
                                Some(n) if arg_ok(n) && !n.starts_with('/') => {}
                                _ => return Err(refuse_cmd("tsc: bad project path")),
                            }
                        }
                        other => {
                            return Err(refuse_cmd(format!(
                                "tsc: argument '{}' is not permitted",
                                other.chars().take(40).collect::<String>()
                            )))
                        }
                    }
                    i += 1;
                }
                if !no_emit {
                    return Err(refuse_cmd("tsc: --noEmit is required"));
                }
                let p = ["/usr/bin/tsc", "/usr/local/bin/tsc"]
                    .iter()
                    .find(|p| Path::new(p).exists())
                    .ok_or_else(|| refuse_cmd("tsc is not available on this host"))?;
                Ok(ResolvedCommand {
                    name: "tsc".into(),
                    program: (*p).to_owned(),
                    argv: a.args.clone(),
                    cwd,
                    env,
                    ro_binds: Vec::new(),
                    ..Default::default()
                })
            }
            other if other.starts_with('/') && self.test_programs.iter().any(|p| p == other) => {
                Ok(ResolvedCommand {
                    name: other.to_owned(),
                    program: other.to_owned(),
                    argv: a.args.clone(),
                    cwd,
                    env,
                    ro_binds: Vec::new(),
                    ..Default::default()
                })
            }
            other => Err(refuse_cmd(format!(
                "program '{}' is not an approved command",
                other.chars().take(40).collect::<String>()
            ))),
        }
    }
}

// --------------------------------------------------------- execution

/// The project-scoped environment of one task: where its dependency installs and build
/// caches live between commands, and whether it may install dependencies at all.
#[derive(Debug, Clone)]
pub struct ProjectEnv {
    /// Host directory (private to the project; never inside a workspace).
    pub dir: PathBuf,
    /// The project allows dependency installation (network for the install forms).
    pub installs: bool,
}

/// Directories an install writes into the source tree that later commands need: npm's
/// `node_modules` and the .NET restore output `obj/` (assets file, generated props). They
/// are kept per relative location in the project environment and mounted back over the
/// sources.
const NM_STORE: &str = "nm";
const INSTALL_DIRS: [&str; 2] = ["node_modules", "obj"];

fn find_node_modules(root: &Path, rel: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(root.join(rel)) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = e.file_name();
        let r = rel.join(&name);
        if INSTALL_DIRS.iter().any(|d| name == *d) {
            out.push(r);
        } else if name != ".git" {
            find_node_modules(root, &r, depth + 1, out);
        }
    }
}

/// Mount points for the stored `node_modules` of this project.
fn stored_node_modules(env: &ProjectEnv) -> Vec<(PathBuf, String)> {
    let base = env.dir.join(NM_STORE);
    let mut found = Vec::new();
    find_node_modules(&base, Path::new(""), 0, &mut found);
    found
        .into_iter()
        .map(|rel| {
            let sbx = format!("/work/src/{}", rel.to_string_lossy());
            (base.join(&rel), sbx)
        })
        .collect()
}

/// After a successful install: keep what it put under `node_modules` for later commands.
fn harvest_node_modules(src: &Path, env: &ProjectEnv) -> Result<usize, String> {
    let mut found = Vec::new();
    find_node_modules(src, Path::new(""), 0, &mut found);
    if found.is_empty() {
        return Ok(0);
    }
    let base = env.dir.join(NM_STORE);
    let _ = std::fs::remove_dir_all(&base);
    for rel in &found {
        let to = base.join(rel);
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let from = src.join(rel);
        if std::fs::rename(&from, &to).is_err() {
            let st = std::process::Command::new("cp")
                .arg("-a")
                .arg(&from)
                .arg(&to)
                .status()
                .map_err(|e| e.to_string())?;
            if !st.success() {
                return Err("cannot keep node_modules".into());
            }
        }
    }
    Ok(found.len())
}

pub struct ProcessContext<'a> {
    pub ws: &'a Workspace,
    /// Project-scoped environment (workbench policy); `None` = ephemeral.
    pub env: Option<&'a ProjectEnv>,
    /// Private host directory under which per-execution dirs are created.
    pub run_root: &'a Path,
    pub execution_id: &'a str,
    pub policy: &'a CommandPolicy,
    pub budgets: &'a ToolBudgets,
    /// Upper bound on wall time from the approved process scope.
    pub scope_max_wall_ms: u64,
    /// Filesystem scope SEALED in the Kernel process scope (never taken from tool arguments).
    pub fs_scope: crate::exec_contract::FsScope,
    /// The standing grant sealed in the process scope, recorded verbatim in the journal (absent = none).
    pub grant: Option<&'a crate::authorization::GrantRef>,
    /// Identity of the task and command the execution belongs to (recorded in the effects ledger).
    pub task_instance_id: &'a str,
    pub command_id: &'a str,
}

/// Read-only binds plus the provenance note recorded in the journal.
type DependencyView = (Vec<(PathBuf, String)>, serde_json::Value);

/// Locate the lockfile governing `cwd` (walking up inside the snapshot),
/// materialise the vendor view under `run_dir`, and return the read-only
/// binds. `Ok(None)` when the project has no registry dependencies.
fn prepare_dependency_view(
    cache_dir: &Path,
    src: &Path,
    cwd_in_sandbox: &str,
    run_dir: &Path,
) -> Result<Option<DependencyView>, crate::depcache::CacheError> {
    use crate::depcache::{
        cargo_source_config, parse_cargo_lock, CacheError, CacheQuota, DepCache,
    };
    let rel = cwd_in_sandbox
        .strip_prefix("/work/src")
        .unwrap_or("")
        .trim_start_matches('/');
    let mut dir = src.join(rel);
    let lock_path = loop {
        let c = dir.join("Cargo.lock");
        if let Ok(md) = std::fs::symlink_metadata(&c) {
            if md.is_file() {
                break Some(c);
            }
        }
        if dir == src || !dir.pop() {
            break None;
        }
    };
    let Some(lock_path) = lock_path else {
        return Ok(None);
    };
    let text = std::fs::read(&lock_path).map_err(|e| CacheError {
        code: "lockfile-invalid",
        message: format!("Cargo.lock: {e}"),
    })?;
    if text.len() > 8 * 1024 * 1024 {
        return Err(CacheError {
            code: "lockfile-invalid",
            message: "Cargo.lock too large".into(),
        });
    }
    let lock = parse_cargo_lock(&String::from_utf8_lossy(&text))?;
    if lock.registry.is_empty() && lock.unsupported.is_empty() {
        return Ok(None);
    }
    let cache = DepCache::open(cache_dir, false, CacheQuota::default())?;
    let vendor = run_dir.join("vendor");
    let rep = cache.materialize(&lock, &vendor)?;
    let cfg = run_dir.join("cargo-config.toml");
    std::fs::write(&cfg, cargo_source_config("/work/vendor")).map_err(|e| CacheError {
        code: "materialize",
        message: format!("config: {e}"),
    })?;
    let note = serde_json::json!({
        "cache": CACHE_LABEL,
        "packages": rep.packages, "files": rep.files, "bytes": rep.bytes,
        "copiedInsteadOfLinked": rep.copied_instead_of_linked,
        "lockfile": "snapshot",
    });
    Ok(Some((
        vec![
            (vendor, "/work/vendor".to_owned()),
            (cfg, "/work/out/cargo-home/config.toml".to_owned()),
        ],
        note,
    )))
}

const CACHE_LABEL: &str = crate::depcache::CACHE_VERSION;

fn limits_from(b: &ToolBudgets, scope_wall: u64) -> SandboxLimits {
    SandboxLimits {
        wall_ms: b.proc_wall_ms.min(scope_wall).max(1),
        cpu_secs: b.proc_cpu_secs,
        memory_bytes: b.proc_memory_bytes,
        address_space_bytes: b.proc_memory_bytes.saturating_mul(4).max(1 << 30),
        max_procs: b.proc_max_procs,
        scratch_bytes: b.proc_scratch_bytes,
        stdout_cap: b.proc_output_bytes as usize,
        stderr_cap: b.proc_output_bytes as usize,
        ..Default::default()
    }
}

fn redact_stream(bytes: &[u8], truncated: bool, red: &mut Redaction) -> String {
    // When the capture was cut at the byte cap, the last line is incomplete:
    // a secret split by the cut could be a prefix too short for the
    // patterns to recognise. Drop the incomplete tail line before redaction.
    let bytes = if truncated {
        match bytes.iter().rposition(|b| *b == b'\n') {
            Some(i) => &bytes[..=i],
            None => &bytes[..0],
        }
    } else {
        bytes
    };
    let text = String::from_utf8_lossy(bytes);
    let mut r = Redactor::new();
    let mut out = String::new();
    for line in text.split('\n') {
        out.push_str(&r.line(line, red));
        out.push('\n');
    }
    // `split` yields a trailing empty piece; avoid doubling the newline.
    if out.ends_with("\n\n") {
        out.pop();
    }
    if truncated {
        out.push_str(LINE_TRUNCATED.trim());
        out.push('\n');
    }
    out
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    format!("[…earlier output omitted]\n{}", &s[start..])
}

struct Control<'a, 'h> {
    cancel: &'a CancellationToken,
    hooks: &'h mut dyn ProcessHooks,
    /// Controlled Internet: the egress service and the policy it was started with.
    egress: Option<&'a mut crate::egress_host::EgressRun>,
    net: Option<&'a crate::netpolicy::NetPolicy>,
}

impl SandboxControl for Control<'_, '_> {
    fn should_stop(&mut self) -> Option<StopReason> {
        if self.cancel.is_cancelled() {
            return Some(StopReason::Cancelled);
        }
        let fence = self.hooks.fence();
        if let (Some(e), Some(np)) = (self.egress.as_mut(), self.net) {
            if e.ended_early.is_none() {
                if fence.is_err() {
                    e.kill_now("permissions revoked");
                } else if self.hooks.net_narrowed(np) {
                    // narrowing never kills the command, but the connections it was authorized for end now
                    e.kill_now("network permissions narrowed");
                }
            }
        }
        match fence {
            Ok(()) => None,
            Err(e) => Some(StopReason::Revoked(e.message)),
        }
    }
    fn on_spawned(&mut self, pid: u32, cgroup: &str) -> Result<(), ToolError> {
        self.hooks.journal(
            PH_RUNNING,
            serde_json::json!({"pid": pid, "cgroup": cgroup}),
        )
    }
}

fn failed(
    hooks: &mut dyn ProcessHooks,
    run_dir: &Path,
    code: ToolErrorCode,
    msg: String,
) -> Result<ToolResultV1, ToolError> {
    let _ = std::fs::remove_dir_all(run_dir);
    let e = ToolError::new(code, msg);
    hooks.journal(
        PH_FAILED,
        serde_json::json!({"errorCode": e.code.as_str(), "reason": e.message, "processStarted": false}),
    )?;
    Ok(ToolResultV1::failure(
        "proc.run",
        crate::contract::TOOL_VERSION,
        e,
        ToolStats::default(),
    ))
}

/// Does the script contain a pipeline (`a | b`, not `a || b`)? Quote-unaware on purpose: a false
/// positive only adds the (harmless) pipefail handling.
pub fn script_has_pipeline(script: &str) -> bool {
    let b = script.as_bytes();
    (0..b.len()).any(|i| {
        b[i] == b'|' && (i == 0 || b[i - 1] != b'|') && b.get(i + 1).is_none_or(|n| *n != b'|')
    })
}

/// Does this shell understand `set -o pipefail`? Probed, never assumed (`dash` before 0.5.12 and
/// other POSIX shells do not). Cached per program path.
fn shell_supports_pipefail(program: &str) -> bool {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> =
        std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(v) = cache
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(program)
        .copied()
    {
        return v;
    }
    // `(set -o pipefail)` in a subshell: an unsupported option must not end the probing shell
    let ok = std::process::Command::new(program)
        .args(["-c", "(set -o pipefail) 2>/dev/null"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    cache
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(program.to_owned(), ok);
    ok
}

/// What happened to the exit status of a pipeline script.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pipefail {
    /// Not a shell pipeline: the command ran exactly as requested.
    NotApplicable,
    /// `set -o pipefail` was prepended: the status is the first failing stage's.
    Applied,
    /// The shell has no pipefail: a pipeline's status is the last stage's, so it proves nothing.
    Unsupported,
}

impl Pipefail {
    pub fn as_str(self) -> &'static str {
        match self {
            Pipefail::NotApplicable => "not-applicable",
            Pipefail::Applied => "applied",
            Pipefail::Unsupported => "unsupported",
        }
    }
}

/// Make a shell pipeline's exit status mean what it says (D5): `cargo test | tail` must fail when
/// `cargo test` fails. Rewrites the script only when it is a pipeline AND the shell supports it.
pub fn apply_pipefail(cmd: &mut ResolvedCommand) -> Pipefail {
    if !cmd.shell_pipeline || cmd.argv.len() != 2 {
        return Pipefail::NotApplicable;
    }
    if !shell_supports_pipefail(&cmd.program) {
        return Pipefail::Unsupported;
    }
    cmd.argv[1] = format!("set -o pipefail\n{}", cmd.argv[1]);
    Pipefail::Applied
}

/// The verification verdict of a finished command. A pipeline never reports a pass it cannot back:
/// without pipefail the status says nothing about the first stage, and under pipefail a status of
/// 141 means a stage was cut off by SIGPIPE (`... | head`) before it finished - its result is unknown.
pub fn verdict(exit_code: Option<i64>, pipefail: Pipefail) -> &'static str {
    match exit_code {
        Some(0) if pipefail == Pipefail::Unsupported => "unverified",
        Some(0) => "pass",
        Some(141) if pipefail == Pipefail::Applied => "unverified",
        _ => "fail",
    }
}

/// What a command changed in its throw-away copy of the project. The copy is staged read-from-the-project
/// and discarded when the command ends; nothing here is ever applied to the project. Reporting it is what
/// keeps "the command passed" from being read as "the project now has these files".
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchEffects {
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
    pub created_dirs: Vec<String>,
    /// Files among the above that matter to the project (everything except lock files the agent may
    /// not write anyway): created + modified + deleted.
    pub unsaved_files: u32,
    pub truncated: bool,
}

impl ScratchEffects {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty()
            && self.modified.is_empty()
            && self.deleted.is_empty()
            && self.created_dirs.is_empty()
    }
}

const EFFECTS_MAX_ENTRIES: usize = 60_000;
const EFFECTS_LIST_CAP: usize = 40;

/// Compare the staged tree (after the command) with what was staged (before it). Host-side, never
/// following symlinks; toolchain caches, hidden names and dependency/build directories are not reported
/// (they are not project files and the agent could not write them anyway).
pub fn scratch_effects(src: &Path, staged: &crate::stage::StageReport) -> ScratchEffects {
    use std::collections::{BTreeSet, HashMap};
    use std::io::Read;
    let policy = crate::workspace::WorkspacePolicy::default();
    let before: HashMap<&str, &str> = staged
        .manifest
        .iter()
        .map(|(p, h)| (p.as_str(), h.as_str()))
        .collect();
    let before_dirs: BTreeSet<&str> = staged.dir_paths.iter().map(String::as_str).collect();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let (mut created, mut modified, mut created_dirs) = (Vec::new(), Vec::new(), Vec::new());
    let mut entries = 0usize;
    let mut truncated = false;
    let mut stack: Vec<(PathBuf, String, u32)> = vec![(src.to_path_buf(), String::new(), 0)];
    // Hidden names the project itself had (`.gitignore`, `.eslintrc`) are compared like any file; hidden
    // things that only appeared (`.pytest_cache`, `.cargo`, `.npm`) are toolchain artifacts and not reported.
    let skip_name = |n: &str, rel: &str, is_dir: bool| {
        policy.classify_name(n) != crate::workspace::NameClass::Allowed
            || policy.is_ignored_dir(n)
            || (n.starts_with('.')
                && !(if is_dir {
                    before_dirs.contains(rel)
                } else {
                    before.contains_key(rel)
                }))
    };
    while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<_> = rd.flatten().collect();
        names.sort_by_key(|e| e.file_name());
        for e in names {
            entries += 1;
            if entries > EFFECTS_MAX_ENTRIES {
                truncated = true;
                break;
            }
            let Ok(name) = e.file_name().into_string() else {
                continue;
            };
            let Ok(md) = std::fs::symlink_metadata(e.path()) else {
                continue;
            };
            let rel_path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let ft = md.file_type();
            if skip_name(&name, &rel_path, ft.is_dir()) {
                continue;
            }
            if ft.is_dir() {
                if depth >= 32 {
                    truncated = true;
                    continue;
                }
                if !before_dirs.contains(rel_path.as_str()) {
                    created_dirs.push(rel_path.clone());
                }
                stack.push((e.path(), rel_path, depth + 1));
            } else if ft.is_file() {
                seen.insert(rel_path.clone());
                match before.get(rel_path.as_str()) {
                    None => created.push(rel_path),
                    Some(h) => {
                        // unchanged size + hash = unchanged; bounded read
                        let mut buf = Vec::new();
                        let same = md.len() <= 16 * 1024 * 1024
                            && std::fs::File::open(e.path())
                                .and_then(|f| f.take(16 * 1024 * 1024 + 1).read_to_end(&mut buf))
                                .is_ok()
                            && hex::encode(Sha256::digest(&buf)) == **h;
                        if !same {
                            modified.push(rel_path);
                        }
                    }
                }
            }
        }
    }
    let mut deleted: Vec<String> = staged
        .manifest
        .iter()
        .filter(|(p, _)| !seen.contains(p))
        .map(|(p, _)| p.clone())
        .collect();
    created.sort();
    modified.sort();
    deleted.sort();
    created_dirs.sort();
    let protected = |p: &String| {
        let base = p.rsplit('/').next().unwrap_or(p).to_ascii_lowercase();
        crate::protect::PROTECTED_NAMES.contains(&base.as_str())
    };
    let unsaved_files = created
        .iter()
        .chain(&modified)
        .chain(&deleted)
        .filter(|p| !protected(p))
        .count() as u32;
    let cap = |v: &mut Vec<String>, t: &mut bool| {
        if v.len() > EFFECTS_LIST_CAP {
            v.truncate(EFFECTS_LIST_CAP);
            *t = true;
        }
    };
    cap(&mut created, &mut truncated);
    cap(&mut modified, &mut truncated);
    cap(&mut deleted, &mut truncated);
    cap(&mut created_dirs, &mut truncated);
    ScratchEffects {
        created,
        modified,
        deleted,
        created_dirs,
        unsaved_files,
        truncated,
    }
}

/// M8 Full Access branch of `run_process`: the sealed scope is `Full`, so the
/// command runs on the host under the OS user's authority. Reached only from
/// the sealed scope — never as a fallback from a failed sandbox run.
fn run_host_branch(
    ctx: &ProcessContext<'_>,
    args: &ProcessArgs,
    cmd: &ResolvedCommand,
    cancel: &CancellationToken,
    hooks: &mut dyn ProcessHooks,
) -> Result<ToolResultV1, ToolError> {
    use crate::exec_contract::{
        check_grant, Approval, ExecBackend, ExecGrant, HostBackend, NetScope,
    };
    // Full Access enforces only `full`/`full` (ADR Rev 2 §7): any other network
    // claim for a host process would be a lie, so it is refused, not emulated.
    let net_full = ctx.grant.is_some_and(|g| g.net == "full");
    if !net_full {
        return Ok(failed_result(
            ToolErrorCode::CommandRefused,
            "Full Access requires an explicit `net=full` grant alongside `fs=full`: Nexus does not claim Offline or Controlled Internet for an unsandboxed host process. Ask the user to grant Full Network for this project, or run the command under the confined Workspace backend (nothing was run)".to_owned(),
        ));
    }
    if let Err(r) = check_grant(
        &HostBackend.caps(),
        &ExecGrant {
            fs: crate::exec_contract::FsScope::Full,
            net: NetScope::Full,
            approval: Approval::Auto,
        },
    ) {
        let e = r.into_error();
        return Ok(failed_result(e.code, e.message));
    }
    let root = PathBuf::from(ctx.ws.root_path());
    let program = match crate::host_exec::resolve_host_program(&args.program, &root) {
        Ok(p) => p,
        Err(e) => return Ok(failed_result(e.code, e.message)),
    };
    let cwd = root.join(&args.cwd);
    if !cwd.is_dir() {
        return Ok(failed_result(
            ToolErrorCode::CommandRefused,
            format!(
                "working directory '{}' does not exist in the workspace (nothing was run)",
                args.cwd
            ),
        ));
    }
    // `ResolvedCommand.argv` carries the arguments only; the program is separate.
    let mut argv: Vec<String> = vec![program.to_string_lossy().into_owned()];
    argv.extend(cmd.argv.iter().cloned());
    let wall = {
        let w = cmd.wall_ms.unwrap_or(ctx.scope_max_wall_ms);
        if w == 0 {
            600_000
        } else {
            w
        }
    };
    let (pre, pre_trunc) = crate::host_exec::project_manifest(&root, 20_000);
    hooks.journal(
        PH_PREPARED,
        serde_json::json!({
            "backend": "host/1", "fsScope": "full", "netScope": "full",
            "program": argv[0], "argv": argv, "cwd": cwd.to_string_lossy(),
            "grant": ctx.grant, "processStarted": false,
            "note": "Full Access: unsandboxed host execution under the OS user's authority; effects outside the project are not observed and cannot be undone",
        }),
    )?;
    let outcome = {
        let mut should_stop = || -> Option<&'static str> {
            if cancel.is_cancelled() {
                return Some("cancelled");
            }
            if hooks.fence().is_err() {
                return Some("revoked");
            }
            None
        };
        crate::host_exec::run_host(crate::host_exec::HostRun {
            program: program.clone(),
            argv: argv.clone(),
            cwd: cwd.clone(),
            env: crate::host_exec::host_env(&cmd.env),
            wall_ms: wall,
            tail_bytes: 256 * 1024,
            should_stop: &mut should_stop,
        })
    };
    let out = match outcome {
        Ok(o) => o,
        Err(e) => return Ok(failed_result(e.code, e.message)),
    };
    let (post, post_trunc) = crate::host_exec::project_manifest(&root, 20_000);
    let mut effects = crate::host_exec::manifest_diff(&pre, &post);
    effects["manifestTruncated"] = serde_json::json!(pre_trunc || post_trunc);
    let mut red = Redaction::default();
    let so = redact_stream(&out.stdout, out.stdout_truncated, &mut red);
    let se = redact_stream(&out.stderr, out.stderr_truncated, &mut red);
    let (code, signal) = match &out.exit {
        ExitKind::Exited(c) => (Some(*c), out.signal_hint),
        ExitKind::Signaled(s) => (None, Some(*s)),
        _ => (None, None),
    };
    let verification = verdict(code.map(i64::from), Pipefail::NotApplicable);
    let phase = match out.exit {
        ExitKind::Cancelled | ExitKind::Revoked(_) => PH_CANCELLED,
        _ => PH_EXITED,
    };
    let output_digest = {
        let mut h = Sha256::new();
        h.update(so.as_bytes());
        h.update([0]);
        h.update(se.as_bytes());
        hex::encode(h.finalize())
    };
    hooks.journal(
        phase,
        serde_json::json!({
            "backend": "host/1", "fsScope": "full", "netScope": "full",
            "reason": out.exit.reason(), "exitCode": code, "signal": signal,
            "verification": verification, "wallMs": out.wall_ms,
            "stdoutBytes": out.stdout_bytes, "stderrBytes": out.stderr_bytes,
            "stdoutTail": tail(&so, PERSISTED_TAIL_BYTES),
            "stderrTail": tail(&se, PERSISTED_TAIL_BYTES),
            "outputDigest": output_digest, "processStarted": true,
            "effects": effects, "grant": ctx.grant,
        }),
    )?;
    let mut trunc = Truncation::default();
    if out.stdout_truncated {
        trunc.add("stdout-cap");
    }
    if out.stderr_truncated {
        trunc.add("stderr-cap");
    }
    Ok(ToolResultV1::success(
        "proc.run",
        crate::contract::TOOL_VERSION,
        serde_json::json!({
            "backend": "host", "fsScope": "full", "network": "full",
            "reason": out.exit.reason(), "exitCode": code, "signal": signal,
            "verification": verification, "stdout": so, "stderr": se,
            "stdoutTruncated": out.stdout_truncated, "stderrTruncated": out.stderr_truncated,
            "wallMs": out.wall_ms, "resourceEnforcement": out.resource_enforcement,
            "writeBack": "host-filesystem",
            "persisted": "the command ran on the real host filesystem under the OS user's authority; Nexus did not copy or adopt anything",
            "effects": effects,
        }),
        trunc,
        red,
        ToolStats::default(),
    ))
}

fn failed_result(code: ToolErrorCode, message: String) -> ToolResultV1 {
    ToolResultV1::failure(
        "proc.run",
        crate::contract::TOOL_VERSION,
        ToolError::new(code, message),
        ToolStats::default(),
    )
}

/// Run one process request to a terminal lifecycle state.
pub fn run_process(
    ctx: &ProcessContext<'_>,
    args: &ProcessArgs,
    cancel: &CancellationToken,
    hooks: &mut dyn ProcessHooks,
) -> Result<ToolResultV1, ToolError> {
    let run_dir = ctx
        .run_root
        .join(crate::sandbox::cgroup_leaf_name(ctx.execution_id));
    let mut cmd = match ctx.policy.resolve(args) {
        Ok(c) => c,
        Err(e) => {
            // M8: under a sealed Full scope the HOST resolver is authoritative
            // (the workbench resolver only knows the sandbox runtime). A host
            // miss still refuses; nothing falls back to the sandbox.
            if ctx.fs_scope == crate::exec_contract::FsScope::Full {
                let root = PathBuf::from(ctx.ws.root_path());
                match crate::host_exec::resolve_host_program(&args.program, &root) {
                    Ok(host) => ResolvedCommand {
                        name: args.program.clone(),
                        program: host.to_string_lossy().into_owned(),
                        argv: args.args.clone(),
                        cwd: args.cwd.clone(),
                        env: Default::default(),
                        ro_binds: Vec::new(),
                        install: false,
                        wall_ms: None,
                        shell_pipeline: false,
                    },
                    Err(he) => return Ok(failed_result(he.code, he.message)),
                }
            } else {
                return failed(hooks, &run_dir, e.code, e.message);
            }
        }
    };
    let pipefail = apply_pipefail(&mut cmd);
    if cancel.is_cancelled() {
        return failed(
            hooks,
            &run_dir,
            ToolErrorCode::Cancelled,
            "cancelled before start".into(),
        );
    }
    if let Err(e) = hooks.fence() {
        return failed(hooks, &run_dir, ToolErrorCode::Revoked, e.message);
    }
    // M8: a sealed `Full` scope runs on the host backend. This branch is taken
    // only from the sealed scope, never as a fallback from a sandbox failure.
    if ctx.fs_scope == crate::exec_contract::FsScope::Full {
        return run_host_branch(ctx, args, &cmd, cancel, hooks);
    }
    // The grant this command runs under must be one the backend can really enforce. A refusal is final:
    // there is no substitution of another scope (ADR rev. 2 section 7.5).
    let in_place = ctx.fs_scope == crate::exec_contract::FsScope::Workspace;
    {
        use crate::exec_contract::{
            check_grant, Approval, ExecBackend, ExecGrant, LinuxBwrapBackend, NetScope,
        };
        let grant = ExecGrant {
            fs: ctx.fs_scope,
            net: if cmd.install {
                NetScope::Install
            } else {
                NetScope::Offline
            },
            approval: Approval::Auto,
        };
        if let Err(r) = check_grant(&LinuxBwrapBackend.caps(), &grant) {
            let e = r.into_error();
            return failed(hooks, &run_dir, e.code, e.message);
        }
        if in_place && !ctx.policy.is_workbench() {
            return failed(
                hooks,
                &run_dir,
                ToolErrorCode::CommandRefused,
                "in-place execution is only available with the workbench command policy (nothing was run)".into(),
            );
        }
    }
    let base = match crate::sandbox::cgroup_base() {
        Some(b) => b,
        None => {
            return failed(
                hooks,
                &run_dir,
                ToolErrorCode::SandboxUnavailable,
                "no cgroup v2 hierarchy; sandbox unavailable (nothing was run)".into(),
            )
        }
    };
    // 1. Stage the snapshot (bounded, policy-filtered, consistency-checked).
    if let Err(e) = std::fs::create_dir_all(ctx.run_root) {
        return failed(
            hooks,
            &run_dir,
            ToolErrorCode::SnapshotFailed,
            format!("run dir: {e}"),
        );
    }
    if let Err(e) = std::fs::create_dir(&run_dir) {
        return failed(
            hooks,
            &run_dir,
            ToolErrorCode::SnapshotFailed,
            format!("run dir: {e}"),
        );
    }
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700));
    }
    let src = run_dir.join("src");
    let slim = StageLimits {
        max_files: ctx.budgets.stage_max_files,
        max_bytes: ctx.budgets.stage_max_bytes,
        ..Default::default()
    };
    let mut probe = || -> Result<(), ToolError> {
        if cancel.is_cancelled() {
            return Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "cancelled during staging",
            ));
        }
        Ok(())
    };
    // In place: nothing is staged. The task's own working copy is bound by the descriptor the Workspace
    // pinned; what the command writes is the working copy (reviewed through the task's git diff).
    let exec_override = if in_place { hooks.exec_policy() } else { None };
    // A1: did `.git` exist before this command prepared its protections?
    let git_existed_before = in_place
        && std::path::Path::new(ctx.ws.root_path())
            .join(".git")
            .exists();
    let net_policy: Option<crate::netpolicy::NetPolicy> = hooks.net_policy();
    if net_policy.is_some() && !in_place {
        return failed(
            hooks,
            &run_dir,
            ToolErrorCode::SandboxUnavailable,
            "Controlled Internet is available only to commands that run in place; nothing was run"
                .into(),
        );
    }
    // legacy install-class network (host network namespace) is used only when Controlled Internet is not
    let host_net = cmd.install && net_policy.is_none();
    // where the time goes (milliseconds), recorded with the effects of every in-place command
    let mut timing: std::collections::BTreeMap<String, u64> = Default::default();
    let t_scan = std::time::Instant::now();
    let mut mount: Option<crate::inplace::InPlaceMount> = None;
    let report = if in_place {
        match crate::inplace::prepare_with(
            ctx.ws,
            &crate::inplace::PrepareOptions {
                hard_links: exec_override
                    .as_ref()
                    .map(|x| x.hard_link_policy())
                    .unwrap_or_else(|| ctx.policy.hard_links()),
                git_worktree: exec_override
                    .as_ref()
                    .is_some_and(|x| x.git_worktree == "read-only"),
                git_write: exec_override.as_ref().is_some_and(|x| x.git_write),
                forbidden: ctx.policy.forbidden_paths().to_vec(),
                ..Default::default()
            },
        ) {
            Ok(m) => {
                timing.insert(
                    "protectionScanMs".into(),
                    t_scan.elapsed().as_millis() as u64,
                );
                mount = Some(m);
                crate::stage::StageReport::default()
            }
            Err(e) => return failed(hooks, &run_dir, e.code, e.message),
        }
    } else {
        match stage_workspace(ctx.ws, &src, &slim, &mut probe, &mut |_| {}) {
            Ok(r) => r,
            Err(e) => return failed(hooks, &run_dir, e.code, e.message),
        }
    };
    hooks.at("after-stage");
    // 1b. Dependency view (A3.5): a per-execution, read-only vendor tree
    //     built only from verified cache objects named by the snapshot's
    //     own Cargo.lock; plus a generated source-replacement config.
    let mut dep_note = serde_json::Value::Null;
    if let (Some(dir), "cargo") = (&ctx.policy.dep_cache, cmd.name.as_str()) {
        if args.args.first().map(String::as_str) != Some("fmt") {
            let dep_src = if in_place {
                PathBuf::from(ctx.ws.root_path())
            } else {
                src.clone()
            };
            match prepare_dependency_view(dir, &dep_src, &cmd.cwd, &run_dir) {
                Ok(Some((binds, note))) => {
                    cmd.ro_binds.extend(binds);
                    cmd.env.insert("CARGO_INCREMENTAL".into(), "0".into());
                    cmd.env.insert("CARGO_PROFILE_DEV_DEBUG".into(), "0".into());
                    dep_note = note;
                }
                Ok(None) => {}
                Err(e) => {
                    return failed(
                        hooks,
                        &run_dir,
                        ToolErrorCode::DependencyUnavailable,
                        e.to_string(),
                    )
                }
            }
        }
    }
    // 1c. Project environment (workbench): a persistent directory for dependencies and
    //     caches mounted at /work/env, with stored node_modules mounted over the sources.
    let mut rw_binds: Vec<(PathBuf, String)> = Vec::new();
    if ctx.policy.is_workbench() {
        let env_dir = match ctx.env {
            Some(e) => e.dir.join("shared"),
            None => run_dir.join("env"),
        };
        if let Err(e) = std::fs::create_dir_all(&env_dir) {
            return failed(
                hooks,
                &run_dir,
                ToolErrorCode::SnapshotFailed,
                format!("environment dir: {e}"),
            );
        }
        rw_binds.push((env_dir, "/work/env".to_owned()));
        if host_net {
            match ctx.env {
                Some(e) if e.installs => {}
                _ => {
                    return failed(
                        hooks,
                        &run_dir,
                        ToolErrorCode::CommandRefused,
                        "installing dependencies is not enabled for this project (it can be enabled in the project's settings)".into(),
                    )
                }
            }
        } else if let (Some(e), false) = (ctx.env, in_place) {
            // (in place, dependencies live in the working copy itself)
            rw_binds.extend(stored_node_modules(e));
        }
        if cmd.name == "cargo" || cmd.name == "go" {
            // toolchain homes live in the shared environment
        }
    }
    // 2. Sandbox configuration.
    let mut limits = limits_from(ctx.budgets, ctx.scope_max_wall_ms);
    if ctx.policy.is_workbench() {
        // Modern runtimes (V8 WebAssembly, Go, the .NET GC) RESERVE far more address space
        // than they use. Real memory stays bounded by the resident-memory ceiling; the
        // address-space rlimit is only a backstop.
        limits.address_space_bytes = limits
            .memory_bytes
            .saturating_mul(16)
            .max(32 * 1024 * 1024 * 1024);
    }
    if let Some(w) = cmd.wall_ms {
        limits.wall_ms = limits.wall_ms.max(w.min(ctx.scope_max_wall_ms.max(1)));
    }
    // The network is off, but programs still resolve `localhost` (test runners bind a loopback
    // server): give the sandbox a minimal hosts file of its own - never the host's.
    let mut ro_binds = cmd.ro_binds.clone();
    if !host_net {
        let hosts = run_dir.join("sandbox-hosts");
        if std::fs::write(&hosts, "127.0.0.1 localhost\n::1 localhost ip6-localhost\n").is_ok() {
            ro_binds.push((hosts, "/etc/hosts".to_owned()));
        }
    }
    // M3C: an in-place command runs behind the launch gate (namespace verification + Landlock), or not at all.
    let confine = if in_place {
        match build_confine(ctx, host_net) {
            Ok(c) => Some(c),
            Err(m) => {
                return failed(hooks, &run_dir, ToolErrorCode::SandboxUnavailable, m);
            }
        }
    } else {
        None
    };
    // Controlled Internet: the egress service first; without it the command does not start.
    let mut egress: Option<crate::egress_host::EgressRun> = None;
    if let Some(np) = &net_policy {
        match crate::egress_host::start(ctx.policy.egress_settings(), &run_dir, np) {
            Ok(e) => egress = Some(e),
            Err(m) => return failed(hooks, &run_dir, ToolErrorCode::SandboxUnavailable, m),
        }
    }
    let mut cmd_env = cmd.env.clone();
    if net_policy.is_some() {
        controlled_env(&mut cmd_env);
    }
    let net_label = if net_policy.is_some() {
        "controlled"
    } else if cmd.install {
        "install"
    } else {
        "none"
    };
    let spec = SandboxSpec {
        id: ctx.execution_id.to_owned(),
        program: cmd.program.clone(),
        args: cmd.argv.clone(),
        src_dir: if in_place {
            PathBuf::new()
        } else {
            src.clone()
        },
        cwd: cmd.cwd.clone(),
        env: cmd_env,
        ro_binds,
        rw_binds,
        src_writable: ctx.policy.is_workbench(),
        pinned_root: mount.as_ref().map(|m| m.root_fd()),
        protect: mount.as_ref().map(|m| m.protect()).unwrap_or_default(),
        fd_ro_binds: mount.as_ref().map(|m| m.fd_ro_binds()).unwrap_or_default(),
        dev: None,
        egress: egress.as_ref().map(|e| crate::sandbox::EgressSpec {
            socket: e.socket(),
            http_port: crate::egress::PROXY_PORT,
            forward_ports: net_policy
                .as_ref()
                .map(|n| n.local_ports.clone())
                .unwrap_or_default(),
            policy_digest: e.policy_digest.clone(),
        }),
        net: host_net,
        limits: limits.clone(),
        cgroup_base: base.clone(),
        confine,
    };
    let sbx_digest = sandbox_digest(&spec);
    let unit = crate::sandbox::cgroup_leaf_name(ctx.execution_id);
    let kernel_mode = match limits.backend {
        crate::sandbox::ResourceBackend::Polling => false,
        _ => crate::sandbox::kernel_limits_available(),
    };
    let cgroup_path = if kernel_mode {
        crate::sandbox::expected_scope_path(&unit).unwrap_or_else(|| base.join(&unit))
    } else {
        base.join(&unit)
    };
    // 2b. In place: describe the workspace BEFORE the command, through the pinned descriptor, and make that
    //     description durable together with the execution's intent. (Scratch runs are not observed.)
    let eff_dir = crate::observe::effects_dir(ctx.run_root);
    let obs_budget = ctx.policy.observe_budget().clone();
    let mut observation: Option<(crate::observe::Manifest, bool, bool, u64)> = None;
    let mut ck_pol = ctx.policy.checkpoint_policy().clone();
    if let Some(x) = &exec_override {
        ck_pol.mode = x.checkpoint_mode();
    }
    let ck_store = crate::checkpoint::store_dir(ctx.run_root);
    let mut ck: Option<Result<crate::checkpoint::Index, crate::checkpoint::Failure>> = None;
    if in_place {
        let started = crate::observe::now_ms();
        let t_pre = std::time::Instant::now();
        let pre = crate::observe::observe(ctx.ws, &obs_budget);
        timing.insert(
            "preObservationMs".into(),
            t_pre.elapsed().as_millis() as u64,
        );
        let persisted = crate::observe::write_pre(&eff_dir, ctx.execution_id, &pre).is_ok();
        let leads = crate::observe::path_still_leads_to(ctx.ws);
        // 2c. Preserve what the command could change, outside its writable view, before it exists.
        if ck_pol.mode != crate::checkpoint::Mode::Off {
            crash_point("checkpoint-before");
            let t_ck = std::time::Instant::now();
            let r = crate::checkpoint::create(ctx.ws, &ck_store, ctx.execution_id, &pre, &ck_pol);
            timing.insert("checkpointMs".into(), t_ck.elapsed().as_millis() as u64);
            let complete = matches!(&r, Ok(i) if i.status == "complete");
            if ck_pol.mode == crate::checkpoint::Mode::Required && !complete {
                let why = match &r {
                    Ok(i) => i.reasons.join(","),
                    Err(f) => f.reasons.join(","),
                };
                crate::checkpoint::remove(&ck_store, ctx.execution_id);
                crate::observe::remove_pre(&eff_dir, ctx.execution_id);
                return failed(
                    hooks,
                    &run_dir,
                    ToolErrorCode::CommandRefused,
                    format!("checkpoint-required: no complete checkpoint ({why}); nothing ran"),
                );
            }
            ck = Some(r);
        }
        observation = Some((pre, persisted, leads, started));
    }
    // 3. Durable intent BEFORE spawn: identity, digests, limits, cgroup
    //    and run directory (so recovery can find and kill a leftover).
    let mut prepared_record = serde_json::json!({
        "command": cmd.display(),
        "program": cmd.name,
        "argvDigest": cmd.argv_digest(),
        "cwd": cmd.cwd,
        "snapshotDigest": report.digest,
        "snapshotFiles": report.files,
        "snapshotBytes": report.bytes,
        "snapshotSkipped": {
            "hidden": report.skipped_hidden, "sensitive": report.skipped_sensitive,
            "ignored": report.skipped_ignored, "symlinks": report.skipped_symlinks,
            "special": report.skipped_special, "hardlinks": report.skipped_hardlinks,
            "mountCrossing": report.skipped_mount_crossing, "large": report.skipped_large,
        },
        "sandboxDigest": sbx_digest,
        "dependencies": dep_note,
        "sandbox": {
            "backend": "bubblewrap+seccomp+cgroup-v2", "network": net_label,
            "rootfs": "synthetic (usr ro, tmpfs scratch)", "workspace": if ctx.policy.is_workbench() { "snapshot-scratch" } else { "snapshot-ro" },
            "writeBack": "none", "env": "allowlist",
        },
        "resourceEnforcement": if kernel_mode { "kernel-cgroup" } else { "rlimit-polling" },
        "limits": {
            "wallMs": limits.wall_ms, "cpuSecs": limits.cpu_secs,
            "memoryBytes": limits.memory_bytes, "maxProcs": limits.max_procs,
            "outputBytes": limits.stdout_cap, "scratchBytes": limits.scratch_bytes,
        },
        "cgroup": cgroup_path.display().to_string(),
        "runDir": run_dir.display().to_string(),
    });
    if let (Some((pre, persisted, leads, started)), Some(o)) =
        (&observation, prepared_record.as_object_mut())
    {
        // The durable observation boundary: what was seen before the process existed, and where.
        o.insert(
            "observation".into(),
            serde_json::json!({
                "startedAtMs": started,
                "workspace": pre.root,
                "rootPath": ctx.ws.root_path(),
                "pathLeadsToPinnedRoot": leads,
                "pre": crate::observe::ManifestBrief::of(pre),
                "preManifestPersisted": persisted,
                "budget": obs_budget,
                "attribution": "temporal",
            }),
        );
    }
    if let (Some(r), Some(o)) = (&ck, prepared_record.as_object_mut()) {
        o.insert("checkpoint".into(), checkpoint_brief(r, &ck_pol));
    }
    if let (Some(g), Some(o)) = (ctx.grant, prepared_record.as_object_mut()) {
        // Audit: under which permissions this command was allowed to run (sealed by the Kernel).
        o.insert("grant".into(), serde_json::to_value(g).unwrap_or_default());
    }
    if let (true, Some(m), Some(o)) = (in_place, &mount, prepared_record.as_object_mut()) {
        // In place the record must say what is true: nothing was staged, the working copy is written.
        o.insert("snapshotDigest".into(), serde_json::Value::Null);
        o.insert("fsScope".into(), "workspace".into());
        let sb = o.get_mut("sandbox").and_then(|v| v.as_object_mut());
        if let Some(sb) = sb {
            sb.insert("workspace".into(), "task-working-copy-in-place".into());
            sb.insert("writeBack".into(), "in-place".into());
            sb.insert("rootMount".into(), "descriptor-bound".into());
            sb.insert("protected".into(), m.summary.clone());
            if let Some(c) = &spec.confine {
                sb.insert(
                    "confinement".into(),
                    serde_json::json!({
                        "launchGate": "verifies the namespace, applies Landlock, then executes the command",
                        "landlockAbi": crate::confine::landlock_abi(),
                        "minAbi": c.min_abi,
                        "scopingRequired": c.require_scope,
                        "scoping": crate::confine::landlock_abi().is_some_and(|a| a >= crate::confine::SCOPE_ABI),
                        "gateSha256": c.shim_sha256,
                    }),
                );
            }
        }
        o.insert(
            "effects".into(),
            "not observed by the process layer in this build; the task's git diff shows file changes".into(),
        );
    }
    hooks.journal(PH_PREPARED, prepared_record)?;
    crash_point("proc-after-prepared");
    let _ = bwrap_argv; // (argv is part of `sandboxDigest`)
                        // 4. Last fence, then run.
    if cancel.is_cancelled() {
        let _ = std::fs::remove_dir_all(&run_dir);
        crate::observe::remove_pre(&eff_dir, ctx.execution_id);
        crate::checkpoint::remove(&ck_store, ctx.execution_id);
        hooks.journal(
            PH_CANCELLED,
            serde_json::json!({"reason": "cancelled", "processStarted": false}),
        )?;
        return Ok(cancelled_result());
    }
    if let Err(e) = hooks.fence() {
        let _ = std::fs::remove_dir_all(&run_dir);
        crate::observe::remove_pre(&eff_dir, ctx.execution_id);
        crate::checkpoint::remove(&ck_store, ctx.execution_id);
        hooks.journal(
            PH_CANCELLED,
            serde_json::json!({"reason": "revoked", "detail": e.message, "processStarted": false}),
        )?;
        return Ok(cancelled_result());
    }
    let t_run = std::time::Instant::now();
    let outcome = {
        let mut control = Control {
            cancel,
            hooks,
            egress: egress.as_mut(),
            net: net_policy.as_ref(),
        };
        run_sandboxed(&spec, &mut control)
    };
    // the egress service ends with the command; what it saw is summarised (destinations, ports, bytes)
    let net_summary = egress.as_mut().map(|e| e.finish());
    timing.insert("launchAndRunMs".into(), t_run.elapsed().as_millis() as u64);
    // A successful install keeps its node_modules for the commands that follow.
    let mut env_note = serde_json::Value::Null;
    if let (true, false, Ok(o), Some(e)) = (cmd.install, in_place, &outcome, ctx.env) {
        if matches!(o.exit, ExitKind::Exited(0)) {
            env_note = match harvest_node_modules(&src, e) {
                Ok(n) => serde_json::json!({ "nodeModulesKept": n }),
                Err(m) => serde_json::json!({ "nodeModulesKept": false, "error": m }),
            };
        }
    }
    // What the command did to its scratch copy (never applied to the project), read before the copy goes.
    let effects = (ctx.policy.is_workbench() && !in_place && outcome.is_ok())
        .then(|| scratch_effects(&src, &report))
        .filter(|e| !e.is_empty());
    let _ = std::fs::remove_dir_all(&run_dir);
    // In place: observe what the workspace looks like now and record the difference. `run_sandboxed` returns
    // Ok only after the execution cgroup was emptied; an error means the tree may not have settled.
    let mut ledger: Option<crate::observe::EffectsRecord> = None;
    if observation.is_some() {
        crash_point("proc-before-observation");
    }
    if let Some((pre, _, _, started)) = observation.take() {
        if outcome.is_err() {
            kill_and_remove_cgroup(&cgroup_path);
        }
        let state = match &outcome {
            Ok(o) => crate::observe::ProcessState {
                exited: true,
                how: o.exit.reason().into(),
                exit_code: match &o.exit {
                    ExitKind::Exited(c) => Some(i64::from(*c)),
                    _ => None,
                },
                settled: true,
            },
            Err(_) => crate::observe::ProcessState {
                exited: false,
                how: "unknown".into(),
                exit_code: None,
                settled: false,
            },
        };
        ledger = Some(finish_observation(
            ctx,
            &eff_dir,
            &obs_budget,
            pre,
            started,
            state,
            ck.as_ref(),
            &ck_store,
            &ck_pol,
            std::mem::take(&mut timing),
            net_summary.clone(),
        ));
    }
    let out = match outcome {
        Ok(o) => o,
        Err(e) => {
            // Spawn/cleanup failure. The cgroup is killed best-effort.
            kill_and_remove_cgroup(&cgroup_path);
            if let Some(rec) = &ledger {
                hooks.effects(rec);
            }
            return failed(hooks, &run_dir, e.code, e.message);
        }
    };
    crash_point("proc-after-exit");
    if let Some(rec) = &ledger {
        crash_point("proc-after-observation");
        hooks.effects(rec);
    }
    // 5. Redact + bound, then record the explicit outcome.
    let mut red = Redaction::default();
    let so = redact_stream(&out.stdout, out.stdout_truncated, &mut red);
    let se = redact_stream(&out.stderr, out.stderr_truncated, &mut red);
    let (code, signal) = match &out.exit {
        ExitKind::Exited(c) => (Some(*c), out.signal_hint),
        ExitKind::Signaled(s) => (None, Some(*s)),
        _ => (None, None),
    };
    let reason = out.exit.reason();
    let mut verification = verdict(
        match &out.exit {
            ExitKind::Exited(c) => Some(i64::from(*c)),
            _ => None,
        },
        pipefail,
    );
    // A command whose effects could not be established cannot be reported as verified.
    if ledger.as_ref().is_some_and(|l| l.outcome == "uncertain") && verification == "pass" {
        verification = "unverified";
    }
    let phase = match out.exit {
        ExitKind::Cancelled | ExitKind::Revoked(_) => PH_CANCELLED,
        _ => PH_EXITED,
    };
    let output_digest = {
        let mut h = Sha256::new();
        h.update(so.as_bytes());
        h.update([0]);
        h.update(se.as_bytes());
        hex::encode(h.finalize())
    };
    let record = serde_json::json!({
        "reason": reason,
        "exitCode": code,
        "signal": signal,
        "verification": verification, "pipefail": pipefail.as_str(),
        "wallMs": out.wall_ms, "userMs": out.user_ms, "sysMs": out.sys_ms,
        "maxRssKb": out.max_rss_kb, "peakRssBytes": out.peak_rss_bytes, "peakProcs": out.peak_procs,
        "stdoutBytes": out.stdout_bytes, "stderrBytes": out.stderr_bytes,
        "stdoutTruncated": out.stdout_truncated, "stderrTruncated": out.stderr_truncated,
        "stdoutTail": tail(&so, PERSISTED_TAIL_BYTES),
        "stderrTail": tail(&se, PERSISTED_TAIL_BYTES),
        "outputDigest": output_digest,
        "redaction": red,
        "processStarted": true,
        "snapshotDigest": report.digest,
        "sandboxDigest": sbx_digest,
    });
    let mut record = record;
    if let (Some(e), Some(o)) = (&effects, record.as_object_mut()) {
        // audit: the command changed its scratch copy and none of it reached the project
        o.insert(
            "scratchEffects".into(),
            serde_json::json!({
                "persisted": false, "created": e.created.len(), "modified": e.modified.len(),
                "deleted": e.deleted.len(), "createdDirs": e.created_dirs.len(),
                "unsavedFiles": e.unsaved_files,
            }),
        );
    }
    if let (Some(g), Some(o)) = (ctx.grant, record.as_object_mut()) {
        o.insert("grant".into(), serde_json::to_value(g).unwrap_or_default());
    }
    if let (true, Some(o)) = (in_place, record.as_object_mut()) {
        o.insert("snapshotDigest".into(), serde_json::Value::Null);
        o.insert("fsScope".into(), "workspace".into());
        o.insert("writeBack".into(), "in-place".into());
    }
    if let (Some(l), Some(o)) = (&ledger, record.as_object_mut()) {
        o.insert("effects".into(), crate::observe::summary(l, 20));
    }
    if let (Some(n), Some(o)) = (&net_summary, record.as_object_mut()) {
        o.insert("network".into(), n.clone());
    }
    hooks.journal(phase, record)?;
    let output = serde_json::json!({
        "reason": reason, "exitCode": code, "signal": signal,
        "verification": verification, "pipefail": pipefail.as_str(),
        "stdout": so, "stderr": se,
        "stdoutTruncated": out.stdout_truncated, "stderrTruncated": out.stderr_truncated,
        "wallMs": out.wall_ms, "userMs": out.user_ms, "sysMs": out.sys_ms,
        "peakRssBytes": out.peak_rss_bytes, "peakProcs": out.peak_procs,
        "resourceEnforcement": out.resource_enforcement,
        "oomKilled": out.oom_killed, "pidsLimitHit": out.pids_limit_hit,
        "snapshotDigest": report.digest, "sandboxDigest": sbx_digest,
        "network": net_label, "writeBack": "none",
        "environment": env_note,
    });
    let mut output = output;
    if let (Some(n), Some(o)) = (&net_summary, output.as_object_mut()) {
        o.insert("networkSummary".into(), n.clone());
    }
    if let (true, Some(o)) = (in_place, output.as_object_mut()) {
        o.insert("snapshotDigest".into(), serde_json::Value::Null);
        o.insert("fsScope".into(), "workspace".into());
        o.insert("writeBack".into(), "in-place".into());
        o.insert(
            "persisted".into(),
            "files the command created or changed are in the task's working copy".into(),
        );
    }
    if let (Some(l), Some(o)) = (&ledger, output.as_object_mut()) {
        o.insert("effects".into(), crate::observe::summary(l, 40));
    }
    // A1 (M6 closure): mount protection is prepared from entries that EXIST before the command.
    // A `.git` created BY this command (git init, a script, any program) is therefore writable
    // inside that one command — hooks/config included — whatever the grant says; it is fully
    // protected from the next command on. Never let that pass silently: say so in the result.
    if in_place {
        let git_now = std::path::Path::new(ctx.ws.root_path())
            .join(".git")
            .exists();
        if git_now && !git_existed_before {
            if let Some(o) = output.as_object_mut() {
                o.insert(
                    "gitMetadataCreated".into(),
                    serde_json::json!({
                        "byThisCommand": true,
                        "mountProtectedInThisCommand": false,
                        "note": "this command created .git; metadata written inside the creating command (including hooks/config) is not mount-protected — it is protected from the next command on",
                    }),
                );
            }
        }
    }
    if let (Some(e), Some(o)) = (&effects, output.as_object_mut()) {
        let mut v = serde_json::to_value(e).unwrap_or_default();
        v["persisted"] = serde_json::json!(false);
        o.insert("scratchEffects".into(), v);
    }
    let mut trunc = Truncation::default();
    if out.stdout_truncated {
        trunc.add("stdout-cap");
    }
    if out.stderr_truncated {
        trunc.add("stderr-cap");
    }
    Ok(ToolResultV1::success(
        "proc.run",
        crate::contract::TOOL_VERSION,
        output,
        trunc,
        red,
        ToolStats::default(),
    ))
}

/// Post-state observation, comparison, outcome and durable ledger write for one in-place execution.
#[allow(clippy::too_many_arguments)]
fn finish_observation(
    ctx: &ProcessContext<'_>,
    dir: &Path,
    budget: &crate::observe::ObserveBudget,
    pre: crate::observe::Manifest,
    started: u64,
    state: crate::observe::ProcessState,
    ck: Option<&Result<crate::checkpoint::Index, crate::checkpoint::Failure>>,
    ck_store: &Path,
    ck_pol: &crate::checkpoint::CheckpointPolicy,
    mut timing: std::collections::BTreeMap<String, u64>,
    network: Option<serde_json::Value>,
) -> crate::observe::EffectsRecord {
    use crate::observe as ob;
    let t_post = std::time::Instant::now();
    let post = ob::observe(ctx.ws, budget);
    crash_point("proc-during-observation");
    let (mut fx, changed) = ob::diff(&pre, &post, budget);
    ob::hash_changed(ctx.ws, &changed, &mut fx, budget);
    let (ck_value, recov) = match ck {
        Some(r) => (
            Some(checkpoint_brief(r, ck_pol)),
            Some(crate::checkpoint::assess(r.as_ref().ok(), &fx)),
        ),
        None => (None, None),
    };
    let post_state = ob::post_state_of(&post, &fx);
    let identity_ok = ob::root_identity(ctx.ws).is_some_and(|r| r == pre.root);
    let (mut outcome, mut reasons) = ob::judge(&pre, Some(&post), &state, identity_ok);
    let mut rec = ob::EffectsRecord {
        schema: ob::RECORD_SCHEMA.into(),
        execution_id: ctx.execution_id.into(),
        task_instance_id: ctx.task_instance_id.into(),
        command_id: ctx.command_id.into(),
        workspace: pre.root.clone(),
        grant: ctx.grant.and_then(|g| serde_json::to_value(g).ok()),
        fs_scope: "workspace".into(),
        started_ms: started,
        ended_ms: ob::now_ms(),
        pre: ob::ManifestBrief::of(&pre),
        post: Some(ob::ManifestBrief::of(&post)),
        process: state,
        effects: fx,
        outcome: outcome.clone(),
        outcome_reasons: reasons.clone(),
        checkpoint: ck_value,
        recoverability: recov,
        post_state,
        timing_ms: Default::default(),
        network,
        attribution: "temporal".into(),
        note: ob::ATTRIBUTION_NOTE.into(),
        digest: String::new(),
    };
    timing.insert(
        "postObservationMs".into(),
        t_post.elapsed().as_millis() as u64,
    );
    rec.timing_ms = timing;
    rec.digest = rec.compute_digest();
    if ob::write_record(dir, &rec).is_err() {
        // The evidence could not be stored: say so rather than pretend.
        outcome = "uncertain".into();
        reasons.push("ledger-write-failed".into());
        rec.outcome = outcome;
        rec.outcome_reasons = reasons;
        rec.digest = rec.compute_digest();
    }
    ob::remove_pre(dir, ctx.execution_id);
    if ck.is_some() {
        crate::checkpoint::finish(ck_store, ctx.execution_id);
    }
    rec
}

/// The environment of a command under Controlled Internet: every common client is pointed at the bridge, and
/// the "offline" switches of the offline profile are removed (the network is only reachable through the
/// policy, so they would only break builds). Whatever the command sets itself changes nothing: the sandbox has
/// no other route.
fn controlled_env(env: &mut BTreeMap<String, String>) {
    for k in ["CARGO_NET_OFFLINE", "npm_config_offline", "PIP_NO_INDEX"] {
        env.remove(k);
    }
    if env.get("GOPROXY").map(String::as_str) == Some("off") {
        env.remove("GOPROXY");
    }
    let proxy = format!("http://127.0.0.1:{}", crate::egress::PROXY_PORT);
    for k in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        env.insert(k.into(), proxy.clone());
    }
    // traffic to the sandbox's OWN loopback (the bridge forwards of granted local ports) never goes via the proxy;
    // nothing else is exempt
    for k in ["NO_PROXY", "no_proxy"] {
        env.insert(k.into(), "127.0.0.1,localhost,::1".into());
    }
    // Node's built-in fetch ignores proxy variables unless asked
    env.insert("NODE_USE_ENV_PROXY".into(), "1".into());
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    env.insert("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into());
}

/// The launch-gate configuration of an in-place command, or the reason there cannot be one (fail closed).
fn build_confine(
    ctx: &ProcessContext<'_>,
    net: bool,
) -> Result<crate::sandbox::ConfineSpec, String> {
    let abi = crate::confine::landlock_abi().ok_or_else(|| {
        "kernel confinement (Landlock) is unavailable on this machine; in-place execution refused (nothing was run and no weaker backend was used)".to_owned()
    })?;
    if abi < crate::confine::MIN_ABI {
        return Err(format!(
            "Landlock ABI {abi} is below the required {}; in-place execution refused (nothing was run)",
            crate::confine::MIN_ABI
        ));
    }
    if net && abi < crate::confine::SCOPE_ABI {
        return Err(format!(
            "a command with network access needs abstract-socket and signal scoping (Landlock ABI {}); this kernel has {abi}; refused (nothing was run)",
            crate::confine::SCOPE_ABI
        ));
    }
    let shim = ctx.policy.confine_shim().ok_or_else(|| {
        "the confinement launch gate (nexus-confine) was not found next to the running executable; in-place execution refused (nothing was run)".to_owned()
    })?;
    let sha = crate::confine_host::shim_is_trustworthy(&shim)
        .map_err(|e| format!("{e}; in-place execution refused (nothing was run)"))?;
    let root = crate::observe::root_identity(ctx.ws)
        .ok_or_else(|| "cannot identify the workspace root; refused".to_owned())?;
    Ok(crate::sandbox::ConfineSpec {
        shim,
        shim_sha256: sha,
        root: (root.dev, root.ino),
        min_abi: crate::confine::MIN_ABI,
        require_scope: net,
    })
}

/// Bounded description of a checkpoint attempt for the journal and the effects record.
fn checkpoint_brief(
    r: &Result<crate::checkpoint::Index, crate::checkpoint::Failure>,
    pol: &crate::checkpoint::CheckpointPolicy,
) -> serde_json::Value {
    let mut v = match r {
        Ok(i) => i.brief(),
        Err(f) => serde_json::json!({
            "status": "unavailable", "reasons": f.reasons, "consistency": "non-atomic",
        }),
    };
    v["policy"] = serde_json::to_value(pol.mode).unwrap_or_default();
    v
}

fn cancelled_result() -> ToolResultV1 {
    ToolResultV1::failure(
        "proc.run",
        crate::contract::TOOL_VERSION,
        ToolError::new(
            ToolErrorCode::Cancelled,
            "execution cancelled; no process ran",
        ),
        ToolStats::default(),
    )
}

/// Startup reconciliation payload for one open process request: kill a
/// leftover cgroup, remove the run directory. Never restarts anything.
pub fn observe_process_for_recovery(
    prepared: &serde_json::Value,
    running: Option<&serde_json::Value>,
    ids: (&str, &str, &str),
) -> serde_json::Value {
    let cg = prepared
        .get("cgroup")
        .and_then(|v| v.as_str())
        .map(PathBuf::from);
    let rd = prepared
        .get("runDir")
        .and_then(|v| v.as_str())
        .map(PathBuf::from);
    let mut killed = None;
    if let Some(cg) = &cg {
        // Only ever touch a cgroup directory we named `nexus-exec-*`.
        let ok = cg
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("nexus-exec-"))
            .unwrap_or(false);
        if ok && cg.exists() {
            killed = Some(kill_and_remove_cgroup(cg));
        }
    }
    let mut dir_removed = false;
    if let Some(rd) = &rd {
        let ok = rd
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("nexus-exec-"))
            .unwrap_or(false);
        if ok && rd.exists() {
            dir_removed = std::fs::remove_dir_all(rd).is_ok();
        }
    }
    let mut v = serde_json::json!({
        "reason": "no terminal record (daemon crash or restart); never restarted",
        "processStarted": running.is_some(),
        "outcome": if running.is_some() { "uncertain" } else { "never-started" },
        "leftoverProcessesKilled": killed,
        "runDirRemoved": dir_removed,
    });
    if let Some(e) = recover_effects(prepared, running.is_some(), ids) {
        v["effects"] = e;
    }
    v
}

/// Recovery of the effects of an in-place execution that has no terminal record: the process tree is gone
/// (killed above), so observe the workspace again and compare with the pre-manifest that was persisted
/// before the process started. The result is always `uncertain` (nobody saw the process end).
fn recover_effects(
    prepared: &serde_json::Value,
    started: bool,
    (exec_id, task_id, command_id): (&str, &str, &str),
) -> Option<serde_json::Value> {
    use crate::observe as ob;
    let obs = prepared.get("observation")?;
    let run_dir = PathBuf::from(prepared.get("runDir")?.as_str()?);
    let dir = ob::effects_dir(run_dir.parent()?);
    // A record written before the crash (the process ended and was observed) is authoritative evidence of
    // what happened, but the end was never journaled: still uncertain.
    if let Some(mut rec) = ob::read_record(&dir, exec_id) {
        rec.outcome = "uncertain".into();
        rec.outcome_reasons.push("recovered-after-crash".into());
        return Some(ob::summary(&rec, 20));
    }
    let uncertain = |why: &str| {
        Some(serde_json::json!({
            "outcome": "uncertain", "outcomeReasons": [why, "recovered-after-crash"],
            "complete": false, "attribution": "temporal", "note": ob::ATTRIBUTION_NOTE,
        }))
    };
    if !started {
        ob::remove_pre(&dir, exec_id);
        return None;
    }
    let Some(pre) = ob::read_pre(&dir, exec_id) else {
        return uncertain("pre-manifest-unavailable");
    };
    let root = obs.get("rootPath").and_then(|v| v.as_str())?;
    let Ok(ws) =
        crate::workspace::Workspace::open_root(root, crate::workspace::WorkspacePolicy::default())
    else {
        return uncertain("root-unavailable");
    };
    let identity_ok = ob::root_identity(&ws).is_some_and(|r| r == pre.root);
    let budget: ob::ObserveBudget = obs
        .get("budget")
        .and_then(|b| serde_json::from_value(b.clone()).ok())
        .unwrap_or_default();
    let post = ob::observe(&ws, &budget);
    let (mut fx, changed) = ob::diff(&pre, &post, &budget);
    if identity_ok {
        ob::hash_changed(&ws, &changed, &mut fx, &budget);
    }
    let state = ob::ProcessState {
        exited: false,
        how: "unknown".into(),
        exit_code: None,
        settled: true,
    };
    // The checkpoint the execution made before it started (evidence only: recovery never rolls back).
    let ck_store = crate::checkpoint::store_dir(run_dir.parent()?);
    let (ck_value, recov) = match prepared.get("checkpoint") {
        Some(c) if c.get("id").is_some() => {
            let id = c["id"].as_str().unwrap_or_default();
            let idx = crate::checkpoint::read_index(&ck_store, id);
            let v = match &idx {
                Ok(i) => {
                    let mut b = i.brief();
                    b["policy"] = c.get("policy").cloned().unwrap_or_default();
                    b
                }
                Err(e) => serde_json::json!({"id": id, "status": "unreadable", "reasons": [e]}),
            };
            let rc = crate::checkpoint::assess(idx.as_ref().ok(), &fx);
            crate::checkpoint::finish(&ck_store, id);
            (Some(v), Some(rc))
        }
        Some(c) => (Some(c.clone()), Some(crate::checkpoint::assess(None, &fx))),
        None => (None, None),
    };
    let (_, mut reasons) = ob::judge(&pre, Some(&post), &state, identity_ok);
    reasons.push("recovered-after-crash".into());
    let mut rec = ob::EffectsRecord {
        schema: ob::RECORD_SCHEMA.into(),
        execution_id: exec_id.into(),
        task_instance_id: task_id.into(),
        command_id: command_id.into(),
        workspace: pre.root.clone(),
        grant: prepared.get("grant").cloned(),
        fs_scope: "workspace".into(),
        started_ms: obs.get("startedAtMs").and_then(|v| v.as_u64()).unwrap_or(0),
        ended_ms: ob::now_ms(),
        pre: ob::ManifestBrief::of(&pre),
        post: Some(ob::ManifestBrief::of(&post)),
        process: state,
        post_state: ob::post_state_of(&post, &fx),
        timing_ms: Default::default(),
        network: None,
        checkpoint: ck_value,
        recoverability: recov,
        effects: fx,
        outcome: "uncertain".into(),
        outcome_reasons: reasons,
        attribution: "temporal".into(),
        note: ob::ATTRIBUTION_NOTE.into(),
        digest: String::new(),
    };
    rec.digest = rec.compute_digest();
    if ob::write_record(&dir, &rec).is_ok() {
        ob::remove_pre(&dir, exec_id);
    }
    Some(ob::summary(&rec, 20))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged(
        files: &[(&str, &str)],
    ) -> (
        tempfile::TempDir,
        tempfile::TempDir,
        crate::stage::StageReport,
    ) {
        let proj = tempfile::tempdir().unwrap();
        for (p, c) in files {
            let f = proj.path().join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, c).unwrap();
        }
        let root = std::fs::canonicalize(proj.path()).unwrap();
        let ws = crate::workspace::Workspace::open_root(
            root.to_str().unwrap(),
            crate::workspace::WorkspacePolicy::default(),
        )
        .unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("src");
        let rep = crate::stage::stage_workspace(
            &ws,
            &dest,
            &crate::stage::StageLimits::default(),
            &mut || Ok(()),
            &mut |_| {},
        )
        .unwrap();
        (proj, out, rep)
    }

    #[test]
    fn scratch_effects_report_exactly_what_a_command_changed_and_nothing_it_did_not() {
        let (_p, out, rep) = staged(&[
            (".gitignore", "target\n"),
            ("a.txt", "one\n"),
            ("sub/b.txt", "two\n"),
            ("Cargo.lock", "v1\n"),
        ]);
        let src = out.path().join("src");
        // a command that changes nothing reports nothing (a staged hidden file is not "deleted")
        assert!(
            scratch_effects(&src, &rep).is_empty(),
            "{:?}",
            scratch_effects(&src, &rep)
        );
        // artifacts of toolchains are not project files
        std::fs::create_dir_all(src.join("target/debug")).unwrap();
        std::fs::write(src.join("target/debug/x"), "x").unwrap();
        std::fs::create_dir_all(src.join(".pytest_cache")).unwrap();
        std::fs::write(src.join(".pytest_cache/y"), "y").unwrap();
        std::fs::create_dir_all(src.join("node_modules/p")).unwrap();
        std::fs::write(src.join("node_modules/p/i.js"), "i").unwrap();
        assert!(scratch_effects(&src, &rep).is_empty());
        // real effects
        std::fs::create_dir_all(src.join("tests")).unwrap();
        std::fs::write(src.join("tests/add.test.js"), "t").unwrap();
        std::fs::write(src.join("a.txt"), "ONE\n").unwrap();
        std::fs::remove_file(src.join("sub/b.txt")).unwrap();
        std::fs::write(src.join("Cargo.lock"), "v2\n").unwrap(); // regenerated: listed, but not "unsaved"
        std::os::unix::fs::symlink("/etc", src.join("evil")).unwrap(); // never followed, never reported
        let e = scratch_effects(&src, &rep);
        assert_eq!(e.created, ["tests/add.test.js"]);
        assert_eq!(e.modified, ["Cargo.lock", "a.txt"]);
        assert_eq!(e.deleted, ["sub/b.txt"]);
        assert_eq!(e.created_dirs, ["tests"]);
        assert_eq!(e.unsaved_files, 3, "the lock file does not count");
        assert!(!e.truncated);
    }

    #[test]
    fn truncated_capture_never_persists_a_cut_secret_prefix() {
        // A 20+ char token cut at the byte cap leaves a prefix too short for
        // the recognisers; the incomplete last line must be dropped.
        let mut text = String::new();
        for _ in 0..10 {
            text.push_str("ordinary build output line\n");
        }
        text.push_str("token = ghp_abcdefghijklmn"); // cut mid-token, no newline
        let mut red = Redaction::default();
        let out = redact_stream(text.as_bytes(), true, &mut red);
        assert!(!out.contains("ghp_"), "{out}");
        assert!(out.contains("ordinary build output line"));
        assert!(out.trim_end().ends_with("[TRUNCATED:nexus]"));
        // Untruncated complete output is kept intact.
        let mut red = Redaction::default();
        let out = redact_stream(b"line one\nline two\n", false, &mut red);
        assert_eq!(out, "line one\nline two\n");
    }
}
