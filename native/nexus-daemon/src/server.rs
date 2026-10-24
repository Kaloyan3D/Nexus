//! `nexusd` connection serving: bounded frames, concurrent clients with
//! serialized authoritative mutations, structured refusals.
//!
//! The single `Mutex<Kernel>` serializes every authoritative mutation (the
//! kernel's own `flock` + transaction layer remains the cross-process
//! backstop). Read-only operations share the same gate so status/receipt
//! reads never interleave torn state. Malformed input yields a versioned
//! refusal; it can never crash the daemon or corrupt durable state: every
//! handler returns a value, panics are contained per connection, and the
//! listener loop survives client failures.

use crate::auth::{now_ms, IssuerAuth};
use crate::protocol::{
    codes, fail, is_privileged, is_read_only, ok, parse_frame, AuthFields, IpcRequest, MAX_CLIENTS,
    MAX_FRAME_BYTES, MAX_JOURNAL_EVENTS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS,
};
use nexus_kernel::bridge;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Explicit lifecycle states. `stopped` is the exited process (reported on
/// the shutdown log line); while serving, the daemon is exactly one of the
/// first three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Starting,
    Ready,
    Stopping,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Stopping => "stopping",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustMode {
    /// Default: privileged mutations are unconditionally refused.
    Readonly,
    /// Explicit opt-in: privileged mutations require per-request issuer
    /// authentication against the daemon's ephemeral capability key.
    /// Vulnerable to same-UID hostile peers by construction (see auth.rs).
    ShadowTest,
}

impl TrustMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Readonly => "readonly",
            Self::ShadowTest => "shadow-test",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "readonly" => Ok(Self::Readonly),
            "shadow-test" => Ok(Self::ShadowTest),
            _ => Err(format!(
                "unknown --trust-mode '{s}'; expected 'readonly' or 'shadow-test'"
            )),
        }
    }
}

#[derive(Debug, Default)]
pub struct Counters {
    pub requests: AtomicU64,
    pub refused: AtomicU64,
    pub errors: AtomicU64,
    pub active_clients: AtomicUsize,
}

pub struct Daemon {
    pub kernel: Mutex<nexus_kernel::Kernel>,
    pub trust_mode: TrustMode,
    pub auth: Option<Arc<IssuerAuth>>,
    /// A2.1 transport gate: when set, privileged commands additionally
    /// require the connecting process UID (real SO_PEERCRED) to be listed
    /// here. This gates TRANSPORT access by OS identity; it still does not
    /// authenticate which JS module produced a request, so same-UID module
    /// confusion remains out of scope (see auth.rs). None = no gate, with
    /// the documented same-UID limitation in full effect.
    pub allowed_uids: Option<Vec<u32>>,
    /// Closure §2 production socket sharing: when set, the IPC socket lives
    /// in a dedicated directory owned by the daemon euid with group `gid`
    /// and mode 0750, and the socket node itself is 0660 group `gid`, so a
    /// distinct issuer UID in that group can traverse and connect while
    /// untrusted UIDs get kernel-enforced EACCES. None = socket stays under
    /// the owner-only DataRoot policy (see verify_protected_dir).
    pub socket_group: Option<u32>,
    /// Closure §3 handoff copy of the ephemeral capability, group-readable
    /// inside the shared socket directory (never inside the DataRoot).
    /// Removed at shutdown alongside the socket. None = no handoff file.
    pub cap_handoff: Option<std::path::PathBuf>,
    pub lifecycle: Mutex<Lifecycle>,
    pub counters: Counters,
    /// Latched when any operation reports trust-threatening store state
    /// (reconciliation-required, rollback-detected, witness-required,
    /// store-corrupt, store-incompatible). Never auto-clears: restart or
    /// operator recovery only.
    pub reconcile_latch: Mutex<Option<String>>,
    /// A3.2: operator-configured bases beneath which the Controller may
    /// bind workspaces. Empty = workspace binding refused (fail closed).
    pub workspace_bases: Vec<std::path::PathBuf>,
    /// A5.6: directory holding one isolated working copy per coding task.
    pub worktree_root: Option<std::path::PathBuf>,
    /// Autonomy-first: where project-scoped environments (installed dependencies, build
    /// caches) live. One private directory per project; never inside a workspace.
    pub project_envs: Option<std::path::PathBuf>,
    /// A6.1.3: operator project registry (directory + trusted owner uids). When
    /// set, working copies are made only for registered projects, named by id;
    /// a caller-supplied path is refused.
    pub project_registry: Option<(std::path::PathBuf, nexus_tools::registry::Trust)>,
    /// A6.1.4: automated workspace policy (no human approver channel). When set,
    /// approvals are still created, journaled and consumed, but decided by
    /// `autonomous-workspace/v1` for operations inside daemon-made isolated copies.
    pub autonomous: Option<AutonomousConfig>,
    /// Per-task counters (edits, commands) of automated grants.
    pub autonomous_counters: Mutex<std::collections::HashMap<String, (u32, u32)>>,
    /// A5.6: repo-code pilot (also latched in the Kernel handle).
    pub repo_code_enabled: bool,
    /// A3.3: mutating tools are refused unless explicitly enabled.
    pub writes_enabled: bool,
    /// A3.4: sandboxed process execution is refused unless enabled AND the
    /// sandbox preflight succeeded at startup (fail closed).
    pub process_enabled: bool,
    /// True In-Place Execution milestone 1: the filesystem scope that NEW Isolated task copies are
    /// created with (`scratch` = the A3.4 behaviour). It is frozen into each copy's identity record at
    /// creation; nothing a caller or model sends can change the scope of an existing task.
    pub isolated_exec_scope: nexus_tools::exec_contract::FsScope,
    pub command_policy: nexus_tools::process::CommandPolicy,
    pub run_root: std::path::PathBuf,
    pub sandbox_caps: Option<nexus_tools::sandbox::SandboxCapabilities>,
    /// Separate approver capability (never the issuer capability).
    pub approver_auth: Option<Arc<IssuerAuth>>,
    pub approver_uids: Option<Vec<u32>>,
    /// True only when approver UIDs are disjoint from issuer UIDs.
    pub approver_independent: bool,
    /// A4.2: every mutation/process execution additionally requires one
    /// consumed human approval bound to its exact operation; the legacy
    /// scope-approve commands are refused.
    pub require_human_approval: bool,
    /// A4.4: named production security profile this daemon was validated
    /// against at startup (None = no profile; NOT production-configured).
    pub security_profile: Option<String>,
    /// Bounded concurrent tool executions.
    pub tool_inflight: AtomicUsize,
    pub witness_configured: bool,
    pub witness_path: Option<std::path::PathBuf>,
    pub start_utc: String,
}

pub type SharedDaemon = Arc<Daemon>;

fn now_utc() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => format!("{}.{:09}Z", d.as_secs(), d.subsec_nanos()),
        Err(_) => "0.000000000Z".to_owned(),
    }
}

/// Bounded, single-line JSON log. Secrets (cap keys, tags, nonces, request
/// bodies) are never emitted; ids are truncated.
pub fn log_line(event: &str, id: &str, code: &str, detail: &str) {
    let short_id: String = id.chars().take(64).collect();
    let short_detail: String = detail.chars().take(300).collect();
    let short_code: String = code.chars().take(64).collect();
    eprintln!(
        "{}",
        serde_json::json!({
            "atUtc": now_utc(),
            "daemon": "nexusd",
            "event": event,
            "id": short_id,
            "code": short_code,
            "detail": short_detail,
        })
    );
}

fn latch_reconciliation(daemon: &Daemon, code: &str, message: &str) {
    match code {
        "reconciliation-required"
        | "rollback-detected"
        | "witness-required"
        | "store-corrupt"
        | "store-incompatible" => {
            if let Ok(mut latch) = daemon.reconcile_latch.lock() {
                if latch.is_none() {
                    *latch = Some(format!(
                        "{code}: {}",
                        message.chars().take(200).collect::<String>()
                    ));
                }
            }
        }
        _ => {}
    }
}

fn kernel_fail(daemon: &Daemon, id: &str, e: &nexus_contracts::KernelError) -> serde_json::Value {
    latch_reconciliation(daemon, e.code.as_str(), &e.message);
    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
    fail(id, e.code.as_str(), &e.message)
}

fn get_string(
    params: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<String, serde_json::Value> {
    match params.get(field) {
        Some(serde_json::Value::String(s))
            if !s.is_empty() && s.len() <= crate::protocol::MAX_ID_LEN =>
        {
            Ok(s.clone())
        }
        _ => Err(fail(
            "",
            codes::BAD_REQUEST,
            format!("bad-request: '{field}' must be a non-empty string"),
        )),
    }
}

fn get_object(
    params: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<serde_json::Value, serde_json::Value> {
    match params.get(field) {
        Some(v) if v.is_object() => Ok(v.clone()),
        _ => Err(fail(
            "",
            codes::BAD_REQUEST,
            format!("bad-request: '{field}' must be an object"),
        )),
    }
}

/// Parse `--allowed-uids` (comma-separated decimal UIDs). Empty entries are
/// rejected; duplicates are removed. Used by `nexusd` startup and unit tests.
pub fn parse_allowed_uids(spec: &str) -> Result<Vec<u32>, String> {
    let mut out = Vec::new();
    for part in spec.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            return Err("--allowed-uids contains an empty entry".to_owned());
        }
        let uid: u32 = trimmed
            .parse()
            .map_err(|_| format!("--allowed-uids entry '{trimmed}' is not a decimal UID"))?;
        if !out.contains(&uid) {
            out.push(uid);
        }
    }
    if out.is_empty() {
        return Err("--allowed-uids must list at least one UID".to_owned());
    }
    Ok(out)
}

/// Parse `--socket-group` (decimal GID or group name, resolved at startup).
/// Names keep operators from hard-coding numeric GIDs in units; the numeric
/// value is what crosses into enforcement and status reporting.
pub fn parse_socket_group(spec: &str) -> Result<u32, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("--socket-group must name a group or GID".to_owned());
    }
    if let Ok(gid) = trimmed.parse::<u32>() {
        return Ok(gid);
    }
    if trimmed.bytes().any(|b| b == 0) {
        return Err("--socket-group group name contains NUL".to_owned());
    }
    let name = std::ffi::CString::new(trimmed)
        .map_err(|_| "--socket-group group name is invalid".to_owned())?;
    let group = unsafe { libc::getgrnam(name.as_ptr()) };
    if group.is_null() {
        return Err(format!("--socket-group group '{trimmed}' does not exist"));
    }
    Ok(unsafe { (*group).gr_gid })
}

/// Closure §2 fail-closed shared socket-directory check. Unlike
/// [`verify_protected_dir`] (owner-only, no group bits — the DataRoot
/// policy, NEVER weakened), this validates the explicitly selected
/// production sharing layout: `path` must canonicalize to a real directory
/// owned by the daemon euid, owned by group `gid`, with mode exactly 0750.
/// Symlink leaves are refused outright; parents are resolved by
/// canonicalization and the REAL directory is what gets validated, so a
/// link farm can never smuggle an unvalidated directory past this gate.
/// Anything else fails closed at startup (`insecure-socket-dir`).
pub fn verify_socket_dir(path: &Path, gid: u32) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;
    if std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(
            "socket directory path is a symlink; refusing shared IPC (failing closed)".to_owned(),
        );
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("socket directory unavailable: {e}"))?;
    let meta =
        std::fs::metadata(&canonical).map_err(|e| format!("socket directory unavailable: {e}"))?;
    if !meta.is_dir() {
        return Err("socket path is not a directory".to_owned());
    }
    let euid = unsafe { libc::geteuid() };
    if meta.uid() != euid {
        return Err("socket directory is not owned by the daemon uid (failing closed)".to_owned());
    }
    if meta.gid() != gid {
        return Err(
            "socket directory group does not match --socket-group (failing closed)".to_owned(),
        );
    }
    // Exact match including setuid/setgid/sticky: the sharing layout is one
    // precise shape, not a ceiling. (E.g. 2750 setgid would otherwise pass a
    // 0o777 mask while changing inheritance semantics.)
    if meta.permissions().mode() & 0o7777 != 0o750 {
        return Err(format!(
            "socket directory mode must be exactly 0750 (got {:o}); refusing shared IPC (failing closed)",
            meta.permissions().mode() & 0o7777
        ));
    }
    Ok(canonical)
}

/// Closure §2: set the bound socket node to 0660 group `gid` (owner rw +
/// issuer-group rw, no other access) and validate the settled bits.
/// Untrusted UIDs (neither owner nor group) then fail at `connect(2)` with
/// EACCES — enforced by the kernel, not by daemon code. Any failure (not a
/// group member, read-only fs, replaced node) is fatal at startup. Note the
/// 0750 directory gives the group NO write bit, so group members cannot
/// rename/swap entries: node-replacement races need directory write (daemon
/// uid only) and degrade to fail-closed denial, never privilege gain.
pub fn secure_socket_file(socket_path: &Path, gid: u32) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;
    if unsafe {
        libc::chown(
            std::ffi::CString::new(socket_path.as_os_str().as_bytes())
                .map_err(|_| "socket path contains interior NUL".to_owned())?
                .as_ptr(),
            u32::MAX,
            gid,
        )
    } != 0
    {
        return Err(
            "socket group unsettable; is the daemon a member of the socket group? (failing closed)"
                .to_owned(),
        );
    }
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o660))
        .map_err(|e| format!("socket permissions unsettable: {e}"))?;
    let meta = std::fs::metadata(socket_path).map_err(|e| format!("socket unverifiable: {e}"))?;
    let euid = unsafe { libc::geteuid() };
    if meta.uid() != euid || meta.gid() != gid || meta.permissions().mode() & 0o777 != 0o660 {
        return Err("socket settled with wrong ownership or mode (failing closed)".to_owned());
    }
    Ok(())
}

