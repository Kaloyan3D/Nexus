# Nexus Registry — R5 Subscription Connections & Claude Subscription Agent

**Status:** R5 implemented on `feature/model-registry-v1` (connection +
adapter contracts; no execution cutover).
**Baseline:** `22623f2113d02b373ff605bf0860d921b2b8e927`.
**Suite:** `tests/RegistryR5Connections.Tests.cjs` (14 checks, offline,
injected hooks, no credentials, no live CLI required).
**Predecessors:** R0 21/21, R1 45/45, R2 41/41, R3 UI 29/29, R3 hardening
19/19, R4 providers 27/27, R4 transport 19/19, R4 probe security 16/16,
installed runtime 3/3 — all still passing (§9).

R5 reuses the existing ChatGPT/Codex OAuth integration exactly as shipped,
implements the Claude Pro/Max subscription connection through the official
Claude Code CLI lifecycle, and describes the existing OpenCode Go API-key
access accurately — all as non-secret Registry Connection records behind
one unified Connections UI. No R6 execution cutover, no merge.

## 1. What R5 changes (and what it does not)

- **Reused, not rebuilt:** `scripts/Set-OpenAiOAuth.ps1`, `scripts/aih.ps1`,
  the `openai-oauth` runtime, the `sol-local` provider route and the Codex
auth-file lifecycle are byte-identical. R5 only *describes* them in the
  Registry (`subscription-delegated`, local loopback transport) and adds a
  live check that stats the auth file (metadata only) and lists the local
  `/models` endpoint.
- **New:** `config/registry/subscription-connections.cjs` (descriptors,
  live checks, billing guard, narrow CLI adapter), one synthesized set of
  Claude built-ins (provider `claude-code-subscription`, model
  `claude-subscription-agent`, connection
  `conn-claude-code-subscription`, agent route
  `claude-code-subscription/claude-subscription-agent`), a non-secret
  connection-status overlay, three host endpoints, one UI panel, two
  PowerShell scripts plus `Common.ps1` status helpers.
- **Untouched execution:** no DSH routing change, no preset change, no
  Engineering Mode slot change. The Claude route is `availability:
auth-required` with an empty engine scope, so the resolver refuses it in
every mode until R6 controller work lands.

## 2. Codex OAuth vs official delegation (read this first)

The shipped integration is the **third-party Codex OAuth** flow owned by the
`openai-oauth` package (PKCE loopback, Codex-compatible auth file under the
user profile, local service on `127.0.0.1:10531`). It is **not** the
official third-party "Sign in with ChatGPT" delegation. The Registry
records the distinction verbatim in `conn-sol-local.authMethod` and the
Connections UI repeats it, so an operator can never confuse the two.

## 3. Claude subscription design (ten-question review)

1. **Source of truth:** the Claude Code CLI owns credentials, session and
   refresh. Registry records are derived, non-secret, re-derivable.
2. **Ownership:** only `claude login/logout` writes auth state. Nexus
   writes only the non-secret status overlay and operator catalog records.
3. **Dependency direction:** `subscription-connections.cjs` depends on
   `schemas.cjs` only. `probes.cjs` and `runtime-projection.cjs` are
   untouched — `agent-sdk` is not a raw-model transport, and no
   OpenAI-compatible Claude proxy was invented.
4. **Service boundaries:** hook surface is `{ statMeta, execFile,
   fetchJson, spawnEvents }`. There is deliberately **no byte-read hook**,
   so token content cannot enter Nexus by construction.
5. **Failure semantics:** every live path is bounded (timeout), cancellable
   (AbortSignal), and fail-closed (`claude-cli-missing`,
   `claude-session-missing`, `codex-auth-missing`, `claude-timeout`,
   `claude-cancelled`, `billing-boundary`). Missing CLI/session is a
   diagnosable state, never an exception.
6. **State lifecycle:** CLI session created/destroyed by the CLI;
   overlay entries created by live checks, superseded by newer checks,
   never deleted implicitly; disabled-builtin overlays win over status.
7. **Test seams:** all hooks injected; the R5 suite uses fakes (fake auth
   metadata, fake `/models`, fake CLI stdout, fake spawn).
8. **Migration/compatibility:** additive only. Ids, availability and enabled
   flags of existing records are unchanged; operator manual-input gates
   (subscription kinds, agent execution kinds) stay refused as in R4.
   Rollback is a revert: no legacy file format changed.
9. **Observability:** `getConnections()` (billing source, execution kinds,
   account source, connect/disconnect guidance), `checkConnection`,
   `discoverConnectionModels`, plus `Test-ClaudeConnection.ps1`.
10. **Security:** secret-shape scanning on every result; credential VALUES
    rejected at the host boundary (`secret-material-rejected`, including
    caller-supplied `userHome`/`claudeBin` steering attempts); billing
    guard fails closed when `ANTHROPIC_API_KEY` is set unless the caller
    passes an explicit per-call `allowApiBilling` opt-in.

## 4. Claude CLI contract and verification status

