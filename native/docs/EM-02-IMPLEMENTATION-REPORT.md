# EM-02 — Implementation report

Worktree `~/Projects/Nexus-per-attempt`, branch `feature/native-per-attempt-reasoning`, base
`2da0cc3`. **Uncommitted.** No push, merge, deploy or paid inference. Architecture:
`EM-02-ARCHITECTURE.md`; cases and tests: `EM-02-SECURITY-MATRIX.md`.

## 1. Changed files

New:

| File | Purpose |
|---|---|
| `native/nexus-contracts/src/task_binding.rs` | `TaskBindingV1`, projection, `authorized_levels`, `admits` / `admits_target` / `matches_task_issuance`; 4 unit tests |
| `native/nexus-store/tests/task_bindings_em02.rs` | store-level immutability (first writer wins) |
| `config/registry/native-task-binding.cjs` | Registry: `buildTaskBinding`, `authorizeAttemptTarget` |
| `native/nexus-broker/src/attempt_target.rs` | `TaskTarget` (`issue`, `seal`, `pinned`, `for_attempt`), `EffortRequest`, `AttemptTarget`, `identity_digest` |
| `native/nexus-broker/tests/em02_attempt_targets.rs` | 9 trusted-interface tests (real Registry + Kernel + prepare/dispatch), incl. capability provenance, slot policy, selection path |
| `tests/NativeTaskBinding.Tests.cjs` | 7 JS Registry tests |
| `native/docs/EM-02-*.md` | these documents |

Modified:

| File | Change |
|---|---|
| `config/registry/native-target-v2.cjs` | issuance additionally returns `taskBinding` / `taskBindingDigest` (issuance and extension bytes unchanged); a saved slot policy follows a selection only for the same model+route |
| `config/registry/schemas.cjs`, `resolver.cjs`, `native-issuer.cjs` | **hardening**: optional operator slot policy `allowedReasoning` (schema, route-checked by the resolver, carried in the issued target only when configured) |
| `config/registry/native-intent-bridge.cjs` | `issue` emits the binding; new `issue-attempt` subcommand |
| `native/nexus-store/src/{schema,store}.rs` | additive `task_bindings` table; `seal_task_binding` (first writer wins), `fetch_task_binding`, `accepted_issuance_ids` |
| `native/nexus-kernel/src/dispatch.rs` | `seal_task_binding`; authenticated `sealed_task_binding`; `publish_intent` enforces the binding |
| `native/nexus-kernel/src/accept.rs` | `accept_command` enforces the binding; unbound tasks cannot switch issuances |
| `native/nexus-daemon/src/{protocol,server}.rs` | privileged `seal-task-binding` command |
| `native/nexus-model/src/authorized.rs` | dispatch refuses a grant whose target/extension digests differ from the prepared request |
| `native/nexus-client/src/mock.rs` | `run --mock` prepares from the target its Kernel seals (it previously used two unrelated synthetic targets; the mock now names `remote-model`) |
| `native/nexus-broker/src/inspect.rs` | continuation identity check; seal + record the binding at start; each attempt's resolution/core/extension from `for_attempt(Pinned)` |
| `native/nexus-broker/src/server.rs` | `bind_task_target`; continuation carries the interrupted run's model + route |
| `native/nexus-broker/src/store.rs` | run record: `taskBindingDigest`, `taskBindingIdentity` (optional, broker-internal) |
| `native/nexus-contracts/src/target.rs` | **hardening**: `ExecutionTargetCoreV1.allowed_reasoning: Option<Vec<String>>` (skipped when absent → existing digests unchanged); `validate_complete` refuses an effort outside it |
| tests: `code_a56.rs` (+5 E2E), `authorized_dispatch.rs` (fixture made consistent, +1 test), `broker_a53.rs` / `inspect_a55.rs` (new record fields), `nexus-daemon/tests/e2e/driver.cjs` (`registry-levels`, `registry-default`, `issue-attempt`, binding in `issue`) |
| `native/nexus-broker/Cargo.toml`, `native/Cargo.lock` | `rusqlite` dev-dependency (tamper test) |

Totals: 22 tracked files, +901/−90; 7 new files. Not changed: reasoning default, Registry
assignments, tool schemas, EngineExtension policy, approvals, Kernel tool permissions.

## 2. Behaviour