/// Authorize one privileged command. Returns None when admitted, or the
/// refusal value when denied. `peer` is the real SO_PEERCRED of the
/// connecting process, captured once per connection (never self-asserted).
fn authorize(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> Option<serde_json::Value> {
    match daemon.trust_mode {
        TrustMode::Readonly => {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            Some(fail(
                &req.id,
                codes::PRIVILEGED_DISABLED,
                "privileged commands are disabled: this daemon runs in the default readonly trust mode; restart with --trust-mode shadow-test for the explicitly trusted shadow-test configuration",
            ))
        }
        TrustMode::ShadowTest => {
            let auth = match daemon.auth.as_ref() {
                Some(a) => a,
                None => {
                    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                    return Some(fail(
                        &req.id,
                        codes::STORE_UNHEALTHY,
                        "issuer capability is unavailable; failing closed",
                    ));
                }
            };
            let fields: &AuthFields = match req.auth.as_ref() {
                Some(f) => f,
                None => {
                    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                    return Some(fail(
                        &req.id,
                        codes::ISSUER_UNTRUSTED,
                        "missing issuer authentication: privileged commands require auth { nonce, ts, tag } from the trusted issuer",
                    ));
                }
            };
            match auth.verify(&req.cmd, &req.id, &req.params, fields, now_ms()) {
                Ok(()) => {}
                Err(code) => {
                    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                    return Some(fail(
                        &req.id,
                        code,
                        match code {
                            codes::REPLAY_REJECTED => {
                                "issuer nonce was already used; replay rejected"
                            }
                            _ => "issuer authentication failed: unknown or unauthorized issuer",
                        },
                    ));
                }
            }
            // A2.1 transport gate: cap authentication proves possession of
            // the ephemeral key, NOT OS identity. When an allowlist is
            // configured, the connecting UID must additionally match, or the
            // request is refused. A stolen capability alone is insufficient.
            match (&daemon.allowed_uids, peer) {
                (Some(allowed), Some((uid, _, _))) if allowed.contains(&uid) => None,
                (Some(_), _) => {
                    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                    Some(fail(
                        &req.id,
                        codes::PEER_UNAUTHORIZED,
                        "connecting process UID is not authorized for privileged commands; failing closed (no fallback)",
                    ))
                }
                (None, _) => None,
            }
        }
    }
}

fn do_acquire(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let task = match get_string(&req.params, "taskInstanceId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let backend = match get_string(&req.params, "backend") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let mut kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    match kernel.acquire_generation(&task, &backend) {
        Ok(lease) => ok(&req.id, serde_json::json!({ "lease": lease })),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn do_seal(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let resolution_value = match get_object(&req.params, "resolution") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let issued: nexus_contracts::RegistryResolutionV1 =
        match serde_json::from_value(resolution_value) {
            Ok(v) => v,
            Err(_) => {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return fail(
                    &req.id,
                    codes::BAD_REQUEST,
                    "bad-request: 'resolution' does not match RegistryResolutionV1",
                );
            }
        };
    let mut kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    match kernel.seal_issuance(&issued) {
        Ok(id) => ok(&req.id, serde_json::json!({ "issuanceId": id })),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn do_seal_extension(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let extension = match req.params.get("extension") {
        Some(v) if v.is_object() => v.clone(),
        _ => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: extension must be an object",
            )
        }
    };
    let mut kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    match kernel.seal_extension(&extension) {
        Ok(digest) => ok(&req.id, serde_json::json!({ "extensionDigest": digest })),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

/// EM-02: seal a task generation's immutable binding (see `Kernel::seal_task_binding`).
fn do_seal_task_binding(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let binding = match req.params.get("binding") {
        Some(v) if v.is_object() => v.clone(),
        _ => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: binding must be an object",
            )
        }
    };
    let (Some(issuance_id), Some(extension_digest)) = (
        req.params.get("issuanceId").and_then(|v| v.as_str()),
        req.params.get("extensionDigest").and_then(|v| v.as_str()),
    ) else {
        return fail(
            &req.id,
            codes::BAD_REQUEST,
            "bad-request: issuanceId and extensionDigest are required",
        );
    };
    let mut kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    match kernel.seal_task_binding(&binding, issuance_id, extension_digest) {
        Ok(digest) => ok(&req.id, serde_json::json!({ "taskBindingDigest": digest })),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn do_intent_publish(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let intent = match req.params.get("intent") {
        Some(v) if v.is_object() => v.clone(),
        _ => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: intent must be an object",
            )
        }
    };
    let mut kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    match kernel.publish_intent(&intent) {
        Ok(published) => ok(
            &req.id,
            serde_json::json!({ "commandId": published.command_id }),
        ),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn do_intent_fence(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let command_id = match get_string(&req.params, "commandId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let mut kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    match kernel.fence_intent(&command_id) {
        Ok(()) => ok(&req.id, serde_json::json!({})),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn do_dispatch_authorize(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let command_id = match get_string(&req.params, "commandId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let request_digest = match get_string(&req.params, "requestDigest") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let scope = match get_string(&req.params, "scope") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let endpoint_origin = match get_string(&req.params, "endpointOrigin") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let credential_ref = match get_string(&req.params, "credentialRef") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let mut kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    let auth_req = nexus_kernel::NativeDispatchRequest {
        command_id,
        request_digest,
        scope,
        endpoint_origin,
        credential_ref,
    };
    match kernel.authorize_sealed_dispatch(&auth_req) {
        Ok(grant) => ok(
            &req.id,
            serde_json::json!({
                "grant": {
                    "commandId": grant.command_id,
                    "attemptId": grant.attempt_id,
                    "taskInstanceId": grant.task_instance_id,
                    "requestDigest": grant.request_digest,
                    "endpointOrigin": grant.endpoint_origin,
                    "scope": grant.scope,
                    "targetDigest": grant.target_digest,
                    "extensionDigest": grant.extension_digest,
                    "leaseEpoch": grant.lease_epoch,
                    "storeIncarnation": grant.store_incarnation,
                    "credentialRef": grant.credential_ref,
                    "issuedAtMs": grant.issued_at_ms,
                    "expiresAtMs": grant.expires_at_ms,
                    "nonceHex": grant.nonce_hex,
                    "grantedAtUtc": grant.granted_at_utc,
                    "tagHex": grant.tag_hex,
                }
            }),
        ),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

/// A5.1: durable single-use redemption of a sealed dispatch grant.
///
/// The model executor (a separate, network-capable process under the
/// issuer identity) presents the grant it received from
/// `dispatch-authorize` immediately before it writes request bytes. The
/// daemon re-verifies seal, binding, expiry, lease and witness state and
/// atomically records `redeemed`; a second redemption is `command-conflict`.
/// The daemon itself never opens a network connection, never holds a
/// provider credential, and gains no tool authority from this command.
fn do_model_redeem(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let request_digest = match get_string(&req.params, "requestDigest") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let endpoint_origin = match get_string(&req.params, "endpointOrigin") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let credential_ref = match get_string(&req.params, "credentialRef") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let g = match get_object(&req.params, "grant") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let s = |k: &str| -> Option<String> { g.get(k).and_then(|v| v.as_str()).map(str::to_owned) };
    let i = |k: &str| -> Option<i64> { g.get(k).and_then(|v| v.as_i64()) };
    let parsed = (|| {
        Some(nexus_kernel::SealedNativeDispatchGrant {
            command_id: s("commandId")?,
            attempt_id: s("attemptId")?,
            task_instance_id: s("taskInstanceId")?,
            request_digest: s("requestDigest")?,
            endpoint_origin: s("endpointOrigin")?,
            scope: s("scope")?,
            target_digest: s("targetDigest")?,
            extension_digest: s("extensionDigest")?,
            lease_epoch: g.get("leaseEpoch").and_then(|v| v.as_u64())?,
            store_incarnation: s("storeIncarnation")?,
            credential_ref: s("credentialRef")?,
            issued_at_ms: i("issuedAtMs")?,
            expires_at_ms: i("expiresAtMs")?,
            nonce_hex: s("nonceHex")?,
            granted_at_utc: s("grantedAtUtc")?,
            tag_hex: s("tagHex")?,
        })
    })();
    let grant = match parsed {
        Some(g) => g,
        None => {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'grant' does not match the sealed grant shape",
            );
        }
    };
    let mut kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    match kernel.redeem_sealed_grant(
        &grant,
        &request_digest,
        &endpoint_origin,
        &credential_ref,
        now_ms(),
    ) {
        Ok(_) => ok(
            &req.id,
            serde_json::json!({
                "redeemed": true,
                "commandId": grant.command_id,
                "attemptId": grant.attempt_id,
                "scope": grant.scope,
            }),
        ),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn do_accept(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let intent_value = match get_object(&req.params, "intent") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let resolution_value = match get_object(&req.params, "resolution") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let snapshot = match get_object(&req.params, "snapshot") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let lease_value = match req.params.get("lease") {
        Some(v) if v.is_object() => v.as_object().expect("lease is an object").clone(),
        _ => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'lease' must be an object",
            )
        }
    };
    let mut intent: nexus_contracts::ControllerIntentV1 = match serde_json::from_value(intent_value)
    {
        Ok(v) => v,
        Err(_) => {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'intent' does not match ControllerIntentV1",
            );
        }
    };
    if intent.lease.is_some() {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        return fail(
            &req.id,
            codes::BAD_REQUEST,
            "bad-request: intent carries its own lease; the lease comes only from acquire_generation",
        );
    }
    let issued: nexus_contracts::RegistryResolutionV1 =
        match serde_json::from_value(resolution_value) {
            Ok(v) => v,
            Err(_) => {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return fail(
                    &req.id,
                    codes::BAD_REQUEST,
                    "bad-request: 'resolution' does not match RegistryResolutionV1",
                );
            }
        };
    let epoch = match lease_value.get("epoch") {
        Some(serde_json::Value::Number(n)) => match n.as_u64() {
            Some(v) => v,
            None => {
                return fail(
                    &req.id,
                    codes::BAD_REQUEST,
                    "bad-request: 'lease.epoch' must be an unsigned integer",
                )
            }
        },
        _ => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'lease.epoch' must be an unsigned integer",
            )
        }
    };
    let incarnation = match lease_value.get("storeIncarnation") {
        Some(serde_json::Value::String(s)) if !s.is_empty() => s.clone(),
        _ => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'lease.storeIncarnation' must be a non-empty string",
            )
        }
    };
    intent = intent.with_lease(epoch, &incarnation);
    let accept_req = nexus_kernel::AcceptRequest {
        intent,
        issued,
        snapshot,
    };
    let mut kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    match kernel.accept_command(&accept_req) {
        Ok((receipt, created)) => ok(
            &req.id,
            serde_json::json!({ "receipt": receipt, "replayed": !created }),
        ),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

// ---------------------------------------------------------------- A3.3 writes

/// Independent approver channel. Authenticated with the SEPARATE approver
/// capability and gated by `--approver-uids`; the issuer capability cannot
/// satisfy it (different key), so a valid issuer alone can never create a
/// write scope.
fn do_write_scope_approve(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> serde_json::Value {
    let refuse = |code: &str, msg: &str| {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        log_line("refuse", &req.id, code, &req.cmd);
        fail(&req.id, code, msg)
    };
    if !daemon.writes_enabled {
        return refuse(
            "write-disabled",
            "write tools are not enabled on this daemon",
        );
    }
    let (Some(auth), Some(uids)) = (daemon.approver_auth.as_ref(), daemon.approver_uids.as_ref())
    else {
        return refuse("write-disabled", "no approver credential is configured");
    };
    let Some(fields) = req.auth.as_ref() else {
        return refuse(
            codes::ISSUER_UNTRUSTED,
            "missing approver authentication (auth { nonce, ts, tag })",
        );
    };
    if let Err(code) = auth.verify(&req.cmd, &req.id, &req.params, fields, now_ms()) {
        return refuse(
            code,
            if code == codes::REPLAY_REJECTED {
                "approver nonce was already used; replay rejected"
            } else {
                "approver authentication failed (the issuer capability cannot approve writes)"
            },
        );
    }
    match peer {
        Some((uid, _, _)) if uids.contains(&uid) => {}
        _ => {
            return refuse(
                codes::PEER_UNAUTHORIZED,
                "connecting process UID is not an authorized approver",
            )
        }
    }
    if let Err(r) = only_keys(
        &req.params,
        &[
            "commandId",
            "workspaceRootDigest",
            "maxWriteBytes",
            "approverId",
        ],
        &req.id,
    ) {
        return r;
    }
    let command_id = match get_string(&req.params, "commandId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let digest = match get_string(&req.params, "workspaceRootDigest") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let max = match get_u64(&req.params, "maxWriteBytes", &req.id) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let approver_id = req
        .params
        .get("approverId")
        .and_then(|v| v.as_str())
        .unwrap_or("approver")
        .to_owned();
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    match kernel.bind_write_scope(
        &command_id,
        &approver_id,
        daemon.approver_independent,
        &digest,
        max,
    ) {
        Ok(b) => {
            log_line("approver", &req.id, "ok", &req.cmd);
            ok(
                &req.id,
                serde_json::json!({"writeScope": {
                    "commandId": b.command_id,
                    "attemptId": b.attempt_id,
                    "leaseEpoch": b.lease_epoch,
                    "maxWriteBytes": b.max_write_bytes,
                    "independent": b.independent,
                }}),
            )
        }
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn do_process_scope_approve(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> serde_json::Value {
    let refuse = |code: &str, msg: &str| {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        log_line("refuse", &req.id, code, &req.cmd);
        fail(&req.id, code, msg)
    };
    if !daemon.process_enabled {
        return refuse(
            "process-disabled",
            "sandboxed process execution is not enabled on this daemon",
        );
    }
    let (Some(auth), Some(uids)) = (daemon.approver_auth.as_ref(), daemon.approver_uids.as_ref())
    else {
        return refuse("process-disabled", "no approver credential is configured");
    };
    let Some(fields) = req.auth.as_ref() else {
        return refuse(
            codes::ISSUER_UNTRUSTED,
            "missing approver authentication (auth { nonce, ts, tag })",
        );
    };
    if let Err(code) = auth.verify(&req.cmd, &req.id, &req.params, fields, now_ms()) {
        return refuse(
            code,
            if code == codes::REPLAY_REJECTED {
                "approver nonce was already used; replay rejected"
            } else {
                "approver authentication failed (the issuer capability cannot approve processes)"
            },
        );
    }
    match peer {
        Some((uid, _, _)) if uids.contains(&uid) => {}
        _ => {
            return refuse(
                codes::PEER_UNAUTHORIZED,
                "connecting process UID is not an authorized approver",
            )
        }
    }
    if let Err(r) = only_keys(
        &req.params,
        &[
            "commandId",
            "workspaceRootDigest",
            "maxWallMs",
            "approverId",
            "fsScope",
        ],
        &req.id,
    ) {
        return r;
    }
    let fs_scope = match req.params.get("fsScope") {
        None | Some(serde_json::Value::Null) => nexus_kernel::FS_SCOPE_SCRATCH.to_owned(),
        Some(serde_json::Value::String(v))
            if v == nexus_kernel::FS_SCOPE_SCRATCH || v == nexus_kernel::FS_SCOPE_WORKSPACE =>
        {
            v.clone()
        }
        Some(_) => return refuse("scope-refused", "fsScope must be 'scratch' or 'workspace'"),
    };
    let command_id = match get_string(&req.params, "commandId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let digest = match get_string(&req.params, "workspaceRootDigest") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let max = match get_u64(&req.params, "maxWallMs", &req.id) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let approver_id = req
        .params
        .get("approverId")
        .and_then(|v| v.as_str())
        .unwrap_or("approver")
        .to_owned();
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    match kernel.bind_process_scope_with_fs(
        &command_id,
        &approver_id,
        daemon.approver_independent,
        &digest,
        max,
        &fs_scope,
    ) {
        Ok(b) => {
            log_line("approver", &req.id, "ok", &req.cmd);
            ok(
                &req.id,
                serde_json::json!({"processScope": {
                    "commandId": b.command_id,
                    "attemptId": b.attempt_id,
                    "leaseEpoch": b.lease_epoch,
                    "maxWallMs": b.max_wall_ms,
                    "independent": b.independent,
                }}),
            )
        }
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

// ------------------------------------------------------- A4.2 human approval

/// Approver-channel gate: separate approver HMAC AND an approver peer UID.
fn approver_gate(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> Result<(u32, u32, i32), serde_json::Value> {
    let refuse = |code: &str, msg: &str| {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        log_line("refuse", &req.id, code, &req.cmd);
        fail(&req.id, code, msg)
    };
    if !daemon.require_human_approval {
        return Err(refuse(
            "approval-disabled",
            "human approval mode is not enabled on this daemon",
        ));
    }
    let (Some(auth), Some(uids)) = (daemon.approver_auth.as_ref(), daemon.approver_uids.as_ref())
    else {
        return Err(refuse(
            "approval-disabled",
            "no approver credential is configured",
        ));
    };
    let Some(fields) = req.auth.as_ref() else {
        return Err(refuse(
            codes::ISSUER_UNTRUSTED,
            "missing approver authentication (auth { nonce, ts, tag })",
        ));
    };
    if let Err(code) = auth.verify(&req.cmd, &req.id, &req.params, fields, now_ms()) {
        return Err(refuse(
            code,
            if code == codes::REPLAY_REJECTED {
                "approver nonce was already used; replay rejected"
            } else {
                "approver authentication failed (issuer credentials cannot act as the approver)"
            },
        ));
    }
    match peer {
        Some(p) if uids.contains(&p.0) => Ok(p),
        _ => Err(refuse(
            codes::PEER_UNAUTHORIZED,
            "connecting process UID is not an authorized approver",
        )),
    }
}

fn approval_state_view(r: &nexus_store::ApprovalRow, full: bool) -> serde_json::Value {
    let req: serde_json::Value =
        serde_json::from_str(&r.request_json).unwrap_or(serde_json::Value::Null);
    let decision: serde_json::Value = r
        .decision_json
        .as_deref()
        .and_then(|d| serde_json::from_str(d).ok())
        .unwrap_or(serde_json::Value::Null);
    let mut v = serde_json::json!({
        "approvalId": r.approval_id,
        "state": r.state,
        "commandId": r.command_id,
        "taskInstanceId": r.task_instance_id,
        "attemptId": r.attempt_id,
        "leaseEpoch": r.lease_epoch,
        "toolId": r.tool_id,
        "scope": r.scope,
        "requestDigest": r.request_digest,
        "argsDigest": req.get("argsDigest"),
        "workspaceRootDigest": req.get("workspaceRootDigest"),
        "paths": req.get("paths"),
        "operationKind": req.get("operation").and_then(|o| o.get("kind")),
        "createdMs": r.created_ms,
        "expiresMs": r.expires_ms,
        "decidedMs": r.decided_ms,
        "decision": decision.get("decision"),
        "decisionReason": decision.get("reason"),
        "approverId": decision.get("approverId"),
        "humanAuthMechanism": decision.get("humanAuth").and_then(|h| h.get("mechanism")),
        "decisionKind": decision.get("humanAuth").and_then(|h| h.get("kind")),
        "grantRequestId": r.grant_request_id,
    });
    if full {
        v["request"] = req;
    }
    v
}

/// Issuer submits one proposed mutation/process. The daemon (not the
/// submitter) derives the authoritative operation description, pre/post
/// image identity and diff from the live workspace.
/// A6.1.3: the daemon enforces the project's write scope itself (the broker's
/// check is only a courtesy that keeps out-of-scope proposals from an approver).
/// The scope was frozen into the working copy's identity record at creation.
fn write_scope_refusal(
    daemon: &Daemon,
    request: &nexus_tools::ToolRequestV1,
) -> Option<serde_json::Value> {
    let root = daemon.worktree_root.as_ref()?;
    daemon.project_registry.as_ref()?;
    let tool = nexus_tools::ToolId::parse(&request.tool_id)?;
    if !tool.is_mutating() || !nexus_tools::gitwt::valid_task_id(&request.task_instance_id) {
        return None;
    }
    let raw = std::fs::read_to_string(wt_meta_path(root, &request.task_instance_id)).ok()?;
    let meta: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let allow: Vec<String> = meta
        .get("writeAllow")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    if allow.is_empty() {
        return None;
    }
    let path = request
        .args
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let path = path.strip_prefix("./").unwrap_or(path);
    let ok = !path.is_empty()
        && !path.starts_with('/')
        && !path.split('/').any(|c| c == ".." || c == ".")
        && allow.iter().any(|a| {
            if a.ends_with('/') {
                path.starts_with(a.as_str())
            } else {
                path == a
            }
        });
    if ok {
        return None;
    }
    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
    Some(fail(
        &request.task_instance_id,
        "path-not-in-scope",
        "the path is outside the project's write scope",
    ))
}

/// Limits of the automated workspace policy (A6.1.4). The rules themselves are
/// code (below), not configuration, so a config file can never widen them.
#[derive(Debug, Clone)]
pub struct AutonomousConfig {
    pub max_edits_per_task: u32,
    pub max_commands_per_task: u32,
    pub max_write_bytes: u64,
}

pub const AUTONOMOUS_POLICY_ID: &str = "autonomous-workspace/v1";

impl Default for AutonomousConfig {
    fn default() -> Self {
        Self {
            max_edits_per_task: 5000,
            max_commands_per_task: 2000,
            max_write_bytes: 2 * 1024 * 1024,
        }
    }
}

fn autonomous_policy_digest(c: &AutonomousConfig, in_place_task_copies: bool) -> String {
    let mut v = serde_json::json!({
        "id": AUTONOMOUS_POLICY_ID,
        "maxEditsPerTask": c.max_edits_per_task,
        "maxCommandsPerTask": c.max_commands_per_task,
        "maxWriteBytes": c.max_write_bytes,
        "protectedNames": nexus_tools::protect::PROTECTED_NAMES,
        "tools": ["fs.write", "fs.edit", "proc.run"],
    });
    if in_place_task_copies {
        // The policy additionally approves commands that write a task's own disposable copy in
        // place. The digest differs ONLY then, so a scratch-only daemon's digest is unchanged.
        v["execFsScopes"] = serde_json::json!(["scratch", "workspace"]);
    }
    sha256_hex_str(&nexus_contracts::canonical_json(&v))
}

/// Evaluate `autonomous-workspace/v1` for one pending approval. Inputs are facts
/// the daemon holds (its own copy identity record, the Kernel-built operation
/// description, its command policy) - never model or renderer claims. `Ok` =
/// the facts relied on; `Err` = the refusal reason.
fn evaluate_autonomous_policy(
    daemon: &Daemon,
    cfg: &AutonomousConfig,
    sub: &nexus_kernel::ApprovalSubmission,
) -> Result<serde_json::Value, String> {
    let root = daemon
        .worktree_root
        .as_ref()
        .ok_or("no working-copy root is configured")?;
    let task = &sub.task_instance_id;
    if !nexus_tools::gitwt::valid_task_id(task) {
        return Err("invalid task instance".into());
    }
    let direct = direct_meta(daemon, task).is_some();
    let copy = task_workspace_dir(daemon, task).unwrap_or_else(|| root.join(task));
    match std::fs::symlink_metadata(&copy) {
        Ok(m) if m.file_type().is_dir() => {}
        _ if direct => return Err("the task's project folder is not available".into()),
        _ => return Err("the task has no isolated working copy".into()),
    }
    if sha256_hex_str(&copy.to_string_lossy()) != sub.workspace_root_digest {
        return Err(if direct {
            "the operation's workspace is not this task's project folder".into()
        } else {
            "the operation's workspace is not this task's isolated copy".into()
        });
    }
    let meta: serde_json::Value = std::fs::read_to_string(wt_meta_path(root, task))
        .ok()
        .and_then(|r| serde_json::from_str(&r).ok())
        .ok_or("the working copy has no identity record")?;
    let project = meta
        .get("projectId")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let (edits, commands) = daemon
        .autonomous_counters
        .lock()
        .map(|m| m.get(task).copied().unwrap_or((0, 0)))
        .unwrap_or((u32::MAX, u32::MAX));
    match (sub.tool_id.as_str(), sub.scope.as_str()) {
        ("fs.write" | "fs.edit", "write") => {
            if edits >= cfg.max_edits_per_task {
                return Err("the per-task edit budget of the workspace policy is exhausted".into());
            }
            if sub.paths.len() != 1 {
                return Err("exactly one file per edit".into());
            }
            let path = &sub.paths[0];
            nexus_tools::protect::workbench_path_check(path).map_err(|(_, why)| why.to_owned())?;
            let allow: Vec<String> = meta
                .get("writeAllow")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            if !allow.is_empty()
                && !allow.iter().any(|a| {
                    if a.ends_with('/') {
                        path.starts_with(a.as_str())
                    } else {
                        path == a
                    }
                })
            {
                return Err("the path is outside the project's write scope".into());
            }
            let post = sub
                .operation
                .get("postImageBytes")
                .and_then(|v| v.as_u64())
                .ok_or("the operation does not state its post-image size")?;
            if post > cfg.max_write_bytes {
                return Err("the resulting file is larger than the workspace policy allows".into());
            }
            Ok(serde_json::json!({
                "copy": task, "project": project, "tool": sub.tool_id, "path": path,
                "postImageBytes": post, "editsSoFar": edits, "maxEdits": cfg.max_edits_per_task,
            }))
        }
        ("proc.run", "process") => {
            if commands >= cfg.max_commands_per_task {
                return Err(
                    "the per-task command budget of the workspace policy is exhausted".into(),
                );
            }
            let sandbox = sub.operation.get("sandbox");
            let net = sandbox
                .and_then(|s| s.get("network"))
                .and_then(|v| v.as_str());
            let installs_ok = meta.get("installs").and_then(|v| v.as_bool()) == Some(true);
            let net_ok = match net {
                Some("none") => true,
                // dependency installation: the only networked class, only where the
                // project's policy allows it
                Some("install") => installs_ok,
                _ => false,
            };
            // The scope the operation declares must be the scope of THIS task (the daemon's own record),
            // and its write-back description must be the truthful one for that scope.
            let task_scope = task_fs_scope(daemon, task);
            let declared = sub
                .operation
                .get("execFsScope")
                .and_then(|v| v.as_str())
                .unwrap_or("scratch");
            if declared != task_scope.as_str() {
                return Err("the operation's filesystem scope is not this task's".into());
            }
            let expected_write_back = match task_scope {
                nexus_tools::exec_contract::FsScope::Workspace => "in-place-task-copy",
                _ => "none",
            };
            if !net_ok
                || sandbox
                    .and_then(|s| s.get("writeBack"))
                    .and_then(|v| v.as_str())
                    != Some(expected_write_back)
            {
                return Err(if net == Some("install") && !installs_ok {
                    "installing dependencies is not enabled for this project".into()
                } else {
                    "the command would not run in the sandbox without network and without write-back".into()
                });
            }
            let argv_digest = sub
                .operation
                .get("argvDigest")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut facts = serde_json::json!({
                "copy": task, "project": project, "tool": sub.tool_id,
                "program": sub.operation.get("program"), "argvDigest": argv_digest,
                "commandsSoFar": commands, "maxCommands": cfg.max_commands_per_task,
            });
            if task_scope != nexus_tools::exec_contract::FsScope::Scratch {
                facts["fsScope"] = task_scope.as_str().into();
            }
            Ok(facts)
        }
        _ => Err("this tool class is outside the automated workspace policy".into()),
    }
}

fn do_approval_request(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let refuse = |code: &str, msg: &str| {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        fail(&req.id, code, msg)
    };
    if !daemon.require_human_approval {
        return refuse(
            "approval-disabled",
            "human approval mode is not enabled on this daemon",
        );
    }
    let request = match build_tool_request(req, &["ttlMs", "aiOrigin"]) {
        Ok(r) => r,
        Err(r) => return r,
    };
    // A5.6: provenance of a MODEL-proposed operation, shown to the approver.
    let ai_origin: Option<String> = match req.params.get("aiOrigin") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(o))
            if !o.is_empty()
                && o.len() <= 160
                && o.bytes().all(|b| {
                    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':' | b'/')
                }) =>
        {
            Some(o.clone())
        }
        Some(_) => return refuse(codes::BAD_REQUEST, "bad-request: 'aiOrigin' is malformed"),
    };
    let ttl_ms = req
        .params
        .get("ttlMs")
        .and_then(|v| v.as_u64())
        .map(|v| v as i64)
        .unwrap_or(nexus_kernel::APPROVAL_TTL_DEFAULT_MS);
    let tool = match nexus_tools::ToolId::parse(&request.tool_id) {
        Some(t) => t,
        None => return refuse("unsupported-tool", "unknown tool identifier"),
    };
    let (is_write, is_proc) = (tool.is_mutating(), tool.is_process());
    if !is_write && !is_proc {
        return refuse(
            codes::BAD_REQUEST,
            "bad-request: only mutating and process tools require human approval",
        );
    }
    if (is_write && !daemon.writes_enabled) || (is_proc && !daemon.process_enabled) {
        return refuse("scope-refused", "the requested tool class is not enabled");
    }
    if let Some(r) = write_scope_refusal(daemon, &request) {
        return with_id(r, &req.id);
    }
    let ceiling = nexus_tools::ToolBudgets::ceiling();
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let binding = match kernel.workspace_binding(&request.command_id) {
        Ok(Some(b)) => b,
        Ok(None) => {
            return refuse(
                "delivery-invalid",
                "no Controller workspace binding for this command; approval refused",
            )
        }
        Err(e) => return kernel_fail(daemon, &req.id, &e),
    };
    let sub_common = |scope: &str,
                      p: &nexus_tools::PreparedToolRequest,
                      paths: Vec<String>,
                      operation: serde_json::Value,
                      preview: serde_json::Value,
                      limits: serde_json::Value| {
        nexus_kernel::ApprovalSubmission {
            command_id: request.command_id.clone(),
            task_instance_id: request.task_instance_id.clone(),
            attempt_id: request.attempt_id.clone(),
            lease_epoch: request.lease_epoch,
            store_incarnation: request.store_incarnation.clone(),
            tool_id: request.tool_id.clone(),
            tool_version: request.tool_version,
            scope: scope.to_owned(),
            args_digest: p.args_digest().to_owned(),
            budget_digest: p.budget_digest().to_owned(),
            workspace_root_digest: p.workspace_root_digest().to_owned(),
            paths,
            operation,
            preview,
            limits,
            ttl_ms,
        }
    };
    let typed = match nexus_tools::ToolArgs::parse(tool, &request.args) {
        Ok(a) => a,
        Err(e) => return tool_fail(daemon, &req.id, &e),
    };
    let sub = if is_write {
        let dummy = nexus_kernel::WriteScopeBinding {
            command_id: request.command_id.clone(),
            task_instance_id: request.task_instance_id.clone(),
            attempt_id: request.attempt_id.clone(),
            lease_epoch: request.lease_epoch,
            store_incarnation: request.store_incarnation.clone(),
            root_digest: binding.root_digest.clone(),
            max_write_bytes: ceiling.max_write_bytes,
            approver_id: "preview".to_owned(),
            independent: false,
        };
        let prepared = match nexus_tools::prepare_write(request.clone(), &binding, &dummy) {
            Ok(p) => p,
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        let pv = match nexus_tools::preview_write(prepared.workspace(), &typed, prepared.budgets())
        {
            Ok(p) => p,
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        let faithful = pv.pre_text.as_deref().map(sha256_hex_str) == pv.pre_sha256.clone()
            || pv.pre_text.is_none();
        let faithful = faithful && sha256_hex_str(&pv.post_text) == pv.post_sha256;
        let diff = if faithful {
            nexus_tools::unified_diff(pv.pre_text.as_deref().unwrap_or(""), &pv.post_text)
        } else {
            None
        };
        let preview = match diff {
            Some(d) => serde_json::json!({
                "kind": "unified-diff", "digest": sha256_hex_str(&d), "text": d,
                "boundTo": "args-digest",
            }),
            None => serde_json::json!({
                "kind": "unavailable", "digest": serde_json::Value::Null,
                "reason": if faithful { "too-large-for-reliable-diff" } else { "content-not-utf8" },
                "note": "no summary substituted; review the digests and byte counts only",
            }),
        };
        sub_common(
            "write",
            &prepared,
            vec![pv.path.clone()],
            {
                let mut op = serde_json::json!({
                    "kind": request.tool_id, "operation": pv.operation, "path": pv.path,
                    "preImageSha256": pv.pre_sha256, "preImageBytes": pv.pre_bytes,
                    "postImageSha256": pv.post_sha256, "postImageBytes": pv.post_bytes,
                    "fileMode": format!("{:o}", pv.file_mode),
                    "expectedPreImage": pv.pre_sha256,
                });
                // present only when the operation makes folders: the approver/policy sees exactly that
                if !pv.creates_dirs.is_empty() {
                    op["createsDirs"] = serde_json::json!(pv.creates_dirs);
                }
                op
            },
            preview,
            serde_json::json!({
                "maxWriteBytes": prepared.budgets().max_write_bytes,
                "maxFileBytes": prepared.budgets().max_file_bytes,
                "deadlineMs": prepared.budgets().deadline_ms,
            }),
        )
    } else {
        let dummy = nexus_kernel::ProcessScopeBinding {
            command_id: request.command_id.clone(),
            task_instance_id: request.task_instance_id.clone(),
            attempt_id: request.attempt_id.clone(),
            lease_epoch: request.lease_epoch,
            store_incarnation: request.store_incarnation.clone(),
            root_digest: binding.root_digest.clone(),
            max_wall_ms: ceiling.proc_wall_ms,
            approver_id: "preview".to_owned(),
            independent: false,
            fs_scope: task_fs_scope(daemon, &request.task_instance_id)
                .as_str()
                .to_owned(),
        };
        let prepared = match nexus_tools::prepare_process(
            request.clone(),
            &binding,
            &dummy,
            &daemon.command_policy,
        ) {
            Ok(p) => p,
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        let nexus_tools::ToolArgs::Proc(pa) = &typed else {
            return refuse(codes::BAD_REQUEST, "bad-request: not a process request");
        };
        let resolved = match daemon.command_policy.resolve(pa) {
            Ok(r) => r,
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        let b = prepared.budgets();
        let in_place = prepared.fs_scope() == nexus_tools::exec_contract::FsScope::Workspace;
        let mut op = serde_json::json!({
            "kind": "proc.run",
            "program": resolved.name,
            "resolvedProgram": resolved.program,
            "argv": resolved.argv,
            "argvDigest": resolved.argv_digest(),
            "cwd": resolved.cwd,
            "sandbox": {
                "backend": "bubblewrap+seccomp+cgroup-v2",
                "network": if resolved.install { "install" } else { "none" },
                "workspace": if daemon.command_policy.is_workbench() { "throw-away copy of the snapshot" } else { "read-only snapshot" },
                "writeBack": "none",
                "env": "allowlist", "shell": resolved.name == "sh",
            },
            "filesystemEffects": "none to the workspace: runs on a staged read-only snapshot; scratch output is discarded",
        });
        if in_place {
            // Truthful and sealed: the reviewed operation (and so the Kernel scope bound from it) says the
            // command writes the task's own working copy in place. `execFsScope` is the single field the
            // Kernel reads; it is absent for every scratch operation, which stay byte-identical.
            op["execFsScope"] = "workspace".into();
            op["sandbox"]["workspace"] =
                "the task's disposable working copy, read-write in place".into();
            op["sandbox"]["writeBack"] = "in-place-task-copy".into();
            op["filesystemEffects"] = "files the command creates, changes or deletes persist in this task's working copy (not the user's folder); .git is read-only; secret-shaped top-level entries are hidden".into();
        }
        sub_common(
            "process",
            &prepared,
            Vec::new(),
            op,
            serde_json::json!({
                "kind": "argv", "digest": resolved.argv_digest(),
                "text": resolved.display(),
                "note": "argv field of the operation is the exact, unredacted vector",
            }),
            serde_json::json!({
                "procWallMs": b.proc_wall_ms, "procCpuSecs": b.proc_cpu_secs,
                "procMemoryBytes": b.proc_memory_bytes, "procMaxProcs": b.proc_max_procs,
                "procOutputBytes": b.proc_output_bytes, "procScratchBytes": b.proc_scratch_bytes,
            }),
        )
    };
    let mut sub = sub;
    if let (Some(o), Some(op)) = (&ai_origin, sub.operation.as_object_mut()) {
        // Part of the sealed, reviewed request: the approver sees that a model
        // proposed this operation (never a claim that a human did).
        op.insert(
            "proposedBy".to_owned(),
            serde_json::json!({ "origin": "model", "ref": o }),
        );
    }
    match kernel.create_approval(&sub) {
        Ok(row) => {
            let mut row = row;
            if let Some(cfg) = &daemon.autonomous {
                // A6.1.4: decide by automated workspace policy; never by a human.
                match evaluate_autonomous_policy(daemon, cfg, &sub) {
                    Ok(facts) => {
                        let d = nexus_kernel::PolicyDecision {
                            policy_id: AUTONOMOUS_POLICY_ID.to_owned(),
                            policy_digest: autonomous_policy_digest(
                                cfg,
                                daemon.isolated_exec_scope
                                    == nexus_tools::exec_contract::FsScope::Workspace,
                            ),
                            request_digest: row.request_digest.clone(),
                            scope_cap: if sub.scope == "process" {
                                ceiling.proc_wall_ms
                            } else {
                                ceiling.max_write_bytes
                            },
                            facts,
                        };
                        match kernel.decide_approval_by_policy(&row.approval_id, &d) {
                            Ok(decided) => {
                                if let Ok(mut m) = daemon.autonomous_counters.lock() {
                                    let e = m.entry(sub.task_instance_id.clone()).or_insert((0, 0));
                                    if sub.scope == "process" {
                                        e.1 += 1;
                                    } else {
                                        e.0 += 1;
                                    }
                                }
                                row = decided;
                            }
                            Err(e) => {
                                let _ = kernel
                                    .revoke_approval(&row.approval_id, "policy-decision-failed");
                                return kernel_fail(daemon, &req.id, &e);
                            }
                        }
                    }
                    Err(why) => {
                        let _ = kernel.revoke_approval(&row.approval_id, "policy-refused");
                        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                        return fail(
                            &req.id,
                            "policy-refused",
                            format!("automated workspace policy refused this operation: {why}"),
                        );
                    }
                }
            }
            log_line("approval-request", &req.id, "ok", &req.cmd);
            ok(
                &req.id,
                serde_json::json!({ "approval": approval_state_view(&row, false) }),
            )
        }
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn sha256_hex_str(s: &str) -> String {
    hex::encode(<sha2::Sha256 as sha2::Digest>::digest(s.as_bytes()))
}

fn do_approval_revoke(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(&req.params, &["approvalId", "reason"], &req.id) {
        return r;
    }
    let id = match get_string(&req.params, "approvalId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let reason = req
        .params
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("issuer-withdrawn")
        .to_owned();
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    match kernel.revoke_approval(&id, &reason) {
        Ok(changed) => ok(&req.id, serde_json::json!({ "revoked": changed })),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

/// Read-only metadata listing. No preview text, no review code, no
/// credentials. Gated by the issuer allow-list OR the approver UID list.
fn do_approval_list(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> serde_json::Value {
    if let Err(r) = only_keys(
        &req.params,
        &["taskInstanceId", "approvalId", "limit"],
        &req.id,
    ) {
        return r;
    }
    if !daemon.require_human_approval {
        return fail(
            &req.id,
            "approval-disabled",
            "human approval mode is not enabled on this daemon",
        );
    }
    let uid_ok = match peer {
        Some((uid, _, _)) => {
            daemon
                .allowed_uids
                .as_ref()
                .is_some_and(|v| v.contains(&uid))
                || daemon
                    .approver_uids
                    .as_ref()
                    .is_some_and(|v| v.contains(&uid))
        }
        None => false,
    };
    if !uid_ok {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        return fail(
            &req.id,
            codes::PEER_UNAUTHORIZED,
            "connecting process UID is not authorized to read approval history",
        );
    }
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    if let Some(id) = req.params.get("approvalId").and_then(|v| v.as_str()) {
        return match kernel.approval_history(id) {
            Ok((Some(row), ev)) => ok(
                &req.id,
                serde_json::json!({
                    "approval": approval_state_view(&row, false),
                    "events": ev.iter().map(|e| serde_json::json!({
                        "seq": e.seq, "event": e.event, "atMs": e.recorded_ms,
                        "payload": e.payload,
                    })).collect::<Vec<_>>(),
                }),
            ),
            Ok((None, _)) => fail(&req.id, "delivery-invalid", "unknown approval"),
            Err(e) => kernel_fail(daemon, &req.id, &e),
        };
    }
    let limit = req
        .params
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(100) as usize;
    let task = req.params.get("taskInstanceId").and_then(|v| v.as_str());
    match kernel.list_approvals(task, limit) {
        Ok(rows) => ok(
            &req.id,
            serde_json::json!({
                "approvals": rows.iter().map(|r| approval_state_view(r, false)).collect::<Vec<_>>(),
                "approvalAction": "terminal-only",
            }),
        ),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

/// Approver fetches the authoritative review (full request, diff, review
/// code). Recording this fetch is what arms a later decision.
fn do_approval_get(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> serde_json::Value {
    let (uid, _, _) = match approver_gate(daemon, req, peer) {
        Ok(p) => p,
        Err(r) => return r,
    };
    if let Err(r) = only_keys(&req.params, &["approvalId"], &req.id) {
        return r;
    }
    let id = match get_string(&req.params, "approvalId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    match kernel.review_approval(&id, uid) {
        Ok(row) => {
            let mut v = approval_state_view(&row, true);
            v["reviewCode"] = serde_json::json!(row.review_code);
            ok(&req.id, serde_json::json!({ "approval": v }))
        }
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn do_approval_decide(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> serde_json::Value {
    let (uid, gid, pid) = match approver_gate(daemon, req, peer) {
        Ok(p) => p,
        Err(r) => return r,
    };
    if let Err(r) = only_keys(
        &req.params,
        &[
            "approvalId",
            "requestDigest",
            "decision",
            "reviewCode",
            "reason",
            "confirmation",
        ],
        &req.id,
    ) {
        return r;
    }
    let id = match get_string(&req.params, "approvalId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let digest = match get_string(&req.params, "requestDigest") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let code = match get_string(&req.params, "reviewCode") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let approve = match req.params.get("decision").and_then(|v| v.as_str()) {
        Some("approve") => true,
        Some("deny") => false,
        _ => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'decision' must be 'approve' or 'deny'",
            )
        }
    };
    let reason = req
        .params
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let tty_attested = req
        .params
        .get("confirmation")
        .and_then(|c| c.get("tty"))
        .and_then(|t| t.as_bool())
        .unwrap_or(false);
    // Only facts the daemon itself verified are recorded as verified. The
    // client's TTY claim is stored as an attestation, never as proof.
    let human_auth = serde_json::json!({
        "mechanism": "approver-uid-terminal-review-code",
        "verifiedByDaemon": ["approver-hmac-capability", "peer-uid-allowlist", "prior-authenticated-review", "review-code-echo"],
        "clientAttested": { "tty": tty_attested },
        "notVerified": ["human-presence", "tty-origin"],
        "peerUid": uid, "peerGid": gid, "peerPid": pid,
    });
    let ceiling = nexus_tools::ToolBudgets::ceiling();
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    // Scope cap depends on the approval's scope; the Kernel re-reads it.
    let cap = match kernel.approval_history(&id) {
        Ok((Some(r), _)) if r.scope == "process" => ceiling.proc_wall_ms,
        Ok((Some(_), _)) => ceiling.max_write_bytes,
        Ok((None, _)) => return fail(&req.id, "delivery-invalid", "unknown approval"),
        Err(e) => return kernel_fail(daemon, &req.id, &e),
    };
    let d = nexus_kernel::ApprovalDecision {
        approve,
        request_digest: digest,
        review_code: code,
        approver_id: format!("uid:{uid}"),
        independent: daemon.approver_independent,
        reason,
        human_auth,
        scope_cap: cap,
    };
    match kernel.decide_approval(&id, &d) {
        Ok(row) => {
            log_line("approval-decision", &req.id, &row.state, &req.cmd);
            ok(
                &req.id,
                serde_json::json!({ "approval": approval_state_view(&row, false) }),
            )
        }
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

/// A4.3 read-only integrity status. Never mutates authoritative history;
/// a verified result may clear a recoverable block, a mismatch never does.
fn do_integrity_status(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> serde_json::Value {
    if let Err(r) = only_keys(&req.params, &[], &req.id) {
        return r;
    }
    let uid_ok = match (&daemon.allowed_uids, peer) {
        (None, _) => true,
        (Some(allowed), Some((uid, _, _))) => {
            allowed.contains(&uid)
                || daemon
                    .approver_uids
                    .as_ref()
                    .is_some_and(|v| v.contains(&uid))
        }
        _ => false,
    };
    if !uid_ok {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        return fail(
            &req.id,
            codes::PEER_UNAUTHORIZED,
            "connecting process UID is not authorized to read integrity status",
        );
    }
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let rep = kernel.integrity_report(true);
    ok(
        &req.id,
        serde_json::json!({ "integrity": rep, "securityProfile": daemon.security_profile }),
    )
}

/// Daemon-side hooks for the write lifecycle: journal and fence take the
/// Kernel lock only briefly per call; nothing is held across file I/O.
struct DaemonWriteHooks<'a> {
    daemon: &'a Daemon,
    verified: &'a nexus_kernel::VerifiedToolGrant,
    last_seq: i64,
    /// Direct Workspace: the task's pre-image store (None = an isolated copy).
    direct: Option<nexus_tools::direct::Store>,
}

impl nexus_tools::WriteHooks for DaemonWriteHooks<'_> {
    fn journal(
        &mut self,
        phase: &str,
        payload: serde_json::Value,
    ) -> Result<(), nexus_tools::ToolError> {
        let verified_post = (self.direct.is_some() && phase == nexus_tools::write::PH_VERIFIED)
            .then(|| {
                (
                    payload
                        .get("path")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                    payload
                        .get("postSha256")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                )
            })
            .and_then(|(p, post)| p.map(|p| (p, post)));
        let mut k = self.daemon.kernel.lock().map_err(|_| {
            nexus_tools::ToolError::new(
                nexus_tools::ToolErrorCode::IoError,
                "kernel mutex is poisoned; failing closed",
            )
        })?;
        let e = k
            .record_write_phase(self.verified, phase, payload)
            .map_err(|e| {
                nexus_tools::ToolError::new(
                    nexus_tools::ToolErrorCode::AuthorizationRefused,
                    format!("journal refused ({}): {}", e.code.as_str(), e.message),
                )
            })?;
        self.last_seq = e.seq;
        drop(k);
        // Direct Workspace: remember what Nexus last verified for this path, so a later change made by
        // someone else is recognised as theirs. (Best effort: a stale record only over-reports.)
        if let (Some(store), Some((path, post))) = (&self.direct, verified_post) {
            let _ = store.record_post(&path, post.as_deref());
        }
        Ok(())
    }
    fn fence(&mut self) -> Result<(), nexus_tools::ToolError> {
        let k = self.daemon.kernel.lock().map_err(|_| {
            nexus_tools::ToolError::new(
                nexus_tools::ToolErrorCode::Revoked,
                "kernel unavailable; failing closed",
            )
        })?;
        k.check_tool_fence_for(self.verified.grant()).map_err(|e| {
            nexus_tools::ToolError::new(
                nexus_tools::ToolErrorCode::Revoked,
                format!("authority revoked ({})", e.code.as_str()),
            )
        })
    }
    fn dirs_created(&mut self, dirs: &[String]) -> Result<(), nexus_tools::ToolError> {
        match &self.direct {
            None => Ok(()),
            Some(store) => store.record_dirs(dirs).map_err(|e| {
                nexus_tools::ToolError::new(
                    nexus_tools::ToolErrorCode::IoError,
                    format!(
                        "the new folders could not be recorded ({}); nothing was changed",
                        e.message
                    ),
                )
            }),
        }
    }
    fn preimage(
        &mut self,
        path: &str,
        pre: Option<&[u8]>,
        mode: Option<u32>,
    ) -> Result<(), nexus_tools::ToolError> {
        match &self.direct {
            None => Ok(()),
            // no edit or deletion in the user's folder happens without its original being kept
            Some(store) => store.record_pre(path, pre, mode).map_err(|e| {
                nexus_tools::ToolError::new(
                    nexus_tools::ToolErrorCode::IoError,
                    format!(
                        "the original could not be kept ({}); nothing was changed",
                        e.message
                    ),
                )
            }),
        }
    }
}

/// Daemon hooks for the sandboxed-process lifecycle (brief Kernel locks).
struct DaemonProcessHooks<'a> {
    daemon: &'a Daemon,
    verified: &'a nexus_kernel::VerifiedToolGrant,
    last_seq: i64,
}

impl nexus_tools::process::ProcessHooks for DaemonProcessHooks<'_> {
    fn journal(
        &mut self,
        phase: &str,
        payload: serde_json::Value,
    ) -> Result<(), nexus_tools::ToolError> {
        let mut k = self.daemon.kernel.lock().map_err(|_| {
            nexus_tools::ToolError::new(
                nexus_tools::ToolErrorCode::IoError,
                "kernel mutex is poisoned; failing closed",
            )
        })?;
        let e = k
            .record_process_phase(self.verified, phase, payload)
            .map_err(|e| {
                nexus_tools::ToolError::new(
                    nexus_tools::ToolErrorCode::AuthorizationRefused,
                    format!("journal refused ({}): {}", e.code.as_str(), e.message),
                )
            })?;
        self.last_seq = e.seq;
        Ok(())
    }
    fn fence(&mut self) -> Result<(), nexus_tools::ToolError> {
        let k = self.daemon.kernel.lock().map_err(|_| {
            nexus_tools::ToolError::new(
                nexus_tools::ToolErrorCode::Revoked,
                "kernel unavailable; failing closed",
            )
        })?;
        k.check_tool_fence_for(self.verified.grant()).map_err(|e| {
            nexus_tools::ToolError::new(
                nexus_tools::ToolErrorCode::Revoked,
                format!("authority revoked ({})", e.code.as_str()),
            )
        })
    }
}

// ---------------------------------------------------------------- A3.2 tools

/// Hard bound on concurrent tool executions.
pub const MAX_TOOL_INFLIGHT: usize = 4;
const TOOL_EVENTS_MAX_PAGE: usize = 200;
const TOOL_EVENTS_DEFAULT_PAGE: usize = 100;

struct InflightGuard<'a>(&'a AtomicUsize);
impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn lock_kernel<'a>(
    daemon: &'a Daemon,
    id: &str,
) -> Result<std::sync::MutexGuard<'a, nexus_kernel::Kernel>, serde_json::Value> {
    daemon.kernel.lock().map_err(|_| {
        daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
        fail(
            id,
            codes::STORE_UNHEALTHY,
            "kernel mutex is poisoned; failing closed",
        )
    })
}

fn only_keys(
    params: &serde_json::Map<String, serde_json::Value>,
    allowed: &[&str],
    id: &str,
) -> Result<(), serde_json::Value> {
    for k in params.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(fail(
                id,
                codes::BAD_REQUEST,
                format!(
                    "bad-request: unknown parameter '{}' (no caller-supplied roots or paths are accepted)",
                    k.chars().take(40).collect::<String>()
                ),
            ));
        }
    }
    Ok(())
}

fn get_u64(
    params: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    id: &str,
) -> Result<u64, serde_json::Value> {
    params.get(field).and_then(|v| v.as_u64()).ok_or_else(|| {
        fail(
            id,
            codes::BAD_REQUEST,
            format!("bad-request: '{field}' must be an unsigned integer"),
        )
    })
}

fn do_workspace_bind(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(&req.params, &["commandId", "root", "directTask"], &req.id) {
        return r;
    }
    let command_id = match get_string(&req.params, "commandId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let root = match get_string(&req.params, "root") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    // Direct Workspace: the folder of a task the daemon itself opened as direct (from its identity
    // record, which came from the trusted registry) is an allowed base for exactly that binding.
    // The caller names the task, never an allowed path; the root it asks for must be that folder.
    let mut bases = daemon.workspace_bases.clone();
    let mut direct_task: Option<String> = None;
    if let Some(v) = req.params.get("directTask") {
        let Some(task) = v.as_str() else {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'directTask' must be a string",
            );
        };
        let ok_root = direct_meta(daemon, task)
            .and_then(|m| m.get("root").and_then(|r| r.as_str()).map(str::to_owned))
            .filter(|r| {
                std::fs::canonicalize(&root).ok().as_deref() == Some(std::path::Path::new(r))
            });
        match ok_root {
            Some(r) => {
                bases.push(std::path::PathBuf::from(r));
                direct_task = Some(task.to_owned());
            }
            None => {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return fail(
                    &req.id,
                    "scope-refused",
                    "that is not the folder of an open direct workspace",
                );
            }
        }
    }
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    match kernel.bind_workspace(&command_id, &root, &bases) {
        Ok(b) => {
            if let Some(t) = &direct_task {
                if &b.task_instance_id != t {
                    // a direct folder bound to another task's command: undo the authority
                    let _ = kernel.revoke_tools(&command_id, "direct-workspace-task-mismatch");
                    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                    return fail(
                        &req.id,
                        "scope-refused",
                        "the direct workspace belongs to another task",
                    );
                }
            }
            // The root path itself is deliberately not echoed back.
            ok(
                &req.id,
                serde_json::json!({
                    "binding": {
                        "commandId": b.command_id,
                        "taskInstanceId": b.task_instance_id,
                        "attemptId": b.attempt_id,
                        "leaseEpoch": b.lease_epoch,
                        "rootDigest": b.root_digest,
                    }
                }),
            )
        }
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

// ---- A5.6: isolated working copies for autonomous coding ------------------

fn wt_fail(daemon: &Daemon, id: &str, e: &nexus_tools::gitwt::WtError) -> serde_json::Value {
    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
    fail(id, e.code, &e.message)
}

fn wt_root<'a>(daemon: &'a Daemon, id: &str) -> Result<&'a std::path::PathBuf, serde_json::Value> {
    if !daemon.repo_code_enabled {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        return Err(fail(
            id,
            "scope-refused",
            "the repo-code pilot is not enabled on this daemon",
        ));
    }
    daemon.worktree_root.as_ref().ok_or_else(|| {
        fail(
            id,
            "scope-refused",
            "no worktree root is configured on this daemon",
        )
    })
}

/// The project environment of a task: derived only from the daemon's own copy identity
/// record (the project the copy was made for), never from what a caller asserts.
fn project_env_for(daemon: &Daemon, task: &str) -> Option<nexus_tools::process::ProjectEnv> {
    let envs = daemon.project_envs.as_ref()?;
    let root = daemon.worktree_root.as_ref()?;
    if !nexus_tools::gitwt::valid_task_id(task) {
        return None;
    }
    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(wt_meta_path(root, task)).ok()?).ok()?;
    let pid = meta.get("projectId")?.as_str()?;
    if pid.is_empty()
        || pid.len() > 80
        || !pid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return None;
    }
    let dir = envs.join(pid);
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .ok()?;
    }
    Some(nexus_tools::process::ProjectEnv {
        dir,
        installs: meta.get("installs").and_then(|v| v.as_bool()) == Some(true),
    })
}

fn wt_meta_path(root: &std::path::Path, task: &str) -> std::path::PathBuf {
    root.join(".meta").join(format!("{task}.json"))
}

/// Direct Workspace: the identity record of a task that edits the project's REAL folder
/// (`kind == "direct"`), written by `direct-open` from the trusted registry and never by a caller.
fn direct_meta(daemon: &Daemon, task: &str) -> Option<serde_json::Value> {
    let root = daemon.worktree_root.as_ref()?;
    if !nexus_tools::gitwt::valid_task_id(task) {
        return None;
    }
    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(wt_meta_path(root, task)).ok()?).ok()?;
    (meta.get("kind").and_then(|v| v.as_str()) == Some("direct")).then_some(meta)
}

/// The pre-image store and root folder of a direct task.
fn direct_store(daemon: &Daemon, task: &str) -> Option<(nexus_tools::direct::Store, String)> {
    let meta = direct_meta(daemon, task)?;
    let root = meta.get("root")?.as_str()?.to_owned();
    let base = daemon.worktree_root.as_ref()?;
    Some((nexus_tools::direct::Store::at(base, task), root))
}

/// The directory a task's tools edit: its isolated copy, or the real folder of a direct task.
fn task_workspace_dir(daemon: &Daemon, task: &str) -> Option<std::path::PathBuf> {
    if let Some(m) = direct_meta(daemon, task) {
        return m.get("root")?.as_str().map(std::path::PathBuf::from);
    }
    let root = daemon.worktree_root.as_ref()?;
    nexus_tools::gitwt::valid_task_id(task).then(|| root.join(task))
}

fn do_worktree_create(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(
        &req.params,
        &[
            "taskInstanceId",
            "sourceRoot",
            "expectedCommit",
            "projectId",
        ],
        &req.id,
    ) {
        return r;
    }
    let expected_commit: Option<String> = match req.params.get("expectedCommit") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(c))
            if c.len() == 40
                && c.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) =>
        {
            Some(c.clone())
        }
        Some(_) => {
            return fail(
                &req.id,
                "bad-request",
                "bad-request: 'expectedCommit' must be a 40-character lowercase hex commit id",
            )
        }
    };
    let root = match wt_root(daemon, &req.id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let task = match get_string(&req.params, "taskInstanceId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    // A6.1.3: with a project registry the daemon decides what a project is: the
    // caller names an id, never a path, and the pin comes from the registry.
    let mut project_id: Option<String> = None;
    let mut project_write_allow: Vec<String> = Vec::new();
    let mut project_installs = false;
    let mut expected_commit = expected_commit;
    let canon = if let Some((dir, trust)) = &daemon.project_registry {
        if req.params.get("sourceRoot").is_some() {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                "scope-refused",
                "this daemon is registry-managed: a caller-supplied source path is refused",
            );
        }
        let pid = match get_string(&req.params, "projectId") {
            Ok(v) => v,
            Err(r) => return with_id(r, &req.id),
        };
        let rec = match nexus_tools::registry::resolve(dir, trust, &pid) {
            Ok(r) => r,
            Err(e) => {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return fail(&req.id, "scope-refused", format!("project refused: {e}"));
            }
        };
        let canon = std::path::PathBuf::from(&rec.source_path);
        if canon.starts_with(root) || root.starts_with(&canon) {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                "scope-refused",
                "project source overlaps the working-copy root",
            );
        }
        if let Some(c) = &expected_commit {
            if c != &rec.pinned_commit {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return fail(
                    &req.id,
                    "scope-refused",
                    "the requested commit is not the commit the operator pinned for this project",
                );
            }
        }
        expected_commit = Some(rec.pinned_commit.clone());
        project_write_allow = rec.write_allow.clone();
        project_installs = rec.installs;
        project_id = Some(pid);
        canon
    } else {
        if req.params.get("projectId").is_some() {
            return fail(
                &req.id,
                "scope-refused",
                "this daemon has no project registry",
            );
        }
        let source = match get_string(&req.params, "sourceRoot") {
            Ok(v) => v,
            Err(r) => return with_id(r, &req.id),
        };
        if !source.starts_with('/') || source.contains('\0') {
            return fail(
                &req.id,
                "scope-refused",
                "source root must be an absolute path",
            );
        }
        // The source repository must lie beneath an operator-allowed base, just
        // like a bound workspace (the issuer does not get to pick any directory).
        let canon = match std::fs::canonicalize(&source) {
            Ok(c) => c,
            Err(_) => return fail(&req.id, "scope-refused", "source repository does not exist"),
        };
        let beneath = daemon.workspace_bases.iter().any(|b| {
            std::fs::canonicalize(b)
                .map(|cb| cb != std::path::Path::new("/") && canon.starts_with(&cb))
                .unwrap_or(false)
        });
        if !beneath {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                "scope-refused",
                "source repository is not beneath an operator-allowed workspace base",
            );
        }
        canon
    };
    let info = match nexus_tools::gitwt::create(&canon, root, &task) {
        Ok(i) => i,
        Err(e) => return wt_fail(daemon, &req.id, &e),
    };
    // A6.1: a source can be pinned to one exact commit by the operator. The
    // copy is made from the commit the source REALLY has; if that is not the
    // pinned one the copy is removed again and nothing is handed out.
    if let Some(want) = &expected_commit {
        if &info.source.commit != want {
            let _ = nexus_tools::gitwt::remove(root, &task);
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                "scope-refused",
                "the source repository is not at the commit the operator pinned for it",
            );
        }
    }
    // Authoritative record of what this copy was made from (outside the
    // workspace the tools can reach).
    let meta_dir = root.join(".meta");
    let meta = serde_json::json!({
        "taskInstanceId": task,
        "sourceCommit": info.source.commit,
        "sourceRepoId": info.source.repo_id,
        "projectId": project_id,
        // Frozen at creation: a later registry change never alters a started task.
        "writeAllow": project_write_allow,
        "installs": project_installs,
        // Frozen at creation, from the operator's daemon setting (never from the caller): the
        // filesystem scope commands in this task run under. Absent in a record = scratch.
        "execFsScope": daemon.isolated_exec_scope.as_str(),
        "createdAtMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    let wrote = (|| -> std::io::Result<()> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&meta_dir)?;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(wt_meta_path(root, &task))?;
        std::io::Write::write_all(&mut f, meta.to_string().as_bytes())?;
        f.sync_all()
    })();
    if wrote.is_err() {
        let _ = nexus_tools::gitwt::remove(root, &task);
        return fail(
            &req.id,
            "internal",
            "cannot record the working copy identity",
        );
    }
    // In-place commands may create dependency and tool-cache directories in the copy. They are not part
    // of the reviewable change (the same names the stager and the effect report already treat as
    // toolchain artifacts), so the copy's own git excludes them - written here, outside the sandbox
    // (which sees `.git` read-only).
    if daemon.isolated_exec_scope == nexus_tools::exec_contract::FsScope::Workspace {
        let ex = info.path.join(".git").join("info");
        let res = std::fs::create_dir_all(&ex).and_then(|_| {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(ex.join("exclude"))?;
            f.write_all(
                b"\n# Nexus: toolchain artifacts of in-place commands are not part of the change\nnode_modules/\n.venv/\nvenv/\n__pycache__/\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n.next/\n.cache/\n",
            )?;
            f.sync_all()
        });
        if res.is_err() {
            let _ = std::fs::remove_file(wt_meta_path(root, &task));
            let _ = nexus_tools::gitwt::remove(root, &task);
            return fail(
                &req.id,
                "internal",
                "cannot prepare the working copy for in-place commands",
            );
        }
    }
    ok(
        &req.id,
        serde_json::json!({
            "worktree": {
                "path": info.path.to_string_lossy(),
                "sourceCommit": info.source.commit,
                "sourceRepoId": info.source.repo_id,
                "execFsScope": daemon.isolated_exec_scope.as_str(),
            }
        }),
    )
}

/// The filesystem scope commands of a task run under: read ONLY from the daemon's own identity
/// record of the task (written at creation from the operator's setting), never from a request. A
/// direct task, a missing record or an unknown name never yields `workspace`.
fn task_fs_scope(daemon: &Daemon, task: &str) -> nexus_tools::exec_contract::FsScope {
    use nexus_tools::exec_contract::FsScope;
    let Some(root) = daemon.worktree_root.as_ref() else {
        return FsScope::Scratch;
    };
    if !nexus_tools::gitwt::valid_task_id(task) {
        return FsScope::Scratch;
    }
    let meta: Option<serde_json::Value> = std::fs::read_to_string(wt_meta_path(root, task))
        .ok()
        .and_then(|r| serde_json::from_str(&r).ok());
    let Some(meta) = meta else {
        return FsScope::Scratch;
    };
    if meta.get("kind").and_then(|v| v.as_str()) == Some("direct") {
        // Direct + in-place execution is a later stage; it is never inferred.
        return FsScope::Scratch;
    }
    match meta.get("execFsScope").and_then(|v| v.as_str()) {
        Some("workspace") => FsScope::Workspace,
        _ => FsScope::Scratch,
    }
}

/// Direct Workspace: open a task whose edits go to the project's REAL folder.
///
/// The caller names a project id (never a path); the folder, the write scope and the install
/// policy come from the trusted registry record, and only for a project whose durable workspace
/// choice is `direct`. The daemon re-validates the folder itself, writes the task's identity
/// record (`kind: direct`) outside the folder and creates its pre-image store. Nothing in the
/// folder is created, changed or removed here.
fn do_direct_open(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(
        &req.params,
        &["taskInstanceId", "projectId", "fromTaskInstanceId"],
        &req.id,
    ) {
        return r;
    }
    let root = match wt_root(daemon, &req.id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let task = match get_string(&req.params, "taskInstanceId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    if !nexus_tools::gitwt::valid_task_id(&task) {
        return fail(
            &req.id,
            "bad-request",
            "bad-request: invalid task instance id",
        );
    }
    let Some((dir, trust)) = &daemon.project_registry else {
        return fail(
            &req.id,
            "scope-refused",
            "this daemon has no project registry; a direct workspace needs one",
        );
    };
    let pid = match get_string(&req.params, "projectId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let rec = match nexus_tools::registry::resolve(dir, trust, &pid) {
        Ok(r) => r,
        Err(e) => {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(&req.id, "scope-refused", format!("project refused: {e}"));
        }
    };
    if rec.workspace_mode != nexus_tools::registry::WorkspaceMode::Direct || !rec.managed {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        return fail(
            &req.id,
            "scope-refused",
            "this project is not set to edit its folder directly",
        );
    }
    let Some(origin) = rec.origin.clone() else {
        return fail(&req.id, "scope-refused", "the project has no folder");
    };
    let mut forbidden = vec![root.clone(), daemon.run_root.clone(), dir.clone()];
    if let Some(e) = &daemon.project_envs {
        forbidden.push(e.clone());
    }
    let canon = match nexus_tools::direct::validate_root(&origin, &forbidden) {
        Ok(c) => c,
        Err(e) => {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(&req.id, e.code, e.message);
        }
    };
    let canon_s = canon.to_string_lossy().into_owned();
    // an earlier task of the same conversation/continuation: what Nexus wrote there and someone
    // else changed since is reported (never blocked: every write is pre-image guarded anyway)
    let mut external: Vec<String> = Vec::new();
    let mut from_known = false;
    if let Some(from) = req
        .params
        .get("fromTaskInstanceId")
        .and_then(|v| v.as_str())
    {
        if nexus_tools::gitwt::valid_task_id(from) {
            if let Some((fs, froot)) = direct_store(daemon, from) {
                from_known = true;
                if froot == canon_s {
                    external =
                        nexus_tools::direct::external_changes(&fs, &canon_s).unwrap_or_default();
                    external.truncate(50);
                }
            }
        }
    }
    let meta = serde_json::json!({
        "taskInstanceId": task,
        "kind": "direct",
        "root": canon_s,
        "projectId": pid,
        // Frozen at creation: a later registry change never alters a started task.
        "writeAllow": rec.write_allow,
        "installs": rec.installs,
        "createdAtMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    let wrote = (|| -> std::io::Result<()> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root.join(".meta"))?;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(wt_meta_path(root, &task))?;
        std::io::Write::write_all(&mut f, meta.to_string().as_bytes())?;
        f.sync_all()
    })();
    if wrote.is_err() {
        return fail(
            &req.id,
            "internal",
            "cannot record the direct workspace identity",
        );
    }
    if let Err(e) = nexus_tools::direct::Store::create(root, &task, &canon_s) {
        let _ = std::fs::remove_file(wt_meta_path(root, &task));
        return fail(&req.id, e.code, e.message);
    }
    ok(
        &req.id,
        serde_json::json!({
            "direct": {
                "path": canon_s,
                "externalChanges": external,
                "fromRecorded": from_known,
            }
        }),
    )
}

fn wt_read_meta(root: &std::path::Path, task: &str) -> Option<(String, String)> {
    let raw = std::fs::read_to_string(wt_meta_path(root, task)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some((
        v.get("sourceCommit")?.as_str()?.to_owned(),
        v.get("sourceRepoId")?.as_str()?.to_owned(),
    ))
}

/// Carry an interrupted task's work into a fresh copy of the SAME project. Both copies are
/// daemon-owned; the caller names two task ids, never a path.
fn do_worktree_seed(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(
        &req.params,
        &["taskInstanceId", "fromTaskInstanceId", "rebase"],
        &req.id,
    ) {
        return r;
    }
    let rebase = req
        .params
        .get("rebase")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let root = match wt_root(daemon, &req.id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let (to, from) = match (
        get_string(&req.params, "taskInstanceId"),
        get_string(&req.params, "fromTaskInstanceId"),
    ) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(r), _) | (_, Err(r)) => return with_id(r, &req.id),
    };
    if !nexus_tools::gitwt::valid_task_id(&to)
        || !nexus_tools::gitwt::valid_task_id(&from)
        || to == from
    {
        return fail(
            &req.id,
            "bad-request",
            "bad-request: invalid task instance id",
        );
    }
    let meta = |t: &str| -> Option<serde_json::Value> {
        serde_json::from_str(&std::fs::read_to_string(wt_meta_path(root, t)).ok()?).ok()
    };
    let (Some(m_to), Some(m_from)) = (meta(&to), meta(&from)) else {
        return fail(&req.id, "not-found", "both working copies must exist");
    };
    if [&m_to, &m_from]
        .iter()
        .any(|m| m.get("kind").and_then(|v| v.as_str()) == Some("direct"))
    {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        return fail(
            &req.id,
            "scope-refused",
            "a direct workspace has no copy to seed: it edits the folder itself",
        );
    }
    // same project: otherwise the carried files would not belong here
    if m_to.get("projectId") != m_from.get("projectId")
        || m_to.get("projectId").is_none_or(|v| v.is_null())
    {
        return fail(
            &req.id,
            "scope-refused",
            "the two copies are not of the same project",
        );
    }
    // A conversation follow-up may start from a NEWER snapshot of the project (the folder
    // changed, or the earlier patch was applied to it): per file, carry / already applied /
    // conflict. Never silently: a conflict writes nothing and says which files.
    if m_to.get("sourceCommit") != m_from.get("sourceCommit") {
        if !rebase {
            return fail(
                &req.id,
                "scope-refused",
                "the two copies are not of the same project snapshot",
            );
        }
        let (Some(old_base), Some(new_base)) = (
            m_from.get("sourceCommit").and_then(|v| v.as_str()),
            m_to.get("sourceCommit").and_then(|v| v.as_str()),
        ) else {
            return fail(&req.id, "not-found", "both working copies must exist");
        };
        return match nexus_tools::gitwt::seed_rebase(
            &root.join(&from),
            old_base,
            &root.join(&to),
            new_base,
        ) {
            Ok(r) if r.conflicts.is_empty() => ok(
                &req.id,
                serde_json::json!({ "seeded": r.carried, "alreadyApplied": r.already_applied, "relation": "rebased" }),
            ),
            Ok(r) => {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                let shown: Vec<&str> = r.conflicts.iter().take(10).map(String::as_str).collect();
                fail(
                    &req.id,
                    "workspace-conflict",
                    format!(
                        "{} file(s) were changed both by this conversation and in your project since: {}",
                        r.conflicts.len(),
                        shown.join(", ")
                    ),
                )
            }
            Err(e) => wt_fail(daemon, &req.id, &e),
        };
    }
    let base = m_from
        .get("sourceCommit")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match nexus_tools::gitwt::seed_copy(&root.join(&from), base, &root.join(&to)) {
        Ok(n) => ok(
            &req.id,
            serde_json::json!({ "seeded": n, "alreadyApplied": 0, "relation": "continued" }),
        ),
        Err(e) => wt_fail(daemon, &req.id, &e),
    }
}

fn do_worktree_diff(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(&req.params, &["taskInstanceId"], &req.id) {
        return r;
    }
    let root = match wt_root(daemon, &req.id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let task = match get_string(&req.params, "taskInstanceId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    if !nexus_tools::gitwt::valid_task_id(&task) {
        return fail(
            &req.id,
            "bad-request",
            "bad-request: invalid task instance id",
        );
    }
    if let Some((store, droot)) = direct_store(daemon, &task) {
        return match nexus_tools::direct::diff(&store, &droot) {
            Ok(d) => ok(
                &req.id,
                serde_json::json!({
                    "diff": {
                        // the baseline is "the files as Nexus first found them", not a commit
                        "baseCommit": "direct",
                        "files": d.files,
                        "filesTruncated": d.files_truncated,
                        "diff": d.diff,
                        "diffDigest": d.diff_digest,
                        "diffTruncated": d.diff_truncated,
                        "createdDirs": d.created_dirs,
                    },
                    "direct": true,
                }),
            ),
            Err(e) => fail(&req.id, e.code, e.message),
        };
    }
    let Some((commit, repo_id)) = wt_read_meta(root, &task) else {
        return fail(
            &req.id,
            "not-found",
            "no working copy was created for this task",
        );
    };
    match nexus_tools::gitwt::diff(&root.join(&task), &commit) {
        Ok(d) => ok(
            &req.id,
            serde_json::json!({ "diff": d, "sourceRepoId": repo_id }),
        ),
        Err(e) => wt_fail(daemon, &req.id, &e),
    }
}

fn wt_meta_view(root: &std::path::Path, task: &str) -> serde_json::Value {
    let meta: serde_json::Value = std::fs::read_to_string(wt_meta_path(root, task))
        .ok()
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or(serde_json::Value::Null);
    let (bytes, entries, truncated) =
        nexus_tools::gitwt::disk_usage(root, task).unwrap_or((0, 0, false));
    let created = meta
        .get("createdAtMs")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            std::fs::symlink_metadata(root.join(task))
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
        });
    serde_json::json!({
        "taskInstanceId": task,
        "projectId": meta.get("projectId").cloned().unwrap_or(serde_json::Value::Null),
        "sourceCommit": meta.get("sourceCommit").cloned().unwrap_or(serde_json::Value::Null),
        "createdAtMs": created,
        "approxBytes": bytes,
        "entries": entries,
        "usageTruncated": truncated,
        "hasMeta": !meta.is_null(),
    })
}

/// A6.1.3 (issuer): every retained working copy under the managed root. Only real
/// directories directly beneath the root with a valid task-id name are listed;
/// symlinks and anything else are ignored.
fn do_worktree_list(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(&req.params, &[], &req.id) {
        return r;
    }
    let root = match wt_root(daemon, &req.id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !nexus_tools::gitwt::valid_task_id(&name) {
                continue;
            }
            match std::fs::symlink_metadata(e.path()) {
                Ok(m) if m.file_type().is_dir() => out.push(wt_meta_view(root, &name)),
                _ => {}
            }
        }
    }
    out.sort_by_key(|v| v["createdAtMs"].as_u64().unwrap_or(0));
    ok(&req.id, serde_json::json!({ "worktrees": out }))
}

fn do_worktree_stat(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(&req.params, &["taskInstanceId"], &req.id) {
        return r;
    }
    let root = match wt_root(daemon, &req.id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let task = match get_string(&req.params, "taskInstanceId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    if !nexus_tools::gitwt::valid_task_id(&task) {
        return fail(
            &req.id,
            "bad-request",
            "bad-request: invalid task instance id",
        );
    }
    if direct_meta(daemon, &task).is_some() {
        // there is no copy to retain, review-and-apply or remove: the folder IS the workspace
        return ok(
            &req.id,
            serde_json::json!({ "retained": false, "direct": true }),
        );
    }
    match std::fs::symlink_metadata(root.join(&task)) {
        Ok(m) if m.file_type().is_dir() => ok(
            &req.id,
            serde_json::json!({ "retained": true, "copy": wt_meta_view(root, &task) }),
        ),
        _ => ok(&req.id, serde_json::json!({ "retained": false })),
    }
}

/// Is a task's working copy in use? A pending/approved approval or a tool
/// execution that has not reached a terminal phase means yes.
fn wt_is_leased(daemon: &Daemon, task: &str) -> Result<bool, serde_json::Value> {
    let mut kernel = lock_kernel(daemon, "lease-check")?;
    if let Ok(rows) = kernel.list_approvals(Some(task), 500) {
        if rows
            .iter()
            .any(|r| r.state == "pending" || r.state == "approved")
        {
            return Ok(true);
        }
    }
    if let Ok(entries) = kernel.list_tool_journal(Some(task)) {
        let mut last: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
        for e in &entries {
            last.insert(e.execution_id.as_str(), e.phase.as_str());
        }
        if last.values().any(|p| {
            matches!(
                *p,
                "authorized" | "started" | "running" | "planned" | "prepared" | "applied"
            )
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn do_worktree_remove(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(&req.params, &["taskInstanceId"], &req.id) {
        return r;
    }
    let root = match wt_root(daemon, &req.id) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let task = match get_string(&req.params, "taskInstanceId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    if nexus_tools::gitwt::valid_task_id(&task) {
        match wt_is_leased(daemon, &task) {
            Ok(false) => {}
            Ok(true) => {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return fail(
                    &req.id,
                    "scope-refused",
                    "the working copy is in use (pending approval or unfinished tool execution)",
                );
            }
            Err(r) => return r,
        }
    }
    if let Some((store, _)) = direct_store(daemon, &task) {
        // a direct task has no copy: only its record and its kept originals go. The project's folder is
        // never a removal target (this branch never builds a path from the task id into the project).
        let _ = store.remove();
        let _ = std::fs::remove_file(wt_meta_path(root, &task));
        return ok(
            &req.id,
            serde_json::json!({ "removed": true, "direct": true }),
        );
    }
    match nexus_tools::gitwt::remove(root, &task) {
        Ok(()) => {
            let _ = std::fs::remove_file(wt_meta_path(root, &task));
            ok(&req.id, serde_json::json!({ "removed": true }))
        }
        Err(e) => wt_fail(daemon, &req.id, &e),
    }
}

fn do_tool_revoke(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    if let Err(r) = only_keys(&req.params, &["commandId", "reason"], &req.id) {
        return r;
    }
    let command_id = match get_string(&req.params, "commandId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let reason = req
        .params
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("controller-revoked")
        .to_owned();
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    match kernel.revoke_tools(&command_id, &reason) {
        Ok(()) => ok(&req.id, serde_json::json!({ "revoked": true })),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn tool_fail(daemon: &Daemon, id: &str, e: &nexus_tools::ToolError) -> serde_json::Value {
    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
    // Kernel refusals arrive wrapped (`authorization-refused`); trust-
    // threatening store states must still latch reconciliation.
    for code in [
        "reconciliation-required",
        "rollback-detected",
        "witness-required",
        "store-corrupt",
        "store-incompatible",
    ] {
        if e.message.contains(code) {
            latch_reconciliation(daemon, code, &e.message);
            break;
        }
    }
    fail(id, e.code.as_str(), &e.message)
}

/// Parse the shared tool-request shape for `approval-request` so the
/// approval is bound to exactly the request `tool-execute` will build.
fn build_tool_request(
    req: &IpcRequest,
    extra_keys: &[&str],
) -> Result<nexus_tools::ToolRequestV1, serde_json::Value> {
    let mut keys: Vec<&str> = vec![
        "requestId",
        "cancellationId",
        "taskInstanceId",
        "attemptId",
        "commandId",
        "leaseEpoch",
        "storeIncarnation",
        "toolId",
        "toolVersion",
        "args",
        "budgets",
    ];
    keys.extend_from_slice(extra_keys);
    only_keys(&req.params, &keys, &req.id)?;
    let s = |f: &str| get_string(&req.params, f).map_err(|r| with_id(r, &req.id));
    let bad = |m: &str| fail(&req.id, codes::BAD_REQUEST, m);
    let args = match req.params.get("args") {
        Some(v) if v.is_object() => v.clone(),
        _ => return Err(bad("bad-request: 'args' must be an object")),
    };
    let mut budgets = serde_json::to_value(nexus_tools::ToolBudgets::default())
        .unwrap_or(serde_json::Value::Null);
    if let Some(over) = req.params.get("budgets") {
        match (over.as_object(), budgets.as_object_mut()) {
            (Some(o), Some(b)) => {
                for (k, v) in o {
                    b.insert(k.clone(), v.clone());
                }
            }
            _ => return Err(bad("bad-request: 'budgets' must be an object")),
        }
    }
    let budgets: nexus_tools::ToolBudgets = serde_json::from_value(budgets)
        .map_err(|_| bad("bad-request: 'budgets' contains unknown or invalid fields"))?;
    Ok(nexus_tools::ToolRequestV1 {
        schema_version: nexus_tools::TOOL_CONTRACT_VERSION,
        request_id: s("requestId")?,
        cancellation_id: s("cancellationId")?,
        task_instance_id: s("taskInstanceId")?,
        attempt_id: s("attemptId")?,
        command_id: s("commandId")?,
        lease_epoch: get_u64(&req.params, "leaseEpoch", &req.id)?,
        store_incarnation: s("storeIncarnation")?,
        tool_id: s("toolId")?,
        tool_version: get_u64(&req.params, "toolVersion", &req.id)? as u32,
        args,
        budgets,
    })
}

fn do_tool_execute(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    const KEYS: &[&str] = &[
        "requestId",
        "cancellationId",
        "taskInstanceId",
        "attemptId",
        "commandId",
        "leaseEpoch",
        "storeIncarnation",
        "toolId",
        "toolVersion",
        "args",
        "budgets",
        "aiOrigin",
    ];
    if let Err(r) = only_keys(&req.params, KEYS, &req.id) {
        return r;
    }
    macro_rules! s {
        ($f:expr) => {
            match get_string(&req.params, $f) {
                Ok(v) => v,
                Err(r) => return with_id(r, &req.id),
            }
        };
    }
    let request_id = s!("requestId");
    let cancellation_id = s!("cancellationId");
    let task = s!("taskInstanceId");
    let attempt = s!("attemptId");
    let command = s!("commandId");
    let incarnation = s!("storeIncarnation");
    let tool_id = s!("toolId");
    let lease_epoch = match get_u64(&req.params, "leaseEpoch", &req.id) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let tool_version = match get_u64(&req.params, "toolVersion", &req.id) {
        Ok(v) => v as u32,
        Err(r) => return r,
    };
    let args = match req.params.get("args") {
        Some(v) if v.is_object() => v.clone(),
        _ => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'args' must be an object",
            )
        }
    };
    let mut budgets = serde_json::to_value(nexus_tools::ToolBudgets::default())
        .unwrap_or(serde_json::Value::Null);
    if let Some(over) = req.params.get("budgets") {
        match (over.as_object(), budgets.as_object_mut()) {
            (Some(o), Some(b)) => {
                for (k, v) in o {
                    b.insert(k.clone(), v.clone());
                }
            }
            _ => {
                return fail(
                    &req.id,
                    codes::BAD_REQUEST,
                    "bad-request: 'budgets' must be an object",
                )
            }
        }
    }
    let budgets: nexus_tools::ToolBudgets = match serde_json::from_value(budgets) {
        Ok(b) => b,
        Err(_) => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'budgets' contains unknown or invalid fields",
            )
        }
    };
    // A5.5: optional provenance marking a model-PROPOSED read call. The
    // Kernel (not this parser) decides whether it is admissible.
    let ai_origin: Option<String> = match req.params.get("aiOrigin") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(o)) => Some(o.clone()),
        Some(_) => {
            return fail(
                &req.id,
                codes::BAD_REQUEST,
                "bad-request: 'aiOrigin' must be a string",
            )
        }
    };
    let request = nexus_tools::ToolRequestV1 {
        schema_version: nexus_tools::TOOL_CONTRACT_VERSION,
        request_id: request_id.clone(),
        cancellation_id: cancellation_id.clone(),
        task_instance_id: task,
        attempt_id: attempt,
        command_id: command.clone(),
        lease_epoch,
        store_incarnation: incarnation,
        tool_id,
        tool_version,
        args,
        budgets,
    };
    if let Some(r) = write_scope_refusal(daemon, &request) {
        return with_id(r, &req.id);
    }
    // Bounded concurrency (backpressure, never an unbounded queue).
    if daemon.tool_inflight.fetch_add(1, Ordering::SeqCst) >= MAX_TOOL_INFLIGHT {
        daemon.tool_inflight.fetch_sub(1, Ordering::SeqCst);
        return fail(
            &req.id,
            codes::SERVER_BUSY,
            "too many concurrent tool executions",
        );
    }
    let _guard = InflightGuard(&daemon.tool_inflight);

    // Step 1 (under the Kernel lock): resolve the Controller binding,
    // pin the workspace, authorize, journal `started`.
    let cancel = nexus_tools::CancellationToken::new(&cancellation_id);
    let call = {
        let mut kernel = match lock_kernel(daemon, &req.id) {
            Ok(k) => k,
            Err(r) => return r,
        };
        let binding = match kernel.workspace_binding(&command) {
            Ok(Some(b)) => b,
            Ok(None) => {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return fail(
                    &req.id,
                    "delivery-invalid",
                    "no Controller workspace binding for this command; tool execution refused",
                );
            }
            Err(e) => return kernel_fail(daemon, &req.id, &e),
        };
        let mutating = nexus_tools::ToolId::parse(&request.tool_id)
            .map(|t| t.is_mutating())
            .unwrap_or(false);
        let is_process = nexus_tools::ToolId::parse(&request.tool_id)
            .map(|t| t.is_process())
            .unwrap_or(false);
        if is_process && !daemon.process_enabled {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                "process-disabled",
                "sandboxed process execution is not enabled on this daemon",
            );
        }
        let mut proc_scope_wall: u64 = 0;
        if mutating && !daemon.writes_enabled {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                "write-disabled",
                "write tools are not enabled on this daemon",
            );
        }
        let prepared = if is_process {
            let scope = match kernel.process_scope_binding(&command) {
                Ok(Some(s)) => s,
                Ok(None) => {
                    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                    return fail(
                        &req.id,
                        "scope-refused",
                        "no independently approved process scope for this command; execution refused",
                    );
                }
                Err(e) => return kernel_fail(daemon, &req.id, &e),
            };
            // The Kernel-sealed filesystem scope must be the one the daemon derives from its own record
            // of this task: an approval for one scope is never executed under another.
            if scope.fs_scope != task_fs_scope(daemon, &request.task_instance_id).as_str() {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return fail(
                    &req.id,
                    "scope-refused",
                    "the approved filesystem scope is not this task's scope; execution refused",
                );
            }
            proc_scope_wall = scope.max_wall_ms;
            nexus_tools::prepare_process(request, &binding, &scope, &daemon.command_policy)
        } else if mutating {
            let scope = match kernel.write_scope_binding(&command) {
                Ok(Some(s)) => s,
                Ok(None) => {
                    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                    return fail(
                        &req.id,
                        "scope-refused",
                        "no independently approved write scope for this command; mutation refused",
                    );
                }
                Err(e) => return kernel_fail(daemon, &req.id, &e),
            };
            nexus_tools::prepare_write(request, &binding, &scope)
        } else {
            nexus_tools::prepare(request, &binding)
        };
        let prepared = match prepared {
            Ok(p) => match &ai_origin {
                Some(o) => p.with_ai_origin(o.clone()),
                None => p,
            },
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        let is_write = mutating;
        let is_proc = is_process;
        // A4.2: single-use human approval bound to this exact operation.
        // Consumed immediately before the grant is minted; any mismatch,
        // expiry, revocation or reuse refuses with no execution.
        if daemon.require_human_approval && (is_write || is_proc) {
            let r = prepared.request();
            if let Err(e) = kernel.consume_approval(
                &r.command_id,
                &r.task_instance_id,
                &r.attempt_id,
                r.lease_epoch,
                &r.store_incarnation,
                &r.tool_id,
                prepared.args_digest(),
                prepared.budget_digest(),
                prepared.workspace_root_digest(),
                &r.request_id,
                daemon.approver_independent,
            ) {
                return kernel_fail(daemon, &req.id, &e);
            }
        }
        let call = match nexus_tools::authorize(&mut kernel, prepared) {
            Ok(c) => c,
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        let started = match nexus_tools::begin(&mut kernel, &call, &cancel) {
            Ok(s) => s,
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        (call, started, is_write, is_proc, proc_scope_wall)
    };
    let (call, started, is_write, is_proc, proc_wall) = (call.0, call.1, call.2, call.3, call.4);

    if is_proc {
        let mut hooks = DaemonProcessHooks {
            daemon,
            verified: started.verified(),
            last_seq: 0,
        };
        let penv = project_env_for(daemon, &call.prepared().request().task_instance_id);
        return match nexus_tools::run_process_call(
            &call,
            &cancel,
            &daemon.command_policy,
            &daemon.run_root,
            proc_wall,
            penv.as_ref(),
            &mut hooks,
        ) {
            Ok(result) => ok(
                &req.id,
                serde_json::json!({
                    "result": result,
                    "execution": {
                        "requestId": request_id,
                        "executionId": call.grant().execution_id,
                        "journalSeq": hooks.last_seq,
                        "aiInitiated": false,
                        "scope": "process",
                        "approverIndependent": daemon.approver_independent,
                        "testOnlyApproval": !daemon.approver_independent && daemon.autonomous.is_none(),
                        "automatedPolicy": daemon.autonomous.as_ref().map(|_| AUTONOMOUS_POLICY_ID),
                    },
                }),
            ),
            Err(e) => {
                let mut r = tool_fail(daemon, &req.id, &e);
                if let Some(o) = r.as_object_mut() {
                    o.insert("outcome".to_owned(), serde_json::json!("uncertain"));
                }
                r
            }
        };
    }
    if is_write {
        // Write lifecycle: journal + fence hooks lock the Kernel only
        // briefly; the filesystem work holds no lock.
        let mut hooks = DaemonWriteHooks {
            daemon,
            verified: started.verified(),
            last_seq: 0,
            direct: direct_store(daemon, &call.prepared().request().task_instance_id).map(|d| d.0),
        };
        return match nexus_tools::run_write_call(&call, &cancel, &mut hooks) {
            Ok(result) => ok(
                &req.id,
                serde_json::json!({
                    "result": result,
                    "execution": {
                        "requestId": request_id,
                        "executionId": call.grant().execution_id,
                        "journalSeq": hooks.last_seq,
                        "aiInitiated": false,
                        "scope": "write",
                        "approverIndependent": daemon.approver_independent,
                        "testOnlyApproval": !daemon.approver_independent && daemon.autonomous.is_none(),
                        "automatedPolicy": daemon.autonomous.as_ref().map(|_| AUTONOMOUS_POLICY_ID),
                    },
                }),
            ),
            Err(e) => {
                // A journal failure after the filesystem may have changed:
                // the outcome is UNCERTAIN; restart reconciliation will
                // observe and record it. Never claim success.
                let mut r = tool_fail(daemon, &req.id, &e);
                if let Some(o) = r.as_object_mut() {
                    o.insert("outcome".to_owned(), serde_json::json!("uncertain"));
                }
                r
            }
        };
    }

    // Step 2 (NO Kernel lock held across the scan): run with the
    // authoritative fence probe, which takes the lock only briefly.
    let result = {
        let _ = &started;
        let mut probe = || -> Result<(), nexus_tools::ToolError> {
            let kernel = daemon.kernel.lock().map_err(|_| {
                nexus_tools::ToolError::new(
                    nexus_tools::ToolErrorCode::Revoked,
                    "kernel unavailable; failing closed",
                )
            })?;
            kernel.check_tool_fence_for(call.grant()).map_err(|e| {
                nexus_tools::ToolError::new(
                    nexus_tools::ToolErrorCode::Revoked,
                    format!("authority revoked mid-execution ({})", e.code.as_str()),
                )
            })
        };
        nexus_tools::run_started(&call, &cancel, &mut probe)
    };

    // Step 3: journal the (redacted) outcome.
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    match nexus_tools::finish(&mut kernel, &call, &started, result) {
        Ok(o) => ok(
            &req.id,
            serde_json::json!({
                "result": o.result,
                "execution": {
                    "requestId": request_id,
                    "executionId": o.journal.execution_id,
                    "journalSeq": o.journal.seq,
                    "aiInitiated": ai_origin.is_some(),
                },
            }),
        ),
        Err(e) => tool_fail(daemon, &req.id, &e),
    }
}

fn do_tool_events(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> serde_json::Value {
    if let Err(r) = only_keys(
        &req.params,
        &["taskInstanceId", "attemptId", "afterSeq", "limit"],
        &req.id,
    ) {
        return r;
    }
    // Visibility gate: when a UID allowlist is configured the connecting
    // UID must be on it (same OS-identity gate as privileged commands).
    if let Some(allowed) = &daemon.allowed_uids {
        match peer {
            Some((uid, _, _)) if allowed.contains(&uid) => {}
            _ => {
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return fail(
                    &req.id,
                    codes::PEER_UNAUTHORIZED,
                    "connecting process UID is not authorized to read tool events",
                );
            }
        }
    }
    let task = match get_string(&req.params, "taskInstanceId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let attempt = match get_string(&req.params, "attemptId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let after = match req.params.get("afterSeq") {
        None => 0i64,
        Some(v) => match v.as_i64() {
            Some(n) if n >= 0 => n,
            _ => {
                return fail(
                    &req.id,
                    codes::BAD_REQUEST,
                    "bad-request: 'afterSeq' must be a non-negative integer",
                )
            }
        },
    };
    let limit = match req.params.get("limit") {
        None => TOOL_EVENTS_DEFAULT_PAGE,
        Some(v) => match v.as_u64() {
            Some(n) if n >= 1 => (n as usize).min(TOOL_EVENTS_MAX_PAGE),
            _ => {
                return fail(
                    &req.id,
                    codes::BAD_REQUEST,
                    "bad-request: 'limit' must be a positive integer",
                )
            }
        },
    };
    let kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let mut rows = match kernel.tool_records_page(&task, &attempt, after, limit + 1) {
        Ok(r) => r,
        Err(e) => return kernel_fail(daemon, &req.id, &e),
    };
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = rows.last().map(|r| r.seq).unwrap_or(after);
    // One shared allow-listed projection (no raw payload passthrough).
    let records: Vec<serde_json::Value> = rows
        .iter()
        .map(|e| serde_json::to_value(nexus_tools::record_from_entry(e)).unwrap_or_default())
        .collect();
    ok(
        &req.id,
        serde_json::json!({
            "records": records,
            "nextCursor": next_cursor,
            "hasMore": has_more,
            "pageSize": limit,
        }),
    )
}

fn do_receipt(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let command_id = match get_string(&req.params, "commandId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    match kernel.read_receipt(&command_id) {
        Ok(found) => ok(&req.id, serde_json::json!({ "receipt": found })),
        Err(e) => kernel_fail(daemon, &req.id, &e),
    }
}

fn do_journal(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let task = match get_string(&req.params, "taskInstanceId") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let backend = match get_string(&req.params, "backend") {
        Ok(v) => v,
        Err(r) => return with_id(r, &req.id),
    };
    let kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    let events = match kernel.list_events(&task, &backend) {
        Ok(v) => v,
        Err(e) => return kernel_fail(daemon, &req.id, &e),
    };
    let truncated = events.len() > MAX_JOURNAL_EVENTS;
    let mut receipts = Vec::new();
    for event in events.iter().take(MAX_JOURNAL_EVENTS) {
        if let Some(command_id) = event.command_id.as_ref() {
            match kernel.read_receipt(command_id) {
                Ok(Some(r)) => receipts.push(r),
                Ok(None) => {}
                Err(e) => return kernel_fail(daemon, &req.id, &e),
            }
        }
    }
    ok(
        &req.id,
        serde_json::json!({
            "receipts": receipts,
            "events": events.into_iter().take(MAX_JOURNAL_EVENTS).collect::<Vec<_>>(),
            "truncated": truncated,
        }),
    )
}

fn do_health(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let (state, incarnation) = match daemon.kernel.lock() {
        Ok(k) => (lifecycle_of(daemon), k.incarnation().to_owned()),
        Err(_) => (lifecycle_of(daemon), String::new()),
    };
    ok(
        &req.id,
        serde_json::json!({
            "state": state,
            "incarnation": incarnation,
            "ipcProtocol": crate::protocol::IPC_PROTOCOL_VERSION,
            "dispatchEnabled": nexus_kernel::Kernel::dispatch_enabled(),
        }),
    )
}

fn lifecycle_of(daemon: &Daemon) -> &'static str {
    match daemon.lifecycle.lock() {
        Ok(g) => g.as_str(),
        Err(_) => "starting",
    }
}

fn do_status(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    let incarnation = kernel.incarnation().to_owned();
    let accepted = match kernel.count_receipts() {
        Ok(v) => v,
        Err(e) => return kernel_fail(daemon, &req.id, &e),
    };
    let commands = match kernel.count_commands() {
        Ok(v) => v,
        Err(e) => return kernel_fail(daemon, &req.id, &e),
    };
    let events = match kernel.list_all_events() {
        Ok(v) => v,
        Err(e) => return kernel_fail(daemon, &req.id, &e),
    };
    let journal_head = events
        .last()
        .cloned()
        .unwrap_or(nexus_contracts::KernelEventV1 {
            schema_version: nexus_contracts::CONTRACT_SCHEMA_VERSION,
            seq: 0,
            generation_key: String::new(),
            kind: nexus_contracts::KernelEventKind::GenerationAcquired,
            command_id: None,
            payload: serde_json::Value::Null,
            recorded_at_utc: String::new(),
        });
    let model_pilot_enabled = kernel.model_only_pilot_enabled();
    let repo_inspect_enabled = kernel.repo_inspect_pilot_enabled();
    drop(kernel);
    let latch = daemon
        .reconcile_latch
        .lock()
        .map(|g| g.clone())
        .unwrap_or(None);
    let witness_present = daemon
        .witness_path
        .as_ref()
        .map(|p| p.exists())
        .unwrap_or(false);
    ok(
        &req.id,
        serde_json::json!({
            "state": lifecycle_of(daemon),
            "incarnation": incarnation,
            "ipcProtocol": crate::protocol::IPC_PROTOCOL_VERSION,
            "trustMode": daemon.trust_mode.as_str(),
            "peerUidEnforced": daemon.allowed_uids.is_some(),
            "allowedUids": daemon.allowed_uids.clone().unwrap_or_default(),
            "socketShared": daemon.socket_group.is_some(), "socketGroup": daemon.socket_group, "capHandoff": daemon.cap_handoff.is_some(), "shadowMode": "shadow-only",
            "dispatchEnabled": nexus_kernel::Kernel::dispatch_enabled(),
            "modelPilotEnabled": model_pilot_enabled,
            "repoInspectEnabled": repo_inspect_enabled,
            "repoCodeEnabled": daemon.repo_code_enabled,
            "requireHumanApproval": daemon.require_human_approval && daemon.autonomous.is_none(),
            "approvalGated": daemon.require_human_approval,
            "automatedPolicy": daemon.autonomous.as_ref().map(|_| AUTONOMOUS_POLICY_ID),
            "writesEnabled": daemon.writes_enabled,
            "processEnabled": daemon.process_enabled,
            "sandbox": daemon.sandbox_caps.as_ref().map(|c| serde_json::json!({
                "available": c.available, "backend": c.backend,
                "cgroupMemoryController": c.cgroup_memory_controller,
                "kernelEnforcedLimits": c.kernel_enforced_limits,
                "resourceEnforcement": if c.kernel_enforced_limits { "kernel-cgroup" } else { "rlimit-polling" },
            })),
            "acceptedCommands": accepted,
            "totalCommands": commands,
            "eventCount": events.len() as u64,
            "journalHead": journal_head,
            "witness": { "configured": daemon.witness_configured, "present": witness_present },
            "reconciliationRequired": latch.is_some(),
            "reconciliationDetail": latch,
            "activeClients": daemon.counters.active_clients.load(Ordering::Relaxed) as u64,
            "requests": daemon.counters.requests.load(Ordering::Relaxed),
            "refusals": daemon.counters.refused.load(Ordering::Relaxed),
            "errors": daemon.counters.errors.load(Ordering::Relaxed),
            "startedAtUtc": daemon.start_utc,
        }),
    )
}

fn with_id(mut v: serde_json::Value, id: &str) -> serde_json::Value {
    if let Some(obj) = v.as_object_mut() {
        obj.insert("id".to_owned(), serde_json::Value::String(id.to_owned()));
        obj.insert(
            "protocol".to_owned(),
            serde_json::Value::from(crate::protocol::IPC_PROTOCOL_VERSION),
        );
    }
    v
}

/// Dispatch one validated request. Never panics on adversarial input: every
/// refusal is a versioned value. `peer` is the connection's SO_PEERCRED
/// (None when unavailable, e.g. in-process test frames without a socket).
pub fn dispatch(
    daemon: &Daemon,
    req: &IpcRequest,
    peer: Option<(u32, u32, i32)>,
) -> serde_json::Value {
    daemon.counters.requests.fetch_add(1, Ordering::Relaxed);
    if req.cmd == "write-scope-approve" || req.cmd == "process-scope-approve" {
        if daemon.require_human_approval {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            log_line("refuse", &req.id, "approval-required", &req.cmd);
            return fail(
                &req.id,
                "approval-required",
                "human approval mode: scopes are created only by a reviewed, confirmed approval decision",
            );
        }
        return if req.cmd == "write-scope-approve" {
            do_write_scope_approve(daemon, req, peer)
        } else {
            do_process_scope_approve(daemon, req, peer)
        };
    }
    if req.cmd == "approval-get" {
        return do_approval_get(daemon, req, peer);
    }
    if req.cmd == "approval-decide" {
        return do_approval_decide(daemon, req, peer);
    }
    if is_privileged(&req.cmd) {
        if let Some(refusal) = authorize(daemon, req, peer) {
            log_line(
                "refuse",
                &req.id,
                refusal.get("code").and_then(|v| v.as_str()).unwrap_or("?"),
                &req.cmd,
            );
            return refusal;
        }
        let response = match req.cmd.as_str() {
            "acquire" => do_acquire(daemon, req),
            "seal-extension" => do_seal_extension(daemon, req),
            "seal-task-binding" => do_seal_task_binding(daemon, req),
            "intent-publish" => do_intent_publish(daemon, req),
            "intent-fence" => do_intent_fence(daemon, req),
            "dispatch-authorize" => do_dispatch_authorize(daemon, req),
            "model-redeem" => do_model_redeem(daemon, req),
            "workspace-bind" => do_workspace_bind(daemon, req),
            "tool-execute" => do_tool_execute(daemon, req),
            "tool-revoke" => do_tool_revoke(daemon, req),
            "approval-request" => do_approval_request(daemon, req),
            "approval-revoke" => do_approval_revoke(daemon, req),
            "worktree-create" => do_worktree_create(daemon, req),
            "direct-open" => do_direct_open(daemon, req),
            "worktree-diff" => do_worktree_diff(daemon, req),
            "worktree-seed" => do_worktree_seed(daemon, req),
            "worktree-remove" => do_worktree_remove(daemon, req),
            "worktree-list" => do_worktree_list(daemon, req),
            "worktree-stat" => do_worktree_stat(daemon, req),
            "seal" => do_seal(daemon, req),
            "accept" => do_accept(daemon, req),
            _ => unreachable!("privileged set is fixed"),
        };
        log_line(
            "privileged",
            &req.id,
            response
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("ok"),
            &req.cmd,
        );
        return response;
    }
    if !is_read_only(&req.cmd) {
        daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
        log_line("refuse", &req.id, codes::UNKNOWN_COMMAND, &req.cmd);
        return fail(
            &req.id,
            codes::UNKNOWN_COMMAND,
            format!(
                "bad-request: unknown daemon command '{}'",
                req.cmd.chars().take(64).collect::<String>()
            ),
        );
    }
    match req.cmd.as_str() {
        "health" => do_health(daemon, req),
        "status" => do_status(daemon, req),
        "receipt" => do_receipt(daemon, req),
        "journal" => do_journal(daemon, req),
        "readiness" => do_readiness(daemon, req),
        "tool-events" => do_tool_events(daemon, req, peer),
        "approval-list" => do_approval_list(daemon, req, peer),
        "integrity-status" => do_integrity_status(daemon, req, peer),
        "digest" => ok(&req.id, digest_params(&req.params)),
        _ => unreachable!("read-only set is fixed"),
    }
}

/// A2.0 Gate 5: strictly read-only readiness assessment. No mutation, no
/// token, no authorization -- the verdict is always NOT_READY while
/// dispatch stays disabled.
fn do_readiness(daemon: &Daemon, req: &IpcRequest) -> serde_json::Value {
    let command_id = req.params.get("commandId").and_then(|v| v.as_str());
    let kernel = match daemon.kernel.lock() {
        Ok(g) => g,
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                codes::STORE_UNHEALTHY,
                "kernel mutex is poisoned; failing closed",
            );
        }
    };
    let report = kernel.dispatch_readiness(command_id);
    match serde_json::to_value(&report) {
        Ok(v) => ok(
            &req.id,
            serde_json::json!({ "readiness": v, "transport": transport_report(daemon) }),
        ),
        Err(_) => {
            daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
            fail(&req.id, codes::STORE_UNHEALTHY, "readiness encoding failed")
        }
    }
}

/// A2.1 transport posture report (observational, part of `readiness`).
/// `peerUidEnforced` is true only when an explicit UID allowlist gates
/// privileged commands. Even then the verdict stays NOT_READY: UID gating
/// authenticates the connecting PROCESS, never the calling JS module, and
/// dispatch remains disabled regardless.
fn transport_report(daemon: &Daemon) -> serde_json::Value {
    serde_json::json!({
        "peerUidEnforced": daemon.allowed_uids.is_some(),
        "allowedUids": daemon.allowed_uids.clone().unwrap_or_default(),
        "socketShared": daemon.socket_group.is_some(), "socketGroup": daemon.socket_group, "capHandoff": daemon.cap_handoff.is_some(), "socketPolicy": if daemon.socket_group.is_some() { "dataroot-0700 + socketdir-0750 + socket-0660" } else { "dataroot-0700 only (no production sharing)" }, "capAuth": if daemon.auth.is_some() { "ephemeral-hmac-capability" } else { "none" },
        "limitation": "SO_PEERCRED authenticates process credentials, never JS-module origin; same-UID module confusion is out of scope of this gate",
    })
}

/// A2.1 fail-closed directory check: a protected directory (DataRoot,
/// socket parent) must exist, be owned by our own euid, and carry no
/// group/other permission bits (mode 0700 semantics). Anything else fails
/// closed at startup so a permissive directory can never silently host
/// kernel persistence or the IPC socket. Group/other access would let a
/// genuinely distinct OS identity read or replace store files; the check
/// enforces the exact bits production relies on.
pub fn verify_protected_dir(path: &Path, role: &str) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path).map_err(|e| format!("{role} directory unavailable: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("{role} path is not a directory"));
    }
    let euid = unsafe { libc::geteuid() };
    if meta.uid() != euid {
        return Err(format!(
            "{role} directory is not owned by the daemon uid (failing closed)"
        ));
    }
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(format!(
            "{role} directory is group/other-accessible (mode {:o}); refusing to host kernel state (failing closed)",
            meta.permissions().mode() & 0o777
        ));
    }
    Ok(())
}

/// A2.0 Gate 2: observe (never authenticate with) OS peer credentials.
/// SO_PEERCRED proves which UID/PID connected -- never which JS module
/// produced a request -- so this value is logged for forensics and is
/// explicitly NOT an authentication decision. Same-UID hostile peers share
/// the daemon's UID and are indistinguishable here by construction.
#[cfg(target_os = "linux")]
fn peer_credentials(stream: &UnixStream) -> Option<(u32, u32, i32)> {
    use std::os::unix::io::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let ret = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if ret == 0 {
        Some((cred.uid, cred.gid, cred.pid))
    } else {
        None
    }
}

#[cfg(not(target_os = "linux"))]
fn peer_credentials(_stream: &UnixStream) -> Option<(u32, u32, i32)> {
    None
}

fn digest_params(params: &serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    match params.get("value") {
        Some(v) => {
            let d = bridge::digest_value(v);
            let mut map = serde_json::Map::new();
            if let Some(canonical) = d.get("canonical") {
                map.insert("canonical".to_owned(), canonical.clone());
            }
            if let Some(sha) = d.get("sha256") {
                map.insert("sha256".to_owned(), sha.clone());
            }
            serde_json::Value::Object(map)
        }
        None => serde_json::json!({}),
    }
}

/// Serve one validated-or-refused frame (used by tests and connections).
/// In-process callers have no socket peer, so no UID gate can apply: when
/// an allowlist is configured, privileged in-process frames are refused
/// exactly like connections without credentials (never silently admitted).
pub fn serve_frame(daemon: &Daemon, frame: &str) -> serde_json::Value {
    serve_frame_with_peer(daemon, frame, None)
}

/// Serve one frame with explicit peer credentials (live connections).
pub fn serve_frame_with_peer(
    daemon: &Daemon,
    frame: &str,
    peer: Option<(u32, u32, i32)>,
) -> serde_json::Value {
    match parse_frame(frame) {
        Ok(req) => dispatch(daemon, &req, peer),
        Err((id, code, message)) => {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            log_line("refuse", &id, code, "parse");
            fail(&id, code, message)
        }
    }
}

fn write_response(stream: &mut UnixStream, response: &serde_json::Value) -> Result<(), String> {
    let mut text =
        serde_json::to_string(response).map_err(|e| format!("response encoding failed: {e}"))?;
    if text.len() > MAX_RESPONSE_BYTES {
        return Err("response exceeds cap; failing closed".to_owned());
    }
    text.push('\n');
    stream
        .write_all(text.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    stream.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// H-05: atomically reserve one client slot. The accept loop calls this
/// BEFORE spawning a worker, so the check and the reservation are a single
/// atomic step and a burst of simultaneous connections can never admit more
/// than MAX_CLIENTS no matter how the worker threads are scheduled.
fn try_reserve_client(daemon: &Daemon) -> bool {
    daemon
        .counters
        .active_clients
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
            if current < MAX_CLIENTS {
                Some(current + 1)
            } else {
                None
            }
        })
        .is_ok()
}

fn release_client(daemon: &Daemon) {
    daemon
        .counters
        .active_clients
        .fetch_sub(1, Ordering::SeqCst);
}

/// Gracefully refuse an over-cap connection with a structured `server-busy`
/// refusal instead of a bare close. A bare close with unread request bytes
/// still queued turns into RST and the client loses the refusal; so the
/// pending frame bytes are drained first (bounded: at most 4 x 8 KiB reads
/// with a short deadline — legitimate shadow frames are far smaller, and a
/// slow-drip peer only costs the accept loop ~1 s, never a worker thread).
/// Every exit path below ends in close; errors are ignored because the
/// client is being refused either way.
fn refuse_over_cap(stream: UnixStream) {
    let mut stream = stream;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    let mut chunk = [0u8; 8192];
    for _ in 0..4 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if chunk[..n].contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = write_response(
        &mut stream,
        &fail(
            "",
            codes::SERVER_BUSY,
            "connection over client cap (server-busy)",
        ),
    );
}

/// RAII slot release: the counter is decremented on EVERY worker exit path,
/// including a panicking worker (stack unwinding runs `Drop`). The slot is
/// reserved by the accept loop before this worker exists; this guard only
/// ever releases it.
struct ClientSlot<'a> {
    daemon: &'a Daemon,
}

impl Drop for ClientSlot<'_> {
    fn drop(&mut self) {
        release_client(self.daemon);
    }
}

fn serve_connection(stream: UnixStream, daemon: SharedDaemon) {
    let _slot = ClientSlot { daemon: &daemon };
    // Peer UID/GID/PID authenticate the connecting process, never the
    // calling JS module. Observed always; enforced for privileged commands
    // only when --allowed-uids is configured (see authorize).
    let peer = peer_credentials(&stream);
    match peer {
        Some((uid, gid, pid)) => log_line(
            "conn-peer",
            "",
            "observed",
            &format!(
                "peer uid={uid} gid={gid} pid={pid} (process identity, not module authentication)"
            ),
        ),
        None => log_line(
            "conn-peer",
            "",
            "unavailable",
            "peer credentials unavailable; privileged commands fail closed",
        ),
    }
    let result = serve_connection_inner(&stream, &daemon, peer);
    if let Err(detail) = result {
        daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
        log_line("conn-close", "", "transport-error", &detail);
    }
}

/// H-04: byte-oriented, newline-delimited framing. Raw bytes accumulate
/// in `pending` until a `\n` completes a frame; only complete frames are
/// UTF-8 validated (strictly — never lossy), so a multi-byte character
/// split across reads is preserved exactly and several frames arriving in
/// one read are each served in order. The 1 MiB cap is enforced on bytes:
/// a frame body beyond the cap, or a newline-less backlog beyond
/// cap+1, is refused as `too-large` and the connection is closed.
fn serve_connection_inner(
    stream: &UnixStream,
    daemon: &SharedDaemon,
    peer: Option<(u32, u32, i32)>,
) -> Result<(), String> {
    let mut stream = stream
        .try_clone()
        .map_err(|e| format!("clone failed: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(REQUEST_TIMEOUT_MS)))
        .map_err(|e| format!("timeout unsettable: {e}"))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(REQUEST_TIMEOUT_MS)))
        .map_err(|e| format!("timeout unsettable: {e}"))?;
    let mut pending: Vec<u8> = Vec::new();
    loop {
        // Serve every complete line already buffered before reading more,
        // so coalesced requests are each answered in arrival order.
        if let Some(nl) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=nl).collect();
            let body = &line[..line.len() - 1];
            if body.len() > MAX_FRAME_BYTES {
                let _ = write_response(
                    &mut stream,
                    &fail(
                        "",
                        codes::TOO_LARGE,
                        format!("request frame exceeds {MAX_FRAME_BYTES} bytes (too-large)"),
                    ),
                );
                daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                return Err("oversized frame".to_owned());
            }
            let frame = match std::str::from_utf8(body) {
                Ok(text) => text.strip_suffix('\r').unwrap_or(text),
                Err(_) => {
                    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                    let _ = write_response(
                        &mut stream,
                        &fail(
                            "",
                            codes::BAD_REQUEST,
                            "request frame is not valid UTF-8 (bad-request)",
                        ),
                    );
                    continue;
                }
            };
            // Catch panics per request so adversarial input can never kill
            // the connection handler, let alone the daemon.
            let response = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                serve_frame_with_peer(daemon, frame, peer)
            })) {
                Ok(v) => v,
                Err(_) => {
                    daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
                    fail(
                        "",
                        codes::STORE_UNHEALTHY,
                        "internal failure while serving request; failing closed",
                    )
                }
            };
            if write_response(&mut stream, &response).is_err() {
                return Err("response write failed".to_owned());
            }
            continue;
        }
        // No complete line yet: refuse before buffering without bound.
        if pending.len() > MAX_FRAME_BYTES + 1 {
            let _ = write_response(
                &mut stream,
                &fail(
                    "",
                    codes::TOO_LARGE,
                    format!("request frame exceeds {MAX_FRAME_BYTES} bytes (too-large)"),
                ),
            );
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return Err("oversized frame".to_owned());
        }
        let mut chunk = [0u8; 8192];
        let n = stream.read(&mut chunk).map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut
            {
                "request timeout".to_owned()
            } else {
                format!("read failed: {e}")
            }
        })?;
        if n == 0 {
            if pending.is_empty() {
                return Ok(());
            }
            return Err("connection closed mid-frame".to_owned());
        }
        pending.extend_from_slice(&chunk[..n]);
    }
}

