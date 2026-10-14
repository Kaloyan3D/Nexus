//! Authorized production dispatch boundary (A2.4 Phase 1).
//!
//! Raw `Transport::send` is a low-level, test-only primitive: it performs
//! network I/O for any attested request without proving Kernel
//! authorization. It must never be reachable through the production API.
//!
//! This module is the only production path to the network. Every call
//! re-verifies a kernel-sealed dispatch grant **immediately before**
//! transmission, in the same synchronous function with no yield between
//! verification and `send`. The authority handle is `&mut Kernel` itself:
//! only the process holding the real sealed store (daemon or an in-process
//! test harness owning the store) can verify, so CLI/GUI callers cannot
//! self-issue, forge, extend, or refresh grants.
//!
//! Binding: the grant pins command, attempt, task, lease, target digest,
//! extension digest, request digest, endpoint origin, credential reference,
//! scope, and a 5-minute expiry. Verification re-checks the HMAC tag, the
//! exact bytes about to be sent, lease currency, intent lifecycle
//! (executed proves `authorize` happened; published/cancelled refuse),
//! witness health, and scope/loopback. Replay of the same grant cannot
//! cause a second billable call through the same store: the attempt tracker
//! plus the in-process attempt store refuse replays without new bytes (a
//! completed send records grant-consumption; uncertain outcomes record
//! uncertainty and are never retried). Cross-process re-presentation of a
//! copied grant is outside the store's domain; grant minting itself stays
//! durable-exactly-once via the kernel intent ledger (second authorize is
//! command-conflict).

use crate::error::{ModelError, ModelErrorCode};
use crate::prepare::AttestedPreparedModelRequest;
use crate::stream::{AttemptStore, AttemptTracker, Preflight};
use crate::transport::{Credential, SendReport, Transport, TransportError, TransportLimits};

fn now_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis().min(i64::MAX as u128) as i64,
        Err(_) => 0,
    }
}

fn model_err_of_kernel(e: &nexus_contracts::KernelError) -> ModelError {
    let code = match e.code {
        nexus_contracts::KernelErrorCode::ForgedIssuer => ModelErrorCode::AttestationFailed,
        nexus_contracts::KernelErrorCode::BindingMismatch => ModelErrorCode::AttestationFailed,
        nexus_contracts::KernelErrorCode::StaleLease => ModelErrorCode::AttestationFailed,
        nexus_contracts::KernelErrorCode::IntentFenced => ModelErrorCode::Cancelled,
        nexus_contracts::KernelErrorCode::CommandConflict => ModelErrorCode::DuplicateAttempt,
        nexus_contracts::KernelErrorCode::ScopeRefused => ModelErrorCode::TransportRefused,
        nexus_contracts::KernelErrorCode::ReservationExpired => ModelErrorCode::AttestationFailed,
        _ => ModelErrorCode::AttestationFailed,
    };
    ModelError::new(
        code,
        format!(
            "grant authority refused ({}): {}",
            e.code.as_str(),
            e.message
        ),
    )
}

/// Production authorized send: verify-then-transmit with no gap.
///
/// * `kernel` is the trusted authority handle (holds the issuance key).
/// * `grant` must be the kernel-sealed grant for this exact attempt.
/// * `credential_ref` is the opaque reference the grant was bound to
///   (never the secret value).
/// * `attempt`/`store` enforce at-most-once network bytes per attempt.
#[allow(clippy::too_many_arguments)]
pub fn dispatch_authorized<T: Transport>(
    transport: &T,
    kernel: &mut nexus_kernel::Kernel,
    grant: &nexus_kernel::SealedNativeDispatchGrant,
    request: &AttestedPreparedModelRequest,
    credential_ref: &str,
    credential: &Credential,
    cancel: &crate::stream::CancellationToken,
    limits: &TransportLimits,
    attempt: &mut AttemptTracker,
    store: &mut AttemptStore,
) -> Result<SendReport, TransportError> {
    let prepared = request.prepared();
    let verify = kernel.verify_sealed_grant(
        grant,
        &prepared.request_digest,
        &prepared.endpoint_origin,
        credential_ref,
        now_ms(),
    );
    if let Err(e) = verify {
        let me = model_err_of_kernel(&e);
        store.record_failed(&attempt.attempt_id, &prepared.request_digest, &me);
        return Err(TransportError::refused(me));
    }
    if prepared.attempt_id != attempt.attempt_id || prepared.attempt_id != grant.attempt_id {
        let me = ModelError::new(
            ModelErrorCode::AttestationFailed,
            "grant attempt differs from the tracked attempt (refusing dispatch)",
        );
        store.record_failed(&attempt.attempt_id, &prepared.request_digest, &me);
        return Err(TransportError::refused(me));
    }
    if let Err(e) = attempt.require_not_sent() {
        store.record_failed(&attempt.attempt_id, &prepared.request_digest, &e);
        return Err(TransportError::refused(e));
    }
    match store.preflight(&attempt.attempt_id, &prepared.request_digest) {
        Ok(Preflight::Fresh) => {}
        Ok(Preflight::ReplayTerminal(t)) => {
            attempt.mark_terminal();
            return Err(TransportError::refused(ModelError::new(
                ModelErrorCode::DuplicateAttempt,
                format!("duplicate authorized dispatch refused; committed terminal for {} already recorded (no second network call)", t.attempt_id),
            )));
        }
        Ok(Preflight::ReplayFailure(e)) => {
            return Err(TransportError::refused(e));
        }
        Err(e) => {
            return Err(TransportError::refused(e));
        }
    }
    if let Err(e) = credential.check() {
        store.record_failed(&attempt.attempt_id, &prepared.request_digest, &e);
        return Err(TransportError::refused(e));
    }
    if cancel.is_cancelled() {
        let e = ModelError::new(
            ModelErrorCode::Cancelled,
            "cancelled before sending (no bytes sent)",
        );
        store.record_failed(&attempt.attempt_id, &prepared.request_digest, &e);
        return Err(TransportError::refused(e));
    }
    match transport.send(request, credential, cancel, limits) {
        Ok(report) => {
            store.record_sent(&attempt.attempt_id, &prepared.request_digest);
            if report.events.is_empty() {
                attempt.mark_send_uncertain();
            } else {
                for _ in &report.events {
                    attempt.mark_event();
                }
            }
            if report.finish_reason.is_some() {
                attempt.mark_terminal();
            }
            Ok(report)
        }
        Err(te) => {
            if te.bytes_sent {
                attempt.mark_send_uncertain();
                store.record_uncertain(&attempt.attempt_id, &prepared.request_digest);
            } else {
                let me = ModelError::new(te.error.code, te.error.message.clone());
                store.record_failed(&attempt.attempt_id, &prepared.request_digest, &me);
            }
            Err(te)
        }
    }
}
