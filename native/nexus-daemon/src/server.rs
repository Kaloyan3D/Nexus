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
    /// A3.3: mutating tools are refused unless explicitly enabled.
    pub writes_enabled: bool,
    /// Separate approver capability (never the issuer capability).
    pub approver_auth: Option<Arc<IssuerAuth>>,
    pub approver_uids: Option<Vec<u32>>,
    /// True only when approver UIDs are disjoint from issuer UIDs.
    pub approver_independent: bool,
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

/// Daemon-side hooks for the write lifecycle: journal and fence take the
/// Kernel lock only briefly per call; nothing is held across file I/O.
struct DaemonWriteHooks<'a> {
    daemon: &'a Daemon,
    verified: &'a nexus_kernel::VerifiedToolGrant,
    last_seq: i64,
}

impl nexus_tools::WriteHooks for DaemonWriteHooks<'_> {
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
            .record_write_phase(self.verified, phase, payload)
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
    if let Err(r) = only_keys(&req.params, &["commandId", "root"], &req.id) {
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
    let mut kernel = match lock_kernel(daemon, &req.id) {
        Ok(k) => k,
        Err(r) => return r,
    };
    match kernel.bind_workspace(&command_id, &root, &daemon.workspace_bases) {
        // The root path itself is deliberately not echoed back.
        Ok(b) => ok(
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
        ),
        Err(e) => kernel_fail(daemon, &req.id, &e),
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
        if mutating && !daemon.writes_enabled {
            daemon.counters.refused.fetch_add(1, Ordering::Relaxed);
            return fail(
                &req.id,
                "write-disabled",
                "write tools are not enabled on this daemon",
            );
        }
        let prepared = if mutating {
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
            Ok(p) => p,
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        let is_write = mutating;
        let call = match nexus_tools::authorize(&mut kernel, prepared) {
            Ok(c) => c,
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        let started = match nexus_tools::begin(&mut kernel, &call, &cancel) {
            Ok(s) => s,
            Err(e) => return tool_fail(daemon, &req.id, &e),
        };
        (call, started, is_write)
    };
    let (call, started, is_write) = (call.0, call.1, call.2);

    if is_write {
        // Write lifecycle: journal + fence hooks lock the Kernel only
        // briefly; the filesystem work holds no lock.
        let mut hooks = DaemonWriteHooks {
            daemon,
            verified: started.verified(),
            last_seq: 0,
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
                        "testOnlyApproval": !daemon.approver_independent,
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
                    "aiInitiated": false,
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
    if req.cmd == "write-scope-approve" {
        return do_write_scope_approve(daemon, req, peer);
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
            "intent-publish" => do_intent_publish(daemon, req),
            "intent-fence" => do_intent_fence(daemon, req),
            "dispatch-authorize" => do_dispatch_authorize(daemon, req),
            "workspace-bind" => do_workspace_bind(daemon, req),
            "tool-execute" => do_tool_execute(daemon, req),
            "tool-revoke" => do_tool_revoke(daemon, req),
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
            writes_enabled: false,
            approver_auth: None,
            approver_uids: None,
            approver_independent: false,
            tool_inflight: AtomicUsize::new(0),
            witness_configured: false,
            witness_path: None,
            start_utc: String::new(),
        }
    }

    fn own_uid() -> u32 {
        unsafe { libc::geteuid() }
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
