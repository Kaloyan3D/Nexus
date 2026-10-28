# Release 1 — readiness report (Final Closure)

Branch `feature/rust-native-core` · local commits only, **nothing pushed or merged**.

**Final executable source SHA: `83acf06`.** Everything after it is documentation only
(`git diff 83acf06 HEAD` touches `native/docs/` only). The package below was built from `83acf06`.

**Package:** `Nexus_0.1.0_amd64.deb`, 61,519,608 bytes (58.7 MiB),
sha256 `2450c255f80b67747a31514e3e5a979ac64ec4ee5dd0fd1866a7c0e1b5ed3f9e`.
Target: **Linux x86_64, Ubuntu 24.04 / Debian 13 (glibc ≥ 2.39) only.** Windows, macOS, other distributions,
AppImage and rpm are not built, not tested and not claimed.

## Verdict: **GO — for Linux x86_64 Debian/Ubuntu (24.04 / 13) only — with two named owner-side checks that this environment could not perform**

The previous NO-GO rested on five things; each is closed with evidence below:

| Was blocking | Now |
|---|---|
| No installed-package GUI test | Done: the real `.deb` installed with `dpkg`, the real window driven by real mouse/keyboard events, real native dialogs, real provider (§3) |
| Node.js had to be installed by the user | A pinned, verified Node.js **v24.22.1** (npm 11.19.1) ships in the package; the GUI journey ran on a machine with **no** system Node and no nvm (§2) |
| Terminal approver needed for "Ask" | Per-operation Ask is **not offered**; project-level native consent is the authority (§4) |
| File edits and created files could not be restored | Guarded GUI restore, including files commands created and files Nexus created (§5) |
| Git metadata creation window | Measured, mitigated, bounded and stated (§6) |

The two checks that remain (they are *not* hidden behind the GO; see §8):
1. **A real Ubuntu 24.04 / Debian 13 machine or VM.** The installed-package run used an Ubuntu 24.04 userland in
   an unprivileged user/mount-namespace container on the developer's *host kernel* (Arch/CachyOS 6.18), not a VM.
   Ubuntu 24.04's AppArmor restriction on unprivileged user namespaces and the distribution's own kernel were
   therefore **not exercised**. If the sandbox cannot start there, Nexus says so on the setup card and refuses to run
   commands (that path is tested); it fails closed, it does not run unsandboxed.
2. **Typing the provider API key into the real key dialog.** I never type credentials. The provider connection in
   the acceptance run was an existing profile copied into the disposable home; the dialog was opened and
   cancelled, not completed.

## 1. What changed in this closure (all committed locally)

- **Bundled Node.js** (A): pin file with URL, sha256 and signer; fetch + signature/sha256/ELF/arch check at packaging;
  `nexus-node.json` manifest in the package; the runtime verifies manifest, sha256, ELF and `--version` at start-up and
  exports the directory (under `/usr`, so the sandbox sees it read-only) only after verification. Project toolchains
  found by the usual rules win; the private Node is a **last resort** and is never put on the user's PATH.
- **Restore** (B): `direct-restore-preview/apply`, `edit_restore.rs`.
- **Ask disabled** (C): `ASK_UNAVAILABLE`, `askAvailable=false`, hidden/disabled with the reason; switch-to-automatic flow.
- **Git neutraliser** (F): `gitguard.rs`, wired to foreground commands and background jobs.
- **Lifecycle** (E): the runtime reaps its children; a `ShutdownGuard`; a regression test.
- **Defects found only by the real GUI** (fixed, each with a regression test):
  1. the package lacked the config files the Registry bridge reads at run time — the verifier now *executes* the packaged bridge;
  2. a preview-port permission card disappeared when the model later started the server *without* the port (the commonest model behaviour);
  3. a process with no exposed port said "Starting…" forever; it now says "Running".

## 2. Package manifest (A)

`apt` metadata: `Depends: libc6 (>= 2.39), libwebkit2gtk-4.1-0, libgtk-3-0, bubblewrap, systemd, util-linux, zenity | kdialog`;
`Recommends: xdg-utils, git`. **No `nodejs` dependency.** Installed size 164,464 KiB; 2,456 entries.

