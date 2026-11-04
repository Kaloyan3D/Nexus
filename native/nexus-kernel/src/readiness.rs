//! A2.0 read-only dispatch readiness assessment.
//!
//! Strictly observational: this module issues no authorization tokens,
//! enables no execution, and changes no durable state. Every mandatory
//! proof that is absent reports `NOT_READY`; the overall verdict is
//! `NOT_READY` for the whole A2.0 milestone because `dispatch_enabled()`
//! is false and `authorize_dispatch()` always refuses. A future A2.1
//! runtime must re-prove each dimension against its own trust root -- this
//! assessment never becomes an authorization.

use serde::{Deserialize, Serialize};

/// One evaluated readiness dimension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadinessDimension {
    pub name: String,
    pub ready: bool,
    pub detail: String,
}

/// Read-only readiness report. `ready` is always false in A2.0;
/// `verdict` is always `NOT_READY`. The struct carries no token and
/// confers no authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchReadiness {
    pub verdict: String,
    pub ready: bool,
    pub dispatch_enabled: bool,
    pub dimensions: Vec<ReadinessDimension>,
}

impl DispatchReadiness {
    pub fn not_ready(dimensions: Vec<ReadinessDimension>, dispatch_enabled: bool) -> Self {
        Self {
            verdict: "NOT_READY".to_owned(),
            ready: false,
            dispatch_enabled,
            dimensions,
        }
    }

    pub fn dimension_ready(&self, name: &str) -> Option<bool> {
        self.dimensions
            .iter()
            .find(|d| d.name == name)
            .map(|d| d.ready)
    }
}

fn dim(name: &str, ready: bool, detail: impl Into<String>) -> ReadinessDimension {
    ReadinessDimension {
        name: name.to_owned(),
        ready,
        detail: detail.into(),
    }
}

