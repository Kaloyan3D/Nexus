# Unified Permissions and Standing Grants — Milestone 2 report

Branch `feature/rust-native-core`, base `f7c3f0b` (milestone 1). Implements the authorization foundation for Trusted Workspace:
versioned per-project **standing grants** on three independent axes (filesystem, network, approval), managed only by the user
(CLI / Desktop native dialog), frozen into each task, sealed by the Kernel, enforced by the daemon, revocable and expiring, with a
single coherent **Ask / Auto** flow. Not implemented, by instruction: Full Access, Controlled Internet, real Direct Workspace shell execution.

## 1. Authority model (what decides what)

```
 user ──CLI (typed confirmation) / Desktop (native dialog)──► broker verbs project-grant-{preview,set,revoke,clear}
        │ the broker produces the exact consent text; only its digest, echoed back, lets a grant be stored
        ▼
 operator registry (projects.json, owner-only) ── StandingGrant{grantId, version, fs, net, approval, expiry} + audit log
        │  read by the daemon only
        ▼
 task creation (worktree-create / direct-open): resolve_task_permissions
        │  expired/revoked/unsupported ⇒ REFUSED (never the defaults). Result is FROZEN into the task identity record.
        ▼
 every operation of the task:  grant_may_act (registry read NOW)  ∧  check_within_grant  ∧
        ├─ approval = auto  → automated policy `autonomous-workspace/v1` decides (inside the grant only)
        └─ approval = ask   → stays pending → independent approver (approver capability, separate terminal) decides
        ▼
 Kernel approval row (operation.grant sealed in the request digest) → process scope v3 (grant id/version/digest + 3 axes, HMAC-sealed)
        ▼
 execution: daemon re-checks sealed ≙ frozen, grant still valid; the supervisor re-checks every 250 ms while the command runs
```

| Axis | Stored values | Not storable (fail closed) |
|---|---|---|
| filesystem | `scratch`, `workspace` (in-place over the Isolated task copy) | `full`; `workspace` together with the direct workspace |
| network | `offline`, `install` (existing dependency-install class) | `controlled`, `full` |
| approval | `auto`, `ask` | — |

**Immutable while running, can only shrink (corrected in M2.1: see `NEXUS-PERMISSIONS-M2.1-REPORT.md` §3).** A task freezes the grant's
identity and values at creation. At every operation it holds the *stricter, per axis,* of what it froze and what its grant lineage allows now:
widening never reaches it, narrowing applies from its next operation, and revocation, removal, a new lineage (granting again after a
revocation), its frozen expiry or a shorter expiry stop it - including a command already running (the supervisor re-checks every 250 ms).

**Separation of trusted approval from model-requested operations.** The model proposes only `{program, args, cwd}` (unknown keys, including
`fsScope`/`grant`/`net`/`approval`/`unsandboxed`, are refused). The operation description is built by the daemon from its own record. The
automated policy is **never consulted** for an `ask` grant, and the Kernel independently refuses a policy decision on any request whose
sealed declaration says `ask`. Human decisions need the approver capability (a different credential and, in production, a different uid)
that neither the model, the broker's issuer credential nor the Desktop renderer holds. No code path combines the two channels except per-task
by grant: the daemon flag `--standing-grants` is the only way the automated policy and an approver channel coexist; the store latch is a new
level `unified:standing-grants/v1` (same rank as automated; a store that ever ran human-only can never start unified).

## 2. What changed

