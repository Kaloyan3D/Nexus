# Release 1 — readiness report

Branch `feature/rust-native-core` · local commits only, **nothing pushed or merged**.
**Final executable source SHA: `775ea62`.** `48b66ee` (HEAD at writing) adds tests and documents only
(`git diff 775ea62 48b66ee` = the live test file and two docs). Release artifacts were rebuilt from `775ea62`.

## Verdict: **NO-GO for general release. GO for an owner-run hands-on acceptance of the installed package.**

The backend and the Tauri layer now deliver the whole "build a site, preview it, verify it, stop or recover it"
journey without a terminal, and that was proven against the real runtime, the real sandbox and the **real model
provider**. What has **not** been done is the one thing the brief says cannot be substituted: nobody (human or
automation) has driven the **real application window** on an **installed** package, including the first-run
dialogs (API key, consents, folder picker). Until that happens, "a developer unfamiliar with Nexus can do the
journey in the app" is evidenced by tests of every layer *except the pixels*, not by the app itself. Remaining
release-relevant limits are listed in §5.

## 1. How each of the 16 acceptance workflows was tested

Channels: **GUI** = the real window (none) · **TAURI-REAL** = the app's own native-layer functions on the real
runtime + sandbox, dialogs scripted · **LIVE** = same, with the **real provider** (billable), dialogs scripted ·
**TAURI-FAKE** = native-layer commands against a canned broker (what crosses the wire) · **UI** = React tests with a
fake native API · **BROKER** = lower-level broker/daemon test (scripted model).

| # | Workflow | Evidence |
|---|---|---|
| 1 | Fresh install / fresh data dir | TAURI-REAL (fresh temp home → Ready); the `.deb`'s binary, extracted, started its runtime from bundled programs with no environment (Ready). **Not** installed via `dpkg`, no menu launch |
| 2 | Provider connection, first-run setup | UI (setup walk-through incl. Adaptive and project steps); native key prompt **not exercised** (no one to type; an existing connected profile was reused for LIVE) |
| 3 | Open an unknown project folder | TAURI-REAL, LIVE (empty/new folders opened via the picker function) |
| 4 | Create files, run real commands | LIVE (model created `server.js`, `index.html`, `test.js`, `package.json` in the real folder; ran `npm test`) |
| 5 | Run and verify tests | LIVE (run 3: `verified-passed`); run 1 correctly flagged `unexecuted-claims` |
| 6 | Local dev server + preview | LIVE: model asked for port 5173 → refused → allowed through the native layer → server started → page served through the bridge at the address the native layer opened |
| 7 | Edit while the server runs | LIVE (heading changed; visible through the running preview) |
| 8 | Stop the server, verify cleanup | TAURI-REAL (revoke ⇒ stopped, port closed), LIVE (same) |
| 9 | Cancel and resume | LIVE (cancelled after 2 calls; broker said *resumable*; resumed as a new run) |
| 10 | Restart; conversations and job state | TAURI-REAL + LIVE (7-run conversation survived a runtime restart; no job reported running) |
| 11 | Missing permission handled in-app | UI (cards), TAURI-FAKE (amendments), LIVE (`dev-port-not-authorized` → exact request) |
| 12 | Revoke during execution | TAURI-REAL, LIVE (running server stopped by the revocation) |
| 13 | Inspect changes, guarded restore | LIVE (`npm run build` rewrote `README.md`; effects observed; stale digest refused; declined dialog changed nothing; restore put the file back); UI, TAURI-FAKE, BROKER |
| 14 | Refused command, no false success | LIVE (offline `npm install` refused; outcome stayed `no-test-executed`, i.e. *Not verified*); UI/unit (`outcome.test`) |
| 15 | Missing toolchain / sandbox unavailable | TAURI-REAL (no Node.js → `error`, cause named, nothing left running); UI (every finding + disabled choices with reason). Sandbox-unavailable is UI/BROKER only: this machine's sandbox works |
| 16 | Multiple projects, no leakage | TAURI-REAL + LIVE (other project: no grant, job refused, folder untouched, conversations per project) |

Scripted-model vs genuine: the BROKER suite (`aj_*`, `aj2_*`) and `release1_runtime` use scripted/no models. The
`release1_live` suite (`#[ignore]`, run on explicit owner authorization) used the real OpenCode Go provider through
the Adaptive engine (≈11 billable runs). **Dialogs were scripted "yes" in every automated path**; that is a stated
limit of those runs, not a claim that people clicked them.

## 2. What was built (parity matrix: `RELEASE1_PARITY_MATRIX.md`; UX: `RELEASE1_UX_CONTRACT.md`)

- Plain-language project access (edit / run commands / dependency downloads / local previews), granular controls
  under one Advanced disclosure; permissions are **amended**, not rebuilt (lifetime, recovery policy, Git choice kept).
- Demand-driven previews: no port pre-authorized; a refused `job_start` becomes one named request; native
  confirmation of the broker's exact text; the model cannot grant anything.
- Running-process panel: open preview (address from the broker only), log, stop, per project.
- Recovery: effects + digest-bound restore with native confirmation. Six honest result words from receipts only.
- First run: computer findings with fixes, Adaptive preparation, folder open; start-up failures explained.
- **Packaging fix (was a release blocker):** the bundle shipped no runtime programs and no Registry bridge. Now bundled
  (`bin/`, `repo/config/registry/` incl. `modes/`), discovered from the app's own resources; `.deb` depends on Node.js ≥ 18 and a dialog tool.