* **Unchanged for `muse-v0`:** the same model, route, effort (`low`), request bytes and tool
  schemas. The turn loop takes each attempt's target from `for_attempt(Pinned)`, which returns
  the task's own issuance without any call.
* **New at task start:** one `seal-task-binding` daemon call. The binding is recorded on the run.
* **New at continuation:** the continuation runs on the interrupted run's model and route. A
  different binding identity → `rejected` / `task-binding-mismatch` before any working copy or
  request. A record without a model/route → not continued.
* **New guarantees:** (Kernel) every attempt of a bound task stays on its model/route/connection
  and uses a declared effort; an unbound task cannot switch issuances. (Executor) only the target
  the grant names is sent.

## 3. Request-shape comparison (baseline `2da0cc3` vs EM-02)

Same machine, throwaway copies of both trees, identical scenarios, bodies byte-compared:

| Scenario | Requests | Result |
|---|---|---|
| read-only run, tool call, reasoning replay (P0 responder) | 2 | byte-identical (8,257 B, 9,009 B) |
| coding run, `fs_write`, then `muse-v0` nudges | 5 | byte-identical (8,019–9,487 B) |
| EM-01 guard in the full suite | all | same top-level keys, tool-schema SHA-256 `58f513de…`, `reasoning.effort = "low"` |
| A614 long loop | 55 | max request 449,944 B (unchanged) |

No new model-facing tool and no new request field. Authorization metadata (binding, digests)
never reaches the provider.

**Intended difference, demonstrated:** `em02_a_continuation_keeps_its_model_and_route_when_the_registry_default_changes`
(interrupt → operator switches the default to `e2e-2` → broker restart → continue).
- On `2da0cc3` it **fails**: the continuation ran on `e2e-mock-model-2`.
- On EM-02 it passes: the continuation runs on `e2e-mock-model` with the same binding identity.

## 4. Test results (offline, `NEXUS_REQUIRE_SANDBOX=1`, FINAL code after the hardening round)

| Gate | Result |
|---|---|
| `cargo fmt --check`; `cargo clippy --workspace --all-targets -D warnings` | clean; 0 findings |
| **Complete battery** `cargo test --workspace --no-fail-fast`, run after the last change | **952 passed, 0 failed, 49 ignored** (49 = multi-UID tests needing a prepared host, as on every baseline) |
| — reconciliation | R-LOCK-1 `2da0cc3`: 932. EM-02 adds 20: contracts 4, store 1, `authorized_dispatch` 1, trusted-interface 9, `code_a56` 5 |
| `code_a56` (full stack) | 87 passed, 4 ignored; EM-01 request guard included |
| A614 long loop | max request 449,944 B (unchanged) |
| Request bodies vs `2da0cc3` (final code) | 7/7 byte-identical (read-only run: 2; coding run: 5) |
| Desktop Tauri | 27 passed, 2 ignored |
| JS: `NativeTaskBinding` (new) | 7/7 |
| JS: the 30 other suites that load the Registry, run before (stash) and after on this machine | **identical results**. Passing include RegistryCore 45, R2Compatibility 41, NativeTargetV2 17. Failing identically on `2da0cc3` for environment reasons only, **not EM-02**: NativeShadowA12 72/74 and A13 39/40 (`pwsh` sections); RegistryR65Matrix (`spawn pwsh ENOENT`); RegistryR62Shadow, R631Lockdown, R632Execution, R63Binding, R70Readiness, R74RollbackRecovery, R75InstallationAudit (installed-runtime/`pwsh` paths and a missing `tmp/` directory); DeepSeekRequestBoundaryHost skips (needs a DSH host) |
| Earlier rounds (for the record) | a stale `nexusd` binary (not rebuilt by `cargo test -p nexus-broker`) once rejected policy-carrying issuances until rebuilt; the 9 mock-run failures and the row-19 assertion were fixed earlier; none remain |

## 5. Performance (offline, measured, not optimized)

| Path | Cost |
|---|---|
| Default effort (`Pinned`, every `muse-v0` attempt) | **0 extra calls** per attempt |
| Task start | +1 daemon call (`seal-task-binding`, Kernel ≈ 2 ms) |
| Non-default effort (not reachable in EM-02 production) | +1 Registry bridge process, median **190.6 ms** (n=15; dominated by Node startup and Registry module load), plus Kernel seal of issuance + extension, median **2.0 ms** (n=15) |

