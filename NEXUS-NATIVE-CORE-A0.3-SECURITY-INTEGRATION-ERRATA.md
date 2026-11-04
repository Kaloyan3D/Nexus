# Nexus Native Core — A0.3 Security & Integration Errata

> **Status:** PROPOSED — review companion to `NEXUS-NATIVE-CORE-ARCHITECTURE-A0.3.md`, not an implementation authorization.
> **Date:** 2026-10-13
> **Baseline:** `Kaloyan3D/Nexus`, `feature/model-registry-v1`, pinned evidence commit `8ae2fe3943750cd1d6c7c439b4771a49209b3849` (historical review baseline; revalidate against branch HEAD before implementation).
> **Purpose:** Correct concrete contradictions and close security/integration risks raised during external review, without expanding Native Core's product scope or replacing A0.3 with a new architecture.

## Decision summary

Keep the small Rust execution kernel; keep **Controller = task authority**, **Registry = model/route authority**, **Kernel = effect execution authority**, and **CCv2, Skills, Muse, Code Mode, Nova = extensions**. However, A0.3's A1 shadow trust model is *not* sufficient for real tools, and its target issuance and controller journal flow need real prototypes now. These errata apply until folded into the canonical spec.

**Hard rules:** (1) No effectful Native mode until the trusted Registry issuer is unambiguous. (2) No model-driven process execution until tools are demonstrably isolated from Nexus control-plane storage, IPC and secrets. (3) No real Native attempt dispatch until the actual Controller has a crash-tested durable intent record. (4) A successful A1 mock does not certify A2/A4.

## E-01 — Tool children cannot be trusted same-UID IPC peers (critical)

**A0.3 conflict:** §5.11 permits a same-UID trusted-process assumption during shadow mode, but generic model-driven `exec`/build/test tools on A4 may run attacker-controlled scripts under the same Unix UID. Socket permissions `0600`, `SO_PEERCRED` UID matching, and an auth token readable by that UID do not distinguish the Controller from an untrusted child. A malicious process may also try `/proc`, inherited FDs, environment, credential caches or SQLite state; hiding the socket mount alone is not enough.

**Normative change:** A1 may retain its strictly **no-effects** same-UID assumption. A2 must review the effectful trusted-peer threat model, and A4 MUST sandbox **every model-driven process** (including transitive `npm`/`cargo`/Git hooks), denying access to:

- Native `DataRoot` / event DB / journal / artifact internals, Controller-ledger and routing authority paths, bridge/Kernel/secret-broker IPC, credential files and secret-bearing environment;
- Sensitive parent process handles/FDs, `/proc` host process internals, ptrace/process inspection and unauthorized network egress, including localhost service endpoints;
- Writable host filesystem outside the explicitly granted workspace (except controlled temporary/cache surfaces), while controlling child-process descendants.

**Important limit:** This is an **enforcement obligation**, not a promise that any given sandbox backend achieves it. Before A3 tool integration, select/test a candidate sandbox and network policy; before A4 writes, demonstrate real OS-level confinement, fd inheritance closure and denial tests. If unavailable, refuse process tools. The broader threat of *an arbitrary unsandboxed malicious process already running as the user's UID* remains a distinct deployment threat; do not claim protection without a separately protected service identity or equivalent stronger boundary.

**Acceptance:** a deliberately malicious `npm test`-style fixture cannot read/write either store, open any Nexus authority socket, inspect protected process/credentials, or reach forbidden network endpoints; test direct calls and descendants. Treat any success as A4 NO-GO.

## E-02 — Exactly one Registry issuer path (critical)

**A0.3 conflict:** §3 graph suggests Registry → Bridge; §7 suggests Registry → Controller → Bridge. If Controller forwards an unauthenticated JSON `RegistryResolutionV1`, Kernel cannot prove that Registry issued it; `issuer: "registry"` and a digest are not attestations.

**Decision for P0:** **trusted bridge invokes the existing JS Registry resolver from validated, issuer-controlled source snapshots**. Controller submits *task/role intent*, not a freely supplied executable model target. The bridge returns the result and provenance to Kernel via the trusted bridge channel. No independent resolution inside Kernel, no silently generated endpoint/billing fields, and no runtime fallback. Preserve `resolutionId` as a compatibility identifier; **do not** treat it as a complete source-identity hash. The issuer-controlled `registry_snapshot_digest`, target JCS digest and required provenance remain separate.

**A2 security gate:** prove the actual issuer process and its snapshot inputs are protected from unauthorized writes; protect IPC against hostile tool children and forged Controller/Registry messages under the declared threat model. Signing is an alternative if the ownership topology changes, but not required merely to serialize JavaScript data. **Same-UID authentication is still unsolved if an attacker can invoke or modify the trusted bridge.** Do not assume calling the Registry internally automatically solves host compromise.

**Canonical flow:**

