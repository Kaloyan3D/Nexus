//! EM-01: the Engineering Mode extension boundary (contract version 1).
//!
//! An Engineering Mode decides *strategy* (when to keep the model working, what bounded
//! guidance to give it, how much reasoning to ask for). The Native Core decides *execution*
//! (transport, tools, sandbox, Kernel authorization, durable records). This module is the one
//! seam between the two inside the broker's turn loop:
//!
//! * the Core builds a read-only [`EngineSnapshot`] of receipts (never handles, grants,
//!   credentials, targets or paths) at a fixed [`Hook`];
//! * the selected [`EngineExtension`] answers with an [`EngineProposal`];
//! * the Core's [`EngineHost`] validates the proposal BEFORE anything happens - engine
//!   identity, revision, proposal id, the action admitted for that hook, the effort proposal,
//!   guidance bounds, and the engine's typed state transition - and only then commits the new
//!   engine state and returns an [`EngineDecision`] for the Core to carry out.
//!
//! Authority that never moves into an engine:
//! * Registry: provider, model, route and reasoning effort (the run's pinned target). Contract
//!   v1 admits no effort change at all ([`EffortProposal::KeepPinned`] only).
//! * Controller: task lifecycle and completion. An engine may only propose `Finish`; the
//!   completion verdict (`completion::decide_run`) is computed from receipts by the Core.
//! * Core/Kernel: tool execution, approvals, grants, sandbox, verification truth.
//!
//! The extension is selected from the SEALED Registry resolution (`modeId` +
//! `orchestrationEngineId`) of the run; an engine that is not built in fails closed before
//! any provider request. Extensions are compiled in (no runtime registration).

pub mod muse_v0;
#[cfg(feature = "test-engines")]
pub mod test_engine;
#[cfg(feature = "test-engines")]
pub mod test_faults;

/// Version of this contract. A change of any type below bumps it.
pub const ENGINE_CONTRACT_VERSION: u32 = 2;
/// EM-03: contract v2 adds effort proposals for the NEXT attempt (within the task binding's
/// authorized levels), durable engine state (`engine_state.rs`) and continuation inheritance.
/// Largest guidance message an engine may ask the Core to send (it becomes request bytes).
pub const MAX_GUIDANCE_BYTES: usize = 2048;
/// The engine of runs recorded before EM-01: the inline Native loop, which `muse-v0` reproduces
/// decision for decision (differential parity test).
pub const LEGACY_NATIVE_ENGINE: &str = "muse-v0";
/// Largest serialized engine state.
pub const MAX_STATE_BYTES: usize = 16 * 1024;

/// What an engine is and what it may ask for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineDescriptor {
    /// Registry `orchestrationEngineId` this extension implements (e.g. `muse-v0`).
    pub engine_id: &'static str,
    /// Contract version the extension was written against.
    pub contract_version: u32,
    /// Registry mode ids the engine may run (e.g. `engineering-v2`).
    pub mode_ids: &'static [&'static str],
    /// Registry internal roles the engine drives (one in v1: single-agent engines only).
    pub roles: &'static [&'static str],
    /// Schema version of the engine's own state.
    pub state_schema: u32,
    /// Whether the engine may propose an effort different from the pinned target. Always
    /// `false` in contract v1 (the Registry-authorized per-attempt issuance does not exist).
    pub may_propose_effort: bool,
    /// EM-03: whether a continuation inherits this engine's persisted payload (validated by the
    /// engine's `restore_state`). `false` = every task generation starts from `initial_state`.
    pub inherits_state: bool,
}

/// Where in the turn loop the Core consults the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hook {
    /// Before a provider request is prepared.
    BeforeRequest,
    /// The response carried tool calls and they have all been handled.
    AfterToolPhase,
    /// The response carried no tool call (the model would end its turn here).
    FinalResponse,
}

/// The kind of run (the loop serves both read-only inspection and coding).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunKind {
    Inspect,
    Code,
}

