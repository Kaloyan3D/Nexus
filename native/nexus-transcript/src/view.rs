//! Shared presentation logic: collapse revisions to the latest version of
//! each logical message, preserve order, and page by cursor.

use crate::contract::TranscriptEventV1;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSpec {
    /// Return events with `seq > after_seq` (live follow / forward paging).
    pub after_seq: Option<u64>,
    /// Return the last `limit` events with `seq < before_seq` (load earlier).
    pub before_seq: Option<u64>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub events: Vec<TranscriptEventV1>,
    pub total: u64,
    pub first_seq: Option<u64>,
    pub last_seq: Option<u64>,
    pub has_earlier: bool,
    pub has_later: bool,
    /// Highest store sequence in the transcript: the cursor for live follow.
    pub head_seq: Option<u64>,
}

pub const MAX_PAGE: u32 = 500;

/// Keep only the highest revision per `message_id`, in seq order of the
/// message's first appearance.
pub fn collapse(events: &[TranscriptEventV1]) -> Vec<TranscriptEventV1> {
    let mut latest: HashMap<&str, usize> = HashMap::new();
    for (i, e) in events.iter().enumerate() {
        match latest.get(e.message_id.as_str()) {
            Some(&j) if events[j].revision >= e.revision => {}
            _ => {
                latest.insert(e.message_id.as_str(), i);
            }
        }
    }
    let mut first_pos: HashMap<&str, u64> = HashMap::new();
    for e in events {
        first_pos.entry(e.message_id.as_str()).or_insert(e.seq);
    }
    let mut out: Vec<TranscriptEventV1> = latest
        .values()
        .map(|&i| {
            let mut e = events[i].clone();
            e.revision_seq = e.seq;
            e.seq = first_pos[e.message_id.as_str()];
            e
        })
        .collect();
    out.sort_by_key(|e| (e.seq, e.revision_seq));
    out
}

pub fn page(events: &[TranscriptEventV1], spec: PageSpec) -> Page {
    let all = collapse(events);
    let total = all.len() as u64;
    let limit = spec.limit.clamp(1, MAX_PAGE) as usize;
    let (slice, has_earlier, has_later): (Vec<TranscriptEventV1>, bool, bool) =
        if let Some(after) = spec.after_seq {
            let rest: Vec<_> = all
                .iter()
                .filter(|e| e.revision_seq > after)
                .cloned()
                .collect();
            let more = rest.len() > limit;
            (
                rest.into_iter().take(limit).collect(),
                all.iter().any(|e| e.revision_seq <= after),
                more,
            )
        } else {
            let eligible: Vec<_> = match spec.before_seq {
                Some(b) => all.iter().filter(|e| e.seq < b).cloned().collect(),
                None => all.clone(),
            };
            let n = eligible.len();
            let start = n.saturating_sub(limit);
            let later = spec.before_seq.is_some()
                && all.iter().any(|e| e.seq >= spec.before_seq.unwrap_or(0));
            (eligible[start..].to_vec(), start > 0, later)
        };
    Page {
        first_seq: slice.first().map(|e| e.seq),
        last_seq: slice.last().map(|e| e.seq),
        events: slice,
        total,
        has_earlier,
        has_later,
        head_seq: events.iter().map(|e| e.seq).max(),
    }
}
