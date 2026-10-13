# SPIKE-02 Evidence Report — Registry Issuer + Controller Durable-Intent Journal (HARDENED)

```text
Spike: S-02 (hardening: F-01..F-06)
Commit: <filled at commit time>  Branch: feature/rust-native-core
OS/FS: Linux kaloyan-cachyos 7.2.9-1-cachyos x86_64 / btrfs  Date: 2026-10-13
Scope: spikes/spike-02-registry-intent/lib/{controller-intent-store,registry-issuer-bridge,
       kernel-inbox-mock,envelope,trust,file-lock,test-workers/spike02-worker}.cjs
       tests/Spike02RegistryIntent.Tests.cjs (isolated mkdtemp roots, synthetic ids only)
Executed commands: node tests/Spike02RegistryIntent.Tests.cjs ; node tests/RegistryCore.Tests.cjs
Tests: PASS 30 / FAIL 0 / NOT RUN 0  (spike) ; regression gate RegistryCore 45/45 PASS
Security boundary tested: sealed-issuance forgery refused (3 adversarial); rollback-detected + fenced
  recovery; xproc concurrency (commit/acquire/deliver); full intent→resolution binding; envelope tamper;
  real process exit/SIGKILL crashes (distinguished from SIMULATED injected exceptions)
Unexpected effects/credentials: none (no inference, no network, no DSH import, no prod writes)
Performance: SIGKILL loop inspected 154 complete records in one run; no latency/SLO claims
Result: PASS (prototype questions answered for the Linux/btrfs/node path tested)
Decision: keep direction — hardened contracts below are safe to carry into A1 design (not code)
Follow-up ADR and gate: A1 must re-prove on its real store/IPC; A2/A4 gates stay closed
```

## What the hardening changed (and why)

- **F-01 sealed issuance (prototype trust boundary).** The Kernel honors ONLY bridge-sealed
  resolutions: HMAC-SHA256 over the canonical issued bytes with a per-kernelRoot random key,
  verified with timingSafeEqual + deep-equal against the trusted-issuance record. Issuer strings
  and caller-supplied digests grant nothing. Adversarial proof: self-consistent forgery with the
  correct issuer string and honestly recomputed matching digests is REJECTED (no sealed record);
  sealed-record bytes with swapped target fields are REJECTED (seal mismatch either way);
  unsealed bridge output is REJECTED at delivery. Real resolver stays the sole routing authority.
- **F-02 rollback witness (separate failure domain).** Lease counters live inside the restored DB,
  so same-DB counters cannot detect rollback (proven: unwitnessed restore test ACCEPTS the stale
  lease — kept as a documented UNSUPPORTED case). With an out-of-DB monotonic-max witness, the
  real epoch-1-restore attack is REJECTED with `rollback-detected`, and recovery re-acquires at
  witness-max+1 (epoch 3, never re-issues fenced epoch 2) on a NEW commandId.
- **F-03 concurrency.** tmp-write + fsync + link(2) exclusive-publish (winner-takes-all, readers
  never see torn files) + mkdir-mutex serialization of read-modify-write. Cross-process proof
  (8 separate OS processes each): identical commits → 1 winner/7 idempotent; conflicting commits
  → 1 winner/7 intent-conflict, never overwrite; acquires → epochs exactly 1..8; identical
  deliveries → 1 receipt/1 winner.
- **F-04 binding.** Delivery validates taskInstanceId, role, modeId, modeConfigRevision (target AND
  provenance), backend, attempt/command presence, sealed target/provenance digests, and current
  lease — mismatched role/mode/revision against otherwise-valid sealed resolutions are rejected.
- **F-05 envelope digests.** payloadDigest recomputed from actual payloads on every path;
  intentDigest/commandDigest (documented sorted-key canonicalization, lease/timestamps excluded
  from identity) make commandId reuse with ANY differing immutable field a conflict; tamper tests
  prove payload-tamper and command-conflict paths.
- **F-06 real crashes.** Separate-process exit(3) before commit (nothing persisted), commit-then-die
  without ACK (exactly one + idempotent replay), SIGKILL mid-loop over 2000 commits (154 complete
  records inspected: all parse, all digests verify, all replays idempotent, orphan tmps ignored).
  During this work real SIGKILL testing found and fixed a genuine bug: naive O_EXCL-direct-write
  can leave 0-byte torn targets — replaced by link-publish everywhere. SIMULATED injected-exception
  tests are retained and explicitly labeled SIMULATED vs REAL.

## Residual risks / explicitly UNSUPPORTED (do not carry into production claims)

1. The seal is a file-shared key, NOT IPC authentication: any same-UID process that can read
   `issuance-key.json` or write `trusted-issuances/` breaks the prototype boundary. A1 needs real
   peer authentication (service identity / SCM_CREDENTIALS-class proof). No same-UID isolation claimed.
2. Rollback detection REQUIRES the witness in an independent failure domain (separate store/host HSM
   counter). Same-disk witness restored together with the DB is undetected — proven by test.
3. The mkdir mutex has no stale-lock recovery and is not fcntl; a killed lock holder wedges that
   root until manual cleanup. A1 needs fcntl/transactional storage.
