//! Native tool authority (A3.1).
//!
//! The Kernel is the only minter of tool grants. A grant is an HMAC-sealed
//! statement that one accepted command, in its current attempt and lease
//! generation, may run exactly one read-only tool invocation with exactly
//! these arguments, against exactly this workspace, under exactly these
//! budgets. Model- or renderer-supplied JSON is never authority: it must be
//! bound to a grant the Kernel signed.
//!
//! Lifecycle (each phase is journaled exactly once, hash-chained):
//!   authorize_tool -> `authorized`; begin_tool_execution -> `started`
//!   (consumes the grant; replay refused); complete_tool_execution ->
//!   `completed`. A `started` without `completed` is a crashed execution and
//!   is never silently re-run.
//!
//! This module performs no filesystem access on workspaces. It carries no
//! live-dispatch authority: `Kernel::dispatch_enabled()` stays false.

use crate::{hmac_seal_hex, Kernel};
use nexus_contracts::{canonical_json, KernelError, KernelErrorCode, KernelResult};
use nexus_store::{ToolEntryInput, ToolJournalEntry};

pub const TOOL_GRANT_SEAL_DOMAIN: &str = "nexus-tool-grant/v1";
pub const TOOL_GRANT_TTL_MS: i64 = 120_000;
pub const TOOL_GRANT_SKEW_MS: i64 = 60_000;

const TOOL_CHECKPOINT_KEY: &str = "tool_journal_checkpoint/v1";

pub const PHASE_AUTHORIZED: &str = "authorized";
pub const PHASE_STARTED: &str = "started";
pub const PHASE_COMPLETED: &str = "completed";
/// Terminal, never an execution outcome: the grant lapsed unexecuted.
pub const PHASE_EXPIRED: &str = "expired";
/// Terminal: execution started but no completion was ever recorded
/// (crash/restart). Outcome is UNCERTAIN; it is never re-executed and no
/// completion is invented.
pub const PHASE_INTERRUPTED: &str = "interrupted";

/// Write lifecycle phases (A3.3). Durability points are documented in
/// `native/A3.3-EVIDENCE.md`.
pub const PHASE_PLANNED: &str = "planned";
pub const PHASE_PREPARED: &str = "prepared";
pub const PHASE_APPLIED: &str = "applied";
pub const PHASE_VERIFIED: &str = "verified";
pub const PHASE_FAILED: &str = "failed";
pub const PHASE_CONFLICT: &str = "conflict";

const WRITE_TERMINALS: [&str; 6] = [
    PHASE_VERIFIED,
    PHASE_FAILED,
    PHASE_CONFLICT,
    PHASE_INTERRUPTED,
    PHASE_COMPLETED,
    PHASE_EXPIRED,
];

/// Tool identifiers the Kernel will ever seal, with their grant scope.
/// A `read` grant can never authorize mutation: the scope is sealed into
/// the grant and re-derived from the tool id at every verification.
pub fn tool_scope(tool_id: &str) -> Option<&'static str> {
    match tool_id {
        "fs.list" | "fs.read" | "fs.search" => Some("read"),
        "fs.write" | "fs.edit" => Some("write"),
        "proc.run" => Some("process"),
        _ => None,
    }
}

/// Process lifecycle (A3.4): authorized -> started (grant consumed,
/// exactly once) -> prepared (snapshot + sandbox digests durable, BEFORE
/// spawn) -> running (process spawned) -> exited | failed | cancelled |
/// interrupted.
pub const PHASE_RUNNING: &str = "running";
pub const PHASE_EXITED: &str = "exited";
pub const PHASE_CANCELLED: &str = "cancelled";

const PROCESS_TERMINALS: [&str; 7] = [
    PHASE_EXITED,
    PHASE_FAILED,
    PHASE_CANCELLED,
    PHASE_INTERRUPTED,
    PHASE_EXPIRED,
    PHASE_COMPLETED,
    PHASE_VERIFIED,
];

pub const PROCESS_SCOPE_DOMAIN: &str = "nexus-process-scope/v1";
pub const WRITE_SCOPE_DOMAIN: &str = "nexus-write-scope/v1";
pub const WORKSPACE_BINDING_DOMAIN: &str = "nexus-workspace-binding/v1";

/// What the trusted issuer asks the Kernel to authorize.
#[derive(Debug, Clone)]
pub struct ToolAuthorizationRequest {
    pub request_id: String,
    pub command_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub tool_id: String,
    pub tool_version: u32,
    pub args_digest: String,
    pub workspace_root_digest: String,
    pub workspace_root_dev: u64,
    pub workspace_root_ino: u64,
    pub budget_digest: String,
    pub cancellation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SealedToolGrant {
    pub execution_id: String,
    pub request_id: String,
    pub command_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub tool_id: String,
    /// `read` or `write`; derived from the tool id and sealed.
    pub scope: String,
    pub tool_version: u32,
    pub args_digest: String,
    pub workspace_root_digest: String,
    pub workspace_root_dev: u64,
    pub workspace_root_ino: u64,
    pub budget_digest: String,
    pub cancellation_id: String,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    pub nonce_hex: String,
    pub tag_hex: String,
}

/// Controller-published workspace authority for one accepted command.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceBinding {
    pub command_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub root_path: String,
    pub root_digest: String,
    pub root_dev: u64,
    pub root_ino: u64,
}

/// Independent write authority for one accepted command (A3.3). Created
/// only through the approver-authenticated daemon channel; the issuer
/// capability alone cannot create it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WriteScopeBinding {
    pub command_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub root_digest: String,
    pub max_write_bytes: u64,
    pub approver_id: String,
    /// True only when the daemon verified the approver credential is held
    /// by identities disjoint from the issuer's. Never self-asserted.
    pub independent: bool,
}

fn write_scope_canonical(b: &WriteScopeBinding) -> String {
    canonical_json(&serde_json::json!({
        "domain": WRITE_SCOPE_DOMAIN,
        "commandId": b.command_id,
        "taskInstanceId": b.task_instance_id,
        "attemptId": b.attempt_id,
        "leaseEpoch": b.lease_epoch,
        "storeIncarnation": b.store_incarnation,
        "rootDigest": b.root_digest,
        "maxWriteBytes": b.max_write_bytes,
        "approverId": b.approver_id,
        "independent": b.independent,
    }))
}

/// One open (non-terminal) process request, as seen by reconciliation.
#[derive(Debug, Clone)]
pub struct OpenProcess {
    pub request_id: String,
    pub execution_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub command_id: String,
    pub prepared: serde_json::Value,
    pub running: Option<serde_json::Value>,
}

/// Independent approval to run sandboxed processes for one accepted
/// command (A3.4). Separate from read bindings and from write scopes: a
/// read or write grant can never authorize a subprocess.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcessScopeBinding {
    pub command_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub root_digest: String,
    /// Upper bound on wall-clock runtime the approver allows.
    pub max_wall_ms: u64,
    pub approver_id: String,
    pub independent: bool,
}

fn process_scope_canonical(b: &ProcessScopeBinding) -> String {
    canonical_json(&serde_json::json!({
        "domain": PROCESS_SCOPE_DOMAIN,
        "commandId": b.command_id,
        "taskInstanceId": b.task_instance_id,
        "attemptId": b.attempt_id,
        "leaseEpoch": b.lease_epoch,
        "storeIncarnation": b.store_incarnation,
        "rootDigest": b.root_digest,
        "maxWallMs": b.max_wall_ms,
        "approverId": b.approver_id,
        "independent": b.independent,
    }))
}

