# M5 — Controlled Internet

Source baseline: `f72df57` (M4 accepted). M5 source commits: `b6a48ba` (feature) and `134cf4d` (daemon refuses Controlled
unless commands run in place). **Final source SHA: `134cf4d`** (this report is a docs-only commit on top). Local commits only.

## 1. Architecture

```
 command sandbox (own empty netns: loopback only)          host
 ┌──────────────────────────────────────────┐   unix socket   ┌─────────────────────────────┐
 │ npm / pip / cargo / git / curl / node    │  /nexus/egress  │ nexus-egress (per execution) │
 │   HTTP(S)_PROXY=127.0.0.1:3128           │ ◄─────────────► │ own bwrap: /usr, resolver    │
 │ in-sandbox bridge (forked by nexus-confine│                 │ files, its socket dir only   │
 │ after Landlock): TCP ↔ unix socket        │                 │ policy = grant's NetPolicy   │
 └──────────────────────────────────────────┘                 └──────────────┬──────────────┘
                                                                              ▼ approved host:port only
```

* `nexus-egress` is a separate unprivileged process started by the daemon per execution, outside the command sandbox. It
  has no access to project files, credentials, checkpoints or Nexus data (its sandbox binds only `/usr`, resolver files and
  its own socket directory; seccomp applies; it is **not** Landlocked — bwrap + seccomp only).
* The command sandbox never receives host networking in Controlled mode. The only route out is the bridge → egress. If
  egress is missing, untrusted (protocol handshake `vet_binary`), or dies, commands get a refusal / connection errors; no
  fallback to host networking exists (tested: kill the gatekeeper mid-run → later requests fail, the server sees nothing).
* Transports: HTTP `CONNECT` (HTTPS and any TCP through the proxy), absolute-URI HTTP (forwarded in origin form, one
  request per connection, `Connection: close`), fixed local-port forwards (`NEXUS-FORWARD <port>` → 127.0.0.1 only).
  **Not supported:** SOCKS, UDP/QUIC/HTTP3, ICMP, raw TCP clients that ignore proxy settings, SSH. These fail inside the
  sandbox (no route) with the client's own error; they are not bypassed. No TLS inspection.
* Connection-time enforcement: names only (IP literals refused); host+port must match the frozen policy; resolution is done
  by the egress process with a timeout; every answer is filtered (loopback, private, link-local/metadata, CGNAT, documentation,
  benchmarking, multicast, reserved, and IPv6 forms embedding those); the connection goes to the validated address (no
  re-resolution); redirects are re-judged as new requests; limits on connections, lifetime, idle time and total bytes;
  the audit records host/port/bytes/outcome only — never URLs, query strings, headers or bodies.
* **A hostname allowlist is not data-loss prevention.** The consent text says so verbatim: it limits *where* commands connect,
  not *what* they send; anything a command can read (source, secrets it can see) can be sent to an allowed destination.

## 2. Permission and consent behaviour

* One permission system: the project's standing grant gained `exec.net: NetPolicy{hosts[{host,ports}], local_ports}` with
  `net: controlled`. It is covered by the grant digest, shown in the consent text, and bound to every operation via
  `sandbox.netPolicyDigest`. Presets (npm, pnpm, yarn, cargo, pip, github, gitlab, go) are expanded into explicit hosts at grant time.
* Frozen per task. Widening reaches **new tasks only** (tested: a running task cannot reach a host added mid-run). Narrowing
  intersects frozen ∩ current: the gatekeeper cuts in-flight connections (6 ms measured) while the command continues.
  Revocation/expiry ends the gatekeeper and the command (tested through the broker on a Direct project).
* Ask uses the existing trusted approver path (a held command does not run); Auto never authorizes outside the grant.
  Unknown destinations are refused with a message naming the host:port and the cause so the owner can decide.
* Controlled requires filesystem scope `workspace` (in place, isolated copy or Direct) and the launch gate; scratch +
  controlled is refused at grant validation and, defensively, in the daemon. Full Network / Full Access remain unimplemented.
* Exposure: CLI flags (`--net controlled --allow-host … --net-preset … --allow-local-port …`), Desktop Permissions panel
  (disabled with a reason when the gatekeeper is missing or commands cannot run in place), Tauri command, broker verbs.
  The model has no argument to name a network, proxy or destination (tested).
* Legacy `install` network class retained and labelled distinctly (`network: "install"` = host network, not Controlled).

## 3. Toolchain compatibility (real tools, local fixtures reached via the real egress, test-hook name mapping)

