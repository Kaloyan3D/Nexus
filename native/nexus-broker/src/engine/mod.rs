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

pub mod effort_limiter;
pub mod governor_bridge;
pub mod muse_v0;
pub mod muse_v1;
pub mod muse_v1_adaptive;
#[cfg(feature = "test-engines")]
pub mod test_engine;
#[cfg(feature = "test-engines")]
pub mod test_faults;
pub mod worker_bridge;

/// Version of the engine contract AS PERSISTED: every EM-03 engine state record carries it, and a
/// continuation refuses a record of another version (`engine-state-version`). It therefore changes
/// only for an INCOMPATIBLE change of what a persisted record means: its serialized engine state,
/// the semantics of its effort selection, attempts and events, or how a continuation interprets
/// them. Additive Rust API evolution of the types below - new read-only snapshot fields, defaulted
/// trait methods, new descriptor fields, capabilities lent per consultation (all EM-04A) - leaves
/// persisted records and their recovery interpretation unchanged and does NOT bump it. Records
/// written by EM-03 (`b5a939a`) are reopened byte for byte and continued by this build
/// (`engine_state::em03_records_compatibility`).
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
/// EM-04B: largest acknowledgement an engine may return for a reasoning signal (it becomes the
/// tool result the model reads).
pub const MAX_SIGNAL_ACK_BYTES: usize = 1024;
/// EM-04C2 production gate for the ACTIVE adaptive engine `nexus-adaptive-v1`: OPENED in S10-A, as an
/// explicitly selected beta (the default engine stays `muse-v0`). With `true` production builds
/// register exactly `muse-v0` and `nexus-adaptive-v1`; the latter still runs only in the mode
/// `engineering-v2-adaptive`, only from an operator-SAVED ModeConfiguration, only with a
/// Registry-sealed request budget (see `engine_for_run`). Rollback = set this to `false` (and the
/// mode definition back to planned): continuations of adaptive tasks then fail closed with
/// `engine-unavailable`. This is a compile-time constant, deliberately NOT a runtime switch. The
/// historical name is kept to avoid churn; the runtime identity is `nexus-adaptive-v1`. The
/// experimental `muse-v1-shadow` and `muse-v1-signals` engines are test-only whatever this
/// constant says: they are never registered in a production build.
pub const MUSE_V1_PRODUCTION_ENABLED: bool = true;

/// EM-04C1: the ONE authority for the tool catalog a run is offered. It is a pure function of the
/// run's kind and the engine id of its SEALED Registry resolution (the engine was already selected
/// from that resolution, or the run failed closed). It reads no broker configuration, no model or
/// tool output, no Registry free text: nothing but the sealed engine identity can add a tool.
///
/// * every read-only run: `RepoInspectV1`;
/// * every coding run: `RepoCodeV1` - the production `muse-v0` catalog, frozen byte for byte;
/// * a coding run of the experimental `muse-v1-signals` engine only: `RepoCodeMuseSignalsV1`
///   (`RepoCodeV1` plus `muse_update_reasoning_state`). That id exists only in `test-engines` builds.
///
/// * a coding run of the active `nexus-adaptive-v1` engine (EM-04C2 S6): the same `RepoCodeMuseSignalsV1`
///   catalog, deliberately by row and not by flag. Its digest is the frozen one; the signals tool is
///   scoped to Muse engines only.
pub fn tool_catalog_profile(engine_id: &str, code_run: bool) -> nexus_model::ToolProfile {
    use nexus_model::ToolProfile as P;
    match (code_run, engine_id) {
        (false, _) => P::RepoInspectV1,
        (true, muse_v1::SIGNALS_ENGINE_ID | muse_v1::ACTIVE_ENGINE_ID) => P::RepoCodeMuseSignalsV1,
        (true, _) => P::RepoCodeV1,
    }
}

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
    /// EM-04A: request bytes this engine's mode adds outside the conversation (a mode-scoped tool
    /// schema), measured exactly. When a request budget is configured, the conversation may use
    /// only `target - reserve`. 0 for every engine that adds nothing (`muse-v0`).
    pub request_reserve_bytes: usize,
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
    /// EM-04A: the task generation this run executes (identity of every observation below).
    pub generation: String,
    /// EM-04A: trusted activity of THIS run, in execution order: verified mutations and
    /// verification commands, derived by the Core from its own tool receipts and the Kernel's
    /// execution records - never from model text. Read-only for engines.
    pub activity: Vec<ActivityObservation>,
    /// EM-04B: model-authored reasoning signals of THIS run that passed the Core's strict
    /// validation, in call order. Cognitive CLAIMS, kept apart from `activity` (evidence).
    pub signals: Vec<SignalObservation>,
}