4. Proven on Linux/btrfs + Node fsync/link semantics only. No Windows/NTFS claim. No IPC, no
   real-crash (power loss) claim beyond process termination. No performance/SLO claim.

## Contracts safe to carry into A1 (design, not code) — EXTENDED by addendum below

- Sealed issuance: kernel honors only bridge-sealed bytes; issuer strings never authenticate.
- Envelope layering: payloadDigest → intentDigest → commandDigest; mutable transport state excluded.
- Kernel-owned monotonic leases + out-of-DB witness + fail-closed rollback + fenced re-acquisition
  on new commandIds (never reuse a fenced command).
- Full intent→resolution→receipt binding checklist (F-04 fields) enforced before acceptance.
- link-publish uniqueness + idempotent-vs-conflict classification as the A1 store invariant.

---

# Final hardening addendum (G-01..G-09, three review findings)

```text
Tests: PASS 39 / FAIL 0 (30 prior + 9 new) ; RegistryCore 45/45 PASS
New coverage: G-01 same-lease receipt-loss rollback, G-02 receipt/witness crash window,
  G-03/G-04 issuance identity, G-05/G-06/G-07 witness loss/corruption/downgrade,
  G-08 fenced recovery, G-09 first-init availability guard
```

## Failure reproduction (all confirmed failing-first, 31 PASS / 8 FAIL before fixes)

- G-01: replay of an accepted command after same-epoch restore was silently ACCEPTED again.
- G-02: no receipt/witness crash hook existed; ordering unproven.
- G-03/G-04: second seal with the same targetDigest threw
  `conflicting sealed issuance under the same target digest` — cross-task issuance impossible.
- G-05: deleted witness → delivery ACCEPTED (protection silently dropped).
- G-06: corrupted witness → raw `SyntaxError`, not a contract code.
- G-07: omitted witnessRoot after protection → ACCEPTED (downgrade open).
- G-08: no recovery API existed.
- Test-methodology fix: overlay `cp` without wipe leaves post-backup files behind and is NOT a
  true restore; G-01 now wipes kernelRoot before restoring.

## Fixes and guarantees established

1. **Same-lease rollback (CRITICAL):** witness now binds receipt progress —
   `accepted: { commandId: { commandDigest, leaseEpoch } }` alongside maxEpoch. A replay whose
   acceptance the restored DB lost fails closed with `reconciliation-required`; never re-accepted.
   Persistence order is receipt-then-witness: the only crash window leaves a receipt without a
   witness entry, which the next identical replay heals idempotently (G-02 proves both halves).
   No exactly-once claim for external side effects: the guarantee is "never silently duplicate
   acceptance" (suspend/reconcile), not "effects execute once".
2. **Issuance identity (HIGH):** `issuanceId = sha256(canonical(complete issuance incl. task
   binding))`, carried in `provenance.issuanceId` and used as the trusted-store key; HMAC and
   deep-equal comparison unchanged and undiminished. `targetDigest` is model-target identity only.
   Two tasks sharing one target both seal and deliver (G-03); one task under two snapshots seals
   twice (G-04); cross-task issuance replay still fails (`generation-mismatch`); identical re-issue
   stays idempotent.
3. **Witness loss (HIGH):** kernel lease entries carry `witnessProtected`. Missing witness after
   protection → `reconciliation-required`; corrupt witness → `reconciliation-required` (never
   SyntaxError/skip); omitted witnessRoot after protection → `witness-required` on acquire AND
   deliver; recovery only via explicit `fenceForRecovery` (attestedMaxEpoch + operatorAttestation
   recorded, epoch fenced above kernel/witness/attested max, fresh baseline, old leases dead, G-08).
   First-time init on fresh roots still works (G-09 availability guard).

## Guarantees NOT established / remaining production blockers

- Witness MUST live in an independent failure domain; same-disk witness restored with the DB is
  undetected (prior F-02 LIMIT test retained as proof). Accepted-map growth is unbounded in the
  prototype — A1 needs pruning keyed to controller retention.
- Seal remains a file-shared key, not IPC authentication; same-UID readers/writers of kernelRoot
  break the prototype boundary. Mkdir mutex has no stale-lock recovery (needs fcntl/transactional
  store). Linux/btrfs + Node semantics only; no power-loss, Windows, or performance claims.
- Recovery attestation is operator-asserted, not independently verified; a wrong attestedMaxEpoch
  below a forgotten issuance could re-enable an old epoch — the audit record makes this explicit
  but A1 needs a stronger re-baseline source.

## A1-safe contracts (design, not code)

Sealed-issuance bytes with content-derived issuanceId; envelope digest layering; kernel-owned
monotonic leases; out-of-DB witness binding (maxEpoch + accepted receipts) with receipt-then-witness
ordering; full intent→resolution→receipt binding; link-publish uniqueness; fail-closed codes
`forged-issuer / rollback-detected / reconciliation-required / witness-required / command-conflict /
issuance-conflict / binding-mismatch / payload-tamper`; explicit fenced recovery with recorded attestation.

