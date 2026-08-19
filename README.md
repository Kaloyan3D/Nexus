# A.R.T.H.U.R. — AI Harness

A Windows-first local engineering harness that combines a ChatGPT/Codex lead
model with DeepSeek workers, or can run in a strict DeepSeek-only mode. Runtime
dependencies and Node.js are downloaded from pinned versions during setup; no
API keys, OAuth tokens, sessions, logs, or generated runtime files belong in
Git.

## Requirements

- Windows 10/11 and PowerShell 5.1 or newer
- Internet access during installation
- A DeepSeek API key
- Optional: a ChatGPT plan/account with Codex access for Normal Engineering mode

The ChatGPT subscription and an OpenAI API account are different billing paths.
For subscription access, sign in with ChatGPT in the browser flow. Do not enter
an OpenAI Platform API key unless you intentionally want usage-based API billing.

## Quick start after cloning

Open PowerShell in the cloned repository and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

The setup script will:

1. install the pinned portable Node.js and npm dependencies into
   `C:\AI-Harness`;
2. ask for `DEEPSEEK_API_KEY` with hidden input and store it in a local,
   user-protected credential file;
3. open a browser login for the current user's own ChatGPT/Codex account;
4. add `C:\AI-Harness\bin` to the user's `PATH` and run offline checks.

Open a new terminal after setup. From any project repository, run:

```powershell
aih
```

Useful setup options:

```powershell
# Install dependencies now, configure credentials later
.\setup.ps1 -SkipDeepSeekLogin -SkipOpenAiLogin

# Do not modify the user PATH
.\setup.ps1 -SkipPathUpdate
```

Configure or replace credentials later with:

```powershell
aih-key   # DeepSeek API key; hidden input
aih-auth  # ChatGPT/Codex browser login
```

Every user must run these commands with their own accounts. Never copy another
person's `.codex\auth.json`, `data\.credentials.yaml`, or `.env` file.

## ChatGPT/Codex OAuth details

Normal Engineering uses the third-party `openai-oauth` npm package to expose a
loopback-only OpenAI-compatible endpoint at `http://127.0.0.1:10531/v1`. The
package uses the current Windows user's Codex-compatible auth file. Its login is
interactive and opens a browser; credentials are never written into this
repository.

Keep the proxy bound to `127.0.0.1`. Binding it to a LAN/public interface would
let anyone who can reach the port use the authenticated account's quota.

OpenAI's official Codex login can also be checked or cleared with an installed
Codex CLI:

```powershell
codex login status
codex logout
```

## Modes

### Normal Engineering (default)

```powershell
aih
# equivalent:
aih -Preset normal
```

Uses GPT-5.6 Sol xhigh as Tier 1 and semantic completion verifier, DeepSeek V4
Flash MAX as Tier 2, and DeepSeek V4 Flash High as Tier 3. Native Codex
delegation is opt-in with `-EnableCodexSubagent`.

### DeepSeek Only

```powershell
aih -Preset deepseek
```

Uses DeepSeek V4 Pro MAX as Tier 1 and semantic verifier, with Flash MAX/High
workers. This mode blocks OpenAI/Codex inference routes and fails closed if the
required DeepSeek provider or credential is unavailable.

In the Web UI, select **Normal Engineering** or **DeepSeek Only** on a blank/new
session before submitting a task.

## Diagnostics and tests

```powershell
aih-doctor -Offline              # local configuration only
aih-doctor -Preset normal        # live OpenAI OAuth + DeepSeek readiness
aih-doctor -Preset deepseek      # live DeepSeek-only readiness
aih-test                         # deterministic test suite
aih-test-tiers                   # small live model probes (may consume quota)
aih-stop                         # stop the tracked harness process
```

Completion is preset-aware:

```powershell
aih-complete -Preset aih-engineering ...
aih-complete -Preset aih-deepseek ...
```

Both modes require deterministic project verification, evidenced acceptance
criteria, and a Tier 1 semantic `PASS`. Workers never receive completion
authority.

## Repository layout

- `bin/` — user-facing command wrappers
- `scripts/` — installer, launcher, routing, completion, and diagnostics
- `config/` — version pins, model providers, presets, and routing policy
- `runtime/package*.json` — reproducible npm dependency manifest
- `tests/` — deterministic PowerShell and JavaScript tests
- `app/`, `data/`, `logs/`, `runtime/node/` — generated locally and ignored

## Updating and contributing

Run `aih-update` from an updated checkout to reinstall the pinned source files
and dependencies. Before pushing a change, run `aih-test` and verify that
`git status --ignored` shows credentials, session data, logs, `node_modules`, and
portable Node under ignored paths.

This repository is currently marked `UNLICENSED` in its package manifest. Add an
explicit license before making it public if you want others to have permission
to copy, modify, or redistribute it.
