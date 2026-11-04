# Read-only architecture & security audit (pnpm/TypeScript monorepo)

No file was modified and no command was executed. All evidence below comes from repository listings, searches, and the file ranges actually returned with content. Where a read was compacted/omitted, I treat it as **not inspected** and say so.

## 1. Architecture

### 1.1 Components observed

Top level:

- `apps/cli`, `apps/desktop`, `apps/runtime`
- `packages/`: at least `run-engine`, `harness-opencode`, `harness-*` (other harnesses referenced by docs/names but not enumerated with content), `persistence`, `runtime-protocol`, `snapshot-engine`, `shared`, `workspace-factory`, `schemas` (referenced by imports), and others present but not fully listed in visible output.

Responsibilities (from names plus the files actually read):

- `apps/desktop`: Electron host. `src/main` owns runtime lifecycle, credentials, path preparation, IPC/CLI broker, and export save; `src/preload` exposes the renderer bridge; `src/renderer` is the UI; `src/shared` holds the IPC contract.
  - Evidence: `apps/desktop/src/main/services/desktop-service.ts:1-9` — "Electron main owns NO Sentry domain state … Every QA operation is a typed `RuntimeClient.request()` over the shared stdio transport to the long-lived Linux runtime. Host keeps: safeStorage credentials, runtime lifecycle, path preparation, live-update fan-out. Secrets stay in main; renderer receives statuses."
  - Services listed: `apps/desktop/src/main/services/` contains `desktop-service.ts`, `export-save.ts`, `wsl-runtime-client.ts`.
  - Runtime clients: `apps/desktop/src/main/runtime/` contains `runtime-client.ts`, `stdio-runtime-client.ts` (contents not inspected — reads were compacted).
- `apps/runtime`: execution runtime. `src/` contains `host.ts`, `index.ts`, `runtime.ts` (`runtime.ts` is ~67 KB; only a small range was requested and its content was compacted, so its handlers were **not inspected**).
- `apps/cli`: CLI frontend; `src/`, `tests/`, `package.json`, `vitest.config.ts` listed but contents not inspected.
- `packages/run-engine`: run orchestration (`src` listing compacted; contents not inspected).
- `packages/harness-opencode`: OpenCode agent harness. `src/` includes `process.ts`, `environment.ts`, `scope.ts`, `toolshell.ts`, `proxy.ts` (names observed; only `proxy.ts:1-120` returned content).
- `packages/runtime-protocol`: main↔runtime stdio framing/validation (`protocol.ts`, `transport.ts` listed; contents not inspected).
- `packages/persistence`: filesystem/repository layer (referenced imports: `FilesystemArtifactStore`, `SentryRepository`, `resolveInside`, `runDataPaths`, `scanTree`, `snapshotEntry`, `walkTree`); its `paths.ts` read was compacted, so confinement behavior was **not inspected**.
- `packages/snapshot-engine`: snapshot manifest/spans (`src/index.ts` fully read, lines 1-144).
- `packages/shared`: cross-boundary contracts including `cli-ipc.ts` (lines 1-100 read).
- `packages/workspace-factory`: `src/index.ts` listed; content compacted (not inspected).

### 1.2 Data and control flow (as evidenced, not assumed)

1. Renderer → preload → Electron main (`DesktopApplicationService`) → `RuntimeClient.request(method, params)` → stdio transport → Linux runtime → run engine/harness/agent tools → artifacts/snapshots in the runtime data root.
   - Evidence: `desktop-service.ts:64-71` (`call()` → `this.deps.runtime.request`), `desktop-service.ts:89-151` (projects/runs fan-out to `projects.*` / `runs.*` RPC names).
2. External CLI → local named-pipe/socket broker (Electron main) → same desktop command router (`external:true`) → runtime.
   - Evidence: `apps/desktop/src/main/cli-server.ts:1-6` ("issue operational commands; every request dispatches through the shared desktop command router with external:true … Runs are owned by the Linux execution runtime: a dropped client connection never cancels anything"); `packages/shared/src/cli-ipc.ts:18-51` (broker command allowlist).