| Path | Content |
|---|---|
| `/usr/bin/nexus-desktop` | application (Tauri), 8.1 MB |
| `/usr/lib/Nexus/bin/` | `nexusd`, `nexus-broker`, `nexus-confine`, `nexus-egress`, `nexus-approver` (0755, root) |
| `/usr/lib/Nexus/node/` | Node.js v24.22.1 (`bin/node` 126,879,696 B, sha256 `e32e2d16081cf644…`), `lib/`, `LICENSE`, `nexus-node.json` |
| `/usr/lib/Nexus/repo/config/` | `model-registry.json`, `engineering-profiles.json`, `muse-profiles.json`, `registry/*.cjs` (bridge + dependencies), `registry/modes/*.json` |
| `/usr/lib/Nexus/repo/scripts/` | the provider scripts the bridge/setup uses |
| `/usr/share/doc/nexus/THIRD-PARTY-NOTICES.md` | 291 Rust crates + 7 JS packages + Node.js/npm licences |

Pinned runtime: Node.js **v24.22.1** ("24 LTS Krypton"), `linux-x64`, tarball sha256
`6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6`, release signer
`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`. npm 11.19.1 (bundled with that Node). glibc floor of the binaries:
2.39 (checked at packaging; baseline Ubuntu 24.04 / Debian 13). Package-content gate:
`packaging/verify-package.mjs` extracts the `.deb`, checks every program, the Node manifest/hash/ELF, the notices, and
**runs** the packaged Registry bridge with the packaged Node — it fails if any asset is missing (6 tests, plus a
negative test per missing asset).

## 3. Installed-package acceptance (D)

Environment: a disposable **Ubuntu 24.04 (noble) minimal cloud image userland** (`~/.cache/nexus-accept`, deleted of
credentials/data afterwards), entered with `unshare` (user + mount namespaces, `pivot_root`) as an unprivileged user,
with Xvfb + openbox as the display. Real `/usr/bin/bwrap`, `systemd-run --user --scope` and Landlock (host kernel).
**Verified in that userland: no `/usr/bin/node`, no `/usr/local/bin/node`, no `~/.nvm`** — the app and every
command it ran used the bundled Node.

**What was genuinely a GUI action (real X events on the real window / real GTK dialogs):**

| Step | Result |
|---|---|
| `dpkg -i` of the RC package, launch `/usr/bin/nexus-desktop` | setup card; steps 1–4 passed |
| Provider API-key dialog | opened; **cancel path** only (see §8) |
| Autonomous-work consent | real native dialog, **Allow** clicked |
| Folder picker | real GTK chooser; project folder chosen with the dialog's OK |
| "Let Nexus edit this folder directly?" | real native dialog showing the broker's text, Allow |
| Task typed into the composer, **Run** clicked (real provider) | built `server.js`, `index.html`, `package.json`; ran `npm run build`; **Verified · Tests passed** |
| Permission card for commands → "Allow Nexus to run commands here…" | native dialog (exact broker text), Allow |
| Local previews → Allow… → port 5173 → Review and allow… | native dialog (loopback-only wording), Allow |
| Ask Nexus to restart the server with the port | job `Running`, `http://127.0.0.1:36505`; **`curl` from outside the app returned the page** |
| "Open preview" | "Opened http://127.0.0.1:36505 in your browser." |
| Edit while the server runs | heading changed; the live preview served the new heading without a restart |
| Stop (server) | process gone; port closed (`curl` exit 7) |
| Stop mid-run → Resume | `Cancelled · Stopped`; **Resume this run** → Run 6 completed (30 attempts, 12 edits, 7 files), docs created |
| Review recovery → Restore 1 file… | native dialog; the command-created `out/made-by-command.txt` was **removed from disk** |
| I modified `package.json` outside Nexus, then Restore changes… | preview: *Would be restored: index.html · Left alone (changed since): package.json*; after Allow, `index.html` returned to its original (sha matches the receipt) and **`package.json` was byte-identical to my edit** |
| Offline `npm install` by the model | refused by the sandbox; a "could not download dependencies" card with *Allow and continue…* (**I deliberately did not allow network**) |
| Close the window, reopen | `nexusd` and `nexus-broker` exited within 2 s (no orphans); conversation, results, project and permissions restored; no setup repeated |
| **Upgrade** RC-B → final package (`dpkg -i` over the installed one) | `credentials.json`, the thread and its log are **byte-identical** (sha256 before/after), 6 run records and 2 grant-audit lines intact, project kept *run in the project* + *previews on 5173*; the app showed the whole conversation, the *Execution evidence* receipts and the recovery section |
| Restore on the **upgraded** app (7 items: six `docs/part-N.md` + the now-empty `docs/`) | native dialog; all removed |

**What was not a GUI action (stated, not blurred):** copying the provider profile into the disposable home; creating
the directory/mount namespaces; `curl` checks, `sha256sum`, `ls` and the one outside-of-Nexus edit of `package.json`
(that is the test input); `wmctrl -c` to ask the window manager to close the window (the same as pressing ✕);
screenshots. **Tauri/backend automation** (separate, ran in the gate §7): `release1_native`, `release1_runtime`,
`release1_lifecycle`, `release1_missing_prerequisites`, scripted dialogs.

