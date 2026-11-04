# Sentry (qa-platform v0.1.0-beta.1) — Read-only Architecture & Security Audit

> No file was modified. All evidence below is from files actually read in this working copy (`apps/`, `packages/`, `scripts/`, `sentry.ps1`, `package.json`, `pnpm-workspace.yaml`). Where I could not verify something, I say so.

## 1. Architecture

### 1.1 What this system is
Local-first Electron desktop that runs 3 independent AI QA agent stacks (OpenCode via OpenRouter, DeepSeek SDK/wrapper, GLM via Claude-Code adapter) against an immutable project snapshot, then merges/verifies findings. Execution happens in WSL2 Linux; Windows only hosts UI + launcher.

### 1.2 Main components and responsibilities

| Layer | Package / path | Job |
|---|---|---|
| UI shell | `apps/desktop/src/main/index.ts`, `bootstrap.ts`, `ipc.ts`, `desktop-command-router.ts`, `preload/preload.ts`, `shared/ipc-contract.ts`, `renderer/` | `BrowserWindow`, Zod-validated IPC dispatch, native dialogs, live updates, CLI broker hosting |
| Local CLI broker | `apps/desktop/src/main/cli-server.ts` + `packages/shared/src/cli-ipc.ts` | Windows named-pipe / POSIX-socket server for external `sentry cli`; dispatches through **same** `dispatchDesktopCommand(..., {external:true})` |
| Host↔runtime bridge | `apps/desktop/src/main/services/wsl-runtime-client.ts`, `platform/windows/windows-wsl-platform.ts`, `platform/linux/native-linux-platform.ts`, `runtime/stdio-runtime-client.ts` | Spawns `wsl.exe -d <distro> -- node <runtimeEntry> --stdio`, handshake, timeouts |
| Stable core (Linux) | `apps/runtime/src/runtime.ts` (~1802 lines), `host.ts` | Versioned NDJSON stdio RPC (`runtime.hello/configure`, `projects.*`, `runs.*`, `retests.*`, …); owns DB, coordinators, harness registrations, readiness gates |
| RPC contract | `packages/runtime-protocol/src/protocol.ts`, `transport.ts` | Zod schemas, `MAX_RPC_LINE_BYTES=8MiB`, `RUNTIME_EXPORT_MAX_RAW_BYTES=6MiB`, overflow-safe `RpcLineBuffer` |
| Orchestration | `packages/run-engine/src/index.ts` (~1463 lines), `retest-service.ts`, `verification-service.ts`, `exporters.ts`, `activity-projector.ts` | `RunCoordinator`: snapshot → per-agent workspaces → parallel harness runs → merge → verify → retest |
| Isolation primitives | `packages/workspace-factory/src/index.ts`, `packages/snapshot-engine/src/index.ts`, `packages/persistence/src/filesystem.ts`, `paths.ts`, `artifact-store.ts`, `database.ts` | Frozen snapshot, per-`AgentRun` workspace copy (`symlinkPolicy:'inert-unsafe'`, never follow), `resolveInside` jail, parameterized SQLite (`node:sqlite`) |
| Harnesses | `packages/harness-opencode/*` (adapter, `environment.ts`, `scope.ts`, `toolshell.ts`, `proxy.ts`, `process.ts`, `discovery.ts`, `wire.ts`), `packages/harness-claude-code/*` (`environment.ts`, `launcher.ts`, `sdk.ts`), `packages/harness-deepseek/*`, `packages/harness-protocol/*` | Spawn + supervise one vendor agent; sanitize env; sandbox shells; redact logs |
| Verification replay | `packages/verifier/src/runner.ts`, `sandbox.ts`, `signatures.ts`, `recipe.ts`, `redact.ts`, `frameworks.ts` | Re-executes *recorded* test/build commands only: allowlist + shell-syntax gate + `systemd` transient-unit sandbox (fail-closed, never host fallback) |
| Schemas/domain | `packages/schemas/*`, `packages/domain/*`, `packages/shared/ids.ts`, `run-limits.ts` | ULID-style IDs (`run_*`, `issue_*`, `retest_*` regex-validated in `runtime.ts:85-88`), state machines |
| Launcher/install | `sentry.ps1`, `scripts/launcher/*`, `scripts/launcher/linux/install-*.sh` | WSL/Node/pnpm/agent-tool setup, Electron launch, `doctor/status/update` |