impl crate::Kernel {
    /// Read-only dispatch readiness assessment (A2.0 Gate 5).
    ///
    /// Evaluates each blocker dimension individually and always reports
    /// `NOT_READY`: dispatch is disabled for the milestone, so no combination
    /// of dimensions can authorize execution. Performs no mutation, issues
    /// no token, and must never be treated as an authorization.
    pub fn dispatch_readiness(&self, command_id: Option<&str>) -> DispatchReadiness {
        let mut dims = Vec::new();
        // 1. Trusted issuer identity: the kernel verifies store-held HMAC
        // seals, never independently proven Registry origin. Channel-level
        // issuer authentication (if any) lives in the daemon transport, and
        // same-UID peers can steal a file capability -- so at the kernel
        // layer this proof is always absent in A2.0.
        dims.push(dim(
            "trusted-issuer-identity",
            false,
            "kernel verifies store-held seals only; no independently proven Registry origin at this layer (same-UID capability theft is unprevented)",
        ));
        // 2. Controller durable authority: the kernel holds no durable
        // Controller ledger; intent arrives presented, not published.
        dims.push(dim(
            "controller-durable-authority",
            false,
            "no durable Controller intent publication exists yet; intent is presented per-request, not published before execution (A2.1 design item)",
        ));
        // 3. Valid pinned target: per-command when selected, else absent.
        match command_id {
            Some(cid) => match self.read_receipt(cid) {
                Ok(Some(r)) => dims.push(dim(
                    "pinned-target",
                    true,
                    format!(
                        "receipt pins target {} snapshot {} issuance {}",
                        r.target_digest, r.snapshot_digest, r.issuance_id
                    ),
                )),
                Ok(None) => dims.push(dim(
                    "pinned-target",
                    false,
                    "no receipt pins this commandId yet",
                )),
                Err(e) => dims.push(dim("pinned-target", false, e.message.clone())),
            },
            None => dims.push(dim(
                "pinned-target",
                false,
                "no command selected; per-command pin is unevaluated",
            )),
        }
        // 4. Current generation lease: evaluable only with a command.
        match command_id {
            Some(cid) => match self.read_receipt(cid) {
                Ok(Some(r)) => match self.store_current_generation(&r.task_instance_id, "native") {
                    Ok(Some(cur)) if cur.0 == r.lease_epoch => dims.push(dim(
                        "generation-lease",
                        true,
                        format!("receipt lease epoch {} is current", r.lease_epoch),
                    )),
                    Ok(Some(cur)) => dims.push(dim(
                        "generation-lease",
                        false,
                        format!(
                            "receipt lease epoch {} is superseded by generation epoch {}",
                            r.lease_epoch, cur.0
                        ),
                    )),
                    Ok(None) => dims.push(dim("generation-lease", false, "generation is unknown")),
                    Err(e) => dims.push(dim("generation-lease", false, e.message.clone())),
                },
                Ok(None) => dims.push(dim(
                    "generation-lease",
                    false,
                    "no receipt pins this commandId yet",
                )),
                Err(e) => dims.push(dim("generation-lease", false, e.message.clone())),
            },
            None => dims.push(dim(
                "generation-lease",
                false,
                "no command selected; lease currency is unevaluated",
            )),
        }
        // 5. Independent witness health.
        match self.witness_health() {
            Ok(ok) if ok => dims.push(dim(
                "witness-health",
                true,
                "independent witness is configured, present and readable",
            )),
            Ok(_) => dims.push(dim(
                "witness-health",
                false,
                "witness is not configured; rollback protection has no independent failure domain",
            )),
            Err(e) => dims.push(dim("witness-health", false, e.message.clone())),
        }
        // 6. Crash-safe dispatch reservation.
        match command_id {
            Some(cid) => match self.read_reservation(cid) {
                Ok(Some(res)) if res.state == nexus_store::ReservationState::Acknowledged => {
                    dims.push(dim(
                        "dispatch-reservation",
                        true,
                        format!(
                            "reservation for {} is acknowledged (epoch {}, digest {})",
                            cid, res.lease_epoch, res.command_digest
                        ),
                    ))
                }
                Ok(Some(res)) => dims.push(dim(
                    "dispatch-reservation",
                    false,
                    format!(
                        "reservation for {} is {} (not acknowledged); outcome unknown until acknowledged",
                        cid,
                        res.state.as_str()
                    ),
                )),
                Ok(None) => dims.push(dim(
                    "dispatch-reservation",
                    false,
                    "no witness reservation exists for this command",
                )),
                Err(e) => dims.push(dim("dispatch-reservation", false, e.message.clone())),
            },
            None => dims.push(dim(
                "dispatch-reservation",
                false,
                "no command selected; reservation state is unevaluated",
            )),
        }
        // 7. Reconciliation state: unknown outcomes suspend, never dispatch.
        dims.push(dim(
            "reconciliation-state",
            true,
            "no reconciliation latch lives in the kernel; unknown outcomes surface as reconciliation-required errors, never as dispatch",
        ));
        // 8. Recovery attestation: auditable when present, never a guarantee.
        dims.push(dim(
            "recovery-attestation",
            false,
            "operator attestation is asserted, not independently verified; see recovery-audit for the durable decision trail (A2.1 needs an independent trust source)",
        ));
        // 9. Dispatch disabled: the hard A2.0 guard.
        let disabled = !Self::dispatch_enabled();
        dims.push(dim(
            "dispatch-disabled",
            disabled,
            if disabled {
                "dispatch_enabled()==false and authorize_dispatch() refuses; no execution path exists"
            } else {
                "UNEXPECTED: dispatch reports enabled"
            },
        ));
        DispatchReadiness::not_ready(dims, Self::dispatch_enabled())
    }

    /// Durable audit trail of recovery decisions (A2.0 Gate 4): every
    /// `recovery-fenced` journal event plus the witness baseline, read-only.
    pub fn recovery_audit(
        &self,
        task: &str,
        backend: &str,
    ) -> nexus_contracts::KernelResult<Vec<serde_json::Value>> {
        let events = self.list_events(task, backend)?;
        let mut out = Vec::new();
        for e in events {
            if e.kind == nexus_contracts::KernelEventKind::RecoveryFenced {
                out.push(serde_json::json!({
                    "seq": e.seq,
                    "generationKey": e.generation_key,
                    "baseline": e.payload,
                    "recordedAtUtc": e.recorded_at_utc,
                }));
            }
        }
        Ok(out)
    }
}