/// One open (non-terminal) write request, as seen by reconciliation.
#[derive(Debug, Clone)]
pub struct OpenWrite {
    pub request_id: String,
    pub execution_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub command_id: String,
    pub planned: serde_json::Value,
    pub prepared: Option<serde_json::Value>,
    pub applied: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    pub expired: u64,
    pub interrupted: u64,
}

fn binding_canonical(b: &WorkspaceBinding) -> String {
    canonical_json(&serde_json::json!({
        "domain": WORKSPACE_BINDING_DOMAIN,
        "commandId": b.command_id,
        "taskInstanceId": b.task_instance_id,
        "attemptId": b.attempt_id,
        "leaseEpoch": b.lease_epoch,
        "storeIncarnation": b.store_incarnation,
        "rootPath": b.root_path,
        "rootDigest": b.root_digest,
        "rootDev": b.root_dev,
        "rootIno": b.root_ino,
    }))
}

/// A grant the Kernel has re-verified and marked `started`. Not
/// constructible outside this crate.
#[derive(Debug, Clone)]
pub struct VerifiedToolGrant {
    grant: SealedToolGrant,
    _private: (),
}

impl VerifiedToolGrant {
    pub fn grant(&self) -> &SealedToolGrant {
        &self.grant
    }
}

pub(crate) fn now_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis().min(i64::MAX as u128) as i64,
        Err(_) => 0,
    }
}

pub(crate) fn random_hex(n: usize) -> KernelResult<String> {
    use std::io::Read as _;
    let mut bytes = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| {
            KernelError::new(
                KernelErrorCode::StoreError,
                ["entropy unavailable: ", &e.to_string()].concat(),
            )
        })?;
    Ok(hex::encode(bytes))
}

fn grant_canonical(g: &SealedToolGrant) -> String {
    canonical_json(&serde_json::json!({
        "domain": TOOL_GRANT_SEAL_DOMAIN,
        "executionId": g.execution_id,
        "requestId": g.request_id,
        "commandId": g.command_id,
        "taskInstanceId": g.task_instance_id,
        "attemptId": g.attempt_id,
        "leaseEpoch": g.lease_epoch,
        "storeIncarnation": g.store_incarnation,
        "toolId": g.tool_id,
        "scope": g.scope,
        "toolVersion": g.tool_version,
        "argsDigest": g.args_digest,
        "workspaceRootDigest": g.workspace_root_digest,
        "workspaceRootDev": g.workspace_root_dev,
        "workspaceRootIno": g.workspace_root_ino,
        "budgetDigest": g.budget_digest,
        "cancellationId": g.cancellation_id,
        "issuedAtMs": g.issued_at_ms,
        "expiresAtMs": g.expires_at_ms,
        "nonceHex": g.nonce_hex,
    }))
}

pub(crate) fn refuse(code: KernelErrorCode, msg: &str) -> KernelError {
    KernelError::new(code, msg)
}

impl Kernel {
    /// Shared authority revalidation: accepted receipt, current lease,
    /// witness health, intent not fenced. Returns nothing; refuses closed.
    pub(crate) fn require_tool_authority(
        store: &nexus_store::Store,
        witness: Option<&nexus_store::WitnessStore>,
        command_id: &str,
        task: &str,
        attempt: &str,
        lease_epoch: u64,
        incarnation: &str,
    ) -> KernelResult<()> {
        let receipt = store.read_receipt(command_id)?.ok_or_else(|| {
            refuse(
                KernelErrorCode::DeliveryInvalid,
                "no accepted receipt for this command; tool authority refused",
            )
        })?;
        if receipt.task_instance_id != task || receipt.attempt_id != attempt {
            return Err(refuse(
                KernelErrorCode::BindingMismatch,
                "tool request task/attempt differs from the accepted command",
            ));
        }
        let current = store.current_generation(task, "native")?;
        let (epoch_now, incarnation_now, protected_now) = match current {
            Some(g) => (g.epoch, g.incarnation, g.witness_protected),
            None => {
                return Err(refuse(
                    KernelErrorCode::StaleLease,
                    "generation is not live; tool authority refused",
                ))
            }
        };
        if epoch_now != lease_epoch
            || incarnation_now != incarnation
            || receipt.lease_epoch != lease_epoch
            || receipt.store_incarnation != incarnation
        {
            return Err(refuse(
                KernelErrorCode::StaleLease,
                "stale attempt generation; tool authority refused",
            ));
        }
        match witness {
            None => {
                return Err(refuse(
                    KernelErrorCode::WitnessRequired,
                    "tool execution needs the independent witness",
                ))
            }
            Some(w) => {
                let gkey = nexus_contracts::generation_key(task, "native");
                match w.read(&gkey)? {
                    Some(rec) if rec.max_epoch > epoch_now => {
                        return Err(refuse(
                            KernelErrorCode::RollbackDetected,
                            "store epoch is behind the witness maximum",
                        ))
                    }
                    None if protected_now => {
                        return Err(refuse(
                            KernelErrorCode::ReconciliationRequired,
                            "witness record lost after protection was established",
                        ))
                    }
                    _ => {}
                }
            }
        }
        if store.tools_revoked(command_id)? {
            return Err(refuse(
                KernelErrorCode::IntentFenced,
                "tool authority was revoked for this command",
            ));
        }
        if let Some((_, _, state)) = store.fetch_intent(command_id)? {
            if state == "cancelled" {
                return Err(refuse(
                    KernelErrorCode::IntentFenced,
                    "command was cancelled; tool authority refused",
                ));
            }
        }
        Ok(())
    }

