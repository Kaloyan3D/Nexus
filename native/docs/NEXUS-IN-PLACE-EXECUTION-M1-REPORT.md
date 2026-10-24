# True In-Place Execution — Milestone 1 report

Branch `feature/rust-native-core`, base `8a08471` (ADR revision 2). Implements ADR stages S1 (backend contract, no behaviour change),
the minimum of S2 (backward-compatible Kernel scope) and S3 (in-place execution) **over a disposable Isolated task copy only, with the
Offline / legacy-install network classes only**. Not implemented, by instruction: Full Access, the egress proxy / Controlled Internet,
Direct Workspace execution, Landlock, observation/checkpoints, standing grants.

## 1. What exists now

| Piece | Where | Notes |
|---|---|---|
| Platform-neutral contract | `nexus-tools/src/exec_contract.rs` | `FsScope {Scratch, Workspace, Full}`, `NetScope`, `Approval`, `ExecGrant`, `BackendCaps`/`RequiredCaps`, `ExecRefusal`, `check_grant`, `ExecBackend` + `LinuxBwrapBackend`. `Full`, `Controlled`, `Full` network are *named* and always refused (`NotImplemented`); there is no code path from a refusal to another scope. |
| In-place root preparation | `nexus-tools/src/inplace.rs` | duplicates the descriptor the `Workspace` pinned; refuses mounts below the root; `.git` read-only; **existing** top-level secret-shaped entries hidden (file/socket → empty file, dir → tmpfs); absent names never masked (ADR E2). |
| Sandbox | `nexus-tools/src/sandbox.rs` | `SandboxSpec.pinned_root` / `protect`; argv uses `--bind-fd`, `--ro-bind-fd`; descriptors placed in fixed slots just before exec, everything above closed. Scratch argv (and therefore `sandboxDigest`) is byte-identical to before. |
| Process layer | `nexus-tools/src/process.rs` | in-place: no staging, no node_modules harvest, journal/outputs say `writeBack: "in-place"`, `fsScope: "workspace"`, `snapshotDigest: null` (the three `writeBack:"none"` literals are now conditional). Requires the workbench command policy. |
| Kernel scope | `nexus-kernel/src/tools.rs`, `approvals.rs` | `ProcessScopeBinding.fs_scope` (serde default `scratch`). **A `scratch` scope is sealed and verified with exactly the v1 bytes** (golden test); a `workspace` scope uses domain `nexus-process-scope/v2` and a `fsScope` field. The value is read from the reviewed, digested operation (`operation.execFsScope`); only `scratch`/`workspace` can be sealed. |
| Daemon | `nexus-daemon/src/server.rs`, `main.rs` | operator flag `--isolated-exec-scope scratch|workspace` (needs `--enable-process` + `--autonomous-workspace-policy`; `full`/unknown refused at start). Frozen into each new copy's identity record; `task_fs_scope()` reads only that record (direct tasks and unknown names are always scratch). Policy: operation's declared scope must equal the task's, and its write-back text must be the truthful one for that scope. Run: the Kernel-sealed scope must equal the derived one or the command is refused. Copy gets `.git/info/exclude` for toolchain artifact folders. |
| Broker | `guidance.rs`, `inspect.rs`, `intent_client.rs` | the daemon reports `execFsScope`; the run records it (`execScope`); the harness text is truthful when commands persist. Scratch text is byte-identical. |

