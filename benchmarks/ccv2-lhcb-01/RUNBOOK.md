# Operator runbook — CCV2-LHCB-01 v1

**The initial implementation task does not execute the live benchmark.** All
implementation checks use temporary fixtures, local codecs and fake transports.
The staged default root has no copied credentials, live session or certification.
The commands below describe future operator work after contract review.

## AutoRunner

Two workflows are supported: AutoRunner and the manual/operator-assisted
fallback described below. Both use the same frozen prompts and existing
benchmark authorities.

The optional deterministic runner is documented in [AUTORUNNER.md](AUTORUNNER.md).
It resumes a proven bound session, submits exact frozen bank prompts through the
installed DSH API, verifies idle/session/memory durability, and orchestrates the
existing checkpoint and three-arm authorities. Use `run-status` for read-only
inspection; live runner commands require both environment keys and current
HEALTHY certification. Implementation tests use injected transport only.

## Prepare and inspect

Use Node 24.18.1 or a newer compatible Node with built-in zstd and TypeScript
stripping, Git with the user's existing identity, and the already installed
pinned Nexus dependencies. No new npm packages or framework are needed.

```sh
node scripts/bench/ccv2-lhcb/cli.cjs doctor
node scripts/bench/ccv2-lhcb/cli.cjs init
node scripts/bench/ccv2-lhcb/cli.cjs status
```

The default root is `~/nexus-bench/ccv2-lhcb-01`. Set `CCV2_LHCB_ROOT` to an
absolute safe path before every command to use another root. Root, home,
normal Nexus installation, repository paths, system directories and symlink
ancestors are refused. Init also refuses nonempty targets. A benchmark marker
binds destructive operations to the exact root. Never reuse a normal runtime.

Init stages frozen source from Git and copies **only** `app/package*.json`,
`app/node_modules`, `runtime/node` and `runtime/pwsh` from the local installed
runtime. It never copies that installation's data, credentials or settings.
It uses the existing preset-closure, UI-patching and preset-validation
scripts to compose the isolated runtime. Unlike the installer's final
permission walker, benchmark permissions do not follow dependency symlinks.
No source or CCv2 behavior is patched. Linux is the currently exercised
runtime-staging platform.

Staging copies the complete approved `app/node_modules` tree, including packages
whose code names contain `credentials` or `secrets`. The mutable-state secret
filename filter is not used for immutable code. Both app manifests must match
the frozen runtime manifests before copying. Links are dereferenced only within
approved dependency boundaries; escapes and cycles fail before copying. Existing
approved destinations are replaced so restaging cannot retain stale modules.

Runtime readiness executes imports with the isolated pinned Node, resolving from
its own `app/package.json`. It checks the Muse provider stack and OC01 runtime
imports with network APIs blocked and an environment without credential values.
Import failures report `dependency-import-failed` and safe package identifiers;
a codec-only filesystem check is not sufficient. Use the pinned Node for the
offline test suite as well.


An alternative dependency source is supported:

```sh
node scripts/bench/ccv2-lhcb/cli.cjs init --runtime-source /absolute/offline/nexus
# Fast scaffolding only; this is NOT a runnable installation:
node scripts/bench/ccv2-lhcb/cli.cjs init --no-runtime
# Resume an incomplete dependency/composition stage:
node scripts/bench/ccv2-lhcb/cli.cjs stage-runtime /absolute/offline/nexus
```

Init explicitly sets production/pressure policy for the read-only pressure-building history. Each final trial still restores the same baseline before selecting its arm. Runtime restaging is refused after experiments exist, and generated compositions are fingerprinted to detect DSH threshold changes.

Doctor reports source guard, dependency/composition readiness, derived
thresholds and certification separately. Source drift produces nonzero exit
and names exact protected paths. Missing certification is expected after
implementation and does not claim live readiness. Settings stay frozen and
credentials must be supplied through existing Nexus mechanisms inside the
isolated installation only. Never print, export, paste into prompts, or
archive credential values. The installed runtime never sees the grader.

Before future live use, the operator must run the existing OC01 canary against
this **isolated** installation and obtain current, identity-matching HEALTHY
certification. Consult the OC01 script's actual interface; it makes provider
calls and is deliberately not run by this harness. Do not copy certification
or credentials from the normal installation. Check doctor again afterward.

A separate plumbing-only check is safe before live certification:

```sh
ROOT="$HOME/nexus-bench/ccv2-lhcb-01/nexus-root"
"$ROOT/runtime/node/bin/node" "$ROOT/scripts/OC01-OpenCodeMuseCanary.cjs" --dry-run-native-tail 1
```

This existing production dry-run uses a scripted localhost upstream and local
counter, needs no credential store, and writes no certification to the isolated
installation. Its expected final line is
`CCV2-OC01 native-tail DRY RUN — PASS (no certification written)`.
It is not the real OC01 provider canary.


## Manual/operator-assisted fallback: build real read-only history

1. Start the isolated runtime using its canonical launcher and the fixture as
   working directory. For example, from `~/nexus-bench/ccv2-lhcb-01/workspace`,
   invoke `../nexus-root/bin/aih` using that launcher's normal GUI interface.
   Check `AIH_INSTALL_ROOT`, `NEXUS_INSTALL_ROOT` and `DSH_HOME` resolve to
   `<root>/nexus-root`, `<root>/nexus-root`, and `<root>/nexus-root/data`.
   Ensure there are no other sessions or writers in that installation.
2. Retrieve T00; stdout is the **exact** prompt and stderr is content-free stage
   metadata. Paste stdout into a new Muse/OpenCode session. Keep all work in
   the fixture workspace. Do not give the agent benchmark/grader access.
