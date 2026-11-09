# Nexus CLI alpha: demo handoff

This branch contains the Nexus "plugin-first" work (phases P1 to P2-B2B, plus part of P2-B2C) and a working **Nexus CLI** that Arthur Studio can drive. Arthur writes an idea as Markdown, sends it to Nexus as a prompt, shows "working..." and then shows Nexus's answer.

Nothing has been deployed, and the real Nexus install is untouched. The demo runs in a separate install at `~/Nexus-Demo` on port **3090**.

## Status (2026-11-09)

**Proven end to end on macOS arm64 with a real model** (Muse / `engineering-v2`):

`idea.md` → `nexus submit --prompt-file` → working... → Nexus built a Pomodoro web app (`index.html` + `README.md`) in 16 s → `nexus status` printed Nexus's final message. Script: `demo/alpha/arthur-run/arthur-flow.sh`.

| Area | State |
|---|---|
| `nexus host start / status` | Works. Starts or reuses this install's host through the existing launcher (`scripts/aih.ps1`). |
| `nexus workspace add --path` | Works. Registers a folder (it must be a git repo) with DSH. |
| `nexus submit / run / status / result / wait / cancel / respond` | Works on a DSH build that carries the `gateway/authorize` hook (the demo install). On standard DSH, `submit` is refused on purpose (see "Security note"). |
| Nexus's last reply in status/result | Works. Human output shows `── Nexus ──`; JSON has `data.reply.text`, and `result` has `data.summary`. |
| `nexus credentials list / set --stdin / unset` | Works. Uses the same store as the GUI Models page (`<install>/data/.credentials.yaml`). Values are write-only and never echoed. |
| GUI task route `/nexus/tasks/v1/<op>` | Same operations as the CLI, for the Nexus web UI. |

## Run the demo

The CLI is called as `NODE=~/Nexus-Demo/root/runtime/node/bin/node`, `CLI=~/Nexus-Demo/root/scripts/nexus-cli.cjs`. Full command table: [USING-THE-DEMO.md](USING-THE-DEMO.md).

1. **Build or rebuild the demo install** (needs the base install at `~/Nexus-DSH-0.2.2-Test/root`, or set `NEXUS_DEMO_BASE`):
   `sh demo/alpha/build-demo.sh`
2. **Start it:** `$NODE $CLI host start --mode engineering-v2 --json`
3. **Save the Muse key once:** `printf '%s' "$KEY" | $NODE $CLI credentials set OPENCODE_API_KEY --stdin --json`
4. **Run the Arthur flow:** `sh demo/alpha/arthur-run/arthur-flow.sh`

## Things the Arthur integration must handle

- **Success signal.** A successful turn ends as `status: blocked` with `statusReason: turn-completed-awaiting-verification`, and the exit code is **7**, not 0. Only Nexus's own verification marks a task `completed`. Arthur should treat `data.turn.reason == "completed"`, or a present `data.reply`, as "done".
- **Failures.** A failed turn shows `status: failed`, `data.turn.error.message` (for example a missing credential), and exit code 5.
- **Approvals.** If Nexus waits for a tool approval, `status` becomes `awaiting_operator` and `data.operatorActions` lists the actions. Answer with `respond <taskId> --request <id> --choice allow-once --revision <rev>`. Otherwise "working..." spins forever.
- **One turn per task.** A task gets exactly one agent turn, and there is no "continue" command yet. Scope each idea to what one turn can do.
- **Muse only.** Dual (`engineering-v1`) needs OpenAI OAuth plus a Dual profile preference.

## Security note (why `submit` is gated)

Standard DSH 0.2.2 gives the owner peer (the local browser or app) full power over every session. While a CLI task runs, the app side could inject prompts, swap the model, or answer approvals in that task's session.

The proposed DSH hook (`docs/architecture/evidence/p2b2b/dsh-gateway-authorize.upstream.patch`, about 90 lines, upstream tests 621/621) lets Nexus refuse that. Nexus verifies the hook at startup by build fingerprint plus a live self-test, and refuses `submit` without it. No flag can bypass the check.

The demo install deliberately uses the patched build (`build-demo.sh` reconstructs it from `dsh-gateway-built.lib.diff` and verifies sha256 `12e5577b…`). It is **demo only**; don't patch a production install. Details: [NEXUS-GATEWAY-AUTHORIZE-COMPATIBILITY-SPEC.md](../../docs/architecture/NEXUS-GATEWAY-AUTHORIZE-COMPATIBILITY-SPEC.md).

## Known issues and next steps

Small CLI gaps (good next tasks):
1. `host start` returns `"url": null` when the host was already running.
2. There is no `nexus host stop` yet (stopping uses `pwsh scripts/Stop.ps1 -InstallRoot <root>`).
3. `workspace add --init`: create the folder plus `git init` plus the first commit, then register it.
4. A simple `data.done` boolean, so integrations don't need to read `turn.reason`.
5. Files written by the agent are owner-only (`0600`).

Bigger items:
- **Session restore after a restart (P2-B2C, in progress).** Two DSH 0.2 format-v4 defects broke cold restore of Nexus sessions:
  - the retired `source.kind: 'plugin'`;
  - a Controller notice written before the first `system/message`.

  Both are fixed in code (`config/Nexus-MessageSource.cjs`; notices are published through the pre-step `enter` decision). The unit suite `tests/NexusSessionDurability.Tests.cjs` passes 7/7. **Not yet proven** by the real-host cold-restart test (`tests/NexusSessionColdRestore.RealHost.Tests.mjs`). For the demo, don't restart Nexus mid-demo. Read-only audit of stored sessions: `scripts/NexusSessionAudit.cjs`.
- **Pre-existing on `dev`.** A fresh *GUI* Muse session's first turn can fail with "effective route differs from controller target": DSH captures the step's model selection before pre-step, and GUI sessions skip Nexus session preparation. The CLI path is not affected (it prepares the session).
- **A "continue task" command** (more than one turn per managed task). This needs a policy change in `config/nexus/managed-tasks.cjs` (admission tickets).
- **Full regression lane re-run** (`scripts/Test-Harness.ps1 -Lane production`) after the P2-B2C and CLI changes. The last full run (P2-B2B) was 117/119, and the 2 failures predate this work.
- **Production `nexus submit`** needs an upstream DSH release with the hook, and the remaining items in §12 of the P2-B2B report.

## Where things are

| Path | What |
|---|---|
| `scripts/nexus-cli.cjs` | The CLI |
| `config/nexus/` | Host Controller: `controller.cjs` (service, gates, routes), `task-api.cjs` (operations), `ipc.cjs` (authenticated local transport), `managed-tasks.cjs` + `intake-store.cjs` (durable task intake), `broker.cjs` (approvals), `gateway-policy.cjs` |
| `config/Nexus-MessageSource.cjs` | DSH 0.2 message-source and ordering rules |
| `docs/architecture/` | Architecture, CLI contract, phase reports P1 to P2-B2B, gateway spec, evidence |
| `tests/Nexus*.Tests.*` | Unit and real-host suites (registered in `scripts/Test-Harness.ps1`) |
| `demo/alpha/` | This folder: demo build scripts, Arthur flow, usage doc |
