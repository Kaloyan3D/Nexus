# Nexus × DSH `gateway/authorize` — compatibility and integrity spec

Status: P2-B2B. Applies to managed Nexus task admission (`nexus submit`, the GUI task route and every managed-session effect). Companion to the [P2-B2A report](NEXUS-PLUGIN-FIRST-P2B2A-REPORT.md) (hook design) and the [P2-B2B report](NEXUS-PLUGIN-FIRST-P2B2B-IMPLEMENTATION-REPORT.md) (implementation and evidence).

## 1. What Nexus needs from DSH

One per-operation authorization seam on the Typert gateway that also applies to the **owner** principal. Pinned DSH `0.2.2-rc.1` (`66491b05`) skips `remoteAccess.decide` for owners and has no other per-call seam, so an owner peer (the local browser, any process holding the launch token) can mutate a managed session through ~28 gateway operations. Without the seam, managed admission stays disabled.

The proposed hook (upstream-ready patch: [`evidence/p2b2b/dsh-gateway-authorize.upstream.patch`](evidence/p2b2b/dsh-gateway-authorize.upstream.patch)):

| Property | Contract |
|---|---|
| Event | `gateway/authorize`, dispatched with `ctx.serial` |
| Listener input | Frozen `structuredClone` of `{ principal, action, resources, args, transport }`. `action` is `<namespace>/<method>`, `$events` or `$events/result`. `resources` is `undefined` when the arguments can't be attributed. `transport` is `'unary'` or `'stream'`. For `$events/result`, `resources` is `[{ kind: 'global' }]` and `args` is `{ event, agentId, outcome }`. |
| Listener output | `undefined` = abstain. `{ kind: 'deny', reason }` = refuse. |
| Fail-closed rules | A listener that throws refuses with reason `authorization-failed`. Any other return value refuses with `authorization-invalid`. The first refusal wins regardless of registration order. |
| Position | After the legacy non-owner decision, which it can never relax. Before receiver resolution, so a refusal activates nothing and has no side effect. |
| Coverage | HTTP unary, WebSocket stream (`wireStream.open`), `$events` and `$events/result` |
| No listener | Byte-for-byte today's behavior. The upstream suite passes 609/609 before the patch and 621/621 after it (12 new tests). |

## 2. How Nexus verifies the hook (startup, every host)

`config/nexus/controller.cjs` → `verifyGatewayHook(ctx, appRoot)` runs only when **all** of these hold: installation ownership is `held`, the DSH services (`sessionController`, `sessionPersistence`, `sessions`, `workspaceRegistry`, `typertGateway`) are available, and the Controller is open. Steps:

1. **Integrity.** The Controller resolves `@deepseek-ai/dsh-api-gateway` from the pinned app root and takes the SHA-256 of `lib/index.js`. The digest must appear in `GATEWAY_HOOK_DIGESTS`:

   | Digest | Build |
   |---|---|
   | `12e5577b6ae0c19d2d826790f409e086513a41a33014fc45ae57d257a57a14c8` | `dsh-v0.2.2-rc.1+nexus-gateway-authorize-1` (built from the patch above with the upstream toolchain: `tsc -b` + `tsdown`) |

   The pinned production build `91abae7e…f52b` is deliberately **not** on the list. The same pipeline reproduces that build byte-for-byte from the unpatched source, which shows the patched digest comes from the patch alone.
2. **Live self-test.** The Controller registers a temporary listener that refuses only an owner `session/list` call, using a random nonce as the reason. It then invokes `session/list` (read-only, `{ _request: {} }`) through `typertGateway.invoke` with a fresh owner `Peer`. Verification passes only if all of these hold:
   - the call is refused with exactly that nonce reason
   - the listener saw a frozen request
   - the request's transport was `unary`

   The temporary listener and the Peer are removed afterwards.
