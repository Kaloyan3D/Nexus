# EM-04C2 — Pre-activation security review

Baseline `50a24d791cdb3c1a4b00eb15b24843c4b45d9798` (EM-04C1). Read-only investigation: no
implementation file was modified; experiments ran from scratch drivers outside the repository
against the repository's own worker script and Node binaries. Companions:
`EM-04C2-ANTI-THRASH-POLICY.md`, `EM-04C2-ACTIVATION-PLAN.md`.

**Verdict for part A:** retain the trusted-worker model, **conditional on four small controls**
(§A.9): Node's deny-all permission mode with a startup self-check, tighter memory flags, a worker cap
derived from `max_active`, and one corrected audit event. A separate UID, landlock, namespaces or a
second supervisor are **not** required and are not recommended now.

References are `file:line` in the baseline tree.

---

## A.0 Corrections to earlier C1 statements

| Earlier statement | Finding |
|---|---|
| "RSS plateaus near 132 MiB (heap cap + ≈ 35 MiB)" | Only true for the system Node 26. With the **bundled runtime Node 24.18.1** (`~/.local/share/nexus/runtime/node/bin/node`) the same workload (a signal every second request) reaches **126 MiB at 500 requests, 180 at 1,000, 200 at 2,000, 214 MiB at 10,000** with `--max-old-space-size=96`. The old-space cap does not bound the young generation. See §A.6 for the fix. |
| "worst case 16 × 135 MiB ≈ 2.1 GiB" | Worst case with the current flags on the bundled Node: 16 × ~210 MiB ≈ 3.4 GiB. In practice bounded by `max_active` (§A.6). |
| "identity of a continuation covers the binding" (C1 report §2) | The continuation identity digest does **not** cover the slot's `allowedReasoning` (G-1 in the activation plan). |

## A.1 What the worker is, exactly (source-verified)

* One `node --max-old-space-size=96 -e <worker script> -- <scope>` per Governor-capable run,
  `env_clear`, stdin/stdout pipes, stderr `/dev/null` (`engine/worker_bridge.rs:317-323`).
* It executes the four historical CommonJS modules, byte-pinned: the supervisor sends them in
  `hello` and requires the worker to return the SHA-256 of each equal to the broker's embedded
  constants (`worker_bridge.rs` `handshake`). The adapter (`muse_bridge.cjs`) gives the modules a
  `require` that resolves only `node:crypto`, `node:path`, an in-memory `fs`, two local modules
  (`muse_bridge.cjs` header). Everything else throws `require-refused`.
* The pinned modules contain **no** `eval`, `new Function`, `import()`, dynamic `require`,
  `child_process`, `Proxy` or `Reflect` use (grep of `config/Muse-Reasoning{Governor,Runtime,Activity,Signals}.cjs`;
  the only `require`s are the fixed `node:*` and sibling modules; `Signals` imports `node:module` for
  the DSH tool-registration path, which the adapter replaces with a throwing stub).
* The worker is not given a Kernel/Registry handle, a credential path, or any broker path. The
  existing Controller bridge (`pipeline.rs:36-50`) is the same Node binary, same uid, also
  `env_clear`ed (plus `PATH`), and is given the Registry/data-root arguments and issuer-side
  authority. **The worker is strictly less privileged than a component the broker already runs.**

## A.2 Question 1 — does same-UID access expose broker-owned state or credentials?

**Yes, in principle, to code running inside the worker process; no, as the worker is built.**

Measured with a probe run under the bundled Node 24.18.1 as the broker's uid:

| Operation inside the Node process | no flags | `--permission` (deny-all) |
|---|---|---|
| read a 0600 file of the same uid (stand-in for `engine-state.key`, issuer cap, credentials) | **allowed** | `ERR_ACCESS_DENIED` |
| read `/proc/self/environ`, `/etc/passwd` | allowed | denied |
| write a file | allowed | denied |
| `child_process.execSync('id')` | **allowed** (`uid=1000`) | denied |
| `worker_threads`, native addon (`process.dlopen`), inspector, `process.binding('fs')` | worker/binding allowed | **denied** (addon `ERR_DLOPEN_DISABLED`) |
| TCP/UDP socket creation, DNS | allowed | **allowed** |