**Fixes found by this run and their status:** the preview-card suppression and the "Starting…" label were found in the
GUI run, fixed in `83acf06`, and are covered by unit tests (`access.test.ts`). The *final* package contains the fixes, but
I did **not** replay the preview journey in the GUI on the final package (the upgrade check was done on it, as above).

## 4. Approval model (C)

No terminal is involved anywhere in the normal workflows. Authority comes only from native dialogs that show the
broker's exact text and return that text's digest only on "yes": autonomous work, direct edits, commands in the
project, dependency downloads, preview ports, widening policies, restores. Per-operation **Ask** is not offered:
`apply_draft` refuses `approval=ask` before any dialog (nothing is stored), the UI hides/disables it with the reason,
`project_list` reports `askAvailable=false`, and a project that already asks can be switched to automatic through a
native confirmation. The model cannot request, grant, widen or renew anything: a card exists only because a *refusal*
is in the run record; a run keeps the permissions it started with. Full Access, unrestricted network and Git writes
are never offered by the simple choices and never defaulted. (Tests: `permissions_runtime_m21`, `release1_native`,
`release1.test`.)

## 5. Recovery (B) — what can and cannot be restored

Recoverable (and shown as such): files Nexus edited or created directly in the project; files a command created or
changed **when the checkpoint covered them**. Safety properties, each with a test (`edit_restore_rel1`, 10 tests,
plus `code_a56::rel1_direct_run_edits_…`): digest-bound preview → apply; a stale preview is refused; every path is
decided on its own against the stored original, the recorded post-state and the current file — **a file changed by
anyone afterwards is left alone and reported**; a file Nexus created is removed only while it is unchanged (moved
aside, verified, then deleted); symlinks, hard links, protected paths and anything outside the workspace are refused;
replacement is an atomic exchange with verification of what was swapped out; the daemon audits it; restores are refused
while a command runs.

**Not recoverable, and said so in the UI and in the native dialog:** dependency and build folders (`node_modules`,
`dist`, `target`, …), `.git` and anything in Git, downloads, effects outside the project, anything Full Access did,
files whose original was never kept (very large / no space). It is **not a universal undo**.

*Correction to the previous report:* it said a command restore "does not delete files the command created". That was
true then; it is not true now. The GUI run above shows a command-created file being removed.

## 6. Git-metadata creation window — audit and statement

**The limitation.** The sandbox protects `.git` with mounts built from entries that exist *before* a command. In a
project with no `.git`, a command can create one (`git init`) and plant a hook or a config key (`core.fsmonitor`,
`core.hooksPath`, `core.sshCommand`, `!`-aliases, `filter.*`, `ext::` remotes) *inside that one command*. Inside the
sandbox that is harmless; the harm would come later, when the person's own `git` or editor (outside any sandbox) runs it.
Preventing it at creation time would need a syscall supervisor; this release has none.

**Mitigation shipped:** `gitguard.rs` neutralises the executable surface as soon as the creating command (or, for
background jobs, within a 300 ms sweep and again at job end) has ended: every non-`.sample` hook is removed; `config`
is rewritten to a small allowlist of legitimate keys (remotes limited to https/ssh/git/scp forms); a `.git` that is a
*file* (pointer) is removed; the same for `.git/modules/*`. Originals are copied to a private quarantine first; all work
is descriptor-relative and never follows a symlink (so a command cannot aim it outside the project); the command's result
reports what was done. An existing `.git` is never touched (tests: unit tests ×10, `rel1_git_created_by_a_command…`,
`rel1_a_git_created_by_a_background_job…`).

**Statement.**
- **Maintained:** after a command or job ends, no executable Git metadata that the command created survives for the
  person's tools to run. Nexus itself never runs `git`, commits, pushes or merges.
- **Not guaranteed (bounded residual):** while the creating command is still running (and, for a background job, for up
  to ~300 ms), the planted hook/config exists on disk. It is exploitable only if the person runs `git` in that folder
  *during that interval*. The consent text already tells the person this ("protection applies from the next command on").
- **Release-blocking?** I judge it **not** release-blocking: it needs the person's own tool to run in the same folder at
  the same moment as an AI-run command, the surviving artefact is removed, and it is disclosed in the consent dialog.
  It is **not** masked by documentation: it is mitigated in code and the remaining interval is stated here. If the owner
  considers any concurrent window unacceptable, the only complete answer is the syscall supervisor (out of scope).

