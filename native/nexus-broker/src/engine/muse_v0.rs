//! `muse-v0`: a NATIVE COMPATIBILITY ADAPTER for Engineering Mode v2 - NOT EMv2 parity.
//!
//! It is the strategy the Native generic turn loop already had, behind the extension boundary.
//! It is not the DSH Engineering Mode v2 (Muse) runtime: the Muse Reasoning Governor, adaptive
//! effort, `muse_update_reasoning_state`, EMv2's verification/review discipline and the DSH
//! Controller's phase model are all ABSENT here (see the EM-01 specification, "What muse-v0 is
//! not"). The Registry engine id `muse-v0` names this adapter, not a port of Muse.
//!
//! EM-01 scope: exactly the strategy the generic turn loop applied before the extension
//! boundary existed, moved here unchanged - the stop/nudge policy for a reply without a tool
//! call (with its progress-refreshed stall budgets) and the "start implementing" steer after a
//! tool phase. The reasoning effort is never changed (the Muse Reasoning Governor is NOT
//! active in EM-01). Its counters are this engine's revisioned state.

use super::{
    EffortProposal, EngineAction, EngineDescriptor, EngineExtension, EngineProposal,
    EngineSnapshot, EngineState, EngineStateData, Guidance, GuidanceKind, Hook, RunKind,
};
use crate::completion;

/// Times the harness will ask a model that stopped early to carry on.
pub const MAX_NUDGES: u32 = 7;
/// Bounds of the individual stall budgets (as before EM-01).
pub const MAX_REPORT_NUDGES: u32 = 3;
pub const MAX_VERIFY_NUDGES: u32 = 3;
pub const MAX_FAIL_NUDGES: u32 = 2;
pub const MAX_TIDY_NUDGES: u32 = 1;
/// Normalized progress sentences remembered (a narration loop shows here).
pub const NARRATION_WINDOW: usize = 4;

/// The `muse-v0` compatibility adapter (the only built-in engine in EM-01).
pub static MUSE_V0: MuseV0 = MuseV0 {
    descriptor: EngineDescriptor {
        engine_id: "muse-v0",
        contract_version: super::ENGINE_CONTRACT_VERSION,
        mode_ids: &["engineering-v2"],
        roles: &["muse_main"],
        state_schema: 1,
        may_propose_effort: false,
        // EM-01 behaviour: every task generation (incl. a continuation) starts from scratch
        inherits_state: false,
        request_reserve_bytes: 0,
    },
};

pub struct MuseV0 {
    descriptor: EngineDescriptor,
}

/// M7D: the jobs variant of `muse-v0` — identical run logic, a catalog that additionally
/// carries the four broker-handled background-job tools (`RepoCodeJobsV1`).
pub const JOBS_ENGINE_ID: &str = "muse-v0-jobs";
pub static MUSE_V0_JOBS: MuseV0 = MuseV0 {
    descriptor: EngineDescriptor {
        engine_id: JOBS_ENGINE_ID,
        contract_version: super::ENGINE_CONTRACT_VERSION,
        mode_ids: &["engineering-v2-jobs"],
        roles: &["muse_main"],
        state_schema: 1,
        may_propose_effort: false,
        inherits_state: false,
        request_reserve_bytes: 0,
    },
};

/// Engine state: the stall budgets and the narration window. Nothing else.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MuseV0State {
    /// Times the model was asked to continue after stopping early.
    pub nudges: u32,
    pub plan_nudges: u32,
    pub verify_nudges: u32,
    pub fail_nudges: u32,
    pub report_nudges: u32,
    pub tidy_nudges: u32,
    pub steers: u32,
    /// edits + checks at the last stall-budget refresh.
    pub progress_mark: u32,
    pub recent_narration: Vec<String>,
}

impl MuseV0State {
    pub(super) fn encoded_len(&self) -> usize {
        64 + self
            .recent_narration
            .iter()
            .map(|s| s.len() + 8)
            .sum::<usize>()
    }
}

fn data(s: &EngineState) -> &MuseV0State {
    static FOREIGN: MuseV0State = MuseV0State {
        nudges: 0,
        plan_nudges: 0,
        verify_nudges: 0,
        fail_nudges: 0,
        report_nudges: 0,
        tidy_nudges: 0,
        steers: 0,
        progress_mark: 0,
        recent_narration: Vec::new(),
    };
    match &s.data {
        EngineStateData::MuseV0(d) => d,
        // only reachable with another engine's data, which `check_transition` refuses
        #[allow(unreachable_patterns)]
        _ => &FOREIGN,
    }
}