### 1.3 Data & control flow (normal Full QA)
1. Renderer → `window.sentry` (preload, `preload.ts:1-~120`) → `ipcMain.handle(channel)` (`ipc.ts:21-45`) → `dispatchDesktopCommand` Zod `strict()` parse (`desktop-command-router.ts:129-147`) → `DesktopApplicationService` (`services/desktop-service.ts:1-60`) → `RuntimeClient.request()` over stdio → `apps/runtime/src/runtime.ts` handler → `ProjectManager` / `RunCoordinator` / `SentryRepository` (SQLite under Linux data root).
2. `RunCoordinator` freezes a snapshot (`snapshot-engine`), mints per-agent workspaces (`workspace-factory`: `rm workspaceRoot` then `copyTree(..., symlinkPolicy:'inert-unsafe')`), creates disposable HOME/XDG scopes (`harness-opencode/src/scope.ts:38-80`), launches each harness with an allowlisted env + localhost auth proxy (OpenCode) or subprocess scrub (Claude).
3. Model-controlled `bash` goes through the generated `bwrap` tool-shell wrapper (`toolshell.ts:1-50`): hide scope-dir/workspace-parent/real-HOME via empty tmpfs, re-bind workspace RW, private `/tmp`, `--unshare-net` (parent keeps net so the proxy still works).
4. Verification replays only allowlisted heads (`verifier/src/signatures.ts:14-22`: `node npm pnpm … go mvn …`), refuses shell syntax (`runner.ts:39,43-76`), resolves the executable without a shell (`runner.ts:81-104`), runs inside one `systemd-run` transient unit per attempt with `TemporaryFileSystem=/`, `ProtectHome=yes`, `PrivateNetwork=yes`, `NoNewPrivileges=yes` (`sandbox.ts:325-368`), 64 KiB output caps.
5. Exports return inline base64 only if `≤6 MiB` (`runtime.ts:133-145`, `transport.ts:37-47`); larger runs must use Desktop Save-As (streams bytes, atomic write in `export-save.ts:55-77`).

### 1.4 Trust boundaries
- **Renderer (untrusted) → main (trusted):** Zod `strict()` per channel; destination path never accepted from renderer (`export-save.ts:1-16`); reveal restricted to in-session dialog outputs (`export-save.ts:100-123`).
- **Any local pipe client → main:** same router with `external:true` allowlist (`desktop-command-router.ts:92-101`, `shared/cli-ipc.ts:18-51`). No secret-mutation channels exposed.
- **Windows host → WSL runtime:** stdio NDJSON only; secrets only via `runtime.configure` *after* handshake, never argv (`wsl-runtime-client.ts:37-51`); Windows-style `--data-root` refused (`bootstrap.ts:76-86`); Windows source paths rejected unless the desktop bridge translated them (`runtime.ts:1668-1673`).
- **Runtime → agent child:** allowlisted env (OpenCode `environment.ts:37-109` allowlist is empty for secrets; Claude parent gets exactly `ANTHROPIC_AUTH_TOKEN` in `harness-claude-code/src/environment.ts:60-64`), disposable HOME/XDG, masked project `opencode.json` (`scope.ts:82-~110`), proxy dummy key (`proxy.ts:30`), unit-name has no untrusted content (`launcher.ts:75-80`, `harness-opencode/process.ts:70-74`).
- **Recorded command → verifier sandbox:** allowlist + `hasUnsafeTarget` + cwd containment + scrubbed env + disposable HOME (`runner.ts:106-140`).
- **Desktop ↔ SQLite:** main owns no domain state; all persistence lives in the Linux runtime (`desktop-service.ts:1-11`, `bootstrap.ts:42-47`).

## 2. Security posture (what is done well)