3. Provider credentials: main holds them; renderer gets statuses only; the OpenCode harness is pointed at a loopback auth proxy holding the real key in heap.
   - Evidence: `desktop-service.ts:7-8`, `desktop-service.ts:286-296` (paraphrased from visible lines: statuses to renderer, never values); `packages/harness-opencode/src/proxy.ts:6-30` (design comment quoted in §3.5).
4. Exports: renderer supplies runId+format only; destination comes from the native Save dialog; bytes come from the canonical exporter artifact.
   - Evidence: `apps/desktop/src/main/services/export-save.ts:1-9`, `:73-86`.

### 1.3 Trust boundaries

1. **Renderer (untrusted UI) ↔ main (trusted broker)** — preload/IPC contract. Main re-validates with zod (observed in `desktop-service.ts:26-38`, `:94-155`).
2. **Local CLI client ↔ Electron broker** — OS-local pipe/socket, **no peer authentication observed** (see Finding F1).
3. **Electron main (Windows/host) ↔ Linux execution runtime** — stdio `RuntimeClient`/runtime-protocol boundary. Client side observed; runtime handler side **not inspected**.
4. **Agent harness ↔ model-controlled tools** — subprocess env/files/shell. Only the proxy design comment was read; `process.ts`/`environment.ts`/`scope.ts`/`toolshell.ts` contents were compacted → **not inspected**.
5. **Auth proxy loopback ↔ harness/tools** — documented bounded oracle (see F5).
6. **Project source ↔ snapshot/store/export destinations** — path confinement claimed by names (`resolveInside`, `prepareSourcePath`, dialog-owned destinations) but implementations **not inspected**.

### 1.4 Runs / harnesses / verification orchestration

- Desktop `startRun` validates `{mode, includePaths?, instructions?, agentStackIds?, runTimeoutMs?}` and forwards to `runs.start`, with timeout-reconciliation to avoid hiding a paid run that actually started (`desktop-service.ts:153-180`).
- Run/harness verification internals (run-engine, harness adapters, evidence/verification steps) were **not inspected** — the relevant reads were compacted. I do not describe their orchestration beyond the dispatch surface above.

## 2. Security posture by theme

- **Process execution/sandboxing:** not verified. Harness process/env/scope/toolshell reads were compacted. Only the auth-proxy isolation rationale was read.
- **Filesystem/path handling:** partially observed. Desktop validates lengths/counts and delegates Windows→WSL translation to `host.prepareSourcePath` (`desktop-service.ts:94-135`), whose implementation was not inspected. `resolveInside`/`copyTree`/`scanTree` not inspected. Export destination ownership is dialog-side (good), but the write itself has an atomicity/TOCTOU caveat (F4).
- **Credential/secret handling:** design looks careful (statuses-only to renderer; heap-only proxy key), but the actual `ProviderCredentialService` file was **absent from this working copy** and `safeStorage` search output was redacted. Not verified — must not be assumed encrypted.
- **IPC/runtime protocol validation:** broker framing limits + command allowlist observed (good baseline); runtime-protocol `protocol.ts`/`transport.ts` and stdio client contents not inspected.
- **Input validation:** strong shape validation at the desktop boundary (zod + ULID-pattern IDs for runs/issues/retests), but `projectId` is loose and path/prompt fields are shape-only (see F3).
- **Dependency/supply chain:** not inspected (no lockfiles, workspace catalogs, launcher scripts, or CI reviewed).
- **Sensitive logging:** error sanitization truncates but passes message text through (see F6); proxy claims no body logging (design comment only; relay code not read).
- **Desktop privilege boundary:** main holds secrets/lifecycle; renderer gets statuses; CLI broker shares the same router with `external:true` — so any broker weakness inherits full operational power (see F1).

