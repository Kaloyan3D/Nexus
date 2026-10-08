# CCv2 mutation-time fencing investigation

Scope: `fix/ccv2-lease-fencing`, based on integration HEAD
`390af181c79df08e4da1ee91a408238767d70d81`. No LHCB execution or edits,
no changes to PR #30. This is partial lock-authority hardening and a blocking investigation, not a completed lease-fencing fix.

## Architecture review before implementation

1. Source of truth: PowerShell owns the apply-lock file; A02 owns immutable
   compaction intent; DSH owns the live log and persistence dispatch; A11 owns
   generation reservations/head. These are separate authorities.
2. Ownership: the lock token authorizes A10 orchestration but is never consumed
   by the DSH mutation/persistence authorities. This missing contract is the defect.
3. Dependency direction: A10 invokes A02 and the CLI; A13 invokes A11/A10 and
   also A02 durable recovery. Lower layers do not consult the lock authority.
4. Boundary: acquire/renew return snapshots, not mutation capabilities.
   `append(type,data,options)` and `flush(session)` carry no owner/fence.
5. Failure: a suspended caller can resume after a successful renewal and
   legitimate takeover. Helper-process failure would also invalidate any
   proposal that merely holds a mutex in a separate CLI while Node can resume.
6. Lifecycle: each CLI process exits before Node mutates. Its recorded PID is
   not the Node writer. Lease expiry allows takeover; best-effort release follows
   flush/verification. OS suspension is not process death.
7. Test seams: retain the original diagnostic; add independent OS-process
   suspension against real DSH append/flush with observable stop/expiry barriers.
   No fixed delay is used as proof of ownership or exclusion.
8. Compatibility: no production change will be presented as complete without
   append, flush, recovery and generation finalization fencing. Extending leases,
   recording the live Node PID to forbid takeover, or post-write checks do not
   meet the requested semantics. Existing durable intent remains unchanged.
   The two independently reproduced lock-authority defects are corrected using
   the existing mutex: fail closed on unsuccessful acquisition; serialize release
   with takeover and re-read authorization inside the critical section. Lock file
   format, lease duration, renewal rules and takeover eligibility stay unchanged.
9. Observability: archive source hashes, authority replies, successor ownership,
   event/write counts and result statuses; retain failing safety assertions.
10. Security: fixtures contain synthetic messages only; evidence records IDs,
    counts and hashes, not prompts, provider secrets or private source contents.

## Investigated boundaries (baseline source locations)

- A10 acquires at `ContextActiveApplyV2.cjs:660`, freezes intent before renewal
  at 1083, then clean apply (1284), missing-segment retry (1261), and recovered
  flush (1242) run outside the ownership authority. Every path awaits flush
  before final verification and a `committed`/`recovered` result.
- A02 `ContextCompaction.cjs:952` and `:989` validate durable intent, then call
  `session.append` for each segment. Durable branding proves intent identity,
  not current exclusive ownership. Suspension can occur even within a synchronous
  segment loop; absence of a JavaScript await is not OS-process serialization.
- CLI acquire records `$PID` of the short-lived PowerShell invocation, not the
  Node writer. The existing mutex covers only lock-file acquire/renew decisions.
  `Use-AihCompactionLockMutex` additionally executes its action when WaitOne
  returns false or mutex operations fail. That fallback is not safe fencing.
- Release does not use that mutex: owner comparison followed by unlink is a
  separate TOCTOU window. Sequential stale release refuses correctly, but this
  alone does not prove it cannot unlink a successor after concurrent takeover.
- A11 `applyCurrentGenerationV2` reuses the same snapshot token through its
  reentrant wrapper. The outer owner is released after A10; generation head
  advancement later acquires a different generation lock. Reservation,
  supersession and head writes use the same acquire-then-JavaScript pattern.
- A13 `recoverUnresolvedGeneration` calls A11/A10; durable-only resume recovery
  (`recoverUnresolvedFromDurable`) calls A02 missing-segment append directly,
  then awaits flush. It has no mutation-time owner capability either.
- Pinned DSH `@deepseek-ai/dsh-session` 0.1.1-rc.2: `Session.append` snapshots
  JSON, validates the surface and pushes into its private log; its reentry guard
  is local to that Session object. `SessionStore.flush` dispatches persistence
  listeners and awaits them. Neither accepts or verifies a lease/fencing token.

## Required complete mechanism / current limitation

A complete repair needs an ownership authority shared with the actual writer:
verification and mutation must occur under the same cross-process exclusion,
and durable persistence/finalization must participate in that authority. The
protection must remain effective if the Node writer is suspended, and fail closed
if an auxiliary process dies. Legitimate takeover must revoke the stale writer's
ability to append, flush and finalize. Release must be serialized with takeover.

A token checked in a separate CLI call cannot provide this contract. A helper
holding the existing mutex cannot by itself fence an independently executable
Node writer when that helper dies. Another renew, checking after append, a longer
lease, or preventing takeover of all live Node processes is not a complete fix.

The current host/session API exposes no such transaction or fencing capability.
A repair must extend the host mutation/persistence contract or introduce a proven
writer-held cross-process primitive consistently consumed by PowerShell, DSH,
A02, A10, A11 and recovery. No claim is made that such a repair is impossible;
it has not been established on this branch. A02/A10/DSH mutation remains unchanged; only lock-authority fail-closed and
release serialization are repaired. PR #29 remains BLOCKED. Do not merge this investigation as a lease-fencing fix.

