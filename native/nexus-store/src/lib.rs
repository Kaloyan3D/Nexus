//! Nexus Native Core A1.1 transactional SQLite store.
pub mod journal;
pub mod schema;
pub mod store;
pub mod witness;

pub use journal::{AcceptInput, AcceptOutcome};
pub use schema::STORE_SCHEMA_VERSION;
pub use store::{GenerationInfo, SealOutcome, Store};
pub use witness::{AcceptedEntry, WitnessRecord, WitnessStore};
