//! A4.2 human-approval authority.
//!
//! An approval is an immutable, sealed `ApprovalRequestV1` created from an
//! issuer submission but validated against authoritative Kernel state
//! (accepted receipt, current lease, workspace binding). It is decided
//! exactly once by the independent approver channel, and consumed exactly
//! once by the single tool execution whose args/budget/workspace digests it
//! names. States: `pending -> approved | denied | expired | revoked`, and
//! `approved -> consumed | expired | revoked`. Terminal states never
//! transition again; there is no auto-approval path.

use crate::tools::{now_ms, random_hex, refuse};
use crate::Kernel;
use nexus_contracts::{canonical_json, sha256_hex, KernelError, KernelErrorCode, KernelResult};
use nexus_store::{ApprovalRow, ApprovalUpdate};

pub const APPROVAL_DOMAIN: &str = "nexus-approval-request/v1";
pub const APPROVAL_TTL_DEFAULT_MS: i64 = 300_000;
pub const APPROVAL_TTL_MAX_MS: i64 = 600_000;

pub const APPROVAL_STATES: [&str; 6] = [
    "pending", "approved", "denied", "expired", "revoked", "consumed",
];

/// What the daemon derived (not the model/renderer) about one proposed op.
#[derive(Debug, Clone)]
pub struct ApprovalSubmission {
    pub command_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub tool_id: String,
    pub tool_version: u32,
    pub scope: String,
    pub args_digest: String,
    pub budget_digest: String,
    pub workspace_root_digest: String,
    /// Exact affected paths (writes) or `[]` for processes.
    pub paths: Vec<String>,
    /// Structured operation description (pre/post-image, argv, sandbox...).
    pub operation: serde_json::Value,
    /// `{kind, digest, text?, reason?}`: authoritative preview.
    pub preview: serde_json::Value,
    pub limits: serde_json::Value,
    pub ttl_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ApprovalDecision {
    pub approve: bool,
    pub request_digest: String,
    pub review_code: String,
    pub approver_id: String,
    pub independent: bool,
    pub reason: String,
    /// Verified-by-daemon facts about how consent was obtained.
    pub human_auth: serde_json::Value,
    /// Coarse scope ceiling bound on first approval for the command.
    pub scope_cap: u64,
}

fn conflict(msg: &str) -> KernelError {
    refuse(KernelErrorCode::CommandConflict, msg)
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

pub const POLICY_TEST_ONLY: &str = "human-required:test-only";
pub const POLICY_INDEPENDENT: &str = "human-required:independent";

fn policy_rank(p: Option<&str>) -> u8 {
    match p {
        Some(POLICY_INDEPENDENT) => 2,
        Some(POLICY_TEST_ONLY) => 1,
        Some(_) => 3, // unknown value: treat as strictest, never lower it
        None => 0,
    }
}

impl Kernel {
    /// Persistent no-downgrade latch. A store that has ever run with human
    /// approval can only be started at the same or a stricter level. The
    /// only way back to legacy A3.3 behaviour is a fresh DataRoot (which
    /// carries no pending or approved requests). Returns the effective
    /// stored level after raising it to `requested`.
    pub fn enforce_approval_policy(
        &mut self,
        requested: Option<&str>,
    ) -> KernelResult<Option<String>> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let cur = self.store.approval_policy_get()?;
            if policy_rank(requested) < policy_rank(cur.as_deref()) {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "approval-downgrade-refused: this store requires human approval; \
                     legacy or test-only approval cannot be restored on it",
                ));
            }
            if let Some(r) = requested {
                if cur.as_deref() != Some(r) {
                    self.store.approval_policy_set(r)?;
                    return Ok(Some(r.to_owned()));
                }
            }
            Ok(cur)
        })
    }

    fn expire_due(store: &mut nexus_store::Store, now: i64) -> KernelResult<()> {
        let open = store.approvals_in_states(&["pending", "approved"])?;
        for r in open.into_iter().filter(|r| r.expires_ms <= now) {
            store.approval_transition(
                &r.approval_id,
                &["pending", "approved"],
                "expired",
                &ApprovalUpdate::default(),
                "expired",
                &serde_json::json!({ "reason": "ttl", "expiresMs": r.expires_ms }),
                now,
            )?;
        }
        Ok(())
    }

    /// Re-check live authority for an open approval; on failure the
    /// approval is revoked (never left usable) and the refusal returned.
    fn approval_authority(
        store: &mut nexus_store::Store,
        witness: Option<&nexus_store::WitnessStore>,
        r: &ApprovalRow,
        now: i64,
    ) -> KernelResult<()> {
        let res = Self::require_tool_authority(
            store,
            witness,
            &r.command_id,
            &r.task_instance_id,
            &r.attempt_id,
            r.lease_epoch,
            &r.store_incarnation,
        );
        if let Err(e) = &res {
            store.approval_transition(
                &r.approval_id,
                &["pending", "approved"],
                "revoked",
                &ApprovalUpdate::default(),
                "revoked",
                &serde_json::json!({ "reason": "authority-lost", "code": e.code.as_str() }),
                now,
            )?;
        }
        res
    }

    /// Create a pending approval. Authority, receipt and workspace binding
    /// are re-derived here; the submission only describes the operation.
    pub fn create_approval(&mut self, sub: &ApprovalSubmission) -> KernelResult<ApprovalRow> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let now = now_ms();
            Self::expire_due(&mut self.store, now)?;
            if sub.paths.is_empty() && sub.scope == "write" {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "write approvals require an explicit path allowlist; workspace-wide approval is never inferred",
                ));
            }
            if sub
                .paths
                .iter()
                .any(|p| p.is_empty() || p == "." || p == "/")
            {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "approval paths must name specific files",
                ));
            }
            let receipt = self.store.read_receipt(&sub.command_id)?.ok_or_else(|| {
                refuse(
                    KernelErrorCode::DeliveryInvalid,
                    "no accepted receipt for this command; approval refused",
                )
            })?;
            Self::require_tool_authority(
                &self.store,
                self.witness.as_ref(),
                &sub.command_id,
                &sub.task_instance_id,
                &sub.attempt_id,
                sub.lease_epoch,
                &sub.store_incarnation,
            )?;
            let key = self.store.issuance_key_hex()?;
            let binding =
                Self::verified_binding(&self.store, &key, &sub.command_id)?.ok_or_else(|| {
                    refuse(
                        KernelErrorCode::DeliveryInvalid,
                        "no workspace binding; approval refused",
                    )
                })?;
            if binding.root_digest != sub.workspace_root_digest {
                return Err(refuse(
                    KernelErrorCode::BindingMismatch,
                    "approval workspace differs from the Controller-bound workspace",
                ));
            }
            let intent_digest = match self.store.fetch_intent(&sub.command_id)? {
                Some((json, _, _)) => sha256_hex(&json),
                None => String::new(),
            };
            let dup = self
                .store
                .approvals_for_command(&sub.command_id, &["pending", "approved"])?
                .into_iter()
                .any(|r| {
                    serde_json::from_str::<serde_json::Value>(&r.request_json)
                        .ok()
                        .map(|v| {
                            v.get("argsDigest").and_then(|x| x.as_str()) == Some(&sub.args_digest)
                                && v.get("budgetDigest").and_then(|x| x.as_str())
                                    == Some(&sub.budget_digest)
                        })
                        .unwrap_or(false)
                });
            if dup {
                return Err(conflict(
                    "an open approval already exists for this exact operation; duplicate refused",
                ));
            }
            let ttl = sub.ttl_ms.clamp(1_000, APPROVAL_TTL_MAX_MS);
            let approval_id = random_hex(16)?;
            let created = now;
            let expires = created.saturating_add(ttl);
            let request = serde_json::json!({
                "schemaVersion": 1,
                "domain": APPROVAL_DOMAIN,
                "approvalId": approval_id,
                "commandId": sub.command_id,
                "commandDigest": receipt.command_digest,
                "controllerIntentDigest": intent_digest,
                "taskInstanceId": receipt.task_instance_id,
                "attemptId": receipt.attempt_id,
                "leaseEpoch": receipt.lease_epoch,
                "storeIncarnation": receipt.store_incarnation,
                "workspaceRootDigest": binding.root_digest,
                "toolId": sub.tool_id,
                "toolVersion": sub.tool_version,
                "scope": sub.scope,
                "argsDigest": sub.args_digest,
                "budgetDigest": sub.budget_digest,
                "paths": sub.paths,
                "operation": sub.operation,
                "limits": sub.limits,
                "preview": sub.preview,
                "createdMs": created,
                "expiresMs": expires,
            });
            let request_json = canonical_json(&request);
            let row = ApprovalRow {
                approval_id: approval_id.clone(),
                command_id: sub.command_id.clone(),
                task_instance_id: receipt.task_instance_id.clone(),
                attempt_id: receipt.attempt_id.clone(),
                lease_epoch: receipt.lease_epoch,
                store_incarnation: receipt.store_incarnation.clone(),
                tool_id: sub.tool_id.clone(),
                scope: sub.scope.clone(),
                request_digest: sha256_hex(&request_json),
                request_json,
                state: "pending".to_owned(),
                created_ms: created,
                expires_ms: expires,
                review_code: random_hex(4)?,
                reviewed_ms: None,
                decision_json: None,
                decided_ms: None,
                grant_request_id: None,
            };
            self.store.approval_insert(
                &row,
                &serde_json::json!({
                    "toolId": row.tool_id, "scope": row.scope,
                    "requestDigest": row.request_digest,
                    "workspaceRootDigest": sub.workspace_root_digest,
                    "taskInstanceId": row.task_instance_id,
                    "attemptId": row.attempt_id, "leaseEpoch": row.lease_epoch,
                }),
                now,
            )?;
            Ok(row)
        })
    }

    /// Visible, lazily-expired view of approvals (metadata only; callers
    /// decide what to project).
    pub fn list_approvals(
        &mut self,
        task: Option<&str>,
        limit: usize,
    ) -> KernelResult<Vec<ApprovalRow>> {
        Self::critical(&self.lock_file, &self.in_process, || {
            Self::expire_due(&mut self.store, now_ms())?;
            self.store.approval_list(task, limit.clamp(1, 500))
        })
    }

    pub fn approval_history(
        &mut self,
        id: &str,
    ) -> KernelResult<(Option<ApprovalRow>, Vec<nexus_store::ApprovalEvent>)> {
        Self::critical(&self.lock_file, &self.in_process, || {
            Self::expire_due(&mut self.store, now_ms())?;
            let row = self.store.approval_fetch(id)?;
            let ev = self.store.approval_events(id)?;
            Ok((row, ev))
        })
    }

    /// Approver-side review: returns the sealed row and records that this
    /// approver identity viewed the exact request (decisions require it).
    pub fn review_approval(&mut self, id: &str, approver_uid: u32) -> KernelResult<ApprovalRow> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let now = now_ms();
            Self::expire_due(&mut self.store, now)?;
            let row = self
                .store
                .approval_fetch(id)?
                .ok_or_else(|| refuse(KernelErrorCode::DeliveryInvalid, "unknown approval"))?;
            if row.state != "pending" {
                return Err(conflict(
                    "approval is not pending; it can no longer be decided",
                ));
            }
            Self::approval_authority(&mut self.store, self.witness.as_ref(), &row, now)?;
            self.store.approval_note(
                id,
                "reviewed",
                &serde_json::json!({ "approverUid": approver_uid, "requestDigest": row.request_digest }),
                now,
            )?;
            self.store.approval_transition(
                id,
                &["pending"],
                "pending",
                &ApprovalUpdate {
                    reviewed_ms: Some(now),
                    ..Default::default()
                },
                "review-armed",
                &serde_json::json!({}),
                now,
            )?;
            self.store
                .approval_fetch(id)?
                .ok_or_else(|| refuse(KernelErrorCode::StoreError, "approval vanished"))
        })
    }

    /// Final human decision. On approval the coarse per-command scope is
    /// bound (idempotent) so the existing Kernel scope checks still hold.
    pub fn decide_approval(&mut self, id: &str, d: &ApprovalDecision) -> KernelResult<ApprovalRow> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let now = now_ms();
            Self::expire_due(&mut self.store, now)?;
            let row = self
                .store
                .approval_fetch(id)?
                .ok_or_else(|| refuse(KernelErrorCode::DeliveryInvalid, "unknown approval"))?;
            if row.state != "pending" {
                return Err(conflict(
                    "approval is not pending (decided, expired or revoked); decisions are final",
                ));
            }
            if row.reviewed_ms.is_none() {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "approval was not reviewed through the approver channel; decision refused",
                ));
            }
            if !ct_eq(&row.request_digest, &d.request_digest) {
                return Err(refuse(
                    KernelErrorCode::BindingMismatch,
                    "decision names a different request digest than the pending approval",
                ));
            }
            if !ct_eq(&row.review_code, &d.review_code) {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "human review code mismatch; decision refused",
                ));
            }
            Self::approval_authority(&mut self.store, self.witness.as_ref(), &row, now)?;
            let decision = serde_json::json!({
                "decision": if d.approve { "approved" } else { "denied" },
                "reason": d.reason.chars().take(200).collect::<String>(),
                "approverId": d.approver_id,
                "independent": d.independent,
                "humanAuth": d.human_auth,
                "requestDigest": row.request_digest,
            });
            let upd = ApprovalUpdate {
                decision_json: Some(canonical_json(&decision)),
                decided_ms: Some(now),
                ..Default::default()
            };
            if d.approve {
                match row.scope.as_str() {
                    "write" => {
                        Self::bind_write_scope_inner(
                            &mut self.store,
                            self.witness.as_ref(),
                            &row.command_id,
                            &d.approver_id,
                            d.independent,
                            &Self::request_field(&row, "workspaceRootDigest"),
                            d.scope_cap,
                        )?;
                    }
                    "process" => {
                        Self::bind_process_scope_inner(
                            &mut self.store,
                            self.witness.as_ref(),
                            &row.command_id,
                            &d.approver_id,
                            d.independent,
                            &Self::request_field(&row, "workspaceRootDigest"),
                            d.scope_cap,
                        )?;
                    }
                    _ => {
                        return Err(refuse(KernelErrorCode::ScopeRefused, "unsupported scope"));
                    }
                }
            }
            let won = self.store.approval_transition(
                id,
                &["pending"],
                if d.approve { "approved" } else { "denied" },
                &upd,
                if d.approve { "approved" } else { "denied" },
                &decision,
                now,
            )?;
            if !won {
                return Err(conflict(
                    "approval was decided concurrently; decision is final",
                ));
            }
            self.store
                .approval_fetch(id)?
                .ok_or_else(|| refuse(KernelErrorCode::StoreError, "approval vanished"))
        })
    }

    fn request_field(row: &ApprovalRow, key: &str) -> String {
        serde_json::from_str::<serde_json::Value>(&row.request_json)
            .ok()
            .and_then(|v| v.get(key).and_then(|x| x.as_str()).map(str::to_owned))
            .unwrap_or_default()
    }

    /// Consume the single approved, unexpired approval that names exactly
    /// this operation. Called by the daemon immediately before minting the
    /// tool grant; success is the only way a human-approval-mode execution
    /// proceeds. Mismatch, expiry, revocation or reuse all refuse.
    #[allow(clippy::too_many_arguments)]
    pub fn consume_approval(
        &mut self,
        command_id: &str,
        task: &str,
        attempt: &str,
        lease_epoch: u64,
        incarnation: &str,
        tool_id: &str,
        args_digest: &str,
        budget_digest: &str,
        workspace_root_digest: &str,
        grant_request_id: &str,
        require_independent: bool,
    ) -> KernelResult<String> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let now = now_ms();
            Self::expire_due(&mut self.store, now)?;
            let all = self
                .store
                .approvals_for_command(command_id, &APPROVAL_STATES)?;
            let mut matched: Option<ApprovalRow> = None;
            for r in all.into_iter().filter(|r| r.state == "approved") {
                let v: serde_json::Value =
                    serde_json::from_str(&r.request_json).unwrap_or(serde_json::Value::Null);
                let f = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
                let independent = r
                    .decision_json
                    .as_deref()
                    .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                    .and_then(|d| d.get("independent").and_then(|x| x.as_bool()))
                    .unwrap_or(false);
                if (independent || !require_independent)
                    && r.task_instance_id == task
                    && r.attempt_id == attempt
                    && r.lease_epoch == lease_epoch
                    && r.store_incarnation == incarnation
                    && r.tool_id == tool_id
                    && f("argsDigest") == args_digest
                    && f("budgetDigest") == budget_digest
                    && f("workspaceRootDigest") == workspace_root_digest
                {
                    matched = Some(r);
                    break;
                }
            }
            let Some(r) = matched else {
                return Err(refuse(
                    KernelErrorCode::ScopeRefused,
                    "no approved human approval matches this exact operation; execution refused",
                ));
            };
            Self::approval_authority(&mut self.store, self.witness.as_ref(), &r, now)?;
            let won = self.store.approval_transition(
                &r.approval_id,
                &["approved"],
                "consumed",
                &ApprovalUpdate {
                    grant_request_id: Some(grant_request_id.to_owned()),
                    ..Default::default()
                },
                "consumed",
                &serde_json::json!({ "grantRequestId": grant_request_id, "toolId": tool_id }),
                now,
            )?;
            if !won {
                return Err(conflict("approval was already consumed; single-use"));
            }
            Ok(r.approval_id)
        })
    }

    /// Withdraw one open approval (issuer cancel / operator revoke).
    pub fn revoke_approval(&mut self, id: &str, reason: &str) -> KernelResult<bool> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let now = now_ms();
            self.store.approval_transition(
                id,
                &["pending", "approved"],
                "revoked",
                &ApprovalUpdate::default(),
                "revoked",
                &serde_json::json!({ "reason": reason.chars().take(120).collect::<String>() }),
                now,
            )
        })
    }

    pub(crate) fn revoke_open_approvals(
        store: &mut nexus_store::Store,
        command_id: &str,
        reason: &str,
    ) -> KernelResult<u64> {
        let now = now_ms();
        let mut n = 0;
        for r in store.approvals_for_command(command_id, &["pending", "approved"])? {
            if store.approval_transition(
                &r.approval_id,
                &["pending", "approved"],
                "revoked",
                &ApprovalUpdate::default(),
                "revoked",
                &serde_json::json!({ "reason": reason.chars().take(120).collect::<String>() }),
                now,
            )? {
                n += 1;
            }
        }
        Ok(n)
    }

    /// Startup recovery (single owner, no execution in flight). A restart
    /// never fabricates or preserves consent: approved-but-unconsumed
    /// approvals lapse, and pending ones must be reviewed again.
    pub fn recover_approvals(&mut self) -> KernelResult<(u64, u64)> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let now = now_ms();
            let (mut lapsed, mut rearmed) = (0u64, 0u64);
            for r in self.store.approvals_in_states(&["approved"])? {
                if self.store.approval_transition(
                    &r.approval_id,
                    &["approved"],
                    "expired",
                    &ApprovalUpdate::default(),
                    "recovered-expired",
                    &serde_json::json!({ "reason": "daemon-restart" }),
                    now,
                )? {
                    lapsed += 1;
                }
            }
            for r in self.store.approvals_in_states(&["pending"])? {
                if r.reviewed_ms.is_some()
                    && self.store.approval_transition(
                        &r.approval_id,
                        &["pending"],
                        "pending",
                        &ApprovalUpdate {
                            clear_reviewed: true,
                            ..Default::default()
                        },
                        "recovered-rearmed",
                        &serde_json::json!({ "reason": "daemon-restart; re-review required" }),
                        now,
                    )?
                {
                    rearmed += 1;
                }
            }
            Self::expire_due(&mut self.store, now)?;
            Ok((lapsed, rearmed))
        })
    }

    pub fn verify_approval_journal(&mut self) -> KernelResult<u64> {
        self.store.approval_verify_chain()
    }
}
