# M2.1 — Desktop permissions closure

Base: milestone 2 (`87f475d`, report `932548a`). Scope: the product gaps named in the M2 report. No Full Access, no Controlled Internet, no
Direct Workspace execution, no new architecture layer.

## 1. Ask is functional in the Desktop (and is offered only when it can be answered)

**Trusted path chosen: the existing terminal approver (`nexus-approver`), not a Desktop control.** It is the smallest safe change: the
credential, the typed review code, the exact daemon-authored request and the decision record already exist and are unchanged; the React
renderer and the model still hold no approval authority (the Desktop guard tests that forbid any `approval-*` reference in the backend are
unchanged and pass).

| Piece | What it does |
|---|---|
| `nexusd --approver-same-user` | The honest name for the single-user topology (approver = same OS user, **own credential**, used out-of-band in a terminal). Accepted **only** with `--standing-grants`; refused for the strict human mode, for the automated policy alone, and by `production-v1`. Decisions record `independent: false`. Equivalent to the old test-only flag in effect, not a new authority. |
| Desktop runtime (`nexus-runtime`) | Starts the daemon with `--standing-grants --approver-same-user --approver-cap <home>/approver/approver.cap --approver-uids <me>`. The credential is created by the daemon, owner-only (0600), in its **own** 0700 directory, separate from the issuer's and the daemon's. The broker, renderer and model do not read it. |
| Runtime state | `approverCommand`: the exact `nexus-approver --socket … --cap-file … review ` line with this installation's real **paths** (never the credential). `ApprovalBanner` shows it (with a copy button) instead of placeholders. |
| Broker `project-list` | Adds `permissions: {known, standingGrants, askAvailable, askReason}`, asked of the daemon's own status (1.5 s), never assumed. |
| Broker `project-grant-preview/-grant` | Refuse **before anything is shown or stored**: runtime did not answer; daemon does not apply per-project permissions; `ask` while no approver channel exists. |
| UI | “Ask me first” is disabled with the reason (a note names it); **Apply is disabled** when support is unknown; in-place stays disabled for a project that edits its real folder. |

Honest limit: on a single-user desktop the approver is not OS-identity independent. What the model/renderer cannot do is unchanged: they have
no path to the credential, and a decision needs the review code typed on a real terminal (`/dev/tty`, stdin and stdout must be ttys).

## 2. The installs setting is truthful

* **No grant:** the checkbox, unchanged (`installs` flag; legacy behaviour).
* **With a grant:** no checkbox. The cell states which setting governs: `installs: allowed by Permissions` / `not allowed by Permissions` /
  `stopped (permissions revoked|expired)`, with a tooltip that the Network setting decides and the old switch is not used while the grant exists.

## 3. Transition semantics (implementation = documentation = tests)

The rule: **a running task holds, at every operation, the stricter per axis of what it froze at creation and what its grant lineage allows now.**
Ordering: filesystem `scratch < workspace`; network `offline < install`; approval `ask` is stricter than `auto`; expiry = the earliest of the
frozen and the current one. Implemented in `nexus-tools::grant::narrowed` / `registry::task_permissions_now`, used by the daemon at request time,
in the automated policy, at execution (sealed scope must equal what the task holds *then*), and by the process supervisor while a command runs.

| Transition | New tasks | Running task, next operation | Command in progress | Regression tests |
|---|---|---|---|---|
| **Widen** (new version, same lineage) | get it | **nothing changes** (never gains) | continues | `grant::a_running_task_holds_the_stricter…`; registry `a_running_task_can_only_lose_permission_never_gain_it`; daemon `widening_or_replacing_with_the_same_permissions_never_changes_a_running_task`; e2e `perm_widening_never_reaches_a_running_task` |
| **Narrow** filesystem / network / approval | get it | **applies at once**: in-place declaration refused, installs refused, `auto`→`ask` makes the policy refuse and a person is required | continues (narrowing never kills) | daemon `narrowing_applies_to_a_running_task_from_its_next_operation`; e2e `perm_narrowing_applies_from_the_next_operation_and_never_kills_the_running_command` (the operation after narrowing to `ask` was held for a person and never ran) |
| **Replace** with an identical grant | get it | no change | continues | daemon (same test as widen) |
| **Revoke** | refused (`grant-revoked`) | refused | **killed** (supervisor re-checks every 250 ms; observed within seconds) | registry; daemon `revocation_regranting_and_clearing_each_end_a_running_task`; e2e `perm_revoking_stops_a_running_task_including_the_command_in_flight`, `perm_expired_and_revoked_permissions_are_rejected_for_new_tasks` |
| **Grant again after a revocation** (new lineage) | the new grant | old task stays stopped (`grant-replaced`) | killed | registry; daemon test above |
| **Expire** (frozen expiry, or a shorter one set later) | refused (`grant-expired`) | refused | **killed** | registry; daemon `the_expiry_frozen_into_a_task_ends_it_without_any_registry_change`; e2e `perm_expiry_ends_a_command_in_progress`, `perm_expired_and_revoked…` |
| **Clear / use defaults** | the long-standing defaults | refused (`grant-withdrawn`) | **killed** | registry; daemon test above; e2e `perm_clearing_the_permissions_also_ends_a_command_in_progress` |

Notes. Narrowing the *filesystem* axis of a task whose current command is already in place does not undo that command's effects. The consent
text and the Desktop panel now say exactly this (“widening applies to new tasks only; a running task never gains anything; narrowing applies from
its next operation; revoking or removing stops it, including a command in progress”). Operations already past the final check can complete
(not a transaction). The earlier M2 report said a narrower version did not apply to running tasks; that was an under-specification and is
corrected there.