Authority flow: operator flag → daemon identity record (outside the copy) → daemon-built operation (`execFsScope`) → automated policy
(equality with the record) → Kernel approval row → sealed process scope → daemon re-check → `prepare_process` → `run_process`. No tool
argument, model output, renderer message or IPC field of the model path can set or change the scope (`ProcessArgs` has no such key; the
broker's argument filter and the native `deny_unknown_fields` both reject one — T16 test).

## 2. Acceptance, with evidence

| Criterion | Evidence |
|---|---|
| Existing isolated/scratch behaviour unchanged | scratch `proc_run` test asserts `writeBack:"none"`, 64-hex `snapshotDigest`, no `fsScope` key, `scratchEffects`, project untouched; Kernel golden test of the v1 canonical bytes + legacy-row deserialization; daemon test that the policy digest of a scratch-only daemon equals the historical digest; broker e2e that the default daemon leaves the copy untouched and sends the historical harness text; **provider request bodies: 1617 bodies in 156 tests compared against `8a08471` — 1436 identical, 169 volatile-tool-output only, 12 order-only, 0 unexplained** (`EM04C2-CompareBodies`, the release gate's own comparator); the 4 tests only in the new run are the new milestone tests. |
| Real files created/modified in the authorized worktree | `mkdir`, a `sed` formatter and a Python generator persist (tools test); a later *command* sees them; they appear in the run's `git diff` (broker e2e); files are owned by the real uid. |
| Escape refused | symlinks (absolute, relative, `/etc/passwd`), direct host path, `../`, `/usr`, `/work`, `..` writes, network: all fail; no outside secret read; hidden `.env`/`.ssh` unreadable and unchanged; `.git` writes (`config`, new file, `rm HEAD`) fail; swapping the directory's path during the run cannot redirect the mount (writes land in the verified object); only fds 0–3 inside. A mutation check (disabling the protections) makes the protection test fail. |
| Cancellation and restart | cancel kills the whole tree, partial output persists, no writer remains, run dir removed; real `nexusd` SIGKILLed after the command exited → run not completed/verified, files kept, exactly one execution, journal `interrupted`; `nexusd` SIGKILLed mid-command → sandbox tree gone (`die-with-parent`), recovery closes the execution as `interrupted`, never as success. |
| Gates | see §3. |
| No model-controlled escalation | `fsScope` argument rejected (`invalid-arguments`); scratch scope runs scratch; Kernel refuses `full`, `host`, `""`, `WORKSPACE`; daemon refuses `full` at start; policy refuses mismatched scope/write-back in both directions (unit test). |

## 3. Gates run (this host: Linux 6.18, bwrap 0.13, x86_64)

| Gate | Result |
|---|---|
| `cargo fmt --all --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| Rust workspace battery, `NEXUS_REQUIRE_SANDBOX=1`, whole workspace | **1309 passed, 0 failed, 57 ignored** (the Direct Workspace document recorded 1271 / 0 / 57 at its tested SHA; the tree has moved since, so the difference is not attributable to this milestone alone — this milestone adds 23 tests, 24 with the later patch-exclusion test) |
| Request-body parity vs `8a08471` | PASS, 0 unexplained (above) |
| Tauri crate `cargo clippy --all-targets -- -D warnings` | clean |
| Release gate `EM04C2-ReleaseGate.cjs --bodies <base> <new>` (no skips) | **PASS (acceptance run)**: registry-js 22/22, engines 148/0, e2e 36/0, production 14/0 (negative control rejected and detected), release-binaries (3 executables, no test-only symbol), desktop-binary, bodies (above) |
| JS suites | not run: unrelated to this change (no JS/renderer source touched); pwsh/app-deps limits per the known local baseline |

The baseline battery used for the body comparison was run from a detached worktree with its own target directory; 164 of its tests failed *only* because several
suites hard-code `native/target/debug/nexusd` ("build the workspace first"). That is a harness artifact of the baseline run, not a result about either tree; the
body-producing broker tests honour `CARGO_TARGET_DIR` and ran.

### 3.1 Not run

JS suites outside the gate, the Tauri tests and a Desktop window were not run (no renderer/JS source changed). The patch-exclusion test (`m1_dependency_and_cache_folders…`) and the descriptor-leak test were added after the full battery and were run on their own (pass); the gate's `e2e` section was run afterwards on the final tree.
The Desktop profile does not enable the new scope, so no shipped default behaviour changed.

## 4. Guarantees that are intentionally weaker for arbitrary shell execution (M1)

Unchanged principle from the ADR (§6): authority is per command and scope, not per file.

| Property | `fs_write`/`fs_edit` | In-place command (M1) |
|---|---|---|
| Per-file authorization | yes | **no** — the whole copy is writable |
| Pre-image kept | enforced (Direct) / n.a. (Isolated) | **none**; the copy is disposable and its git base is the pre-image |
| Atomic writes | yes | the tool's own semantics |
| What changed | journal per op | **not observed by the process layer**; visible only through the task's `git diff` (toolchain folders excluded) |
| Attribution | per operation | none inside the copy (single actor: the task) |
| `.git`, secrets | name policy | `.git` read-only; **top-level** secret-shaped entries hidden — nested ones are *not* (the snapshot that makes the copy already excludes them at every depth) |
| Landlock / second layer | — | **not applied**; one confinement layer (namespaces + seccomp + mounts) as in A3.4 |
| Network | — | unchanged: offline, or the existing install class (host network, installs-enabled projects only) with the copy visible — the same files the staged copy exposed before |
| Dependencies | env store | installs now write `node_modules` etc. **into the copy** (excluded from the patch); each new task copy reinstalls (the npm cache stays in the env store) |
| Crash | journal + reconcile | process killed and closed `interrupted`; effects remain, **unverified** |

## 5. Exact prerequisites for Direct + Controlled Internet

Nothing below is started. Each item is a gate for the stage named (ADR §12).

1. **S4 — evidence for a real folder.** Pre/post tiered manifest over the pinned fd; `settled` (cgroup empty); `observed` ledger in `direct::Store` with attribution
   `command:<executionId>` so `diff` and `external_changes` include and correctly attribute command effects (today they would mis-credit them to the user);
   checkpoint (reflink / bounded copy) and guarded rollback; owner decision D4.
2. **S3 completion for a user folder.** Recursive hiding of secret-shaped entries and sockets (today top-level only); hard-link (`nlink>1`) and escaping-symlink
   reporting; integration test for the nested-mount refusal (only the parser is unit-tested); post-spawn identity cross-check / `--block-fd`; **Landlock shim**
   (decision D3) with abstract-socket scope; `.git` policy (`git_write`, `git` program) and its consent text (D6).
3. **S2 — authority.** The standing grant in the registry with user-only verbs (CLI + Desktop dialog, consent-text digest); Kernel scope v3 fields `net_scope`,
   `approval`, `grant_digest`, `net_policy_digest`; policy rule "requested ⊆ granted"; **approval-mode coexistence** (the daemon currently refuses to combine the
   automated policy with human approval, `main.rs:695-717`) — to be solved by one coherent authority model, not by a bypass; `task_fs_scope()` must stop forcing
   direct tasks to scratch only after items 1–2 hold.
4. **S5 — Controlled Internet.** `nexus-egress` process (policy digest = grant digest), in-sandbox bridge, env/hosts plumbing, `local_ports`, TCP bridges, SNI check,
   byte accounting, `pendingEgress` → user card → grant amendment, tool-compatibility matrix (npm/pip/cargo/go/git/Node `fetch`/JVM/.NET), exact-host presets;
   proven first on the Isolated copy.
5. **S6 — Direct specifics.** exec lease (the `project-busy` claim covers writers; commands become writers), Resume/`external_changes` integration, guidance + consent text for
   "your real folder", grant UI, owner try-it.
6. **Owner decisions still open** (ADR §14.2): D1, D4, D5, D6, D8, D9, D13, D14, D15, D16.

## 6. Known limits of this milestone (found, not hidden)

* The operator flag is a *precursor* of the standing grant: one setting per daemon for all new Isolated copies, not per project.
* The Desktop profile does not pass the flag; in-place is therefore off in shipped defaults (default behaviour is scratch, as before).
* `exec_scope` is added to the run record (`execScope` in JSON when set); no UI uses it yet.
* The process layer reports no file effects for in-place runs; the broker's `verified-scratch` verdict is driven by `scratchEffects`, which is absent in place, so a passing
  in-place check reads `verified-passed` — correct for a disposable copy whose git diff is the evidence, and to be revisited with S4.
* Host requirement: bubblewrap with `--bind-fd`/`--ro-bind-fd`; otherwise `check_grant` refuses with `BackendInsufficient`/`NotImplemented` and nothing runs.
