//! Streaming event semantics shared by CLI and future GUI (A2.4 Phase 2/5).
//!
//! Ordering: journal events arrive in durable store order; mock-run SSE
//! events arrive in wire order. Cancellation is cooperative: the token
//! stops further reads immediately and the attempt stays non-terminal
//! (never re-sent). Disconnected clients observe `disconnected`, never a
//! synthesized terminal.

use crate::config::ClientConfig;
use crate::error::ClientError;

/// One streamed client event (wire order preserved).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientEvent {
    pub seq: u64,
    pub kind: String,
    pub detail: String,
}

/// Poll the daemon journal once and normalize into ordered client events.
pub fn poll_journal(cfg: &ClientConfig, limit: u64) -> Result<Vec<ClientEvent>, ClientError> {
    let j = crate::api::journal(cfg, limit)?;
    let events = j
        .get("events")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(events
        .iter()
        .enumerate()
        .map(|(i, e)| ClientEvent {
            seq: i as u64,
            kind: e
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("journal")
                .to_owned(),
            detail: e.to_string().chars().take(300).collect(),
        })
        .collect())
}
