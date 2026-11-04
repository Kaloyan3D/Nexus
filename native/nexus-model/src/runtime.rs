//! Minimal `ModelRuntime` port (A2.2, Phase 2).
//!
//! Required conceptual interface (adapted to workspace conventions — this
//! workspace has no async runtime, so the port is synchronous with
//! identical ordering semantics):
//!
//! ```rust,ignore
//! trait ModelRuntime {
//!     async fn prepare(&self, pin, input) -> Result<Prepared, ModelError>;
//!     async fn dispatch(&self, request: Attested, cancel) -> Result<Stream, ModelError>;
//! }
//! ```
//!
//! Guarantees:
//!
//! * `prepare()` never sends network bytes (it has no transport handle).
//! * `dispatch()` requires an [`AttestedPreparedModelRequest`]: unattested
//!   bytes do not compile as an argument, and tampered bytes fail
//!   attestation coverage before any send. The attestation verified here is
//!   structural (offline pin/target/byte consistency), not production
//!   authorization: lease currency and the kernel issuance seal are carried
//!   opaquely and must be re-proven by the future execution gate.
//! * The transport cannot select model, provider, route, endpoint, or
//!   billing: every routable byte derives from the pinned target.
//! * No implicit fallback, no retry, no credential exposure (see
//!   `transport.rs`), no orchestration policy (assembly returns tool data;
//!   execution would be a Kernel concern and does not exist in A2.2).

use crate::error::{ModelError, ModelErrorCode};
use crate::pin::VerifiedExecutionPin;
use crate::prepare::{attest, now_ms, prepare, AttestedPreparedModelRequest, PreparedModelRequest};
use crate::request::ModelRequest;
use crate::sse::{StreamAssembler, TerminalResponse};
use crate::stream::{AttemptState, AttemptStore, AttemptTracker, CancellationToken, Preflight};
use crate::target::ExecutionTargetV2;
use crate::transport::{Credential, Transport, TransportBinding, TransportError, TransportLimits};
use nexus_contracts::RegistryResolutionV1;

/// Narrow model-runtime port. One implementation exists in A2.2:
/// [`OfflineModelRuntime`]. Production kernels do not hold one.
pub trait ModelRuntime {
    /// Bind pin + target + input into exact request bytes. Sends nothing.
    fn prepare(
        &self,
        pin: &VerifiedExecutionPin,
        issued: &RegistryResolutionV1,
        snapshot: &serde_json::Value,
        target: &ExecutionTargetV2,
        input: &ModelRequest,
    ) -> Result<PreparedModelRequest, ModelError>;

    /// Dispatch an attested request exactly once and normalize the
    /// terminal response. Unknown outcomes never trigger another call.
    fn dispatch(
        &self,
        attempt: &mut AttemptTracker,
        store: &mut AttemptStore,
        request: &AttestedPreparedModelRequest,
        credential: &Credential,
        cancel: &CancellationToken,
    ) -> Result<TerminalResponse, ModelError>;
}

/// Offline fixture-backed runtime (Candidate B transport). All sends go
/// through the bound `Transport` exactly once per attempt.
pub struct OfflineModelRuntime<T: Transport> {
    transport: T,
    binding: TransportBinding,
    limits: TransportLimits,
}

impl<T: Transport> OfflineModelRuntime<T> {
    /// Bind a runtime to one transport, one endpoint origin, one limit set.
    pub fn new(transport: T, binding: TransportBinding, limits: TransportLimits) -> Self {
        Self {
            transport,
            binding,
            limits,
        }
    }

    /// Borrow the endpoint binding (tests assert it before dispatch).
    pub fn binding(&self) -> &TransportBinding {
        &self.binding
    }

    /// Borrow the transport (the authorized-dispatch entry points need it).
    pub fn transport(&self) -> &T {
        &self.transport
    }

    /// Borrow the transport limits.
    pub fn limits(&self) -> &TransportLimits {
        &self.limits
    }

