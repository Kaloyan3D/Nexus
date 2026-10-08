# CCv2 integration plan, before implementation

Bounded objective: selectively integrate production CCv2 into integration/ccv2 on dev 9f5f109, preserving current dev behavior, with offline comprehensive verification and reviewable commits. No LHCB, inference, policy redesign, protected history changes, or unrelated fixes.

## Architecture review
1. Source of truth: task ledger and native ccv2-authority are controller-owned; durable session events remain DSH-owned; checkpoint/page/view artifacts derive from task authority plus exact evidence. Provider counters authorize counts; local estimates do not impersonate provider authority.
2. Ownership: TaskController creates task authority; typed ContextTaskAuthority mutations own categories; memory producer derives pages/checkpoints; active host owns request projection only. Existing DSH compaction owns its durable surface transitions.
3. Dependencies: controller and isolation hosts consume stable Context* contracts and Engineering-Profiles; compiler consumes pages/trust/counters. Controller-request boundary composes per-agent authority inside patched DSH selection. Preset closure copies the same source modules/assets; it is not a second implementation.
4. Contracts: versioned closed-world checkpoint/operation/page schemas; immutable route target; explicit nexus/session-prepare extension; exact provider/model and request projection at llm/stream. No live session objects in persisted bindings, no prompt injection of hidden reasoning, no benchmark observer dependencies.
5. Failure: preserve existing KEEP/BLOCK/Native fallback, stale authority quarantine, bounded remote counter deadlines, safe-point refusal and recoverable operations. Do not change provider retry behavior. Routing failures reject before transport; session bootstrap validates exact profile and identity.
6. Lifecycle: controller creates identity before routing; recover interrupted preparation idempotently; memory registry follows session lifecycle; durable operations validate and read back before mutation, reconcile after restart; apply locks dispose; preset install stages, validates, swaps and restores on failure.
7. Test seams: existing injected I/O/time/counters; fixture controller child CLIs; real pinned DSH scopes and transport doubles; cross-process crash tests. All provider probes use local mock transports. Strict host gates run the actual installed substrate without inference.
8. Compatibility: keep dev OpenCode header patch, Go managed-settings migration, public profiles, Linux detached process and READY validation. V1 compaction records stay V1; legacy authority bootstraps explicitly. New V2 artifacts use separate schema/namespaces. Revert integration commits to rollback code; preserve durable artifacts and never reinterpret them as V1.
9. Observability: existing bounded controller diagnostics, authority/activation/fallback reason codes, shadow observer and generation evidence. Offline activation replay is a regression/debug utility. No benchmark provider instrumentation or raw source/prompt persistence added.
10. Security: task/workspace/session binding, fail-closed route authority, trust/secret redaction/page bounds, exact installed hashes. No credentials read or emitted; no new egress except existing governed production counter path; no live API requests during verification.

## File plan
- Import standalone production config/Context*V2 modules, exact tokenizer assets, Controller-RequestBoundary and Routing-Integrity, vendored DSH agent plus rebuild provenance.
- Merge only CCv2 additions in ContextCompaction, ContextLifecycle, AihController, isolation, route/profile resolution, preset builders/validators, installer closure and UI route contracts.
- Port 71ea5ac controller preparation API and its relevant regression tests/docs from frozen c221afad.
- Keep dev-only OpenCode/Linux/settings/profile functionality and tests. Do not import feature reversions of those.
- Import deterministic compiler/memory/counting/recovery/composition/preset tests and their small helpers; exclude provider-observability fixture, LHCB infrastructure and live acceptance experiments. Import offline CCv2-ActivationReplay because activation regression tests exercise it.
- Extend standard Test-Harness with production regression suites and strict offline DSH gates.
- Execute Node baseline then integrated suites, full PowerShell harness on Linux, shell/static/secret checks and isolated actual dependency install/composition. Windows runtime is unavailable; report that separately.
- Fix only observed integration defects with reproducer. Review complete diff and commit with configured user identity. No merge into dev/main or remote push.

## Ancestry/method
Feature bb2a2be and fix 081c540 trees are identical; mergebase 6011d55, dev unique 182, feature unique 232. Merge simulation produced 46 conflicts. Selective production port avoids unrelated historical replay and older Linux/OpenCode regressions. Protected c221afad benchmark/tag are read-only.
