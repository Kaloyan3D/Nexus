# M3A — Filesystem observation and the command effects ledger

Branch `feature/rust-native-core`. Step 0 baseline: `e68cfe8` (source `ffc89b2`). M3A source commit: **`4ec6f93`** (this report is added in a docs-only
commit after it). Host: Linux 6.18, bwrap 0.13, x86_64. No checkpoints, no rollback, no Landlock, no Direct `proc_run`, no new permission mode.

## 0. Step 0 — full validation of the M2.1 final state (before any M3A code)

Run in an isolated worktree at `e68cfe8` (source commit `ffc89b2`), `NEXUS_REQUIRE_SANDBOX=1`:

| Gate | Result |
|---|---|
| `cargo fmt --all --check`; strict clippy `--workspace --all-targets -D warnings` | clean / clean |
| Rust workspace battery | **1350 passed, 0 failed, 57 ignored** |
| Tauri fmt + clippy `--all-targets`; Tauri tests (27 lib, `permissions_m2` 2, `permissions_runtime_m21` 1, `runtime_update_a614` 1) | clean; all passed |
| Desktop `tsc --noEmit`, `eslint src`, `vitest run` | clean, clean, **185/185** (21 files) |
| Release gate with request-body comparison against the pre-M1 baseline `8a08471` | **PASS**: registry-js 22/22, engines 148/0, e2e 36/0, production 14/0 (negative control rejected), release binaries, desktop binary, **bodies: 1617, identical 1446, volatile-tool-output 169, polling-count-only 2, unexplained 0** |

No failure, so no fix was needed; the gap named in the M2.1 report (battery and body parity not re-measured on the final SHA) is closed.

## 1. What was built

### M3A.1 — Observer (`nexus-tools/src/observe.rs`)
Observes the workspace through the **pinned root descriptor** (descriptor-relative walk, no symlink following, `openat2` BENEATH/NO_XDEV), never by path.
Stat-based manifest: type, size, mode, uid/gid, mtime, **ctime (the change detector)**, inode, link count, symlink target. Nothing is pre-hashed;
after the command only the files that appeared or changed are hashed, within a byte budget, and **never a secret-shaped file** (names classified
sensitive by the workspace policy). Hard limits (daemon-configured: `--observe-max-entries`, `--observe-max-ms`; no tool argument can reach them):
entries 200 000, bulk 5 000 per directory, depth 64, wall 20 s, hash file 1 MiB / total 64 MiB, list cap 500.

Completeness is explicit, never implied: `entry-budget`, `time-budget`, `unreadable:<p>`, `vanished:<p>`, `non-utf8-name`, `mount-crossing:<p>`, `depth:<p>`,
`changed-during-observation:<p>`, `root-unavailable`. A truncated *bulk* directory is counted (`bulkTruncated`) but does not make the detailed tier incomplete
(by design: otherwise every command in a large repository would degrade).

