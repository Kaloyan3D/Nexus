# Nexus Registry — R4 Provider Registry & Manual API Integration

**Status:** R4 implemented on `feature/model-registry-v1`.
**Spec:** `NEXUS_REGISTRY_ARCHITECTURE.md` v0.2, Phase R4 (provider registry / manual APIs).
**Baseline:** `ca015b1f1861bd6d26e56589e7d33ec9fb546d13`.
**Suite:** `tests/RegistryR4Providers.Tests.cjs` (27 checks, offline, no credentials).
**Predecessors:** R0 21/21, R1 45/45, R2 41/41, R3 UI 29/29, R3 hardening 19/19,
installed runtime 3/3 — all still passing (see §10).

R4 lets an operator configure a supported compatible API provider through the
Nexus UI — display name, endpoint, protocol, authentication type, non-secret
metadata — add or discover a model, verify its required capabilities, save an
eligible route and select that route in a staged Engineering Mode
configuration, all without modifying production DSH routing. Production
execution stays on the existing DSH controller until R6. No R5 subscription
work was started.

## 0. Preflight fixes

**R3.1.1 lock-reclamation exception (fixed).** `config/registry/config-store.cjs`
reclaimed the store-wide mutation lock from *any* owner once the lock file
exceeded `LOCK_HARD_STALE_MS` (10 minutes), including a live owner whose
operation legitimately ran long. The hard-age path now applies the same
liveness rule as the claim path: a lock is reclaimed past the hard age only
from a provably inactive owner (dead/invalid pid) or an unreadable claim; an
alive pid keeps its lock at any age and contenders fail closed with
`write-conflict`. `config/registry/operator-catalog.cjs` implements the
identical corrected rule for the catalog lock. Regression coverage:
`R4 lock fix: live owner beyond the 10-minute hard age keeps its lock` and
`R4 lock fix: dead owner beyond the hard age is still reclaimed` in the R4
suite (plus the pre-existing H2 live-owner checks, still passing).

**Reviewed before coding:** full Registry architecture (§§5–8, 11, 13 R4, 15),
the R0–R3 deliverable docs, `config/registry/*`, `ui/nexus-controller/lib/*`,
existing provider/credential handling (`config/model-registry.json` capability
maps, `config/registry/dsh-adapter.cjs` projection, `credential://`
reference convention from `legacy-import.cjs`) and the DSH transport
substrate (existing `openai-responses` / `openai-chat-completions`
support; no Anthropic Messages adapter, no SDK agent transport — both stay
refused in R4).

## 1. Architecture

```text
browser Models & Providers panel (ui/nexus-controller/lib/client.js)
  │  GET/PUT/POST ./nexus/registry/v1/{catalog,providers,models,routes,
  │               connections,connections/status,providers/test,
  │               providers/discover,routes/verify,routes/evidence,
  │               routes/project}   (same loopback host webServer as R3)
  ▼
host adapter (ui/nexus-controller/lib/registry.cjs)
  │  bounded bodies (64 KiB) · same-origin-when-present · status mapping
  │  NO secret values in either direction · NO session/preset/settings access
  ▼
Registry service (config/registry/service.cjs — host-independent)
  │  effective snapshot = built-ins (immutable, derived) + operator overlays
  │  resolver (unchanged, authoritative) · compiler-gated saves
  ▼
new modules (pure, Nexus-owned, DSH-independent)
  provider-config.cjs   R4.2 endpoint/protocol policy (no I/O)
  operator-catalog.cjs  R4.1 revision-checked atomic operator store
  probes.cjs            R4.4 explicit discovery + capability probes (injected fetch)
  runtime-projection.cjs R4.5 dialect descriptions + future projection (no execution)
```

Ten-question review summary: single source of truth per datum (built-ins
derived from legacy configs; operator overlays owned by the catalog store;
effective snapshot re-derivable); one writer per file (shared catalog lock +
per-file revisions); dependencies point at stable Core (adapters never
imported by Core); explicit HTTP contracts (see §2); fail-closed probes,
timeouts, size caps, redaction; per-record versioning with created/disabled
lifecycle; test seams are injected fetch, fs hooks and UI seam globals;
migration is additive (new files only; built-ins untouched; rollback = delete
operator files); observability via runnable reasons, evidence records and
warning arrays; security per §7.

## 2. API contracts

Base `./nexus/registry/v1`. All mutations need the R3 origin-tuple check,
64 KiB bodies, strict schema validation and optimistic-concurrency revisions.
Conflict codes (`stale-revision`, `write-conflict`, `dependency-blocked`,
`duplicate-id`) map to HTTP 409; validation/policy codes to 422; probe
*diagnostic* outcomes return HTTP 200 envelopes (`{ ok: false, checks,
evidence, errors }`) because the probe ran and the provider did not satisfy
it — a failed probe is data, not a malformed request.

