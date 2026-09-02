# Setup, testing, and troubleshooting

This guide covers the normal Windows workflow for installing, starting, testing, restarting, and diagnosing Nexus.

## Requirements

- Windows 10/11
- PowerShell 5.1+
- Internet access during installation/update
- DeepSeek API key
- Optional ChatGPT/Codex authentication for independent review
- Git available for repositories/worktree operations

## Install

From a PowerShell prompt:

```powershell
git clone https://github.com/Kaloyan3D/Nexus.git
cd Nexus
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

Then configure providers:

```powershell
aih-key
aih-auth   # optional; independent Codex review
```

Setup installs/composes pinned runtime dependencies and Nexus UI/controller packages. Local credentials, sessions, generated profiles/packages, runtime data, and portable dependencies are not intended to be committed to Git.

## Start Nexus

Launch the universal application from any directory, then choose **Open
Folder** in the UI:

```powershell
aih -Open
```

Optional explicit preselection:

```powershell
aih -Open .
aih -Open C:\path\to\project
```

An already-running Nexus process is reused. The explicit path is handed to the
UI and never becomes a process-global cwd.

Useful lifecycle commands:

```powershell
aih-stop
aih -Restart -Open
```

Prefer a controlled restart only when a restart is actually required. If a restart wrapper times out or its outcome is unknown, first check whether the host already restarted successfully instead of immediately restarting again.

## Diagnostics

```powershell
aih-doctor -Offline
aih-detect
```

Use offline diagnostics first when you want to validate the local installation without consuming provider quota.

Live provider probes:

```powershell
aih-test-tiers
```

These may consume quota.

## Deterministic tests

Primary regression suites:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\Harness.Tests.ps1
node .\tests\NexusControllerPanel.Tests.cjs
```

Additional repository tests may exist for specific controller/runtime paths. Run the smallest relevant suite during iteration and the full deterministic set before a checkpoint that changes controller contracts.

## Verification from Nexus

For a controller-bound task, `/verify` is the GUI-facing deterministic verification command.

The verifier can legitimately return:

```text
valid JSON + exit 0 -> all required checks passed
valid JSON + non-zero exit -> checks ran and at least one failed
```

A non-zero exit is therefore not automatically an infrastructure crash. If the UI remains `verifying` after the verifier already produced a finished result, inspect evidence and attempt state before assuming the process is still running.

## Control Room troubleshooting

### Compact Controller is `UNAVAILABLE`

Check:

1. Nexus host is READY;
2. `/nexus/controller.json?session=<id>` responds;
3. session binding exists;
4. controller package/profile is synced;
5. browser console has no runtime error.

Do not convert endpoint errors into fake `IDLE` state just to keep the UI quiet.

### Control Room detail is missing/stale

Check:

- `/nexus/control-room.json?session=<id>`;
- the bound workspace/task;
- `.ai-harness` attempt/evidence files;
- source-file mtimes/cache invalidation;
- Git availability for the Files tab.

The detailed endpoint is cached; immutable records should remain stable while changed source artifacts invalidate the snapshot key.

### Duplicate Activity rows

Activity should represent semantic lifecycle transitions, not every possible source record.

For verification start:

- prefer the authoritative attempt `verifying` event;
- use `evidence.startedAtUtc` only as a legacy fallback when no verifying event exists.

Reloading the browser must not add Activity rows.

### Verification says FAILED

Compare three layers:

```text
evidence.json
= /nexus/control-room.json verification
= Verification tab
```

If storage is correct but the endpoint differs, inspect the adapter. If the endpoint is correct but the browser differs, inspect `client.js` rendering.

### Verification infrastructure failure

A genuine verifier failure may leave no completed evidence. Reconciliation should close stale verifying state as `interrupted / verification-incomplete` instead of pretending a normal check failed.

## Session/task contamination checks

Task IDs are not globally unique.

Always reason about:

```text
normalized workspace + taskId
```

resolved through the authoritative session binding.

If old routing/review/verification data from another repository appears, inspect adapter joins for task-ID-only matching.

## Profile/package sync

Nexus source UI/controller packages are copied into generated profile `node_modules`. When changing package source, verify the installed/generated copy is re-synced and byte/hash equivalent where the setup/patch flow expects that invariant.

A source change that is not reflected in the active profile can make browser behavior appear inconsistent with the repository code.

## PowerShell encoding

Nexus is Windows-first and PowerShell 5.1 can use legacy implicit encodings.

For JSON/JSONL producer/read boundaries, use explicit UTF-8 where the implementation requires it. If you see corrupted arrows/checkmarks/non-Latin text after restart, inspect encoding at the writer and reader before patching UI display code.

## Line endings

The repository uses `.gitattributes` to control Windows line endings. Warnings such as:

```text
LF will be replaced by CRLF the next time Git touches it
```

can be expected for configured PowerShell files. Do not rewrite unrelated files only to silence a normal line-ending warning.

## Git hygiene

Before committing:

```powershell
git status
git diff --cached
```

Prefer explicit path staging for source changes. Avoid blindly staging runtime/task artifacts with `git add .` or `git add -A` when `.ai-harness` contains execution/test history.

Typical source commits should not accidentally include:

```text
data/
logs/
tmp/
local credentials
browser profiles
runtime session state
acceptance-driver artifacts
unrelated .ai-harness task history
```

## Safe browser acceptance

Acceptance automation may run a dedicated Chrome profile/debug port.

**Never** terminate every Chrome process by image name, for example:

```text
taskkill /F /IM chrome.exe /T
```

That can kill the user's normal browser.

Terminate only the acceptance/browser process tree you spawned and can positively identify.

## Restart safety

When performing a final acceptance restart:

1. record the current host PID/state;
2. request one controlled restart;
3. independently poll for READY/new host state;
4. if the wrapper hangs after the host is healthy, terminate only the wrapper you spawned;
5. verify endpoints and durable state after restart;
6. do not repeatedly restart a host whose prior restart outcome is unknown.

## Security / secrets

Do not copy or commit another user's OAuth/session/credential files.

Local credential files and environment state are protected runtime data. Architecture rule `SEC001` is intended to catch secret-shaped material persisted into source/tool records while allowing explicit placeholder forms.

See [../../SECURITY.md](../../SECURITY.md).

## When to add a regression test

Add a deterministic regression when a bug involved a stable contract such as:

- routing identity;
- workspace isolation;
- attempt idempotency;
- verification exit-code behavior;
- evidence folding;
- gate validation;
- UI activity/verification semantics;
- package/patch idempotency;
- encoding or persistence boundaries.

The goal is to make the same class of bug hard to reintroduce, not merely to reproduce one fixture.
