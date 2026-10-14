# A2.1 Deployment: OS service identities for `nexusd` (BLOCKED here)

> Status in this development environment: **BLOCKED**. The identities below do
> not exist here (creating host users/services requires explicit authorization
> and was not attempted). The daemon code, the isolated test harness
> (`native/nexus-daemon/tests/isolation.rs`), and this configuration are
> implemented; production readiness stays **BLOCKED** until a host with these
> identities proves the boundary with genuinely distinct UIDs.

## Principals

| Principal | Linux identity | May access |
|---|---|---|
| `nexusd` service | `User=nexusd` (`UID` dedicated, no login) | DataRoot (owner, `0700`), witness DB, socket, cap file. Only writer of kernel persistence. |
| Trusted issuer bridge (Controller + JS Registry delivery channel) | `User=nexus-issuer` (dedicated, no login, no shell) | IPC socket **client** only. Holds the ephemeral capability key in memory per daemon incarnation. Never writes store files directly. |
| Untrusted model/tool processes | Per-workload UIDs (e.g. `nexus-model-*`, or one `nexus-untrusted` UID) | **No** DataRoot access, **no** socket access, **no** cap file access. They receive only sealed, already-authorized work descriptions over a separate, non-privileged channel (future A2.2+; not present in A2.1). |

## Directories and permissions

```text
/var/lib/nexusd                 owner nexusd:nexusd        mode 0700   # DataRoot: k.db, k.witness.db, daemon.lock
/var/lib/nexusd/issuer.cap      owner nexusd:nexusd        mode 0600   # ephemeral per-incarnation HMAC key, rotated each start
/run/nexusd                     owner nexusd:nexus-issuer mode 0750   # dedicated IPC dir (NOT the DataRoot)
/run/nexusd/n.sock              owner nexusd:nexus-issuer mode 0660   # set by the daemon at bind; untrusted UIDs get EACCES
/run/nexusd/issuer.handoff      owner nexusd:nexus-issuer mode 0640   # group-readable key copy, rotated each start
```

The daemon enforces this at startup (`verify_protected_dir`): the DataRoot
(and a custom socket parent outside it) must be owned by the daemon euid with
**no group/other bits**, or the daemon refuses to start with
`insecure-dataroot` and never binds the socket. Fresh directories/files are
created under `umask 0077`, so store, WAL, cap, and socket are owner-only even
if a later chmod is missed.

> Single-UID shadow-test (this environment) keeps DataRoot `0700` + socket
> inside the DataRoot: the trusted issuer runs as the **same UID** as the
> daemon, so a hostile same-UID peer can read `issuer.cap` and impersonate
> the bridge. That is the documented A1.3/A2.0 limitation, pinned by test,
> and the reason production is BLOCKED. The multi-UID layout above is the
> only supported production shape.

## Socket sharing for production (implemented; explicitly selected)

With the strict `0700` startup check, a *distinct* `nexus-issuer` UID cannot
traverse the DataRoot to reach a socket inside it. The closure implements the
sharing layout as an explicitly selected configuration (default behavior is
unchanged and byte-identical to A2.1). Production therefore uses
**both** of the following (implemented in the closure; refused fail-closed when
violated):

1. A socket directory outside the DataRoot owned by `nexusd` with group
   `nexus-issuer` access (e.g. `/run/nexusd` mode `0750`), plus a socket-file
   policy that grants the issuer group connect rights without granting store
   access.
2. A dedicated socket-parent check (`verify_socket_dir`: canonicalized path,
   symlink-leaf refusal, daemon-uid owner, exact `--socket-group` group, mode
   exactly `0750`) that only applies when `--socket-group` is passed AND
   `--allowed-uids` is configured (sharing without peer authorization refuses
   with `insecure-socket-dir`). The socket node is set to `0660` group issuer
   after bind (`secure_socket_file`, validated). The DataRoot `0700` check is
   never weakened, and the socket directory must live outside the DataRoot
   (either nesting direction refuses). Proven by the shared-mode integration
   tests; genuine cross-UID proof requires the MULTUID-PROCEDURE.md host.

Do not chmod the DataRoot to `0750` as a workaround: group traverse rights on
the DataRoot would let the issuer UID read/replace store files directly,
defeating the witness separation. The store and the socket must live under
different directory policies.