- Electron: `nodeIntegration:false, contextIsolation:true, sandbox:true` (`main/index.ts:32-37`); preload exposes only `window.sentry`, payloads only (`ipc-contract.ts:1-6`).
- IPC: every channel Zod-validated; unknown channels rejected; CLI allowlist derived from one shared vocabulary (`cli-ipc.ts:12-17`).
- Transports: byte-length (not char-length) limits on both RPCs; oversize frames fail deterministically instead of hanging (`transport.ts:1-47`, `cli-server.ts:~150-230`).
- FS: `resolveInside` jail (`persistence/src/paths.ts:100-106`), `isPathInside` + `canonicalizePath`/`assertNoPathOverlap` (`paths.ts:63-98`), `lstat`-only traversal / symlinks never followed (`filesystem.ts:75+`), copy preserves modes + `chmod` (`filesystem.ts:330-349`).
- Process: `shell:false` everywhere except agent-owned workers (see §3.2); systemd `--setenv=NAME` for secrets so values never appear in argv (`harness-claude-code/launcher.ts:25-30`, `harness-opencode/process.ts:203-221`); kills scoped to owned unit/cgroup, never `pkill` (`process.ts:44-56`).
- Secrets hygiene: `sanitize()` at the RPC boundary (`runtime.ts:147-170`), `redactSecrets` in verifier (`redact.ts:10-22`), `redactDiagnostic(..., secrets)` in OpenCode observations (`adapter.ts:444-490`), stderr is “never secrets, never protocol” (`runtime.ts:4-11`).
- Distro selection validates against live `wsl.exe --list` WSL2 entries (`windows-wsl-platform.ts:119-128`); preference write is tmp+rename atomic (`wsl-runtime-client.ts:234-244`).
- DB uses `prepare(?)?` placeholders throughout (`repository.ts:129-197`, `database.ts:41-52`); migrations in explicit transactions.

## 3. Concrete findings

### F1 — `ProviderCredentialService` module is absent from this working copy — audit gap, possibly broken build [Severity: High (availability) / Unknown (confidentiality)]
- Affected: `apps/desktop/src/main/bootstrap.ts:15-17,65-69`; `apps/desktop/src/main/services/desktop-service.ts:14`; `apps/desktop/src/main/index.ts:284-321`; referenced by 6+ test files — but `apps/desktop/src/main/services/` on disk contains only `desktop-service.ts`, `export-save.ts`, `wsl-runtime-client.ts` (verified with `ls -la`).
- Why it matters: every claim about “safeStorage/DPAPI, encrypted at rest, presence-only doctor output” bottoms out in a file I could not read. I cannot verify encryption-at-rest, file mode (`0600`), DPAPI fallback, or key-allowlisting. If the file is merely untracked/gitignored, the shipped app may still be fine; if it is genuinely missing, `tsc`/Electron boot fails.
- Fix: restore/commit the file; add `0600` file mode + DPAPI-unavailable fail-closed test; keep `sentry doctor` presence-only (already the case in `index.ts:300-327`).

### F2 — `SENTRY_DESKTOP_URL` lets any process that can set the env load arbitrary web content into the privileged renderer [Medium-High, verified]
- Affected: `apps/desktop/src/main/index.ts:40-45`.
- Why: `loadURL(devUrl)` with no allowlist. That page gets the full `window.sentry` bridge (run start = spend money, project delete, provider-save, distro switch). Dev convenience becomes RCE-as-renderer-compromise if the variable leaks (launcher scripts, shortcuts, CI).
- Fix: only honor `http(s)://localhost:*`/`127.0.0.1` (or a `--dev-url` flag + `NODE_ENV=development`), else `loadFile`.

### F3 — CLI broker has no authentication — any same-user (and on POSIX-tmp, potentially same-host) process can drive operational commands [Medium, verified]
- Affected: `packages/shared/src/cli-ipc.ts:97-120` (`parseClientIdentity` only checks `name` non-empty); `apps/desktop/src/main/cli-server.ts:~170-260` (hello → welcome, no secret, no ACL check shown).
- Why: allowlist excludes secret mutation (`providers:save` etc. correctly absent, `cli-ipc.ts:18-51`), but `runs:start` (spends provider budget), `projects:delete`, `runtime:select-distro` remain reachable by