/// Accept loop. Returns when `shutdown` is set. `listener` must already be
/// bound and non-blocking.
pub fn serve(listener: UnixListener, daemon: SharedDaemon, shutdown: Arc<AtomicBool>) {
    if let Ok(mut state) = daemon.lifecycle.lock() {
        *state = Lifecycle::Ready;
    }
    log_line("ready", "", "ok", daemon.trust_mode.as_str());
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if !try_reserve_client(&daemon) {
                    daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
                    log_line(
                        "refuse",
                        "",
                        codes::SERVER_BUSY,
                        "connection over client cap",
                    );
                    refuse_over_cap(stream);
                    continue;
                }
                let worker = Arc::clone(&daemon);
                if std::thread::Builder::new()
                    .name("nexusd-conn".to_owned())
                    .spawn(move || serve_connection(stream, worker))
                    .is_err()
                {
                    // The reserved slot is released; no worker exists to do it.
                    release_client(&daemon);
                    daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
                    log_line("conn-close", "", "transport-error", "worker spawn failed");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                daemon.counters.errors.fetch_add(1, Ordering::Relaxed);
                log_line(
                    "conn-close",
                    "",
                    "transport-error",
                    &format!("accept failed: {e}"),
                );
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
    if let Ok(mut state) = daemon.lifecycle.lock() {
        *state = Lifecycle::Stopping;
    }
    // Bounded drain: in-flight requests finish or the deadline passes.
    for _ in 0..200 {
        if daemon.counters.active_clients.load(Ordering::Relaxed) == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod peer_tests {
    use super::peer_credentials;
    use std::os::unix::net::UnixStream;

    /// A2.0 Gate 2: SO_PEERCRED reports process credentials (uid/gid/pid)
    /// and nothing about which JS module produced a request. The observed
    /// peer uid MUST equal our own uid here -- the exact property that
    /// makes same-UID hostile peers indistinguishable, hence unpreventable
    /// by peer credentials. This test pins the limitation: if it ever
    /// fails, the trust model changed and the design docs must be rewritten.
    #[test]
    fn peer_credentials_report_uid_not_module_identity() {
        let (a, _b) = UnixStream::pair().expect("socketpair");
        let (uid, _gid, _pid) = peer_credentials(&a).expect("SO_PEERCRED available on Linux");
        let own = unsafe { libc::getuid() };
        assert_eq!(
            uid, own,
            "peer uid equals our own uid: same-UID peers are indistinguishable"
        );
    }
}

#[cfg(test)]
mod isolation_tests {
    //! A2.1 transport-gate unit tests: UID allowlist enforcement, refusal
    ///without fallback, and fail-closed directory checks. Genuinely distinct
    ///OS identities are unavailable to this test runner (unprivileged), so
    ///cross-UID proof lives in the integration suite via a non-matching
    ///allowlist against real SO_PEERCRED.
    use super::*;
    use crate::auth::IssuerAuth;
    use crate::protocol::AuthFields;

    fn test_daemon(allowed_uids: Option<Vec<u32>>, trust: TrustMode) -> Daemon {
        let dir = tempfile::tempdir().expect("tempdir");
        // Leak the tempdir: the daemon holds no path that needs it, and the
        // kernel files must outlive this frame for the whole test.
        let dir = Box::leak(Box::new(dir));
        let db = dir.path().join("k.db");
        let kernel = nexus_kernel::Kernel::open(&db, None).expect("kernel opens on temp root");
        let auth = if trust == TrustMode::ShadowTest {
            Some(Arc::new(IssuerAuth::generate().expect("entropy")))
        } else {
            None
        };
        Daemon {
            kernel: Mutex::new(kernel),
            trust_mode: trust,
            auth,
            allowed_uids,
            socket_group: None,
            cap_handoff: None,
            lifecycle: Mutex::new(Lifecycle::Starting),
            counters: Counters::default(),
            reconcile_latch: Mutex::new(None),
            workspace_bases: Vec::new(),
            worktree_root: None,
            project_envs: None,
            project_registry: None,
            autonomous: None,
            autonomous_counters: Mutex::new(Default::default()),
            repo_code_enabled: false,
            writes_enabled: false,
            process_enabled: false,
            isolated_exec_scope: nexus_tools::exec_contract::FsScope::Scratch,
            command_policy: nexus_tools::process::CommandPolicy::standard(
                nexus_tools::process::Toolchain::discover(),
            ),
            run_root: std::path::PathBuf::from("exec"),
            sandbox_caps: None,
            approver_auth: None,
            approver_uids: None,
            approver_independent: false,
            require_human_approval: false,
            security_profile: None,
            tool_inflight: AtomicUsize::new(0),
            witness_configured: false,
            witness_path: None,
            start_utc: String::new(),
        }
    }

    fn own_uid() -> u32 {
        unsafe { libc::geteuid() }
    }

    // ---- A6.1.4 automated workspace policy: the rules, directly -------------

    fn sub(
        task: &str,
        root_digest: &str,
        tool: &str,
        scope: &str,
        paths: &[&str],
        op: serde_json::Value,
    ) -> nexus_kernel::ApprovalSubmission {
        nexus_kernel::ApprovalSubmission {
            command_id: "cmd".into(),
            task_instance_id: task.into(),
            attempt_id: "a".into(),
            lease_epoch: 1,
            store_incarnation: "i".into(),
            tool_id: tool.into(),
            tool_version: 1,
            scope: scope.into(),
            args_digest: "d".into(),
            budget_digest: "b".into(),
            workspace_root_digest: root_digest.into(),
            paths: paths.iter().map(|p| p.to_string()).collect(),
            operation: op,
            preview: serde_json::json!({}),
            limits: serde_json::json!({}),
            ttl_ms: 1000,
        }
    }

    fn policy_rig(write_allow: &[&str]) -> (Daemon, tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let task = "task-policy0000000000000001".to_owned();
        std::fs::create_dir_all(root.join(&task)).unwrap();
        std::fs::create_dir_all(root.join(".meta")).unwrap();
        std::fs::write(
            wt_meta_path(&root, &task),
            serde_json::json!({"taskInstanceId": task, "sourceCommit": "0".repeat(40), "projectId": "p", "writeAllow": write_allow}).to_string(),
        )
        .unwrap();
        let mut d = test_daemon(Some(vec![own_uid()]), TrustMode::ShadowTest);
        d.worktree_root = Some(root.clone());
        d.autonomous = Some(AutonomousConfig::default());
        let digest = sha256_hex_str(&root.join(&task).to_string_lossy());
        (d, dir, task, digest)
    }

    fn edit(task: &str, digest: &str, path: &str, bytes: u64) -> nexus_kernel::ApprovalSubmission {
        sub(
            task,
            digest,
            "fs.edit",
            "write",
            &[path],
            serde_json::json!({"postImageBytes": bytes}),
        )
    }

    fn proc_op(network: &str, shell: bool, write_back: &str) -> serde_json::Value {
        serde_json::json!({"program": "cargo", "argvDigest": "x", "sandbox": {"network": network, "shell": shell, "writeBack": write_back}})
    }

    fn set_scope(root: &std::path::Path, task: &str, extra: serde_json::Value) {
        let mut m: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(wt_meta_path(root, task)).unwrap())
                .unwrap();
        for (k, v) in extra.as_object().unwrap() {
            m[k] = v.clone();
        }
        std::fs::write(wt_meta_path(root, task), m.to_string()).unwrap();
    }

    fn proc_op_scope(scope: Option<&str>, write_back: &str) -> serde_json::Value {
        let mut o = proc_op("none", false, write_back);
        if let Some(s) = scope {
            o["execFsScope"] = s.into();
        }
        o
    }

    #[test]
    fn the_filesystem_scope_comes_only_from_the_daemons_record_and_must_match_the_operation() {
        use nexus_tools::exec_contract::FsScope;
        let (d, _keep, task, digest) = policy_rig(&["src/"]);
        let root = d.worktree_root.clone().unwrap();
        let cfg = d.autonomous.clone().unwrap();
        let run = |scope: Option<&str>, wb: &str| {
            evaluate_autonomous_policy(
                &d,
                &cfg,
                &sub(
                    &task,
                    &digest,
                    "proc.run",
                    "process",
                    &[],
                    proc_op_scope(scope, wb),
                ),
            )
        };
        // a record without the field is scratch (every pre-existing copy)
        assert_eq!(task_fs_scope(&d, &task), FsScope::Scratch);
        assert!(run(None, "none").is_ok());
        // a scratch task refuses an operation that claims a workspace scope, whatever its write-back text
        assert!(run(Some("workspace"), "in-place-task-copy").is_err());
        assert!(run(Some("workspace"), "none").is_err());
        // a workspace task
        set_scope(
            &root,
            &task,
            serde_json::json!({"execFsScope": "workspace"}),
        );
        assert_eq!(task_fs_scope(&d, &task), FsScope::Workspace);
        let ok = run(Some("workspace"), "in-place-task-copy").expect("covered");
        assert_eq!(ok["fsScope"], "workspace");
        // it never accepts the scratch description (a lie in either direction), nor an omitted scope
        assert!(run(None, "none").is_err());
        assert!(run(Some("scratch"), "none").is_err());
        assert!(run(Some("workspace"), "none").is_err());
        assert!(run(Some("full"), "in-place-task-copy").is_err());
        // unknown / hostile names in the record are scratch, never workspace
        for v in ["full", "WORKSPACE", "host", ""] {
            set_scope(&root, &task, serde_json::json!({"execFsScope": v}));
            assert_eq!(task_fs_scope(&d, &task), FsScope::Scratch, "{v}");
        }
        // a direct task is never in place in this milestone, even if its record says so
        set_scope(
            &root,
            &task,
            serde_json::json!({"execFsScope": "workspace", "kind": "direct"}),
        );
        assert_eq!(task_fs_scope(&d, &task), FsScope::Scratch);
        // an invalid task id or a missing record is scratch
        assert_eq!(task_fs_scope(&d, "../etc"), FsScope::Scratch);
        assert_eq!(
            task_fs_scope(&d, "task-nonexistent0000000001"),
            FsScope::Scratch
        );
    }

    #[test]
    fn the_policy_digest_changes_only_when_in_place_copies_are_enabled() {
        let c = AutonomousConfig::default();
        let scratch_only = autonomous_policy_digest(&c, false);
        let with_ws = autonomous_policy_digest(&c, true);
        assert_ne!(scratch_only, with_ws);
        // the scratch-only digest is the historical one (no extra key)
        let historical = sha256_hex_str(&nexus_contracts::canonical_json(&serde_json::json!({
            "id": AUTONOMOUS_POLICY_ID,
            "maxEditsPerTask": c.max_edits_per_task,
            "maxCommandsPerTask": c.max_commands_per_task,
            "maxWriteBytes": c.max_write_bytes,
            "protectedNames": nexus_tools::protect::PROTECTED_NAMES,
            "tools": ["fs.write", "fs.edit", "proc.run"],
        })));
        assert_eq!(scratch_only, historical);
    }

    #[test]
    fn the_automated_policy_allows_only_the_covered_operations_in_the_tasks_own_copy() {
        let (d, _keep, task, digest) = policy_rig(&["src/"]);
        let cfg = d.autonomous.clone().unwrap();
        let ev = |s: &nexus_kernel::ApprovalSubmission| evaluate_autonomous_policy(&d, &cfg, s);
        // covered
        assert!(ev(&edit(&task, &digest, "src/lib.rs", 100)).is_ok());
        assert!(ev(&sub(
            &task,
            &digest,
            "proc.run",
            "process",
            &[],
            proc_op("none", false, "none")
        ))
        .is_ok());
        // protected, hidden, outside the project's write scope, oversize, many files
        for p in [
            "build.rs",
            "Cargo.lock",
            ".env",
            ".git/config",
            "src/../x",
            "node_modules/a.js",
            "package.json",
        ] {
            assert!(ev(&edit(&task, &digest, p, 1)).is_err(), "{p}");
        }
        assert!(ev(&edit(&task, &digest, "README.md", 1))
            .unwrap_err()
            .contains("write scope"));
        assert!(ev(&edit(&task, &digest, "src/lib.rs", 10 * 1024 * 1024)).is_err());
        let mut two = edit(&task, &digest, "src/a.rs", 1);
        two.paths.push("src/b.rs".into());
        assert!(ev(&two).is_err());
        // a different workspace, a missing copy, an invalid task id
        assert!(ev(&edit(&task, &"0".repeat(64), "src/lib.rs", 1))
            .unwrap_err()
            .contains("isolated copy"));
        assert!(ev(&edit(
            "task-nonexistent0000000001",
            &digest,
            "src/lib.rs",
            1
        ))
        .is_err());
        assert!(ev(&edit("../etc", &digest, "src/lib.rs", 1)).is_err());
        // commands that would not run in the confined sandbox
        for (n, sh, wb) in [
            ("host", false, "none"),
            ("install", false, "none"), // this copy's project does not allow installs
            ("none", false, "workspace"),
        ] {
            assert!(
                ev(&sub(
                    &task,
                    &digest,
                    "proc.run",
                    "process",
                    &[],
                    proc_op(n, sh, wb)
                ))
                .is_err(),
                "{n} {sh} {wb}"
            );
        }
        // tool classes the policy does not cover, or scope/tool mismatches
        assert!(ev(&sub(
            &task,
            &digest,
            "fs.read",
            "write",
            &["src/lib.rs"],
            serde_json::json!({"postImageBytes": 1})
        ))
        .is_err());
        assert!(ev(&sub(
            &task,
            &digest,
            "fs.edit",
            "process",
            &[],
            proc_op("none", false, "none")
        ))
        .is_err());
        assert!(ev(&sub(
            &task,
            &digest,
            "proc.run",
            "write",
            &["src/lib.rs"],
            serde_json::json!({})
        ))
        .is_err());
    }

    #[test]
    fn the_automated_policy_budgets_are_per_task_and_a_swapped_copy_is_refused() {
        let (d, keep, task, digest) = policy_rig(&[]);
        let cfg = AutonomousConfig {
            max_edits_per_task: 2,
            max_commands_per_task: 1,
            max_write_bytes: 1000,
        };
        d.autonomous_counters
            .lock()
            .unwrap()
            .insert(task.clone(), (2, 1));
        assert!(
            evaluate_autonomous_policy(&d, &cfg, &edit(&task, &digest, "src/a.rs", 1))
                .unwrap_err()
                .contains("budget")
        );
        assert!(evaluate_autonomous_policy(
            &d,
            &cfg,
            &sub(
                &task,
                &digest,
                "proc.run",
                "process",
                &[],
                proc_op("none", false, "none")
            )
        )
        .unwrap_err()
        .contains("budget"));
        d.autonomous_counters.lock().unwrap().clear();
        assert!(
            evaluate_autonomous_policy(&d, &cfg, &edit(&task, &digest, "src/a.rs", 1001)).is_err()
        );
        assert!(
            evaluate_autonomous_policy(&d, &cfg, &edit(&task, &digest, "src/a.rs", 1000)).is_ok()
        );
        // the copy directory replaced by a symlink to elsewhere is not a daemon-made copy
        let root = d.worktree_root.clone().unwrap();
        std::fs::remove_dir_all(root.join(&task)).unwrap();
        std::os::unix::fs::symlink(keep.path(), root.join(&task)).unwrap();
        assert!(
            evaluate_autonomous_policy(&d, &cfg, &edit(&task, &digest, "src/a.rs", 1)).is_err()
        );
    }

    static NONCE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

    fn authed_acquire(daemon: &Daemon) -> IpcRequest {
        // Fresh nonce per request: the replay cache consumes each tag once,
        // so sharing a nonce across authorize() calls would false-positive.
        let n = NONCE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let params = serde_json::Map::new();
        let nonce = format!("cd{n:030x}");
        let id = format!("t-gate-{n}");
        let ts = crate::auth::now_ms();
        let tag = daemon
            .auth
            .as_ref()
            .expect("shadow-test auth")
            .tag_for("acquire", &id, &params, &nonce, ts);
        IpcRequest {
            id,
            cmd: "acquire".to_owned(),
            params,
            auth: Some(AuthFields { nonce, ts, tag }),
        }
    }

    fn code_of(value: &Option<serde_json::Value>) -> &str {
        value
            .as_ref()
            .and_then(|v| v.get("code"))
            .and_then(|v| v.as_str())
            .unwrap_or("<admitted>")
    }

    #[test]
    fn parse_allowed_uids_accepts_and_rejects() {
        assert_eq!(parse_allowed_uids("1000").unwrap(), vec![1000]);
        assert_eq!(
            parse_allowed_uids("1000, 1001,1000").unwrap(),
            vec![1000, 1001]
        );
        assert!(parse_allowed_uids("").is_err());
        assert!(parse_allowed_uids("1000,").is_err());
        assert!(parse_allowed_uids("root").is_err());
        assert!(parse_allowed_uids("4294967296").is_err());
    }

    #[test]
    fn gate_absent_preserves_cap_only_behavior() {
        let daemon = test_daemon(None, TrustMode::ShadowTest);
        let req = authed_acquire(&daemon);
        assert!(authorize(&daemon, &req, Some((own_uid(), 0, 0))).is_none());
    }

    #[test]
    fn matching_peer_uid_is_admitted() {
        let me = own_uid();
        let daemon = test_daemon(Some(vec![me]), TrustMode::ShadowTest);
        let req = authed_acquire(&daemon);
        assert!(authorize(&daemon, &req, Some((me, 0, 0))).is_none());
    }

    #[test]
    fn non_matching_peer_uid_is_refused_without_fallback() {
        let me = own_uid();
        // Allowlist names a UID we are not: even a VALID capability tag
        // must not admit the request, and no fallback path may admit it.
        let daemon = test_daemon(Some(vec![me.wrapping_add(65433)]), TrustMode::ShadowTest);
        let req = authed_acquire(&daemon);
        let refusal = authorize(&daemon, &req, Some((me, 0, 0)));
        assert_eq!(code_of(&refusal), codes::PEER_UNAUTHORIZED);
        // A valid tag presented in-process (no socket peer) is also refused
        // when a gate is configured: absence of credentials is not an
        // allowlist bypass. (Fresh tag: the first tag's nonce is consumed.)
        let req2 = authed_acquire(&daemon);
        let refusal = authorize(&daemon, &req2, None);
        assert_eq!(code_of(&refusal), codes::PEER_UNAUTHORIZED);
    }

    #[test]
    fn readonly_refuses_before_any_gate() {
        let me = own_uid();
        let daemon = test_daemon(Some(vec![me]), TrustMode::Readonly);
        let req = IpcRequest {
            id: "t-ro".to_owned(),
            cmd: "acquire".to_owned(),
            params: serde_json::Map::new(),
            auth: None,
        };
        let refusal = authorize(&daemon, &req, Some((me, 0, 0)));
        assert_eq!(code_of(&refusal), codes::PRIVILEGED_DISABLED);
    }

    #[test]
    fn replay_is_rejected_before_gate() {
        let me = own_uid();
        let daemon = test_daemon(Some(vec![me]), TrustMode::ShadowTest);
        let req = authed_acquire(&daemon);
        assert!(authorize(&daemon, &req, Some((me, 0, 0))).is_none());
        let replay = authorize(&daemon, &req, Some((me, 0, 0)));
        assert_eq!(code_of(&replay), codes::REPLAY_REJECTED);
    }

    #[test]
    fn protected_dir_checks_are_fail_closed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        // Provisioned owner-only root (0700, as deployment requires): passes.
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
            .expect("chmod");
        assert!(verify_protected_dir(dir.path(), "dataroot").is_ok());
        // Group/other-readable: refused (this is the real default of
        // umask-022 tempdirs, which is why the daemon enforces 0700).
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755))
            .expect("chmod");
        assert!(verify_protected_dir(dir.path(), "dataroot").is_err());
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777))
            .expect("chmod");
        assert!(verify_protected_dir(dir.path(), "dataroot").is_err());
        // A file is not a directory: refused.
        let file = dir.path().join("f");
        std::fs::write(&file, b"x").expect("write");
        assert!(verify_protected_dir(&file, "dataroot").is_err());
        // Missing path: refused.
        assert!(verify_protected_dir(&dir.path().join("nope"), "dataroot").is_err());
    }

    fn own_gid() -> u32 {
        unsafe { libc::getegid() }
    }

    fn provision_socket_dir(parent: &std::path::Path, mode: u32, gid: u32) -> std::path::PathBuf {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;
        let dir = parent.join("sockdir");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).expect("chmod");
        // chown group-only to a member group (own gid always works).
        let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).expect("cstr");
        let rc = unsafe { libc::chown(c.as_ptr(), u32::MAX, gid) };
        assert_eq!(rc, 0, "test setup chown failed");
        dir
    }

    #[test]
    fn parse_socket_group_accepts_gid_and_name() {
        let gid = own_gid();
        assert_eq!(parse_socket_group(&gid.to_string()).unwrap(), gid);
        // Our own group name must resolve to our own gid.
        let name = unsafe {
            let g = libc::getgrgid(gid);
            assert!(!g.is_null());
            let bytes = std::ffi::CStr::from_ptr((*g).gr_name).to_bytes();
            std::str::from_utf8(bytes)
                .expect("group name utf8")
                .to_owned()
        };
        assert_eq!(parse_socket_group(&name).unwrap(), gid);
        assert!(parse_socket_group("").is_err());
        assert!(parse_socket_group("   ").is_err());
        assert!(parse_socket_group("no-such-group-xyz-123").is_err());
    }

    #[test]
    fn socket_dir_policy_is_exact() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let gid = own_gid();
        // Exact 0750 + daemon-owned + matching group: admitted.
        let good = provision_socket_dir(tmp.path(), 0o750, gid);
        assert!(verify_socket_dir(&good, gid).is_ok());
        // Group/other drift of any kind: refused.
        for mode in [0o700, 0o755, 0o770, 0o777, 0o751, 0o2750] {
            std::fs::set_permissions(&good, std::fs::Permissions::from_mode(mode)).expect("chmod");
            assert!(
                verify_socket_dir(&good, gid).is_err(),
                "mode {mode:o} must be refused"
            );
        }
        std::fs::set_permissions(&good, std::fs::Permissions::from_mode(0o750)).expect("chmod");
        // Wrong group: refused (nobody membership may vary; use gid+1).
        assert!(verify_socket_dir(&good, gid.wrapping_add(1)).is_err());
        // Symlink leaf: refused even when the target is perfect.
        let link = tmp.path().join("socklink");
        std::os::unix::fs::symlink(&good, &link).expect("symlink");
        assert!(verify_socket_dir(&link, gid).is_err());
        // File and missing path: refused.
        let file = tmp.path().join("f");
        std::fs::write(&file, b"x").expect("write");
        assert!(verify_socket_dir(&file, gid).is_err());
        assert!(verify_socket_dir(&tmp.path().join("nope"), gid).is_err());
    }
}
