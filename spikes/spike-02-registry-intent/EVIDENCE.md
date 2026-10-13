# SPIKE-02 Evidence Report — Registry Issuer + Controller Durable-Intent Journal

```text
Spike: S-02
Commit: f322745 (checked-out HEAD; spike files are new, untracked, throwaway)
OS/FS: Linux kaloyan-cachyos 7.2.9-1-cachyos x86_64 / btrfs (/home/kaloyan/Projects/Nexus)  Date: 2026-10-13
Scope: spikes/spike-02-registry-intent/lib/{controller-intent-store,registry-issuer-bridge,kernel-inbox-mock}.cjs
       tests/Spike02RegistryIntent.Tests.cjs (isolated mkdtemp DataRoot/kernelRoot, synthetic ids only)
Executed commands: node tests/Spike02RegistryIntent.Tests.cjs ; node tests/RegistryCore.Tests.cjs
Tests: PASS 15 / FAIL 0 / NOT RUN 0  (spike) ; regression gate RegistryCore 45/45 PASS
Security boundary tested: forged issuer refused; snapshot-mismatch refused; stale lease refused;
  command-conflict refused; resend allocates no second attempt; crash at every transition keeps 0-or-1 records
Unexpected effects/credentials: none (no inference, no network, no DSH import, no prod writes; git status
  shows only new untracked spike files; pre-existing untracked A0.3 docs untouched)
Performance: not measured (correctness spike; no batching/TTFT claims)
Result: PASS (spike question answered for the Linux/btrfs/node-fsync path tested)
Decision: keep assumption — real-resolver bridge + Controller durable intent + Kernel-owned leases is viable for A1
Follow-up ADR and gate: A1 must adopt the contracts in "A1 recommendation" below; A2/A4 gates stay closed
```

## What was proven (executable)

- Real resolver is the only routing authority: the bridge calls
  `config/registry/resolver.cjs::compileModeConfig` on an issuer-controlled snapshot from
  read-only `legacyImport.buildRegistrySnapshot(repoRoot)`. Controller submits role intent only.
- `resolutionId` is compat-only: provider `baseUrl` mutation keeps `resolutionId` identical while
  the snapshot digest diverges (test 12). `modeConfigRevision` is not a definition digest (test 13).
- `engineering-v2` is Muse-only: Dual-model assignment fails closed; out-of-mode roles never issue (test 14).
- Unresolvable input yields `target-incomplete`, never a fabricated binding (test 15).
- Crash matrix: before/during/after Controller intent commit, bridge delivery loss, before/during/after
  Kernel inbox commit, ACK loss — every case recovers to 0-or-1 durable records and idempotent replay.
- No second attempt on resend at either layer (commandId-keyed idempotency + digest-conflict rejection).

## Discovered architectural blockers

1. **B-01 — Controller has no transactional intent record today.** `persistBindings` (tmp+fsync+rename)
   is atomic per file but there is no single authoritative (taskInstanceId, attemptId, commandId) envelope
   spanning attempt creation → command publication → ledger projection. A1 must add one (see contracts),
   or move intent to a small transactional store if cross-file atomicity cannot be shown on the target FS.
2. **B-02 — Lease ownership must move to Kernel.** A Controller-allocated fence epoch is not globally
   recoverable; the spike demonstrates Kernel-issued monotonic epochs per (taskInstanceId, backend,
   incarnation) with fail-closed stale/restore handling. A1 must adopt Kernel-owned leases.
3. **B-03 — `resolutionId` / `modeConfigRevision` must never be treated as source identity.**
   Proven by failing-closed fixtures in this spike; A1 pin format must carry separate snapshot/target digests.
4. **B-04 — Durability shown on Linux/btrfs only.** Windows/NTFS fsync+rename semantics were NOT tested;
   no Windows support claim is made. Same-UID forged-peer threat (E-01/E-02 caveats) is NOT solved by this
   spike — A2 must gate effectful peers and A4 must sandbox model-driven processes.
5. **B-05 — Stale-restore reconciliation is only half-proven.** The spike proves fail-closed rejection;
   the operator re-acquire/reconcile workflow (suspend → re-acquire → resume vs. refuse) is still an
   A1 design item.

## Recommendation for the A1 implementation contracts

- **ControllerIntentV1**: `{ schemaVersion:1, kind, taskInstanceId, attemptId, commandId, backend:'native',
  controllerRevision, role, modeId, modeConfigRevision, payloadDigest, intentPayload, lease|null,
  status:'committed' }`, one file per commandId, tmp+fsync+rename+dir-fsync, idempotent re-commit,
  `intent-conflict` on digest/attempt/generation divergence, `attachLease` set-once semantics.
- **Registry issuance**: trusted bridge invokes the real resolver from issuer-controlled snapshots;
  wire format carries `provenance{ issuer:'registry-bridge', resolutionIdCompat, registrySnapshotDigest,
  targetDigest, modeConfigRevision }`; Kernel verifies all three digests plus generation/backend/fence.
- **Kernel inbox**: persistent `storeIncarnation` + monotonic lease epochs per generation;
  `AcquireGeneration` supersedes (fences) prior epochs; receipts keyed by commandId with
  idempotent replay and `command-conflict` on divergence; stale/restored state fails closed to
  suspend/reconcile, never to silent execution.
- **No-go conditions for A2**: any second attempt on resend, any forged/stale/conflicting acceptance,
  any lost-journal execution, any claim of Windows or same-UID-hostile-peer safety without new tests.
