//! Native model dispatch authorization (A2.3 Phase 3).
//!
//! Independently revalidates Controller authority, Registry issuance, lease
//! currency, witness health, and credential binding at the dispatch
//! boundary, before any network I/O.
//!
//! Scope discipline: A2.3 admits exactly mock-e2e (loopback mock provider).
//! Any other scope is refused with scope-refused. General production
//! dispatch stays disabled: dispatch_enabled() is false and
//! authorize_dispatch() still always refuses.
//!
//! An A2.2 structural attestation is NEVER production authorization here:
//! the grant additionally requires the kernel HMAC seals (V1 issuance, V2
//! extension, published intent), a live lease proof, and an accepted receipt.

use crate::{hmac_seal_hex, Kernel};
use nexus_contracts::{KernelError, KernelErrorCode, KernelResult, RegistryResolutionV1};

/// The only execution scope A2.3 authorizes: loopback mock provider.
pub const SCOPE_MOCK_E2E: &str = "mock-e2e";

/// Durable Controller execution intent bundle reference.
#[derive(Debug, Clone)]
pub struct PublishedIntent {
    /// Command identity (also the store key).
    pub command_id: String,
    /// Canonical bundle bytes as sealed.
    pub canonical_json: String,
}

/// Dispatch authorization request.
#[derive(Debug, Clone)]
pub struct NativeDispatchRequest {
    /// Accepted command identity.
    pub command_id: String,
    /// sha256 of the exact prepared request bytes to be sent.
    pub request_digest: String,
    /// Execution scope (must be mock-e2e in A2.3).
    pub scope: String,
    /// Prepared endpoint origin (must equal the sealed extension origin).
    pub endpoint_origin: String,
    /// Presented credential reference (must equal the sealed extension ref).
    pub credential_ref: String,
}

/// Successful authorization, consumed exactly once.
#[derive(Debug, Clone)]
pub struct NativeDispatchGrant {
    /// Authorized command.
    pub command_id: String,
    /// Authorized attempt.
    pub attempt_id: String,
    /// Authorized request bytes digest.
    pub request_digest: String,
    /// Authorized endpoint origin.
    pub endpoint_origin: String,
    /// Authorized scope.
    pub scope: String,
    /// Grant instant (UTC, audit only).
    pub granted_at_utc: String,
}

fn utc_now() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => [
            d.as_secs().to_string(),
            ".".to_owned(),
            format!("{:09}", d.subsec_nanos()),
            "Z".to_owned(),
        ]
        .concat(),
        Err(_) => "0.000000000Z".to_owned(),
    }
}

fn field_u64(bundle: &serde_json::Value, key: &str) -> KernelResult<u64> {
    bundle.get(key).and_then(|v| v.as_u64()).ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::DeliveryInvalid,
            ["intent field ", key, " is not a u64"].concat(),
        )
    })
}

fn field_str(bundle: &serde_json::Value, key: &str) -> KernelResult<String> {
    bundle
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            KernelError::new(
                KernelErrorCode::DeliveryInvalid,
                ["intent field ", key, " is missing"].concat(),
            )
        })
}

fn is_loopback_origin(origin: &str) -> bool {
    let after_scheme = match origin.split_once("://") {
        Some(pair) if pair.0 == "http" => pair.1,
        _ => return false,
    };
    let slash = after_scheme.find('/').unwrap_or(after_scheme.len());
    let hostport = after_scheme[..slash].to_owned();
    let colon = hostport.find(':').unwrap_or(hostport.len());
    let host = hostport[..colon].to_owned();
    let h = host
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    h == "localhost" || h == "127.0.0.1" || h == "::1" || h.starts_with("127.")
}