    /// Mint a sealed tool grant and journal `authorized`.
    pub fn authorize_tool(
        &mut self,
        req: &ToolAuthorizationRequest,
    ) -> KernelResult<SealedToolGrant> {
        Self::critical(&self.lock_file, &self.in_process, || {
            for (name, v) in [
                ("requestId", &req.request_id),
                ("commandId", &req.command_id),
                ("taskInstanceId", &req.task_instance_id),
                ("attemptId", &req.attempt_id),
                ("toolId", &req.tool_id),
                ("argsDigest", &req.args_digest),
                ("workspaceRootDigest", &req.workspace_root_digest),
                ("budgetDigest", &req.budget_digest),
                ("cancellationId", &req.cancellation_id),
            ] {
                if v.is_empty() {
                    return Err(refuse(
                        KernelErrorCode::DeliveryInvalid,
                        &["tool authorization field ", name, " is required"].concat(),
                    ));
                }
            }
            let scope = tool_scope(&req.tool_id)
                .ok_or_else(|| refuse(KernelErrorCode::ScopeRefused, "unknown tool id; refused"))?;
            Self::require_tool_authority(
                &self.store,
                self.witness.as_ref(),
                &req.command_id,
                &req.task_instance_id,
                &req.attempt_id,
                req.lease_epoch,
                &req.store_incarnation,
            )?;
            let key_for_binding = self.store.issuance_key_hex()?;
            Self::check_binding(&self.store, &key_for_binding, req)?;
            let write_scope = if scope == "write" {
                Some(Self::check_write_scope(&self.store, &key_for_binding, req)?)
            } else {
                None
            };
            let process_scope = if scope == "process" {
                Some(Self::check_process_scope(
                    &self.store,
                    &key_for_binding,
                    req,
                )?)
            } else {
                None
            };
            Self::ensure_journal_consistent(&mut self.store, self.witness.as_ref())?;
            if self
                .store
                .tool_phase_recorded(&req.request_id, PHASE_AUTHORIZED)?
            {
                return Err(refuse(
                    KernelErrorCode::CommandConflict,
                    "tool request already authorized; duplicate refused",
                ));
            }
            let key_hex = self.store.issuance_key_hex()?;
            let issued = now_ms();
            let mut g = SealedToolGrant {
                execution_id: random_hex(16)?,
                request_id: req.request_id.clone(),
                command_id: req.command_id.clone(),
                task_instance_id: req.task_instance_id.clone(),
                attempt_id: req.attempt_id.clone(),
                lease_epoch: req.lease_epoch,
                store_incarnation: req.store_incarnation.clone(),
                tool_id: req.tool_id.clone(),
                scope: scope.to_owned(),
                tool_version: req.tool_version,
                args_digest: req.args_digest.clone(),
                workspace_root_digest: req.workspace_root_digest.clone(),
                workspace_root_dev: req.workspace_root_dev,
                workspace_root_ino: req.workspace_root_ino,
                budget_digest: req.budget_digest.clone(),
                cancellation_id: req.cancellation_id.clone(),
                issued_at_ms: issued,
                expires_at_ms: issued.saturating_add(TOOL_GRANT_TTL_MS),
                nonce_hex: random_hex(16)?,
                tag_hex: String::new(),
            };
            g.tag_hex = hmac_seal_hex(&key_hex, &grant_canonical(&g))?;
            self.store.append_tool_entry(&ToolEntryInput {
                request_id: g.request_id.clone(),
                execution_id: g.execution_id.clone(),
                task_instance_id: g.task_instance_id.clone(),
                attempt_id: g.attempt_id.clone(),
                command_id: g.command_id.clone(),
                phase: PHASE_AUTHORIZED.to_owned(),
                payload: serde_json::json!({
                    "toolId": g.tool_id,
                    "scope": g.scope,
                    "approverIndependent": write_scope
                        .as_ref()
                        .map(|b| b.independent)
                        .or(process_scope.as_ref().map(|b| b.independent)),
                    "toolVersion": g.tool_version,
                    "workspaceRootDigest": g.workspace_root_digest,
                    "budgetDigest": g.budget_digest,
                    "cancellationId": g.cancellation_id,
                    "leaseEpoch": g.lease_epoch,
                    "expiresAtMs": g.expires_at_ms,
                }),
            })?;
            Self::checkpoint_tool_journal(&mut self.store, self.witness.as_mut())?;
            Ok(g)
        })
    }

