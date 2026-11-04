# Architecture & Security Audit — Sentry QA Platform (`qa-platform`)

> Read-only. No files modified. All findings below come from code actually read via `fs_read`/`fs_search`/`fs_list`/`proc_run`; line numbers are those returned by the tools. Where validation was not visible in the lines read, I label it a hypothesis / gap rather than a verified flaw.

---

## 1. Architecture

### 1.1 Monorepo layout (observed)

* Root `package.json:1-32`: private `qa-platform@0.1.0-beta.1`, `type: module`, `packageManager: pnpm@9.12.3`, `engines.node >= 22`, `turbo run build/test/lint/typecheck`, one `pnpm.overrides` pin (`extract-zip@2.0.1>yauzl → 3.4.0`).
* `apps/desktop/src/main/*`: Electron main process — `index.ts` (windows + boot), `ipc.ts`, `desktop-command-router.ts`, `cli-server.ts`, `services/desktop-service.ts`, `services/export-save.ts`, `services/wsl-runtime-client.ts`, `runtime/stdio-runtime-client.ts`, `platform/*`.
* `apps/desktop/src/preload/preload.ts`: preload bridge (read 1–120).
* `apps/runtime/src/runtime.ts` (~68 KB): stdio JSON-RPC runtime host — owns projects, runs, harnesses, secrets-in-env, sandbox probing, log sanitization.
* `packages/runtime-protocol/src/{protocol.ts,transport.ts}`: Zod-validated RPC envelope + stdio transport.
* `packages/persistence/src/{paths.ts,filesystem.ts,index.ts}`: data-root layout, managed-copy store, path helpers.
* `packages/harness-{opencode,claude-code,deepseek}/src/*`: one adapter per agent CLI (`adapter.ts`, `launcher.ts`/`process.ts`, `environment.ts`).
* `packages/verifier/src/sandbox.ts`, `packages/run-engine/src/index.ts`: verification sandbox + run orchestration (partially read).

### 1.2 Data & control flow

```
Electron renderer ──ipcRenderer──▶ preload ──ipcMain.handle──▶ main
  (sandboxed, no node)              (minimal bridge)           index.ts / ipc.ts /
                                                            desktop-command-router.ts /
                                                            services/*
        │
        │ stdio JSON-RPC (runtime-protocol, Zod-parsed both ends)
        ▼
apps/runtime RuntimeHost (apps/runtime/src/runtime.ts)
  ├─ configure(): models/providers/binaries → process.env
  ├─ addProject/getProject/listRevisions → packages/persistence
  ├─ run dispatch → packages/run-engine → harness adapters
  │     → spawn agent CLIs (opencode/claude/deepseek) with curated env
  │     → stream observations → Sentry HarnessEvents
  └─ verifier/sandbox (bwrap+socat on Linux; translateWindowsPath+WSL path on Windows)
```

Key trust-relevant facts verified in code:

* Desktop main creates the only renderer-accessible window locked down (`apps/desktop/src/main/index.ts:24-38`):
  `nodeIntegration: false, contextIsolation: true, sandbox: true, preload: …/preload.js`. This is the correct Electron baseline.
* Runtime RPC entry points parse-then-act: `hello()` builds a hello object and `RuntimeHelloResultSchema.parse(…)` before returning (`runtime.ts:542-562`); `configure()` starts with `RuntimeConfigureParamsSchema.parse(params ?? {})` (`runtime.ts:564-565`); `addProject()` does `z.string().min(1).max(2000).parse(sourcePath)` then `translateWindowsPath()` + `assertReadableDir()` (`runtime.ts:639-646`); `getProject/listRevisions` go through `ProjectIdInput.parse(projectId)` (`runtime.ts:648-658`). Protocol validation at the runtime boundary is real.
* Harness session continuity is fail-closed in the OpenCode adapter (`packages/harness-opencode/src/adapter.ts:684-731`): turns after the first must continue the captured session; mismatch or a tool call during a `forbidTools` reporting turn throws (`OPENCODE_SESSION_MISMATCH`, `OPENCODE_REPORT_TOOL_FORBIDDEN`). Good anti-conversation-swap firewall.
* Log redaction is centralized in `runtime.ts:150-170` (`sanitize`/`sanitizeBranch`): `Bearer <token> → Bearer [REDACTED]`, `KEY|TOKEN|SECRET|PASSWORD|apiKey|authToken` keys recursed. Defense-in-depth, but purely syntactic (see §2.7).

