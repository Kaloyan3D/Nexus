# Nexus Plugin-First — P2 closure report

Closes **P2 · First-party Nexus CLI for existing modes**, built on P1, as a development milestone. The pinned DSH is `dsh-v0.2.2-rc.1`. Platform evidence covers macOS arm64. Date: 2026-11-11.

**Development verdict: P2 GO.**

**Production verdict: NO-GO on the standard unpatched DSH.** Managed `submit` and `continue` stay refused until the gateway authorization extension is released (R01). All admission guards remain enabled.

## 1. Milestones completed

| Phase | Outcome | Report |
|---|---|---|
| P1 | One trusted host Controller, strategy index (Muse, legacy Dual), legacy CLI adapters | [P1](NEXUS-PLUGIN-FIRST-P1-IMPLEMENTATION-REPORT.md) |
| P2-A | Controller authority consolidation (safety foundation for the CLI) | [P2-A](NEXUS-PLUGIN-FIRST-P2A-IMPLEMENTATION-REPORT.md) |
| P2-B1 | Secure single-host ownership, authenticated IPC, read-only CLI, managed-session effect prevention | [P2-B1](NEXUS-PLUGIN-FIRST-P2B1-IMPLEMENTATION-REPORT.md) |
| P2-B2A | DSH authorization boundary: opt-in deny-wins `gateway/authorize` hook (PoC) and compatibility spec | [P2-B2A](NEXUS-PLUGIN-FIRST-P2B2A-REPORT.md) |
| P2-B2B | Durable managed submission, approval broker, activation gates | [P2-B2B](NEXUS-PLUGIN-FIRST-P2B2B-IMPLEMENTATION-REPORT.md) |
| P2-B2C | Session durability on format v4; typed holds for damaged historical sessions; identity tombstones | [P2-B2C](NEXUS-PLUGIN-FIRST-P2B2C-IMPLEMENTATION-REPORT.md) |
| P2-B2D | Authoritative verification through the existing `/verify`; operator recovery (close) | [P2-B2D](NEXUS-PLUGIN-FIRST-P2B2D-IMPLEMENTATION-REPORT.md) |
| P2-B2E | Durable multi-turn continuation (`nexus continue`) in the same DSH session | [P2-B2E](NEXUS-PLUGIN-FIRST-P2B2E-IMPLEMENTATION-REPORT.md) |
| P2-B2F | Review and visual gates through the task API; review provenance | [P2-B2F](NEXUS-PLUGIN-FIRST-P2B2F-IMPLEMENTATION-REPORT.md) |

## 2. Final Controller and CLI capabilities

- **One Controller task API** for both the CLI (authenticated IPC) and the GUI (`/nexus/tasks/v1/*`):
  - `hello`, `listModes`, `getStatus`, `getResult`, `follow`;
  - `submit`, `continueTask`, `cancel`, `respond`;
  - workspace, credential and session-check operations.
- **CLI:** `nexus modes|status|result|wait|submit|run|continue|cancel|respond|workspace|credentials|session|host`. It has stable versioned JSON and exit codes, and non-interactive mode never approves anything.
- **Durable managed tasks:**
  - idempotent submission and turns; same task, DSH session and attempt across turns;
  - crash-safe delivery with evidence read-back; tombstones; restart reconciliation.
- **Operator actions** are revision-bound, answered through `respond`, and the same in GUI and CLI:
  - run-verification, close;
  - run-review (Dual only);
  - review gate approve/reject; completion re-run.
- **Authorities preserved:**
  - the TaskController decides completion;
  - the existing `/verify`, reviewer, gate journal and visual loop are reused;
  - Muse has no independent reviewer; Dual review behavior is unchanged.
- **Typed explanations** for every hold or denial, plus completion and review provenance (an operator override is never shown as a reviewer PASS).

## 3. Final evidence

The final full production lane ran on a fresh install with the standard DSH, on the exact final source (`evidence/p2b2f/`):

| Metric | Result |
|---|---|
| Rows | **128** |
| Rows passed | **126** |
| Assertions passed | **3,388** |
| Introduced failures | **0** |

The 2 failures are pre-existing and unchanged since the P2-B2C baseline: `ContextRestrictedProductionV2` and `Harness` (`source contains no credential values`).

Source identity matched before and after the lane, and again at this checkpoint:

| Hash | Value |
|---|---|
| Tracked diff sha256 | `d5ac9788eeae6f38281c3620dcffa1870c78fb52d1ea0abe779d67eb9bf8cdc8` |
| Untracked source sha256 | `fd738264509ed9215cdd31584cba90efe39c9c5aa9dd96a85576c99e91e26428` |

Real-host results on the final code:

| Suite | Patched PoC (isolated) | Standard DSH |
|---|---|---|
| Gates | 7/7 | 2/2 (managed submit and continue refused) |
| Continuation | 7/7 | — |
| Verification | 5/5 | — |
| ManagedTasks | 13/13 | — |
| DurabilityRestart | 6/6 | — |
| ColdRestore | 3/3 | — |

Unit: Gates 9/9, Verification 8/8, Continuation 6/6.

## 4–5. Verdicts

- **Development: P2 GO.** Every P2 sub-phase is GO with completed tests, and the final-tree lane is within the known baseline.
- **Production: NO-GO** on the standard unpatched DSH `0.2.2-rc.1`, which refuses managed admission by design. The patched gateway was used only in disposable PoC installs and is not installed in any user runtime.

## 6. Deferred release requirements

These are in the roadmap's P2 release-hardening backlog. None of them blocks P3 in an isolated test environment.

| ID | Requirement |
|---|---|
| R01 | DSH gateway authorization release or integration |
| R02 | Windows/Linux native qualification (launchers, IPC ACL, installers) |
| R03 | Signed installers and CLI packaging; reviewed admission switch |
| R04 | Visual repair and re-verification |
| R05 | Multi-question approvals |
| R06 | Post-completion workspace and evidence protection |
| R07 | Retention and historical-session migration |
| R08 | Production provider and review-service integration tests |

## 7. Known limitations

- One active turn per task.
- No continuation or re-verification after verification starts.
- Review is available only before verification.
- Visual `revise`/`unavailable`/`exhausted` and a rejected gate end in close.
- Held or interrupted work is never resumed.
- No free-text review question.
- macOS arm64 only.
- The real-host reviewer and model are synthetic (no paid calls).
- Evidence committed before P2-B2C contains absolute local paths. Later evidence was sanitized to `<home>`/`<scratch>`/`<tmp>` placeholders (path strings only; results unchanged).

## 8. Git checkpoint

| | |
|---|---|
| Branch | `feature/nexus-plugin-first-p1` |
| Parent | `2070c617` |
| Commit | Local, created by this closure (not pushed, merged or deployed) |
| Contents | P2-B2C through P2-B2F source and tests, their reports and sanitized evidence, this report and the roadmap status update |

P1 through P2-B2B were committed earlier (`2d84cc8f`, `2070c617`).

## 9. Readiness for P3 — Nova Foundation

The frozen P2 task API, durable intake, verification and gate contracts are the base P3 depends on. P3 may start in an isolated test environment. It has **not** been started: no branch, no code, no prompt.
