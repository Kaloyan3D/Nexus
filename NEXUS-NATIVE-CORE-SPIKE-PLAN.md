# Nexus Native Core — Three Throwaway Spikes (A0.3 companion)

> **Status:** executable work-plan / NOT IMPLEMENTED. No changes to production Nexus, PR #33, DSH execution or live Controller sessions are authorized by this document.
> **Date:** 2026-10-13
> **Related:** `NEXUS-NATIVE-CORE-ARCHITECTURE-A0.3.md`, `NEXUS-NATIVE-CORE-A0.3-SECURITY-INTEGRATION-ERRATA.md`.
> **Priority:** Prove risky constraints with tiny isolated experiments before the expensive Rust Kernel implementation. Build for a 1–2-person team; one isolated branch or disposable workspace per experiment; record PASS/FAIL and raw evidence, then discard the prototype implementation unless reviewed.

## Global guardrails

- No modifications of production sessions, `dev`, `main`, or existing Draft PR #33. No real credentials in cassettes/logs. Use temporary DataRoot/workspace, explicit expiry/cleanup and synthetic secrets.
- Do not mix the throwaway provider spike with the real Controller journal. The provider spike runs **read-only/model-only**, independent of DSH; journal spike runs **without any provider/model/network tool**.
- Report the exact branch/commit, OS/kernel/filesystem, installed binary/library versions, commands and test logs. An unexecuted test is `NOT RUN`, never `PASS`.
- Stop on an isolation breach, unexplained second effect, unbounded retry, leaked secret, or a test that unexpectedly touches real Nexus user data.

## SPIKE-01 — Linux process sandbox & control-plane isolation

**Question:** Can Nexus safely run adversarial same-UID build/test processes without allowing access to Kernel/Controller stores, IPC, credentials or unauthorized network endpoints?

**Disposable setup:** launcher and adversarial fixture under a temporary worktree; dummy `nexusd.sock`, `registry-bridge.sock`, `secret-broker.sock`, `DataRoot`, `controller-ledger`, `.env`, and a benign workspace containing a hostile test script. Real Nexus sockets/state **must not** be mounted or used. Spawn descendant processes in the fixture (e.g. `sh -c`, Python) to prove transitive enforcement.

**Candidate investigation:** bubblewrap/user+mount+pid/network namespaces and optional Landlock, with focus on CachyOS/Linux support; check kernel/userns restrictions, `/proc` visibility, open-file inheritance, symlinks, mounted directories and network allowlisting. Record whether a clean separate service identity is necessary. Do not call the sandbox safe based on a single CLI flag.

**Checks:**

1. Allowed workspace read/edit and child process tests succeed inside the sandbox.
2. Direct and descendant reads/writes to all dummy control-plane stores fail, including symlink and relative path tricks.
3. Direct and descendant connections to dummy Kernel/Registry/secret broker sockets fail, including localhost endpoints and inherited-FD probes.
4. Secret environment/caches and host `/proc` inspection are inaccessible. No usable privileged FD leaks to children.
5. Network default-deny works; a narrowly configured build download/caching policy is demonstrable without opening localhost/control-plane access.
6. Process exit, timeout and cancellation terminate the process tree; classify unconfirmed terminations.

**Output:** exact sandbox startup policy, OS prerequisites and failure matrix, list of allowed mounts/egress, benchmarked overhead and PASS/FAIL report. **Gate:** any protected access success ⇒ A4 blocked. Choosing a Linux backend happens here, not by assertion in A0.3. No attempt to prove resistance to arbitrary unsandboxed same-UID host malware using only this test.

## SPIKE-02 — Real Registry issuer + Controller durable-intent journal

**Question:** Can the existing Node/CommonJS Registry and JS/PowerShell Controller issue authoritative, durable execution intent to a simulated Rust/SQLite Kernel without duplicate attempts or forged model targets?

**Disposable setup:** checkout at a pinned known commit, isolated `DataRoot` and workspace, mocked transport/Kernel inbox. Real existing `config/registry/resolver.cjs` is invoked by a **trusted bridge**, not by a Controller-supplied `target` JSON object. Model calls and shell/file mutations are disabled. The Controller test harness exercises the **actual Controller persistence path**, not a second synthetic-only ledger.

**Minimum protocol to prototype:**

```text
Controller: commit ONE authoritative (taskInstanceId, attemptId, commandId,
            backend=native, revision, role intent, payload digest) record.
Kernel mock: AcquireGeneration(authorized intent) -> leaseEpoch + storeIncarnation.
Controller: attach lease authorization to a stable command record/replay envelope.
Bridge: receive role intent; resolve with existing JS Registry from a protected snapshot.
Kernel mock: verify binding/provenance/lease + unique commandId; persist receipt atomically.
Controller: query by commandId after timeout; never allocate a second attempt for resend.
```

**Required source-mapping fixtures:** old `resolutionId` vs full source digest; `modeConfigRevision` vs mode-definition digest; provider `baseUrl` mutation with unchanged legacy `resolutionId`; unresolvable `billingClass`/endpoint yields `target-incomplete`, **not** fake executable binding; `engineering-v2` Muse-only role mapping.