## 7. Final gate on `83acf06` (F)

All stages ran from `/tmp/rel-gate/gate.sh` on the final executable source; logs kept there.

| Gate | Result |
|---|---|
| `cargo build --workspace`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` (native) | clean |
| `NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace` | **1538 passed, 0 failed, 64 ignored** (prior 1509; +29) |
| Provider-body comparison (`code_a56`: 228 passed, 5 ignored; 198 dumps) vs **M8.1-AJ** | **0 skeleton differences** on any baselined test. 3 tests have no baseline entry: `aj2_…` (pre-existing) and my two new `rel1_…` tests. **No intentional provider-body change in Release 1; no baseline edited.** Preserved: `nexus-adaptive-v1` and the AJ bodies |
| vs M8.1-EG | 299 skeleton differences = the already-classified job-tool catalog change between EG and AJ (AJ=0 proves they are not new), + 5 tests without baseline |
| `tools/prodgate` (`cargo test --release`) | 6 + 8 passed (frozen tool-catalog digests verified) |
| Tauri `cargo fmt --check`, `clippy --all-targets -D warnings` | clean |
| Tauri `cargo test` | **51 passed, 0 failed, 5 ignored** (ignored = billable live suites, run separately earlier) |
| Desktop `tsc`, `eslint`, `vitest` | clean; **24 files, 246 tests** |
| `npm run test:packaging` | 6 passed |
| Package-content verification of the final `.deb` | `package ok` (programs, Node manifest/hash/ELF, notices, bridge *executed*) |
| Leftover processes after the whole battery | none (`ps`: no `nexusd`/`nexus-broker`/`nexus-egress`/`nexus-desktop`; no `nexus-*` systemd scopes) |

The ignored live suite (`release1_live`, real provider, billable) was run earlier in this release on `775ea62`; it was
**not** re-run on `83acf06`. The GUI acceptance in §3 used the real provider and replaces it for the journey, on the RC
packages; the final package was exercised only for upgrade, persistence and restore.

## 8. Residual limits and what the owner still has to do

1. **Real Ubuntu 24.04 / Debian 13 first launch** (not a namespace container on a different host kernel). Check in
   particular AppArmor's unprivileged-user-namespace restriction for `bwrap` on Ubuntu 24.04, and cgroup v2 delegation
   for `systemd-run --user`. Failure mode is a named setup finding and refused commands, never unsandboxed execution.
2. **Type the API key into the real dialog** once. Everything after it was exercised with an existing profile.
3. **Same package version** (`0.1.0`) was installed over itself for the upgrade test; a real version bump has not been
   exercised, and there is no formal data-migration test beyond the byte-identity/persistence checks above.
4. Only OpenCode Go is supported; each task is billable.
5. Command policy is strict; some commands a person expects to work are refused and reported as refused. Watch-style
   servers (`next dev`, `cargo watch`) and jobs needing network are untested/unsupported.
6. A model may start a server without a preview port after a refusal. The card now appears anyway (fixed), and the
   process says *Running* with no "Open preview" until the port is allowed and the server restarted.
7. The Git interval in §6.
8. Verification is of *recorded commands*; it never proves a requirement is met (stated in the UI).
9. Data folder paths longer than the Unix-socket limit fail start-up; the setup card explains it.

## 9. Process cleanup (E)

Nothing from earlier sessions remained (the machine had been rebooted). In this session I started: `Xvfb :99`
(pid 40036) and `openbox` (pid 42100) inside my own `run.sh` wrappers, and `nexus-desktop` three times (pids 50010,
59438, 62464, each with its own `nexusd` and `nexus-broker` children). Each application instance was closed through its
window (`wmctrl -c`); in every case `nexusd`/`nexus-broker` exited within ~2 s without any signal. Xvfb and openbox were
stopped with `SIGTERM` on those exact PIDs. No pattern-based kill was used. Final `ps` shows no Nexus, Xvfb or openbox
process and no `nexus-*` systemd scope. The copied provider credentials and the app data directory in
`~/.cache/nexus-accept` were deleted; the 2.2 GB Ubuntu rootfs and the `.deb` files there are left for the owner to
reuse or remove. The lifecycle regression test (`release1_lifecycle`) from the earlier defect remains in the suite and
passed in the gate.

## 10. Commits (local)

`83acf06` fix(desktop): preview-port card / "Running" label · `399e0da` ship the config files the bridge reads, verifier
executes the bridge · `2ee027f` Git-metadata neutraliser · `cb7e788` bundled Node, GUI restore of file edits, no per-operation
Ask, orphan-free shutdown · earlier Release 1 commits.
