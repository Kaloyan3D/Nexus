# EM-04C1 — Production preparation of the Muse engine: architecture

Baseline `49026e8` (EM-04B). Worktree `~/Projects/Nexus-muse-production-prep`, branch
`feature/native-muse-production-prep`. **Uncommitted**, for architectural review. Offline only; no
provider inference; no push, merge or deploy.

EM-04C1 makes the existing Muse implementation safe to activate **without activating it**. Three
pieces, plus a review:

1. a persistent, supervised, stateless Node worker behind the Governor/Signals bridge;
2. a Registry-sealed, per-mode serialized-request budget;
3. frozen, per-profile tool-catalog identities and a single catalog authority;
4. a review of the historical Governor's anti-thrash behaviour (policy untouched).

Companions: `EM-04C1-IMPLEMENTATION-REPORT.md`, `EM-04C1-IPC-SECURITY-MATRIX.md`,
`EM-04C2-ACTIVATION-HANDOFF.md`.

## 0. What did not change

| Area | State |
|---|---|
| `muse-v0` (the only selectable engine) | Request bodies byte-identical to `49026e8` (report §4). `engine/muse_v0.rs`, the Kernel, the daemon, `config/Muse-Reasoning*.cjs`, model/provider/route assignments: **not modified**. |
| Default effort | `low`; adaptive effort is not enabled and has no switch. |
| `MUSE_V1_PRODUCTION_ENABLED` | still `false`; `engines(false) == ["muse-v0"]`. `muse-v1-shadow` / `muse-v1-signals` stay `test-engines`-only. |
| Historical algorithms | The four CommonJS modules are embedded byte-for-byte and executed unchanged by the same adapter script as before; `sources_digest()` (decision evidence) is unchanged. |
| Persisted engine records | schema 1 / contract 2 unchanged; EM-03 fixtures reopen byte for byte. |
| Registry authority | Still the only issuer of targets, efforts and (new) budgets. No second Registry or Controller was introduced. |
| `requestMax` | still not model-facing (signals path refuses it, pinned by test A10). |

## 1. Persistent Governor worker (Phase 1)

### 1.1 Shape

```
 run (inspect.rs) ── WorkerLease ──owns──> WorkerGovernorBridge ──spawns/kills──> node muse_bridge_worker.cjs
                                              │  (implements GovernorEvaluator;       │  (hosts the UNCHANGED
                                              │   one process per run)                │   one-shot bridge source)
                          engines call evaluator.call(op, args)  ◄──length-framed JSON──►
```

* `engine/worker_bridge.rs` — the supervisor (`WorkerGovernorBridge`, `WorkerLease`, protocol,
  bounds, stats).
* `engine/muse_bridge_worker.cjs` — the worker. It contains **no policy**. For every request it
  executes the unchanged one-shot bridge (`muse_bridge.cjs`) in a fresh closure, with a stand-in
  for the `process` object, so the Governor/Runtime/Activity/Signals modules are re-instantiated
  with a fresh virtual store and fixed clock each time.
* The engines still see only `Arc<dyn GovernorEvaluator>`; the extension boundary is unchanged.
  The one-shot `NodeGovernorBridge` remains (reference implementation, benchmark baseline,
  `NEXUS_TEST_BRIDGE=oneshot` runs the same suites against it).

### 1.2 Statelessness

