//! In-memory view of a run's evidence, rebuilt deterministically from the durable log.

use super::evidence::EvidenceRecord;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inserted {
    New,
    /// The same evidence id with identical content: a replay. Nothing changed.
    Duplicate,
    /// The same evidence id with DIFFERENT content: the first record is kept, the second is
    /// reported, never merged.
    Conflict,
}

#[derive(Debug, Default, Clone)]
pub struct Ledger {
    by_id: BTreeMap<String, EvidenceRecord>,
}

impl Ledger {
    pub fn insert(&mut self, rec: EvidenceRecord) -> Inserted {
        match self.by_id.get(&rec.evidence_id) {
            None => {
                self.by_id.insert(rec.evidence_id.clone(), rec);
                Inserted::New
            }
            Some(old) if same_observation(old, &rec) => Inserted::Duplicate,
            Some(_) => Inserted::Conflict,
        }
    }

    /// What `insert` would do, without doing it.
    pub fn check(&self, rec: &EvidenceRecord) -> Inserted {
        match self.by_id.get(&rec.evidence_id) {
            None => Inserted::New,
            Some(old) if same_observation(old, rec) => Inserted::Duplicate,
            Some(_) => Inserted::Conflict,
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.by_id.contains_key(id)
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// Records in call order (ties broken by id), the same for any insertion order.
    pub fn records(&self) -> Vec<&EvidenceRecord> {
        let mut v: Vec<&EvidenceRecord> = self.by_id.values().collect();
        v.sort_by(|a, b| (a.call_index, &a.evidence_id).cmp(&(b.call_index, &b.evidence_id)));
        v
    }

    /// Recognized checks whose process exited 0 under the Kernel's pass verdict.
    pub fn check_exit_zero_count(&self) -> usize {
        self.by_id
            .values()
            .filter(|r| r.is_check_process_exit_zero())
            .count()
    }

    /// Records where the legacy and the new classification disagree (diagnostic only).
    pub fn shadow_differences(&self) -> Vec<&EvidenceRecord> {
        self.records()
            .into_iter()
            .filter(|r| r.shadow.as_ref().is_some_and(|s| s.difference.is_some()))
            .collect()
    }
}

/// Equality ignoring the observation time (a replay is observed again at a later time).
fn same_observation(a: &EvidenceRecord, b: &EvidenceRecord) -> bool {
    let mut b = b.clone();
    b.provenance.observed_at_ms = a.provenance.observed_at_ms;
    *a == b
}