```mermaid
sequenceDiagram
    participant C as Controller (task authority)
    participant B as Trusted bridge / Registry issuer
    participant R as Existing JS Registry resolver
    participant K as Rust Kernel
    participant S as Native Store
    C->>C: Commit one authoritative attempt-intent envelope
    C->>B: Intent(taskInstanceId, role, authorization evidence, commandId)
    B->>R: Resolve from issuer-controlled snapshot
    R-->>B: Existing resolutionId + binding
    B->>B: Validate provenance; produce complete candidate/target
    B->>K: Trusted-issued resolution + Controller authorization
    K->>K: Verify binding, issuer, generation, backend, fence
    K->>S: Atomic inbox receipt + complete snapshots + pin
    K-->>C: Durable receipt via bridge
```

**Compatibility:** `engineering-v2` is `muse-v0`/`muse_main`; legacy Muse `role:null` is mapped explicitly. No Dual roles on Muse. Unknown endpoint/billing/session policy yields `target-incomplete`, not a guessed value.

## E-03 — Real Controller journal is an A1 parallel spike (critical)

**A0.3 gap:** §5.9 correctly requires a single durable attempt-intent envelope, but A1 acceptance relies on a synthetic Controller. Existing `config/AihController.cjs::persistBindings` already uses file temp-write, fsync and rename in part of session persistence; that does **not** establish atomicity between TaskController attempt creation, native command publication and ledger projections.

**Normative change:** Prototype the **real JS/PowerShell Controller write path in parallel with A1**, behind a disabled test-only entry point and disposable fixture workspace. Select one authoritative durable record for `taskInstanceId`, `attemptId`, `commandId`, controller revision, backend, intent and digest; projection and delivery are derived. No second independently committed outbox file. Test process kills before/during/after its real filesystem commits on the intended OS/filesystem; Windows and Linux durability are not interchangeable. If atomicity cannot be shown, move the Controller-owned intent to a small transactional store instead of weakening the invariant.

**Acceptance:** after each injected crash, either no intent was committed or precisely one valid intent can be recovered; IPC resend of the original ID cannot allocate a new attempt or cause double execution. Preserve existing Controller verification/completion authority.

## E-04 — Kernel-issued fencing lease and restore procedure (critical)

**A0.3 conflict:** §5.9 allocates `controllerFenceEpoch` in Controller; Kernel's journal is better suited to issuing transactional monotonically advancing execution leases. Avoid calling an unproven Controller JSON revision a globally recoverable fence.

**Decision:** Controller **authorizes task creation**, Kernel **issues/rotates an execution lease epoch** for a particular `(taskInstanceId, backend, kernelStoreIncarnation)` on authenticated `AcquireGeneration`. Controller persists the acquired lease reference/epoch with its next authorized command. Kernel rejects old epochs, revoked leases, expired authorization generations and mismatched kernel state revisions. One generation has at most one active execution lease; a new owner must explicitly supersede/fence the previous one. A lease is **not** a substitute for authenticated Controller authorization.

**Backup/restore rule:** Kernel store has a persistent installation/incarnation identity, and restore/rollback to a stale DB or missing Controller journal is **fail-closed** and requires explicit reconciliation/re-acquisition; never silently reset epoch to 1 or trust old grants. If the entire protected state is rolled back, local fencing alone cannot detect that without an external monotonic anchor: state this limitation clearly rather than promising impossible rollback immunity.

**Acceptance:** stale owner rejected after restart, second owner fences first without mutating previous receipts, Controller state loss does not auto-resume, and restored-backup fixture suspends until operator reconciliation.

## E-05 — Model retry policy separates execution safety from billing (high)

`model_outcome_unknown` describes a request whose bytes **may** have reached the provider; it must not equal permanent task failure by definition. Persist a model attempt ID and distinguish `not_sent`, `send_uncertain`, `stream_partial`, `terminal_committed`, `provider_resume_verified`. Only the Controller may authorize a bounded **new attempt on the exact same pin** (or explicitly resolve a new pin); model runtime may not silently retry provider/model/route. A fresh attempt does not convert the earlier uncertain billing into a known outcome.

**Conformance gate:** test OpenCode Go `x-opencode-session` affinity, continuation IDs, HTTP disconnects and retry behavior. Do not merge partial content into a new provider conversation without verified semantics. If provider state cannot be safely resumed, offer an explicit new attempt with warning/approval and bounded cost budget, or suspend. **Tool side effects are a stricter domain** and never inherit model-only retry policy.

## E-06 — Reference-backed context is not semantically lossless (high)

Allow a separately tested P0 candidate `ReferenceBackedNative` / `NativeWithElidedRefs` for **oversized tool results**: persist the full original bytes as a content-addressed artifact, keep typed `tool_call → tool_result` structure, show the model digest, size, scope and an authorized retrieval tool. Require stable artifact lifetime, exact verification and bounded paging/range reads. No silent elision, no unverified references, no omission of system/developer instructions or provider continuity tokens. This is *lossless storage* but **not equivalent to full model-visible context**; contextual quality/continuity tests must certify where allowed. If unsafe, fall back to faithful `Native` or typed refusal. CCv2 lossy compaction stays disabled in P0.