```text
GET  /catalog
PUT  /providers                 { provider, expectedRevision?, endpointOptions? }
PUT  /models                    { model, expectedRevision? }
PUT  /routes                    { route, expectedRevision? }
PUT  /connections               { connection, expectedRevision? }
POST /providers/disable         { id, expectedRevision? }   (same for models/routes/connections)
POST /providers/delete          { id }                      (same for models/routes/connections)
POST /connections/status        { id, status, attested? }
POST /providers/test            { id, connectionId? }       → { ok, evidence, errors }
POST /providers/discover        { id, connectionId? }       → { ok, advertised, errors }
POST /routes/verify             { id }                      → { ok, checks, evidence, errors }
GET  /routes/evidence?route=<id>
POST /routes/project            { id, runtime? }
```

Provider input shape: `{ id, name, transportId, baseUrl, authType?,
metadata? }`. Route creation accepts only `executionKind: raw-model`
(agent-sdk onboarding belongs to R5) and only `discovered` /
`probe-required` availability — `verified` is granted exclusively by
`verifyProviderRoute` after every required probe passes. Connections start
as `not-connected`/`unknown` and reach `connected` only through explicit
operator attestation (see §6 blocker).

## 3. Supported protocols

| transportId | R4 status | Substrate |
|---|---|---|
| `openai-responses` | supported | existing DSH path, reused via the narrow adapter |
| `openai-chat-completions` | supported | existing DSH path, reused via the narrow adapter |
| `local-openai-compatible` | supported, loopback-only unless explicitly trusted | existing path + local policy |
| `anthropic-messages` | refused (`unsupported-protocol`) | no supported adapter exists |
| `agent-sdk` / SDK dialects | refused | separate execution kind, belongs to R5 |
| `unknown` / anything else | refused | fail closed, never guessed |

## 4. Provider onboarding workflow

`Add Provider → Add Connection (reference) → Test Connection → Discover
Models → Add Model Manually / import discovered → Add/Edit Route → Verify
Capabilities → eligible in compatible Registry slots → stage in Engineering
Mode`. Adding a standard compatible provider requires no provider-specific
configuration files and no new PowerShell routine. Verification never implies
subscription entitlement; eligibility never rewrites saved assignments;
assignment never activates production execution; sessions stay pinned; no
automatic substitution; reasoning is never downgraded (all enforced by the
unchanged compiler and covered by R4.7 tests).

## 5. Evidence model

Three levels, kept distinct end to end: **discovered** (advertised id only —
never execution access), **declared** (configuration/documentation
provenance), **verified** (required probes succeeded for this specific
route — the only level the resolver treats as executable). Minimum probes:
authenticated access, structural text completion, genuine SSE streaming where
the model declares it, real tool-call emission plus continuation with the
actual emitted call id where toolCalling is declared, reasoning-effort
acknowledgment for the route's levels, transport compatibility, normalized
errors and timeouts. Probes use synthetic content
(`probe-ok` round-trips) with a single deadline covering connection,
headers and body; the 256 KiB cap is enforced while streaming, before the
full body is ever buffered. Redirects are denied by default (the Location
target is never fetched); every request re-resolves DNS and revalidates the
connection target, so a public hostname resolving to a restricted address is
refused. Concurrency is bounded (4 inflight probe requests) with caller
cancellation, response cleanup and redacted diagnostics. Nothing probes on
startup. Evidence records persist (redacted) under `data/registry/route-evidence.json`,
outside canonical route records.

### 5.1 R4.1 binding guarantees

Every granted verification carries a probe contract version plus a sha256
fingerprint over the verified tuple: provider endpoint and transport,
logical model id and checkpoint, capability set, remote model id and route
id, reasoning levels, execution kind, and connection id, kind, status and
credential reference. An operator route whose stored availability says
verified is executable-eligible only while its current evidence still binds
the live tuple: missing evidence, a failed latest attempt, a contract
mismatch, or any change to a security-relevant field demotes the effective
record to probe-required (fail closed, with a diagnostic note). A failed
re-probe additionally demotes the stored record, so no stale verified flag
survives; the attempt history (bounded to the last 10) is preserved for
diagnostics while only the current attempt decides. Revocation is covered
twice: the resolver already fails closed on revoked or disabled connections,
and the status change also breaks the fingerprint. Built-in shipped
verification state is never altered by this machinery.

### 5.2 R4.2 transport binding and completeness