/// EM-04B: one validated call of the reasoning-signals tool. The Core builds it from the provider's
/// call and its own identity facts; the model supplies only `signal` (closed schema, no effort).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalObservation {
    /// Order within the run, shared with `ActivityObservation::seq` (the tool call's index).
    pub seq: u32,
    /// The model attempt whose response made the call.
    pub attempt: u32,
    pub generation: String,
    pub call_id: String,
    /// Trusted dispatch identity (generation, attempt, call id and the signal's canonical hash):
    /// the historical deduplication key.
    pub dispatch_key: String,
    /// The validated signal object, exactly as the model sent it (only historical fields).
    pub signal: serde_json::Value,
}

/// EM-04A: one trusted operational observation (the Native counterpart of the historical Muse
/// activity observer's classification). Built only by the Core from an executed tool's receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityObservation {
    /// Order within the run: the tool call's index (strictly increasing, 1-based).
    pub seq: u32,
    /// The model attempt whose response proposed the call (1-based dispatch ordinal).
    pub attempt: u32,
    /// The task generation that executed it.
    pub generation: String,
    /// Replay identity: the Kernel execution id of the operation.
    pub execution_id: String,
    pub kind: ObservationKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservationKind {
    /// A file change the Kernel executed (`fs_write` / `fs_edit`, receipt `executed`).
    Mutation,
    /// A verification command (Native's own classification) and its verified outcome.
    Verification {
        outcome: VerificationOutcome,
        /// The program that ran (from the closed program allow-list), informational.
        family: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationOutcome {
    /// The command ran but its status proves nothing (Native verdict `unverified`).
    Started,
    Passed,
    Failed,
}

impl VerificationOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Passed => "passed",
            Self::Failed => "failed",
        }
    }
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
    /// EM-04B: the acknowledgement of a reasoning signal (admitted ONLY by `consult_signal`).
    Acknowledge(String),
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
///
/// One value exists per run (never in a hot path); the Muse variant carries the Governor blocks and,
/// for the active engine, the limiter state - boxing it would only move the allocation.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)]
pub enum EngineStateData {
    MuseV0(muse_v0::MuseV0State),
    /// EM-04A shadow Governor engine `muse-v1-shadow` (not selectable in production).
    MuseV1(muse_v1::MuseV1State),
    /// Test-only deterministic engine (feature `test-engines`, never in production builds).
    #[cfg(feature = "test-engines")]
    EffortTestV0(test_engine::EffortTestState),
}