Consequences:
1. Without a flag, any code execution in the worker is a **broker-equivalent compromise**: the
   broker's state directory (`engine-state.key` 0600, run records, the issuer capability file, the
   credentials file, transcripts) is readable by the same uid.
2. The Node permission model closes the filesystem and process-spawn halves with no code change
   to the worker; **the network half stays open** (it can connect to a socket it can name). With
   the filesystem denied, there is nothing in the process to exfiltrate and no capability file to
   present to the Kernel daemon, but this is a mitigation, not a sandbox.
3. The worker script runs **unchanged** under `--permission` on both Node 24.18.1 (bundled) and
   26.10.0 (system), with the same results as without, and a request cost of 3.04 vs 3.20 ms in the
   Python-driven harness (no measurable overhead).

(Node documents the permission model as a safeguard against accidental access rather than a
sandbox for hostile code; treat it as defence in depth, which is what §A.8 recommends. I did not
re-verify that wording against the Node 24 documentation in this session.)

## A.3 Question 2 — can untrusted model signals reach dangerous Node functionality?

**No path exists in the current code; verified in three layers.**

1. *Free model text never enters the worker.* The `evaluate` arguments built in
   `engine/muse_v1.rs:530-545` (Governor) and `:675-684` (signals) are: the engine's own Muse
   blocks (validated by `valid_reasoning_block`/`valid_activity_block`, `muse_v1.rs:386-482`, closed
   key sets, bounded integers/booleans, `family ≤ 64`), `authorized_efforts` (Registry), trusted
   observations (`kind`, outcome, `family`), and the signal object. The signal passed through
   `signals.rs::validate` (`:87-140`): ≤ 1,024 bytes, only the nine allow-listed fields, `phase`
   must be one of seven names after ECMAScript trim/lowercase, flags must be `true`/`false`. The
   one model-influenced string left is the verification `family`: the first whitespace-delimited
   token of the command summary, filtered to `[A-Za-z0-9-_.]`, ≤ 32 chars (`inspect.rs:1747-1763`).
2. *The historical validators refuse everything else, even if Rust were bypassed.* I drove the real
   worker directly (skipping the Rust validator) with `{"__proto__":{"polluted":true}}`,
   `{"constructor":{"prototype":…}}`, `{"phase":{"toString":"x"}}`, a 500,000-character phase,
   non-boolean flags, `phase` with `\0`, and a state block carrying an own `__proto__`. Every signal
   was refused with `signal-unknown-field` / `signal-invalid-phase` / `signal-invalid-field`
   (`Muse-ReasoningSignals.cjs:135-190`: `Object.keys` + allow-list, no property lookup by
   model-controlled name). After those 8 hostile requests plus 12 responses, a snapshot of
   `Object.getOwnPropertyNames` of `Object.prototype`, `Array.prototype` and `Function.prototype`
   was **identical across all 12 responses** and the next fresh request returned a byte-identical
   answer to the first (no prototype pollution, no residual state).
3. *The adapter surface.* The only model-adjacent lookup in the adapter is
   `Object.prototype.hasOwnProperty.call(SEMANTIC, ev.op)` where `ev.op` is a Rust constant
   (`muse_bridge.cjs`), and request validation in the worker (closed op regex `^[a-z][a-z-]{0,31}$`,
   closed key sets, `args` an object).

Remaining theoretical vector: a memory-safety bug in V8/Node triggered by attacker-chosen JSON.
The attacker-influenced JSON is, per above, enumerations and booleans of bounded size, so the
attack surface is the JSON parser on Rust-generated documents; the realistic mitigation for that is
keeping Node patched (§A.8, condition 5) and the permission flag.

## A.4 Question 3 — is the current isolation sufficient under an explicit threat model?

