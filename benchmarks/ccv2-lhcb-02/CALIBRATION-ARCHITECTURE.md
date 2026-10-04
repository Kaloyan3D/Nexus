# Calibration observer boundary

The objective is a real T00 + E01–E06 run followed by a valid pressure calibration and the official comparison. Calibration owns only prompt release, diagnostic receipts and reports. Production behavior and acceptance thresholds remain frozen.

1. Source of truth: production `prepareSession` owns pre-request route and identity. Durable session records own completed requests, usage and pressure.
2. Ownership: the harness writes only benchmark evidence and receipts; controller and SessionStore write production state.
3. Dependencies: calibration consumes production APIs and pure session/pressure helpers. It does not inherit LHCB-01 AutoRunner methods.
4. Boundary: the preparation adapter returns seven explicit fields. The transport accepts prompts and reports status/flush. No live controller objects cross processes.
5. Failure: bounded polling tolerates accepted/running requests without headers. Completed turns require durable matching route evidence. Failures preserve the root.
6. Lifecycle: one fresh root, one session, T00 then six phases, report, close owned transport. Interrupted executions are never resumed or retransmitted.
7. Test seams: injectable transport, preparation adapter, clock, polling and grader. An asynchronous test accepts T00 before materializing request headers.
8. Compatibility: existing roots are diagnostic artifacts only. Fresh roots are required after code changes; no migration or recovery subsystem.
9. Observability: off policy plus durable append-only history proves native operation. Active decisions contradicting off policy fail. Production does not emit active decisions in off mode.
10. Security: credentials stay in process environment; reports contain counts, enums and hashes. Host graders run separately with offline transport. Live tools run in a namespace exposing only the frozen installation and workload; host graders, reports and receipts are hidden.

Calibration no longer waits for compiler memory generation: native calibration needs durable session evidence, not compiler state. Official snapshots must independently verify the memory producer before comparison. Scientific acceptance (minimum 10,000 growth per phase, native history, correctness, provider input accounting, comparison fairness) is unchanged.
