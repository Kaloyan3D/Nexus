//! Intent, lease, command, receipt and event types.

use crate::canonical::{command_digest_of, intent_digest_of, payload_digest_of};
use crate::errors::{KernelError, KernelErrorCode, KernelResult};
use crate::CONTRACT_SCHEMA_VERSION;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPinV1 {
    pub epoch: u64,
    pub store_incarnation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerIntentV1 {
    pub schema_version: u32,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub command_id: String,
    pub backend: String,
    pub controller_revision: u64,
    pub role: String,
    pub mode_id: String,
    pub mode_config_revision: serde_json::Value,
    pub intent_payload: serde_json::Value,
    pub payload_digest: String,
    pub intent_digest: String,
    pub lease: Option<ExecutionPinV1>,
}

impl ControllerIntentV1 {
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        task: &str,
        attempt: &str,
        command: &str,
        backend: &str,
        revision: u64,
        role: &str,
        mode: &str,
        mode_rev: serde_json::Value,
        payload: serde_json::Value,
    ) -> Self {
        let payload_digest = payload_digest_of(&payload);
        let intent_digest = intent_digest_of(
            task,
            attempt,
            command,
            backend,
            revision,
            role,
            mode,
            &mode_rev,
            &payload_digest,
        );
        Self {
            schema_version: CONTRACT_SCHEMA_VERSION,
            task_instance_id: task.to_owned(),
            attempt_id: attempt.to_owned(),
            command_id: command.to_owned(),
            backend: backend.to_owned(),
            controller_revision: revision,
            role: role.to_owned(),
            mode_id: mode.to_owned(),
            mode_config_revision: mode_rev,
            intent_payload: payload,
            payload_digest,
            intent_digest,
            lease: None,
        }
    }

    pub fn with_lease(mut self, epoch: u64, incarnation: &str) -> Self {
        self.lease = Some(ExecutionPinV1 {
            epoch,
            store_incarnation: incarnation.to_owned(),
        });
        self
    }

    pub fn verify_integrity(&self) -> KernelResult<()> {
        if self.schema_version != CONTRACT_SCHEMA_VERSION {
            return Err(KernelError::new(
                KernelErrorCode::UnsupportedSchema,
                "unsupported intent schemaVersion",
            ));
        }
        if payload_digest_of(&self.intent_payload) != self.payload_digest {
            return Err(KernelError::new(
                KernelErrorCode::PayloadTamper,
                "intent payload does not match its digest",
            ));
        }
        let recomputed = intent_digest_of(
            &self.task_instance_id,
            &self.attempt_id,
            &self.command_id,
            &self.backend,
            self.controller_revision,
            &self.role,
            &self.mode_id,
            &self.mode_config_revision,
            &self.payload_digest,
        );
        if recomputed != self.intent_digest {
            return Err(KernelError::new(
                KernelErrorCode::PayloadTamper,
                "intent identity does not match its digest",
            ));
        }
        if self.task_instance_id.is_empty()
            || self.attempt_id.is_empty()
            || self.command_id.is_empty()
        {
            return Err(KernelError::new(
                KernelErrorCode::DeliveryInvalid,
                "task/attempt/command binding is required",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationLeaseV1 {
    pub schema_version: u32,
    pub task_instance_id: String,
    pub backend: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub witness_protected: bool,
    pub acquired_at_utc: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelCommandV1 {
    pub schema_version: u32,
    pub intent: ControllerIntentV1,
    pub issued: crate::RegistryResolutionV1,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub command_digest: String,
}

impl KernelCommandV1 {
    pub fn compute_digest(
        intent_digest: &str,
        target_digest: &str,
        snapshot_digest: &str,
        lease_epoch: u64,
        incarnation: &str,
    ) -> String {
        command_digest_of(
            intent_digest,
            target_digest,
            snapshot_digest,
            lease_epoch,
            incarnation,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReceiptStatus {
    AcceptedReservedDispatchDisabled,
}

impl ReceiptStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AcceptedReservedDispatchDisabled => "accepted-reserved-dispatch-disabled",
        }
    }

    /// Parse a persisted status. A1.1 writes exactly one status; anything
    /// else on disk means tampering or corruption and must fail closed.
    pub fn parse_status(s: &str) -> Option<Self> {
        match s {
            "accepted-reserved-dispatch-disabled" => Some(Self::AcceptedReservedDispatchDisabled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceiptV1 {
    pub schema_version: u32,
    pub command_id: String,
    pub command_digest: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub target_digest: String,
    pub snapshot_digest: String,
    pub issuance_id: String,
    pub status: ReceiptStatus,
    pub event_seq: i64,
    pub accepted_at_utc: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KernelEventKind {
    GenerationAcquired,
    CommandAccepted,
    RecoveryFenced,
    ReconciliationRequired,
}

impl KernelEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GenerationAcquired => "generation-acquired",
            Self::CommandAccepted => "command-accepted",
            Self::RecoveryFenced => "recovery-fenced",
            Self::ReconciliationRequired => "reconciliation-required",
        }
    }
    pub fn parse_kind(s: &str) -> Option<Self> {
        match s {
            "generation-acquired" => Some(Self::GenerationAcquired),
            "command-accepted" => Some(Self::CommandAccepted),
            "recovery-fenced" => Some(Self::RecoveryFenced),
            "reconciliation-required" => Some(Self::ReconciliationRequired),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelEventV1 {
    pub schema_version: u32,
    pub seq: i64,
    pub generation_key: String,
    pub kind: KernelEventKind,
    pub command_id: Option<String>,
    pub payload: serde_json::Value,
    pub recorded_at_utc: String,
}

pub fn generation_key(task: &str, backend: &str) -> String {
    [task, backend].join("|")
}
