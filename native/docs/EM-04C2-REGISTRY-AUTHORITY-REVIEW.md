# EM-04C2 Checkpoint 1 — Registry authority review (S3, S4)

Branch `feature/native-muse-adaptive-foundations`, baseline `50a24d791cdb3c1a4b00eb15b24843c4b45d9798`.
Uncommitted. Companion documents: `EM-04C2-CHECKPOINT-1-REPORT.md`,
`EM-04C2-WORKER-SECURITY-RESULTS.md`; governing plan `EM-04C2-ACTIVATION-PLAN.md`.

This review answers one question: **after S3 and S4, who can cause a run to use the adaptive
engine or a different reasoning policy, and what stops each of them?** The answer is that nobody can
cause a run to use the adaptive engine at this checkpoint, and nobody except the Registry (through a
change the continuation then refuses) can change a task's reasoning authorization.

## 1. Authority map (source-verified)

| Decision | Owner | Mechanism | Where |
|---|---|---|---|
| Which (mode, engine) pairs the Native path may issue | **Registry code, reviewed** | closed, frozen table `NATIVE_SCOPES` (2 entries); own-property lookup `scopeOf` | `config/registry/native-issuer.cjs:52-80` |
| What engine a mode declares | Registry definition (install root) | `modes/<mode>.json` `orchestrationEngineId`; must be allowed by the table entry | `native-issuer.cjs:143-146` (compile), `:157-160` (issue) |
| Whether the adaptive mode can run at all | Registry definition + operator | definition `runnable/selectable/status`; operator-**saved** ModeConfiguration | `modes/engineering-v2-adaptive.json`; `native-issuer.cjs:122-126`, `native-target-v2.cjs:322-329` |
| Which models may serve an engine | Registry resolver | `checkEngineScope`: `model.engines` must contain the mode's engine | `resolver.cjs:149-162` (unchanged) |
| Which reasoning levels a slot authorizes | Operator via Registry | `allowedReasoning` sealed in the target; binding `supportedReasoning` | `resolver.cjs`, `native-task-binding.cjs` (unchanged) |
| Which mode a run asks for | Client (an optional, bounded identifier) | `ModelSelection.mode_id` → selection JSON `modeId` → **judged by the Registry** | `nexus-contracts/src/intent.rs:59-71`, `nexus-broker/src/inspect.rs` / `pipeline.rs` selection builders |
| Whether the runtime has the engine | Native build | `engine::resolve_issued` → `built_in()`; **no `muse-v1`** | `engine/mod.rs` (unchanged; `MUSE_V1_PRODUCTION_ENABLED = false`) |
| Whether a continuation keeps its mode, engine and policy | Broker, from the sealed binding | `identity_digest` v2; `identity_matches` | `attempt_target.rs:329-424`, `inspect.rs:840` |

## 2. S4 — what the closed table does

```
NATIVE_SCOPES = {
  'engineering-v2':          { engineId: 'muse-v0',  experimentalEngineIds: [effort-test-v0, muse-v1-shadow, muse-v1-signals],
                               role: 'muse_main', requiresSavedConfiguration: false },
  'engineering-v2-adaptive': { engineId: 'muse-v1',  experimentalEngineIds: [],
                               role: 'muse_main', requiresSavedConfiguration: true  },
}
```

* **Closed:** `Object.freeze` at both levels; `scopeOf` uses `hasOwnProperty`, so `__proto__`,
  `constructor`, `toString` and any non-string are not modes (tested). Nothing — no selection, no
  configuration, no model, no Rust caller — can add an entry.
* **`engineering-v2` is unchanged:** engine `muse-v0`; the saved-configuration requirement is
  **false**, so the existing preview-from-legacy-profile behaviour is preserved exactly. The three
  experimental ids are the Rust runtime's deterministic **test-only** engines (compiled only into
  `test-engines` builds; a production runtime answers `engine-unavailable`). They are listed because the
  existing fixture install roots edit `engineering-v2.json` to name them; before this change the issuer
  accepted *any* engine string there, so the table is strictly **narrower** than baseline. The adaptive
  production engine `muse-v1` is **not** among them: `engineering-v2` + `muse-v1` is refused
  (`registry-unsupported-scope`, JS suite, 8 mode/engine pairs).
