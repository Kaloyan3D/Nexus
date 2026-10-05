# Temporary status RPC observation

Official run7 stopped during an accepted E05 turn when `session.list` produced `lhcb-runner-rpc-endpoint-unavailable`. Cleanup subsequently reported the runtime busy. The failed root remains diagnostic evidence, without a checkpoint or comparison. The immediate underlying network error was not retained, so its exact cause is unverified.

The existing completion observer now waits through that single classified temporary status error within its unchanged 900,000 ms turn deadline. It records each observation failure separately from provider telemetry. It never submits the prompt again. Successful status observations still require the exact session and workspace; completion still requires flush, prompt/RPC provenance, exact turn identity, unchanged history prefix and durable provider/model evidence. Other errors remain fatal. Production, calibration, workloads, thresholds and snapshot semantics are unchanged.

1. Source of truth: production durable events establish completion; status is only an observation.
2. Ownership: production owns the running turn; the benchmark observes it.
3. Dependencies: official observer uses the existing transport and completion validator.
4. Boundary: unavailable status differs from a malformed or foreign status response.
5. Failure: temporary observation failures consume the existing deadline; expiry remains terminal.
6. Lifecycle: one accepted submission, the existing bounded wait, then grading. No restart, resume or submission recovery is added.
7. Tests: injected clocks reproduce a temporary outage, deadline exhaustion and fatal identity/schema errors without sleeps.
8. Compatibility: calibration contract/workload hashes remain unchanged; the official protocol hash changes and requires a fresh official root.
9. Observability: statusObservationFailures are host control evidence, never synthetic provider usage or pressure.
10. Isolation: existing PID/listener ownership, namespace isolation and immutable fixture checks remain enforced.

The regression first failed with the actual endpoint-unavailable error in the original wait loop. After the correction it reaches the same durable completion after a temporary outage, with exactly one prompt submission. Repeated outages still fail at the unchanged deadline; schema errors and identity drift still fail immediately.

Official run9 reached a natural checkpoint at 485,241 tokens after E31 and completed E42 with cumulative correctness intact. Its final T99 integration had 18 completed steps and two provider transport retries when the 900,000 ms observation deadline expired. That attempt remains invalid and its snapshot is not reused. T99 now has a bounded 2,700,000 ms deadline in every arm; ordinary engineering turns retain 900,000 ms and explicit test overrides retain precedence. This changes only the official observation protocol, requiring a fresh official root. The frozen workload, calibration contract, correctness, reduction, step-count and provider-failure validity gates remain unchanged. The deadline regression failed before this change; an independent test retains the ordinary deadline.
