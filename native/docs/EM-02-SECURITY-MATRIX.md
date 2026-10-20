# EM-02 — Security matrix

Legend: **R** = Registry (`native-task-binding.cjs`), **K** = Kernel, **X** = executor
(`nexus-model`), **B** = broker. Test files: `tm` = `nexus-broker/tests/em02_attempt_targets.rs`
(real JS Registry + real Kernel + real prepare/dispatch), `a56` = `nexus-broker/tests/code_a56.rs`
(full stack: daemon, bridge, sandbox, mock provider), `tb` = `nexus-contracts/src/task_binding.rs`
unit tests, `js` = `tests/NativeTaskBinding.Tests.cjs`, `ad` =
`nexus-model/tests/authorized_dispatch.rs`.

| # | Case | Expected | Enforced by | Tests |
|---|---|---|---|---|
| 1 | Two attempts of one task with different declared efforts | both execute; bodies differ only in `reasoning.effort` | R, K, X | tm `two_attempts_of_one_task_…`; a56 `em02_the_broker_authorizes_…`; js; tb |
| 2 | Their provider / model / route / connection / endpoint / credential | identical | K (`admits` projection) | tm (field-by-field), a56 |
| 3 | The default effort | the task's own issuance, no call, unchanged ids | R, B | tm, a56, js |
| 4 | Same effort requested twice | same target (content-addressed), no new authority | R, K | tm, js |
| 5 | Effort not authorized (`xhigh`, `max`, `minimal`, non-levels) | refused, never escalated/downshifted; an effort outside the target's own policy is refused already at `seal_issuance` | R, B (pre-check), K | tm, a56, js, tb |
| 6 | Attempt target changing route / model / provider / connection / logical model (self-consistent forgery, even if sealed) | `binding-mismatch` at accept | K | tm `unsupported_redirecting_…`, tb |
| 7 | Attempt extension changing endpoint / limits / credential (same core) | `binding-mismatch` at publish | K | tm, tb |
| 8 | Effort split between target and extension | refused | K, R | tb, js |
| 9 | Another task's attempt target | `generation-mismatch` (K), `registry-binding-mismatch` (R) | R, K | tm |
| 10 | Tampered / widened binding presented to the Registry | `registry-binding-invalid` | R | tm, js |
| 11 | Second, different binding for a task (stale/duplicate/forged) | refused by derivation (`binding-mismatch`); store first-writer-wins (`issuance-conflict`) as second line; identical re-seal idempotent | K | tm, st, a56 (`TaskTarget::issue` twice) |
| 12 | Binding not describing the sealed task issuance | refused at seal | K | tm |
| 13 | Tampered binding at rest (store row edited) | `store-corrupt`, fail closed | K | tm `an_unbound_task_…` |
| 14 | Task without binding (legacy) switching issuance | `binding-mismatch` at accept | K | tm |
| 15 | Registry configuration change mid-run (slot policy revoked, route level removed, default switched) | running task unaffected: authorized from its sealed binding only; the new issuance cannot be executed under it | R (binding-only input), K | tm `a_registry_change_mid_run_…` |
| 16 | Kernel restart | binding durable and enforced | K | tm (reopen + forged refused + genuine accepted) |
| 17 | Broker restart + continuation after the operator switched the default model | continuation keeps the original model/route; identity equal | B | a56 `em02_a_continuation_keeps_…` (fails on `2da0cc3`: ran on the new default) |
| 18 | Continuation whose binding identity differs | `rejected` / `task-binding-mismatch` before any working copy or request | B | a56 `em02_a_continuation_under_another_binding_identity_…` |
| 19 | Continuation of a run whose model/route was never recorded | refused, not continued | B | a56 `em02_a_continuation_under_another_binding_identity_…` (record without route → refused: "model and route are not recorded") |
| 20 | Binding missing / malformed / unsealable / unrecordable at task start | run fails closed before any request | B | covered by construction; every a56 run seals one (`em02_a_run_executes_…` asserts the record) |
| 21 | Grant naming another target/extension than the prepared request | nothing sent | X | ad `a_grant_naming_another_target_extension_sends_nothing` |
| 22 | Ambiguous delivery / lost answer | new attempt, new command, one receipt per request, one issuance, no double dispatch | K, X, B | a56 `em02_recovered_attempts_…`; existing a614 interruption tests |
| 23 | Replayed (executed) attempt | not dispatched again | K | tm (re-run of attempt 2) |
| 24 | Untrusted model/tool output selecting effort | impossible: no code path; engine v1 admits `KeepPinned` only; `for_attempt` takes effort only from trusted broker code | B, EM-01 host | EM-01 host tests (effort refusal, hostile engine) |
| 25 | Operator approvals and Kernel tool permissions | unchanged code paths | — | full a56 approval/budget/write/process suites in the battery |
| 26 | Request shape | same keys, tool digest, effort `low`, bytes | — | a56 `em01_the_engine_boundary_…`; byte comparison (implementation report) |
| 27 | Route declares a level, operator slot policy absent | only the default is authorized (Registry, broker, Kernel) | R, B, K | tm `a_route_level_outside_the_slot_policy_…`, a56 broker test (route-only task), js, tb |
| 28 | Slot policy names a level the route does not declare, or omits the default | the mode configuration does not compile / cannot be saved | R (schema + resolver) | tm, driver smoke |
| 29 | Narrower policy than the route | exactly the policy's levels | R, K | tm |
| 30 | Binding `supportedReasoning` widened/narrowed BEFORE sealing (digest recomputed) | Kernel `seal_task_binding` → `binding-mismatch`; Registry → `registry-binding-mismatch` | K (derivation), R | tm `capability_tampering_before_…`, js, tb |
| 31 | Policy injected into the binding's target projection | refused (projection ≠ sealed target) | K | tm |
| 32 | Issued target `allowedReasoning` widened without re-deriving digests | `seal_issuance` → `delivery-invalid` | K | tm |
| 33 | Issued target policy that changes between task and attempt | projection mismatch → refused | K | tb |
| 34 | First issuance fully re-derived by the issuer channel (model OR policy) | accepted for an unbound task in both cases (issuer channel = trust root, documented); refused in both cases once bound | K | tm `capability_has_exactly_the_provenance_of_the_model_identity` (characterization) |
| 35 | Selection of a different model than the saved slot assignment | the saved policy does not follow; default only | R | tm `a_slot_policy_does_not_follow_a_selection_of_another_model` (real bridge selection path) |
| 36 | Existing configurations (no policy) | targets/digests/requests byte-identical to `2da0cc3`; non-default disabled | R | byte comparison, em01 guard, JS suites before/after identical |
