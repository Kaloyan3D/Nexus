# RC validation evidence (2026-11-07, Linux aarch64 VM, DSH 0.2.2-rc.1)

Final-claim evidence (tested source revision `038c98f9`; see section J of `../../dsh-0.2.x-migration-report.md`):

| File | What it is |
| --- | --- |
| `final-real-harness-production-lane.log` / `.report.json` | real `Test-Harness.ps1 -Lane production`, fresh install of the final tree: 105 rows, 103 pass |
| `final-real-harness-ccv2-lab-lane-source-root.log` / `.report.json` | real `Test-Harness.ps1 -Lane ccv2-lab` on a source-tree root: 81 rows, 68 pass |
| `baseline-0.1.1-rc.2-installed-root-harness.log` | fresh DSH 0.1.1-rc.2 baseline, its own harness, installed root (180 suites) |
| `baseline-0.1.1-rc.2-source-root-harness.log` | same baseline measured from a source-tree root (lab comparison) |
| `auth-sweep-final-tree.json`, `auth-sweep-upgraded-install.json` | 14 routes, 280 checks, 0 failures |
| `ev-gate-actions.jsonl`, `ev-gates.jsonl`, `ev-model-selection.txt`, `ev-settings-lines.txt`, `ev-egress-attempts.txt`, `ev-ext-sockets.txt` | authoritative backend records captured from the VM beside the browser observations (earlier tree; the chooser and gate behaviour is unchanged) |
| `screenshots/` | browser captures of the chooser, Controller panel, Control Room, gates, profile selector, outage and the final default-mode state |

Superseded or intermediate (kept for history, do not use for totals):

| File | Why superseded |
| --- | --- |
| `suites-*-rc-linux-aarch64.json`, `production-lane-rc.log`, `ccv2-lab-lane-rc.log` | per-suite runner without the harness environment (6 `pwsh ENOENT` artefacts, live proofs silently skipped) |
| `real-harness-production-lane.*`, `real-harness-ccv2-lab-lane.*`, `real-harness-ccv2-lab-lane-source-root.*` | real harness runs made before the fixes in J6 (they exposed them) |
| `auth-sweep-authenticated-and-unauthenticated.json` | sweep of the previous tree (13 routes, 260 checks) |

Credential-shaped test fixtures are redacted to `sk-<fixture-redacted>`. No real credential, token or cookie value is stored here.
