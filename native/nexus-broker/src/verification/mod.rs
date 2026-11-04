//! Verification Engine, Phase 01 + 02: versioned evidence contracts and a durable evidence
//! ledger, in Shadow Mode.
//!
//! Core-owned and independent of `engine/`: every Engineering Mode reaches it through the same
//! tool loop in `inspect.rs`. It records what the Kernel receipted; it never decides, blocks,
//! schedules, continues the model or adds a provider request.

pub mod attest;
pub mod evidence;
pub mod feedback;
pub mod freshness;
pub mod ledger;
pub mod persistence;
pub mod reconcile;
pub mod shadow;
pub mod target;

#[cfg(test)]
pub(crate) mod tests;

pub use evidence::{EvidenceRecord, ReceiptFacts};
pub use shadow::ShadowRecorder;
