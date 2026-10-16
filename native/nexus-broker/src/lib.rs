//! Nexus intent broker (A5.3).
//!
//! A narrow, durable front door for user intents. It accepts only the
//! `NexusIntentV1` verbs (submit / status / result / follow / cancel /
//! list / models) from local clients identified by OS peer credentials, and
//! drives the EXISTING chain: Controller bridge (JS) -> Registry issuance ->
//! daemon seal/accept/authorize (issuer-authenticated) -> `run_model_only`
//! (HTTPS executor). It adds no Controller, task database, transport or
//! harness of its own; it holds no authority a client can borrow:
//!
//! * the issuer capability and provider credential are read by THIS
//!   process only; no command returns or forwards them;
//! * there is no verb that forwards a daemon command, a path, a URL, a
//!   shell or a filesystem operation;
//! * clients can only see and cancel runs owned by their own client id.

pub mod config;
pub mod pipeline;
pub mod server;
pub mod store;
pub mod trust;

pub use config::BrokerConfig;
pub use server::{start, BrokerHandle};
