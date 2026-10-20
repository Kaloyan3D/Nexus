# EM-03 — Durable engine state and EngineExtension v2: architecture

Branch `feature/native-durable-engine-state`, base `2403a8d` (EM-02). **Uncommitted, for
review.** Offline only; no provider inference.

**Scope.** EM-03 prepares Native for the Muse Reasoning Governor; it does **not** activate it.
The production adapter `muse-v0` keeps choosing the configured default (`low`). No user
configuration starts adaptive effort.

## 1. Where state authority lives (Phase 0 findings)

| State | Owner | Persistence | Lifetime |
|---|---|---|---|
| Run record (status, counters, binding digests, engine id) | broker `store.rs` | `<state>/runs/<run>.json`, atomic writes | run |
| Controller task / attempts | intent bridge ledger (`native-intent-bridge.cjs`) | `.ai-harness/state/tasks.json`, `runs/<task>/attempts.jsonl` | task |
| Task binding, issuances, extensions, intents, receipts, grants | Kernel (`nexus-store`) | SQLite + witness, HMAC-sealed | task generation |
| Engine state (EM-01/02) | `EngineHost` in the turn loop | **memory only** | one `turn_loop` call |
| Muse reasoning state (DSH) | Muse runtime | DSH routing-state file (not on the Native path; not reused) | DSH task |

Facts that shaped the design:

- **A broker restart never resumes a run in place.** `server::recover` closes interrupted runs,
  and `resume_run` starts a **new task generation**: new Controller task, new issuance, new
  binding, with EM-01/EM-02 continuity checks. "Recovery" of engine state therefore means
  continuation semantics, not replay inside a dead process.
- A worker panic is caught by the pipeline (`catch_unwind`). It ends the run terminally with
  **no further writes**, which faithfully simulates a crash for durable state.
- The broker and the Kernel have separate persistence boundaries. There is no cross-process
  atomic commit, and none is claimed. Ordering plus reconciliation provide the guarantees (§4).

A0.3 §5.5/§6.2 asks for proposals with an expected revision, a durable accepted state before
any effect, idempotency by proposal id, unknown state versions that suspend safely, and no
completion authority for engines. EM-03 implements exactly this, in the broker (the Native
Controller-side run owner), with no second Controller and no second persistence system.

## 2. EngineExtension contract v2 (`engine/mod.rs`)

- `ENGINE_CONTRACT_VERSION = 2` (mod.rs:34). Descriptor gains `inherits_state` (mod.rs:63).
- Snapshot gains `attempts_dispatched`, `current_effort` and `authorized_efforts` (=
  `TaskBindingV1.supportedReasoning`).
- `EffortProposal::KeepPinned` keeps the effort in force. `EffortProposal::Change(level)` means
  "from the NEXT attempt on". The host admits it (mod.rs:470) only if all of these hold:
  1. the descriptor has `may_propose_effort`;
  2. `level ∈ authorized_efforts`;
  3. the action is not `Finish`.
- The resulting `EffortSelection { effort, from_attempt = dispatched + 1, proposal_id }` is
  in force until changed. `effort_for_attempt(n)` (mod.rs:415) is never retroactive.
