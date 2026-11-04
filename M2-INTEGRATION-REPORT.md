# M2 — macOS Nexus.app ⇄ Fedora Linux engine

Status: **bridge works end to end; a real task ran from the Mac transport and completed `verified-passed`.**
**Not verified: the Nexus.app window itself** (no screenshot/click access in this session). Nothing committed.

## 1. Audit (before building)

* Guest `192.168.64.2` (UTM "ARTHUR VM", Fedora 44 aarch64, uid 1000 `kaloyan`), repo at `a8b668a` (one commit ahead of the
  Mac's `8d209f2`: dev launcher, README, `Cargo.lock` +1 line; no source conflict). `nexusd` + `nexus-broker` already running,
  `NEXUS_HOME=~/.nexus-interactive-dev`, `--allowed-uids 1000`, sockets are Unix-only.
* Peer credentials do not cross a network hop, so forwarding the sockets (`ssh -L`, `socat`) was rejected (see
  `apps/nexus-desktop/docs/M2-TRANSPORT-SECURITY.md`).
* Mac cannot link `nexus-client` (Linux-only dependency chain), so commands must be executed on the guest.

## 2. Architecture implemented

```
UI → macos_app (ACL, unchanged names) → EngineLink (engine.rs) → BridgeLink (bridge_link.rs)
   → /usr/bin/ssh (restricted key, pinned host key) → nexus-bridge --stdio (guest, uid 1000)
   → the REAL Linux Tauri handler + ACL (mock-runtime app, same Runtime/ClientConfig) → broker → daemon → sandbox
```

* **No logic duplicated**: the guest bridge dispatches into the existing `linux_app` command layer
  (`invoke_handler()` extracted so window and bridge share one list). Idempotency, grants, approvals, refusals are the existing code.
* **Protocol** (`bridge_proto.rs`): `call` / `confirm-reply` / `ping` ↔ `hello` / `ok` / `err` / `confirm` / `pong`. No exec or
  shell verb; unknown verbs end the session. Version + proto + build compatibility checked at hello.
* **Engine states** (`engine.rs`): Unavailable (fallback, no `engine.json`), Disconnected, Connecting, Ready, Busy{runs}, Error.
  Busy comes from the guest heartbeat (`active_runs`). Calls are only sent in Ready/Busy; otherwise a structured error
  (`engine-disconnected` / `engine-connecting` / `engine-error` / `engine-unavailable`), never mock data.
* **Reconnect/shutdown**: supervised child, 1 s→15 s back-off, pending calls fail with a clear "may or may not have reached
  the engine" message (no replay), ping/pong liveness, `shutdown()` on app exit; stderr tail (e.g. "Permission denied") surfaced.
* **Dialogs**: guest confirmations appear as native Mac alerts (Cancel default); folder/secret/URL from the guest fail closed.
  `project_pick` stays Mac-local and drops the chosen folder (folder sync is out of scope).
* **Diagnostics**: shown in the existing Settings "Message" / top-bar status (transport, state, attempts, engine version/user,
  guest runtime phase, round trip, last problem). No new command, no UI redesign (one TopBar line now shows the message).
* **Config**: `~/Library/Application Support/ai.arthurlabs.nexus.desktop/engine.json` + `engine_known_hosts`. Absent file = M1
  behaviour (NoEngine). `Info.plist` adds `NSLocalNetworkUsageDescription`.

## 3. Files (new / changed)

New: `bridge_proto.rs`, `bridge_link.rs`, `engine_config.rs`, `linux_app/bridge.rs`, `bin/nexus-bridge.rs`, `examples/mock_bridge.rs`,
`tests/bridge_link.rs`, `tests/live_guest.rs`, `Info.plist`, `docs/M2-TRANSPORT-SECURITY.md`.
Changed: `engine.rs` (states, `call`, diagnostics), `macos_app.rs` (forwarding handler), `linux_app.rs` (extract `invoke_handler`,
`AppState::new`, `mod bridge` behind feature), `interactive.rs` (+2 read-only accessors), `dto.rs` (`UiError: Deserialize`),
`Cargo.toml` (`engine-bridge` feature, `nexus-bridge` bin with `required-features`), `TopBar.tsx`.
Linux sandbox policy, `native/`, broker/daemon: **untouched**. `nexus-bridge` is not built by default and is not in the Mac bundle (checked).

## 4. Guest changes made (please review)

* One line appended to `~/.ssh/authorized_keys` (restricted key, forced command; backup `authorized_keys.pre-m2`) — approved by you.
  The dev admin key you installed (`nexus_engine_ed25519`, full shell) is still authorized: remove it when done.
* Source overlay from the Mac into `~/Projects/Nexus/apps/nexus-desktop` (uncommitted; `Cargo.lock` not overwritten) and a debug build
  of `nexus-bridge` in `src-tauri/target/debug`. `/tmp/test-project-backup-m2` is a copy of the test project before the task.

## 5. Real task (Stage 4) — evidence

Through the Mac-side `BridgeLink` over the restricted SSH key (same code path the app uses):

1. Connected; guest runtime `ready`, provider connected, consent given; **project `test`** listed; 1 → 2 threads; 12 model routes.
2. Submitted a real coding task via `thread_send` (idempotency key reused → `replay=true`, same run, no duplicate).
3. Run states: preparing → executing ⇄ tool-running → **completed**, finish `stop`, 39 089 in / 1 255 out tokens, ~23 s.
4. Tool evidence (`intent_activity`): `fs_list`, `fs_read`, `fs_edit README.md` (approval `automated-policy`, pre/post SHA-256),
   `proc_run node --check app.js` **exit 0 → `verification: pass`**; outcome `verified-passed`, 1 file changed (+17 lines).
5. Independent check on the guest: only `README.md` differs from the backup; the `## Usage` section is present; `node --check` passes.
6. Persistence: a new connection (fresh process, after quitting the real app) lists 2 threads including the new one.

Sandbox execution is the existing Linux sandbox (`proc_run` under the broker's policy), unmodified.

## 6. Tests

| Where | Result |
|---|---|
| Mac: `cargo fmt --check`, `clippy --all-targets -D warnings` | pass |
| Mac: `cargo test` | 21 pass, 2 ignored (live) — incl. 7 transport tests: handshake, protocol/version mismatch, Busy, crash→fail-in-flight→reconnect, confirm allow/deny, unreachable guest (ssh stderr surfaced), idempotent shutdown |
| Mac: frontend typecheck / lint / vitest | pass / pass / 253 pass |
| Live (Mac→Fedora): read path, real task | pass (above) |
| App process test: `Nexus.app` launched → 1 `ssh` child, 1 guest `nexus-bridge`; killing `ssh` → new `ssh` within ~1 s; quit → 0 local ssh, 0 guest bridges, daemons keep running | pass |
| Fedora: `cargo fmt --check`, `clippy -D warnings` (default and `engine-bridge`) | pass |
| Fedora: `cargo test --no-fail-fast` in a delegated cgroup scope with `NEXUS_REQUIRE_SANDBOX=1` | **all pass** (36 unit + all integration incl. real sandbox runtime) |
| Security probes on the restricted key | client shell command not executed; no forwarding; wrong host key refused |

Note: the first Fedora run failed `permissions_runtime_m21` with *"cannot create a cgroup: Permission denied"* because a plain SSH session
has no delegated cgroup; it passes under `systemd-run --user --scope -p Delegate=yes` (environmental, not caused by M2).
The native workspace (1 663 tests) was not re-run: `native/` is untouched.

## 7. Not verified / limitations

* **GUI not inspected** — I could not see Nexus.app. Process-level behaviour is verified; the rendering of ready/connecting states, Settings
  diagnostics text and the TopBar pill in the live window is not. Please open it and check: pill reads engine status, Projects shows `test`,
  threads list, send a task.
* A full **guest reboot** was not exercised (link loss was: killed `ssh`; and the mock-bridge crash test).
* `project_pick` from the Mac cannot open a guest project (by design, later milestone); `provider_connect` secret entry via the bridge is refused.
* Guest IP is configured, not discovered (UTM DHCP could change it). Bridge is a debug build; app key is an unencrypted file (see security review).
* Task submission from the UI itself (`ThreadSendInput` shaping) was exercised through the same command names/args, not by clicking.