3. **Result.** `setManagedGate('hook', result)`. Any failure is recorded with a reason and stays unverified. Reasons: `gateway-package-unresolvable`, `gateway-build-not-allowlisted`, `gateway-service-unavailable`, `connection-package-unresolvable`, `gateway-hook-inert`, `gateway-hook-misbehaved` (the last includes a diagnostic detail).

## 3. What happens when the hook is absent or unverified

- `core.activation()` reports `gateway-hook-unverified:<reason>`, and `admission.state` is `disabled`.
- `submit` (IPC, GUI route and in-process) answers `REQUIRED_CAPABILITY_UNAVAILABLE` with the activation problems. The CLI exits with code 4. Nothing is reserved, created, delivered or sent to a model. Real-host proof on pinned DSH: [`evidence/p2b2b/realhost-production.json`](evidence/p2b2b/realhost-production.json).
- Every step of an existing managed session or its subagents is refused at `agent/pre-step`, by both the host gate and the plane bridges. Its approvals are rejected, and its questions fail with `NO_PROVIDER`.
- The product policy listener stays registered. It is inert on pinned DSH because the event is never emitted, but it denies as soon as a verified hook exists. The Connection fetch guard (`connection/request`) and the `/nexus/*` route guard act on pinned DSH too.

No environment variable, CLI flag, settings key or debug switch can mark the hook as verified or skip any activation gate. The unit suite sets `NEXUS_MANAGED_ADMISSION`, `NEXUS_FORCE_SUBMIT` and `AIH_MANAGED` and checks that admission is still disabled. Test-only instrumentation lives in test files and the child-host harness, never in product code.

## 4. Activation gates (all required)

| Gate | Source |
|---|---|
| Installation ownership `held`, enforced | `host-ownership.cjs` kernel lock (P2-B1) |
| Durable intake store `ok` (not corrupt or unavailable) | `intake-store.cjs` load at core creation |
| Hook verified (§2) | `verifyGatewayHook` |
| Gateway policy listener installed | host `apply`, before the service is provided |
| Connection fetch-route guard installed | host `apply` |
| Approval broker installed | host `apply` |
| `/nexus/*` route guard attached | the UI plugin announces it via `attachRouteGuard`. Unloading the plugin detaches it. |
| Workspace exclusivity guard installed | host `agent/pre-step` |
| DSH session services available | `ctx.inject([...])`. Losing them deactivates admission. |
| Managed ports bound | host `apply` |
| Intake reconciled after start | `managedTasks.reconcile()` |
| Platform qualified | `QUALIFIED_PLATFORMS = ['darwin']`, the only native real-host evidence |

## 5. Upgrade and rollback rules

- **DSH upgrade:** a new gateway build has a new digest, so admission turns off by itself. To re-enable it:
  1. Rebuild the hook from upstream, or from the patch rebased onto the new release.
  2. Run the upstream gateway suite.
  3. Run `NexusGatewayAuthorization` (28 rows) and `NexusManagedTasks.RealHost` (patched mode) on every platform being claimed.
  4. Only then add the new digest to `GATEWAY_HOOK_DIGESTS`.

  If upstream adopts the hook, replace the digest allowlist with a version range check. The live self-test stays either way.
- **Installation (when authorized):** the installer would write the patched `lib/index.js` atomically, inside the published closure step, and verify the digest before and after. Hosts verify it again at startup. No installer change ships in P2-B2B, and the production dependency was not modified.
- **Rollback:** reinstall the unpatched package, or remove the digest from the allowlist. Admission refuses immediately. Existing managed sessions stay in the durable registry, remain protected by the fetch guard, the route guard and the step and approval refusals, and stay observable through status.

## 6. What the hook is not

It isn't a filesystem sandbox: agent tools write files without crossing the gateway. Nexus covers cross-session writes separately with the workspace exclusivity gate, which refuses ordinary-session steps in a workspace with a live or pending managed task. It doesn't cover in-process host code, which is trusted by design, or raw web routes. For raw routes, `/nexus/*` is guarded by Nexus, `/api/session/uploadFileBinary` by the fetch guard, and the remaining fetch routes are read-only.
