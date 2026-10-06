# E05 audit caller revision: e05-audit-v1

Design fixed before implementation or live measurement. Calibration19 remains WORKLOAD_INADEQUATE; its evidence is immutable. Exactly one fresh qualification is authorized, with the unchanged 10000 floor, provider, model and scratch protocol. Ordinary pressure failure ends this revision; PASS immediately proceeds to all three official arms. No E47+.

E05 gains one connected responsibility: repair `postAudited(store, command, actor, audits, clock)` in a released `src/audited-service.ts` consumer. Every normal call appends exactly one allowlisted authorization-decision audit, including denied attempts and successful replays. The result, ledger transitions and clock usage remain those of the existing service. Audits describe access decisions, not successful commits: allowed validation/conflict failures remain allow decisions. Inputs stay immutable and published audit objects are detached from caller inputs. The public verifier exercises new commit, replay, revoked/foreign replay, changed-body conflict, invalid posting, stale revision, and another tenant using the same key text. Hidden inputs independently enforce the same contract. Existing E05 evaluate semantics and all earlier/later released artifacts remain unchanged.

Architecture review before implementation:
1. Source of truth: authorization owns access decisions, service owns posting behavior, persistence owns ledger/replay state; caller owns its append-only audit array.
2. Ownership: the adapter appends one sanitized decision to that array, delegates ledger writes exclusively to service; no second ledger writer.
3. Dependencies: audited-service -> authorization/service -> api/persistence. No reverse dependency or cycle.
4. Boundary: explicit store, JSON command/actor, audit sink and injected clock; response is the existing service result. Internal store objects and secret request fields never enter audit output.
5. Failure semantics: normal 403/409/422 responses are audited once. Unexpected thrown dependency errors propagate; no invented success or retry. This local synchronous contract introduces no external dependency or timeout.
6. Lifecycle: caller creates/disposes store and audit array; each completed call appends one independent record. Replay changes audit count but never ledger state.
7. Seams: real fixture store, injected clock counter, VM sandbox and distinct public/hidden JSON inputs; no sleeps or mocked transport.
8. Compatibility: existing service callers, authorization evaluate and E01-E04/E06 byte identities stay intact. Additive adapter API; rollback removes only the new adapter/checks in a new revision, never rewrites old evidence.
9. Observability: bounded public diagnostics, exact audit record/count, ledger history/balance/revision and clock count distinguish healthy behavior.
10. Security: authorization precedes any replay exposure; audit allowlist excludes credentials and request bodies, preserves target tenant and request ID, and avoids shared-object mutation.

Correctness: expand the existing redact-audit obligation with an executable audit-service consistency probe; preserve all prior probes and the 54 obligations / 19 critical obligations. No acceptance threshold changes. Prompt change is E05 only, preserving its original body and the uniform scratch addendum. All eight regression suites must pass under the frozen source before the single live qualification.
