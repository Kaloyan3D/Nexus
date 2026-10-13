//! Nexus Native Core A1.1 versioned contracts.

pub mod canonical;
pub mod errors;
pub mod target;
pub mod types;

pub use canonical::{
    canonical_json, command_digest_of, digest_value, intent_digest_of, payload_digest_of,
    sha256_hex, snapshot_digest_of, target_digest_of,
};
pub use errors::{KernelError, KernelErrorCode, KernelResult};
pub use target::{ExecutionTargetCoreV1, RegistryProvenanceV1, RegistryResolutionV1};
pub use types::{
    generation_key, CommandReceiptV1, ControllerIntentV1, ExecutionPinV1, GenerationLeaseV1,
    KernelCommandV1, KernelEventKind, KernelEventV1, ReceiptStatus,
};

pub const CONTRACT_SCHEMA_VERSION: u32 = 1;

#[cfg(test)]
mod tests;