## Daemon invocation (production shape)

```sh
nexusd --db /var/lib/nexusd/k.db \
  --witness /var/lib/nexusd/k.witness.db \
  --socket /run/nexusd/n.sock \
  --cap /var/lib/nexusd/issuer.cap \
  --trust-mode shadow-test \
  --allowed-uids "$(id -u nexus-issuer)" \
  --socket-group nexus-issuer \
  --cap-handoff /run/nexusd/issuer.handoff
```

- `--allowed-uids` lists the **connecting process UIDs** authorized for
  privileged commands (`acquire`/`seal`/`accept`), enforced per-connection via
  real `SO_PEERCRED` (never self-asserted). A valid capability tag alone is
  insufficient: non-allowlisted UIDs get `peer-unauthorized` even with a
  correct HMAC. Absence of the flag preserves the documented same-UID
  limitation and is BLOCKED for production.
- `--socket-group` (GID or group name) selects production sharing: the socket
  parent must be exactly `0750` daemon-uid-owned with that group, the socket
  node becomes `0660`, and sharing without `--allowed-uids` refuses startup.
  The issuer bridge passes `daemonCapPath: /run/nexusd/issuer.handoff` to
  `native-shadow-daemon.cjs` (existing option, no JS change needed).
- `--cap-handoff` writes a `0640` group-readable copy of the per-incarnation
  key inside the shared socket directory (`O_NOFOLLOW`, symlink refusal,
  placement validated, removed at shutdown). The `nexus-issuer` UID
  authenticates with ZERO read access to the DataRoot or `issuer.cap`.
  Requires `--socket-group` + `shadow-test`; a stolen copy is still
  insufficient without a matching allowlisted peer UID.
- `SO_PEERCRED` authenticates the connecting **process**, never which
  JavaScript module produced a request. Same-UID module confusion (a hostile
  thread/module inside the issuer process) is out of scope of this gate and
  must be handled by issuer-process hardening (separate future work).
- `dispatch_enabled()` remains `false`; `authorize_dispatch()` refuses every
  request. No model inference, tool execution, external dispatch, MCP/Code
  Mode, DSH migration, or completion authority is enabled by this setup.

See `nexusd.service` in this directory for the systemd unit (uses the same
flags with `User=nexusd`, `SupplementaryGroups=nexus-issuer`, `UMask=0077`,
`RuntimeDirectory=nexusd` + `RuntimeDirectoryMode=0750`, and `ReadWritePaths`).
See `MULTUID-PROCEDURE.md` for the genuine multi-UID verification run.

## Creating the identities (operator steps, NOT executed by this task)

```sh
# Requires host authorization; do not run in unprivileged dev containers.
useradd --system --no-create-home --shell /usr/sbin/nologin nexusd
useradd --system --no-create-home --shell /usr/sbin/nologin nexus-issuer
install -d -o nexusd -g nexusd -m 0700 /var/lib/nexusd
install -d -o nexusd -g nexus-issuer -m 0750 /run/nexusd
# nexusd must resolve the socket group (member via SupplementaryGroups= in nexusd.service)
```

## Verification required on the target host (before un-BLOCKing)

1. Start the daemon as `nexusd` with `--allowed-uids <issuer-uid>`.
2. As `nexus-issuer`: complete one `acquire -> seal -> accept` shadow flow
   over the socket (valid cap) — must succeed; store/witness/cap files must
   remain `0600`/`0700` and unreadable to the issuer UID directly
   (direct `cat` of the DB/cap as `nexus-issuer` must fail with `EACCES`).
3. As an untrusted UID: replay the same valid capability tag — must be
   refused `peer-unauthorized`; unauthenticated and replayed frames must be
   refused `issuer-untrusted`/`replay-rejected`; direct CLI mutation while the
   daemon lives must be refused `daemon-owns-store`.
4. `readiness` must report `NOT_READY` with `dispatchEnabled: false` and the
   transport posture (`peerUidEnforced: true`).
5. No permissive fallback: chmod the DataRoot to `0755` and confirm the
   daemon refuses startup with `insecure-dataroot` and binds no socket.
