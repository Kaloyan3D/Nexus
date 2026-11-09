# Nexus demo install (alpha)

A separate Nexus install for the demo. It runs on port **3090** and never touches the real Nexus (3080) or the test install (3081).

- Built from the working tree of `feature/nexus-plugin-first-p1` (uncommitted).
- Its DSH carries the PoC `gateway/authorize` build (fingerprint `12e5577b…`), so CLI task submission is **active** here. On standard DSH that protection is missing and `submit` stays off.
- **Demo only:** it is a modified DSH build. Don't use it for real work.

## One-time setup: credentials

Muse (`engineering-v2`) needs `OPENCODE_API_KEY`. DSH stores keys per install in `~/Nexus-Demo/root/data/.credentials.yaml`. The GUI's **Models** page writes that file, and every host start reads it. `demo/alpha/build-demo.sh` keeps it across rebuilds. Three ways to set the key:
- **Once, in the GUI:** start the host, open the printed URL, go to **Models**, store the key, then restart the host.
- **Copy your real install's file:** copy `<your real Nexus install>/data/.credentials.yaml` to `~/Nexus-Demo/root/data/.credentials.yaml` (keep it `chmod 600`). This brings all the keys from your real Nexus.
- **Per start:** `OPENCODE_API_KEY=... nexus-cli.cjs host start ...`.

Dual (`engineering-v1`) needs OpenAI OAuth (`aih-auth`) and a Dual profile preference. This install's preference is a Muse profile, so `nexus modes` shows `engineering-v1` as not submittable (`mode-profile-unresolved`). Demo with Muse.

## CLI for Arthur Studio

Run Node with the entrypoint and an argument array. No shell is needed.

```
NODE=~/Nexus-Demo/root/runtime/node/bin/node
CLI=~/Nexus-Demo/root/scripts/nexus-cli.cjs
```

| Step | Command | Success |
|---|---|---|
| Start Nexus (reuses a running host) | `$NODE $CLI host start --mode engineering-v2 --json` | exit 0, `data.ready: true`, `data.url` |
| Register the project folder (once) | `$NODE $CLI workspace add --path <dir> --json` | exit 0, `disposition` registered/existing |
| Submit a task | `$NODE $CLI submit --workspace <dir> --mode engineering-v2 --prompt "<text>" --idempotency-key <unique> --json` | exit 0, `data.taskId` (`nt_…`) |
| Submit and follow to the end | `$NODE $CLI run --workspace <dir> --mode engineering-v2 --prompt "<text>" --json` | exit 0 completed, 5 failed, 6 cancelled, 7 waiting/held |
| Status / result | `$NODE $CLI status <taskId> --json` · `result <taskId> --json` | exit 0 / see exit codes |
| Wait | `$NODE $CLI wait <taskId> --timeout 10m --json` | as `run` |
| Approve a tool request | `$NODE $CLI respond <taskId> --request <actionId> --choice allow-once --revision <rev> --json` | exit 0 |
| Cancel | `$NODE $CLI cancel <taskId> --json` | exit 0 |
| Host status | `$NODE $CLI host status --json` | exit 0 when ready |
| Which keys are set | `$NODE $CLI credentials list --json` (or `list NAME...`) | `configured` true/false; values are never returned |
| Save a key (stdin only) | `printf '%s' "$KEY" \| $NODE $CLI credentials set OPENCODE_API_KEY --stdin --json` | exit 0, `configured: true` |
| Remove a key | `$NODE $CLI credentials unset OPENCODE_API_KEY --json` | exit 0 |
| Stop Nexus | `~/Nexus-Demo/root/runtime/pwsh/pwsh -File ~/Nexus-Demo/root/scripts/Stop.ps1 -InstallRoot ~/Nexus-Demo/root` | |

Notes:
- `--prompt-file <file.md>` or `--stdin` can replace `--prompt`.
- Reuse the same `--idempotency-key` only to retry the *same* submission. A retry returns the original task.
- Each managed task gets **one** admitted turn.
- A finished turn is not "completed". Completion comes only from the task ledger, so `status` shows `blocked` (`turn-ended-without-ledger-completion`) unless the task completes itself.

## Rebuild after code changes

`sh demo/alpha/build-demo.sh` (from the repo). It replaces `~/Nexus-Demo/root` only and keeps the stored keys; stop the host first.

## Known limits

- A fresh *GUI* Muse session's first turn can fail with "effective route differs from controller target". This is pre-existing on `dev`, and the CLI path is not affected. If it happens in the app, send a second message.
- Not yet proven end to end: restoring a session after an app restart. Avoid restarting Nexus during the demo.
