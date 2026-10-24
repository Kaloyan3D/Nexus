# Nexus Adaptive v1 — owner hands-on findings and focused fixes

Baseline: Phase 2 (`4acc3a0`, docs `8d45324`). Fix commit: **`2529361`** (local; no push, no merge, no deployment).

## 1. Working functionality (owner-observed; preserved, not touched)

Tests 1, 2, 3 and 5 passed in full; Test 4 verified working-copy preservation and ordinary same-thread continuation.
Authenticated engine records, medium → high → medium effort selection by the host limiter, tool execution/edits,
read-only enforcement, memory and same-thread continuity were all observed. None of that code was changed except
where listed in §3.

## 2. Findings, root causes

### A. "No Resume button" (High)
* **What the code actually did.** The Phase 2 Resume button exists and, rendered against the owner's REAL Test 4
  thread data (`thr_4c54…`, run 1 cancelled), it appears (reproduced by feeding the real `thread show` JSON to the
  current UI in the in-app browser through a mocked Tauri bridge, and in a vitest). So the defect was **not** a
  missing component or a wrong visibility rule for that data. I could not reproduce "absent"; what I did find:
  1. It was a small, secondary-styled "Resume" between the engine disclosure and the step list, with no
     explanation — easy to overlook next to the prominent Cancelled badge, and not what a person reads as the
     way to continue.
  2. Its visibility was decided in the browser from a hard-coded list of run states, not from the broker, and
     a run that could not be resumed gave **no reason** (the owner's requirement).
  3. I cannot prove what the owner's window rendered (their session was launched at 12:01 and served the new
     bundle; I did not see their screen). The honest statement is: the control existed but was not discoverable and
     not broker-driven; whether it was literally absent in their window is **unverified**.
* **Backend facts.** `intent-resume` is eligible only for a terminal, non-completed run of an interactive coding
  session, not already continued, with a recorded task/working copy/model/route, and — for a thread — only when it is
  the conversation's newest run with nothing active (`may_continue`). That is why typing "resume" worked as an
  ordinary message but a run that has a newer run can no longer be resumed.
* **Typing "resume" is not a resume.** It starts a new run from the conversation memory and the retained working copy
  (valid, and what Test 4 verified). It does not call `intent-resume`, so it neither links the run as `continuedAs`
  nor inherits the predecessor's engine state through the resume path. The new tests exercise the real one.

### B. Repeated "refused" `muse_update_reasoning_state` (Medium)
* **Root cause: a Desktop labelling bug, not refusals.** The durable run records show these calls as
  `status: executed` (3 in Test 2, 5 in Test 3, 5 in Test 4 — exactly the owner's counts) and the engine record has
  matching `signal-handled … applied` events. `describeStep` (`lib/progress.ts`) only knew read/write/command tools;
  every other tool fell through to "`<tool> refused`", including accepted calls.
* **Contract, as observed.** The Adaptive catalog (digest `5f7d19e2…`) deliberately advertises the signals tool. A
  call is a model-authored *claim* (phase, findings); the host validates it, the engine records it, and the effort
  is chosen by the host limiter/Registry (`limiter:up`/`down-confirmed` events precede each `attempt-bound`). The
  model never sets an effort, and forbidden fields are refused with a code. No authorization was weakened.
* **Cost.** Each call is one tool call within a model turn (5 of 17 in Test 4); no escalation or limit is consumed.
  Reducing the model's use of the tool would be a prompt/catalog change to Adaptive — deliberately out of scope.

### C. "Cancelled" next to "Tests passed · exit 0" (Low/Medium)
* **Root cause:** the badge reports the last test command's recorded verdict (true: it passed before the user
  cancelled) with wording that reads as the task's outcome.

## 3. Fixes

* **Broker** (`nexus-broker/src/server.rs`): the eligibility rules were extracted from `resume_run` into one
  `resume_blocker`, used by `intent-resume` **and** by a new read-only verb `intent-resumable`
  (`{resumable, code, reason}`). Same rules, no new authority; `intent-resume` behavior is unchanged.