/// A reply that has the shape of a finished written report (long and structured).
pub(crate) fn looks_like_report(t: &str) -> bool {
    t.len() >= 1500
        && t.lines().any(|l| {
            let l = l.trim_start();
            l.starts_with('#')
                || l.starts_with("**")
                || l.starts_with("- ")
                || l.starts_with("* ")
                || l.split_once('.')
                    .is_some_and(|(n, _)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
}

/// The nudge budgets bound CONSECUTIVE stalls, not the length of a run. Found live: a productive
/// run (20 edits, 7 files, 4 test runs) ended "incomplete" at turn 120 because the model's habit of
/// ending turns on "Next: ..." had used the run-wide budget of 5 over those 120 turns. A real edit or
/// check since the last refresh proves the earlier stalls were overcome, so the budgets start over.
///
/// What counts as progress: an edit, or a verification that RESOLVED an outstanding failure. Re-running a
/// check that already passed does not (found live: a resumed run re-ran passing checks about 75 times while the
/// host kept refusing to finish, each re-run resetting the very cap meant to end that).
pub(crate) fn progress_of(snap: &EngineSnapshot) -> u32 {
    snap.edits_used + snap.resolved_checks
}

pub(crate) fn refresh_stall_budget(s: &mut MuseV0State, snap: &EngineSnapshot) {
    let progress = progress_of(snap);
    if progress > s.progress_mark {
        s.progress_mark = progress;
        s.nudges = 0;
        s.plan_nudges = 0;
        s.report_nudges = 0;
        s.verify_nudges = 0;
        s.fail_nudges = 0;
    }
}

/// Should the harness refuse to accept this reply as the end of the task? Returns the
/// message to send the model and a short reason for the timeline. The check is about the
/// SHAPE of the stop (work visibly unfinished), never about the quality of the answer.
pub(crate) fn premature_stop(
    s: &mut MuseV0State,
    snap: &EngineSnapshot,
    text: &str,
) -> Option<(&'static str, &'static str)> {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    // 0. an implementation was asked for, nothing was changed and nothing was verified, yet
    //    the model ended on a plan or on tool calls written as prose (found live: a 40 KB
    //    planning ramble was accepted as the finished task)
    if snap.expects_change
        && snap.applied_edits == 0
        && snap.last_test.as_deref() != Some("pass")
        && s.plan_nudges < completion::MAX_PLAN_NUDGES
    {
        if completion::text_tool_calls(t) {
            s.plan_nudges += 1;
            return Some((completion::MSG_TEXT_CALLS, "tool calls written as text"));
        }
        if completion::plan_like(t) || t.is_empty() || (snap.tool_calls == 0 && !snap.carried_work)
        {
            s.plan_nudges += 1;
            return Some((completion::MSG_PLAN, "a plan instead of the work"));
        }
    }
    // 0b. changes exist, but the model stopped on "now the next step" (found live: five edits,
    //     then a one-line announcement was accepted as the end of the task)
    if snap.expects_change
        && s.plan_nudges < completion::MAX_PLAN_NUDGES
        && completion::announcement(t)
    {
        s.plan_nudges += 1;
        return Some((
            completion::MSG_ANNOUNCE,
            "an announcement instead of the step",
        ));
    }
    // 1. an announcement of the next step instead of the step
    const MIDFLIGHT: [&str; 10] = [
        "re-issuing",
        "reissuing",
        "let me ",
        "i'll ",
        "i will ",
        "now i",
        "next, i",
        "continuing",
        "going to ",
        "proceeding",
    ];
    if snap.tool_calls > 0
        && t.len() < 700
        && (t.is_empty() || MIDFLIGHT.iter().any(|m| lower.contains(m)))
    {
        return Some((
            "You ended your turn without making the next tool call or writing the final answer. Continue the work now: call the tools you need, or if you are finished, write the complete final answer (for a review, the full report with evidence).",
            "no tool call and no final answer",
        ));
    }
    // 1b. a long investigation that ends without a written report
    if snap.edits_used == 0
        && snap.last_test.is_none()
        && snap.tool_calls >= 8
        && s.report_nudges < MAX_REPORT_NUDGES
        && !looks_like_report(t)
    {
        s.report_nudges += 1;
        return Some((
            "Your last message is not a finished report. Do not plan or narrate further. If you still need evidence, make the tool calls now (one call per step is fine). Otherwise write the COMPLETE final report now as your reply: headings, each finding with severity, the file path and line numbers you actually read, why it matters and a recommended fix, then a prioritized summary and what you did not inspect.",
            "no finished report yet",
        ));
    }
    // 1c. scratch files left in the project
    if s.tidy_nudges < MAX_TIDY_NUDGES {
        let junk = snap.created_files.iter().any(|p| {
            let l = p.to_ascii_lowercase();
            [".new", ".bak", ".orig", ".tmp", ".old", "~"]
                .iter()
                .any(|e| l.ends_with(e))
        });
        if junk {
            s.tidy_nudges += 1;
            return Some((
                "You left scratch files in the project that are not part of the change. Delete them now with fs_write mode \"delete\" (and only them), then give your final answer.",
                "scratch files left behind",
            ));
        }
    }
    // 2. changes that were never verified
    if snap.edits_used > 0
        && snap.dirty_since_test
        && s.verify_nudges
            < if snap.expects_change {
                MAX_VERIFY_NUDGES
            } else {
                1
            }
    {
        s.verify_nudges += 1;
        return Some((
            "You changed files but no build, test or type-check has run since your last change. Run the project's verification now (install dependencies first if they are missing) and fix anything that fails. Only then give your final answer.",
            "changes not verified",
        ));
    }
    // 3a. verification commands are still failing although the LAST one passed (a narrower command
    //     hides them; found live: five unresolved failures and a closing 15 KB narration)
    if snap.last_test.as_deref() != Some("fail")
        && snap.failed_checks > 0
        && snap.edits_used > 0
        && s.fail_nudges < MAX_FAIL_NUDGES
    {
        s.fail_nudges += 1;
        return Some((
            completion::MSG_UNRESOLVED_CHECKS,
            "failed checks never re-run successfully",
        ));
    }
    // 3. the last verification failed
    if snap.last_test.as_deref() == Some("fail")
        && snap.edits_used > 0
        && s.fail_nudges < MAX_FAIL_NUDGES
    {
        s.fail_nudges += 1;
        return Some((
            "Your last verification command failed. Read its output. If your change caused it, fix the cause and run it again. If the failure was already there and is unrelated to the task, do not widen the task to fix it: say so explicitly in your final answer with the evidence.",
            "last verification failed",
        ));
    }
    None
}

/// After a tool phase: remember the progress sentence and, for an implementation task that keeps
/// reading (a block of tool calls with no change, or the same progress sentence three turns
/// running), tell the model to start. Bounded; it creates no side effect and does not stop the run.
pub(crate) fn steer(s: &mut MuseV0State, snap: &EngineSnapshot) -> Option<String> {
    s.recent_narration
        .push(completion::normalize_narration(&snap.response_text));
    if s.recent_narration.len() > NARRATION_WINDOW {
        s.recent_narration.remove(0);
    }
    if snap.expects_change && snap.applied_edits == 0 && s.steers < completion::MAX_STEERS {
        let due = snap.tool_calls >= completion::STEER_EVERY * (s.steers + 1);
        if due || completion::repeated_narration(&s.recent_narration) {
            s.steers += 1;
            s.recent_narration.clear();
            return Some(completion::steer_message(snap.tool_calls));
        }
    }
    None
}

impl EngineExtension for MuseV0 {
    fn descriptor(&self) -> &EngineDescriptor {
        &self.descriptor
    }

    /// EM-03 persisted form: the counters as they are; the narration window (normalized MODEL
    /// text) only as SHA-256 digests, so no model output is written to the engine state store.
    fn persist_state(&self, state: &EngineState) -> serde_json::Value {
        let s = data(state);
        let digests: Vec<String> = s
            .recent_narration
            .iter()
            .map(|n| nexus_contracts::sha256_hex(n))
            .collect();
        serde_json::json!({
            "nudges": s.nudges,
            "planNudges": s.plan_nudges,
            "verifyNudges": s.verify_nudges,
            "failNudges": s.fail_nudges,
            "reportNudges": s.report_nudges,
            "tidyNudges": s.tidy_nudges,
            "steers": s.steers,
            "progressMark": s.progress_mark,
            "narrationDigests": digests,
        })
    }

    fn initial_state(&self) -> EngineState {
        EngineState {
            engine_id: self.descriptor.engine_id,
            schema: self.descriptor.state_schema,
            revision: 0,
            data: EngineStateData::MuseV0(MuseV0State::default()),
        }
    }

    fn propose(
        &self,
        hook: Hook,
        snap: &EngineSnapshot,
        state: &EngineState,
        proposal_id: u64,
    ) -> EngineProposal {
        let mut s = data(state).clone();
        let action = match hook {
            Hook::BeforeRequest => EngineAction::Continue,
            Hook::AfterToolPhase => match steer(&mut s, snap) {
                Some(message) => EngineAction::Guide(Guidance {
                    message,
                    reason: "no change yet".into(),
                    kind: GuidanceKind::Steer,
                    ordinal: s.steers,
                }),
                None => EngineAction::Continue,
            },
            Hook::FinalResponse => {
                refresh_stall_budget(&mut s, snap);
                let gated =
                    snap.interactive && snap.kind == Some(RunKind::Code) && s.nudges < MAX_NUDGES;
                match gated
                    .then(|| premature_stop(&mut s, snap, &snap.response_text))
                    .flatten()
                {
                    Some((message, reason)) => {
                        s.nudges += 1;
                        // name the unresolved commands instead of repeating the generic refusal
                        let message = if reason == "failed checks never re-run successfully"
                            && !snap.unresolved_checks.is_empty()
                        {
                            completion::unresolved_checks_message(
                                &snap.unresolved_checks,
                                &snap.passed_checks,
                            )
                        } else {
                            message.to_owned()
                        };
                        EngineAction::Guide(Guidance {
                            message,
                            reason: reason.to_owned(),
                            kind: GuidanceKind::Nudge,
                            ordinal: s.nudges,
                        })
                    }
                    None => EngineAction::Finish,
                }
            }
        };
        EngineProposal {
            proposal_id,
            based_on_revision: state.revision,
            action,
            // EM-01: the Muse Reasoning Governor is not active; the pinned effort is kept.
            effort: EffortProposal::KeepPinned,
            next_state: EngineState {
                engine_id: state.engine_id,
                schema: state.schema,
                revision: state.revision + 1,
                data: EngineStateData::MuseV0(s),
            },
        }
    }

    fn check_transition(
        &self,
        from: &EngineState,
        to: &EngineState,
        snap: &EngineSnapshot,
    ) -> Result<(), String> {
        #[allow(irrefutable_let_patterns)]
        let (EngineStateData::MuseV0(_), EngineStateData::MuseV0(_)) = (&from.data, &to.data) else {
            return Err("state data of another engine".into());
        };
        let (a, b) = (data(from), data(to));
        let progress = progress_of(snap);
        let reset_ok = progress > a.progress_mark;
        if !(b.progress_mark == a.progress_mark || (reset_ok && b.progress_mark == progress)) {
            return Err("progress mark may only move to the receipts' progress".into());
        }
        let resettable = [
            ("nudges", a.nudges, b.nudges, MAX_NUDGES),
            (
                "plan_nudges",
                a.plan_nudges,
                b.plan_nudges,
                completion::MAX_PLAN_NUDGES,
            ),
            (
                "report_nudges",
                a.report_nudges,
                b.report_nudges,
                MAX_REPORT_NUDGES,
            ),
            (
                "verify_nudges",
                a.verify_nudges,
                b.verify_nudges,
                MAX_VERIFY_NUDGES,
            ),
            ("fail_nudges", a.fail_nudges, b.fail_nudges, MAX_FAIL_NUDGES),
        ];
        for (name, x, y, cap) in resettable {
            let step = y == x || y == x + 1 || (reset_ok && y <= 1);
            if !step || y > cap {
                return Err(format!("{name} {x} -> {y} is not a valid transition"));
            }
        }
        let monotonic = [
            ("tidy_nudges", a.tidy_nudges, b.tidy_nudges, MAX_TIDY_NUDGES),
            ("steers", a.steers, b.steers, completion::MAX_STEERS),
        ];
        for (name, x, y, cap) in monotonic {
            if !(y == x || y == x + 1) || y > cap {
                return Err(format!("{name} {x} -> {y} is not a valid transition"));
            }
        }
        if b.recent_narration.len() > NARRATION_WINDOW
            || b.recent_narration.iter().any(|n| n.len() > 1024)
        {
            return Err("narration window out of bounds".into());
        }
        Ok(())
    }
}