## 4. Evidence

Final source SHA: **`ffc89b2`** (this report is added in a docs-only commit after it). Host: Linux 6.18, bwrap 0.13, x86_64.
Per the owner's instruction these are **focused** runs, not the whole battery; what ran and what did not is stated exactly.

| Check on `ffc89b2` | Result |
|---|---|
| `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; Tauri crate fmt + clippy `--all-targets` | clean / clean / clean / clean |
| `cargo test --workspace --no-run` (every test target in the workspace compiles) | OK |
| `nexus-tools`: `grants_m2` 6, `inplace_m1` 9, lib 33 (incl. `narrowed` table) | 48 passed, 0 failed |
| `nexus-kernel` lib (golden v1 bytes, v2, v3 seal, declared-scope parsing) | 5 passed |
| `nexus-daemon` lib (policy, freeze rules, all grant transitions) 42; `autonomous_a614` (startup rules incl. `--approver-same-user`) 5 | 47 passed |
| `nexus-runtime` (real daemon/broker lifecycle with the new flags) | 7 passed |
| Broker end-to-end, real daemon + Kernel + sandbox + approver (`code_a56 -- perm_ m1_`) | **20 passed, 0 failed** (14 permission tests incl. the real terminal approver through a pty, widen/narrow/revoke/expire/clear in flight; 5 milestone-1 tests; plus the Ask-unavailable refusal) |
| Tauri: lib 27, `permissions_m2` 2, `permissions_runtime_m21` 1 (real runtime) | 30 passed, 0 failed |
| Desktop: `tsc --noEmit`, `eslint src`, vitest (full suite 185/185 on the previous SHA; Projects/approval/composer files 60/60 on this one) | clean / clean / pass |

**Not run on `ffc89b2`, deliberately:** the whole Rust battery, the Tauri tests outside the three above (the 43 s runtime-update test ran earlier in the
same session on the preceding SHA), the full vitest suite and the release gate with request-body parity.
What exists instead: a **complete** validation run on `38d39ac` (the code commit before the last two test-only commits) in which the Tauri
suite, the Desktop suite (185/185) and every release-gate section except `bodies` passed (registry-js 22/22, engines 148/0, e2e 36/0, production
14/0 with negative controls, release binaries, desktop binary). In that run the Rust battery did not compile because one test rig literal
(`Tools { approver }` in `nexus-runtime/tests/lifecycle_a614.rs`) was stale - that is why `bodies` read "no test compared" - and it was fixed in
`ffc89b2` (no product code changed in the last two commits: a new expiry test and that literal). The last complete battery and request-body parity are
from milestone 2 (`87f475d`: 1339 passed, 0 failed; 0 unexplained of 1617 bodies). M2.1 does not touch anything a provider request is built from (the
harness text, tool schemas and engines are unchanged), so parity is expected, but it has not been re-measured on this SHA.

## 5. Desktop window smoke test — what was and was not done

**Not done by me: driving the real Desktop window.** Your standing instruction is not to drive/screenshot the desktop with computer-use tools
(token cost) and to ask you to click through instead. Everything below the window was exercised for real:

| Smoke step | Exercised how | Observed |
|---|---|---|
| Create an Isolated project | Desktop backend `Runtime::project_pick` against the **real runtime** (real `nexusd` + broker started by the Desktop's supervisor; dialogs scripted, stated) | project registered, `workspaceMode` isolated |
| Auto grant, allowed command | `perm_automatic_approval_runs_inside_the_grant…` (real daemon/Kernel/sandbox/broker, mock provider) | ran under the grant in place; every approval row and journal record names the grant; `automated-policy` |
| Ask grant → request → approve | `perm_the_real_terminal_approver_approves_and_denies_an_ask_operation` — the **real `nexus-approver` binary through a pseudo-terminal**, daemon started with the Desktop's exact approver flags | request held (`approval-pending`, nothing ran); approver printed the exact command; typing the review code → `recorded: approved`; command ran; record `approver-uid-terminal-review-code`, not automated |
| Deny | same test, answer `deny` | `recorded: denied`; file never created; activity `denied` |
| Revoke during an active command | `perm_revoking_stops_a_running_task_including_the_command_in_flight` | the sleeping command disappeared within seconds, later operation never ran |
| UI truthfulness | vitest on the Projects page and the approval banner (Ask disabled with reason, installs sentence, real approver command, no approve/deny control) | pass |
| Desktop runtime provisioning | `permissions_runtime_m21` | approver credential 0600 in its own 0700 dir, hint names real paths and not the key, `askAvailable` true, set/replace/revoke/clear through the backend, "no" in a dialog changes nothing, audit log order |

**For you to click through (≈5 min)** — `NEXUS_HOME=$(mktemp -d) nexus-desktop`, connect the provider, then: open a small project and answer
**No** to “edit directly”; Projects → Permissions… → *Commands change the task's working copy*, *Asks me first* (it should be enabled; the note must
not appear), Apply, confirm the native dialog; send a task that runs a command; the banner shows the approver command with real paths — paste it
into a terminal, type the review code (approve) or `deny`; repeat with deny; start a task with a long command (`sleep 120`) and press **Revoke**
mid-command (the command should stop within a few seconds and the run end without a success verdict). Also check that opening a project with
“edit directly” = **Yes** shows *Commands change the task's working copy* disabled.