/// Read-only execution facts. Receipts recorded by the Core (never model claims), the task's
/// intent as classified by the Controller, and the response the hook is about.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EngineSnapshot {
    pub kind: Option<RunKind>,
    /// Interactive (autonomy-first) profile; the strict profile asks for no guidance.
    pub interactive: bool,
    /// Provider turn number.
    pub turn: u32,
    /// Tool calls made so far (proposals that reached validation).
    pub tool_calls: u32,
    /// Mutations and commands approved for this run (budget counters).
    pub edits_used: u32,
    pub tests_used: u32,
    /// Edits and writes that really executed.
    pub applied_edits: u32,
    /// Verdict of the latest verification command (`pass` / `fail` / `unverified`).
    pub last_test: Option<String>,
    /// A file changed after the last verification command.
    pub dirty_since_test: bool,
    /// Verification commands whose latest result is a failure.
    pub failed_checks: u32,
    /// Files this run created and has not deleted.
    pub created_files: Vec<String>,
    /// The request asks for an implementation (Controller classification).
    pub expects_change: bool,
    /// The copy already holds changes of earlier runs.
    pub carried_work: bool,
    /// Text of the response this hook is about (empty for `BeforeRequest`).
    pub response_text: String,
    /// EM-03: model attempts dispatched so far in this run (the next attempt is this + 1).
    pub attempts_dispatched: u32,
    /// EM-03: the effort the next attempt will use unless a proposal changes it.
    pub current_effort: String,
    /// EM-03: the levels the task binding authorizes (TaskBindingV1.supportedReasoning).
    pub authorized_efforts: Vec<String>,
}

/// What the engine asks the Core to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineAction {
    /// Proceed normally (the only action at `BeforeRequest` and the default after tools).
    Continue,
    /// Keep the model working: the Core appends the model's own reply (when there is one)
    /// and this guidance as the next user message.
    Guide(Guidance),
    /// The engine sees no reason to keep going; the Controller decides completion.
    Finish,
    /// Not admitted in contract v1 (reserved: Controller-run verification).
    RequestVerification,
    /// Not admitted in contract v1 (reserved: operator question).
    AskOperator,
    /// Not admitted in contract v1 (reserved: EMv3 child runs).
    RequestChildRun,
}

/// One bounded guidance message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guidance {
    /// Exact text sent to the model.
    pub message: String,
    /// Short reason shown in the timeline.
    pub reason: String,
    /// `Nudge` after a final response, `Steer` after a tool phase.
    pub kind: GuidanceKind,
    /// 1-based count of this kind in the run (shown in the timeline).
    pub ordinal: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuidanceKind {
    Nudge,
    Steer,
}

/// Reasoning effort for the NEXT model attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffortProposal {
    /// Keep the effort currently in force (initially the task's pinned default).
    KeepPinned,
    /// From the next attempt on, use this level. Admitted (contract v2) only for an engine whose
    /// descriptor declares `may_propose_effort`, only for a level the task binding authorizes,
    /// and never together with `Finish`. The Registry then issues and the Kernel seals that
    /// attempt's target; an existing issuance is never altered.
    Change(String),
}

/// EM-03: an accepted effort selection: in force from attempt `from_attempt` (1-based) on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortSelection {
    pub effort: String,
    pub from_attempt: u32,
    pub proposal_id: u64,
}

/// An engine's revisioned state. `data` is the engine's own typed state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineState {
    pub engine_id: &'static str,
    pub schema: u32,
    pub revision: u64,
    pub data: EngineStateData,
}

/// Typed state of each built-in engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineStateData {
    MuseV0(muse_v0::MuseV0State),
    /// Test-only deterministic engine (feature `test-engines`, never in production builds).
    #[cfg(feature = "test-engines")]
    EffortTestV0(test_engine::EffortTestState),
}

impl EngineStateData {
    fn encoded_len(&self) -> usize {
        match self {
            Self::MuseV0(s) => s.encoded_len(),
            #[cfg(feature = "test-engines")]
            Self::EffortTestV0(s) => s.encoded_len(),
        }
    }
}