### M3A.2 — Tiered manifests
Tier 1 (detailed per-entry) for everything else; tier 2 (bulk summary: entry count, dir count, newest ctime) for `node_modules`, `target`, `dist`, `build`, `vendor`,
`__pycache__`, `.venv`, `venv`, `.next`, `.cache`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.gradle`, `.tox`, `.nuxt`, `.parcel-cache`; `.git` is *protected* (summarised, and
any change to it, a secret-shaped name or a build-steering file is listed under `protected`). Renames are reported as delete + create, with a `likelyRenames` hint
(same inode, size, mtime) that is evidence, not proof. Hard links, symlinks that escape the root, specials (fifo/socket/device) and mode/owner changes are listed.

### M3A.3 — Durable effects ledger
* **Kernel journal** (existing phases, bounded): `prepared` gains an `observation` boundary (start time, workspace dev/ino, root path, whether the path still leads to the pinned root,
  pre-manifest digest/entry count/completeness, budget); `exited`/`cancelled`/`interrupted` gain an `effects` summary (≤20 paths per category).
* **Full record**: `<run_root>/_effects/<executionId>.json` (0600 in a 0700 directory, atomic write + fsync), schema `nexus.command-effects/v1`, with its own digest. Tool output carries a ≤40-path summary.
* **Pre-manifest persisted before spawn** (`<id>.pre.json.gz`) so a crash can still be compared; removed once the record exists. Startup sweeps ledger files older than 30 days.
* **Outcome**: `observed` (both manifests complete, process ended and the whole tree settled), `partial` (complete evidence of a command that did not finish normally: cancelled, revoked, timeout...),
  `uncertain` (incomplete manifest, tree not settled, identity changed, ledger write failed, or recovered after a crash). `uncertain` + exit 0 ⇒ `verification: unverified`, never `pass`.
* Daemon issuer verb `exec-effects {executionId}` returns the record (id validated to the Kernel's alphabet before it names a file).
* Attribution is always **temporal** and says so in the record: *changes appeared while the command ran; it does not prove the command made every one*.

### M3A.4 — Direct Workspace evidence
`direct::Store` keeps `observed` records (idempotent per execution id, capped at 64). `diff` lists command-only paths with `origin: command`, `attribution: temporal|ambiguous`,
`preImage` (a created file is shown whole against nothing; command-modified/deleted files are listed without a diff because no pre-image exists) and a `commandEvidence` block.
A path where a tool write completed inside the command's window is `ambiguous`. `external_changes` treats what the command left as the expected state, so a **later user edit is an outside change**.
Direct tasks cannot yet run in-place commands (M2 refuses `workspace` + direct), so the integration is exercised with real records from real sandbox runs and with synthetic records; no Direct `proc_run` exists.

### M3A.5 — Lifecycle
In-place runs only (Scratch output and journal are byte-identical: asserted, no `effects` key, no `_effects` directory). Sequence: verify identity → observe pre → persist → journal `prepared`
→ spawn → supervisor → (cgroup emptied ⇒ `settled`) → observe post → diff → hash → judge → write record → remove pre → crash point → journal end.
Early cancel/revoke before spawn removes the pre-manifest. After a daemon crash, recovery kills the leftover cgroup, **re-observes the workspace and compares with the persisted pre-manifest,
records outcome `uncertain` (`recovered-after-crash`)**, and closes the run as `interrupted` — never as success, never re-run.

## 2. Tests (all new unless stated)

| Level | Test | What it proves |
|---|---|---|
| unit (`observe`) | 9 | manifest/diff/budget/protected/rename/digest stability |
| tools, real sandbox (`effects_m3a`) | `nested_files_edits_deletes_and_a_formatter_are_reported_exactly` | nested creates, `sed -i` formatter, delete, rename hint, exact post hashes, journal boundary + summary, pre-manifest consumed, 0700 dir |
| | `successive_commands_each_describe_only_their_own_changes` | two commands; second pre digest = first post digest |
| | `dependency_directories_are_summarised_not_enumerated` | 300 `node_modules` files never listed; bulk summary present |
| | `an_observation_that_ran_out_of_budget_is_uncertain_and_never_reported_as_verified` | tiny budget ⇒ `uncertain`, `unverified` |
| | `an_unreadable_directory_makes_the_observation_partial_not_silent` | `unreadable:locked` |
| | `a_cancelled_command_still_leaves_an_honest_partial_record` | cancellation during writes ⇒ `partial` with the files seen |
| | `a_concurrent_user_edit_is_reported_as_temporal_not_as_the_commands_proven_work` | concurrent user edits listed, attribution `temporal`, note says it does not prove |
| | `the_model_cannot_set_or_widen_the_observation` | `observe`/`budget`/`effects`/`maxEntries`/`ledger` arguments refused |
| | `what_a_user_edits_after_a_command_is_an_outside_change_in_the_direct_evidence` | Direct diff + external change |
| | `a_tool_write_inside_the_command_window_makes_attribution_ambiguous` | ambiguity rule |
| broker e2e, real daemon/Kernel/sandbox | `m3a_observed_changes_are_in_the_project_diff_and_the_ledger_matches_the_journal` | every observed change ⊆ the project diff; dependency files not enumerated; journal digest = file digest |
| | `m3a_a_crash_after_the_observation_keeps_the_record_and_still_closes_the_run_as_interrupted` | SIGKILL after the record exists |
| | `m3a_killing_the_daemon_mid_command_records_what_the_recovery_saw_as_uncertain` | SIGKILL mid-command: pre-manifest present while running, recovery re-observes, `uncertain`, run not completed, no leftover |
| existing, adjusted | `inplace_m1` scratch test now also asserts no `effects`/no ledger; cancel test ignores the `_effects` directory | Scratch unchanged |

Note for anyone running broker tests by hand: `crash-injection` is a *dev-dependency* of the daemon, so `nexusd` has the crash points only when built by `cargo test` (e.g. `cargo test --workspace --no-run`); a plain `cargo build` produces a daemon without them.

## 3. Observation performance (release build, `bench_observation`, ignored test)

| Tree | Entries (tier 1) | Dependency files | Pre-observation | Post-observe + diff + hash | Pre-manifest (gz) | Effects JSON |
|---|---|---|---|---|---|---|
| small | 1 321 | 0 | 9 ms | 9 ms | 23 KB | 0.7 KB |
| medium | 20 321 | 0 | 83 ms | 119 ms | 409 KB | 0.7 KB |
| large | 20 322 | 130 000 (1 bulk dir) | 99 ms | 113 ms | 392 KB | 0.7 KB |

The dependency tier keeps a repository with 150 000 files at the cost of 20 000: bulk directories are summarised by one cheap pass. A command costs roughly two observations (≈ 0.2 s on a 20 000-file project).

## 4. Final validation of `4ec6f93`

Host: Linux 6.18, bwrap 0.13. `NEXUS_REQUIRE_SANDBOX=1`.

| Gate | Result on `4ec6f93` |
|---|---|
| `cargo fmt --all --check`; strict clippy `--workspace --all-targets -D warnings` | clean / clean |
| Rust workspace battery (run twice, see below) | **1372 passed, 0 failed, 58 ignored** both times (baseline 1350 / 0 / 57: +22 tests = 9 observer units, 10 tools-level, 3 broker e2e; +1 ignored benchmark) |
| Tauri fmt + clippy `--all-targets`; Tauri tests | clean; 27 lib, `permissions_m2` 2, `permissions_runtime_m21` 1, `runtime_update_a614` 1: all passed |
| Desktop `tsc --noEmit`, `eslint src`, `vitest run` | clean, clean, **185/185** |
| Release gate: registry-js / engines / e2e / production / release-binaries / desktop-binary | PASS 22/22 / PASS 148-0 / PASS 36-0 / PASS 14-0 (negative control detected) / PASS (no test-only symbol) / PASS |
| Release gate `bodies` (request bodies vs pre-M1 baseline `8a08471`) | **PASS on the clean rerun**: 156 tests, 1617 bodies, 1438 identical, 169 volatile tool output, 8 order-only, 2 polling-count-only, **0 unexplained**, non-input fields identical in 1617/1617 |

**One failed measurement, stated plainly.** The first body comparison of this SHA reported `FAIL` (33 unexplained bodies). That run happened while the Step 0 release gate was still running on the same
machine (load average ≈ 15). The differing bodies were scheduling-dependent, not content-dependent: the order of two concurrent conversations (`a71_two_conversations_running_at_the_same_time…`), a
conversation-history entry whose recording raced (`rn2_…`), a timing-derived effort level (`s8_…`), and tool output that carries wall-clock numbers. Nothing in them involved `effects`. The battery
was re-run unchanged on an idle machine (same SHA, same flags): 1372 passed, 0 failed, and the comparison passed with 0 unexplained (Step 0, before any M3A code, measured 0 unexplained with 0 order-only).
The idle-machine comparison was run with the gate's own comparator (`compareDirs`) on the new dump, not as a second full gate invocation; the other gate sections above come from the first full gate run on this SHA.

Request bodies for **Scratch** runs are unchanged by M3A (asserted by the scratch test and by the comparison). In-place tool results now carry a bounded `effects` summary, which the model can see: this is intended, and
is the only change to what a provider request can contain (`m3a_*` and `m1_*` tests are new relative to the pre-M1 baseline).

## 5. Limitations (stated, not hidden)

* **Attribution is temporal.** Anything that changes during the command window is listed; the record cannot say who did it.
* Command-origin **modifications and deletions have no pre-image** (no checkpoint yet): they are listed, not diffable, and cannot be undone. That is M3B.
* Detection relies on ctime/size/mtime/inode; a process that restores ctime (root only) or a change inside a **bulk directory** is seen only as a summary difference (counts/newest ctime), not as paths.
* Secret-shaped files are listed but never hashed; files over 1 MiB or past the 64 MiB budget are listed without a hash.
* An observation budget that is exhausted yields `uncertain` and `unverified`: large monorepos may need `--observe-max-entries`/`--observe-max-ms` raised.
* After a crash the ledger file of a command whose record was already written stays `observed` on disk while the *journal* closes it `interrupted` (`uncertain` in the summary): the file states what was seen, the journal states that nobody saw the end.
* Direct tasks cannot run in-place commands yet; the Direct integration is verified with real sandbox records and synthetic ones, not with a live Direct `proc_run`.
* No Landlock (M3C): the sandbox, not the observer, prevents writes outside the pinned root; the observer only reports.

## 6. M3B readiness

See the verdict in the final message of the milestone. Prerequisites M3B needs and M3A now provides: a durable per-execution boundary (`observation`), an authoritative list of created/modified/deleted paths with hashes, explicit incompleteness, and a crash-safe pre-manifest. What M3B must add: content pre-images (copy-on-first-change, reflink where possible) for the paths the observer would find, bounded in size, taken **before** the command.