impl Kernel {
    /// Seal one Registry-issued V2 extension under its digest identity,
    /// using the issuance key (same trust root as V1 seals). The extension
    /// must be a JSON object; its canonical digest becomes the seal id.
    /// Re-sealing identical bytes is idempotent.
    pub fn seal_extension(&mut self, extension: &serde_json::Value) -> KernelResult<String> {
        Self::critical(&self.lock_file, &self.in_process, || {
            if !extension.is_object() {
                return Err(KernelError::new(
                    KernelErrorCode::DeliveryInvalid,
                    "extension must be a JSON object",
                ));
            }
            let canonical = nexus_contracts::canonical_json(extension);
            let digest = nexus_contracts::sha256_hex(&canonical);
            let key_hex = self.store.issuance_key_hex()?;
            let seal = hmac_seal_hex(&key_hex, &canonical)?;
            match self.store.seal_extension(&digest, &canonical, &seal)? {
                nexus_store::SealOutcome::Created | nexus_store::SealOutcome::Identical => {
                    Ok(digest)
                }
            }
        })
    }
    /// Publish one durable Controller execution intent through the
    /// authenticated channel. Referenced V1 issuance and V2 extension seals
    /// must pre-exist; bundle digests must agree with the sealed records;
    /// the lease must equal the current generation. Republishing
    /// byte-identical intent is idempotent.
    pub fn publish_intent(&mut self, bundle: &serde_json::Value) -> KernelResult<PublishedIntent> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let command_id = field_str(bundle, "commandId")?;
            let task_instance_id = field_str(bundle, "taskInstanceId")?;
            let lease_epoch = field_u64(bundle, "leaseEpoch")?;
            let store_incarnation = field_str(bundle, "storeIncarnation")?;
            let role = field_str(bundle, "role")?;
            let target_digest = field_str(bundle, "targetDigest")?;
            let snapshot_digest = field_str(bundle, "snapshotDigest")?;
            let issuance_id = field_str(bundle, "issuanceId")?;
            let extension_digest = field_str(bundle, "extensionDigest")?;
            let scope = field_str(bundle, "scope")?;
            field_str(bundle, "attemptId")?;
            field_str(bundle, "requestDigest")?;
            field_str(bundle, "sessionId")?;
            if scope != SCOPE_MOCK_E2E {
                return Err(KernelError::new(
                    KernelErrorCode::ScopeRefused,
                    "intent scope is not mock-e2e; publication refused",
                ));
            }
            let (issued_json, _seal) = self.store.fetch_sealed(&issuance_id)?.ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "no sealed issuance for this intent; seal first",
                )
            })?;
            let (ext_json, _ext_seal) =
                self.store
                    .fetch_extension(&extension_digest)?
                    .ok_or_else(|| {
                        KernelError::new(
                            KernelErrorCode::ForgedIssuer,
                            "no sealed target extension for this intent; seal first",
                        )
                    })?;
            let issued: RegistryResolutionV1 =
                serde_json::from_str(&issued_json).map_err(|_| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed issuance is not a resolution",
                    )
                })?;
            if issued.provenance.target_digest != target_digest
                || issued.provenance.registry_snapshot_digest != snapshot_digest
                || issued.provenance.issuance_id != issuance_id
                || issued.task_instance_id != task_instance_id
                || issued.role != role
            {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "intent digests disagree with the sealed issuance",
                ));
            }
            let ext_value: serde_json::Value = serde_json::from_str(&ext_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "sealed extension is not JSON",
                )
            })?;
            if nexus_contracts::digest_value(&ext_value) != extension_digest {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "sealed extension does not match its digest",
                ));
            }
            let ext_remote = ext_value
                .get("remoteModelIdConfirmed")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let ext_reasoning = ext_value
                .get("reasoningEffort")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let ext_conn = ext_value
                .get("connectionBinding")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if ext_remote != issued.target.remote_model_id
                || ext_reasoning != issued.target.reasoning
                || ext_conn != issued.target.connection_id
            {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "sealed extension disagrees with the sealed core identity",
                ));
            }
            match self.store.current_generation(&task_instance_id, "native")? {
                Some(g) if g.epoch == lease_epoch && g.incarnation == store_incarnation => {}
                _ => {
                    return Err(KernelError::new(
                        KernelErrorCode::StaleLease,
                        "intent lease is not the current generation",
                    ));
                }
            }
            let canonical = nexus_contracts::canonical_json(bundle);
            let key_hex = self.store.issuance_key_hex()?;
            let seal = hmac_seal_hex(&key_hex, &canonical)?;
            match self.store.publish_intent(&command_id, &canonical, &seal)? {
                nexus_store::SealOutcome::Created | nexus_store::SealOutcome::Identical => {
                    Ok(PublishedIntent {
                        command_id,
                        canonical_json: canonical,
                    })
                }
            }
        })
    }

    /// Terminally fence one published intent (Controller cancellation).
    pub fn fence_intent(&mut self, command_id: &str) -> KernelResult<()> {
        Self::critical(&self.lock_file, &self.in_process, || {
            self.store.fence_intent(command_id)
        })
    }
    /// Authorize exactly one native model dispatch after revalidating the
    /// nine dispatch-boundary proofs. Consumes the intent atomically, so a
    /// second authorization for the same command is refused.
    pub fn authorize_native_dispatch(
        &mut self,
        req: &NativeDispatchRequest,
    ) -> KernelResult<NativeDispatchGrant> {
        Self::critical(&self.lock_file, &self.in_process, || {
            if req.scope != SCOPE_MOCK_E2E {
                return Err(KernelError::new(
                    KernelErrorCode::ScopeRefused,
                    "only the mock-e2e scope is authorized; live dispatch refused",
                ));
            }
            let (stored_json, stored_seal, state) =
                self.store.fetch_intent(&req.command_id)?.ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::IntentUnknown,
                        "no published intent for this command identity",
                    )
                })?;
            match state.as_str() {
                "published" => {}
                "cancelled" => {
                    return Err(KernelError::new(
                        KernelErrorCode::IntentFenced,
                        "intent was fenced; dispatch refused",
                    ));
                }
                "executed" => {
                    return Err(KernelError::new(
                        KernelErrorCode::CommandConflict,
                        "intent already executed; duplicate dispatch refused",
                    ));
                }
                _ => {
                    return Err(KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "intent carries an unknown lifecycle state",
                    ));
                }
            }
            let key_hex = self.store.issuance_key_hex()?;
            let expect_seal = hmac_seal_hex(&key_hex, &stored_json)?;
            if expect_seal != stored_seal {
                return Err(KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "published intent seal mismatch; store tampered",
                ));
            }
            let bundle: serde_json::Value = serde_json::from_str(&stored_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "published intent is not JSON",
                )
            })?;
            if field_str(&bundle, "commandId")? != req.command_id {
                return Err(KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "published intent identity drifted",
                ));
            }
            if field_str(&bundle, "requestDigest")? != req.request_digest {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "request bytes differ from the published intent",
                ));
            }
            if field_str(&bundle, "scope")? != req.scope {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "request scope differs from the published intent",
                ));
            }
            let extension_digest = field_str(&bundle, "extensionDigest")?;
            let (ext_json, _ext_seal) =
                self.store
                    .fetch_extension(&extension_digest)?
                    .ok_or_else(|| {
                        KernelError::new(
                            KernelErrorCode::ForgedIssuer,
                            "sealed extension lost after publication",
                        )
                    })?;
            let ext_value: serde_json::Value = serde_json::from_str(&ext_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "sealed extension is not JSON",
                )
            })?;
            let origin = ext_value
                .get("endpoint")
                .and_then(|e| e.get("origin"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed extension lacks an endpoint origin",
                    )
                })?;
            if origin != req.endpoint_origin {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "prepared endpoint differs from the sealed extension",
                ));
            }
            if !is_loopback_origin(origin) {
                return Err(KernelError::new(
                    KernelErrorCode::ScopeRefused,
                    "mock scope requires a loopback-local endpoint",
                ));
            }
            let cred = ext_value
                .get("credentialRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed extension lacks a credential reference",
                    )
                })?;
            if cred != req.credential_ref {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "credential reference differs from the sealed extension",
                ));
            }
            let receipt = self.store.read_receipt(&req.command_id)?.ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::DeliveryInvalid,
                    "no accepted receipt for this command",
                )
            })?;
            if receipt.target_digest != field_str(&bundle, "targetDigest")?
                || receipt.snapshot_digest != field_str(&bundle, "snapshotDigest")?
                || receipt.issuance_id != field_str(&bundle, "issuanceId")?
                || receipt.lease_epoch != field_u64(&bundle, "leaseEpoch")?
                || receipt.task_instance_id != field_str(&bundle, "taskInstanceId")?
                || receipt.attempt_id != field_str(&bundle, "attemptId")?
            {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "accepted receipt disagrees with the published intent",
                ));
            }
            let task_id = receipt.task_instance_id.clone();
            let current = self.store.current_generation(&task_id, "native")?;
            let (epoch_now, incarnation_now, protected_now) = match current {
                Some(g) => (g.epoch, g.incarnation, g.witness_protected),
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::StaleLease,
                        "generation vanished after acceptance",
                    ));
                }
            };
            if epoch_now != receipt.lease_epoch || incarnation_now != receipt.store_incarnation {
                return Err(KernelError::new(
                    KernelErrorCode::StaleLease,
                    "generation advanced after acceptance; re-acquire first",
                ));
            }
            match self.witness.as_ref() {
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::WitnessRequired,
                        "dispatch needs the independent witness; configure it first",
                    ));
                }
                Some(w) => {
                    let gkey = nexus_contracts::generation_key(&task_id, "native");
                    match w.read(&gkey)? {
                        Some(rec) => {
                            if rec.max_epoch > epoch_now {
                                return Err(KernelError::new(
                                    KernelErrorCode::RollbackDetected,
                                    "store epoch is behind the witness maximum",
                                ));
                            }
                        }
                        None => {
                            if protected_now {
                                return Err(KernelError::new(
                                    KernelErrorCode::ReconciliationRequired,
                                    "witness record lost after protection was established",
                                ));
                            }
                        }
                    }
                }
            }
            self.store.mark_intent_executed(&req.command_id)?;
            Ok(NativeDispatchGrant {
                command_id: req.command_id.clone(),
                attempt_id: receipt.attempt_id.clone(),
                request_digest: req.request_digest.clone(),
                endpoint_origin: origin.to_owned(),
                scope: req.scope.clone(),
                granted_at_utc: utc_now(),
            })
        })
    }
}