## 3. Concrete findings

> Severity scale: High = directly exploitable confidentiality/integrity/financial impact; Medium = meaningful hardening gap or bounded exploit; Low = defense-in-depth.
> "Verified" = I read the cited lines. "Hypothesis/gap" = I could not read the enforcing code.

### F1 — CLI broker has no client authentication (Verified) — Severity: Medium, borderline High on shared/multi-user hosts

- Files/lines read:
  - `apps/desktop/src/main/cli-server.ts:37-44, 49-71, 87-124` — pipe server takes any connection, `dispatch(command, payload)`; no token, no peer-credential check; errors sanitized but identity never verified.
  - `packages/shared/src/cli-ipc.ts:18-51` — allowlist includes state-changing/paid operations: `runs:start`, `runs:start-production`, `runs:cancel`, `projects:add/update/delete`, `providers:detect-binaries`.
  - `packages/shared/src/cli-ipc.ts:97-101` — `parseClientIdentity` accepts anything shaped `{type:'cli', name}`; nothing cryptographic.
- Why it matters: any local process running as the same user (and, on a permissive POSIX socket dir, potentially other local users) can drive paid runs, mutate/delete projects, and trigger binary detection, with no audit identity. The "dropped connection never cancels" design is good for reliability but also means a malicious/rogue start keeps spending after disconnect.
- Fix: require proof of local identity — e.g., a per-launcher secret file under the launcher home (mode `0600`) presented in `hello`, or OS peer credentials (Windows named-pipe impersonation/`GetNamedPipeClientProcessId` + process-image check; POSIX `SO_PEERCRED` + uid check). Add explicit confirmation/flag for mutating and paid commands, and log caller identity + command.

### F2 — Pipe path is predictable and low-entropy; POSIX socket squatting risk (Verified) — Severity: Medium

- Files/lines: `packages/shared/src/cli-ipc.ts:52-54` (32 MB caps), `:74-90` (`launcherHomeScope()` → `sha1(...).slice(0,12)`; `cliPipePath()` → `join(tmpdir(), tag-scope.sock)` on POSIX, fixed `\\.\pipe\...` name on Windows).
- Why: 48-bit truncated SHA-1 of a guessable path is not a secret; `/tmp`-family sockets are vulnerable to pre-creation/squatting and permissive-umask exposure. `EADDRINUSE` handling (`cli-server.ts:91-118`) reports "already owned" but cannot distinguish attacker squat from a second instance.
- Fix: bind with exclusive create, set restrictive DACL/`umask`/`chmod 0700` dir + `0600` socket, verify ownership/permissions before listen, and consider a per-install random suffix stored in the launcher home rather than a pure hash of a predictable path.

### F3 — Desktop boundary validation is shape-only for paths/prompts; enforcement depends on unread runtime code (Verified client side; server side = gap) — Severity: Medium

- Files/lines:
  - `apps/desktop/src/main/services/desktop-service.ts:26-38` (`StartRunOptions`: `includePaths` ≤100×≤500 chars, `instructions` ≤5000 chars, `agentStackIds` 1–10×≤200 chars — no charset, normalization, or confinement checks).
  - `:94-121, :133-135` — `addProject`/`updateProject` length-check then `host.prepareSourcePath` (implementation not inspected).
  - `:27-29` — `RunId/IssueId/RetestRunId` use strict ULID regexes (good), but `ProjectIdInput (:26)` is `min(1).max(200)` free text.
- Why: renderer/CLI-controlled strings flow into `runs.start`/`projects.add/update`. If the runtime trusts them for filesystem scoping, traversal/symlink confusion or prompt-injection-adjacent content reaches the agent context. I did **not** read the runtime handlers, so exploitability is a hypothesis; the missing server-side check is the finding.
- Fix: canonicalize + confine `includePaths`/`sourcePath` server-side (normalize, resolve symlinks, enforce containment in the project root, reject absolute/parent refs and NUL bytes); tighten `projectId` charset server-side; treat `instructions` as untrusted model input (wrap/delimit, never interpolate into shell).