Used surface (declared from public Anthropic documentation): `claude
--version`, `claude login/logout`, `claude --print <prompt>
--output-format stream-json --max-turns N [--model m] [--system-prompt s]
[--resume id] [--permission-mode plan|acceptEdits] [--allowedTools a,b]`.
Session continuity is resume-id passthrough; the adapter tags every event
with the caller task identity and returns the CLI session id. Working
directory is the caller-provided `cwd` of the spawn.

| Capability | Status in this environment |
|---|---|
| CLI installed/authenticated detection | Honest `not-connected` (no binary, no session here); logic covered by fakes (R5 suite) |
| `--version` / `--help` probing | Mocked (fake CLI stdout); **UNVERIFIED against a real CLI here** |
| `--print` stream-json argv shape | Declared from public docs; exercised against a fake spawn; **UNVERIFIED live here** |
| Streaming parse / bounds / secret scan | Verified with synthetic stream-json (R5 suite) |
| Cancellation / timeout / exit codes | Verified with fake spawn outcomes (R5 suite) |
| Billing separation (`ANTHROPIC_API_KEY` guard) | Verified (R5 suite); live behavior **UNVERIFIED here** |
| Real `claude login` / `logout` round-trip | **UNVERIFIED here** (no binary, no subscription); scripts wrap the native commands without handling tokens |
| Agent SDK (`@anthropic-ai/claude-agent-sdk`)nodejs binding | **Not integrated** (CLI contract only, by design — the SDK shells to the same CLI session; a future host may add it behind the same billing guard) |
| Linux / Windows install paths | Helpers cover both (`Get-AihClaudeExecutable`); executed on Linux here; Windows paths **UNVERIFIED here** |

To verify live: install the official CLI, run
`powershell -File scripts/Set-ClaudeSubscription.ps1` (or `claude login`
directly), then `scripts/Test-ClaudeConnection.ps1` and the Registry
Connections panel Check/Discover. No Nexus code handles the token at any
point — confirm with the source credential guard.

## 5. Engineering Mode readiness (EMv1 orchestrator assessment)

Claude is **not** an EM orchestrator in R5, by validated contract mismatch:
an SDK/CLI-managed agent does not expose the raw-model message/tool
continuation contract EMv1 routes require (resolver `singleAgent` slots
require `raw-model`; runtime projection refuses `agent-sdk` as a transport).
Full EM use needs R6 controller changes (agent-turn approval boundaries,
session-scoped tool control, reasoning accounting for managed reasoning).
R5 ships the connection + adapter contracts and marks execution `pending-r6`
in the capability record. No R6 work was started.

## 6. Connections UI contract

`GET /nexus/registry/v1/connections/list` — enriched records (billing
source, execution kinds, account source, connect/disconnect commands,
capability notes, routes using each connection).
`POST .../connections/check { id }` and `POST .../connections/discover
{ id }` — server-side native checks for `conn-sol-local` and
`conn-claude-code-subscription`; 200 diagnostic envelopes, never secrets.
Connect/Reconnect and Disconnect are terminal-assisted commands shown in
the UI (`scripts/Set-OpenAiOAuth.ps1`, `claude login`, `claude logout`)
— they cannot run inside a loopback POST and never cross HTTP.

## 7. Files

- `config/registry/subscription-connections.cjs` (new)
- `config/registry/service.cjs`, `schemas.cjs`, `legacy-import.cjs`,
  `index.cjs` (additive)
- `ui/nexus-controller/lib/registry.cjs`, `index.js`, `client.js`
  (3 endpoints + Connections panel)
- `scripts/Common.ps1` (status helpers), `scripts/Set-ClaudeSubscription.ps1`,
  `scripts/Test-ClaudeConnection.ps1` (new; OAuth scripts untouched)
- `tests/RegistryR5Connections.Tests.cjs` (new), route-count pins updated
  in `RegistryCore`, `RegistryR4Providers`, `RegistryInstalledRuntime`,
  `NexusControllerPanel` (spec change, intent preserved)

## 8. Verification

See §9 for the gate table. Pre-existing environmental failures (unchanged
by R5, reproduced on the pristine baseline): `NexusControllerPanel` late
sections require the `app/` DSH closure absent from this checkout;
`PowerShellPortability` flags a foreign `.claude/worktrees/...` checkout
inside the repo. Real-CLI paths are UNVERIFIED here per §4.

## 9. Gate table

| Gate | Result |
|---|---|
| R5 suite (14) | PASS 14/14 |
| R0 baseline (21), R1 core (45), R2 compat (41) | PASS |
| R3 UI (29), R3 hardening (19) | PASS |
| R4 providers (27), R4 transport (19), R4 probe security (16) | PASS |
| Installed runtime (3) | PASS |
| NexusControllerPanel route pins | PASS (late sections blocked by missing app closure — pre-existing) |
| MuseProvider (33), MuseOpenCodeGo (19), credential guard (14) | PASS |
| PowerShell syntax (3 files) | PASS |
| `Set-OpenAiOAuth.ps1` / `aih.ps1` unchanged | PASS (`git status` clean for both) |
| PR #33 | stays Draft; no merge, no R6, no R7 |
