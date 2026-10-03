# Implementation plan and boundary review

Phase 0: clean benchmark/ccv2-lhcb-01 at frozen HEAD 081c54070ee0ae62a8ae303bbcde9f930174cbed; ancestry confirmed. Inspected activation, active compiler, OpenCode host, wire, certification, replay, DSH decoder, architecture sections 54–55, installer and controller persistence. Baseline activation suite: 74/0; OpenCode host suite: 221/0 (local transports).

Phases 1–6: add manifest/schemas/root and fixture; immutable snapshots/restore and policy arms; authority-based collectors; executable hidden grader and independent verdicts; CLI/reports; offline tests and contract/runbook. All additions remain under benchmarks/, scripts/bench/, tests/.

Architecture review:
1. Truth: durable DSH events own usage; production gate owns pressure/threshold; controller ledger/bindings own identity; snapshot hashes own comparison baseline; hidden tests own obligations. Derived metrics never replace these authorities.
2. Writes: harness writes only marked isolated root, arm config through routing-policy.json. Runtime owns session and ledger state. Operators stop runtime before capture/restore/config changes.
3. Dependencies: benchmark -> existing production/replay authorities. Production never imports benchmark.
4. Boundaries: explicit manifest, binding, snapshot, result and report JSON; aggregate evidence only in run outputs. No credential material crosses archive/report boundaries.
5. Failures: source drift, unsafe paths, corrupt restore and mismatched identity fail closed. Observable provider failures invalidate runs; missing measurement is null with a reason. No retries or provider calls in harness.
6. Lifecycle: init creates marker and fixture, bind records existing session, prompts record stages, snapshot seals immutable baseline, restore recreates baseline, arm starts unique run, collect seals evidence, grade and report derive outcomes. Only restore deletes isolated mutable trees. Interrupted restore locks root until successful recovery.
7. Tests: temp roots, recorded events through real pinned DSH codec, explicit clock/timestamps and transport blocker; no live calls.
8. Compatibility: new external tooling; no existing files or formats changed. Delete isolated root to remove experiment. Contract changes require a new version.
9. Observability: doctor distinguishes source guard from runtime readiness; status shows certification/pressure and staged run; report retains invalid runs and unavailable values.
10. Security: reject links, ambiguous roots, credential filenames/content and unexpected archive destinations; allowlist runtime staging; never copy user data/credentials. Arbitrary secrets cannot be recognized perfectly: dedicated credential-free engineering fixture/session only. Hidden grader is outside workspace; workspace isolation is operator enforced, not an OS sandbox.