### 1.3 Trust boundaries

1. **Renderer (untrusted) → preload → main (trusted).** Only IPC surface; window is sandboxed.
2. **Desktop main → runtime child process (mutually suspicious).** Line-delimited JSON-RPC over stdio; both ends Zod-parse. Desktop pushes secrets + binary paths; runtime spawns OS processes.
3. **Runtime → agent harness CLIs (untrusted output).** Harnesses emit tool calls/text/usage that become ledger events; adapters normalize and re-emit (`observeTool`, `packages/harness-opencode/src/adapter.ts:444+`).
4. **Runtime → OS (spawn/sandbox/filesystem).** Highest blast radius: harness CLIs, `bwrap`/`socat` probes, project import (directory read), export-save (file write).
5. **Persistence (SQLite + managed copies + export files).** Cross-run integrity boundary; not deeply audited (see §4).

### 1.4 Runs / harnesses / verification orchestration

* `apps/runtime/src/runtime.ts` is the orchestrator: `hello/configure` handshake, `PendingRun` map (`runtime.ts:181-184`), project/revision APIs, then delegation to `run-engine` + harness adapters + `verifier/sandbox.ts`.
* `packages/runtime-protocol/src/protocol.ts:1-180` defines the envelope; `transport.ts:1-100` the stdio framing (both read; validation is Zod, fail-closed on parse error — exact error strings not captured, so no claim about error-oracle leakage).
* `packages/run-engine/src/index.ts:1-150` (read) is thin orchestration over persistence + harness metadata (`getMetadata()` in each adapter advertises `shell/filesystemRead/filesystemWrite` capabilities, e.g. `packages/harness-opencode/src/adapter.ts:399-419`).
* `packages/harness-opencode/src/environment.ts:1-150` builds the tool-visible environment with explicit `allowedNames/blockedNames` (`toolEnvironmentNames()`, `adapter.ts:390-397`) — genuine secret-isolation design.
* `packages/verifier/src/sandbox.ts:150-350` probed in three windows; sandbox prerequisite probing lives in the runtime host (`probeSandboxDeps()`, `runtime.ts:206+`), fail-closed language in comments.

---

## 2. Security posture by theme

### 2.1 Process execution & sandboxing

Verified spawns are `spawn`/`spawnSync` with argv arrays (no `shell:true` in the paths read). The string `shell: true` appears only as a *capability advertisement* in harness metadata (`packages/harness-claude-code/src/adapter.ts:604`, `packages/harness-deepseek/src/adapter.ts:469`, `packages/harness-opencode/src/adapter.ts:410` — found via search, confirmed in context at `harness-opencode/adapter.ts:405-414`), not as a `spawn` option in the files read. Do not confuse the two.

One exception — string-built shell command:

* `apps/runtime/src/runtime.ts:218`: `spawnSync('sh', ['-c', 'command -v ' + bin], …)` inside `has()`. Current callers pass only literals `'socat'`/`'bwrap'` (`runtime.ts:227-228`), so **not currently exploitable**, but the helper is one refactor away from injection. Fix by using `spawnSync(bin, ['--version'])` or `fs.access(PATH lookup)` with no shell.

Sandbox itself was only partially inspected (`verifier/sandbox.ts` windows + `probeSandboxDeps`); bwrap/socat presence/version/init checks exist but I did not trace the final `bwrap` argv construction. See §4.

### 2.2 Filesystem & path handling

