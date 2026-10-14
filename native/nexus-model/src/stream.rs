//! Attempt lifecycle, cancellation, and duplicate suppression (A2.2, Phase 4.7/4.10).
//!
//! ```text
//! not_sent -> send_uncertain -> stream_partial -> terminal_committed
//! ```
//! Every transition is explicit and inspectable. A provider request with an
//! unknown outcome (`send_uncertain`, `stream_partial`) NEVER triggers
//! another call: re-dispatch of the same attempt is refused with
//! `duplicate-attempt` (different bytes) or `continuation-required` (same
//! bytes, outcome unknown — resuming needs a verified continuation the
//! Registry has not issued, so none is synthesized here). A terminal
//! response replays from the store without new bytes.

use crate::error::{ModelError, ModelErrorCode};
use crate::sse::TerminalResponse;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// Explicit provider-attempt state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptState {
    /// No byte has been sent for this attempt.
    NotSent,
    /// Bytes may have been sent, but no provider event was observed.
    /// The outcome is UNKNOWN: do not re-send.
    SendUncertain,
    /// At least one provider event arrived without terminal completion.
    /// Partial output is retained for inspection, never executed.
    StreamPartial,
    /// Terminal completion observed and normalized.
    TerminalCommitted,
}

impl AttemptState {
    /// Stable wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotSent => "not_sent",
            Self::SendUncertain => "send_uncertain",
            Self::StreamPartial => "stream_partial",
            Self::TerminalCommitted => "terminal_committed",
        }
    }
}

/// Live tracker for one attempt. Owned by the caller and passed to
/// `dispatch()` so states are observable across the call.
#[derive(Debug, Clone)]
pub struct AttemptTracker {
    /// Attempt identity.
    pub attempt_id: String,
    state: AttemptState,
    events_seen: usize,
}

impl AttemptTracker {
    /// Begin tracking an attempt that has sent nothing.
    pub fn new(attempt_id: &str) -> Self {
        Self {
            attempt_id: attempt_id.to_owned(),
            state: AttemptState::NotSent,
            events_seen: 0,
        }
    }

    /// Current state.
    pub fn state(&self) -> AttemptState {
        self.state
    }

    /// Provider events observed so far.
    pub fn events_seen(&self) -> usize {
        self.events_seen
    }

    /// Dispatch requires a fresh attempt. Anything else is a duplicate or a
    /// disguised retry of an uncertain outcome.
    pub fn require_not_sent(&self) -> Result<(), ModelError> {
        if self.state != AttemptState::NotSent {
            return Err(ModelError::new(
                ModelErrorCode::DuplicateAttempt,
                format!(
                    "attempt is already {} (refusing a second provider call)",
                    self.state.as_str()
                ),
            ));
        }
        Ok(())
    }

    /// Record that bytes may have been sent without an observed event.
    pub fn mark_send_uncertain(&mut self) {
        if self.state == AttemptState::NotSent {
            self.state = AttemptState::SendUncertain;
        }
    }

    /// Record one observed provider event.
    pub fn mark_event(&mut self) {
        self.events_seen += 1;
        if self.state == AttemptState::NotSent || self.state == AttemptState::SendUncertain {
            self.state = AttemptState::StreamPartial;
        }
    }

    /// Record terminal completion.
    pub fn mark_terminal(&mut self) {
        self.state = AttemptState::TerminalCommitted;
    }
}

/// Recorded outcome for one attempt id (durable-intent support hook: the
/// store is in-memory in A2.2; crash recovery re-derives `send_uncertain`
/// from a missing terminal, never success).
#[derive(Debug, Clone)]
enum AttemptOutcome {
    /// Terminal response committed (replayable without new bytes).
    Committed(TerminalResponse),
    /// Terminal provider failure (replayable as the same error).
    Failed(ModelError),
    /// Uncertain outcome: bytes may exist provider-side. Resuming needs a
    /// verified continuation (not issued in A2.2).
    Uncertain { request_digest: String },
    /// Authorized dispatch completed a network send for these exact bytes
    /// (A2.4 grant-consumption record). The grant is spent: re-presenting it
    /// for the same attempt refuses without new bytes, so a replayed grant
    /// can never cause a second billable call through the same store.
    Sent { request_digest: String },
}

/// Suppresses duplicate and replayed provider attempts process-wide.
/// One entry per attempt id; a second send for the same id is refused
/// unless it replays a committed terminal byte-for-byte.
#[derive(Debug, Default)]
pub struct AttemptStore {
    entries: HashMap<String, AttemptOutcome>,
}