* **Client/Tauri:** `intent_client::resumable`, command `run_resumable` (allow-listed, capability + permission file).
* **Desktop:** new `ResumeControl` — asks the broker; if eligible shows a primary **"Resume this run"** with a
  one-line explanation and calls `intent_resume(<this run id>)` (never a chat message); if not, shows
  "Cannot be resumed: <broker reason>". Shown only for the newest, terminal, non-completed run.
* **Desktop:** `describeStep` shows accepted signal calls as "Reported reasoning state (…)", non-accepted ones as
  "Reasoning-state report not accepted (code)", other executed tools as "Used <tool>"; genuine refusals still say refused.
* **Desktop:** on a **cancelled** run the badge reads "Last test command passed/failed · exit N" with a tooltip
  that the run was cancelled before finishing. The recorded evidence is unchanged.

## 4. Tests actually executed (on `2529361`)

| Check | Result |
|---|---|
| New E2E `p2_a_cancelled_adaptive_run_is_resumed_natively_with_inherited_engine_state` (mock provider, adaptive engine, real broker) | PASS: a live run answers `not-terminal`; after cancel the broker answers resumable; real `intent-resume` completes on the same route/model; engine `nexus-adaptive-v1`, mode `engineering-v2-adaptive`; engine record authenticated with `lineage.inherited = true`, `predecessorRun` = the cancelled run; afterwards `already-continued`, a second resume is refused; a completed run is never offered |
| Vitest (new): real Resume click calls `runResumable` + `intentResume(run 3)` and NOT `threadSend`; broker refusal shows its reason and no button; cancelled-run label; step labels | PASS |
| Desktop vitest / tsc / eslint | 171/171; clean |
| Rust workspace battery (`NEXUS_REQUIRE_SANDBOX=1`) | 1247 passed, 0 failed, 57 ignored |
| Tauri tests (separate target dir) | 27 passed, 1 ignored (+2 ignored live smokes) |
| fmt; strict clippy (workspace all-targets, Tauri all-targets) | clean |
| Release gate with `--bodies` | PASS (registry-js 22/22, engines 148/0, e2e 36/0, production 14/0, release binaries, desktop-binary; bodies: 1170, identical 1076, volatile 88, order-only 4, polling-only 2, **unexplained 0**) |
| Real data in the browser (mocked Tauri bridge, real thread JSON) | Resume rendered, clicking it issued `run_resumable` then `intent_resume` |

## 5. Not verified

* **The Tauri window itself** was not driven (the browser run used a mocked bridge over the real data). The button
  has not been seen in the real window by me.
* Cancelling a REAL OpenCode Go run and resuming it from the Desktop was not re-run (no new paid inference); covered
  by the mock-provider E2E and by Phase 1's CLI interrupt/resume.
* Linux only; macOS/Windows unverified. R74 (issue #35) not fixed. `xhigh` still never observed.
* The running `npm run tauri dev` session rebuilds when `src-tauri` sources change; restart it to be sure it runs
  the fixed binary.

## 6. Targeted owner retest (do NOT repeat Tests 1, 2, 3, 5)

1. Stop the Desktop and start it again: `cd ~/Projects/Nexus/apps/nexus-desktop && NEXUS_HOME=$HOME/.nexus-interactive-dev npm run tauri -- dev`.
2. Open the project; start a **new** conversation, *Make changes*, run the Test 3 task (fix `median`/`min_max`).
3. After a few steps press **Stop**. Wait for **Cancelled**.
4. Look at the cancelled run: expect a purple **Resume this run** button with "Continues from this run's work in a
   new run (not a new chat message)" directly under the run's badges, and the green badge reading
   **Last test command passed** (only if a test already passed) rather than "Tests passed".
5. Press **Resume this run** (do NOT type a message). Expect a new run in the same conversation, "Nexus continued the previous run automatically", an
   Engine section for it, and no repeated fixes.
6. Back on run 1 expect "Cannot be resumed: this run was already continued as …".
7. Expand a run's steps: signal calls should read **Reported reasoning state (phase=…)**, not "refused".
8. Report anything different, including if the button is still absent (then send a screenshot of the run block).