The worker keeps nothing between requests: no reasoning ledger, no routing state, no
processed-signal window. Each request carries the complete Muse blocks (the Broker's engine state)
and returns the complete result. Consequences:

* a restart loses nothing; a request can be re-asked of a fresh worker and returns the same answer;
* a duplicated or replayed IPC message cannot create a second accepted transition: the only thing
  that changes state is the host's validated, durable commit of the **one** answer it consumed;
* tasks cannot cross: one process per run, scope echoed and checked.

### 1.3 Lifecycle (explicit ownership, no daemon)

| Event | Behaviour |
|---|---|
| first call | lazy spawn: `node --max-old-space-size=96 -e <worker> -- <scope>`, `env_clear`, stderr null; handshake (sources + digests) |
| normal call | one frame out, one frame in, id = previous + 1 |
| worker died while idle | detected before use, replaced |
| worker died / violated protocol during a call | process killed and reaped, **one** retry on a fresh worker, then `bridge-failed` / `bridge-protocol` |
| timeout (10 s) | SIGKILL, reap, `bridge-timeout`, **no** retry |
| cancel flag (run cancelled) | polled every ≤ 20 ms; kill, `bridge-cancelled`; nothing restarts |
| crash loop | > 6 spawns / 60 s ⇒ `bridge-restart-limit` |
| run ends / early return / unwinding | `WorkerLease::drop` → `shutdown` → kill + reap + join; later calls `bridge-closed` |
| broker dies | the worker's stdin reaches EOF and it exits |

`inspect.rs` creates the bridge object only for the two Governor-capable engines (test-only today)
and holds the lease for the whole run; the **process** is spawned lazily at the first evaluation.
`muse-v0` never creates a bridge or a process (tested). Peak RSS per worker plateaus at ≈ 132 MiB
(heap cap 96 MiB + runtime); worst case 16 workers (report §8.1).

### 1.4 Protocol (v1) and bounds

4-byte big-endian length + UTF-8 JSON; `hello`/`ready` handshake, then strictly one request in
flight. Envelope fields are closed sets. Bounds: request args ≤ 512 KiB (frame ≤ 640 KiB, hello
≤ 1 MiB), response ≤ 256 KiB, ≤ 4 waiting callers per worker (`bridge-busy`), ≤ 16 live workers per
broker, 96 MiB V8 old space, 10 s per request. Every violation by either side ends the process.
The full threat table is `EM-04C1-IPC-SECURITY-MATRIX.md`.

### 1.5 Failure semantics are the engines' existing ones

The shadow records an error outcome and the run continues unaffected; the signals engine reports
"not recorded", applies nothing, and never applies it later. Durable-before-ack and fail-closed
authorization are untouched because nothing about *who commits what, when* changed: the worker
only replaces *how fast* the same pure function is computed.

## 2. Registry-sealed per-mode request budget (Phase 2)

The budget policy owner is the Registry. The flow reuses the EM-02 `allowedReasoning` pattern
(emitted only when configured, so unconfigured targets are byte-for-byte unchanged):

```
modes/<mode>.json  requestBudgetBytes  ──schemas.cjs (int, 65,536..4,194,304)
  → resolver.cjs  binding.requestBudgetBytes  (folded into the resolution id)
  → native-issuer.cjs  target.requestBudgetBytes  (digest-covered, sealed by the Kernel)
  → nexus-contracts ExecutionTargetCoreV1.request_budget_bytes (Option, skipped when None; bounds in validate_complete)
  → TaskBindingV1.target (projection keeps it; admits() compares it)  → TaskTarget::request_budget_bytes()
  → inspect.rs: effective = min(sealed, broker value) | sealed | broker value (test seam)
```

Rules (all tested):

* **`muse-v0` / any mode without a declaration:** no key anywhere; same digests; same bytes.
* **Bound to the authorized task/mode:** the budget is part of the sealed target, therefore of the
  issuance, the task binding digest and the **binding identity** a continuation must keep (the
  identity digest includes the key only when present). Every attempt's issuance must carry the same
  value (`request-budget-mismatch` otherwise).
* **Unauthorized changes are refused:** an edited issuance is not self-consistent; another budget
  under the same binding fails `admits`; out-of-range values fail the Registry schema, compile and
  the Kernel's `validate_complete`; a changed mode budget between interruption and continuation is
  `task-binding-mismatch` before any request.
* **The broker can only tighten.** `BrokerConfig.request_budget_bytes` (`None` in production)
  never widens a sealed value.
* **Never truncating mandatory content:** the EM-04A `request_budget::fit` is unchanged: user
  messages, function calls and the latest step are never touched; the reserve is the engine's;
  unmet ⇒ `request-budget-exceeded` before the attempt is bound or dispatched.
* **No activation:** no shipped mode declares a budget.

## 3. Tool catalog integrity (Phase 3)

* `nexus_model::repo_tools` pins one SHA-256 per profile (`REPO_INSPECT_V1_…`, `REPO_CODE_V1_…`,
  `REPO_CODE_MUSE_SIGNALS_V1_…`). The first two were computed on the baseline commit and are
  equal there; the signals catalog is a distinct identity.
* `engine::tool_catalog_profile(engine_id, code_run)` is the single authority: a pure function of
  the run kind and the **sealed** engine id. Only the exact id `muse-v1-signals` (a `test-engines`
  build) selects the signals catalog; the future production `muse-v1` will get its row in EM-04C2
  deliberately.
* At run start the broker verifies the build offers exactly the frozen bytes
  (`verify_catalog`, else `tool-catalog-mismatch`) and records the digest on the run record
  (`toolCatalogDigest`, set once).
* Nothing a run sees or says reaches the selector. Tests: wire `tools` digest per request equals
  the frozen identity; hostile file text and forged/cross-engine/invented tool calls are refused;
  catalogs are mutually distinct; any one-character edit is detected.

## 4. Anti-thrash review (Phase 4)

Policy untouched. `engine/anti_thrash_review.rs` drives the real modules and pins what they do
(A1–A10). Findings and the proposed EM-04C2 policy are in `EM-04C2-ACTIVATION-HANDOFF.md` §3.

## 5. File map

| New | Purpose |
|---|---|
| `engine/worker_bridge.rs`, `engine/muse_bridge_worker.cjs` | supervisor, worker |
| `engine/worker_tests.rs` | 24 tests + benchmark |
| `engine/catalog_tests.rs` | 5 tests |
| `engine/anti_thrash_review.rs` | 10 review tests |
| `tests/RegistryRequestBudget.Tests.cjs` | 6 Registry tests |

| Modified | Change |
|---|---|
| `config/registry/{schemas,resolver,native-issuer}.cjs` | optional `requestBudgetBytes` |
| `nexus-contracts/src/{target,lib,task_binding}.rs` | field, bounds, 3 tests |
| `nexus-model/src/{repo_tools,target}.rs` | frozen digests, 3 tests |
| `nexus-broker/src/{attempt_target,inspect,server,store}.rs` | sealed budget, catalog authority, worker lease, run-record digest |
| `nexus-broker/src/engine/{mod,governor_bridge}.rs` | `tool_catalog_profile`, module wiring, `berr` visibility |
| engine test modules, `engine_state.rs` test | run against the worker by default (`NEXUS_TEST_BRIDGE=oneshot` for the old bridge); restart tests |
| `nexus-broker/tests/code_a56.rs` | 9 E2E tests, a fixture with a budgeted mode, an inert body-dump harness |

## 6. Limitations

See the implementation report §6 and the IPC matrix §4.
