# M2 transport security review — macOS app ⇄ Linux engine

## 1. What is protected, and how the Linux engine authenticates today

* `nexusd` and `nexus-broker` listen on **Unix sockets** under `NEXUS_HOME` (`broker.sock`, `daemon/n.sock`).
  Authorization is the kernel's peer credential (`SO_PEERCRED` uid) against `--allowed-uids`
  (here `1000`); grants, approvals and issuer capabilities are issued by the kernel/broker, never by the UI.
* Provider credentials (`credentials.json`) are read only by the broker; the UI never sees them.

Peer credentials **do not survive any network hop**: a socket forwarded over SSH (`-L`, `socat`, `ssh -W`)
makes the *forwarder's* uid the peer, so whoever can reach the forwarded port inherits uid 1000 with no
authentication. M2 therefore does **not** forward the sockets.

## 2. Design

```
React UI ─(Tauri IPC, ACL)─> macos_app (Rust) ─ stdio of ─> /usr/bin/ssh ──SSH──> sshd
                                                                                   └─ forced command:
                                                         nexus-bridge --stdio (uid 1000) ─(AF_UNIX, SO_PEERCRED=1000)─> broker/daemon
```

* The bridge is an ordinary local client of the broker, **as uid 1000**, exactly like the Linux desktop.
  The broker's own peer-credential check is unchanged and still decisive.
* The only thing that crosses the network is a line protocol (`bridge_proto.rs`) with three host→guest verbs:
  `call {cmd,args}`, `confirm-reply`, `ping`. There is **no exec / shell / file / socket verb**; unknown verbs
  end the session (tested).
* `call` runs through the **real registered Tauri handler and ACL** of the Linux command layer
  (`build.rs` manifest + `capabilities/main.json`), so validation, idempotency, grants and approvals are the
  existing code. The bridge additionally refuses `project_pick` and `run_mock`.
* Native confirmations requested by the guest are shown **on the Mac** (NSAlert, default button = Cancel);
  if a dialog cannot be shown, or the link drops, the answer is *deny*. Folder picks, secrets and URL opening
  from the guest fail closed.

## 3. Identity and authorization boundary

| Boundary | Mechanism |
|---|---|
| Mac → guest identity | SSH public-key auth with a dedicated key (`~/.ssh/nexus_engine_app_ed25519`, no password, mode 600) |
| Guest → Mac identity | Pinned host key (`engine_known_hosts` in the app's config dir), `StrictHostKeyChecking=yes`; a changed key is refused (verified) |
| What the key can do | `authorized_keys`: `restrict,command="env … nexus-bridge --stdio"`. `restrict` disables pty, agent/X11/port forwarding and `~/.ssh/rc`; the forced command ignores any command the client sends (verified: `id; touch /tmp/PWNED` did not run, `-L` gave nothing) |
| Renderer → backend | Unchanged Tauri ACL: only the allowlisted command names, with the same JSON arguments; the renderer cannot reach the transport, key, host or bridge |
| ssh invocation | fixed argv; `BatchMode`, `IdentitiesOnly`, no agent/forwarding, no ControlMaster; `host`/`user` validated so they cannot become ssh options |

## 4. Residual risks (accepted for the prototype, listed honestly)

1. **Key = uid 1000 on the engine.** Anyone who steals the app key can speak the bridge protocol, i.e. act as
   the Linux desktop would (submit tasks, change grants *the UI is allowed to change*). It cannot get a shell
   or forward ports. Mitigation later: Keychain-held key, per-connection challenge, or a guest-side token.
2. **Compromised guest** can show misleading text in a native confirmation. Dialogs are bounded in size and
   labelled by the Mac app, not by the guest.
3. **Private-network host key trust** relies on the key pinned at setup time (verified against the guest's
   `/etc/ssh/ssh_host_ed25519_key.pub` over the already authenticated admin channel, fingerprint
   `SHA256:Xn69pdx4…`). A rebuilt VM needs re-pinning (refusal, not silent trust).
4. **Disconnect semantics**: a call whose reply is lost reports "may or may not have reached the engine";
   nothing is auto-retried. Re-sending relies on the existing idempotency keys.
5. **Guest build path / environment** (`NEXUS_HOME`, binary dir) is fixed in the forced command; the
   `nexus-bridge` binary is a debug build from the guest checkout.
6. The development admin key (`nexus_engine_ed25519`, full shell) was used only to set this up and test;
   remove its `authorized_keys` line when finished. A backup of the original file is
   `~/.ssh/authorized_keys.pre-m2`.
7. Denied by design / not done: no TCP listener on the guest, no daemon or broker exposure, no change to
   the Linux sandbox or kernel policy.

## M3 addendum — project transfer and verified writeback

* New verbs (`ToGuest::Sync`, protocol 2): stage-begin/changes/chunk/status/commit/abort, export-plan/read/ack, discard. Each names
  an authorized project id (`[a-z0-9-]{1,48}`) and is resolved only under the guest's Nexus-owned root (`~/NexusMac/<id>/…`);
  relative paths are validated (no `..`, absolute, backslash, NUL, control characters, protected names). There is still no exec,
  shell or generic file verb. Export reads only files named by the plan the guest itself computed, re-hashed at read time.
* Consent and the baseline are **Mac-only** (registry in the app's data directory). The guest cannot grant, widen or read them; a
  writeback additionally requires the engine's own `verified-passed` verdict, no cancellation/error, and no conflict.
* The Mac re-validates every path and hash from the guest, treats a plan that names protected paths as an engine fault (nothing
  applied), compares each affected file with the Mac's recorded baseline, and never writes through symlinks.
* Delegated cgroup: the forced command now runs `systemd-run --user --scope -p Delegate=yes … nexus-bridge --stdio`, because the
  engine's sandbox needs a delegated cgroup to (re)start its daemon from an SSH session. The bridge exits after 90 s of silence so a
  cut network cannot leave an orphan session. Residual risks above (key = uid 1000) are unchanged.

## M4.1 addendum — browser evidence over the bridge

* No new protocol verb. The Mac reads a stored screenshot with the existing `call` verb and one new registered command, `intent_browser_artifact { runId, evidenceId, file }` (read-only; in `build.rs`, the capability file and the handler list, which the allowlist test keeps equal).
* The broker authorizes by run ownership like every other `intent_*` read, resolves only `<state>/browser/<run>/<call>/<file>` where `<file>` must be a screenshot the stored evidence itself lists (a file name of `[A-Za-z0-9._-]`, never a path, never `evidence.json`/`report.json`), re-checks the size bound and returns the bytes with their SHA-256. Unit tests cover traversal, foreign evidence ids and non-screenshot files.
* The browser itself runs inside the engine, started by the broker; nothing on the Mac reaches it and the bridge gained no way to start a process. Chromium's sandbox stays on; the page can reach only the project's own files and an authorized loopback preview.
