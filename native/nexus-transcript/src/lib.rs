//! Nexus per-task conversation contract v1 (A2.5).
//!
//! * [`contract`]: the versioned, additive event record with provenance.
//! * [`redact`]: credential redaction that always reports that it happened.
//! * [`store`]: durable, append-only, hash-chained native transcript store.
//! * [`dsh`]: read-only adapter over historical DSH session logs, joined only
//!   through the Controller attempt journal and verified by an in-record
//!   binding message. It never needs DSH to be running.
//! * [`view`]: revision collapsing and cursor paging shared by both sources.
//!
//! Nothing here fabricates conversation: absent history stays absent.

pub mod contract;
pub mod dsh;
pub mod redact;
pub mod store;
pub mod view;

pub use contract::*;
pub use dsh::{read_history, read_history_cached, DshLimits, DshSources, HistoryError};
pub use store::{AppendOutcome, StoreError, TranscriptStore};
pub use view::{page, Page, PageSpec};