/// One proposal. `next_state` is the complete state the engine wants after this proposal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineProposal {
    pub proposal_id: u64,
    pub based_on_revision: u64,
    pub action: EngineAction,
    pub effort: EffortProposal,
    pub next_state: EngineState,
}

/// An Engineering Mode extension. Implementations are pure with respect to the Core: they see
/// a snapshot and their own state and return a proposal; they hold no handles.
pub trait EngineExtension: Send + Sync {
    fn descriptor(&self) -> &EngineDescriptor;
    /// State of a new run (revision 0).
    fn initial_state(&self) -> EngineState;
    /// The engine's answer at `hook`.
    fn propose(
        &self,
        hook: Hook,
        snapshot: &EngineSnapshot,
        state: &EngineState,
        proposal_id: u64,
    ) -> EngineProposal;
    /// Engine-specific transition rules, checked by the host before a state is committed.
    fn check_transition(
        &self,
        from: &EngineState,
        to: &EngineState,
        snapshot: &EngineSnapshot,
    ) -> Result<(), String>;
    /// EM-03: the persistable form of `state.data` (bounded; no model text, no secrets). The
    /// Core owns persistence; the engine only says what its payload looks like on disk.
    fn persist_state(&self, state: &EngineState) -> serde_json::Value;
    /// EM-03: rebuild a state from its persisted payload for an inheriting continuation.
    /// `None` = invalid (the continuation fails closed) or not inheritable.
    fn restore_state(&self, _payload: &serde_json::Value, _revision: u64) -> Option<EngineState> {
        None
    }
}

/// A refused selection or proposal. The run fails closed with this code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineRefusal {
    pub code: &'static str,
    pub message: String,
}

fn refuse(code: &'static str, message: impl Into<String>) -> EngineRefusal {
    EngineRefusal {
        code,
        message: message.into(),
    }
}

/// The compiled-in engines. The test engine exists only in `test-engines` builds (tests); it
/// is selectable only if the Registry issues its id (a fixture mode), like any other engine.
fn built_in() -> Vec<&'static dyn EngineExtension> {
    #[allow(unused_mut)]
    let mut v: Vec<&'static dyn EngineExtension> = vec![&muse_v0::MUSE_V0];
    #[cfg(feature = "test-engines")]
    v.push(&test_engine::EFFORT_TEST_V0);
    v
}

/// Resolve the extension for a run from its SEALED Registry resolution. Unknown or
/// unavailable engines, and an engine not declared for the mode, fail closed.
pub fn resolve(
    mode_id: &str,
    orchestration_engine_id: &str,
) -> Result<&'static dyn EngineExtension, EngineRefusal> {
    let Some(ext) = built_in()
        .into_iter()
        .find(|e| e.descriptor().engine_id == orchestration_engine_id)
    else {
        return Err(refuse(
            "engine-unavailable",
            format!(
                "the Registry selected orchestration engine '{}' for mode '{}', and this runtime has no such engine; nothing was sent",
                safe(orchestration_engine_id),
                safe(mode_id)
            ),
        ));
    };
    if !ext.descriptor().mode_ids.contains(&mode_id) {
        return Err(refuse(
            "engine-mode-mismatch",
            format!(
                "orchestration engine '{}' does not run mode '{}'; nothing was sent",
                ext.descriptor().engine_id,
                safe(mode_id)
            ),
        ));
    }
    if ext.descriptor().contract_version != ENGINE_CONTRACT_VERSION {
        return Err(refuse(
            "engine-contract-mismatch",
            "the engine was written against another extension contract version",
        ));
    }
    Ok(ext)
}

/// Resolve the extension from a Registry resolution as issued: the TYPED resolution, accepted
/// only when its content digest equals its issuanceId (the id the Kernel seals and binds every
/// attempt to), so the engine identity cannot differ from the sealed one. Returns the engine and
/// the issued mode id.
pub fn resolve_issued(
    resolution: &serde_json::Value,
) -> Result<(&'static dyn EngineExtension, String), EngineRefusal> {
    let typed: nexus_contracts::RegistryResolutionV1 = serde_json::from_value(resolution.clone())
        .map_err(|_| {
        refuse(
            "engine-identity-invalid",
            "the Registry resolution is not a valid resolution; nothing was sent",
        )
    })?;
    if typed.issuance_id_of() != typed.provenance.issuance_id {
        return Err(refuse(
            "engine-identity-invalid",
            "the Registry resolution does not match its issuance id; nothing was sent",
        ));
    }
    let ext = resolve(&typed.target.mode_id, &typed.target.orchestration_engine_id)?;
    Ok((ext, typed.target.mode_id))
}