3. Stop/flush the runtime and bind the actual durable session path:

```sh
node scripts/bench/ccv2-lhcb/cli.cjs prompt T00
node scripts/bench/ccv2-lhcb/cli.cjs bind nexus-root/data/sessions/WORKSPACE_KEY/SESSION_ID/session.jsonl.zstd
node scripts/bench/ccv2-lhcb/cli.cjs prompt next
# Or request the next stage explicitly:
node scripts/bench/ccv2-lhcb/cli.cjs prompt P01
```

Binding is taken from the real controller's session-bindings and task manifest;
IDs cannot be made up. Stage metadata records expected session, prompt hash,
sequence boundary and workspace hash. Continue P01–P07 in the same session.
After each completed audit, flush/stop before retrieving the next prompt so
its boundary and source-integrity check are reliable. Inspect concise findings;
do not ask for verbosity or padding. Resume the same session after each stop.

4. Seven moderate audits may not reach a pressure band. Continue legitimate
   read-only engineering investigations, or retrieve another audit with
   `prompt P02 --repeat` after the initial seven audits. Each repetition records
   a new boundary with the same frozen prompt. Investigate actual unanswered
   questions; do not repeat already-settled reads to manufacture context.
5. `status` shows the production pressure bound, NATIVE/ACTIVATE decision,
   activation basis/threshold, DSH threshold, certification and snapshots.
   Actual DSH compaction is permitted. Never lower its pressure boundary or
   change the CCv2 gate to reach a checkpoint. CP-OVERFLOW may remain absent.

## Manual/operator-assisted fallback: capture and run matched arms

Snapshot only a stopped, flushed runtime with all tools settled. For the manual
commands below, `--stopped` is an operator assertion; these commands cannot prove
that another process has stopped. They reject out-of-band captures, unexpected
mutable layouts, links or recognizable secrets. A capture must still contain
the unmodified fixture.
Each named snapshot is immutable and cannot be overwritten.

```sh
node scripts/bench/ccv2-lhcb/cli.cjs snapshot CP-500 --stopped
node scripts/bench/ccv2-lhcb/cli.cjs snapshots
node scripts/bench/ccv2-lhcb/cli.cjs restore CP-500 --stopped
node scripts/bench/ccv2-lhcb/cli.cjs arm native --stopped
node scripts/bench/ccv2-lhcb/cli.cjs prompt T99
```

Record the unique `runId` returned by `arm`. Start the same restored session
using the same provider/model and runtime settings. Deliver T99 exactly once
and let the final challenge finish. Stop/flush the runtime. Do not make manual
source fixes to a trial. Collect and grade **before restoring another arm**:

```sh
node scripts/bench/ccv2-lhcb/cli.cjs collect RUN_ID --stopped
node scripts/bench/ccv2-lhcb/cli.cjs grade RUN_ID
```

Restore CP-500 again, start `arm production`, deliver the identical T99, then
collect/grade. Restore again and do `arm forced`. Use the same procedure for
other available checkpoints. All arms must use the same immutable snapshot,
settings identity, fixture, frozen source and continuation prompt. Collection
checks durable provider/model headers and production decisions, not operator
assertions alone. It excludes the inherited pressure-building work from run
accounting. Never collect one trial twice or grade a different workspace.

In this manual fallback, `prompt` prints the frozen prompt for the operator to
deliver; runtime start, stop and durability flush are also operator-assisted.
The AutoRunner workflow instead submits exact frozen prompts through the
installed DSH API and manages runtime lifecycle and durable completion checks.
Live prompt execution can make provider calls in either workflow; implementation
verification uses offline fixtures and injected transports only.

## Review outcomes

```sh
node scripts/bench/ccv2-lhcb/cli.cjs report
node --test tests/Ccv2Lhcb.Tests.cjs
```

`runs/<runId>` contains run/preflight/activation/metrics/result JSON and grade
JSON after grading. Raw transcripts are not copied there. The reports are
`reports/CCV2-LHCB-01.json` and `.md`. Missing values read UNAVAILABLE and have
JSON reasons. Compiler Capability, Production Benefit and Reasoning Continuity
Safety remain independent. NOT_TRIGGERED is expected when natural DSH
compaction prevents production CCv2 activation. Forced without a compiled
request is INVALID. Infrastructure invalidations stay visible and do not count
as CCv2 correctness failures. Do not conceal invalid trials or replace valid
unfavorable trials with favorable repetitions.

## Recovery and limitations

Corrupt snapshots fail before destructive restore. If copying/verification
fails mid-restore, the restore lock blocks further work. Stop the runtime and
rerun restore from a verified snapshot; do not remove the lock manually to
resume a partial experiment. Restore deletes only mapped mutable trees inside
the marked isolated root, preserves credentials and installed dependencies,
and verifies restored hashes. Never move snapshots to a different root: durable
workspace and task identities contain absolute paths.

The grader executes agent-produced code with a stripped environment, timeout
and Node network-API blocker. This is deterministic grading for a cooperative
benchmark agent, not hostile-code containment. Review code if stronger
isolation is needed. General arbitrary secret detection is not possible;
only dedicated credential-free fixture sessions belong in snapshots. Exact
file-read repetitions and first useful edits inside `run_code` remain
unavailable rather than guessed. DSH replacements use the pinned canonical
surface fold around the existing replay. Any replay/telemetry disagreement
requires inspecting the safe evidence; never alter production to make it pass.

No pushes are part of benchmark setup or execution.
