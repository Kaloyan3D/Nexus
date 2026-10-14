//! Nexus Native Core A2.2 — offline model transport (conformance milestone).
//!
//! Minimal, reliable, security-first transport foundation: immutable target
//! binding, provider-request attestation, deterministic streaming
//! normalization, cancellation, and truthful failure classification.
//!
//! This crate is OFFLINE: it proves exact request bytes, attestation,
//! streaming, cancellation, and failure semantics against recorded
//! fixtures and a loopback mock server (`testkit`). It performs NO
//! production model dispatch and launches NO real inference — the separate
//! execution-readiness gates must be satisfied first, and the production
//! kernel still reports `dispatch_enabled() == false` (pinned by test).
//!
//! Non-goals (explicitly out of scope for A2.2): agent orchestration
//! policy, tool execution (fragments are data, never run), credential
//! issuance, retry/resume semantics (unknown outcomes stay unknown), and a
//! second model router (the Registry remains the only model authority).

pub mod error;
pub mod pin;
pub mod prepare;
pub mod request;
pub mod runtime;
pub mod sse;
pub mod stream;
pub mod target;
pub mod testkit;
pub mod transport;

pub use error::{redact, ModelError, ModelErrorCode};
pub use pin::VerifiedExecutionPin;
pub use prepare::{
    attest, now_ms, prepare, Attestation, AttestedPreparedModelRequest, PreparedModelRequest,
};
pub use request::{ChatMessage, ModelRequest, ToolDefinition};
pub use runtime::{ModelRuntime, OfflineModelRuntime};
pub use sse::{AssembledToolCall, ModelEvent, StreamAssembler, TerminalResponse, Usage};
pub use stream::{AttemptState, AttemptStore, AttemptTracker, CancellationToken};
pub use target::{
    AuthoritativeEndpoint, BillingProvenance, ExecutionTargetV2, SessionBinding,
    TARGET_EXTENSION_VERSION,
};
pub use transport::{
    Credential, HttpSseTransport, SendReport, Transport, TransportBinding, TransportError,
    TransportLimits,
};
