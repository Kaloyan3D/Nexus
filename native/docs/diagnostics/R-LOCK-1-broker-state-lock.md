# R-LOCK-1 — Broker state-lock lifecycle

Branch `fix/native-broker-lock-lifecycle`, from `7211caf` (EM-01). Uncommitted, for review.
Offline only; no provider inference.

## Symptom
Sometimes, under the full parallel test battery, a broker restarted on the same state
directory right after `shutdown()` was refused with "another broker already owns this state
directory". Seen in `broker_a53::a53_broker_crash…` and in
`code_a56::a71_records_from_before_conversations…`.

## Root cause
- **How the lock works.** `nexus_broker::start` takes a non-blocking exclusive `flock` on
  `<state_dir>/broker.lock`. The descriptor lived in `Broker._lock`, and the lock was released
  only implicitly, when that descriptor was closed (the last `Arc<Broker>` dropped).
- **Why closing was not enough.** `flock` locks belong to the **open file description**. When
  *any* thread of the process forks a child, the child gets a copy of that description. The
  copy lives until the child calls `exec`; the descriptor is close-on-exec, so it never outlives
  the `exec`. Closing the broker's descriptor while such a child sits between `fork` and `exec`
  leaves the lock held through the child's copy, so an immediate restart is refused.
- **Why it only showed up in the battery.** Test binaries run tests as threads of one process,
  and sibling tests spawn daemons, node bridges, git and sandboxes all the time.
- **The earlier explanation was wrong.** It blamed a lingering `Arc<Broker>` / the 20 s
  worker-join deadline. That is falsified: the previous `Broker` was never alive after
  `shutdown()` (`Weak::strong_count() == 0` in every probe iteration).

## Fix (minimal)
New `nexus-broker/src/state_lock.rs`:
- `StateLock::acquire(state_dir)` does exactly what `start` did before: same file, same open
  flags, same non-blocking exclusive lock, and the same refusal text (`OWNED_ELSEWHERE`).
- `impl Drop for StateLock` calls `fs2::FileExt::unlock` (`LOCK_UN`) before the descriptor
  closes.

`Broker._lock` is now a `StateLock`. It is still the last field, so it is dropped after every
other field.

**Why `LOCK_UN` is safe:**
- It releases only the lock held by *our* open file description, whatever copies of it exist.
- A different live broker always owns a description it opened itself. An exclusive lock cannot
  be held on two descriptions at once, and no broker ever uses an inherited descriptor. So the
  release can never free another broker's ownership.
- A failed acquisition never builds a `StateLock`, so it releases nothing.

**Single-owner enforcement is unchanged.** The release happens only when the `Broker` itself is
dropped, after its last thread holding `Arc<Broker>` is gone. A worker still running past the
shutdown deadline keeps the lock. Deliberately, the lock is NOT released in `shutdown()`/`stop()`:
that could let a new broker start while an old worker still writes the state directory.

**Unchanged:** lock path, mode and error text; the steps before the lock (idempotent
`mkdir`/`chmod 0700`) and after it (socket publish).

## Evidence
### Reproducer
`race_probe_restart_after_shutdown`, from the EM-01 review package, run in throwaway copies:
300 restarts right after `shutdown()`, with optionally 8 threads in the same process spawning
`/bin/true`.

| Storm | before (`7211caf`) | after (R-LOCK-1) |
|---|---|---|
| none (control) | 0/300 | 0/300 |
| std spawn | 140/300, 137/300 | 0/300, 0/300 |
| forced fork (`pre_exec`) | 55/300, 60/300 | 0/300, 0/300 |
| old broker alive after `shutdown()` | 0 | 0 |

The same probe earlier gave `a497b87` 142/300, 134/300 and 34/300. With an experimental unlock
it gave 0.

### Regression tests (deterministic)
Unit tests in `state_lock::tests`, using a forked child that keeps every inherited descriptor
until it is killed:

