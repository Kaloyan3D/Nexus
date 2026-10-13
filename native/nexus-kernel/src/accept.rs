//! Command acceptance, explicit recovery and deterministic reconstruction.

use crate::{hmac_seal_hex, Kernel};
use nexus_contracts::{
    generation_key, CommandReceiptV1, ControllerIntentV1, GenerationLeaseV1, KernelError,
    KernelErrorCode, KernelEventV1, KernelResult, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION,
};
use nexus_store::AcceptInput;

pub struct AcceptRequest {
    pub intent: ControllerIntentV1,
    pub issued: RegistryResolutionV1,
    pub snapshot: serde_json::Value,
}

pub struct GenerationState {
    pub task_instance_id: String,
    pub backend: String,
    pub epoch: u64,
    pub incarnation: String,
    pub receipts: Vec<CommandReceiptV1>,
    pub events: Vec<KernelEventV1>,
}

fn corrupt(msg: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StoreCorrupt, msg)
}

impl Kernel {
    pub fn accept_command(
        &mut self,
        req: &AcceptRequest,
    ) -> KernelResult<(CommandReceiptV1, bool)> {
        Kernel::critical(&self.lock_file, &self.in_process, || {
            let intent = &req.intent;
            let issued = &req.issued;
            if intent.schema_version != CONTRACT_SCHEMA_VERSION {
                return Err(KernelError::new(
                    KernelErrorCode::UnsupportedSchema,
                    "unsupported intent schemaVersion",
                ));
            }
            if issued.schema_version != CONTRACT_SCHEMA_VERSION {
                return Err(KernelError::new(
                    KernelErrorCode::UnsupportedSchema,
                    "unsupported resolution schemaVersion",
                ));
            }
            intent.verify_integrity()?;
            let issued_value = serde_json::to_value(issued).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::DeliveryInvalid,
                    "resolution is not JSON-representable",
                )
            })?;
            let issued_canonical = nexus_contracts::canonical_json(&issued_value);
            let key_hex = self.store.issuance_key_hex()?;
            let expected_seal = hmac_seal_hex(&key_hex, &issued_canonical)?;
            let computed_issuance = issued.issuance_id_of();
            if computed_issuance != issued.provenance.issuance_id {
                return Err(KernelError::new(
                    KernelErrorCode::DeliveryInvalid,
                    "issuanceId does not match issuance content",
                ));
            }
            match self.store.fetch_sealed(&computed_issuance)? {
                Some((stored_json, stored_seal)) => {
                    if stored_seal != expected_seal || stored_json != issued_canonical {
                        return Err(KernelError::new(
                            KernelErrorCode::ForgedIssuer,
                            "no verified sealed issuance for this target",
                        ));
                    }
                }
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::ForgedIssuer,
                        "no verified sealed issuance for this target",
                    ));
                }
            }
            issued.target.validate_complete()?;
            let target_value = serde_json::to_value(&issued.target).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::DeliveryInvalid,
                    "target is not JSON-representable",
                )
            })?;
            let recomputed_target_digest = nexus_contracts::target_digest_of(&target_value);
            if recomputed_target_digest != issued.provenance.target_digest {
                return Err(KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "sealed target does not match its provenance digest",
                ));
            }
            let recomputed_snapshot_digest = nexus_contracts::snapshot_digest_of(&req.snapshot);
            if recomputed_snapshot_digest != issued.provenance.registry_snapshot_digest {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "registry snapshot mismatch between intent and sealed provenance",
                ));
            }
            let intent_mode_rev = nexus_contracts::canonical_json(&intent.mode_config_revision);
            let target_mode_rev = nexus_contracts::canonical_json(
                &serde_json::to_value(&issued.target.mode_config_revision)
                    .unwrap_or(serde_json::Value::Null),
            );
            let prov_mode_rev =
                nexus_contracts::canonical_json(&issued.provenance.mode_config_revision);
            if intent_mode_rev != target_mode_rev || intent_mode_rev != prov_mode_rev {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "mode revision mismatch between intent and issued target",
                ));
            }
            if intent.backend != "native" {
                return Err(KernelError::new(
                    KernelErrorCode::BackendMismatch,
                    "backend mismatch",
                ));
            }
            if issued.task_instance_id != intent.task_instance_id {
                return Err(KernelError::new(
                    KernelErrorCode::GenerationMismatch,
                    "generation mismatch between intent and issued target",
                ));
            }
            if issued.role != intent.role {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "role mismatch between intent and issued target",
                ));
            }
            if issued.target.mode_id != intent.mode_id {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "mode mismatch between intent and issued target",
                ));
            }
            let lease = intent.lease.as_ref().ok_or_else(|| {
                KernelError::new(KernelErrorCode::StaleLease, "missing lease authorization")
            })?;
            let gkey = generation_key(&intent.task_instance_id, &intent.backend);
            let command_digest = nexus_contracts::command_digest_of(
                &intent.intent_digest,
                &recomputed_target_digest,
                &recomputed_snapshot_digest,
                lease.epoch,
                &lease.store_incarnation,
            );
            let current = self
                .store
                .current_generation(&intent.task_instance_id, &intent.backend)?;
            match self.witness.as_ref() {
                Some(w) => match w.read(&gkey)? {
                    Some(rec) => {
                        if let Some(cur) = current.as_ref() {
                            if rec.max_epoch > cur.epoch {
                                return Err(KernelError::new(KernelErrorCode::RollbackDetected, "store epoch is behind the witness maximum; refusing rolled-back lease"));
                            }
                        }
                        if rec.accepted.contains_key(&intent.command_id) {
                            let entry = rec.accepted.get(&intent.command_id).unwrap();
                            match self.store.read_receipt(&intent.command_id)? {
                                Some(r) => {
                                    if r.command_digest != entry.command_digest {
                                        return Err(KernelError::new(
                                            KernelErrorCode::CommandConflict,
                                            "witnessed acceptance conflicts with stored receipt",
                                        ));
                                    }
                                }
                                None => {
                                    return Err(KernelError::new(KernelErrorCode::ReconciliationRequired, "receipt was lost to rollback; refusing silent re-acceptance"));
                                }
                            }
                        }
                    }
                    None => {
                        if current
                            .as_ref()
                            .map(|g| g.witness_protected)
                            .unwrap_or(false)
                        {
                            return Err(KernelError::new(
                                KernelErrorCode::ReconciliationRequired,
                                "witness record lost after protection was established",
                            ));
                        }
                    }
                },
                None => {
                    if current
                        .as_ref()
                        .map(|g| g.witness_protected)
                        .unwrap_or(false)
                    {
                        return Err(KernelError::new(
                            KernelErrorCode::WitnessRequired,
                            "generation is witness-protected; witness must not be omitted",
                        ));
                    }
                }
            }
            let input = AcceptInput {
                command_id: intent.command_id.clone(),
                task_instance_id: intent.task_instance_id.clone(),
                attempt_id: intent.attempt_id.clone(),
                backend: intent.backend.clone(),
                controller_revision: intent.controller_revision as i64,
                role: intent.role.clone(),
                mode_id: intent.mode_id.clone(),
                mode_config_revision_json: serde_json::to_string(&intent.mode_config_revision)
                    .unwrap_or("null".to_owned()),
                payload_json: serde_json::to_string(&intent.intent_payload)
                    .unwrap_or("null".to_owned()),
                payload_digest: intent.payload_digest.clone(),
                intent_digest: intent.intent_digest.clone(),
                target_json: serde_json::to_string(&target_value).unwrap_or("null".to_owned()),
                snapshot_digest: recomputed_snapshot_digest,
                target_digest: recomputed_target_digest,
                issuance_id: computed_issuance,
                lease_epoch: lease.epoch,
                store_incarnation: lease.store_incarnation.clone(),
                command_digest: command_digest.clone(),
            };
            let outcome = self.store.accept_command(&input)?;
            if let Some(w) = self.witness.as_mut() {
                w.note_epoch(
                    &gkey,
                    lease.epoch,
                    &lease.store_incarnation,
                    Some((&intent.command_id, &command_digest, lease.epoch)),
                )?;
            }
            Ok((outcome.receipt, outcome.created))
        })
    }
    pub fn fence_for_recovery(
        &mut self,
        task: &str,
        backend: &str,
        attested_max_epoch: u64,
        operator_attestation: &str,
    ) -> KernelResult<GenerationLeaseV1> {
        if task.is_empty() {
            return Err(KernelError::new(
                KernelErrorCode::LeaseInvalid,
                "taskInstanceId is required",
            ));
        }
        if backend != "native" {
            return Err(KernelError::new(
                KernelErrorCode::LeaseBackendRefused,
                "only backend=native participates in A1.1",
            ));
        }
        if operator_attestation.is_empty() {
            return Err(KernelError::new(
                KernelErrorCode::DeliveryInvalid,
                "operator attestation is required for fenced recovery",
            ));
        }
        Kernel::critical(&self.lock_file, &self.in_process, || {
            let gkey = generation_key(task, backend);
            if self.witness.is_none() {
                return Err(KernelError::new(
                    KernelErrorCode::WitnessRequired,
                    "recovery requires the independent witness",
                ));
            }
            let store_epoch = self
                .store
                .current_generation(task, backend)?
                .map(|g| g.epoch)
                .unwrap_or(0);
            let witness_max = self
                .witness
                .as_ref()
                .unwrap()
                .read(&gkey)?
                .map(|r| r.max_epoch)
                .unwrap_or(0);
            let mut base = store_epoch;
            if witness_max > base {
                base = witness_max;
            }
            if attested_max_epoch > base {
                base = attested_max_epoch;
            }
            let (next, incarnation) =
                self.store
                    .acquire_generation(task, backend, Some(base), true)?;
            let baseline = serde_json::json!({"attestedMaxEpoch": attested_max_epoch, "operatorAttestation": operator_attestation, "previousStoreEpoch": store_epoch, "previousWitnessMax": witness_max, "fencedEpoch": next, "reason": "explicit-operator-recovery"});
            let baseline_json = serde_json::to_string(&baseline).unwrap_or("{}".to_owned());
            self.witness.as_mut().unwrap().write_recovery_baseline(
                &gkey,
                &baseline,
                next,
                &incarnation,
            )?;
            self.store
                .record_event(&gkey, "recovery-fenced", None, &baseline_json)?;
            Ok(GenerationLeaseV1 {
                schema_version: CONTRACT_SCHEMA_VERSION,
                task_instance_id: task.to_owned(),
                backend: backend.to_owned(),
                lease_epoch: next,
                store_incarnation: incarnation,
                witness_protected: true,
                acquired_at_utc: accept_now_utc(),
            })
        })
    }

    pub fn reconstruct(&self, task: &str, backend: &str) -> KernelResult<GenerationState> {
        let gkey = generation_key(task, backend);
        let cur = self
            .store
            .current_generation(task, backend)?
            .ok_or_else(|| KernelError::new(KernelErrorCode::LeaseInvalid, "unknown generation"))?;
        let events = self.store.list_events(&gkey)?;
        let mut receipts = Vec::new();
        let mut last_seq: i64 = 0;
        let mut last_acquire: u64 = 0;
        for e in &events {
            if e.seq <= last_seq {
                return Err(corrupt("event ordering violated"));
            }
            last_seq = e.seq;
            match e.kind {
                nexus_contracts::KernelEventKind::GenerationAcquired => {
                    let ep = e
                        .payload
                        .get("leaseEpoch")
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| corrupt("generation-acquired event is malformed"))?;
                    if ep < last_acquire {
                        return Err(corrupt("generation epoch regressed in journal"));
                    }
                    last_acquire = ep;
                }
                nexus_contracts::KernelEventKind::CommandAccepted => {
                    let cid = e
                        .command_id
                        .clone()
                        .ok_or_else(|| corrupt("command-accepted event lacks commandId"))?;
                    let r = self
                        .store
                        .read_receipt(&cid)?
                        .ok_or_else(|| corrupt("journal references a missing receipt"))?;
                    let digest = e
                        .payload
                        .get("commandDigest")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| corrupt("command-accepted event is malformed"))?;
                    if digest != r.command_digest {
                        return Err(corrupt("journal digest disagrees with stored receipt"));
                    }
                    receipts.push(r);
                }
                nexus_contracts::KernelEventKind::RecoveryFenced => {}
                nexus_contracts::KernelEventKind::ReconciliationRequired => {}
            }
        }
        if last_acquire != cur.epoch {
            return Err(corrupt("journal head disagrees with generation state"));
        }
        Ok(GenerationState {
            task_instance_id: task.to_owned(),
            backend: backend.to_owned(),
            epoch: cur.epoch,
            incarnation: cur.incarnation,
            receipts,
            events,
        })
    }
}

fn accept_now_utc() -> String {
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