* Project import validates length then translates + readability-checks: `runtime.ts:639-646`. Good.
* IDs are branded/zod-validated (`ProjectIdInput`, `runtime.ts:649,656`).
* Persistence helpers (`packages/persistence/src/paths.ts:1-100`, `filesystem.ts:1-150`) centralize the data-root layout; I saw `translateWindowsPath` usage and `assertReadableDir` gating but did **not** verify symlink/canonicalization/TOCTOU handling or export-save destination confinement (`export-save.ts:1-120` read once — save dialog result flows to a write; I did not capture an allowlist check). Treat traversal/overwrite as **unverified, needs follow-up**, not a confirmed bug.

### 2.3 Credential / secret handling — biggest cluster

**F1 (below) is the headline.** Supporting observations from lines actually read:

* Secrets land in `process.env` (`runtime.ts:580-594`: `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, plus `SENTRY_*_MODEL/PROVIDER`). Comment at `runtime.ts:578-579` states intent ("memory only, never persisted"). Env-vars are inherited by every child process, visible via `/proc/<pid>/environ`, included in crash dumps and any `environment` echo in diagnostics. The harness `environment.ts` allow/block lists mitigate tool-visible leakage, but the *host-level* secret store is still the process environment.
* `registerDesktopIpc` was only shallowly read (`apps/desktop/src/main/ipc.ts:1-80`); I could not confirm per-channel allowlisting or whether secrets cross IPC more than once.
* `apps/desktop/src/main/services/provider-credentials.ts` is referenced by grep (`provider-credential` search hit) but **every read/list attempt was refused by policy** (`sensitive-path-refused`) and the file does not appear in `services/` listings. I therefore **cannot confirm or deny OS-keychain (DPAPI/libsecret/keytar/safeStorage) usage**. This is an explicit audit gap (§4), not evidence of plaintext storage.

### 2.4 IPC & runtime protocol validation

Positive: Zod schemas at every runtime entry read (`RuntimeHelloResultSchema`, `RuntimeConfigureParamsSchema`, `ProjectIdInput`, `z.string().min(1).max(2000)`). Transport is stdio only (no TCP socket observed in `transport.ts:1-100`), which avoids remote-network exposure.

Gaps: I did not read the desktop-side `stdio-runtime-client.ts` beyond the first 100 lines, nor `wsl-runtime-client.ts` beyond 150 lines, nor the full `cli-server.ts` (only `1-120`). CLI-server authentication/origin checks, WSL path translation edge cases, and renderer→main channel allowlists are therefore **unverified**.

### 2.5 Input validation

Runtime boundary: strong (Zod-first, see §1.2). Harness boundary: session-continuity firewall is strong (`adapter.ts:684-740`). What I did *not* see in lines read: output-size caps on harness text/observations, timeout values beyond `turnTimeoutMs` plumbing (`adapter.ts:693-711`), or schema validation of `result.toolCalls` before `observeTool`. Log-sanitizer bypasses (e.g. split-token, non-`KEY=` formats) are likely — regex redaction is inherently best-effort.

### 2.6 Dependency / supply-chain posture

* pnpm 9 + `catalog:` + `engines.node >= 22` + a targeted `yauzl → 3.4.0` override (zip-slip-era pin) shows active maintenance. I did **not** run `pnpm audit`/lockfile review, verify binary provenance (`doctorOpenCode` health check at `adapter.ts:421-428` checks presence, not signature), or check `turbo`/pipeline sandboxing. No `postinstall` scripts were enumerated (gap).
* No network fetch of models/binaries was observed in the files read; binary *selection* is the risk (F1), not download integrity.

### 2.7 Logging of sensitive data

`sanitize()` (`runtime.ts:150-170`) redacts `Bearer` and `KEY|TOKEN|SECRET|PASSWORD|apiKey|authToken` shapes. Strengths: recursive, applied at the RPC boundary per comments. Weaknesses: misses `Authorization:` without `Bearer`, `api_key` with different separators, JWTs without keywords, and structured secrets under innocuous keys; key-match branch (`/KEY|TOKEN|…/i`) over-redacts some diagnostics while under-redacting values under generic keys (e.g. `auth`, `session`, `config`). Treat as defense-in-depth only.

### 2.8 Desktop privilege boundaries

* Main window: hardened baseline verified (`index.ts:32-37`). Preload read (1–120) is a narrow bridge — no `shell`, `fs`, or secret APIs visible in the window read.
* Two hardening gaps verified in read lines:
  * `index.ts:40-42`: `SENTRY_DESKTOP_URL` overrides the renderer URL. Any process that can set the Electron parent's env (launcher scripts, `.env` confusion, CI) can redirect the privileged renderer to attacker content. No `https:`/allowlist check visible in the lines read.
  * `index.ts:75-100`: boot-failure window loads a `data:` URL built with `encodeURIComponent` (safe) plus `message.replace(/</g,'&lt;')` — adequate *here* because of the encoding, but the single-char escape pattern is fragile if reused elsewhere without `encodeURIComponent`.
* `registerDialogIpc` (`index.ts:52-62`) exposes only `open-directory` — appropriately narrow.

---

## 3. Concrete findings

### F1 — Desktop-pushed binary path overrides reach `process.env` → harness spawn with no validation visible [HIGH — verified flow, validation not seen]
* **Files/lines actually read:** `apps/runtime/src/runtime.ts:186-189` (`applyBinaryOverride`: `if (value !== undefined) process.env[name] = value; else delete …`) and `runtime.ts:598-611` (applies `parsed.binaries.{opencode,deepseek,glm}` to `SENTRY_OPENCODE_BINARY`, `SENTRY_DEEPSEEK_BINARY`, `SENTRY_GLM_BINARY`, and mirrors GLM into `SENTRY_CLAUDE_BINARY`).
* **Why it matters:** whoever can send `configure({ binaries: { opencode: "/attacker/controlled" } })` over the stdio/CLI channel controls which executable the runtime later spawns for agent runs. Combined with renderer→main→runtime trust (§1.3), a renderer compromise or a malicious local CLI client escalates directly to arbitrary command execution as the runtime user. I read the consumer (`applyBinaryOverride` + 4 call sites) but **did not locate the `binaries` Zod schema** in the lines read, so I cannot confirm absence of validation — but no existence check, executability check, allowlist, or `PATH`-resolution guard appears at the use site.
* **Fix:** validate at parse time: reject relative paths and non-allowlisted directories; `fs.stat` + mode check (regular file, executable, not symlink-to-outside-allowlist); canonicalize with `fs.realpath`; optionally pin SHA-256 per binary and fail closed; log the resolved path (sans secrets). Add a test that `configure({binaries:{opencode:'/tmp/evil'}})` throws.

### F2 — Provider secrets stored in `process.env`, inherited by all children [MEDIUM — verified]
* **Files/lines:** `apps/runtime/src/runtime.ts:564-597` (six `process.env['*_API_KEY|AUTH_TOKEN|BASE_URL']` assignments behind `RuntimeConfigureParamsSchema.parse`).
* **Why it matters:** env is the leakiest secret store: `/proc` environ, child inheritance (every harness + grandchild tool), core dumps, `ps e`, accidental `console.log(process.env)` outside the sanitized path. The `environment.ts` allow/block lists protect the *agent-visible* subset, but host-level exposure remains.
* **Fix:** keep secrets in a module-scoped `Map` (never `process.env`); inject per-spawn via explicit `env` allowlist at the single spawn site; `mlock`-style zeroing is overkill in Node, but overwrite on run teardown and never include secret values in `hello()`/diagnostics. If env must be used for CLI compat, scope it to the child `env` option only, not the runtime process env.

### F3 — `SENTRY_DESKTOP_URL` lets environment redirect the privileged renderer [MEDIUM — verified]
* **Files/lines:** `apps/desktop/src/main/index.ts:40-45` (`if (devUrl …) loadURL(devUrl) else loadFile(…index.html)`).
* **Why it matters:** the renderer holds IPC access; loading `http://attacker/` (dev convenience) in a production-signed build hands that IPC to attacker JS. Env-var control is easier than code change (launchers, test harnesses, malware already on box).
* **Fix:** gate on `app.isPackaged`: ignore `SENTRY_DESKTOP_URL` (or restrict to `https://localhost:` + token) when packaged; warn loudly in dev.

### F4 — Shell-string probe helper invites future injection [LOW — verified pattern, not currently exploitable]
* **Files/lines:** `apps/runtime/src/runtime.ts:215-229` (`spawnSync('sh', ['-c', 'command -v ' + bin])`; only literals `'socat'`/`'bwrap'` passed at `:227-228`).
* **Fix:** replace with shell-free lookup (`which`-equivalent via `PATH` split + `fs.constants.X_OK`) or `spawnSync('command',[' -v',…])` without `sh -c`. Mark `has()` input as `/* caller must pass literal */` or accept an allowlist union type.

### F5 — Regex log redaction is bypassable [LOW (defense-in-depth) — verified logic]
* **Files/lines:** `apps/runtime/src/runtime.ts:150-170`.
* **Why it matters:** anything the regex misses (custom header names, chunked exfiltration across log lines, secrets under generic keys like `prompt`, `context`) lands in persisted logs/artifacts/SQLite and violates the `runtime.ts:578-579` "never persisted" promise.
* **Fix:** keep regex as a backstop; primarily (a) never log request/response bodies at info level, (b) structured-log with a secret-typed wrapper so serializers must opt in, (c) add negative tests (Bearer split across lines, `apiKey` nested 3 deep, JWT-shaped value under `model` key → must still redact or must not be logged).

### Hypotheses explicitly *not* promoted to findings
* Plaintext provider-key storage on disk — **unknown**: the credential module was unreadable (policy refusal); no evidence either way.
* CLI-server (`cli-server.ts:1-120` read) loopback auth bypass — **unverified**: auth/origin/token lines not in the window read.
* Export path overwrite / symlink escape — **unverified**: `export-save.ts:1-120` read but destination-confinement check not captured.
* `bwrap` sandbox escape / over-permissive binds — **unverified**: final sandbox argv not traced.

---

## 4. Prioritized summary

1. **Harden `configure→binaries` (F1)** — highest ROI: single choke point, RCE-equivalent. Add allowlist + realpath + executability + tests.
2. **Move secrets out of `process.env` (F2)** — narrow the blast radius to per-spawn env; audit every `process.env[` reader.
3. **Gate `SENTRY_DESKTOP_URL` on `!app.isPackaged` (F3)** — one-line change, kills a renderer-hijack vector.
4. **De-shell the probe helper (F4)** + expand redaction tests (F5) — cheap hardening.
5. **Close the gaps below** before any security-sensitive release.

## What I did not inspect (honest scope limits)

* `apps/desktop/src/main/services/provider-credentials.ts` (and any `safeStorage/DPAPI/keytar` usage): **reads refused by environment policy** (`sensitive-path-refused`); storage-at-rest posture for provider keys is therefore **unaudited**. A follow-up with credential-file access is required.
* Renderer (`apps/desktop/src/renderer`): not enumerated beyond `index.html` reference; XSS→IPC impact unassessed.
* Full `cli-server.ts` (only 1–120), `stdio-runtime-client.ts` (only 1–100), `wsl-runtime-client.ts` (only 1–150), `ipc.ts` (only 1–80), `desktop-service.ts` (only 1–100), `desktop-command-router.ts` (1–120 + 120–240): routing/auth edge cases beyond those windows not covered.
* `verifier/sandbox.ts` final argv, `persistence` SQLite layer, all `harness-*` adapters beyond the windows cited, `run-engine` beyond 1–150.
* Supply chain: no `pnpm-lock.yaml` audit, no `postinstall` enumeration, no `pnpm audit` (read-only task; network-restricted sandbox). No tests were run (per read-only instruction), so **no test-result claim is made**.

Overall: the security *architecture* is thoughtfully layered (sandboxed renderer, Zod-at-every-runtime-entry, session-continuity firewall, secret-aware env builder, centralized redaction). The residual risk concentrates where trusted configuration (binary paths, secrets, renderer URL) crosses a boundary with insufficient confinement — F1–F3 above.