| Test | What it checks |
|---|---|
| `ownership_is_released_on_drop_and_can_be_taken_again` | normal release and re-acquire |
| `a_second_owner_is_refused_while_the_first_one_lives` | legitimate contention; a refusal releases nothing |
| `closing_alone_leaves_the_lock_with_a_forked_child` | characterises the defect (old behaviour) |
| `a_forked_child_cannot_keep_a_released_lock` | the fix: restart while the child lives; new owner exclusive, also after the child exits |
| `a_release_can_never_free_another_owners_lock` | unlocking another descriptor or a refused contender never frees the owner |
| `the_lock_descriptor_never_survives_an_exec` | `FD_CLOEXEC` is set |
| `restarting_while_other_threads_spawn_children_never_fails` | 2,000 release/acquire cycles under a spawn storm |

Broker E2E tests in `broker_a53`:

| Test | What it checks |
|---|---|
| `rlock1_a_live_broker_keeps_exclusive_ownership_of_its_state_directory` | two genuine brokers, second refused on two other socket paths, owner keeps serving, restart after shutdown |
| `rlock1_a_restart_right_after_shutdown_is_never_refused_while_children_are_spawned` | 60 full broker restarts under an 8-thread spawn storm |

### The tests detect the bug
- **Mutation:** removing the explicit unlock makes 3–4 of the 7 unit tests fail.
- **Unfixed tree:** the broker restart E2E fails 3/3 on `7211caf`, with refusals at restarts 1,
  3, 5, 7, …
- **Stability:** the unit tests ran 200× in a row with 0 failures and 0 hangs, and the full
  broker lib 5×. (An earlier helper that waited on a pipe could deadlock when two forked
  children inherited each other's pipe ends; the helper now kills its child with `SIGKILL`.)

### Validation
- `cargo fmt --check` and `cargo clippy --workspace --all-targets -D warnings` are clean.
- Targeted: `nexus-broker` (lib, `broker_a53`, `code_a56`, `inspect_a55`, `rn2_binding`) and
  `nexus-kernel` (all suites): 291 passed, 0 failed, 5 ignored.
- Full battery (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast`): **932 passed, 0 failed, 49 ignored** (= EM-01's 923 + 7 lock unit tests + 2 broker E2E tests).

### No impact elsewhere
The diff touches only `server.rs` (lock acquisition and the field type), `lib.rs` (the module),
the new `state_lock.rs`, `broker_a53.rs` (tests) and docs. Not changed:
- EngineExtension (`engine/`, `inspect.rs`)
- persistent threads (`threads.rs`), run store (`store.rs`)
- task recovery (`code.rs`, `server::recover`), approvals and request execution (`pipeline.rs`, `inspect.rs`)
- completion; Kernel, contracts, model, tools and client crates
- Registry `config/`, Desktop

Registry pins, reasoning effort and tool schemas are untouched. The EM-01 request guard still
passes as part of `code_a56`.

## Remaining concurrency risks
1. **Crash or `SIGKILL` of a broker process.** No destructor runs, and the kernel closes the
   descriptor at exit. A child of the dying process that is between fork and exec could hold
   the lock for microseconds. The supervisor (`nexus-runtime`) waits for the process to exit,
   and every broker child execs immediately. Negligible; not addressed.
2. **Workers past the 20 s shutdown deadline** keep `Arc<Broker>`, and with it the lock. A
   restart is then refused until they finish. That is correct single-owner behaviour, not a
   race.
3. **Other `flock` users.** Most are unaffected: blocking locks (supervisor, project registry,
   transcript store, kernel guard) are only delayed by the window, never refused, and the kernel
   guard and `ensure_no_live_daemon` unlock explicitly. The exception is `nexusd`'s
   process-lifetime `try_lock` on `daemon.lock`, which shares risk 1 (cross-process,
   microseconds). Not changed here.
4. **Test helper.** Forking in a multi-threaded test process is safe only because the child
   calls nothing but `pause`.