| Area | Files |
|---|---|
| Grant model, digest, validation, consent text | `nexus-tools/src/grant.rs` (new) |
| Registry: `grant` on `ProjectRecord`, `set_grant`/`revoke_grant`/`clear_grant`, `resolve_permissions`, `task_may_act`, audit log `grants.audit.jsonl`, direct⇄in-place invariant | `nexus-tools/src/registry.rs` |
| Kernel: scope v3 (grant id/version/digest, net, approval), `DeclaredScope::from_operation`, policy refusal for `ask`, `POLICY_UNIFIED` | `nexus-kernel/src/tools.rs`, `approvals.rs` |
| Execution: network axis enforced for installs; grant recorded in journal (`prepared`/`exited`) and in folded tool events | `nexus-tools/src/authorization.rs`, `process.rs`, `events.rs` |
| Daemon: `--standing-grants` (+ optional approver channel), freeze at task creation, within-grant and validity checks at request / policy / execution / in-flight, status fields, audit fields in approval views | `nexus-daemon/src/server.rs`, `main.rs`, `profile.rs` |
| Broker + client + CLI: preview/set/revoke/clear verbs, `nexus project grant …` | `nexus-broker/src/projects.rs`, `server.rs`, `config.rs`, `nexus-client`, `nexus-cli` |
| Desktop: native confirmation commands and the Permissions panel | `src-tauri/src/interactive.rs`, `lib.rs`, `build.rs`, `capabilities/main.json`; `src/features/projects/ProjectsPage.tsx`, `api.ts`, `NexusContext.tsx` |
| Runtime: the Desktop-run daemon is started with `--standing-grants` (no grants ⇒ identical behaviour) | `nexus-runtime/src/lib.rs` |

## 3. Acceptance, with evidence