## Partial production correction

`ContextLifecycle.ps1` now throws when mutex construction/wait fails or the
existing 5-second WaitOne expires. It never executes the action without ownership;
abandoned-mutex acquisition remains supported. Release uses that same existing
mutex and re-reads the owner before unlink, so a takeover cannot interleave between
authorization and deletion. Initial scope selection alone never authorizes release.
Malformed lock files and unavailable mutexes refuse deletion. No extra primitive,
lease extension, retry, provider, activation or compiler change is introduced.

Rollback is reverting this scoped authority change; it would reintroduce the two
reproduced lock-file races. It does not resolve the main mutation-time blocker.

## Verification

All commands used Node 24.18.1 and PowerShell 7.5.3 from the installed Nexus
runtime, on native Linux. DSH Session/SessionStore proofs executed on the real
installed host; persistence in the suspension worker is a synthetic disk listener,
not the production persistence plugin. The campaign proves stale mutation and
flush/finalization permission, not simultaneous production-session disk corruption.

| Gate | Baseline | Scoped correction |
| --- | --- | --- |
| Original ShortLeaseOwnership diagnostic | FAIL: 7 → 8 events; committed after takeover | Main defect remains FAIL in real-host campaign |
| Authority timeout / construction / release races | 1 PASS, 3 FAIL | 4 PASS, 0 FAIL |
| Real-host OS suspension campaign, five boundaries + valid-owner control | 29 PASS, 12 FAIL | 29 PASS, 12 FAIL |
| A10 unit / real host | — | 171 / 60 PASS |
| A02 operation / foundation / PowerShell | — | 141 / 112 / 30 PASS |
| Lifecycle PowerShell | — | 99 PASS |
| A12 recovery unit / real host | — | 213 / 19 PASS |
| A11 generation unit / real host | — | 155 / 63 PASS |
| A13 integration unit / real host | — | 207 / 19 PASS |
| A10 / A11 / A12 / A13 existing cross-process suites | — | 16 / 27 / 41 / 22 PASS |
| Native Windows, PowerShell 5.1, complete repository suite | UNVERIFIED | UNVERIFIED |

The existing cross-process suites ran through the archived adapter that omits
only their two fixture `git config user.name/user.email` assignments. Synthetic
fixture repositories inherited the user's existing identity. No assertions,
synchronization, production code or repository files were changed by the adapter.
A12's existing short-lease scheduling test passed this invocation; that does not
establish fencing, which still fails at the independent suspension barriers.

The new campaign pauses the actual Node writer with SIGSTOP, observes `/proc`
stopped state, waits for the authoritative expiry and obtains the successor token
through the unchanged real CLI. SIGCONT resumes the stale writer. Boundaries:
after renew, before first append, between two segment appends, before flush and
after flush before successful completion. Each returns `committed` incorrectly.
The valid-owner control commits; stale renewal and sequential release refuse;
a fresh owner acquires/releases after expiry. Correct stale append/flush refusal
and generation finalization after takeover remain **FAIL / UNVERIFIED**, respectively.
Ordinary restart/idempotent recovery passed; recovery under revoked ownership is
not proved safe by those passes. No lease, takeover rule or assertion was weakened.

Reproduce (with pinned node/pwsh directories on PATH):

```sh
node tests/diagnostics/ShortLeaseOwnership.cjs /path/to/integration /tmp/original.json
CCV2_TEST_ROOT=/path/to/unchanged-integration node tests/ContextApplyLockAuthority.Tests.cjs /tmp/authority-before.json
node tests/ContextApplyLockAuthority.Tests.cjs /tmp/authority-after.json
CCV2_FENCING_EVIDENCE=/tmp/suspension.json node tests/ContextLeaseFencing.Tests.cjs
NEXUS_REQUIRE_CCV2_LIVE_HOST=1 node tests/ContextActiveApplyV2LiveHost.Tests.cjs
node docs/operations/evidence/ccv2-lease-fencing/xproc-verification-adapter.cjs tests/ContextRecoveryV2XProc.Tests.cjs
pwsh -NoProfile -File tests/ContextCompaction.Tests.ps1
```

The first two reproduction commands fail on unchanged integration; the authority
gate passes here. The suspension campaign deliberately still exits 1 with the
unfixed safety assertions. Full commands, outputs, before/after observations and
SHA256 identities are archived in `evidence/ccv2-lease-fencing/`. No frozen LHCB
evidence was modified, no benchmark ran, and no provider inference occurred.

## Readiness and remaining blockers

**Partial implementation verified; complete fix NOT ESTABLISHED. PR #29 BLOCKED.**
The patch fixes two lock-file authority defects. It must not be described as a
mutation-time fencing mechanism. Remaining release blockers are atomic writer
fencing at append (including between segments), persistence/async flush and
successful finalization; the same protection must cover durable-only recovery
and generation-state writes. A tested native Windows exclusion/lifetime contract
is also unverified. Review the independent draft PR as partial hardening/evidence,
then implement the shared writer-level contract and require every preserved red
regression to pass before incorporating a complete repair into PR #29.
