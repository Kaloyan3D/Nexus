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

fn now_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis().min(i64::MAX as u128) as i64,
        Err(_) => 0,
    }
}

fn random_hex(n: usize) -> KernelResult<String> {
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

fn refuse(code: KernelErrorCode, msg: &str) -> KernelError {
    KernelError::new(code, msg)
}

impl Kernel {
    /// Shared authority revalidation: accepted receipt, current lease,
    /// witness health, intent not fenced. Returns nothing; refuses closed.
    fn require_tool_authority(
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
            Self::require_tool_authority(
                &self.store,
                self.witness.as_ref(),
                &req.command_id,
                &req.task_instance_id,
                &req.attempt_id,
                req.lease_epoch,
                &req.store_incarnation,
            )?;
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
                    "toolVersion": g.tool_version,
                    "argsDigest": g.args_digest,
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
        let Some(w) = self.witness.as_ref() else {
            return Ok(n);
        };
        let Some(raw) = w.get_meta(TOOL_CHECKPOINT_KEY)? else {
            return Ok(n);
        };
        let corrupt = |m: &str| KernelError::new(KernelErrorCode::StoreCorrupt, m);
        let v: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| corrupt("tool journal checkpoint unreadable"))?;
        let count = v
            .get("count")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| corrupt("checkpoint count"))?;
        let tail = v
            .get("tail")
            .and_then(|x| x.as_str())
            .ok_or_else(|| corrupt("checkpoint tail"))?;
        let seal = v
            .get("seal")
            .and_then(|x| x.as_str())
            .ok_or_else(|| corrupt("checkpoint seal"))?;
        if self.store.tool_checkpoint_seal(count, tail)? != seal {
            return Err(corrupt("tool journal checkpoint seal mismatch"));
        }
        if n < count {
            return Err(corrupt(
                "tool journal is shorter than the witness checkpoint (tail truncation)",
            ));
        }
        // Entry number `count` (1-based) must carry the checkpointed hash.
        let entries = self.store.list_tool_entries(None)?;
        let at = if count == 0 {
            nexus_store::TOOL_JOURNAL_GENESIS.to_owned()
        } else {
            entries
                .get(count as usize - 1)
                .map(|e| e.entry_hash.clone())
                .unwrap_or_default()
        };
        if at != tail {
            return Err(corrupt(
                "tool journal diverges from the witness checkpoint (rewritten history)",
            ));
        }
        Ok(n)
    }
}