### F4 — Export write is not atomic and trusts dialog path without hardening (Verified) — Severity: Low

- Files/lines: `apps/desktop/src/main/services/export-save.ts:49-86` (temp sibling + `rm(destination,{force:true})` + `rename`; dialog-owned destination, canonical artifact bytes), `:88-99` (saved-export allowlist is an in-memory `Set`, reset every restart).
- Why: remove-then-rename is not atomic (crash leaves no export; concurrent readers see absence), and a dialog-selected symlink/existing file is removed rather than exclusively created — destructive rather thanhre exfiltrative, but still surprising. In-memory allowlist means post-restart "reveal in folder" fails closed (safe direction) at the cost of UX.
- Fix: create temp file with `O_EXCL`/`0600`, `fsync`, rename without pre-`rm` where the platform allows (or accept Windows limitation explicitly); consider `O_NOFOLLOW`-style handling or warning when the destination is a symlink; persist the allowlist only as hashes if cross-restart reveal is needed, or keep fail-closed and document it.

### F5 — Loopback auth proxy is a documented bounded oracle; key-safety claims rest on unread relay code (Verified design; relay = gap) — Severity: Low (as documented) / Medium if allowlists regress

- Files/lines: `packages/harness-opencode/src/proxy.ts:6-30` (real key heap-only; dummy key to OpenCode; "reachable over loopback, so a deliberately hostile tool could use it as a bounded oracle" contained by "ephemeral per-run port, exact model+route allowlists, loopback-only bind, lifetime tied to AgentRun, no body logging"), `:32-70` (`SENTRY_PROXY_DUMMY_KEY`, fixed upstream `https://openrouter.ai/api/v1`, explicit `PROXY_ROUTES`/`UPSTREAM_PATHS`, minimal forwarded headers), `:88-120` (empty-key fail-closed; `upstreamBaseUrl` overridable; `/v1/models` stub).
- Why: good design — but I did not read the relay path (lines 121+) that must enforce: bind address = `127.0.0.1` (not `::`/all), exact route+model match per request, bounded body size/timeouts, no request/response body logging, proxy close on run end, and upstream restricted to https-allowlisted hosts (the overridable `upstreamBaseUrl` is an SSRF/key-misdirection risk if ever fed untrusted input).
- Fix: verify/pin those five; forbid non-HTTPS upstreams; cap body bytes; assert `server.address()` is loopback in tests; add a regression test that a wrong-model/wrong-route/oversized request is rejected and the real key never appears in env (`process.env`), argv, files, or logs.

### F6 — Error sanitization truncates but forwards runtime text (Verified) — Severity: Low

- Files/lines: `desktop-service.ts:40-55` (`sanitizeError` keeps `{code, message}` sliced to 100/1000 chars), `:64-71` (thrown to caller → IPC/CLI surface), `cli-server.ts:91-118` (broker errors pass through `sanitizeBrokerField`, not read in full).
- Why: runtime messages often embed absolute paths, usernames, repo names, or provider hints; forwarding them to renderer logs/CLI output leaks host layout and aids phishing/social engineering. 1000 chars is plenty for a secret-bearing line.
- Fix: allowlist error codes at the boundary, replace messages with generic text by default, redact path-like/secret-like patterns if passthrough is ever needed, and keep detailed errors in a main-side/runtimeside diagnostic log only.

### F7 — Snapshot manifest parsing has no resource/schema caps (Verified locally; walk/scan side = gap) — Severity: Low