| # | Adversary / event | In scope | Current control | Sufficient? |
|---|---|---|---|---|
| T1 | Untrusted model output (signals, tool args, text), hostile repository content | yes | Rust validation, enumerations only, pinned modules, closed adapter | **yes** |
| T2 | Corrupted or forged worker output | yes | strict envelope, digests, `valid_*` blocks, host `check_transition`/`fold_signal`, durable-before-ack | **yes** |
| T3 | Worker crash, hang, partial/duplicate/replayed frames, restart storms | yes | supervisor (matrix rows 1–25) | **yes** (§A.7 for exactly-once) |
| T4 | Resource exhaustion by a run | yes | bounded frames/queue, ≤4 callers, restart limit, timeout, heap cap | **partly**: RSS not bounded by the heap cap (§A.6) |
| T5 | Supply chain of the Node binary or of `config/Muse-*.cjs` | operator | `trust::resolve_node` (owner/permissions of the path chain, `trust.rs:47-67`); embedded sources + digest handshake; byte-equality test against `config/` | **yes** for sources; Node binary = same trust as the Controller bridge |
| T6 | A vulnerability in V8/Node reachable by crafted JSON | residual | enumerated inputs; permission mode | **acceptable with condition 1 and patching** |
| T7 | Other-uid local users | yes | no new file, socket or path is created by the worker; descriptors verified (no sharing) | **yes** |
| T8 | Same-uid hostile process | out of scope | the uid *is* the principal | n/a |
| T9 | Hostile Node binary or hostile `config/` | out of scope | operator custody | n/a |

Conclusion: under T1–T3 and T5–T7 the **IPC-level** isolation is sufficient. It is not an OS
boundary, and §A.2 shows exactly what the difference is; the single cheap control that narrows it is
the permission mode.

## A.5 Question 4 — is a bounded OS sandbox, separate UID, landlock or namespace required?

**Not required for activation.** Reasons, from the code and measurements:

* The incremental risk is tiny: the worker adds no new *class* of exposure over the existing
  Controller bridge (A.1), whose inputs are broader and whose authority is greater.
* No model-controlled data reaches a code-execution surface (A.3).
* *Separate UID*: needs privileged installation, breaks the per-user Desktop install model, has no
  Windows analogue, and the broker would need a way to start processes as another uid.
* *Landlock / seccomp / namespaces*: Linux-only. The repository already has a mature Linux sandbox
  (`nexus-tools/src/sandbox.rs`: bubblewrap, user/PID/net namespaces, seccomp, cgroup-v2) but it is a
  **run-to-completion tool executor with systemd-scope resource accounting** (§D shows that scope
  creation is exactly the flaky primitive behind the one failed battery test). Reusing it for a
  persistent stdio worker would couple Muse reasoning to that primitive, add failure modes and add a
  second execution architecture, which you asked not to introduce.
* The Node permission model covers the dominant risks (read/write of broker state, process spawn,
  native code, inspector, worker threads) identically on Linux, macOS and Windows because it is part
  of Node itself.

An **optional**, Linux-only later hardening, not a gate: run the worker under `prlimit`
(`RLIMIT_AS`/`RLIMIT_NOFILE`) via `pre_exec`, and/or add a landlock ruleset with no allowed paths.
Both are small, but each is platform code with its own failure modes and neither adds protection
beyond the permission mode for this threat model.

## A.6 Questions 5 & 6 — smallest safe mitigation, concurrency and memory

**Mitigation (all three are one-line argv changes plus a self-check):**