    /// Attest a preparation (the only attestation path; dispatches the
    /// audit stamp internally).
    pub fn attest(
        &self,
        pin: &VerifiedExecutionPin,
        issued: &RegistryResolutionV1,
        snapshot: &serde_json::Value,
        target: &ExecutionTargetV2,
        prepared: PreparedModelRequest,
    ) -> Result<AttestedPreparedModelRequest, ModelError> {
        attest(pin, issued, snapshot, target, prepared, now_ms())
    }
}

impl<T: Transport> ModelRuntime for OfflineModelRuntime<T> {
    fn prepare(
        &self,
        pin: &VerifiedExecutionPin,
        issued: &RegistryResolutionV1,
        snapshot: &serde_json::Value,
        target: &ExecutionTargetV2,
        input: &ModelRequest,
    ) -> Result<PreparedModelRequest, ModelError> {
        // No transport handle is touched here by construction: `prepare`
        // takes no `self.transport` access and performs no I/O.
        prepare(pin, issued, snapshot, target, input)
    }

    fn dispatch(
        &self,
        attempt: &mut AttemptTracker,
        store: &mut AttemptStore,
        request: &AttestedPreparedModelRequest,
        credential: &Credential,
        cancel: &CancellationToken,
    ) -> Result<TerminalResponse, ModelError> {
        let prepared = request.prepared();
        let attestation = request.attestation();
        // 1. Attestation coverage: the bytes must still match the attested
        //    digests. Tampering after `attest()` fails here, before contact.
        let recomputed =
            nexus_contracts::sha256_hex(&String::from_utf8_lossy(&prepared.request_bytes));
        if recomputed != prepared.request_digest || recomputed != attestation.request_digest {
            return Err(ModelError::new(
                ModelErrorCode::AttestationFailed,
                "prepared bytes do not match the attested digest (refusing dispatch)",
            ));
        }
        if attestation.pin_digest != prepared.pin_digest
            || attestation.target_digest != prepared.target_digest
            || attestation.extension_digest != prepared.extension_digest
        {
            return Err(ModelError::new(
                ModelErrorCode::AttestationFailed,
                "attestation does not cover this preparation (refusing dispatch)",
            ));
        }
        if prepared.attempt_id != attempt.attempt_id {
            return Err(ModelError::new(
                ModelErrorCode::AttestationFailed,
                "attested attempt differs from the tracked attempt",
            ));
        }
        // 2. Fresh attempt: the tracker refuses any second call outright.
        attempt.require_not_sent()?;
        // 3. Store preflight: replays return committed terminals without new
        //    bytes; uncertain outcomes demand a verified continuation.
        match store.preflight(&attempt.attempt_id, &prepared.request_digest)? {
            Preflight::Fresh => {}
            Preflight::ReplayTerminal(t) => {
                attempt.mark_terminal();
                return Ok(t);
            }
            Preflight::ReplayFailure(e) => {
                return Err(e);
            }
        }
        // 4. Credential + binding gates run BEFORE any byte is sent.
        if let Err(e) = credential.check() {
            store.record_failed(&attempt.attempt_id, &prepared.request_digest, &e);
            return Err(e);
        }
        if let Err(e) = self.binding.check(&prepared.endpoint_origin) {
            store.record_failed(&attempt.attempt_id, &prepared.request_digest, &e);
            return Err(e);
        }
        if cancel.is_cancelled() {
            let e = ModelError::new(
                ModelErrorCode::Cancelled,
                "cancelled before sending (no bytes sent)",
            );
            store.record_failed(&attempt.attempt_id, &prepared.request_digest, &e);
            return Err(e);
        }
        // 5. Exactly one send. No retry exists on any path below.
        let report = match self
            .transport
            .send(request, credential, cancel, &self.limits)
        {
            Ok(r) => r,
            Err(te) => return Err(self.absorb_transport_error(attempt, store, prepared, te)),
        };
        // 6. Normalize the observed events with bounds + cancellation.
        let mut assembler = StreamAssembler::new(
            &attempt.attempt_id,
            &prepared.request_digest,
            self.limits.max_events,
            self.limits.max_text_bytes,
            self.limits.max_arg_bytes,
        );
        for event in report.events {
            if cancel.is_cancelled() {
                // Partial events already counted stay counted; the attempt
                // is stream_partial (or send_uncertain when none arrived).
                if attempt.state() == AttemptState::NotSent {
                    attempt.mark_send_uncertain();
                }
                store.record_uncertain(&attempt.attempt_id, &prepared.request_digest);
                return Err(ModelError::new(
                    ModelErrorCode::Cancelled,
                    "cancelled during streaming (partial output retained, not terminal; not re-sending)",
                ));
            }
            attempt.mark_event();
            if let Err(e) = assembler.push(event) {
                // Bounds are fail-closed: partial output is retained in the
                // tracker counts, never executed, never retried.
                store.record_uncertain(&attempt.attempt_id, &prepared.request_digest);
                return Err(e);
            }
        }
        match report.finish_reason {
            Some(reason) => {
                assembler.set_finish(&reason);
                match assembler.finish() {
                    Ok(terminal) => {
                        attempt.mark_terminal();
                        debug_assert_eq!(terminal.request_digest, prepared.request_digest);
                        store.record_committed(terminal.clone());
                        Ok(terminal)
                    }
                    Err(e) => {
                        // Provider completed but the output is unusable
                        // (e.g. invalid tool arguments): deterministic replay
                        // of the same error, never a new call, never executed.
                        store.record_failed(&attempt.attempt_id, &prepared.request_digest, &e);
                        Err(e)
                    }
                }
            }
            None => {
                // Truncated stream (disconnect or missing completion): the
                // outcome is UNKNOWN. Record uncertainty, never re-send.
                if attempt.state() == AttemptState::NotSent {
                    attempt.mark_send_uncertain();
                }
                store.record_uncertain(&attempt.attempt_id, &prepared.request_digest);
                let note = report
                    .note
                    .unwrap_or_else(|| "no provider completion observed".to_owned());
                Err(ModelError::new(
                    ModelErrorCode::StreamPartial,
                    format!(
                        "stream ended without provider completion after {} events ({note}; not re-sending)",
                        attempt.events_seen(),
                    ),
                ))
            }
        }
    }
}

