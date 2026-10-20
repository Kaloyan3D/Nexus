# EM-04A — Muse Governor parity: DSH vs Native

**Result:** every scenario decides identically under DSH and under Native: effort, requested
effort, reason, trace, effective phase and source, capability refusals, and the final semantic
and activity state.

The **only** differences are these:
- the 11 verification-vocabulary disagreements (P-1);
- two excluded fields (P-2: the family label; P-5: the timestamp);
- one documented continuation adapter (P-6), proven decision-neutral.

The Governor algorithm was **not** changed. One historical behaviour that surprised the test
author (O-1) is recorded and preserved.

## 0. Two kinds of parity

| Kind | Question | EM-04A result |
|---|---|---|
| **Algorithmic parity** | Given the same semantic events and the same activity classifications, do the Native bridge and DSH produce the same effort, phase, escalation, de-escalation, clamp, refusal and state? | **Yes, exactly**, in every scenario (§3), including restart and continuation. The Governor, Runtime and Activity code is the historical code, unmodified. |
| **End-to-end activity-semantic parity** | Given the same real tool executions, does each system derive the same activity classification? | **Not on 11 of 36 corpus commands** (§4, P-1). DSH classifies shell text; Native uses its own trusted execution receipts and verification classifier. |

**Decision (approved at review):** Native's trusted receipts and verification classification are
authoritative for the feed. The historical Muse Governor and Activity reducer are not modified to
reproduce DSH's command classification. Where the two classifiers disagree, the shadow decision
follows Native's verdict, by design. Any future alignment must be a deliberate change to Native's
classifier, because it also drives completion. It must never be a change to the Governor.

## 1. Original DSH deterministic suites (unchanged sources, this tree)

| Suite | Result | Environment |
|---|---|---|
| `tests/MuseReasoningGovernor.Tests.cjs` | 52 / 52 | plain node |
| `tests/MuseReasoningRuntime.Tests.cjs` | 30 / 30 | plain node |
| `tests/MuseRoutingAuthorityOrdering.Tests.cjs` | 28 / 28 | plain node |
| `tests/MuseReasoningActivity.Tests.cjs` | 33 / 33 | scratch copy with the installed DSH app deps (`~/.local/share/nexus/app`) and preset files; `AIH_INSTALL_ROOT` set |
| `tests/MuseReasoningSignals.Tests.cjs` | 34 / 34 | same |

Activity and Signals need `@deepseek-ai/dsh-tools` and generated preset files, which a fresh
worktree lacks (a known local baseline condition). They were run on a read-only `git archive`
copy of this tree with the installed app linked in. Nothing in the worktree or the installation
was modified.

## 2. Method (`nexus-broker/src/engine/governor_parity.rs`)

Each scenario is a list of steps:
- a semantic transition;
- a tool outcome;
- a request (`Resolve`);
- a restart.

Each scenario runs twice:

| | DSH reference (`dsh_reference.cjs`) | Native |
|---|---|---|
| Modules | the ORIGINAL files in `config/`, via `require` | the embedded copies (byte-identical, tested) evaluated by `muse_bridge.cjs` |
| State | a real routing-state file in a temporary install root (`Engineering-Profiles.routingStatePath`) | the blocks carried between requests exactly as `muse-v1-shadow` carries them in its payload |
| Capabilities | a real `config/model-registry.json` entry | the virtual registry entry built from the binding's authorized levels |
| Tool outcome | DSH `exec` / `result` through `recordMuseToolOutcome` (historical classifier) | a Native `ToolActivity` receipt → `inspect::observe` with Native's `is_verification_command` → classification → historical `applyClassification` |
| Semantic transition | the Runtime API (`setMuseReasoningPhase`, …) | the same Runtime API through the bridge |
| Request | `prepareMuseRequestEffort` | `prepareMuseRequestEffort` through the bridge |
| Restart | module cache cleared and re-required; state re-read from disk | `muse-v1-shadow` `persist_state` → `restore_state` (the EM-03 continuation path) |