1. `--permission` with **no** `--allow-*` flags. Self-check: the worker reports in `ready`
   whether `process.permission` exists and `process.permission.has('fs.read','/')` is `false`; the
   supervisor refuses a worker that does not (`bridge-protocol`). A Node without the flag exits at
   start-up (unknown option), which the supervisor already maps to `bridge-failed`, so an old Node
   **fails closed** to the existing engine fallback (shadow records the error, signals "not
   recorded", the adaptive engine keeps the pinned effort). Stable name needs Node ≥ 23.5; the
   bundled runtime is 24.18.1.
2. Memory flags `--max-old-space-size=48 --max-semi-space-size=2` instead of `--max-old-space-size=96`.

| Flags (bundled Node 24.18.1, 6,000 requests, same workload) | RSS | median / p95 / p99 (Python-driven round trip) |
|---|---|---|
| `--max-old-space-size=96` (current) | **208 MiB** | 1.17 / 2.04 / 2.99 ms |
| `--max-old-space-size=48 --max-semi-space-size=2` | **79 MiB** | 1.40 / 2.51 / 3.61 ms |
| `--max-old-space-size=48 --max-semi-space-size=4` | 81 MiB | 1.39 / 2.43 / 3.35 ms |
| `--max-old-space-size=32 --max-semi-space-size=2` | 78 MiB | 1.42 / 2.48 / 3.24 ms |
| `--max-old-space-size=32 --max-semi-space-size=1` | 77 MiB | 1.61 / 3.37 / 5.15 ms |

   Choose `48 / 2`: −62 % RSS for +0.2 ms. Stability: with `32/1` the RSS was 75 → 77 MiB between
   1,000 and 10,000 requests on Node 24 and 71 → 70 on Node 26 (flat), so no recycling is needed.
3. **Concurrency.** The broker already admits at most `max_active` unfinished runs
   (`server.rs:557`; default **8** with `--interactive-profile`, **2** otherwise, `main.rs:461-467`),
   and there is no upper clamp on `--max-active`. `MAX_LIVE_WORKERS = 16` (`worker_bridge.rs:54`)
   is therefore a backstop that is never reached by default. Recommendation: construct the
   supervisor limit from the configured `max_active` (cap = `min(max_active, 16)`), so the memory
   ceiling is `max_active × ~80 MiB` (≈ 0.64 GiB at 8, 0.16 GiB at 2) instead of an independent
   constant, and document that `--max-active > 16` makes adaptive runs beyond the 16th fall back
   (`bridge-busy`) rather than start a worker.

## A.7 Question 7 — can crashes, retries, cancellation or partial IPC violate exactly-once state transitions?

**No, for the transitions that matter; one audit-labelling defect (E-1) and one unreachable
double-count path were found.**

Semantics (source-verified):

* *Authority.* The worker is a pure function of its arguments; only the host's validated, durable
  commit changes state. `EngineHost::consult_signal` (`engine/mod.rs:756-815`) checks proposal id,
  revision, `KeepPinned`, ack bound, then `admit_next_state` (the same `check_transition` as every
  proposal, with `fold_signal` re-deriving the historical transition); `EngineRun::consult_signal`
  stages and commits `signal-accepted` **before** returning the acknowledgement
  (`engine_state.rs:580-602`).
* *Frontier before call.* `take_signals` sets `s.signals_through = newest` **before** calling the
  evaluator (`muse_v1.rs:685`) and records `last_unapplied` on any failure (`:723`). So a signal is
  evaluated **at most once by the engine** and can never be applied "later behind the model's
  back". The supervisor's single transparent retry happens *inside* `call`, before the engine sees
  anything, and a retried request is a re-computation of the same pure function (proven equal in
  `signals_tests`: crash-once ⇒ identical state, applied once).
* *Duplicates.* A replayed delivery has the same Core-computed dispatch key
  (`signals.rs:193-199`); the processed-id window travels in the state
  (`processedSignalIds`, FIFO 100), so the second delivery is `duplicate:true` and changes nothing.
* *Cancellation / timeout / partial frame.* Each ends the worker process (`worker_bridge.rs`
  `call`: `inner.proc = None` on every transport failure) and returns an error code; the engine
  reports "not recorded"; nothing is applied. A response arriving after a kill is impossible
  (process dead, pipes closed). An unsolicited or duplicate frame is a protocol violation, not an
  answer (checked before every send).
* *Governor evaluation* is read-only with respect to authority: a lost/failed evaluation
  yields `KeepPinned`; the attempt then runs at the effort in force, which the Registry/Kernel have
  already authorised.

Findings:

* **E-1 (audit, Medium).** `EngineRun::consult_signal` appends the event `signal-accepted` for
  *every* `Ok` from the host, including an acknowledgement `{"ok":false,"recorded":false}` (bridge
  failure, refused signal, stale signal): `engine_state.rs:597-600` is unconditional. The event
  therefore reads as "accepted" when the signal was *not recorded*. No state is wrong, but the audit
  trail is misleading and C2 will rely on events to justify effort changes. **Fix before activation:**
  event kind `signal-handled` (or keep the kind and set `detail = "applied" | "duplicate" |
  "unrecorded:<code>"`) with the dispatch key; add a test that an unrecorded signal never produces
  `applied`.
* **E-2 (defence in depth, Medium).** `EngineHost::accept` admits `EffortProposal::Change(level)`
  where `level` equals the effort already in force (`engine/mod.rs:645-670` checks authorization,
  Finish and `may_propose_effort`, not equality); the result is a new `EffortSelection`, the host's
  `effort_selection() != before` test fires, and `EngineRun::consult` commits a new
  `effort-selected` event (`engine_state.rs:552-572`). Today only `test` engines can do that. The
  limiter must never emit it, **and the host must refuse it** (`engine-effort-noop`) so a buggy
  engine cannot spam durable events or Registry issuances.
* **No double application path exists** between worker answer and durable commit: a broker crash
  there loses the *run's* in-memory signal observation, not a durable state (the continuation is a
  new generation; EM-04B recovery matrix), and the worker holds nothing.