| Tool | Result | Notes |
|---|---|---|
| npm install | **works** | `--registry http://registry…/`; lockfile + node_modules created; denied host → install fails, denial names host:port |
| pip install | **works** | `--index-url … --trusted-host … --target` |
| cargo fetch/run | **works** | sparse registry source-replacement via project `.cargo/config.toml` |
| git clone (HTTP) | **works** | dumb-HTTP fixture; real git over HTTPS uses CONNECT (covered by the TLS case) |
| git over SSH | unsupported | no route; fails by itself (documented; use HTTPS remotes) |
| curl / wget over HTTPS (CONNECT, self-signed fixture CA) | **works** | CA must be a readable non-secret-shaped file (the sandbox hides `*.pem`) |
| Node `fetch` | **works** with `NODE_USE_ENV_PROXY=1` (set by Nexus); without it fails `EAI_AGAIN` — no bypass |
| localhost dev endpoint (granted port) | **works** | other local ports unreachable |
| pnpm | **not tested** | not installed on this host; uses the same proxy variables as npm |
| SOCKS / UDP / raw TCP / DNS | unsupported | fail inside the sandbox |
| Live internet | **not run** | no destinations were authorized for live acceptance |

## 4. Negative security tests (real namespaces, real egress service)

Unapproved domain refused; IP literals refused; non-listed port refused; redirect to an unapproved host refused (target
never contacted); DNS rebinding answers (10/8, 127/8, 169.254.169.254) refused for allowed names; `--noproxy`, own proxy
settings, direct IP, raw TCP, UDP, DNS: no route; proxy-env override cannot widen; local-port forwards limited to the granted
ports; gatekeeper death → refusal, nothing reaches the server; missing egress binary → command not run; cancellation <8 s
(84 ms measured); narrowing cuts in-flight connection; revocation ends the transfer; widening never reaches a running task;
query secret built at runtime appears nowhere in Nexus data; model cannot supply net/proxy/destination args; production
profile rejects the `--egress-test-*` hooks; Offline unchanged (no proxy env); Scratch refuses Controlled.

## 5. Direct Workspace acceptance (broker + daemon + Kernel + sandbox + egress, Direct project)

Commands run in place in the real folder and write there; the M3A ledger record carries a `network` summary
(destinations, denied, bytes, connections) without URLs or secrets; M3B checkpoints still restore (the command's file was
removed by guarded restore); revocation produced an `outcome: partial` record. **Truthfulness limits:** a package install
creates a bulk directory (`node_modules`) that is summarised, not claimed per file, and cannot be claimed fully recoverable;
network effects on remote services are never undone.

## 6. Performance (release build, loopback fixtures; `perf_m5_measurements`, ignored test)

| Measure | Direct | Via sandbox + gatekeeper |
|---|---|---|
| small request (curl process included) | 11–12 ms | 15 ms (+3–4 ms) |
| sandbox + gatekeeper startup (empty command) | – | 70–87 ms |
| 512 MiB download | 0.21 s (≈2.4 GiB/s) | 0.52 s (≈990 MiB/s) |
| gatekeeper peak RSS during the download | – | 2.9 MiB (streams 64 KiB; no buffering) |
| gatekeeper CPU for 512 MiB | – | 0.31 s |
| cancel → execution returned | – | 84 ms |
| narrowing decision → in-flight transfer cut | – | 6 ms |
| policy check | – | ≈15 µs per host check (51-rule policy) |

Real DNS latency and WAN throughput were not measured (fixtures + name mapping). Package install time was not compared to a
host-network baseline (fixtures resolve only through the gatekeeper); the six-test toolchain suite incl. npm, pip, cargo,
git and TLS ran in ≈10 s total.

## 7. Unsupported tools and residual risks

* HTTP is one request per connection (`Connection: close`): correct but slower for chatty HTTP clients; HTTPS tunnels are unaffected.
* No SOCKS/SSH/UDP; clients ignoring proxy variables fail rather than bypass.
* Hostname allowlist ≠ DLP (see §1). Wildcard rules (`*.cdn…`) widen to every subdomain the owner's DNS names.
* DNS answers are trusted after the forbidden-range filter; a malicious *public* resolver answer for an allowed name reaches a public IP.
* Local-port forwards expose host services the owner explicitly names.
* The egress process is protected by bwrap + seccomp but not Landlock.
* Sandbox hides credential-shaped files (e.g. `*.pem`) from commands, which affects custom CA bundles in the project.

## 8. Validation (final SHA `134cf4d`, tree clean)

* `cargo fmt --check` and `clippy --workspace --all-targets -D warnings`: clean (native and Tauri).
* Native battery (`NEXUS_REQUIRE_SANDBOX=1`): **1466 passed, 0 failed, 63 ignored**.
* Tauri: all suites pass. Desktop: `tsc`, `eslint` clean; vitest 188/188.
* Release gate: PASS — registry-js 22/22, engines 148, e2e 36, production 14 (no test-only symbols), 5 release executables
  (incl. `nexus-egress`) clean, bodies: 156 tests / 1617 bodies, **0 unexplained** (identical 1438, volatile tool output 169,
  order-only 10, polling-count-only 0) — provider request-body parity preserved.
* A first full run on `b6a48ba` was green except one daemon unit test (Controlled with scratch scope not refused in the
  daemon's defensive path); fixed in `134cf4d` and the whole script re-run.

## 9. Recommendation

**GO for M6 — Universal Developer Toolchains & Git**, with live
destinations authorized by the owner before any live acceptance.