- Files/lines: `packages/snapshot-engine/src/index.ts:59-85` (streams NDJSON, skips malformed lines, validates `sha256` hex, but unbounded entries/Map growth; `relativePath` used un-normalized as key), `:94-107` (hash aggregate over `JSON.stringify(entry)` lines from `walkTree`/`snapshotEntry`, not inspected).
- Why: a corrupt/giant manifest (or hostile working copy producing huge entries) can balloon memory/CPU during `baselineFileHashes`; un-normalized keys risk duplicate/confused entries.
- Fix: cap line length/entry count/total bytes, normalize `relativePath` (POSIX, no `..`, no absolute, no NUL), fail closed over a threshold, and review `walkTree`/`snapshotEntry` symlink/reparse-point policy (unread).

### F8 — Credential store not present in this copy; encryption unverified (Gap, not a finding of plaintext) — Severity: Unknown (action required)

- Files/lines: references only — `apps/desktop/src/main/bootstrap.ts:65,69` (`new ProviderCredentialService… load()`), `desktop-service.ts:14,22,286-296` (statuses-only surface), plus test references to `src/main/services/provider-credentials.ts`, which does not exist in the listed `services/` directory (`desktop-service.ts`, `export-save.ts`, `wsl-runtime-client.ts` only).
- Why it matters: the "safeStorage credentials" claim (`desktop-service.ts:7`) cannot be confirmed here — algorithm, file permissions, DPAPI/keychain usage, memory zeroization, and backup/ACL exposure are all unknown.
- Fix: produce/verify the module; confirm OS-keystore-backed encryption at rest, `0600`/ACL files, no key material in logs/errors/renderer payloads, and presence-only diagnostics (the `--sentry-credential-status` path in `index.ts:300-323` must print booleans only — I saw only search snippets, not the full code, so re-verify).

## 4. Prioritized summary

1. **Authenticate the CLI broker (F1) + harden the pipe (F2)** — highest leverage: the broker exposes paid/mutating commands to any local claimant.
2. **Prove runtime-side confinement (F3):** read `apps/runtime/src/runtime.ts` handlers, `run-engine`, `persistence` (`resolveInside`/`copyTree`/`scanTree`), `workspace-factory`, and `host.prepareSourcePath`; add canonicalize-and-contain checks plus hostile-path tests.
3. **Verify the credential store (F8)** end-to-end (at rest, in memory, in logs, across backup/ACLs).
4. **Error/log redaction (F6)** and **proxy relay verification (F5)** — cheap, prevents slow leaks.
5. **Lower IPC caps / stream large payloads (F2)**, **atomic export writes (F4)**, **snapshot caps (F7)**.

## 5. What I did not inspect (honest scope limits)

- `apps/runtime/src/runtime.ts` (handlers), `host.ts`, `index.ts`; `apps/cli/*`; `apps/desktop` preload, renderer, `ipc.ts`, `desktop-command-router.ts`, `platform/*`, `wsl-runtime-client.ts`, `stdio-runtime-client.ts`, `runtime-client.ts`, `cli-server.ts` beyond line 150.
- `packages/runtime-protocol/*`, `run-engine/*`, `harness-opencode` `process/env/scope/toolshell/*` and `proxy.ts:121+`, other harnesses, `persistence` path/copy/scan code, `workspace-factory`, `shared` beyond `cli-ipc.ts:1-100`, schemas/verification/exporter logic.
- Supply chain: lockfiles, pnpm catalogs/versions, postinstall scripts, launcher/installer scripts, CI/workflows, container/WSL setup.
- Dynamic behavior: ran no builds, tests, or scanners; reviewed no git history or live IPC traffic.

Net assessment: the boundaries I could verify show a security-aware design (typed contracts, allowlists, statuses-not-secrets, dialog-owned export paths, heap-only proxy key, strict run/issue ID formats, timeout reconciliation for paid runs). The audit is limited by large unread areas: the highest-risk unknowns are the runtime's server-side path/command enforcement, harness subprocess isolation, the missing credential-store implementation, and the unauthenticated local CLI broker.