impl EngineStateData {
    fn encoded_len(&self) -> usize {
        match self {
            Self::MuseV0(s) => s.encoded_len(),
            Self::MuseV1(s) => s.encoded_len(),
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

/// EM-04A: capabilities the Core lends an engine for ONE consultation. Each is a pure function
/// from the engine's point of view (no handle, path, credential or side effect reaches the
/// engine); `None` = not available to this run.
#[derive(Clone, Default)]
pub struct EngineEnv {
    /// The historical Muse policy (Governor, Runtime transitions, Activity reducer).
    pub governor: Option<std::sync::Arc<dyn governor_bridge::GovernorEvaluator>>,
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
    /// EM-04A: `propose` with the capabilities lent for this consultation. Engines that need
    /// none keep the default (identical to `propose`).
    fn propose_in(
        &self,
        hook: Hook,
        snapshot: &EngineSnapshot,
        state: &EngineState,
        proposal_id: u64,
        _env: &EngineEnv,
    ) -> EngineProposal {
        self.propose(hook, snapshot, state, proposal_id)
    }
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
    /// EM-04B: answer the newest signal in `snapshot.signals` (an `Acknowledge` action, never an
    /// effort change). `None` = this engine takes no signals (every engine but the experimental
    /// signals engine); the host then refuses the call.
    fn propose_signal(
        &self,
        _snapshot: &EngineSnapshot,
        _state: &EngineState,
        _proposal_id: u64,
        _env: &EngineEnv,
    ) -> Option<EngineProposal> {
        None
    }
    /// EM-03: rebuild a state from its persisted payload for an inheriting continuation.
    /// `None` = invalid (the continuation fails closed) or not inheritable.
    fn restore_state(&self, _payload: &serde_json::Value, _revision: u64) -> Option<EngineState> {
        None
    }
    /// EM-04C2 S6: `restore_state` with what the interrupted run's durable record says about its
    /// effort (the continuation restarts at the default; an engine whose policy depends on that
    /// reset needs to know what was reset). Engines that do not care keep the default.
    fn restore_state_in(
        &self,
        payload: &serde_json::Value,
        revision: u64,
        _ctx: &RestoreContext,
    ) -> Option<EngineState> {
        self.restore_state(payload, revision)
    }
    /// EM-04C2 S6: the engine's own explanation of an effort proposal, verified by the host AFTER
    /// the state transition and BEFORE anything is committed: the proposal's effort must be exactly
    /// the decision the engine's recorded (and independently re-validated) state says it took.
    /// The default accepts only what every other engine may do under the generic rules.
    fn check_effort(
        &self,
        _from: &EngineState,
        _to: &EngineState,
        _effort: &EffortProposal,
        _snapshot: &EngineSnapshot,
    ) -> Result<(), String> {
        Ok(())
    }
    /// EM-04C2 S6: audit detail for the `effort-selected` event of the proposal that produced `state`.
    fn effort_detail(&self, _state: &EngineState) -> Option<String> {
        None
    }
    /// EM-04C2 S6: an engine whose mode must not dispatch without a Registry-sealed request-size
    /// budget (the adaptive engine). Judged by the broker before any state or request exists.
    fn requires_sealed_request_budget(&self) -> bool {
        false
    }
}

/// What a continuation knows about the interrupted run's effort (see `restore_state_in`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreContext {
    /// The effort selection in force when the interrupted run's record was last committed
    /// (`None` = it ran at the pinned default).
    pub effort_in_force: Option<String>,
    /// The pinned default effort of the task (the continuation restarts there).
    pub default_effort: String,
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
    engines(cfg!(feature = "test-engines"))
}

/// The engine list of a production build (`test_build = false`) or a `test-engines` build.
fn engines(test_build: bool) -> Vec<&'static dyn EngineExtension> {
    engines_with(test_build, MUSE_V1_PRODUCTION_ENABLED)
}

/// `engines` with the production gate as a parameter, so that the day the gate is opened (S10) is
/// already proven by a test: opening it registers ONLY the active `nexus-adaptive-v1`.
fn engines_with(test_build: bool, muse_v1_enabled: bool) -> Vec<&'static dyn EngineExtension> {
    let mut v: Vec<&'static dyn EngineExtension> = vec![&muse_v0::MUSE_V0];
    if muse_v1_enabled || test_build {
        v.push(&muse_v1::MUSE_V1_ACTIVE);
    }
    if test_build {
        v.push(&muse_v1::MUSE_V1);
        v.push(&muse_v1::MUSE_V1_SIGNALS);
    }
    #[cfg(feature = "test-engines")]
    if test_build {
        v.push(&test_engine::EFFORT_TEST_V0);
    }
    v
}