## E-07 — Process execution is untrusted regardless of argv (high)

`argv` avoids one class of quoting/injection but does **not** make `npm test`, `cargo build`, or `git` safe: scripts/hooks can launch shells and descendants. Treat build/test/process tools as potentially mutating/externally effectful unless a narrowly audited operation proves otherwise. Sandbox isolation is the boundary. Define offline/limited-network defaults, package-install/update approvals and cache mounts in the sandbox spike **before A3**; deny direct access to provider and Kernel localhost APIs. Tool crash after ambiguous effects remains `indeterminate`.

## E-08 — Stream journal batching policy (high)

Keep **synchronous durable barriers** before model dispatch, ToolGrant redemption, approval decisions and mutations. UI token frames may be provisional and buffered; periodically commit bounded batches by time/bytes, flush at terminal/tool-call boundaries, and persist a durable watermark. Do **not** fsync each token. Measure queue head-of-line latency, memory bounds, recovery-prefix loss and p95 TTFT with real provider traffic before freezing exact batch sizes. Provisional frames must be clearly recoverability-labeled.

## E-09 — Reconciliation is an operator workflow (medium)

Specify `nexus-doctor reconcile --task-instance <id> --dry-run` (proposed, not shipped). It prints unresolved model/tool effects, committed receipts, provider/handler evidence and changed workspace paths. Recovery actions are typed, separately authorized, audited and never equivalent to marking Controller task PASS: `observe`, `recheck`, `abandon`, `start-new-generation`, `authorize-new-attempt`. No blind `mark-done`, no automatic unsafe `re-grant`. UI can expose the same protocol later.

## E-10 — Workspace handoff is explicit (medium)

A new generation may inherit **workspace bytes** from a previous generation but **not** its unverified execution authority or completion status. Capture Git `HEAD`, index/worktree/untracked inventories, changed-file hashes and indeterminate actions. If dirty/unknown, require Controller/operator review before further mutation. DSH rollback is permitted only for a **new generation**, without automatically replaying Native commands or assuming the workspace is clean.

## E-11 — Platform statement (medium)

Linux-first is a **proposed target**, not evidence that the Controller requires Windows (PowerShell 7 works on Linux). Add a real deployment matrix for Linux native, WSL2 and Windows (with install paths, IPC transport, filesystem semantics, and sandbox availability). The first P0 release must say exactly which configuration it supports; others retain existing DSH behavior until separately tested.

## E-12 — Time and lease semantics (medium)

Use monotonic time for in-process countdowns and process deadlines. Persist absolute expiry and issuance evidence for cross-restart decisions; clocks can skew or roll back, so ambiguous/expired grants are **not** reactivated after restart. An acquired lease and cancellation authorization epoch must be revalidated against durable generation state, not trusted solely because its timestamp looks recent. Do not use a bare journal event count as elapsed time.

## Exact editorial fixes to A0.3 (do these when merging errata)

| A0.3 location | Replace or clarify |
|---|---|
| §3 topology, §7 diagram | Controller sends intent → trusted Registry bridge invokes JS resolver → Kernel verifies/records; **not** Controller forwarding unsigned executable target |
| §5.9 step (0), DTOs, §8.2 | Rename Controller-allocated `controllerFenceEpoch` to Kernel-issued `executionLeaseEpoch` with acquire/rotate and restore procedure; preserve `expectedControllerRevision` as a *different* authorization revision |
| §7 `Durable outbox(...)` | `Commit ONE Controller authoritative attempt-intent envelope(...)` |
| §8.2 heading, step 2, crash table | `durable attempt-intent publication + Kernel inbox`, not an independently committed outbox; projection/delivery are derived |
| §5.10 model attempt retry | Distinguish unknown provider/billing outcome from unsafe tool effects; Controller-owned bounded retry under pin and continuation proof |
| §5.11 | A1 shadow same-UID assumption only. A2/4 effectful peer/trust gates; process sandbox must hide the control plane |
| §5.4 and §10 | Add opt-in tested `ReferenceBackedNative`; don't call it semantically identical to full history |
| §8.1 | Define batched provisional model-stream durability and synchronous authority transitions |
| §13 gates | Add E-01..E-04 blockers at correct phases, observable E-05..E-12 tests and supported-platform matrix |

## Approval, scope and stop rules

The three throwaway spikes in `NEXUS-NATIVE-CORE-SPIKE-PLAN.md` validate E-01, E-02/E-03/E-04 and E-05/E-06/E-08. They are **not** release artifacts. A1 may develop no-effects Rust contracts in parallel. A2 may not emit live requests until trusted issuer + real Controller journal + peer protection pass. A3 process interfaces may be designed, but A4 write-capable process execution cannot proceed until sandbox isolation + egress + race tests pass. No production configuration, existing active session or Registry PR is altered by this errata.

**Status:** all errata are **proposals pending prototype evidence and human sign-off**. A successful spike should convert a proposed decision into an ADR with pinned evidence rather than trigger an unlimited architecture rewrite.
