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

pub mod attempt_target;
pub mod code;
pub mod completion;
pub mod config;
pub mod consent;
pub mod context;
pub mod engine;
pub mod engine_state;
pub mod guidance;
pub mod identity;
pub mod inspect;
pub mod jobs;
pub mod live_auth;
pub mod pipeline;
pub mod projects;
pub mod recovery;
pub mod request_budget;
pub mod resolution;
pub mod server;
pub mod signals;
pub mod state_lock;
pub mod store;
pub mod threads;
pub mod trust;
pub mod worktree_ops;

pub use config::{BrokerConfig, CodeCaps, WorkspaceSpec};
pub use server::{start, BrokerHandle};
