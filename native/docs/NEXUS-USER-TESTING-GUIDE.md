# Nexus Native — owner hands-on testing guide (Desktop + Nexus Adaptive)

Everything here is run by the owner, from the Desktop window. Nothing below needs a Registry JSON
edit. Each observation is tagged:

- **VALIDATED** — seen in a recorded run on this machine (Linux), through the same code the Desktop
  calls (Tauri command → broker → OpenCode Go). Evidence is named.
- **UNVERIFIED** — expected from the design but not yet observed; treat a surprise here as a finding,
  not as a regression.

The GUI window itself has **not** been driven by an automated test (see Phase 2 report). The Desktop
backend commands behind every button have been.

## 0. Privacy note (read once)

The Contributor model's data-use policy permits training on submitted content. Use only the
disposable synthetic repository below (or another repository you are happy to share). Do not point
Nexus at private code with this model.

## 1. Launch

```bash
cd ~/Projects/Nexus/apps/nexus-desktop
NEXUS_HOME=$HOME/.nexus-interactive-dev npm run tauri -- dev
```

The Desktop supervises `nexusd` and `nexus-broker` itself. To use the release build instead, build
it with `cargo build --release --offline` in `apps/nexus-desktop/src-tauri` and run
`target/release/nexus-desktop` with the same `NEXUS_HOME`.

- **VALIDATED**: the supervised runtime starts and the broker answers (runtime start/status, Phase 1/2 runs).
- **UNVERIFIED**: macOS and Windows. Linux only.

## 2. First run (no JSON editing)

1. **Settings → Provider and autonomy**. If OpenCode Go shows *not connected*, press *Connect
   OpenCode Go…* and paste the key into the native dialog (the key is never shown again).
2. Press *Allow autonomous work…* and read the consent text.
3. Under **Engine**, *Nexus Adaptive (recommended)* is the default. If a yellow banner says it is not
   set up yet, press **Set up Nexus Adaptive…**. A native dialog lists the billable provider requests
   (about eight, one per reasoning level and capability) and asks for confirmation. Confirm only if
   you accept the cost.
4. The banner disappears once the provider has answered every check. If a check fails, the banner stays,
   with the reason; nothing is recorded as verified.

- **VALIDATED**: the setup sequence (apply → authorize → verify) against the real route, 8/8 checks, in Phase 1;
  failed verification no longer disconnects the provider.
- **UNVERIFIED**: pressing the button inside the window (the same function ran from the CLI and the
  Tauri backend test); the native confirmation dialog's appearance.

If your machine is already set up (as the owner's `~/.nexus-interactive-dev` is), the banner never
appears.

## 3. The synthetic repository

`~/nexus-test-repos/stats-kit` is a small git repository prepared for these tasks. Add it with
*Open project…* (or `nexus project open`). Each task below runs in an isolated copy; your files are
only changed if you press **Apply** on a finished run.

## 4. Five tasks

For every task start a **new conversation**, leave **Engine = Nexus Adaptive**, and choose *Make
changes* where the task says so. After each run press **Execution evidence** and open the
**Engine** section of the run.

1. **Read-only orientation.** *Review only*: "Read this repository and explain its structure: list each source
   file, what it exports, and which tests exist. Do not modify anything."
   - Expect: an accurate answer, no changed files, run badge *Read-only*.
   - VALIDATED: this exact task completed read-only in Phase 1 (10 turns, 0 edits).
2. **Small targeted change.** *Make changes*: "In src/lib.rs, make clamp robust when lo is greater than hi:
   swap the bounds instead of returning a wrong value. Add a test for it in tests/stats.rs and run only the
   clamp tests with cargo test --offline clamp. Do not touch any other function; two other tests in this
   repo are known to fail and are out of scope."
   - Expect: a 2-edit diff, one test run, the two known failures left alone.
   - VALIDATED: this exact task completed in Phase 1; the patch applied to a clean clone and passed.
3. **Fix failing tests across turns.** *Make changes*: "Two tests in this repository fail (median for an even
   number of items, and min_max for a constant series). Run the whole suite with cargo test --offline, find
   the root causes in src/mean.rs and src/normalize.rs, fix both without changing any test, and re-run the
   whole suite until it passes. Report what you changed."
   - Expect: ~17 turns, edits to the two source files, a passing suite, and (often, not always) a reasoning
     effort rise to *high* after verified failures and back to *medium* after progress, visible in the
     Engine section.
   - VALIDATED: this exact task, three executions; 4/4 tests pass in a clean clone; the effort path
     medium → high → medium was observed each time.
4. **Stop and resume.** Re-run task 3 in a fresh copy of the repository (or a new conversation after the
   earlier changes were not applied), press **Stop** after a few steps, then **Resume** on the stopped run.
   - Expect: the stopped run ends *cancelled*; **Resume** starts a new run that continues from the work;
     its Engine section shows an *effort-reset-continuation* event and inherited earlier engine state.
   - VALIDATED: interrupt/resume with authenticated inherited lineage (Phase 1, via the CLI/broker).
   - UNVERIFIED: the Stop and Resume buttons in the window.
5. **Follow-up in the same conversation.** In the conversation of task 1 send: "List the public functions
   exported by this crate in one short sentence each. Do not modify anything."
   - Expect: the composer shows *Engine: Nexus Adaptive* (no model picker: a conversation keeps the
     engine it started with) and the new run carries the earlier context.
   - VALIDATED: the second message keeps the engine (broker unit tests and the Desktop-backend smoke
     with a second `thread_send`).

## 5. What the Engine section shows (and does not)

It lists the engine, each attempt's reasoning effort and the effort events, read from the broker's
authenticated engine record. If the record cannot be authenticated it says so and shows nothing.

- **VALIDATED**: effort `medium → high → medium` transitions and replay across a transition (HTTP 200) were observed in Phase 1/2 runs.
- **UNVERIFIED**: `xhigh` has never been selected in a task. A run that does not change effort
  shows a single attempt at the default effort — that is normal, not a fault. Do not expect a
  transition in every run.

## 6. Stable / Legacy

Settings → Engine → *Stable (legacy)* makes NEW conversations use `muse-v0`. Existing conversations
and in-progress tasks are never migrated.

- **VALIDATED**: the Stable choice is exercised by the Tauri fake-broker test (see the Phase 2 report for the release gate's historical-body parity result).

## 7. If something looks wrong

- "Nexus Adaptive is not set up yet" → press *Set up Nexus Adaptive…* (or pick Stable). New tasks never start on the other engine silently.
- Provider errors show the error code and a plain reason; keys are never printed.
- `nexus engine status` and `node scripts/Inspect-AdaptiveRun.cjs latest` give the durable facts from a terminal.
- Known open item: R74 root cause is **not** fixed (GitHub issue #35).