**Compared:**
- every resolution: `outcome, effort, requested, reason, trace, effectivePhase, effectiveSource, activityState`,
  or the capability refusal's `code, requested, supported`;
- the final `museReasoning` (except `lastResolution.atUtc`, P-5);
- the final `museActivity` (except `verification.family`, P-2).

## 3. Scenario results (all equal)

| Scenario | Exercises | Efforts (both sides) |
|---|---|---|
| `phase-defaults` | all 7 cognitive phases | medium, medium, high, high, medium, medium, high, high |
| `escalation` | failure escalation (≥ 2 hypotheses → xhigh); progress-based de-escalation (root cause newly established resets the active window, history kept); implementation failures → xhigh; solution established → `de-escalation` medium | high, xhigh, high, xhigh, medium |
| `root-cause` | root cause + solution in implement; conflict → xhigh, resolved; invalidation; re-marking an established flag never resets | medium, medium, xhigh, medium, medium, medium, medium |
| `clamp` | capability limits: escalation clamped **down** to the highest authorized level; `requestMax` clamped down | high, high |
| `default-only` | binding authorizes `low` only (not on the ladder) | refused, refused (`capability-unavailable`; state unchanged) |
| `floor` | authorized levels all above the request | refused (never resolved upward) |
| `max` | explicit max request, authorized | max |
| `activity` | trusted reductions: ignored reads, listings and failed edits; mutation → `implementation-active`; anti-thrash; failed checks → `recovery-needed` (re-stamped); passed check in verify → `verification-passed`; unproven check → semantic; semantic transition re-baselines | high, high, medium, medium, high, high, high, medium, medium, high |
| `restart` | restart / continuation between and after semantic and trusted events | high, xhigh, xhigh, xhigh (equal to the same steps without restarts) |

`the_unchanged_ladder_never_contains_low`: the bridge's ladder is `[medium, high, xhigh, max]` and
equals `MUSE_LADDER`.

## 4. Differences (none hidden)

### P-1. Verification vocabulary (classification input, not Governor policy)

DSH recognizes verification commands from shell text with a closed token matcher. Native's
verification truth is `is_verification_command`, a word-based classifier over `program` + `args`
(A6.1.x) that also judges `sh -c` scripts. The shadow uses Native's because it is the Core's
authoritative verdict; a second verdict would be a second ledger.
`the_verification_vocabularies_differ_exactly_as_documented` pins the disagreements over a
36-command corpus:

| Command | DSH | Native |
|---|---|---|
| `cargo check` | – | verification |
| `cargo clippy` | – | verification |
| `npm run verify` | verify-script | – |
| `npx eslint .` | lint | – |
| `eslint .` | lint | – |
| `python3 -m pytest` | – (DSH only knows `python`) | verification |
| `go vet ./...` | – | verification |
| `mypy .` | – | verification |
| `make test` | – | verification |
| `sh -c "cargo test"` | – | verification |
| `bash -lc "npm test"` | – | verification |

The other 25 agree:
- `cargo test` / `cargo build`;
- `npm test` / `npm run test|build|lint|typecheck`;
- `pnpm` / `yarn test`;
- `npx vitest|jest|tsc`, `tsc`, `node --test`;
- `pytest`, `python -m pytest|unittest`;
- `go test`, `dotnet test|build`;
- `npm install` / `ls` / `cat` / `git status`.

`known_difference_shell_wrapped_verification_is_recognized_only_by_native` shows the effect end
to end: `sh -c "cargo test"` failing in `implement` gives DSH `semantic` / medium and Native
`recovery-needed` / high.

**Decision (approved):** Native's verdict is the feed's source (§0). The Governor is unchanged.
These 11 commands are the full, test-pinned extent of the end-to-end difference on the corpus;
`the_verification_vocabularies_differ_exactly_as_documented` fails if either side changes.

