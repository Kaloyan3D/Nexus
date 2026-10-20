//! Executable target and sealed resolution types.
//! Field names are camelCase to match JS bridge bytes exactly.

use crate::canonical::digest_value;
use crate::errors::{KernelError, KernelErrorCode, KernelResult};
use crate::CONTRACT_SCHEMA_VERSION;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionTargetCoreV1 {
    pub schema_version: u32,
    pub resolution_id: String,
    pub mode_id: String,
    pub orchestration_engine_id: String,
    pub mode_config_revision: serde_json::Value,
    pub role_id: String,
    pub logical_model_id: String,
    pub route_id: String,
    pub provider_id: String,
    pub remote_model_id: String,
    pub connection_id: String,
    pub execution_kind: String,
    pub access_type: String,
    pub protocol_id: String,
    pub reasoning: String,
    /// EM-02: the operator-authorized reasoning levels of the slot (Registry-resolved, route-
    /// checked). Absent on targets without a slot policy: only `reasoning` is authorized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_reasoning: Option<Vec<String>>,
    pub required_capabilities: Vec<String>,
    pub slot_requirements: serde_json::Value,
    pub data_use_tier: Option<String>,
}

impl ExecutionTargetCoreV1 {
    pub fn validate_complete(&self) -> KernelResult<()> {
        if self.schema_version != CONTRACT_SCHEMA_VERSION {
            return Err(KernelError::new(
                KernelErrorCode::UnsupportedSchema,
                "unsupported target schemaVersion",
            ));
        }
        let required: [(&str, &String); 8] = [
            ("modeId", &self.mode_id),
            ("roleId", &self.role_id),
            ("logicalModelId", &self.logical_model_id),
            ("routeId", &self.route_id),
            ("providerId", &self.provider_id),
            ("remoteModelId", &self.remote_model_id),
            ("connectionId", &self.connection_id),
            ("executionKind", &self.execution_kind),
        ];
        for (field, value) in required {
            if value.trim().is_empty() {
                return Err(KernelError::new(
                    KernelErrorCode::TargetIncomplete,
                    ["mandatory target field ", field, " is missing"].concat(),
                ));
            }
        }
        if self.orchestration_engine_id.trim().is_empty() {
            return Err(KernelError::new(
                KernelErrorCode::TargetIncomplete,
                "mandatory target field orchestrationEngineId is missing",
            ));
        }
        // EM-02: a slot policy, when present, must authorize the target's own effort
        if let Some(levels) = &self.allowed_reasoning {
            if levels.is_empty() || !levels.contains(&self.reasoning) {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "the target's reasoning effort is outside its slot reasoning policy",
                ));
            }
        }
        Ok(())
    }

    pub fn sample(role: &str, mode: &str, rev: serde_json::Value) -> Self {
        Self {
            schema_version: CONTRACT_SCHEMA_VERSION,
            resolution_id: "compat-resolution".to_owned(),
            mode_id: mode.to_owned(),
            orchestration_engine_id: "muse".to_owned(),
            mode_config_revision: rev,
            role_id: role.to_owned(),
            logical_model_id: "logical-model".to_owned(),
            route_id: "route".to_owned(),
            provider_id: "provider".to_owned(),
            remote_model_id: "remote-model".to_owned(),
            connection_id: "connection".to_owned(),
            execution_kind: "raw-model".to_owned(),
            access_type: "managed".to_owned(),
            protocol_id: "https".to_owned(),
            reasoning: "low".to_owned(),
            allowed_reasoning: None,
            required_capabilities: Vec::new(),
            slot_requirements: serde_json::json!({}),
            data_use_tier: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryProvenanceV1 {
    pub issuer: String,
    pub resolution_id_compat: String,
    pub registry_snapshot_digest: String,
    pub target_digest: String,
    pub mode_config_revision: serde_json::Value,
    pub issuance_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryResolutionV1 {
    pub schema_version: u32,
    pub issuer: String,
    pub task_instance_id: String,
    pub role: String,
    pub target: ExecutionTargetCoreV1,
    pub provenance: RegistryProvenanceV1,
}

impl RegistryResolutionV1 {
    pub fn seal_content(&self) -> serde_json::Value {
        serde_json::json!({
            "issuer": self.issuer,
            "taskInstanceId": self.task_instance_id,
            "role": self.role,
            "target": self.target,
            "provenance": {
                "issuer": self.provenance.issuer,
                "resolutionIdCompat": self.provenance.resolution_id_compat,
                "registrySnapshotDigest": self.provenance.registry_snapshot_digest,
                "targetDigest": self.provenance.target_digest,
                "modeConfigRevision": self.provenance.mode_config_revision,
            }
        })
    }
    pub fn issuance_id_of(&self) -> String {
        digest_value(&self.seal_content())
    }
}