| Criterion | Evidence (test) |
|---|---|
| Automatic execution inside the grant | `perm_automatic_approval_runs_inside_the_grant_and_every_record_names_the_grant` (real daemon/Kernel/sandbox/broker): persisted in-place under the grant alone; every approval row and process journal record names grant id/version/axes |
| Ask presents the approval through the trusted path | `perm_ask_waits_for_the_independent_approver_and_a_denial_runs_nothing` (approver capability; approve ⇒ runs, not recorded as automated; deny ⇒ nothing runs); `perm_an_ask_project_is_never_decided_by_the_policy_even_when_nobody_answers`; daemon unit `a_grant_that_reserves_the_decision_for_a_person_is_never_decided_by_the_policy` |
| Outside the grant cannot run without a new authorization | `perm_requests_outside_the_grant…` (install under an offline grant refused; widening is a new version made by the user); unit `a_task_holding_a_grant_is_approved_only_inside_it_and_exactly_as_it_froze_it` (missing/other/widened grant, install, in-place under scratch, edits without declaration) |
| Expired and revoked rejected | `perm_expired_and_revoked_permissions_are_rejected_for_new_tasks`; `perm_revoking_stops_a_running_task_including_the_command_in_flight` (sleeping command killed, later operation never ran); registry tests `expired_and_revoked_grants_are_rejected…`, `a_running_task_can_only_lose_permission_never_gain_it`; unit tests for replaced/withdrawn/frozen expiry |
| Model cannot forge filesystem or network privileges | `perm_the_model_cannot_name_a_scope_a_grant_or_a_network_in_its_tool_arguments`; M1 `a_scope_the_approver_did_not_seal…`; Kernel unit tests (a changed axis/identity changes the sealed bytes; malformed or inconsistent declarations refused); `perm_a_daemon_that_does_not_honour_grants_refuses_projects_that_have_them`; daemon unit `new_tasks_are_refused_when_the_daemon_cannot_provide…`; scope-seal ≙ frozen check at execution |
| User-only management | CLI: `perm_the_cli_changes_permissions_only_after_an_explicit_confirmation` (no terminal / no `--yes` ⇒ refused; `full`, `controlled` refused even with `--yes`); Desktop backend: `permissions_m2.rs` (the broker's exact text is shown; a "no" stores nothing; a refused choice never opens a dialog; only the digest of the shown text is sent); UI tests (choices only; in-place disabled for direct) |
| Backward compatibility | Kernel golden test: a scratch/legacy scope still seals the exact v1 bytes; M1's v2 form unchanged; legacy rows deserialize to no grant; a project without a grant behaves as before; **provider request bodies vs the pre-milestone-1 baseline `8a08471`: 1617 bodies, 1446 identical, 169 volatile-tool-output, 2 polling-count-only, 0 unexplained** |
| Audit | `grants.audit.jsonl` (one line per create/replace/revoke/clear with who, digests, expiry; refused changes leave no line), grant history on the record, `grant` in approval views, in the Kernel approval request and in the process journal |

## 4. Gates (final tested SHA is stated in the commit message / `git log`)

Final tested SHA: **`87f475d`** (this report is added in a docs-only commit after it). Host: Linux 6.18, bwrap 0.13, x86_64.

| Gate | Result |
|---|---|
| `cargo fmt --all --check` (native; Tauri crate) | clean / clean |
| `cargo clippy --workspace --all-targets -- -D warnings` (native); Tauri crate `--all-targets` | clean / clean |
| Rust workspace battery, `NEXUS_REQUIRE_SANDBOX=1`, whole workspace | **1339 passed, 0 failed, 57 ignored** (M1 tree: 1309 / 0 / 57; +30 tests) |
| Tauri crate tests | 27 passed (1 ignored) + `permissions_m2` 2 + `runtime_update_a614` 1; 0 failed |
| Desktop: `tsc --noEmit`, `eslint src`, `vitest run` | clean, clean, **180/180** (21 files) |
| Release gate `EM04C2-ReleaseGate.cjs --bodies <8a08471 dump> <this tree>` (no skips) | **PASS (acceptance run)**: registry-js 22/22, engines 148/0, e2e 36/0, production 14/0 (negative control rejected and detected), release-binaries (no test-only symbol), desktop-binary, bodies |
| Provider request bodies vs the pre-milestone baseline | 156 tests, 1617 bodies: 1446 identical, 169 volatile tool output only, 2 polling-count only, **0 unexplained**; the 11 tests only in the new run are the milestone-1/2 tests |

Not run: the JS suites outside the gate and a Desktop window (no JS behaviour outside the Projects page changed); the real-provider acceptance runner.

## 5. Decisions made where the brief left room, and limits (stated, not hidden)

* **Revocation is immediate, including in-flight commands**, because it is cheap and the alternative (let a revoked task finish its running command) contradicts "revoked permissions are rejected". It is not a transaction: an operation already past the final check may complete.
* **Expired / revoked / replaced ⇒ refusal, never a fallback to defaults**, and this applies to read-only runs of that project too (a refusal at task creation). "Use defaults" (`clear`) is an explicit user action.
* **Write approvals carry the grant** in the sealed approval request (reviewed and journaled) but the *write* scope binding is not versioned: the Kernel-sealed scope with the grant is the **process** scope. Edits are covered by the execution-time validity check.
* **Ask in the Desktop** (closed in M2.1): the Desktop-run daemon now has an approver channel and the UI offers `ask` only when the runtime says it can be answered; the Desktop still never holds approval authority.
* The registry is the user's own file (same trust boundary as before: not signed; owner-only). A same-uid attacker who can write it is the user; the model's sandbox cannot see it.
* Under a grant the per-project `installs` flag no longer matters (the network axis governs); the checkbox still edits the legacy flag.
* The operator flag `--isolated-exec-scope` (M1) remains the default for projects **without** a grant; a grant's filesystem axis overrides it.
* The automated policy keeps its id `autonomous-workspace/v1`; its digest differs only on daemons started with `--standing-grants` (an extra `standingGrants` key), so scratch-only/legacy daemons keep the historical digest.
* In-place commands remain over the **Isolated** task copy only; `workspace` + direct is refused at storing, at switching, at task creation.

## 6. Prerequisites for the next steps

1. Desktop approver provisioning (an approver credential for the Desktop-run daemon and a read of `approverChannel` so the UI offers `ask` only when it can be answered).
2. Controlled Internet (egress service), Direct + in-place (observation/checkpoints, recursive hiding, Landlock) and Full Access remain as in the ADR §12; all will need only new axis *values* and backends — the grant, scope and approval plumbing here is the foundation they plug into (`net_policy_digest` is the next sealed field).
3. Optional: seal the grant into the write scope as well, if per-edit sealing (not only the reviewed operation) is wanted.
