# Provider accounting and accepted pressure

Qualification21 remains FAIL under 8429c39. Its reports are immutable; it does
not qualify this revision. Unknown failed-attempt usage is null, never zero or
an estimate. Accepted durable request usage alone determines scientific input
totals and phase pressure. Known failed usage is separate billing evidence.

Architecture review before implementation:

1. Source of truth: immutable Harness events own accepted results and retry
   receipts; raw SDK JSONL owns invocation, transport failure and reported usage.
   Frozen runtime provider settings and the installed resolver own retry policy.
2. Ownership: the existing Harness/observer remain the only writers. A local
   accounting reader derives receipts; it cannot submit, stop or retry requests.
3. Direction: telemetry consumes the pure accounting module; validity consumes
   its admission and totals. Neither accounting nor validity imports runners.
4. Contract: plain evidence records cross the seam, bound by session, RPC, phase,
   turn, step, attempt, time and provider/model. No SDK objects or prompts cross.
5. Failure: absent, ambiguous or corrupt raw evidence cannot admit a failed
   attempt. Missing successful usage/pressure and unobserved requests stay fatal.
   No read failure changes retry execution or timing.
6. Lifecycle: receipts are rederived from persisted events after flush; no new
   durable state, timers or recovery process. Abnormal exits retain originals.
7. Tests: pure inputs substitute events, raw evidence and resolved policy;
   integration exercises the telemetry reader. No live provider tests.
8. Compatibility: existing successful evidence remains valid; failed evidence
   needs the new strict proof. Historical reports are neither migrated nor
   rewritten. Git rollback restores the old validator without touching evidence.
9. Observability: reports distinguish complete scientific pressure from
   incomplete billing, with failed-attempt counts, retry receipts and raw IDs.
10. Security: read only existing sanitized JSONL and narrowly selected provider
    settings. Persist no settings, credentials, raw prompts or source contents.

Official provider policy is unchanged, including its existing fresh-root/sealed
checkpoint abort conditions and budgets. This correction never authorizes new
retries or suppresses those terminal conditions. Billing unavailability alone
does not invalidate a proven legal recovered request.

Executable harness identity changes. Workload identity, scientific thresholds,
prompts and execution protocol stay unchanged. If official report code changes,
the source-based official protocol hash must change honestly, even though
execution/retry semantics do not.