    /// Verify a grant, revalidate live authority, and journal `started`.
    /// This is the single gate before any workspace byte is read.
    pub fn begin_tool_execution(
        &mut self,
        grant: &SealedToolGrant,
        expected_args_digest: &str,
        expected_budget_digest: &str,
    ) -> KernelResult<VerifiedToolGrant> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let key_hex = self.store.issuance_key_hex()?;
            let expect = hmac_seal_hex(&key_hex, &grant_canonical(grant))?;
            if expect != grant.tag_hex {
                return Err(refuse(
                    KernelErrorCode::ForgedIssuer,
                    "tool grant seal mismatch; forged or altered",
                ));
            }
            let now = now_ms();
            if now > grant.expires_at_ms
                || grant.issued_at_ms > now.saturating_add(TOOL_GRANT_SKEW_MS)
            {
                return Err(refuse(
                    KernelErrorCode::ReservationExpired,
                    "tool grant expired or not yet valid",
                ));
            }
            if tool_scope(&grant.tool_id) != Some(grant.scope.as_str()) {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "grant scope does not match its tool id; refused",
                ));
            }
            if grant.scope == "write" {
                let key = self.store.issuance_key_hex()?;
                let b = Self::verified_write_scope(&self.store, &key, &grant.command_id)?
                    .ok_or_else(|| {
                        refuse(
                            KernelErrorCode::ScopeRefused,
                            "no independent write scope for this command; mutation refused",
                        )
                    })?;
                if b.lease_epoch != grant.lease_epoch
                    || b.store_incarnation != grant.store_incarnation
                    || b.root_digest != grant.workspace_root_digest
                {
                    return Err(refuse(
                        KernelErrorCode::BindingMismatch,
                        "write scope does not match this grant",
                    ));
                }
            }
            if grant.scope == "process" {
                let key = self.store.issuance_key_hex()?;
                let b = Self::verified_process_scope(&self.store, &key, &grant.command_id)?
                    .ok_or_else(|| {
                        refuse(
                            KernelErrorCode::ScopeRefused,
                            "no independent process scope for this command; execution refused",
                        )
                    })?;
                if b.lease_epoch != grant.lease_epoch
                    || b.store_incarnation != grant.store_incarnation
                    || b.root_digest != grant.workspace_root_digest
                {
                    return Err(refuse(
                        KernelErrorCode::BindingMismatch,
                        "process scope does not match this grant",
                    ));
                }
            }
            if grant.args_digest != expected_args_digest {
                return Err(refuse(
                    KernelErrorCode::BindingMismatch,
                    "tool arguments differ from the authorized arguments",
                ));
            }
            if grant.budget_digest != expected_budget_digest {
                return Err(refuse(
                    KernelErrorCode::BindingMismatch,
                    "tool budgets differ from the authorized budgets",
                ));
            }
            if grant.store_incarnation != self.store.incarnation() {
                return Err(refuse(
                    KernelErrorCode::StaleLease,
                    "tool grant belongs to a different store incarnation",
                ));
            }
            Self::require_tool_authority(
                &self.store,
                self.witness.as_ref(),
                &grant.command_id,
                &grant.task_instance_id,
                &grant.attempt_id,
                grant.lease_epoch,
                &grant.store_incarnation,
            )?;
            Self::ensure_journal_consistent(&mut self.store, self.witness.as_ref())?;
            for terminal in [PHASE_EXPIRED, PHASE_INTERRUPTED] {
                if self
                    .store
                    .tool_phase_recorded(&grant.request_id, terminal)?
                {
                    return Err(refuse(
                        KernelErrorCode::IntentFenced,
                        "tool request was already closed by reconciliation; not re-executable",
                    ));
                }
            }
            if !self
                .store
                .tool_phase_recorded(&grant.request_id, PHASE_AUTHORIZED)?
            {
                return Err(refuse(
                    KernelErrorCode::IntentUnknown,
                    "tool grant has no authorized journal record",
                ));
            }
            // Exactly-once start: a replayed grant hits the unique
            // (request, phase) constraint and is refused here.
            self.store.append_tool_entry(&ToolEntryInput {
                request_id: grant.request_id.clone(),
                execution_id: grant.execution_id.clone(),
                task_instance_id: grant.task_instance_id.clone(),
                attempt_id: grant.attempt_id.clone(),
                command_id: grant.command_id.clone(),
                phase: PHASE_STARTED.to_owned(),
                payload: serde_json::json!({ "toolId": grant.tool_id }),
            })?;
            Self::checkpoint_tool_journal(&mut self.store, self.witness.as_mut())?;
            Ok(VerifiedToolGrant {
                grant: grant.clone(),
                _private: (),
            })
        })
    }

    /// Journal `completed` with the already-redacted result record.
    pub fn complete_tool_execution(
        &mut self,
        verified: &VerifiedToolGrant,
        record: serde_json::Value,
    ) -> KernelResult<ToolJournalEntry> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let g = &verified.grant;
            if !self
                .store
                .tool_phase_recorded(&g.request_id, PHASE_STARTED)?
            {
                return Err(refuse(
                    KernelErrorCode::IntentUnknown,
                    "tool execution was never started",
                ));
            }
            let entry = self.store.append_tool_entry(&ToolEntryInput {
                request_id: g.request_id.clone(),
                execution_id: g.execution_id.clone(),
                task_instance_id: g.task_instance_id.clone(),
                attempt_id: g.attempt_id.clone(),
                command_id: g.command_id.clone(),
                phase: PHASE_COMPLETED.to_owned(),
                payload: record,
            })?;
            Self::checkpoint_tool_journal(&mut self.store, self.witness.as_mut())?;
            Ok(entry)
        })
    }

    fn check_binding(
        store: &nexus_store::Store,
        key_hex: &str,
        req: &ToolAuthorizationRequest,
    ) -> KernelResult<()> {
        let b = Self::verified_binding(store, key_hex, &req.command_id)?.ok_or_else(|| {
            refuse(
                KernelErrorCode::DeliveryInvalid,
                "no Controller workspace binding for this command; tool authority refused",
            )
        })?;
        if b.task_instance_id != req.task_instance_id
            || b.attempt_id != req.attempt_id
            || b.lease_epoch != req.lease_epoch
            || b.store_incarnation != req.store_incarnation
        {
            return Err(refuse(
                KernelErrorCode::BindingMismatch,
                "workspace binding does not belong to this task/attempt/generation",
            ));
        }
        if b.root_digest != req.workspace_root_digest
            || b.root_dev != req.workspace_root_dev
            || b.root_ino != req.workspace_root_ino
        {
            return Err(refuse(
                KernelErrorCode::BindingMismatch,
                "workspace identity differs from the Controller-authorized binding",
            ));
        }
        Ok(())
    }

    pub(crate) fn verified_binding(
        store: &nexus_store::Store,
        key_hex: &str,
        command_id: &str,
    ) -> KernelResult<Option<WorkspaceBinding>> {
        match store.fetch_workspace_binding(command_id)? {
            None => Ok(None),
            Some((json, seal)) => {
                let b: WorkspaceBinding = serde_json::from_str(&json).map_err(|_| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "workspace binding unreadable",
                    )
                })?;
                if hmac_seal_hex(key_hex, &binding_canonical(&b))? != seal
                    || canonical_json(&serde_json::to_value(&b).unwrap_or_default()) != json
                {
                    return Err(KernelError::new(
                        KernelErrorCode::ForgedIssuer,
                        "workspace binding seal mismatch; store tampered",
                    ));
                }
                Ok(Some(b))
            }
        }
    }

    /// Verified read of the Controller workspace binding (seal checked).
    pub fn workspace_binding(
        &mut self,
        command_id: &str,
    ) -> KernelResult<Option<WorkspaceBinding>> {
        let key_hex = self.store.issuance_key_hex()?;
        Self::verified_binding(&self.store, &key_hex, command_id)
    }

    /// Controller workspace authorization. Called only through the
    /// issuer-authenticated daemon channel (or an in-process trusted
    /// harness). The root must (a) belong to an accepted command in its
    /// current lease generation, (b) be a real directory, and (c) lie
    /// beneath an operator-configured allowed base. Its `(dev, ino)` is
    /// captured by the Kernel itself, never taken from the caller.
    pub fn bind_workspace(
        &mut self,
        command_id: &str,
        root: &str,
        allowed_bases: &[std::path::PathBuf],
    ) -> KernelResult<WorkspaceBinding> {
        use std::os::unix::fs::MetadataExt;
        Self::critical(&self.lock_file, &self.in_process, || {
            let receipt = self.store.read_receipt(command_id)?.ok_or_else(|| {
                refuse(
                    KernelErrorCode::DeliveryInvalid,
                    "no accepted receipt for this command; workspace binding refused",
                )
            })?;
            Self::require_tool_authority(
                &self.store,
                self.witness.as_ref(),
                command_id,
                &receipt.task_instance_id,
                &receipt.attempt_id,
                receipt.lease_epoch,
                &receipt.store_incarnation,
            )?;
            if !root.starts_with('/') || root.contains('\0') {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "workspace root must be an absolute path",
                ));
            }
            let canon = std::fs::canonicalize(root).map_err(|_| {
                refuse(
                    KernelErrorCode::ScopeRefused,
                    "workspace root does not exist or is unreadable",
                )
            })?;
            let beneath = allowed_bases.iter().any(|b| {
                std::fs::canonicalize(b)
                    .map(|cb| cb != std::path::Path::new("/") && canon.starts_with(&cb))
                    .unwrap_or(false)
            });
            if !beneath {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "workspace root is not beneath an operator-allowed workspace base",
                ));
            }
            let md = std::fs::symlink_metadata(&canon)
                .map_err(|_| refuse(KernelErrorCode::ScopeRefused, "workspace root unreadable"))?;
            if !md.is_dir() {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "workspace root is not a directory",
                ));
            }
            let root_path = canon.to_str().ok_or_else(|| {
                refuse(KernelErrorCode::ScopeRefused, "workspace root is not UTF-8")
            })?;
            // The issuer does not get to pick the workspace at bind time:
            // the Controller-authored intent payload that was digest-
            // verified and sealed at ACCEPTANCE must commit to exactly this
            // root (`workspaceRootDigest = sha256(canonical root)`). Being
            // beneath an allowed base is necessary, never sufficient.
            let payload = self.store.command_payload(command_id)?.ok_or_else(|| {
                refuse(
                    KernelErrorCode::StoreCorrupt,
                    "accepted command has no payload",
                )
            })?;
            let payload: serde_json::Value = serde_json::from_str(&payload).map_err(|_| {
                KernelError::new(KernelErrorCode::StoreCorrupt, "command payload unreadable")
            })?;
            let committed = payload
                .get("workspaceRootDigest")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    refuse(
                        KernelErrorCode::ScopeRefused,
                        "accepted intent does not commit to a workspace (workspaceRootDigest); binding refused",
                    )
                })?;
            if committed != nexus_contracts::sha256_hex(root_path) {
                return Err(refuse(
                    KernelErrorCode::BindingMismatch,
                    "workspace differs from the root committed in the accepted Controller intent",
                ));
            }
            let b = WorkspaceBinding {
                command_id: command_id.to_owned(),
                task_instance_id: receipt.task_instance_id.clone(),
                attempt_id: receipt.attempt_id.clone(),
                lease_epoch: receipt.lease_epoch,
                store_incarnation: receipt.store_incarnation.clone(),
                root_path: root_path.to_owned(),
                root_digest: nexus_contracts::sha256_hex(root_path),
                root_dev: md.dev(),
                root_ino: md.ino(),
            };
            let key_hex = self.store.issuance_key_hex()?;
            let seal = hmac_seal_hex(&key_hex, &binding_canonical(&b))?;
            let json = canonical_json(&serde_json::to_value(&b).map_err(|_| {
                KernelError::new(KernelErrorCode::StoreError, "binding not serializable")
            })?);
            self.store
                .insert_workspace_binding(command_id, &json, &seal)?;
            Ok(b)
        })
    }

    /// Controller-side revocation of tool authority for one command.
    /// Observed by `begin_tool_execution` and by mid-execution probes.
    pub fn revoke_tools(&mut self, command_id: &str, reason: &str) -> KernelResult<()> {
        Self::critical(&self.lock_file, &self.in_process, || {
            if self.store.read_receipt(command_id)?.is_none() {
                return Err(refuse(
                    KernelErrorCode::IntentUnknown,
                    "no accepted command to revoke",
                ));
            }
            self.store
                .revoke_tools(command_id, &reason.chars().take(120).collect::<String>())?;
            // A4.2: revocation also withdraws every open human approval.
            Self::revoke_open_approvals(&mut self.store, command_id, "tools-revoked")?;
            Ok(())
        })
    }

    /// Authoritative, read-only fence probe for an in-flight execution:
    /// lease generation, witness, revocation and intent fence. Never
    /// depends on the caller's cancellation token.
    pub fn check_tool_fence(&self, verified: &VerifiedToolGrant) -> KernelResult<()> {
        let g = &verified.grant;
        Self::require_tool_authority(
            &self.store,
            self.witness.as_ref(),
            &g.command_id,
            &g.task_instance_id,
            &g.attempt_id,
            g.lease_epoch,
            &g.store_incarnation,
        )
    }

    /// Same probe for a grant that this process already verified and
    /// started (the daemon keeps the sealed grant, not the verified token).
    pub fn check_tool_fence_for(&self, g: &SealedToolGrant) -> KernelResult<()> {
        Self::require_tool_authority(
            &self.store,
            self.witness.as_ref(),
            &g.command_id,
            &g.task_instance_id,
            &g.attempt_id,
            g.lease_epoch,
            &g.store_incarnation,
        )
    }

    /// Journal/witness consistency gate run before every append.
    ///
    /// Recoverable states (checkpoint count `c`, store count `n`):
    /// * `n == c`, tail hash == checkpoint tail  -> consistent;
    /// * `n == c + 1`, entry `c` hash == checkpoint tail -> crash between
    ///   append and checkpoint (documented one-entry window), recoverable;
    /// * anything else (store behind, diverged, further ahead, missing or
    ///   unsealed checkpoint with a non-trivial journal) -> fail closed.
    fn ensure_journal_consistent(
        store: &mut nexus_store::Store,
        witness: Option<&nexus_store::WitnessStore>,
    ) -> KernelResult<()> {
        let Some(w) = witness else { return Ok(()) };
        let corrupt = |m: &str| KernelError::new(KernelErrorCode::StoreCorrupt, m);
        let (n, tail) = store.tool_journal_tail()?;
        let Some(raw) = w.get_meta(TOOL_CHECKPOINT_KEY)? else {
            return if n <= 1 {
                Ok(())
            } else {
                Err(corrupt(
                    "tool journal has no witness checkpoint (inconsistent evidence)",
                ))
            };
        };
        let v: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| corrupt("tool journal checkpoint unreadable"))?;
        let c = v
            .get("count")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| corrupt("checkpoint count"))?;
        let ctail = v
            .get("tail")
            .and_then(|x| x.as_str())
            .ok_or_else(|| corrupt("checkpoint tail"))?;
        let cseal = v
            .get("seal")
            .and_then(|x| x.as_str())
            .ok_or_else(|| corrupt("checkpoint seal"))?;
        if store.tool_checkpoint_seal(c, ctail)? != cseal {
            return Err(corrupt("tool journal checkpoint seal mismatch"));
        }
        if n == c {
            if tail != ctail {
                return Err(corrupt(
                    "tool journal tail diverges from the witness checkpoint",
                ));
            }
            return Ok(());
        }
        if n == c + 1 {
            return match store.tool_entry_hash_at(c)? {
                Some(h) if h == ctail => Ok(()),
                _ => Err(corrupt("tool journal diverges from the witness checkpoint")),
            };
        }
        if n < c {
            return Err(corrupt(
                "tool journal is shorter than the witness checkpoint (tail truncation)",
            ));
        }
        Err(corrupt(
            "tool journal is more than one entry ahead of the witness checkpoint",
        ))
    }

    /// Deterministic lifecycle reconciliation. Never invents completion:
    /// * `authorized` older than the grant lifetime, never started ->
    ///   terminal `expired`;
    /// * (`include_started`) `started` with no completion -> terminal
    ///   `interrupted` (uncertain; reads may have happened; not retried).
    ///
    /// `include_started` must only be true when no execution can be in
    /// flight (daemon startup, single owner of the store).
    pub fn reconcile_tool_journal(
        &mut self,
        include_started: bool,
    ) -> KernelResult<ReconcileReport> {
        self.reconcile_tool_journal_at(now_ms(), include_started)
    }

    /// `reconcile_tool_journal` with an explicit clock (tests, replay).
    pub fn reconcile_tool_journal_at(
        &mut self,
        now: i64,
        include_started: bool,
    ) -> KernelResult<ReconcileReport> {
        Self::critical(&self.lock_file, &self.in_process, || {
            Self::ensure_journal_consistent(&mut self.store, self.witness.as_ref())?;
            let mut rep = ReconcileReport::default();
            let now_s = (now / 1000).max(0) as u64;
            let ttl_s = (TOOL_GRANT_TTL_MS / 1000 + TOOL_GRANT_SKEW_MS / 1000) as u64;
            let unstarted = self
                .store
                .tool_requests_in_state(PHASE_AUTHORIZED, &[PHASE_STARTED, PHASE_EXPIRED])?;
            let unstarted: Vec<_> = unstarted;
            for (rid, eid, task, attempt, cmd, at) in unstarted {
                let at_s: u64 = at
                    .split('.')
                    .next()
                    .and_then(|x| x.parse().ok())
                    .unwrap_or(0);
                if now_s.saturating_sub(at_s) >= ttl_s {
                    self.store.append_tool_entry(&ToolEntryInput {
                        request_id: rid,
                        execution_id: eid,
                        task_instance_id: task,
                        attempt_id: attempt,
                        command_id: cmd,
                        phase: PHASE_EXPIRED.to_owned(),
                        payload: serde_json::json!({"reason": "grant lapsed before execution started"}),
                    })?;
                    Self::checkpoint_tool_journal(&mut self.store, self.witness.as_mut())?;
                    rep.expired += 1;
                }
            }
            if include_started {
                let open = self.store.tool_requests_in_state(
                    PHASE_STARTED,
                    &[
                        PHASE_COMPLETED,
                        PHASE_INTERRUPTED,
                        PHASE_PLANNED,
                        PHASE_VERIFIED,
                        PHASE_FAILED,
                        PHASE_CONFLICT,
                        // Process lifecycle phases are reconciled by the
                        // process layer (it must kill leftovers first).
                        PHASE_PREPARED,
                        PHASE_RUNNING,
                        PHASE_EXITED,
                        PHASE_CANCELLED,
                    ],
                )?;
                for (rid, eid, task, attempt, cmd, _) in open {
                    self.store.append_tool_entry(&ToolEntryInput {
                        request_id: rid,
                        execution_id: eid,
                        task_instance_id: task,
                        attempt_id: attempt,
                        command_id: cmd,
                        phase: PHASE_INTERRUPTED.to_owned(),
                        payload: serde_json::json!({
                            "reason": "no completion recorded (crash or restart); outcome uncertain; never re-executed",
                        }),
                    })?;
                    Self::checkpoint_tool_journal(&mut self.store, self.witness.as_mut())?;
                    rep.interrupted += 1;
                }
            }
            Ok(rep)
        })
    }

    /// Paged records for one (task, attempt). The attempt must exist as an
    /// accepted command, otherwise the scope is refused (no cross-task
    /// probing). Cursor = last returned `seq`.
    pub fn tool_records_page(
        &self,
        task: &str,
        attempt: &str,
        after_seq: i64,
        limit: usize,
    ) -> KernelResult<Vec<ToolJournalEntry>> {
        if !self.store.attempt_exists(task, attempt)? {
            return Err(refuse(
                KernelErrorCode::IntentUnknown,
                "no such task attempt in this store",
            ));
        }
        self.store
            .list_tool_entries_page(task, attempt, after_seq.max(0), limit.clamp(1, 500))
    }

    fn verified_process_scope(
        store: &nexus_store::Store,
        key_hex: &str,
        command_id: &str,
    ) -> KernelResult<Option<ProcessScopeBinding>> {
        match store.fetch_process_scope(command_id)? {
            None => Ok(None),
            Some((json, seal)) => {
                let b: ProcessScopeBinding = serde_json::from_str(&json).map_err(|_| {
                    KernelError::new(KernelErrorCode::StoreCorrupt, "process scope unreadable")
                })?;
                if hmac_seal_hex(key_hex, &process_scope_canonical(&b))? != seal
                    || canonical_json(&serde_json::to_value(&b).unwrap_or_default()) != json
                {
                    return Err(KernelError::new(
                        KernelErrorCode::ForgedIssuer,
                        "process scope seal mismatch; store tampered",
                    ));
                }
                Ok(Some(b))
            }
        }
    }

    fn check_process_scope(
        store: &nexus_store::Store,
        key_hex: &str,
        req: &ToolAuthorizationRequest,
    ) -> KernelResult<ProcessScopeBinding> {
        let b =
            Self::verified_process_scope(store, key_hex, &req.command_id)?.ok_or_else(|| {
                refuse(
                    KernelErrorCode::ScopeRefused,
                    "no independent process scope for this command; execution refused",
                )
            })?;
        if b.task_instance_id != req.task_instance_id
            || b.attempt_id != req.attempt_id
            || b.lease_epoch != req.lease_epoch
            || b.store_incarnation != req.store_incarnation
            || b.root_digest != req.workspace_root_digest
        {
            return Err(refuse(
                KernelErrorCode::BindingMismatch,
                "process scope does not belong to this task/attempt/generation/workspace",
            ));
        }
        Ok(b)
    }

    /// Verified read of a command's process scope (seal checked).
    pub fn process_scope_binding(
        &mut self,
        command_id: &str,
    ) -> KernelResult<Option<ProcessScopeBinding>> {
        let key = self.store.issuance_key_hex()?;
        Self::verified_process_scope(&self.store, &key, command_id)
    }

    /// Publish the independent process scope (approver channel only; the
    /// daemon verified the approver credential beforehand).
    pub fn bind_process_scope(
        &mut self,
        command_id: &str,
        approver_id: &str,
        independent: bool,
        approved_root_digest: &str,
        max_wall_ms: u64,
    ) -> KernelResult<ProcessScopeBinding> {
        Self::critical(&self.lock_file, &self.in_process, || {
            Self::bind_process_scope_inner(
                &mut self.store,
                self.witness.as_ref(),
                command_id,
                approver_id,
                independent,
                approved_root_digest,
                max_wall_ms,
            )
        })
    }

    pub(crate) fn bind_process_scope_inner(
        store: &mut nexus_store::Store,
        witness: Option<&nexus_store::WitnessStore>,
        command_id: &str,
        approver_id: &str,
        independent: bool,
        approved_root_digest: &str,
        max_wall_ms: u64,
    ) -> KernelResult<ProcessScopeBinding> {
        {
            let receipt = store.read_receipt(command_id)?.ok_or_else(|| {
                refuse(
                    KernelErrorCode::DeliveryInvalid,
                    "no accepted receipt for this command; process scope refused",
                )
            })?;
            Self::require_tool_authority(
                store,
                witness,
                command_id,
                &receipt.task_instance_id,
                &receipt.attempt_id,
                receipt.lease_epoch,
                &receipt.store_incarnation,
            )?;
            let key_hex = store.issuance_key_hex()?;
            let read_binding =
                Self::verified_binding(store, &key_hex, command_id)?.ok_or_else(|| {
                    refuse(
                        KernelErrorCode::DeliveryInvalid,
                        "no workspace binding; bind the read workspace first",
                    )
                })?;
            if read_binding.root_digest != approved_root_digest {
                return Err(refuse(
                    KernelErrorCode::BindingMismatch,
                    "the approver authorized a different workspace than the bound one",
                ));
            }
            if max_wall_ms == 0 {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "maxWallMs must be positive",
                ));
            }
            let b = ProcessScopeBinding {
                command_id: command_id.to_owned(),
                task_instance_id: receipt.task_instance_id.clone(),
                attempt_id: receipt.attempt_id.clone(),
                lease_epoch: receipt.lease_epoch,
                store_incarnation: receipt.store_incarnation.clone(),
                root_digest: read_binding.root_digest.clone(),
                max_wall_ms,
                approver_id: approver_id.chars().take(64).collect(),
                independent,
            };
            let seal = hmac_seal_hex(&key_hex, &process_scope_canonical(&b))?;
            let json = canonical_json(&serde_json::to_value(&b).map_err(|_| {
                KernelError::new(KernelErrorCode::StoreError, "scope not serializable")
            })?);
            store.insert_process_scope(command_id, &json, &seal)?;
            Ok(b)
        }
    }

    /// Append one process-lifecycle phase for a verified process grant,
    /// enforcing the state machine, then checkpoint.
    pub fn record_process_phase(
        &mut self,
        verified: &VerifiedToolGrant,
        phase: &str,
        payload: serde_json::Value,
    ) -> KernelResult<ToolJournalEntry> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let g = &verified.grant;
            if g.scope != "process" {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "only process grants can record process phases",
                ));
            }
            let has = |st: &nexus_store::Store, p: &str| st.tool_phase_recorded(&g.request_id, p);
            for t in PROCESS_TERMINALS {
                if has(&self.store, t)? {
                    return Err(refuse(
                        KernelErrorCode::CommandConflict,
                        "process request is already terminal",
                    ));
                }
            }
            let ok = match phase {
                PHASE_PREPARED => has(&self.store, PHASE_STARTED)?,
                PHASE_RUNNING => has(&self.store, PHASE_PREPARED)?,
                PHASE_EXITED => has(&self.store, PHASE_RUNNING)?,
                PHASE_FAILED | PHASE_CANCELLED => has(&self.store, PHASE_STARTED)?,
                _ => false,
            };
            if !ok {
                return Err(refuse(
                    KernelErrorCode::CommandConflict,
                    "process phase is not valid in the request's current state",
                ));
            }
            Self::ensure_journal_consistent(&mut self.store, self.witness.as_ref())?;
            let entry = self.store.append_tool_entry(&ToolEntryInput {
                request_id: g.request_id.clone(),
                execution_id: g.execution_id.clone(),
                task_instance_id: g.task_instance_id.clone(),
                attempt_id: g.attempt_id.clone(),
                command_id: g.command_id.clone(),
                phase: phase.to_owned(),
                payload,
            })?;
            Self::checkpoint_tool_journal(&mut self.store, self.witness.as_mut())?;
            Ok(entry)
        })
    }

    fn collect_open_processes(store: &nexus_store::Store) -> KernelResult<Vec<OpenProcess>> {
        let open = store.tool_requests_in_state(
            PHASE_PREPARED,
            &[
                PHASE_EXITED,
                PHASE_FAILED,
                PHASE_CANCELLED,
                PHASE_INTERRUPTED,
                PHASE_PLANNED,
                PHASE_VERIFIED,
                PHASE_CONFLICT,
                PHASE_COMPLETED,
            ],
        )?;
        let mut out = Vec::new();
        for (rid, eid, task, attempt, cmd, _) in open {
            let entries = store.tool_entries_for_request(&rid)?;
            let find = |p: &str| entries.iter().find(|e| e.phase == p);
            out.push(OpenProcess {
                request_id: rid.clone(),
                execution_id: eid,
                task_instance_id: task,
                attempt_id: attempt,
                command_id: cmd,
                prepared: find(PHASE_PREPARED)
                    .map(|e| e.payload.clone())
                    .unwrap_or_default(),
                running: find(PHASE_RUNNING).map(|e| e.payload.clone()),
            });
        }
        Ok(out)
    }

    /// Read-only view of process requests awaiting reconciliation.
    pub fn open_processes(&self) -> KernelResult<Vec<OpenProcess>> {
        Self::collect_open_processes(&self.store)
    }

    /// Close every open process request as `interrupted`. `inspect` (the
    /// process layer) kills leftover cgroups and cleans staging, and
    /// returns the payload describing what it found. Never restarts.
    pub fn reconcile_open_processes(
        &mut self,
        inspect: &mut dyn FnMut(&OpenProcess) -> serde_json::Value,
    ) -> KernelResult<u64> {
        Self::critical(&self.lock_file, &self.in_process, || {
            Self::ensure_journal_consistent(&mut self.store, self.witness.as_ref())?;
            let mut n = 0;
            for op in Self::collect_open_processes(&self.store)? {
                let payload = inspect(&op);
                self.store.append_tool_entry(&ToolEntryInput {
                    request_id: op.request_id,
                    execution_id: op.execution_id,
                    task_instance_id: op.task_instance_id,
                    attempt_id: op.attempt_id,
                    command_id: op.command_id,
                    phase: PHASE_INTERRUPTED.to_owned(),
                    payload,
                })?;
                Self::checkpoint_tool_journal(&mut self.store, self.witness.as_mut())?;
                n += 1;
            }
            Ok(n)
        })
    }

    fn verified_write_scope(
        store: &nexus_store::Store,
        key_hex: &str,
        command_id: &str,
    ) -> KernelResult<Option<WriteScopeBinding>> {
        match store.fetch_write_scope(command_id)? {
            None => Ok(None),
            Some((json, seal)) => {
                let b: WriteScopeBinding = serde_json::from_str(&json).map_err(|_| {
                    KernelError::new(KernelErrorCode::StoreCorrupt, "write scope unreadable")
                })?;
                if hmac_seal_hex(key_hex, &write_scope_canonical(&b))? != seal
                    || canonical_json(&serde_json::to_value(&b).unwrap_or_default()) != json
                {
                    return Err(KernelError::new(
                        KernelErrorCode::ForgedIssuer,
                        "write scope seal mismatch; store tampered",
                    ));
                }
                Ok(Some(b))
            }
        }
    }

    fn check_write_scope(
        store: &nexus_store::Store,
        key_hex: &str,
        req: &ToolAuthorizationRequest,
    ) -> KernelResult<WriteScopeBinding> {
        let b = Self::verified_write_scope(store, key_hex, &req.command_id)?.ok_or_else(|| {
            refuse(
                KernelErrorCode::ScopeRefused,
                "no independent write scope for this command; mutation refused",
            )
        })?;
        if b.task_instance_id != req.task_instance_id
            || b.attempt_id != req.attempt_id
            || b.lease_epoch != req.lease_epoch
            || b.store_incarnation != req.store_incarnation
            || b.root_digest != req.workspace_root_digest
        {
            return Err(refuse(
                KernelErrorCode::BindingMismatch,
                "write scope does not belong to this task/attempt/generation/workspace",
            ));
        }
        Ok(b)
    }

    /// Verified read of a command's write scope (seal checked).
    pub fn write_scope_binding(
        &mut self,
        command_id: &str,
    ) -> KernelResult<Option<WriteScopeBinding>> {
        let key = self.store.issuance_key_hex()?;
        Self::verified_write_scope(&self.store, &key, command_id)
    }

    /// Publish the independent write scope. The caller (the daemon) must
    /// already have verified an approver credential that is distinct from
    /// the issuer capability; `independent` records whether the daemon
    /// could additionally prove the two credentials are held by disjoint
    /// OS identities. Requires: accepted command in its current lease, an
    /// existing read workspace binding for the same root, and an approver
    /// that explicitly named that root digest.
    pub fn bind_write_scope(
        &mut self,
        command_id: &str,
        approver_id: &str,
        independent: bool,
        approved_root_digest: &str,
        max_write_bytes: u64,
    ) -> KernelResult<WriteScopeBinding> {
        Self::critical(&self.lock_file, &self.in_process, || {
            Self::bind_write_scope_inner(
                &mut self.store,
                self.witness.as_ref(),
                command_id,
                approver_id,
                independent,
                approved_root_digest,
                max_write_bytes,
            )
        })
    }

    pub(crate) fn bind_write_scope_inner(
        store: &mut nexus_store::Store,
        witness: Option<&nexus_store::WitnessStore>,
        command_id: &str,
        approver_id: &str,
        independent: bool,
        approved_root_digest: &str,
        max_write_bytes: u64,
    ) -> KernelResult<WriteScopeBinding> {
        {
            let receipt = store.read_receipt(command_id)?.ok_or_else(|| {
                refuse(
                    KernelErrorCode::DeliveryInvalid,
                    "no accepted receipt for this command; write scope refused",
                )
            })?;
            Self::require_tool_authority(
                store,
                witness,
                command_id,
                &receipt.task_instance_id,
                &receipt.attempt_id,
                receipt.lease_epoch,
                &receipt.store_incarnation,
            )?;
            let key_hex = store.issuance_key_hex()?;
            let read_binding =
                Self::verified_binding(store, &key_hex, command_id)?.ok_or_else(|| {
                    refuse(
                        KernelErrorCode::DeliveryInvalid,
                        "no workspace binding; bind the read workspace first",
                    )
                })?;
            if read_binding.root_digest != approved_root_digest {
                return Err(refuse(
                    KernelErrorCode::BindingMismatch,
                    "the approver authorized a different workspace than the bound one",
                ));
            }
            if max_write_bytes == 0 {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "maxWriteBytes must be positive",
                ));
            }
            let b = WriteScopeBinding {
                command_id: command_id.to_owned(),
                task_instance_id: receipt.task_instance_id.clone(),
                attempt_id: receipt.attempt_id.clone(),
                lease_epoch: receipt.lease_epoch,
                store_incarnation: receipt.store_incarnation.clone(),
                root_digest: read_binding.root_digest.clone(),
                max_write_bytes,
                approver_id: approver_id.chars().take(64).collect(),
                independent,
            };
            let seal = hmac_seal_hex(&key_hex, &write_scope_canonical(&b))?;
            let json = canonical_json(&serde_json::to_value(&b).map_err(|_| {
                KernelError::new(KernelErrorCode::StoreError, "scope not serializable")
            })?);
            store.insert_write_scope(command_id, &json, &seal)?;
            Ok(b)
        }
    }

    /// Append one write-lifecycle phase for a verified write grant,
    /// enforcing the state machine, then checkpoint. Each phase is
    /// journaled exactly once; the record is durable (SQLite
    /// `synchronous=FULL`) before this returns.
    pub fn record_write_phase(
        &mut self,
        verified: &VerifiedToolGrant,
        phase: &str,
        payload: serde_json::Value,
    ) -> KernelResult<ToolJournalEntry> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let g = &verified.grant;
            if g.scope != "write" {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "read grants cannot record write phases",
                ));
            }
            let has = |st: &nexus_store::Store, p: &str| st.tool_phase_recorded(&g.request_id, p);
            for t in WRITE_TERMINALS {
                if has(&self.store, t)? {
                    return Err(refuse(
                        KernelErrorCode::CommandConflict,
                        "write request is already terminal",
                    ));
                }
            }
            let ok = match phase {
                PHASE_PLANNED => has(&self.store, PHASE_STARTED)?,
                PHASE_PREPARED => has(&self.store, PHASE_PLANNED)?,
                PHASE_APPLIED => has(&self.store, PHASE_PREPARED)?,
                PHASE_VERIFIED => has(&self.store, PHASE_APPLIED)?,
                PHASE_FAILED | PHASE_CONFLICT => has(&self.store, PHASE_STARTED)?,
                _ => false,
            };
            if !ok {
                return Err(refuse(
                    KernelErrorCode::CommandConflict,
                    "write phase is not valid in the request's current state",
                ));
            }
            Self::ensure_journal_consistent(&mut self.store, self.witness.as_ref())?;
            let entry = self.store.append_tool_entry(&ToolEntryInput {
                request_id: g.request_id.clone(),
                execution_id: g.execution_id.clone(),
                task_instance_id: g.task_instance_id.clone(),
                attempt_id: g.attempt_id.clone(),
                command_id: g.command_id.clone(),
                phase: phase.to_owned(),
                payload,
            })?;
            Self::checkpoint_tool_journal(&mut self.store, self.witness.as_mut())?;
            Ok(entry)
        })
    }

    /// Reconcile write requests that have `planned` but no terminal
    /// record. `inspect` (supplied by the filesystem layer) observes the
    /// target and returns the `interrupted` payload. Never replays a write
    /// and never invents `applied`/`verified`.
    pub fn reconcile_open_writes(
        &mut self,
        inspect: &mut dyn FnMut(&OpenWrite) -> serde_json::Value,
    ) -> KernelResult<u64> {
        Self::critical(&self.lock_file, &self.in_process, || {
            Self::ensure_journal_consistent(&mut self.store, self.witness.as_ref())?;
            let mut n = 0;
            for ow in Self::collect_open_writes(&self.store)? {
                let payload = inspect(&ow);
                self.store.append_tool_entry(&ToolEntryInput {
                    request_id: ow.request_id,
                    execution_id: ow.execution_id,
                    task_instance_id: ow.task_instance_id,
                    attempt_id: ow.attempt_id,
                    command_id: ow.command_id,
                    phase: PHASE_INTERRUPTED.to_owned(),
                    payload,
                })?;
                Self::checkpoint_tool_journal(&mut self.store, self.witness.as_mut())?;
                n += 1;
            }
            Ok(n)
        })
    }

    fn collect_open_writes(store: &nexus_store::Store) -> KernelResult<Vec<OpenWrite>> {
        let open = store.tool_requests_in_state(
            PHASE_PLANNED,
            &[
                PHASE_VERIFIED,
                PHASE_FAILED,
                PHASE_CONFLICT,
                PHASE_INTERRUPTED,
                PHASE_COMPLETED,
            ],
        )?;
        let mut out = Vec::new();
        for (rid, eid, task, attempt, cmd, _) in open {
            let entries = store.tool_entries_for_request(&rid)?;
            let find = |p: &str| entries.iter().find(|e| e.phase == p);
            out.push(OpenWrite {
                request_id: rid.clone(),
                execution_id: eid,
                task_instance_id: task,
                attempt_id: attempt,
                command_id: cmd,
                planned: find(PHASE_PLANNED)
                    .map(|e| e.payload.clone())
                    .unwrap_or_default(),
                prepared: find(PHASE_PREPARED).map(|e| e.payload.clone()),
                applied: find(PHASE_APPLIED).is_some(),
            });
        }
        Ok(out)
    }

    /// Read-only view of write requests awaiting reconciliation.
    pub fn open_writes(&self) -> KernelResult<Vec<OpenWrite>> {
        Self::collect_open_writes(&self.store)
    }

    /// Record the journal tail in the independent witness store (a separate
    /// SQLite file). Called after every append. A crash between the append
    /// and this call leaves the store at most one entry *ahead* of the
    /// checkpoint, which verification tolerates; the store being *behind*
    /// the checkpoint is truncation and is refused.
    fn checkpoint_tool_journal(
        store: &mut nexus_store::Store,
        witness: Option<&mut nexus_store::WitnessStore>,
    ) -> KernelResult<()> {
        let (count, tail) = store.tool_journal_tail()?;
        let seal = store.tool_checkpoint_seal(count, &tail)?;
        if let Some(w) = witness {
            let v = serde_json::json!({"count": count, "tail": tail, "seal": seal});
            w.set_meta(TOOL_CHECKPOINT_KEY, &canonical_json(&v))?;
        }
        Ok(())
    }

    pub fn list_tool_journal(&self, task: Option<&str>) -> KernelResult<Vec<ToolJournalEntry>> {
        self.store.list_tool_entries(task)
    }

    /// Verify chain + seals, then (when a witness is configured) compare
    /// against the witness checkpoint. Detects truncation back past the
    /// last checkpoint. Without a witness only the chain is checked and
    /// tail truncation is NOT detectable.
    pub fn verify_tool_journal(&mut self) -> KernelResult<u64> {
        let n = self.store.verify_tool_journal()?;
        Self::ensure_journal_consistent(&mut self.store, self.witness.as_ref())?;
        Ok(n)
    }
}