/// EM-04C2 S10 (RG-1): what THIS compiled artifact contains, for `nexus-broker engines`. Read-only and
/// secret-free: it lets the release gate ask the exact shipped executable which engines it registers
/// and which (mode, engine) pairs resolve, instead of inferring it from a different build.
pub fn build_report() -> serde_json::Value {
    const MODES: [&str; 6] = [
        "engineering-v1",
        "engineering-v2",
        "engineering-v2-adaptive",
        "engineering-v3",
        "engineering-v2-adaptive ",
        "",
    ];
    let registered: Vec<&str> = built_in()
        .iter()
        .map(|e| e.descriptor().engine_id)
        .collect();
    let mut resolvable = Vec::new();
    for mode in MODES {
        for engine in [
            "muse-v0",
            "nexus-adaptive-v1",
            "muse-v1-shadow",
            "muse-v1-signals",
            "effort-test-v0",
            "dual-v1",
            "MUSE-V0",
            "",
        ] {
            if resolve(mode, engine).is_ok() {
                resolvable.push(serde_json::json!([mode, engine]));
            }
        }
    }
    serde_json::json!({
        "report": "nexus-broker-engines/1",
        "testEnginesFeature": cfg!(feature = "test-engines"),
        "testFixturesFeature": cfg!(feature = "test-fixtures"),
        "adaptiveProductionEnabled": MUSE_V1_PRODUCTION_ENABLED,
        "registered": registered,
        "resolvable": resolvable,
    })
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
    /// EM-04B: the proposal answered a reasoning signal (not a hook).
    pub signal: bool,
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
        self.consult_in(hook, snapshot, &EngineEnv::default())
    }

    /// EM-04A: `consult` lending `env` to the engine for this consultation. Validation is the same.
    pub fn consult_in(
        &mut self,
        hook: Hook,
        snapshot: &EngineSnapshot,
        env: &EngineEnv,
    ) -> Result<EngineDecision, EngineRefusal> {
        let p = self
            .ext
            .propose_in(hook, snapshot, &self.state, self.next_proposal, env);
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
                // EM-04C2 (E-2): a change to the effort that ALREADY applies to the next attempt is a
                // no-op, never a new selection: it would commit a durable `effort-selected` event
                // and could trigger a Registry issuance and two Kernel seals for nothing, on every
                // request, from a buggy or hostile engine. Both the Core's view (the snapshot's
                // `current_effort`: the selection in force or the pinned default) and the host's
                // own selection are consulted. Nothing is changed or committed.
                let next_attempt = snapshot.attempts_dispatched + 1;
                if snapshot.current_effort == *level
                    || self.effort_for_attempt(next_attempt) == Some(level.as_str())
                {
                    return Err(refuse(
                        "engine-effort-noop",
                        "the proposed effort already applies to the next attempt; no new selection is made",
                    ));
                }
                Some(EffortSelection {
                    effort: level.clone(),
                    from_attempt: next_attempt,
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
        self.admit_next_state(&p.next_state, snapshot)?;
        // EM-04C2 S6: the effort asked for must be exactly the decision the engine's validated
        // state records (an engine cannot propose an effort its own audit trail does not justify)
        self.ext
            .check_effort(&self.state, &p.next_state, &p.effort, snapshot)
            .map_err(|m| refuse("engine-effort-unjustified", m))?;
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
            signal: false,
        });
        self.next_proposal += 1;
        Ok(decision)
    }

    /// Generic state invariants and the engine's own transition rules (every admission path).
    fn admit_next_state(
        &self,
        n: &EngineState,
        snapshot: &EngineSnapshot,
    ) -> Result<(), EngineRefusal> {
        let d = self.ext.descriptor();
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
            .map_err(|m| refuse("engine-state-transition", m))
    }

    /// EM-04B: hand the newest validated reasoning signal (`snapshot.signals`) to the engine and
    /// admit its answer: only an `Acknowledge` within bounds, never an effort change, and the same
    /// state rules as every proposal. On success the new state is committed (in memory; the caller
    /// makes it durable before the acknowledgement reaches the model) and the acknowledgement
    /// returned; on refusal nothing changes.
    pub fn consult_signal(
        &mut self,
        snapshot: &EngineSnapshot,
        env: &EngineEnv,
    ) -> Result<String, EngineRefusal> {
        let Some(p) = self
            .ext
            .propose_signal(snapshot, &self.state, self.next_proposal, env)
        else {
            return Err(refuse(
                "engine-signals-unsupported",
                "this engine takes no reasoning signals",
            ));
        };
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
        if p.effort != EffortProposal::KeepPinned {
            return Err(refuse(
                "engine-effort-not-admitted",
                "a reasoning signal never changes the reasoning effort",
            ));
        }
        let EngineAction::Acknowledge(ack) = &p.action else {
            return Err(refuse(
                "engine-action-not-admitted",
                format!(
                    "action {} is not admitted for a reasoning signal",
                    action_name(&p.action)
                ),
            ));
        };
        if ack.is_empty() || ack.len() > MAX_SIGNAL_ACK_BYTES {
            return Err(refuse(
                "engine-ack-invalid",
                "the signal acknowledgement must be non-empty and bounded",
            ));
        }
        let ack = ack.clone();
        self.admit_next_state(&p.next_state, snapshot)?;
        self.state = p.next_state;
        self.receipts.push(ProposalReceipt {
            proposal_id: p.proposal_id,
            hook: Hook::AfterToolPhase,
            revision: self.state.revision,
            effort: None,
            signal: true,
        });
        self.next_proposal += 1;
        Ok(ack)
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
        EngineAction::Acknowledge(_) => "acknowledge",
    }
}

#[cfg(test)]
mod anti_thrash_review;
#[cfg(test)]
mod catalog_tests;
#[cfg(test)]
mod effort_limiter_tests;
#[cfg(test)]
mod effort_limiter_v2_tests;
#[cfg(test)]
mod governor_parity;
#[cfg(test)]
mod legacy_reference;
#[cfg(test)]
mod muse_v1_active_tests;
#[cfg(test)]
mod muse_v1_tests;
#[cfg(test)]
mod signals_parity;
#[cfg(test)]
mod signals_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod worker_tests;