- Narrow backend changes: `projectId` on job records + `job-list` filter; job activity run-record fields
  (`requestedPorts`, readable `argsSummary`, `dev-port-not-authorized`). **Model-visible text is unchanged**
  (a field I had leaked into job results was caught and stripped; a regression assertion pins it).

## 3. Gates (all on the final executable source)

| Gate | Result |
|---|---|
| `NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace` | **1509 passed, 0 failed, 64 ignored** (previous baseline 1506; +3 new) |
| `cargo clippy --workspace --all-targets -- -D warnings` (native and Tauri) | clean |
| `cargo fmt --check` (native and Tauri) | clean |
| Tauri tests | 28 unit + `release1_native` 13 + `release1_runtime` 1 + `release1_missing_prerequisites` 1 + `permissions_*`, `acceptance`, `runtime_update` — all pass (live tests `#[ignore]`) |
| Desktop `tsc`, `eslint`, `vitest` | clean; **24 files, 242 tests** (was 188 → +54) |
| Production gate (`tools/prodgate`) | pass (frozen tool-catalog digests verified) |
| Provider-body comparison (`code_a56`: 226 passed, 196 dumps) | vs **M8.1-AJ** baseline: **0 skeleton differences** (only `aj2_…`, a test added in the previous milestone after that baseline was minted). vs M8.1-EG: the already-classified 301 job-tool differences + the same `aj2_…`. **No intentional provider-body change in Release 1**; no baseline was edited |
| Release build + `.deb` (`Nexus_0.1.0_amd64.deb`, sha256 `e6680583…d5b7`, 11.7 MiB, rebuilt from `775ea62`) | built; contents verified (binaries 0755 root, bridge incl. `modes/`); binary extracted from the package reached *Ready* |

Every failure seen along the way is accounted for: two of my own test assumptions (an over-strict assertion about the
model starting a server without a port; a >SUN_LEN scratch path), one real defect in my change (`projectId` in
model-visible tool output — fixed before the gates above), and one real bundling defect (flattened `modes/`, fixed).

## 4. Security review of what changed

Renderer authority is unchanged: it names a project identity, port numbers 1024–65535 (≤ 8) and an execution id plus
a digest *it was given*. It cannot name a path, address, tool, limit or approval. Every widening is broker preview →
native dialog → digest. Preview opening is `http://127.0.0.1:<broker host port>` only (validated twice). Restore:
re-preview, stale digest refused, native confirm of exact outcome, audited by the daemon, refused while a command runs.
Widening policies (installs, auto-apply) now need a native yes (previously unconfirmed). New: amendments never revive a
revoked grant's weaker options. Full Access, Git writes and unrestricted network are never offered by the simple choices.

## 5. Known limitations and residual risks (not waived — each is visible to the user or in this list)

1. **No GUI/installed-package validation** (blocker for GO): first-run dialogs, folder picker, the real window, menu launch, `dpkg -i`, upgrade over an existing install.
2. **Edits made directly in the folder cannot be restored with one click.** Originals are kept 30 days; the UI and the native dialog say so. A restore of *command* effects does **not delete files the command created**; it only puts back files that existed (seen live: `dist/out.txt` stayed).
3. **"Ask me first" needs the terminal approver** (a separate credential by design). Warned on the project; default is automatic.
4. **Node.js ≥ 18 is required** on the computer (the Registry bridge). A GUI launch may not see an nvm-installed Node; the setup card explains this.
5. Linux only (Landlock + cgroup v2 + zenity/kdialog). Windows/macOS: **not validated, not claimed**. Only `.deb` was built; AppImage/rpm untested.
6. Only OpenCode Go is supported; each task is billable (≈ the limits shown on the composer).
7. A model may legitimately start a server **without** a preview port after a refusal (seen live): it runs, but shows no preview. Not a security issue; the UI shows no "Open preview" for it.
8. Command policy is strict (`node -e …` was refused live): some commands a person expects to work will be refused and reported as refused.
9. Watch-style servers (`next dev`, `cargo watch`) and jobs with network are untested/unsupported (inherited from the Adaptive+Jobs report).
10. Upgrade compatibility: the live runs reused a pre-Release-1 data directory (conversations and registry read correctly; job records without `projectId` default to empty); no formal migration test. Frontend/backend version compatibility relies on the existing Client-API version check.
11. Existing Tauri tests leave their temporary runtimes running after the test ends (pre-existing; my new tests share it). Harmless but untidy; verify with `ps` after a test battery.
12. A data folder path longer than the Unix-socket limit fails start-up; the setup card now explains it.
13. Verification is of *recorded commands*; it never proves a requirement is met (stated in the UI).

## 6. What would turn this into GO

1. Install the `.deb` (or run the built binary) on a clean Linux user account; run the six-step journey by hand: connect provider, consent, Adaptive setup, open a folder, build a site, allow the preview, open it, stop it, restore a build. Record screenshots or a short log.
2. Decide limitation 2 (restore of file edits and of created files) — either accept it for Release 1 with the current wording, or schedule the narrow backend work.
3. Decide Node.js bundling vs. documented prerequisite.