### P-2. Verification family label

DSH names a family (`rust-test`, `node-test`, …); Native records `native:<program>`. The reducer
never reads it. It is excluded from the comparison.

### P-3. "Started" verification

DSH records `started` for a background launch or an unknown exit code. Native records `started`
for a verification whose verdict is `unverified` (a pipeline status that proves nothing). Native
has no background verification. The reducer treats both identically (`activity` scenario).

### P-4. Failed and uncertain tools

DSH ignores `isError` outcomes. Native produces no observation for `refused`, `failed`,
`cancelled` or `uncertain` calls, or for calls without a Kernel execution id. A failing test is
not an error in either system: DSH sees exit code ≠ 0, Native records `executed` with verdict
`fail`. These are equivalent.

### P-5. Resolution timestamp

`lastResolution.atUtc` is DSH's wall clock but the bridge's fixed clock (`1970-01-01T00:00:00.000Z`),
so Native decision evidence is deterministic. It is excluded from the comparison and is
diagnostic only.

### P-6. Continuation clears `currentEffort`

Native's restore sets the historical `currentEffort` to `null` (EM-03: the effort restarts at the
default). DSH keeps it until the next resolution overwrites it. The Governor never reads
`currentEffort`. The `restart` scenario and its no-restart twin decide identically.

### P-7. Observation timing

The DSH observer writes on every tool result. Native folds the new observations at the next
`BeforeRequest`, in the same order. Decisions are only taken at requests, so they are identical
(`activity` and `restart` scenarios).

### P-8. Not applicable in Native

The DSH `run_code` composite transport (ignored by DSH) and DSH tool names (`write`, `edit`,
`bash`, `pwsh`) have no Native counterpart. The mapping is by meaning (§2).

### O-1. Historical behaviour preserved (not a Native difference)

The mutation milestone fires once per active period (anti-thrash). After `edit → failed check`,
a further edit in the **same** period does not re-stamp the mutation. The failure stays the
newest evidence, so the effective state remains `recovery-needed` (`activity` scenario, 7th
request). The reducer's comment suggests that "the fix supersedes the failure". In practice this
happens only for the first mutation after a semantic transition. EM-04A preserves the historical
behaviour; whether to change it is a policy decision for EM-04B/C.

## 5. Adversarial results (`engine/muse_v1_tests.rs`, `engine/governor_bridge.rs`)

| Attack | Result |
|---|---|
| Forged activity: another task's observation (cross-task) | refused, evidence unchanged |
| Replayed execution id with a fresh `seq` | refused, evidence unchanged |
| Already-folded observation offered again (stale) | not folded again |
| Model narration ("all tests pass") | no observation, no change |
| Predecessor's execution id inside a continuation | refused |
| Forged semantic transition (phase, counter, `requestMax`) | `engine-state-transition` (semantic state immutable) |
| Activity evidence changed without an observation | refused |
| Frontier beyond the receipts / foreign generation | refused |
| Shadow decision for the wrong attempt, off-ladder, or `would` outside the authorized levels | refused |
| Rewritten or broken decision chain; two evaluations in one consultation | refused |
| Stale proposal (old revision) | `engine-state-stale` |
| Forged `Change` proposal from the shadow engine | `engine-effort-not-authorized` |
| Corrupt persisted state: bad phase, negative counter, off-ladder effort, activity schema or revision, unknown or missing field, history bound or shape, smuggled long text | `restore_state` → `None` → EM-03 `engine-state-corrupt`; tampering is caught earlier by HMAC (EM-03) |
| Corrupt state given to the bridge, or unknown event type | `state-invalid` / `event-invalid` |
| Bridge answers with a forged block, or folds without evidence | `bridge-output-invalid`; nothing adopted; observations re-offered |
| Bridge missing, timing out or failing | decision recorded with the error code; run continues at the authorized effort |
| `require` outside the traced set inside the bridge | refused (`require-refused`) |