**Crash and attack matrix:** kill before/during/after Controller intent commit, projection update, bridge delivery, Kernel inbox commit and ACK; restart Controller, replay same ID, mutate payload with same ID, send forged issuer/role, restore older Controller state, restore older Kernel DB. Test Linux/fsync/rename/locks on actual filesystem; separately characterize Windows/NTFS before claiming support. Evaluate Controller-owned transactional mini-store if file-based transaction cannot be demonstrated.

**Outputs:** selected minimal IPC framing/peer model, committed intent record format, lease protocol, source-field provenance report, crash fault matrix, and explicit security caveat for arbitrary malicious unsandboxed same-UID peers. **Gate:** no new task/attempt on resend; forged target refused; lost journal or stale lease causes suspend/reconciliation rather than execution. This spike is part of A1's critical path and must NOT be postponed to A2.

## SPIKE-03 — Native Muse/OpenCode Go model-only transport

**Question:** Does the selected transport obey Nexus's exact target and OpenCode Go session/stream semantics without DSH? What failure/retry/batching policy is practical?

**Two-stage setup:** (a) recorded synthetic HTTP/SSE Responses fixtures with invalid key-free requests and simulated disconnects; (b) **optional operator-authorized live test** using an explicitly selected real OpenCode Go account/key, isolated session, cost cap and no file/process tools. Never print/store the key. The offline stage can run without credentials. No DSH module is imported or invoked.

**Compare two narrow candidates:** `rust-genai` in explicitly bound-adapter mode versus a minimal direct Responses HTTP adapter behind the same Nexus-owned interface. Don't simultaneously introduce a second high-level agent framework; don't assume `rust-genai` can expose a no-bytes-sent `prepare()` hook until tested.

**Measurements and assertions:**

1. Exact requested URL origin/path, method, model string, reasoning `xhigh`, auth connection selection and stable `x-opencode-session` affinity are observable in nonsecret transport audit. Wrong/redirected endpoint refused. No auto-provider/model/reasoning fallback.
2. Ordered streaming events and complete tool-call fragments normalize without triggering tools. Cancellation/disconnect produce truthful state.
3. Detect and record `not_sent`, `send_uncertain`, `stream_partial`, `terminal_committed`; retry cannot silently repeat an unknown billable call. Test whether continuation can safely resume or whether a Controller-approved new attempt is needed.
4. Persist low-cost synthetic frame batches with a durable watermark and provisional UI deltas; vary batch window/bytes, record p95 TTFT, writer queue wait, recoverable prefixes and test-run counts. No fsync per token.
5. Separate full native history from content-addressed reference-backed oversized tool output; test tool pairing, stable retrieval/digest and quality/continuity caveat. No hidden CCv2 lossy compaction.

**Outputs:** transport recommendation (or unresolved blocker), pinned dependency/version, fixture corpus, request/stream schema, retry/continuation policy proposal, batching measurements and cost report. **Gate:** `rust-genai` is NOT an approved dependency without verified exact-bound adapter behavior; no live A2 authorization from this spike alone.

## Milestone and handoff plan

| Track | Runs in parallel with | Must complete before | Deliverable |
|---|---|---|---|
| S-01 sandbox | A1 schema/store work | A3 process integration / A4 writes | Sandbox feasibility decision + denial suite |
| S-02 Registry/Controller | A1 shadow prototype | A2 live execution | Durable intent + trusted issuer prototype / fault tests |
| S-03 model-only transport | A1 shadow prototype | A2 transport selection | Responses/Go conformance + batching/retry evidence |

**Suggested timeboxes, not commitments:** S-01 1–3 focused engineering days, S-02 2–4, S-03 1–3 (live provider availability can delay it). If any timebox is exceeded, stop and record the blocker before widening scope. Avoid parallel changes to the same Controller/Registry files: only S-02 touches a copied/isolated Controller fixture; S-01 and S-03 need no production source edits.

## Evidence report template (one per spike)

```text
Spike: S-0X
Commit: <sha>  OS/FS: <actual versions>  Date: <date>
Scope: <isolated files used>
Executed commands: <commands, sanitized>
Tests: PASS __ / FAIL __ / NOT RUN __
Security boundary tested: <precise assertion>
Unexpected effects/credentials: <none or details>
Performance: <measured numbers, sample size, environment>
Result: PASS / BLOCKED / INCONCLUSIVE
Decision: <keep/modify/reject assumption>
Follow-up ADR and gate: <id>
```

## The next actual coding task

Start **S-02** in a disposable branch/worktree by freezing a `ControllerIntentV1` record, using the real Controller persistence stack plus a mocked Kernel inbox. Implement fault injection around intent commit and ACK loss before any network/agent tool integration. At the same time, run S-01 sandbox feasibility independently. S-03 can begin offline with mocked SSE fixtures. **Do not implement the full seven-crate Rust workspace as the first experiment.**