- Trait additions: `persist_state` (the engine's bounded, model-text-free payload) and
  `restore_state` (inheritance; `None` refuses).
- Unchanged: identity checks, revision +1, replay/stale checks, action admission per hook,
  guidance bounds, engine-specific `check_transition`, no completion authority, and no
  model/provider/route/connection/credential/permission fields anywhere.

| Engine | `may_propose_effort` | `inherits_state` | Build |
|---|---|---|---|
| `muse-v0` (production adapter) | false | false | always |
| `effort-test-v0` | true | true | **only** with feature `test-engines` (this crate's tests); absent from `cargo build` and `--release` (verified: 0 symbols in the release binary and rlib). Selectable only if the Registry issues its id (a fixture install root), like any engine |

**Three gates for a non-default effort:**
1. the host (engine authority plus the binding's levels);
2. the Registry (`issue-attempt` against the sealed `TaskBindingV1`, including the slot policy);
3. the Kernel (binding `admits` at publish/accept; the executor binds the grant to the prepared target).

## 3. Durable engine state (`engine_state.rs`)

One record per task generation: `<state_dir>/engine/<taskInstanceId>.json` (record schema 1).

```
EngineStateRecord {
  schemaVersion, runId, taskInstanceId, modeId, engineId, engineContract, stateSchema,
  taskBindingDigest, defaultEffort,
  revision (monotonic), lastProposalId (ids contiguous: every id <= it is a replay),
  effort: EffortSelection | null,
  payload (engine-validated, <= 16 KiB, no model text),
  attempts [<= 32]: { ordinal, attemptId, effort, issuanceId, extensionDigest, state },
  lineage: { predecessorRun, predecessorTask, predecessorRevision, inherited, rule } | null,
  events [<= 64]: { seq (monotonic), kind, revision, proposalId?, attempt?, effort?, detail?<=200 },
  nextEventSeq, mac }
```

**Integrity and bounds:**
- Written atomically (`write_atomic_unique`: unique temp file, fsync, rename, directory fsync).
- Authenticated with HMAC-SHA256 under a broker-local key (`<state>/engine-state.key`, 0600,
  created once with `create_new`; a key that can't be created or read fails closed).
- Loaded with `O_NOFOLLOW`, size-bounded (64 KiB), strict schema (unknown fields refused), and
  checked for version and identity.

**Sensitive-data exclusions:** no prompts, model text, file contents or secrets. `muse-v0`
persists its narration window only as SHA-256 digests (asserted end to end).

**Retention:** a record lives as long as its run record (same state directory). History is a
bounded ring, and `seq` stays monotonic across truncation.

**The schema can represent the future Muse state without implementing it.** The engine payload
is engine-typed and versioned (`stateSchema`); the test engine carries `phase`,
`failedHypotheses` and `rootCauses` to prove the shape. Trusted activity signals and failure
windows map to payload fields plus events (handoff §3).

## 4. Transactions and recovery

```
attempt k of a run (turn loop, inspect.rs)
  (1) engine proposes            [memory]                     fault "before-accept"
  (2) EngineHost validates        [memory; refusal = no change]
  (3) EngineRun::consult: an accepted effort change is COMMITTED (event effort-selected)
                                  [broker disk]                fault "after-accept"
  (4) Registry issue-attempt (non-default effort; cached per effort) + Kernel seal
                                  [Kernel disk]                fault "after-authorize"
  (5) attempt-add / shadow / kernel-intent / prepare
      EngineRun::bind_attempt: attempt k -> {effort, issuanceId, extensionDigest} COMMITTED
                                  [broker disk, write-ahead]   fault "after-bind"
  (6) Kernel publish/accept (binding admits) -> dispatch-authorize -> single-use grant
  (7) send (exactly once; the executor checks the grant's target/extension digests)
  (8) outcome answered|truncated|uncertain|failed [memory; durable with the next commit]
                                                                fault "after-answer"
run end: finalize (run record: AUTHORITATIVE verdict) -> EngineRun::finish -> event run-ended COMMITTED
```

**Guarantees** (tests in the recovery matrix):

- **No dispatch from an uncommitted engine decision.** (3) precedes (4), and (5) precedes (6)
  and (7). A failed commit returns `LoopEnd::Failed(engine-state-unpersisted)` before the effect.
- **No proposal applied twice; no stale overwrite.** Proposal ids are contiguous; a restored
  host continues after `lastProposalId`; `based_on_revision` must equal the current revision.
- **A rejected proposal applies nothing.** `EngineHost::accept` validates everything before its
  only mutations; `EngineRun` commits only after acceptance.
- **A restart cannot silently reset or escalate.** A continuation is a new generation under its
  own binding. Its effort starts at the default, recorded as an explicit
  `effort-reset-continuation` event. Any other effort requires a new proposal (committed) and a
  new Registry authorization.
- **A recovered attempt uses the effort authorized for that attempt.** A re-ask after an
  interruption is a new attempt with its own binding record and its own Kernel acceptance.
- **Ambiguous delivery is never re-sent.** The lost attempt stays `uncertain` (or `bound` in a
  crashed predecessor, recorded as `predecessor-attempt-unresolved`). New commands are new
  attempts; the Kernel's single-use intents make re-dispatch impossible.
- **The Kernel and TaskBindingV1 stay authoritative.** EM-03 adds no Kernel path.
- **No cross-task or cross-engine reuse.** Records are keyed and identity-checked by task.
  Inheritance requires the same engine, mode, contract and schema; the payload is re-validated by
  `restore_state`; selections and authorizations never cross generations.
- **Unreconcilable recovery fails closed** with `engine-state-unauthenticated`,
  `engine-state-version`, `engine-state-identity` or `engine-state-corrupt`. This happens before
  the continuation creates anything (`examine_predecessor`, inspect.rs:849).

**Cross-process boundary.** Between (4) and (5), the Kernel may hold a sealed attempt target the
broker never bound. That is harmless: seals are content-addressed authorizations, not effects,
and are only usable through a published, accepted intent. Between (5) and (7), the broker may
have bound an attempt that was never sent. Its record says `bound`, and the Kernel journal (no
receipt or an unexecuted intent) shows it was not dispatched.

**Continuation rules** (`examine_predecessor`, `EngineRun::start`):

| Predecessor | Rule (`lineage.rule`) | Effect |
|---|---|---|
| none recorded (pre-EM-03 run, or the task was never reached) | `pre-em03-no-state` | engine initial state, default effort; allowed only because the EM-01 continuity rule already proved it is the same engine |
| authentic, same engine/mode/contract/schema, `inherits_state` | `inherited` | payload restored (validated), revision 0 of the new generation, `predecessorRevision` recorded |
| authentic, engine does not inherit (`muse-v0`) | `fresh-engine-does-not-inherit` | initial state (EM-01 behaviour) |
| tampered, other version or schema, other engine/mode/task, invalid payload | — | continuation refused before any working copy |

## 5. Reasoning authorization path

`TaskTarget::for_attempt(Authorized(e))` is the EM-02 Registry and Kernel path. Its results are
cached per effort in the turn loop, so the Registry is called at most once per (task, effort).
The default effort uses the pinned target: no Node process and no additional call. The EM-02
slot policy (`allowedReasoning`, absent means default only) defines `authorized_efforts`.
Normal configuration changes apply to new tasks; a running task keeps its sealed policy.
Emergency revocation is out of scope and separate.

## 6. What does not change

- `muse-v0` decisions: the EM-01 differential test (48,000 decisions) passes.
- Request bodies: byte-identical to `2403a8d` (7/7).
- Request keys and tool schemas: the EM-01 guard.
- Unchanged behaviours: model and Registry selection, completion, verification, phase and
  reasoning replay, sandbox, approvals, the A614 bound (449,944 B).
- No new tool, request field, provider, model or configuration default.

## 7. Final durability review

### 7.1 Completion authority and the end-of-run write

The **run record** (`store.rs`, written by `finalize`) owns the completion verdict. Together
with the Kernel receipts, it is what restart, recovery and continuation decide from: `resume_run`
refuses completed runs, and `recover()` closes non-terminal ones. Run-record terminal states are
sticky (`server.rs:118`): a late write can never rewrite them. The engine record's `run-ended`
event is an audit annotation; no decision reads it.

**Defect found and fixed (D1).** The engine end was written BEFORE `finalize`. A crash in between
left the engine record saying the run ended while the run record was non-terminal. That state is
observable as contradictory, although harmless, because continuation never read it.
- Now `finalize` runs first (`inspect.rs:1297`) and `finish` after it (`inspect.rs:1300`). The
  engine record can never claim an end the authority lacks.
- A failed `finish` is logged to the operator log. The record then lacks only its end; its last
  attempt reads `bound` (unresolved, never re-sent) to a continuation.

Tests:
- `em03_a_failed_terminal_write_never_contradicts_a_completed_run`: completed run, restart; still
  completed, not continuable, receipts = attempts.
- `em03_a_failed_terminal_write_on_a_failed_run_continues_safely`: failed run, restart,
  continuation authenticates, attempt 1 unresolved, never re-sent, default effort.
- `em03_a_crash_between_the_verdict_and_the_engine_end_leaves_the_verdict_authoritative`.

### 7.2 Filesystem durability of engine state writes

| Step | Call | Evidence |
|---|---|---|
| temp file | `create_new` + `O_NOFOLLOW` + mode 0600, unique name (pid + counter) | `engine_state.rs:703-705` |
| data | `write_all` then `fsync` (`File::sync_all`) of the temp file | `:708` |
| replace | `rename(tmp, record)`: atomic replacement in the same directory | `:710` |
| directory | `fsync` of the directory, **error propagated** (fixed, D3; it was ignored) | `:716`, `fsync_dir :723` |
| first use | `fsync` of the state root after creating `engine/` and after creating the key (fixed, D3) | `:235`, `:304` |

- **Process-crash safety** (kill, panic): readers see either the previous or the new complete
  record (atomic rename). A crash can leave a stray `*.tmp-<pid>-<n>` file, which is never read.
- **Power-loss durability:** a commit returns `Ok` only after the file data, the rename (directory
  fsync) and, on first use, the directory/key entries are synced. A failure at any step returns
  `engine-state-unpersisted` and the effect is not performed.
- **Limits:** these guarantees assume the filesystem honours `fsync`, as ext4/btrfs/xfs do.
  `strace` was not available on this machine, so the evidence is the source above, not a syscall
  trace.
- **No atomic power-loss durability is claimed ACROSS stores.** The run store, the engine state
  store and the Kernel store are separate files with separate commits. After a power loss, one
  may reflect a later point than another. Safety comes from the ordering in §4 and §7.1 (engine
  decisions durable before their effects; the engine end only after the run verdict) and from
  reconciliation at continuation. It does not come from cross-store atomicity.
- The **run store** (`store.rs::write_atomic`, pre-existing, not changed by EM-03) also fsyncs
  data and the directory, but ignores directory-fsync errors. Its power-loss durability is
  therefore best-effort for the rename (recorded limitation, outside EM-03's scope).

### 7.3 The broker-local HMAC key

- **Created once** per state root: `create_new` + `O_NOFOLLOW` + 0600, data fsync and state-root
  fsync (`:295-304`).
- **Never regenerated for existing records (fixed, D2).** If `engine/` holds records and the key
  is missing, `open` refuses (`engine-state-unauthenticated`, `:271-280`) instead of minting a key
  that would orphan them.
- **Never followed or replaced.** It is opened with `O_NOFOLLOW` (a symlink is refused). It must
  be a regular file, 0600, owned by the broker's uid (owner check added, `:255`). Malformed
  contents are refused.
- **Preserved across restarts:** the same bytes after reopening, records keep authenticating.
- Test: `engine_state::tests::the_key_is_never_regenerated_replaced_or_followed`.

The key lives in the broker's state root (0700, single owner, R-LOCK-1 lock). It protects
against corruption and foreign or edited records, not against a fully compromised broker
identity, which could read the key. TaskBindingV1 and the Kernel still bound every effort.

### 7.4 Accepted proposal, failed authorization

`EngineRun::consult` commits `effort-selected` BEFORE `TaskTarget::for_attempt`. If the Registry
or Kernel step then fails, `for_attempt` returns an error and the turn loop ends with it before
`bind_attempt`, publish or dispatch. The selection never reaches a bound attempt in that task. A
continuation resets to the default (explicit event); a non-default effort there needs a new,
committed proposal and a new authorization under the continuation's own binding.

Test: `em03_an_accepted_proposal_whose_authorization_fails_never_dispatches` (fault
`authorize-fail`, restart, continuation).