* **Both directions are enforced:** the compiled snapshot's engine is checked against the entry
  (`compileTrustedMode`), and again on the binding (`issueForGeneration`), so a definition edited to
  declare another engine, or a forged binding, cannot be issued.
* **Saved configuration, nothing created:** for the adaptive mode `getModeConfiguration` must return a
  **persisted** entry; otherwise `registry-mode-configuration-required`. `previewFor` returns
  `mode-configuration-required` for it: no default, no adoption (`unknown-profile` for any adopt
  attempt). A refused read or save writes nothing (the data-root listing is byte-identical before and
  after; JS and Rust E2E).
* **The mode is part of what is sealed:** `issuance.modeId` is the binding's mode (was a constant);
  `target.modeId` and `orchestrationEngineId` are in the digest-covered target and in the task
  binding's projection, so the Kernel seals them and every attempt's `admits` compares them.

### 2.1 Selection grammar

`parseSelectionJson` (`native-intent-bridge.cjs:172-196`) accepts exactly:
`{logicalModelId, routeId}` (as before, byte-for-byte), `{logicalModelId, routeId, modeId}`,
`{modeId}`. `modeId` must be a key of the table. Any other shape, an extra key, a wrong type, a
differently spelled or inherited name is `bad-args`. Absent `modeId` ⇒ `engineering-v2`; an explicit
`engineering-v2` produces the **identical** resolution, core, extension, task binding and issuance id
(E2E `s4_a_selection_without_a_mode_is_exactly_what_it_was_…`, compared field by field).

### 2.2 Engine and model scope validated by the Registry

An activated adaptive mode with models **not** scoped to `muse-v1` cannot even be saved
(`engine-scope-mismatch`, E2E `s4_models_outside_the_engine_scope_…`), and without a saved
configuration it cannot be issued. The existing resolver rule did the work; no new scope logic was
needed.

## 3. Layers that keep the adaptive mode dormant at this checkpoint

Each is independent; **any one** suffices.

| # | Gate | State now |
|---|---|---|
| 1 | Shipped definition | `status: planned`, `runnable: false`, `selectable: false` → the Registry refuses to compile or save a configuration (`mode-not-runnable`) |
| 2 | Installation closure | `scripts/MusePresetDependencyClosure.cjs` pins the three mode files it installs; `engineering-v2-adaptive.json` is **not** among them, so a real install does not carry the definition (`mode-definition-missing`). S6 must add it deliberately. |
| 3 | Operator authorization | a saved ModeConfiguration is required; none exists or is ever created |
| 4 | Engine scope | models must list `muse-v1` in `engines`; the shipped catalog lists none |
| 5 | Native runtime | `engine-unavailable`: `muse-v1` is not in `built_in()`; the run ends before any request, working copy or tool (E2E, with an **activated** fixture, saved configuration and scoped models: `error_code == engine-unavailable`, 0 provider requests, 0 turns, no worktree) |
| 6 | Identity | even with the engine, a continuation cannot cross modes (§4) |

## 4. S3 + S4 — continuity

`identity_digest` (v2) hashes: mode, engine, role, model, route, provider, connection, execution kind,
protocol, endpoint, credential reference, wire profile, default effort, request budget (C1) and the
slot's **explicit** `allowedReasoning`, canonicalised as a sorted, de-duplicated list. Everything is
present only when configured, so:

* policy-less bindings hash **byte-for-byte** as at the baseline (pinned: `b367efc6…a07d`; with a 428,722 B
  budget `bbebf734…3bd9`, both computed by the baseline code);
* default-only (`[low]`), widened, narrowed, removed and added policies are five distinct identities;
  spelling/order/duplicates are not (`["medium","low"]` ≡ `["low","medium"]`).

Runs now record `taskBindingIdentityVersion: 2`. `identity_matches`:

| Recorded | Rule |
|---|---|
| version 2 | digest equals this binding's v2 digest |
| none (recorded before EM-04C2) | digest equals the **legacy** digest **and** the new binding carries **no** explicit policy; an old record cannot prove which policy it ran under, so a binding that authorizes extra levels is refused |
| any other version | never matches |

`task_binding_continuity` now runs **before** `engine_for_run` (`inspect.rs:840`), so a continuation
that changed mode — hence engine — is `task-binding-mismatch`, not an `engine-unavailable` that would hide
the change. A continuation is issued in the mode of the run it continues (`resume_run` carries the
recorded `engine_mode_id` unless it is the default). E2E (7 cases) proves: same policy and re-spelled
policy continue; default-only → widened, mid → wide, wide → narrowed, wide → removed, none → added are all
`rejected` / `task-binding-mismatch` with **0** provider requests and 0 turns; a legacy record
(version key removed) continues; a cross-mode continuation (record re-pointed at the adaptive mode, with
the adaptive mode fully activated) is `task-binding-mismatch`.

## 5. Compatibility evidence

| Subject | Result |
|---|---|
| Policy-less identities | byte-identical to the baseline (unit test with baseline-computed constants) |
| Default issuance with and without `modeId: engineering-v2` | identical resolution, core, extension, binding, issuance id (E2E) |
| 34 existing Registry / Native / MusePreset JS suites (+ closure and clean-install suites) | all exit 0 |
| `muse-v0` provider request bodies | dump comparison against the baseline commit (checkpoint report §5) |
| Historical records | `signal-accepted` events and records without the identity version stay readable (unit + E2E) |

## 6. Concerns and decisions for review

1. **Experimental ids in a JS table.** Reviewed trade-off: it keeps the experimental-engine fixtures
   (dozens of E2E tests) working and is narrower than baseline; the alternative (an injected table)
   would add an override path. They never reach production: the Rust runtime refuses them.
2. **No client can choose the adaptive mode from conversations, the CLI or the Desktop** at this
   checkpoint (`to_selection`/`parse_thread_selection` set `mode_id: None`). That is intentional; the
   field exists on the intent contract for coding runs only (`bad-intent` otherwise).
3. **Legacy records with a policy fail closed** (cannot be continued under an explicit policy). Only
   engines able to change effort could have used the extra levels and none shipped one.
4. **Behaviour change in error precedence:** a continuation with both a changed identity and an
   unavailable engine now reports `task-binding-mismatch` first. The EM-01 test that tampers the
   engine id alone still reports `engine-continuity-mismatch` (identity unchanged).
5. **`parity.cjs` `KNOWN_ORCHESTRATION_ENGINES` was not changed** (the plan listed it under S4). It is
   a legacy DSH isolation check that never sees the Native issuer; widening it is not needed for S4 and
   belongs with the engine in S6.
6. **`parseSelectionJson` loads the issuer module** only when a `modeId` is present, so the default
   selection path loads exactly what it loaded before.

## 7. Verdict

The Registry remains the only authority over modes, engines, models, reasoning policy and budgets; the
new mode is defined, validated and sealed but unreachable; continuity can no longer silently inherit a
different mode or reasoning authorization. **APPROVE**, with concerns 1–3 recorded for the reviewer.

## Erratum (added in S7–S9; the original text above is kept as written)

* §3 gate 2 ("a real install does not carry the definition") is correct only for the preset dependency closure.
  Both installers publish `config/registry/` recursively, so installations carry the dormant definition and the
  Registry lists it as a non-executable `planned` row (owner decision D-1: accepted). Gate 2 is therefore NOT an
  independent barrier; the barriers are gates 1 and 3–6.
* §5 "34 existing Registry / Native / MusePreset JS suites … all exit 0" was incorrect: seven of them failed
  at this commit (see `EM-04C2-CHECKPOINT-1-REPORT.md`, erratum). The defect was in `legacy-import.cjs`
  (a count-based completeness check) and `service.cjs` (a phantom row for an absent optional mode); both are
  fixed in S7–S9 with a closed identity for the optional definition.