fn safe(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(64)
        .collect()
}

/// What the Core carries out after a proposal was accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineDecision {
    Continue,
    Guide(Guidance),
    Finish,
}

/// Receipt of one accepted proposal (in memory, per run).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalReceipt {
    pub proposal_id: u64,
    pub hook: Hook,
    pub revision: u64,
    /// EM-03: the effort selection this proposal made, if any.
    pub effort: Option<EffortSelection>,
}

/// The Core side of the boundary for ONE run: owns the engine state, validates every proposal
/// and commits accepted state. Never shared between runs.
pub struct EngineHost {
    ext: &'static dyn EngineExtension,
    state: EngineState,
    next_proposal: u64,
    receipts: Vec<ProposalReceipt>,
    /// EM-03: the effort selection in force (None = the task's pinned default).
    effort: Option<EffortSelection>,
}

impl EngineHost {
    pub fn new(ext: &'static dyn EngineExtension) -> Self {
        Self {
            ext,
            state: ext.initial_state(),
            next_proposal: 1,
            receipts: Vec::new(),
            effort: None,
        }
    }

    /// EM-03: a host resuming durable state (`engine_state.rs` validated it). Proposal ids
    /// continue after `last_proposal_id`, so a pre-restart id can never be accepted again.
    pub fn restored(
        ext: &'static dyn EngineExtension,
        state: EngineState,
        last_proposal_id: u64,
        effort: Option<EffortSelection>,
    ) -> Self {
        Self {
            ext,
            state,
            next_proposal: last_proposal_id + 1,
            receipts: Vec::new(),
            effort,
        }
    }