DNS validation alone is not the boundary. The default probe transport
resolves the hostname once, validates every address, then connects the
socket to the validated address without re-resolving, so rebinding
between validation and connect cannot redirect the probe. For https
targets the original hostname is sent as SNI and default hostname
verification applies. Redirects are never followed and mixed
restricted/public answer sets are refused with nothing leaving. The
single deadline covers resolution, connection, headers and body, and
abort destroys the socket, so uncooperative endpoints leave no
lingering connection behind the 4-wide limiter. An injected fetch
transport is a test seam only and carries no binding guarantee.
Production UI calls never inject one. Without a DNS resolver for a
hostname target, probing fails closed.

Capability evidence is per level. Every advertised reasoning level is
probed individually, evidence records the checked set and the verified
subset, the fingerprint binds the verified subset, and the effective
route is narrowed to it, so unchecked levels never compile. The
test-only streaming skip is removed from the promotion path. Evidence
contract is v3, and v2 evidence no longer grants eligibility.

## 6. Credential ownership and the R4.3 integration blocker

Credentials are separated from public records: connections carry
`credentialRef: credential://…` plus non-secret status metadata; catalogs,
snapshots, logs, HTTP responses and exports never carry key values (secret
shapes are rejected at every write boundary and evidence is redaction-gated).

**Blocker (reported, not worked around):** the host provides no
authenticated credential-write boundary — the registry routes share the R3
loopback + origin-tuple CSRF boundary, under which any local process can
call them exactly like the pre-existing Nexus routes. Per the task, R4 adds
**no insecure HTTP endpoint for secrets**: the service accepts only opaque
references, and the HTTP probe API rejects secret-bearing bodies outright.
A credential may be presented only at the service layer (offline calls and
credential-gated tests); server-side UI probes run without secret values.
Reaching `connected` still requires explicit operator attestation
(`POST /connections/status { attested: true }`, surfaced in the UI as
“connected (operator-attested)”).
R4.1 hardening: attestation alone never verifies. Verification demands a
presented credential that the provider accepted; an unauthenticated 200 is
reported as reachability only, and a key-required connection without a
presented credential fails closed. Live credential-gated probes (real
authenticated text/streaming/tool round-trips against a commercial endpoint)
could not run without explicit credentials and are documented as not run;
the offline suites inject fake transports (and pinned test bearers at the
service layer only) instead. The authenticated credential boundary (secure
storage writes, subscription OAuth, browser-token handling) belongs to R5.

## 7. Storage

```text
data/registry/
  mode-configurations.json   (R3 staged mode configs, unchanged semantics)
  custom-providers.json      (R4 operator providers + built-in disable overlays)
  custom-models.json         (R4 operator models + overlays)
  routes.json                (R4 operator routes + overlays)
  connections.json           (R4 operator connections: refs only + overlays)
  route-evidence.json        (R4 redacted verification evidence)
  catalog.lock               (R4 shared mutation lock, corrected reclamation)
```

Every file is `{ schemaVersion: 1, revision, updatedAtUtc, items: { id:
{ record, provenance: 'operator', recordVersion, updatedAtUtc } },
disabledBuiltins: { … } }`. Writes are revision-checked, temp-file + atomic
rename, lock-serialized, rollback-safe; failed writes leave no temp/lock
leftovers. Built-in identity is preserved: operator ids colliding with
built-ins are rejected (`duplicate-id`); built-ins are disabled via overlay,
never mutated or deleted. Canonical data carries no DSH identifiers
(`legacyDshProviderId` still rejected as an unknown field) and no
credentials. A failed refresh never erases operator data: merge conflicts
exclude only the colliding record with a `duplicate-id` warning while
everything else loads.

Safe-disable rule: disable/delete of anything referenced by a saved mode
configuration fails with `dependency-blocked` naming the dependents
(`saved-configuration route …`); removal proceeds only after a separate
safe migration (re-stage without the route), proven by test.

## 8. Limitations (R4.2 actual guarantees)

- Live provider verification needs the R5 credential boundary. UI-driven
  server-side probes run without secret values and report honest
  reachability/auth states; only service-layer calls with an explicitly
  presented credential can produce authenticated evidence.
- Request-time DNS is resolved once per probe (default resolver is
  node:dns; tests pin answers) and the socket binds the validated
  address with SNI and hostname verification intact. Rebinding between
  validation and connect is eliminated on the default transport; the
  residual risk is confined to injected test transports, which carry no
  binding guarantee, and to exotic resolver middleboxes outside the
  probe's control.
- Redirects are denied rather than revalidated: providers that answer API
  calls with 3xx stay unverified until they serve the endpoint directly.
