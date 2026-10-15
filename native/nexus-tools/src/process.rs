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
}

// ------------------------------------------------------------ policy

#[derive(Debug, Clone)]
pub struct ResolvedCommand {
    /// Logical name (`cargo`, `npm`, `tsc`, or a test-policy name).
    pub name: String,
    pub program: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub ro_binds: Vec<(PathBuf, String)>,
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
            test_programs: Vec::new(),
        }
    }

    /// Offline test policy: also allows the listed absolute programs.
    pub fn offline_test(toolchain: Toolchain, programs: &[&str]) -> Self {
        Self {
            toolchain,
            test_programs: programs.iter().map(|s| s.to_string()).collect(),
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

pub struct ProcessContext<'a> {
    pub ws: &'a Workspace,
    /// Private host directory under which per-execution dirs are created.
    pub run_root: &'a Path,
    pub execution_id: &'a str,
    pub policy: &'a CommandPolicy,
    pub budgets: &'a ToolBudgets,
    /// Upper bound on wall time from the approved process scope.
    pub scope_max_wall_ms: u64,
}

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
}

impl SandboxControl for Control<'_, '_> {
    fn should_stop(&mut self) -> Option<StopReason> {
        if self.cancel.is_cancelled() {
            return Some(StopReason::Cancelled);
        }
        match self.hooks.fence() {
            Ok(()) => None,
            Err(e) => Some(StopReason::Revoked(e.message)),
        }
    }
    fn on_spawned(&mut self, pid: u32, cgroup: &str) -> Result<(), ToolError> {
        self.hooks.journal(
            PH_RUNNING,
            serde_json::json!({"pid": pid, "cgroup": cgroup, "network": "none"}),
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
    let cmd = match ctx.policy.resolve(args) {
        Ok(c) => c,
        Err(e) => return failed(hooks, &run_dir, e.code, e.message),
    };
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
    let report = match stage_workspace(ctx.ws, &src, &slim, &mut probe, &mut |_| {}) {
        Ok(r) => r,
        Err(e) => return failed(hooks, &run_dir, e.code, e.message),
    };
    hooks.at("after-stage");
    // 2. Sandbox configuration.
    let limits = limits_from(ctx.budgets, ctx.scope_max_wall_ms);
    let spec = SandboxSpec {
        id: ctx.execution_id.to_owned(),
        program: cmd.program.clone(),
        args: cmd.argv.clone(),
        src_dir: src.clone(),
        cwd: cmd.cwd.clone(),
        env: cmd.env.clone(),
        ro_binds: cmd.ro_binds.clone(),
        limits: limits.clone(),
        cgroup_base: base.clone(),
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
    // 3. Durable intent BEFORE spawn: identity, digests, limits, cgroup
    //    and run directory (so recovery can find and kill a leftover).
    hooks.journal(
        PH_PREPARED,
        serde_json::json!({
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
            "sandbox": {
                "backend": "bubblewrap+seccomp+cgroup-v2", "network": "none",
                "rootfs": "synthetic (usr ro, tmpfs scratch)", "workspace": "snapshot-ro",
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
        }),
    )?;
    crash_point("proc-after-prepared");
    let _ = bwrap_argv; // (argv is part of `sandboxDigest`)
                        // 4. Last fence, then run.
    if cancel.is_cancelled() {
        let _ = std::fs::remove_dir_all(&run_dir);
        hooks.journal(
            PH_CANCELLED,
            serde_json::json!({"reason": "cancelled", "processStarted": false}),
        )?;
        return Ok(cancelled_result());
    }
    if let Err(e) = hooks.fence() {
        let _ = std::fs::remove_dir_all(&run_dir);
        hooks.journal(
            PH_CANCELLED,
            serde_json::json!({"reason": "revoked", "detail": e.message, "processStarted": false}),
        )?;
        return Ok(cancelled_result());
    }
    let outcome = {
        let mut control = Control { cancel, hooks };
        run_sandboxed(&spec, &mut control)
    };
    let _ = std::fs::remove_dir_all(&run_dir);
    let out = match outcome {
        Ok(o) => o,
        Err(e) => {
            // Spawn/cleanup failure. The cgroup is killed best-effort.
            kill_and_remove_cgroup(&cgroup_path);
            return failed(hooks, &run_dir, e.code, e.message);
        }
    };
    crash_point("proc-after-exit");
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
    let pass = matches!(out.exit, ExitKind::Exited(0));
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
        "verification": if pass { "pass" } else { "fail" },
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
    hooks.journal(phase, record)?;
    let output = serde_json::json!({
        "reason": reason, "exitCode": code, "signal": signal,
        "verification": if pass { "pass" } else { "fail" },
        "stdout": so, "stderr": se,
        "stdoutTruncated": out.stdout_truncated, "stderrTruncated": out.stderr_truncated,
        "wallMs": out.wall_ms, "userMs": out.user_ms, "sysMs": out.sys_ms,
        "peakRssBytes": out.peak_rss_bytes, "peakProcs": out.peak_procs,
        "resourceEnforcement": out.resource_enforcement,
        "oomKilled": out.oom_killed, "pidsLimitHit": out.pids_limit_hit,
        "snapshotDigest": report.digest, "sandboxDigest": sbx_digest,
        "network": "none", "writeBack": "none",
    });
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
    serde_json::json!({
        "reason": "no terminal record (daemon crash or restart); never restarted",
        "processStarted": running.is_some(),
        "outcome": if running.is_some() { "uncertain" } else { "never-started" },
        "leftoverProcessesKilled": killed,
        "runDirRemoved": dir_removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
