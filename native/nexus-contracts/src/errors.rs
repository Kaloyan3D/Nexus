//! Wire-stable kernel error codes shared with the JS prototype vocabulary.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KernelErrorCode {
    DeliveryInvalid,
    ForgedIssuer,
    BackendMismatch,
    GenerationMismatch,
    BindingMismatch,
    PayloadTamper,
    CommandConflict,
    IssuanceConflict,
    StaleLease,
    TargetIncomplete,
    UnsupportedSchema,
    RollbackDetected,
    ReconciliationRequired,
    WitnessRequired,
    IntentConflict,
    LeaseInvalid,
    LeaseBackendRefused,
    DispatchDisabled,
    StoreIncompatible,
    StoreCorrupt,
    StoreError,
}

impl KernelErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeliveryInvalid => "delivery-invalid",
            Self::ForgedIssuer => "forged-issuer",
            Self::BackendMismatch => "backend-mismatch",
            Self::GenerationMismatch => "generation-mismatch",
            Self::BindingMismatch => "binding-mismatch",
            Self::PayloadTamper => "payload-tamper",
            Self::CommandConflict => "command-conflict",
            Self::IssuanceConflict => "issuance-conflict",
            Self::StaleLease => "stale-lease",
            Self::TargetIncomplete => "target-incomplete",
            Self::UnsupportedSchema => "unsupported-schema",
            Self::RollbackDetected => "rollback-detected",
            Self::ReconciliationRequired => "reconciliation-required",
            Self::WitnessRequired => "witness-required",
            Self::IntentConflict => "intent-conflict",
            Self::LeaseInvalid => "lease-invalid",
            Self::LeaseBackendRefused => "lease-backend-refused",
            Self::DispatchDisabled => "dispatch-disabled",
            Self::StoreIncompatible => "store-incompatible",
            Self::StoreCorrupt => "store-corrupt",
            Self::StoreError => "store-error",
        }
    }
}

impl std::fmt::Display for KernelErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelError {
    pub code: KernelErrorCode,
    pub message: String,
}

impl KernelError {
    pub fn new(code: KernelErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for KernelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for KernelError {}

pub type KernelResult<T> = Result<T, KernelError>;