/// Result of consulting the store before sending.
#[derive(Debug)]
pub enum Preflight {
    /// First send for this attempt: proceed exactly once.
    Fresh,
    /// Same bytes, committed terminal: replay without new bytes.
    ReplayTerminal(TerminalResponse),
    /// Same bytes, recorded failure: replay the same error.
    ReplayFailure(ModelError),
}

impl AttemptStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Pre-send gate. Refuses different bytes for a known id
    /// (`duplicate-attempt`) and same bytes with an uncertain outcome
    /// (`continuation-required`); replays committed terminals.
    pub fn preflight(
        &self,
        attempt_id: &str,
        request_digest: &str,
    ) -> Result<Preflight, ModelError> {
        match self.entries.get(attempt_id) {
            None => Ok(Preflight::Fresh),
            Some(AttemptOutcome::Committed(t)) if t.request_digest == request_digest => {
                Ok(Preflight::ReplayTerminal(t.clone()))
            }
            Some(AttemptOutcome::Failed(e)) => {
                // A recorded failure replays only when the bytes match the
                // failed attempt; different bytes are a new call in disguise.
                if e.message.contains(request_digest) {
                    Ok(Preflight::ReplayFailure(e.clone()))
                } else {
                    Err(ModelError::new(
                        ModelErrorCode::DuplicateAttempt,
                        "attempt id was already used with different request bytes (replay refused)",
                    ))
                }
            }
            Some(AttemptOutcome::Committed(_)) => Err(ModelError::new(
                ModelErrorCode::DuplicateAttempt,
                "attempt id was already committed with different request bytes (replay refused)",
            )),
            Some(AttemptOutcome::Sent { request_digest: sent }) if sent == request_digest => {
                Err(ModelError::new(
                    ModelErrorCode::DuplicateAttempt,
                    "attempt was already dispatched with these bytes (grant consumed; replay refused, no second provider call)",
                ))
            }
            Some(AttemptOutcome::Sent { .. }) => Err(ModelError::new(
                ModelErrorCode::DuplicateAttempt,
                "attempt id was already dispatched with different request bytes (replay refused)",
            )),
            Some(AttemptOutcome::Uncertain { request_digest }) => Err(ModelError::new(
                ModelErrorCode::ContinuationRequired,
                format!(
                    "attempt outcome is uncertain (digest {request_digest}); resuming needs a verified provider continuation (not re-sending)",
                ),
            )),
        }
    }

    /// Record a committed terminal (replayable).
    pub fn record_committed(&mut self, terminal: TerminalResponse) {
        self.entries.insert(
            terminal.attempt_id.clone(),
            AttemptOutcome::Committed(terminal),
        );
    }

    /// Record a terminal failure. The request digest is embedded in the
    /// stored message so replays can prove byte-identity.
    pub fn record_failed(&mut self, attempt_id: &str, request_digest: &str, error: &ModelError) {
        let mut tagged = error.clone();
        tagged
            .message
            .push_str(&format!(" [attempt:{attempt_id} digest:{request_digest}]"));
        // Re-tagging runs outside the redacting constructor; the digest and
        // attempt id are hex digests, never secrets — but re-run redaction
        // defensively so no path can smuggle a secret into the store.
        tagged.message = crate::error::redact(&tagged.message);
        self.entries
            .insert(attempt_id.to_owned(), AttemptOutcome::Failed(tagged));
    }

    /// Record a completed authorized send (grant consumed; never re-sendable).
    /// The request digest binds the record to the exact bytes that left.
    pub fn record_sent(&mut self, attempt_id: &str, request_digest: &str) {
        self.entries.insert(
            attempt_id.to_owned(),
            AttemptOutcome::Sent {
                request_digest: request_digest.to_owned(),
            },
        );
    }

    /// Record an uncertain outcome (never replayable, never re-sendable).
    pub fn record_uncertain(&mut self, attempt_id: &str, request_digest: &str) {
        self.entries.insert(
            attempt_id.to_owned(),
            AttemptOutcome::Uncertain {
                request_digest: request_digest.to_owned(),
            },
        );
    }
}

/// Cooperative cancellation token. Cloned handles share one flag; the
/// transport checks it between events and after connect, so cancellation
/// during streaming stops further reads immediately.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    flag: Arc<AtomicBool>,
}

impl CancellationToken {
    /// Create an uncancelled token.
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cancellation.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    /// True once `cancel()` was called.
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Refuse further work when cancelled. The attempt stays
    /// `stream_partial` (or earlier): cancellation is never terminal.
    pub fn check(&self) -> Result<(), ModelError> {
        if self.is_cancelled() {
            return Err(ModelError::new(
                ModelErrorCode::Cancelled,
                "cancellation requested during streaming (attempt is not terminal)",
            ));
        }
        Ok(())
    }
}
