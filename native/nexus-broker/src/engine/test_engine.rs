//! TEST-ONLY deterministic engine (`effort-test-v0`), compiled only with the `test-engines`
//! feature (enabled for this crate's own tests through its dev-dependency on itself; never in
//! `cargo build` / `--release`). It is selectable only when the Registry issues its id, i.e. from
//! a fixture install root whose engineering-v2 mode names it, so the EM-01 rule (the engine comes
//! from the sealed Registry resolution) holds in tests too.
//!
//! Policy: the effort for the k-th attempt of the WHOLE task (counted across continuations via the
//! inherited `attempts_total`) follows `SCHEDULE` = low, high, low, ... and is proposed at
//! `BeforeRequest` only when it differs from the effort in force. It never guides and finishes on
//! the first reply without a tool call. The payload deliberately has the shape a Muse governor
//! state will need (phase, failure counters, root causes, activity) without implementing them.

use super::{
    EffortProposal, EngineAction, EngineDescriptor, EngineExtension, EngineProposal,
    EngineSnapshot, EngineState, EngineStateData, Hook,
};

pub const SCHEDULE: [&str; 2] = ["low", "high"];

pub static EFFORT_TEST_V0: EffortTestV0 = EffortTestV0 {
    descriptor: EngineDescriptor {
        engine_id: "effort-test-v0",
        contract_version: super::ENGINE_CONTRACT_VERSION,
        mode_ids: &["engineering-v2"],
        roles: &["muse_main"],
        state_schema: 1,
        may_propose_effort: true,
        inherits_state: true,
    },
};

pub struct EffortTestV0 {
    descriptor: EngineDescriptor,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffortTestState {
    /// Proposals made (every hook), across the task's generations.
    pub proposals: u64,
    /// Effort changes proposed.
    pub changes: u32,
    /// Model attempts the engine has seen dispatched, across generations.
    pub attempts_total: u32,
    /// Attempts dispatched in the CURRENT generation when last consulted.
    pub attempts_here: u32,
    /// Muse-shaped fields (not driven by any policy here).
    pub phase: String,
    pub failed_hypotheses: u32,
    pub root_causes: Vec<String>,
}

impl EffortTestState {
    pub(super) fn encoded_len(&self) -> usize {
        96 + self.phase.len() + self.root_causes.iter().map(|r| r.len() + 8).sum::<usize>()
    }
}

/// The effort the schedule wants for the task's attempt number `k` (1-based).
pub fn scheduled(k: u32) -> &'static str {
    SCHEDULE[((k.max(1) - 1) as usize) % SCHEDULE.len()]
}

fn data(s: &EngineState) -> Option<&EffortTestState> {
    match &s.data {
        EngineStateData::EffortTestV0(d) => Some(d),
        #[allow(unreachable_patterns)]
        _ => None,
    }
}

impl EngineExtension for EffortTestV0 {
    fn descriptor(&self) -> &EngineDescriptor {
        &self.descriptor
    }

    fn initial_state(&self) -> EngineState {
        EngineState {
            engine_id: self.descriptor.engine_id,
            schema: 1,
            revision: 0,
            data: EngineStateData::EffortTestV0(EffortTestState {
                phase: "discover".into(),
                ..Default::default()
            }),
        }
    }

    fn propose(
        &self,
        hook: Hook,
        snap: &EngineSnapshot,
        state: &EngineState,
        proposal_id: u64,
    ) -> EngineProposal {
        let mut s = data(state).cloned().unwrap_or_default();
        let new_attempts = snap.attempts_dispatched.saturating_sub(s.attempts_here);
        s.attempts_total += new_attempts;
        s.attempts_here = snap.attempts_dispatched;
        s.proposals += 1;
        let (action, effort) = match hook {
            Hook::BeforeRequest => {
                let want = scheduled(s.attempts_total + 1);
                if want != snap.current_effort {
                    s.changes += 1;
                    (
                        EngineAction::Continue,
                        EffortProposal::Change(want.to_owned()),
                    )
                } else {
                    (EngineAction::Continue, EffortProposal::KeepPinned)
                }
            }
            Hook::AfterToolPhase => (EngineAction::Continue, EffortProposal::KeepPinned),
            Hook::FinalResponse => (EngineAction::Finish, EffortProposal::KeepPinned),
        };
        EngineProposal {
            proposal_id,
            based_on_revision: state.revision,
            action,
            effort,
            next_state: EngineState {
                engine_id: self.descriptor.engine_id,
                schema: 1,
                revision: state.revision + 1,
                data: EngineStateData::EffortTestV0(s),
            },
        }
    }

    fn check_transition(
        &self,
        from: &EngineState,
        to: &EngineState,
        snap: &EngineSnapshot,
    ) -> Result<(), String> {
        let (Some(a), Some(b)) = (data(from), data(to)) else {
            return Err("state data of another engine".into());
        };
        if b.proposals != a.proposals + 1 {
            return Err("proposals must advance by one".into());
        }
        if b.changes < a.changes || b.changes > a.changes + 1 {
            return Err("at most one effort change per proposal".into());
        }
        if b.attempts_here != snap.attempts_dispatched
            || b.attempts_total < a.attempts_total
            || b.attempts_total - a.attempts_total
                != snap.attempts_dispatched.saturating_sub(a.attempts_here)
        {
            return Err("attempt counters must follow the receipts".into());
        }
        if b.root_causes.len() > 8 || b.root_causes.iter().any(|r| r.len() > 200) {
            return Err("root causes out of bounds".into());
        }
        Ok(())
    }

    fn persist_state(&self, state: &EngineState) -> serde_json::Value {
        let s = data(state).cloned().unwrap_or_default();
        serde_json::json!({
            "proposals": s.proposals,
            "changes": s.changes,
            "attemptsTotal": s.attempts_total,
            "attemptsHere": s.attempts_here,
            "phase": s.phase,
            "failedHypotheses": s.failed_hypotheses,
            "rootCauses": s.root_causes,
        })
    }

    fn restore_state(&self, v: &serde_json::Value, revision: u64) -> Option<EngineState> {
        let obj = v.as_object()?;
        let allowed = [
            "proposals",
            "changes",
            "attemptsTotal",
            "attemptsHere",
            "phase",
            "failedHypotheses",
            "rootCauses",
        ];
        if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
            return None;
        }
        let u = |k: &str| obj.get(k).and_then(|x| x.as_u64());
        let roots: Vec<String> = obj
            .get("rootCauses")?
            .as_array()?
            .iter()
            .map(|r| r.as_str().map(str::to_owned))
            .collect::<Option<_>>()?;
        let phase = obj.get("phase")?.as_str()?.to_owned();
        if phase.len() > 32 || roots.len() > 8 || roots.iter().any(|r| r.len() > 200) {
            return None;
        }
        let s = EffortTestState {
            proposals: u("proposals")?,
            changes: u32::try_from(u("changes")?).ok()?,
            attempts_total: u32::try_from(u("attemptsTotal")?).ok()?,
            // a new generation has dispatched nothing yet
            attempts_here: 0,
            phase,
            failed_hypotheses: u32::try_from(u("failedHypotheses")?).ok()?,
            root_causes: roots,
        };
        u("attemptsHere")?;
        Some(EngineState {
            engine_id: self.descriptor.engine_id,
            schema: 1,
            revision,
            data: EngineStateData::EffortTestV0(s),
        })
    }
}