The ~190 ms is in the same range as each existing per-turn bridge call (`attempt-add`, `shadow`,
`kernel-intent`, `publish`). A long-lived Registry worker would remove it. That would be an
optimization for EM-03 or later, and must not weaken authorization.

## 6. Remaining risks

1. **Supported levels are captured at task start.** If an operator removes a level mid-run, the
   running task may still use it until it ends (tested). This is the intended "no redirect"
   semantics. Revocation of a capability mid-task would need an explicit EM-03 decision.
2. **Slot policy is operator data in the mode configuration** (`slots.<id>.allowedReasoning`).
   No shipped configuration or existing data root has one, so non-default effort is disabled
   everywhere until an operator sets one. Two independent gates keep `muse-v0` on `low`:
   the engine (v1 `KeepPinned` only) and the policy (absent → default only). A mode-DEFINITION
   ceiling (what a mode permits regardless of operator choice) does not exist yet; see §7.
3. **Trust root = the issuer channel (unchanged).** Since the hardening review, the authorized
   levels are part of the Registry-issued, digest-covered target, and the Kernel DERIVES them
   (the binding only echoes them). A delivery channel cannot add a level without forging the
   task's first issuance itself. That would give it the same power to forge the model or route,
   and the Kernel accepts such a forgery today because the Registry runs inside the issuer
   identity (characterized by `capability_has_exactly_the_provenance_of_the_model_identity`).
   Removing that would need a Registry in its own trust domain with a signing key the Kernel
   verifies: an architectural change, not EM-02.
4. **Continuation identity relies on the broker's run record** (as EM-01's engine binding). The
   Kernel binding covers each task generation; it does not link generations.
5. **A legacy record without a recorded model/route cannot be continued.** This fails closed; a
   user-visible message explains it.
6. **`run --mock` output changed its synthetic model name** (`remote-model-a` → `remote-model`).
   The mock is labelled as such.

## 7. EM-03 contracts required before activation

1. EngineExtension v2: admit `EffortProposal::Change(level)` only for engines/modes whose
   Registry slot policy permits adaptive effort. Map it to `EffortRequest::Authorized(level)` for
   the next attempt only. Emit a timeline/receipt event per non-default effort.
2. Optionally a mode-definition reasoning ceiling (shipped `modes/*.json`) intersected with the
   operator policy; the operator slot policy itself is implemented in EM-02.
3. A decision on capability revocation mid-task (risk 1).
4. Durable, revisioned per-task engine state (approved for a later milestone), carrying its own
   continuation link under the Kernel seal (risk 4).
5. A request-size budget before `muse_update_reasoning_state` (EMv2-scoped) is added; the EM-01
   request guard will fail by design when a tool is added.
6. Optionally, a persistent Registry worker if per-attempt bridge latency matters (§5).
7. If the issuer channel must stop being the trust root for Registry output: a Registry in its
   own trust domain (separate identity) that signs issuances with a key the Kernel verifies.

## 8. Authorization hardening review (final round)

**Concern 1 — capability provenance.** Before this round, `supportedReasoning` was a side field
copied from the route record into the binding and checked only for internal consistency. A
delivery channel could have widened it before sealing without touching the issuance. Now the
authorized levels live in the issued target (`allowedReasoning`, covered by `targetDigest` and
`issuanceId`), and the Kernel derives them (`authorized_levels`) at `seal_task_binding` and at
every publish/accept. Tamper tests run before the binding is sealed: binding widened or
narrowed with its digest recomputed; a policy injected into the projection; the target policy
widened without re-derived digests. All are refused. The remaining trust root is stated precisely
in the architecture (§7).

**Concern 2 — slot policy.** No slot policy existed. EM-02 adds the smallest compatible one: an
optional operator `allowedReasoning` per slot assignment, route-checked by the resolver.
**Absent means default only**, so a route-declared level is never treated as operator-authorized.
Non-default effort stays disabled in every existing configuration; only controlled fixtures set a
policy.

**Behaviour preserved:** targets without a policy are byte-identical (same digests). The EM-01
request guard, the A614 size (449,944 B) and request-body byte comparisons are unchanged
(§3, re-run on the final code).
