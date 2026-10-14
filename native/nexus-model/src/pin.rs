//! Verified execution pin (A2.2, Phase 2).
//!
//! A pin binds one Controller attempt to one sealed Registry issuance and
//! one authoritative target extension. The transport cannot select anything:
//! `verify_against` re-derives every digest from the presented bytes and
//! refuses drift with `wrong-target` (changed Registry target after pin
//! creation) or `target-incomplete` (missing provenance).
//!
//! TRUST BOUNDARY (audit classification): this is OFFLINE STRUCTURAL
//! verification, not production authorization. `bind`/`verify_against`
//! prove the presented bytes are self-consistent (digests re-derived,
//! drift refused) but they do NOT verify the kernel HMAC issuance seal,
//! re-prove lease currency against the live generation, or authenticate
//! genuine Registry origin: a fully self-consistent fabricated chain
//! attests structurally (pinned by test). Production dispatch therefore
//! additionally requires the sealed-issuance check, a live lease proof,
//! and real Registry issuance — none of which exist in A2.2 — and stays
//! disabled regardless (`dispatch_enabled() == false`).

use crate::error::{ModelError, ModelErrorCode};
use crate::target::ExecutionTargetV2;
use nexus_contracts::RegistryResolutionV1;

/// Immutable binding of an attempt to its sealed issuance.
///
/// All digests are hex sha256 over canonical JSON, matching the kernel
/// vocabulary (`target_digest`, `snapshot_digest`, `issuance_id`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedExecutionPin {
    /// Controller task generation identity.
    pub task_instance_id: String,
    /// Controller command identity.
    pub command_id: String,
    /// Controller attempt identity (exactly one provider call per attempt
    /// unless a verified continuation is issued).
    pub attempt_id: String,
    /// Generation lease epoch authorizing this attempt.
    pub lease_epoch: u64,
    /// Store incarnation authorizing this attempt.
    pub store_incarnation: String,
    /// Digest of the sealed legacy core target.
    pub target_digest: String,
    /// Digest of the Registry snapshot the issuance was sealed over.
    pub snapshot_digest: String,
    /// Issuance identity (`issuance_id_of`).
    pub issuance_id: String,
    /// Kernel command digest binding intent + target + snapshot + lease.
    pub command_digest: String,
    /// Digest of the authoritative target extension bytes.
    pub extension_digest: String,
}

impl VerifiedExecutionPin {
    /// Bind a pin to a sealed resolution, its snapshot, the authoritative
    /// extension, and the kernel command digest. No network, no I/O.
    #[allow(clippy::too_many_arguments)]
    pub fn bind(
        task_instance_id: &str,
        command_id: &str,
        attempt_id: &str,
        lease_epoch: u64,
        store_incarnation: &str,
        issued: &RegistryResolutionV1,
        snapshot: &serde_json::Value,
        target: &ExecutionTargetV2,
        command_digest: &str,
    ) -> Result<Self, ModelError> {
        if task_instance_id.trim().is_empty()
            || command_id.trim().is_empty()
            || attempt_id.trim().is_empty()
        {
            return Err(ModelError::new(
                ModelErrorCode::AttestationFailed,
                "task/attempt/command binding is required for a pin",
            ));
        }
        if issued.task_instance_id != task_instance_id {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "pin task identity differs from the sealed issuance",
            ));
        }
        let target_value = serde_json::to_value(&issued.target).map_err(|_| {
            ModelError::new(
                ModelErrorCode::AttestationFailed,
                "sealed target is not JSON-representable",
            )
        })?;
        let target_digest = nexus_contracts::target_digest_of(&target_value);
        if target_digest != issued.provenance.target_digest {
            return Err(ModelError::new(
                ModelErrorCode::AttestationFailed,
                "sealed target does not match its provenance digest",
            ));
        }
        let snapshot_digest = nexus_contracts::snapshot_digest_of(snapshot);
        if snapshot_digest != issued.provenance.registry_snapshot_digest {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "registry snapshot drifted after pin creation",
            ));
        }
        let issuance_id = issued.issuance_id_of();
        if issuance_id != issued.provenance.issuance_id {
            return Err(ModelError::new(
                ModelErrorCode::AttestationFailed,
                "issuance id does not match issuance content",
            ));
        }
        // The extension must describe the SAME core the issuance sealed.
        let core_value = serde_json::to_value(&target.core).map_err(|_| {
            ModelError::new(
                ModelErrorCode::AttestationFailed,
                "extension core is not JSON-representable",
            )
        })?;
        if nexus_contracts::canonical_json(&core_value)
            != nexus_contracts::canonical_json(&target_value)
        {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "authoritative extension describes a different core than the sealed issuance",
            ));
        }
        Ok(Self {
            task_instance_id: task_instance_id.to_owned(),
            command_id: command_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            lease_epoch,
            store_incarnation: store_incarnation.to_owned(),
            target_digest,
            snapshot_digest,
            issuance_id,
            command_digest: command_digest.to_owned(),
            extension_digest: target.extension_digest(),
        })
    }

    /// Re-verify the pin against freshly presented bytes before dispatch.
    /// Any drift since binding is `wrong-target`, never executed.
    pub fn verify_against(
        &self,
        issued: &RegistryResolutionV1,
        snapshot: &serde_json::Value,
        target: &ExecutionTargetV2,
    ) -> Result<(), ModelError> {
        if issued.task_instance_id != self.task_instance_id {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "sealed issuance task drifted after pin creation",
            ));
        }
        let target_value = serde_json::to_value(&issued.target).map_err(|_| {
            ModelError::new(
                ModelErrorCode::AttestationFailed,
                "sealed target is not JSON-representable",
            )
        })?;
        if nexus_contracts::target_digest_of(&target_value) != self.target_digest {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "registry target changed after pin creation",
            ));
        }
        if nexus_contracts::snapshot_digest_of(snapshot) != self.snapshot_digest {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "registry snapshot changed after pin creation",
            ));
        }
        if issued.issuance_id_of() != self.issuance_id {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "issuance changed after pin creation",
            ));
        }
        if target.extension_digest() != self.extension_digest {
            return Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "authoritative target extension changed after pin creation",
            ));
        }
        Ok(())
    }

    /// Digest identifying this pin (bound into the attestation).
    pub fn pin_digest(&self) -> String {
        let value = serde_json::json!({
            "taskInstanceId": self.task_instance_id,
            "commandId": self.command_id,
            "attemptId": self.attempt_id,
            "leaseEpoch": self.lease_epoch,
            "storeIncarnation": self.store_incarnation,
            "targetDigest": self.target_digest,
            "snapshotDigest": self.snapshot_digest,
            "issuanceId": self.issuance_id,
            "commandDigest": self.command_digest,
            "extensionDigest": self.extension_digest,
        });
        nexus_contracts::digest_value(&value)
    }
}