    pub fn extension(&self) -> &'static dyn EngineExtension {
        self.ext
    }

    /// The id the next proposal must carry (= last accepted id + 1).
    pub fn next_proposal_id(&self) -> u64 {
        self.next_proposal
    }

    /// The effort selection in force (None = the pinned default).
    pub fn effort_selection(&self) -> Option<&EffortSelection> {
        self.effort.as_ref()
    }

    /// The effort for model attempt `ordinal` (1-based), or None for the pinned default. A
    /// selection is effective only from its designated attempt on, never retroactively.
    pub fn effort_for_attempt(&self, ordinal: u32) -> Option<&str> {
        self.effort
            .as_ref()
            .filter(|e| ordinal >= e.from_attempt)
            .map(|e| e.effort.as_str())
    }

    pub fn engine_id(&self) -> &'static str {
        self.ext.descriptor().engine_id
    }

    pub fn state(&self) -> &EngineState {
        &self.state
    }

    pub fn receipts(&self) -> &[ProposalReceipt] {
        &self.receipts
    }

    /// Ask the engine at `hook` and validate its proposal. On success the new state is
    /// committed and the decision returned; on refusal nothing changes.
    pub fn consult(
        &mut self,
        hook: Hook,
        snapshot: &EngineSnapshot,
    ) -> Result<EngineDecision, EngineRefusal> {
        let p = self
            .ext
            .propose(hook, snapshot, &self.state, self.next_proposal);
        self.accept(hook, snapshot, p)
    }

    /// Validation and commit (separate from `consult` so any proposal can be tested).
    pub fn accept(
        &mut self,
        hook: Hook,
        snapshot: &EngineSnapshot,
        p: EngineProposal,
    ) -> Result<EngineDecision, EngineRefusal> {
        let d = self.ext.descriptor();
        if p.proposal_id != self.next_proposal {
            return Err(refuse(
                "engine-proposal-replayed",
                "the proposal id is not the next one for this run (duplicate or out of order)",
            ));
        }
        if p.based_on_revision != self.state.revision {
            return Err(refuse(
                "engine-state-stale",
                "the proposal was based on another engine state revision",
            ));
        }
        // effort (contract v2): only an effort-capable engine, only a level the task binding
        // authorizes, never while finishing; effective from the NEXT attempt. The Registry and the
        // Kernel authorize and seal that attempt's target; this is the first of three gates.
        let effort = match &p.effort {
            EffortProposal::KeepPinned => None,
            EffortProposal::Change(level) => {
                if !d.may_propose_effort {
                    return Err(refuse(
                        "engine-effort-not-authorized",
                        "this engine may not change the reasoning effort of the pinned target",
                    ));
                }
                if matches!(p.action, EngineAction::Finish) {
                    return Err(refuse(
                        "engine-effort-not-admitted",
                        "an effort change cannot accompany Finish",
                    ));
                }
                if !snapshot.authorized_efforts.iter().any(|l| l == level) {
                    return Err(refuse(
                        "engine-effort-not-authorized",
                        "the proposed effort is not one the task binding authorizes",
                    ));
                }
                Some(EffortSelection {
                    effort: level.clone(),
                    from_attempt: snapshot.attempts_dispatched + 1,
                    proposal_id: p.proposal_id,
                })
            }
        };
        // the action must be admitted at this hook
        let decision = match (&hook, &p.action) {
            (_, EngineAction::Continue) if hook != Hook::FinalResponse => EngineDecision::Continue,
            (Hook::FinalResponse, EngineAction::Finish) => EngineDecision::Finish,
            (Hook::FinalResponse, EngineAction::Guide(g)) if g.kind == GuidanceKind::Nudge => {
                EngineDecision::Guide(g.clone())
            }
            (Hook::AfterToolPhase, EngineAction::Guide(g)) if g.kind == GuidanceKind::Steer => {
                EngineDecision::Guide(g.clone())
            }
            (_, a) => {
                return Err(refuse(
                    "engine-action-not-admitted",
                    format!(
                        "action {} is not admitted at {:?} in contract v2",
                        action_name(a),
                        hook
                    ),
                ))
            }
        };
        if let EngineDecision::Guide(g) = &decision {
            if g.message.trim().is_empty()
                || g.message.len() > MAX_GUIDANCE_BYTES
                || g.reason.len() > 200
                || g.ordinal == 0
            {
                return Err(refuse(
                    "engine-guidance-invalid",
                    "guidance must be non-empty and bounded",
                ));
            }
        }
        // generic state invariants
        let n = &p.next_state;
        if n.engine_id != d.engine_id || n.schema != d.state_schema {
            return Err(refuse(
                "engine-state-foreign",
                "the proposed state belongs to another engine or schema",
            ));
        }
        if n.revision != self.state.revision + 1 {
            return Err(refuse(
                "engine-state-revision",
                "the proposed state must advance the revision by exactly one",
            ));
        }
        if n.data.encoded_len() > MAX_STATE_BYTES {
            return Err(refuse(
                "engine-state-oversized",
                "the proposed state is too large",
            ));
        }
        self.ext
            .check_transition(&self.state, n, snapshot)
            .map_err(|m| refuse("engine-state-transition", m))?;
        // commit
        self.state = p.next_state;
        if effort.is_some() {
            self.effort = effort.clone();
        }
        self.receipts.push(ProposalReceipt {
            proposal_id: p.proposal_id,
            hook,
            revision: self.state.revision,
            effort,
        });
        self.next_proposal += 1;
        Ok(decision)
    }
}

fn action_name(a: &EngineAction) -> &'static str {
    match a {
        EngineAction::Continue => "continue",
        EngineAction::Guide(_) => "guide",
        EngineAction::Finish => "finish",
        EngineAction::RequestVerification => "request-verification",
        EngineAction::AskOperator => "ask-operator",
        EngineAction::RequestChildRun => "request-child-run",
    }
}

#[cfg(test)]
mod legacy_reference;
#[cfg(test)]
mod tests;
