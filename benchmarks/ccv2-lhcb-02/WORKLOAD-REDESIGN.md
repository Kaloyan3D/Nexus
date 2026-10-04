Workload architecture: integration journeys (calibration untouched)
1. Source of truth: fixture definitions own public business inputs and host oracles; the real fixture store owns committed ledger state.
2. Ownership: candidate source may change only src; released evidence/tools are immutable. Host grading never trusts verifier stdout.
3. Dependency direction: journey consumers -> phase modules -> existing service/persistence. No production dependencies added.
4. Boundaries: JSON action sequences and JSON observations; injected clock and actor; no host live objects or credentials.
5. Failure semantics: expected denial/conflict/validation remain ordinary values; unexpected exceptions are explicit failed action observations, never successes.
6. Lifecycle: each journey creates a new isolated fixture store, executes sequential actions, returns copied account/journal observations, then discards it.
7. Test seams: deterministic clocks, independently calculated oracle, distinct withheld action chains, positive and negative controls.
8. Compatibility: T00/E01–E06 preserved byte-for-byte; all old late outputs and obligations remain required. Rollback retains canonical document exactly, including metadata.
9. Observability: bounded verifier diagnostics, phase request telemetry, per-action results and actual store state; no token budget in candidate prompts.
10. Security: actor authorization before replay, namespaces, opaque keys and redaction are exercised across distant modules; existing OS isolation remains authoritative.

Sustained feature work after E24 (E25–E42)
- Native run4 finished E24 at 329407 reconstructed pressure tokens and T99 at 346206. All E01–E24 cumulative correctness gates passed; T99 omitted declared replay responses. This remains a recorded model failure. No comparisons were eligible.
- Add 18 distinct financial and state-machine consumers: netting, largest-remainder allocations, marginal fees, injected-clock scheduling, committed outbox delivery, fencing leases, stable statement pagination, retention, exact rational conversion, reconciliation, account closure, rollout evidence, atomic import merging, ordered change feeds, replica reconciliation, scoped role inheritance, dry repair plans and Cartesian release matrices.
- Each feature consumes its public JSON contract plus cross-module caller records. integrate calls earlier domain, migration, authorization and rollback interfaces, its preceding feature and a feature six stages earlier. Independent host probes verify actual ordered results and input preservation. These are substantive implementations with different algorithms and failure semantics, not renamed copies or a pressure budget.
- Ownership and isolation are unchanged. Candidate edits src only; contracts/cases/verifiers remain immutable. Pure financial plans do not write canonical persistence; existing service/persistence remains the sole committed state owner. No production source, calibration architecture, thresholds or provider changed.
- Host references validate supported public contracts but are never released to model sessions. Mathematical anchors and dependency regression controls are required separately from reference agreement. T00 and E01–E06 released bytes stay unchanged. The original 32 obligations and 19 critical obligations remain; 18 new required feature obligations extend the fixed comparison workload.