impl<T: Transport> OfflineModelRuntime<T> {
    fn absorb_transport_error(
        &self,
        attempt: &mut AttemptTracker,
        store: &mut AttemptStore,
        prepared: &PreparedModelRequest,
        te: TransportError,
    ) -> ModelError {
        if !te.bytes_sent {
            // Proven not-sent (connect refused, gate failed inside the
            // transport): deterministic failure replay, no uncertainty —
            // but still NO automatic retry. A retry needs a new attempt.
            store.record_failed(&attempt.attempt_id, &prepared.request_digest, &te.error);
            return te.error;
        }
        // Bytes may exist provider-side: the outcome is UNKNOWN.
        if attempt.state() == AttemptState::NotSent {
            attempt.mark_send_uncertain();
        }
        store.record_uncertain(&attempt.attempt_id, &prepared.request_digest);
        normalize_after_send(te.error)
    }
}

/// After-send normalization: a bare `disconnected` with bytes on the wire
/// is truthfully `send-uncertain`. Every other code already describes an
/// uncertain or partial outcome and passes through.
fn normalize_after_send(error: ModelError) -> ModelError {
    if error.code == ModelErrorCode::Disconnected {
        return ModelError::new(
            ModelErrorCode::SendUncertain,
            format!(
                "{} (bytes were sent; outcome unknown; not re-sending)",
                error.message
            ),
        );
    }
    error
}