## A.8 Recommendation

**Retain the current trusted-worker model, with these conditions, all small and none a new
architecture:**

1. **Deny-all permission mode** (`--permission`) + startup self-check + fail-closed behaviour on old
   Node (§A.6). Acceptance: `W the_worker_denies_fs_process_and_addon_access`, `W a_node_without_the_permission_flag_is_refused`
   (§ plan, step W1).
2. **Memory flags** `--max-old-space-size=48 --max-semi-space-size=2`; acceptance: RSS ≤ 100 MiB after
   10,000 requests on both Node 24.18.1 and 26.x (release, test marked ignored/measurement).
3. **Worker cap derived from `max_active`.**
4. **E-1** (event labelling) and **E-2** (host rejects no-op `Change`).
5. **Operational:** Node ≥ 23.5 (stable `--permission`) for the adaptive mode; patch policy for the
   bundled Node recorded with the runtime packaging; document that the permission mode is a safeguard
   and not a sandbox and that the network is not restricted by it.

Not required: separate UID, landlock, namespaces/bwrap, another supervisor. Revisit if (a) the worker
ever receives free-form model text, (b) it gains any capability beyond frames, or (c) the product
targets multi-tenant brokers.

## A.9 Windows / macOS compatibility of the recommendation

* `--permission` and the memory flags are Node-level, identical on all three OSes.
* The supervisor itself is portable `std::process` code, **except** Unix-only pieces already in the
  broker (`trust.rs` uses `MetadataExt`, the broker uses `libc::kill/flock`); a Windows port of the
  broker is a separate project and does not interact with this worker design.
* No condition above depends on `/proc`, cgroups, systemd or `bwrap`.
* Test-only helpers (`/proc/<pid>/environ`, descriptors) are Linux-gated tests, not product code.

## A.10 Residual risks after the conditions

1. Network access from a compromised worker remains possible (not restricted by Node's permission
   model); mitigated by absence of secrets in the process and fs/spawn denial.
2. A V8 vulnerability reachable through the JSON parser; mitigated by patching and enumerated inputs.
3. DoS inside a run budget: a request making the historical modules slow is bounded by the 10 s
   timeout, one retry for crashes only, and the restart limit (6/60 s).
4. The permission model's own limitations (it can be bypassed by code that finds a hole in Node);
   hence "defence in depth", not "sandbox".
