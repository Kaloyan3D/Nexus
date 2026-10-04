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