- Reasoning acknowledgment requires a structural echo (effort value under
  reasoning keys, or consumed reasoning tokens). Vendors whose wire shape
  carries neither stay reasoning-unverified rather than being guessed.
- Continuation semantics outside the two supported dialects stay unverified
  rather than being guessed.
- Evidence has no wall-clock expiry policy: staleness is defined as
  fingerprint, contract or authorization drift, not age.
- Provider-specific continuity (session headers, request ids, tool-handshake
  state) stays runtime/adapter-owned and never enters Registry snapshots.
- The UI has no live-GUI screenshot harness in this task; visual verification
  is the VM static-markup smoke plus control-wiring assertions.

## 9. Test results

`tests/RegistryR4TransportBinding.Tests.cjs`: **11/11 PASS**
(offline, adversarial, real loopback servers). Ten checks failed on the
R4.1 build and pass after the correction; one mixed-DNS guard passed
before and after. Coverage: validated-IP connection for unresolvable
hostnames with Host preservation; single-resolution pinning against
rebinding answers; mixed-result refusal; SNI plus hostname-verification
defaults; DNS inside the deadline; socket destruction for stalled
connections; streaming-skip inertness; per-level reasoning grants with
narrowed eligibility; stale-contract demotion; exact-set evidence;
full-set eligibility.

`tests/RegistryR4ProbeSecurity.Tests.cjs`: **16/16 PASS** (offline,
adversarial). Every check was run against the unfixed R4 build first and
failed there (0/16), then passes after the correction. Coverage: loopback
redirect refusal without requesting the target; private-IP DNS refusal with
no request leaving; oversized streaming bodies stopped before full
buffering; stalled-body deadline settlement; bounded concurrency (4 max)
with response cleanup; caller cancellation; legitimate public endpoints
still passing; arbitrary-JSON, string tool-call and non-SSE rejections;
emitted call-id round-trip; unauthenticated-200 separation; no attestation
substitution; endpoint/model/route/revocation invalidation; failed re-probe
demotion with preserved history; versioned evidence fingerprints.

`tests/RegistryR4Providers.Tests.cjs`: **27/27 PASS** (offline) on
the hardened build. Its fakes were tightened to the new contract
(auth-aware, protocol-accurate payloads, genuine SSE, reasoning echo,
injected bearer plus pinned DNS at the service layer only) — a specified
contract change, with the prior permissive expectations preserved in
history. Coverage:
lock-reclamation fix (live/dead owners past the hard age); CRUD +
restart + record versions; built-in vs operator identity; duplicate/conflict
ids; SSRF/endpoint matrix; local-dialect policy; secret rejection;
credential-ref rules + attestation; discovery-vs-verified eligibility;
auth/text/tool/unreachable probe failures; engine-scope and reasoning
mismatch; R4.7 staged eligibility without substitution or downgrade;
dependency-blocked disable/delete + migration unblock; runtime projection
(including `pending-dsh-mapping` for operator providers); concurrent
saves/rollback hygiene; dependency-free packaging; byte-identical legacy +
controller files; host status codes + origin gating; UI smoke (display names,
ten working controls, execution-kind badges, not-runnable grouping, no
`aih-*` leakage).

Regression gates executed in this task: R0 21/21, R1 45/45, R2 41/41,
installed runtime 3/3 (route pin extended for the R4 contract — a specified
API addition, with the prior pin preserved in history), R3 UI 29/29, R3
hardening 19/19, composed routing matrix 8/8, Nexus engine contract 26/26.
`NexusControllerPanel` route pins updated to the R4 contract (verified 30
routes via standalone registration check); its cordis-dependent section
cannot run in this workspace (missing vendored `@deepseek-ai/cordis`,
fails identically on the clean baseline — pre-existing environment gap, not
an R4 regression). Credential-gated live tests: none run (no credentials
supplied); server-side probes were exercised through injected fakes only.

## 10. Definition-of-Done check

An operator can add a supported compatible API provider through Nexus, add or
discover a model, verify required capabilities, save an eligible route and
select it in a staged Engineering Mode configuration — all without modifying
production DSH routing (proven by the R4.7 end-to-end test and the
byte-identical production hashes). R4.1 adds that executable-eligibility
holds only for the genuinely validated binding (hardened transport,
structural protocol checks, fingerprinted evidence with fail-closed drift
handling). R4.2 closes the binding to the validated destination
address, checks every advertised reasoning level individually with
narrowed eligibility, and removes test-only shortcuts from the
promotion path. No merge to `dev`, no production
cutover, no R5 auto-start. PR #33 stays Draft (no merge performed here).
