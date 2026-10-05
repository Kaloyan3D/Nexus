# Frozen provider failure policy

The official protocol hashes `official-provider-policy.cjs` together with the runner,
physical snapshot implementation and frozen workload. E01–E45, grading,
thresholds and production source remain unchanged.

All three arms use the same supported provider configuration: normal retry mode,
zero automatic request retries. This prevents unbounded retries across the
multiple model steps of one phase and preserves complete compiler/request
telemetry for the measured successful attempt. Only mutable runtime settings
contain this override; normal OC-01 authority and route verification still run.

A failed durable turn may trigger recovery only for HTTP 408/425/429/5xx,
`server_error`, response generation failure, TRANSPORT or TIMEOUT. Authentication,
quota, permission, request-shape and context-limit errors are excluded. The final
failed model step must have no committed assistant message or tool result.
Successful turns, grading failures, protocol errors and source drift never retry.
Earlier successful steps are preserved in the aborted-attempt archive but cannot
contaminate the fresh attempt.

Each arm has at most three provider-aborted runs: after the first and second,
a fresh attempt is allowed; the third stops with
`EXTERNAL_BLOCKER_PROVIDER_INSTABILITY`. Native prefix failures consume the same
Native budget as continuation failures. Before CP-500 a new root is mandatory;
after CP-500 the verified physical seal is restored at the same absolute root.
Aborted candidate, session and controller evidence are archived before restore.
No prompt is re-submitted into a partially executed turn. No calibration rerun
is caused by an official provider failure under unchanged calibration hashes.

Status RPC outages observe the same accepted request and consume the existing
bounded phase deadline (15 minutes engineering, 45 minutes T99). They never
resubmit. Identity/schema/prefix/route failures remain fatal.

Completed clean attempts provide successful model execution latency from durable
turn boundaries. Provider-aborted attempt count, provider retry delay (zero:
there is no scheduled backoff), observer RPC retries and raw total arm duration
are reported separately. Aborted attempt wall time and restart/host time cannot
enter the CCv2 latency ratio. Native prefix retry evidence is supplemental to
the equivalent continuation comparison. A hidden SDK retry violates this policy
and invalidates the measurement rather than silently removing telemetry.
