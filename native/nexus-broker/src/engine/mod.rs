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

/// Version of this contract. A change of any type below bumps it.
pub const ENGINE_CONTRACT_VERSION: u32 = 1;
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

/// Reasoning effort for the NEXT request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffortProposal {
    /// Use the run's pinned target unchanged.
    KeepPinned,
    /// A different effort. Refused in contract v1: only a Registry-issued, per-attempt pinned
    /// target may carry another effort (see the EM-01 specification).
    Change(String),
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
}

impl EngineStateData {
    fn encoded_len(&self) -> usize {
        match self {
            Self::MuseV0(s) => s.encoded_len(),
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

/// The compiled-in engines.
fn built_in() -> [&'static dyn EngineExtension; 1] {
    [&muse_v0::MUSE_V0]
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
}

/// The Core side of the boundary for ONE run: owns the engine state, validates every proposal
/// and commits accepted state. Never shared between runs.
pub struct EngineHost {
    ext: &'static dyn EngineExtension,
    state: EngineState,
    next_proposal: u64,
    receipts: Vec<ProposalReceipt>,
}

impl EngineHost {
    pub fn new(ext: &'static dyn EngineExtension) -> Self {
        Self {
            ext,
            state: ext.initial_state(),
            next_proposal: 1,
            receipts: Vec::new(),
        }
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
        // effort: the Registry-issued pin is the only authority in contract v1
        if let EffortProposal::Change(_) = &p.effort {
            if !d.may_propose_effort {
                return Err(refuse(
                    "engine-effort-not-authorized",
                    "this engine may not change the reasoning effort of the pinned target",
                ));
            }
            return Err(refuse(
                "engine-effort-not-authorized",
                "per-attempt effort changes require a Registry-issued target (not available in contract v1)",
            ));
        }
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
                        "action {} is not admitted at {:?} in contract v1",
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
        self.receipts.push(ProposalReceipt {
            proposal_id: p.proposal_id,
            hook,
            revision: self.state.revision,
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
