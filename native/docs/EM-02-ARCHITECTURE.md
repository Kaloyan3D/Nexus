# EM-02 — Registry-authorized per-attempt reasoning: architecture

Branch `feature/native-per-attempt-reasoning`, base `2da0cc3` (R-LOCK-1). Uncommitted, for
independent review. Offline only; no paid inference.

EM-02 is an **authorization foundation**. Muse adaptive reasoning is **not** activated: the
Governor, adaptive phases, durable cognitive engine state, `muse_update_reasoning_state`,
EMv1/EMv3, CCv2, new providers and fallback are all out of scope. `muse-v0` keeps today's
behaviour byte for byte, at the configured default effort (`low`).

## 1. What existed (traced before any change)

| Step | Where | Scope |
|---|---|---|
| Mode / slot / route / reasoning levels | `config/registry` (resolver: `assignment.reasoning ∈ route.reasoningLevels`, "never downshifted") | Registry configuration |
| Issuance of the target | bridge `issue` → `native-target-v2` → `native-issuer` | **once per run** (task generation) |
| Seal of issuance (`issuanceId` = digest of content incl. `target.reasoning`) and V2 extension (`extensionDigest`, incl. `reasoningEffort`) | Kernel `seal_issuance`, `seal_extension` | once per run, content-addressed |
| Controller task, session, lease | bridge `task-create`, Kernel `acquire` | run |
| Controller attempt, command, Kernel intent | bridge `attempt-add`, `shadow`, `kernel-intent` | **per provider request** |
| Request bytes (`reasoning.effort` = `extension.reasoningEffort` = `core.reasoning`) | `nexus-model` prepare + pin + attestation | per attempt |
| Publish / accept / dispatch-authorize / redeem | Kernel: intent references a sealed `issuanceId` + `extensionDigest`; single-use grant binds request digest, origin, credential | per attempt |
| HTTP send | executor: exactly once per attempt; an uncertain outcome is never re-sent | per attempt |
| Recovery of a lost answer | a NEW Controller attempt (new command, new grant) | per attempt |
| Broker restart | interrupted run closed; continuation = NEW run, new task, new issuance | new task |

Run-scoped: task, task instance (generation), session, lease, issuance, extension, snapshot,
workspace, engine (EM-01). Attempt-scoped: attempt, command, Kernel intent, request digest,
published intent, grant, HTTP send.

**Findings that shaped the design**

1. The effort is part of the sealed identity (`core.reasoning` → `issuanceId`;
   `extension.reasoningEffort` → `extensionDigest`; `nexus-model` refuses drift). A different
   effort is therefore a different issuance; it cannot be "a field of the attempt".
2. The Kernel already accepts any sealed, self-consistent issuance of the same task for any
   command, **but nothing tied an attempt's issuance to the task's model/route**. Rotating
   targets was possible in principle and unauthorized in fact.
3. The sealed snapshot carries role bindings only, not the route's `reasoningLevels`: the Kernel
   could not check capability from what it sealed.
4. A continuation passed `model: None` and was issued against whatever the Registry default was
   at that moment: after a restart the continued task could silently move to another model or
   route (demonstrated on `2da0cc3`, §6).
5. The executor did not check that the grant's target/extension digests are those of the request
   it prepared (the Kernel only sees the request digest the broker supplies).

No fundamental conflict with Kernel sealing or immutable bindings was found: a per-attempt target
is simply another sealed, content-addressed issuance of the same task, provided something binds
it to the task's identity. That binding is the smallest safe change.

## 2. Contract

### 2.1 Immutable task binding — `TaskBindingV1` (`nexus-contracts/src/task_binding.rs`)

```
{ schemaVersion: 1, taskInstanceId, role, issuer, registrySnapshotDigest, modeConfigRevision,
  target:    issued target WITHOUT "reasoning",
  extension: issued V2 extension WITHOUT "reasoningEffort",
  defaultReasoning,            // the task issuance's own effort (configured default)
  supportedReasoning: [...] }  // = authorized_levels(sealed task target): the slot policy
                               //   carried IN the target, else [defaultReasoning] (sorted)
bindingDigest = sha256(canonical(binding))
```

It therefore pins the Engineering Mode and engine id, logical model, remote model, provider,
route, connection, execution kind, access type, protocol, capabilities and slot requirements,
data-use tier, endpoint (origin/path/method), credential reference, session, billing, context and
output limits, wire profile, Registry snapshot and mode revision, task generation and role.

Rule (`admits`): an issued (resolution, extension) may execute under the binding iff its
projection is byte-identical (canonical digest), `supportedReasoning` equals the levels the
issued target itself authorizes (`authorized_levels`, §7), and its effort — identical in target and
extension — is one of them. Checked exactly as issued: never escalated,
downgraded or defaulted.

### 2.2 Per-attempt execution target

Identical to the task's issuance except `target.reasoning` / `extension.reasoningEffort` and the
digests derived from them (`targetDigest`, `issuanceId`, `extensionDigest`). Content-addressed:
the same effort for the same task is always the same target; an issued target is sealed and
never mutated; the default effort IS the task's issuance.

## 3. Authority boundaries

| Authority | EM-02 role |
|---|---|
| **Registry** (`native-task-binding.cjs`) | builds the binding once per task from the task issuance and the bound route's declared levels (`buildTaskBinding`, emitted by bridge `issue`); authorizes an attempt effort **only against the sealed binding** (`authorizeAttemptTarget`, bridge `issue-attempt`) — it reads no Registry configuration for that, so a configuration change mid-run cannot redirect a task |
| **Kernel** | `seal-task-binding`: verifies the binding describes exactly the task's sealed issuance + extension, HMAC-seals it, first writer wins, immutable (`task_bindings` table, additive). `publish_intent`: binding `admits` (target + extension). `accept_command`: binding `admits_target`; **a task without a binding may never switch issuances** (closes finding 2 for legacy flows). Tampered bindings fail authentication → `store-corrupt` |
| **Executor** (`nexus-model`) | sends only if the grant's `targetDigest` / `extensionDigest` equal the prepared request's (closes finding 5) |
| **Broker** (`attempt_target.rs`) | seals the binding at task start and records it on the run; obtains each attempt's target via `TaskTarget::for_attempt` — `Pinned` (task target, no call) or `Authorized(effort)` (bridge `issue-attempt` → local `admits` check → Kernel seals); continuation carries the interrupted run's model+route and must keep its binding identity |
| **EngineExtension** (EM-01) | unchanged: contract v1 admits only `KeepPinned`; no effort ever reaches `for_attempt` from an engine in EM-02 |

No second Controller, Registry or orchestration path: the turn loop already had one target per
attempt; it now takes it from `for_attempt(Pinned)`.

## 4. Attempt vs HTTP retry vs resumed attempt

| Event | Authorization |
|---|---|
| Model attempt (turn or recovery re-ask) | new Controller attempt + command + grant; target from `for_attempt` (EM-02: always `Pinned`) — content-addressed, so no new authority is minted for the same effort |
| HTTP-level retry / uncertain upload or response | none: the executor never re-sends an attempt; the outcome is recorded and a later attempt is a new command (test: `em02_recovered_attempts_…`, one receipt per request, one issuance) |
| Resumed task after a restart | new task generation, new issuance, new binding; must equal the interrupted run's binding identity, else `task-binding-mismatch` (rejected before any working copy or request) |

## 5. EngineExtension v2 (required for EM-03, NOT activated)

EM-01 v1 already declares `EffortProposal::Change(level)` and refuses it. Activation needs:
1. `may_propose_effort` honoured only for an engine/mode whose Registry slot policy allows
   adaptive effort (today the only policy data is the route's levels and the slot's
   `adaptiveReasoningContract`; a mode-level allowlist is an EM-03 contract item);
2. the host turns an accepted `Change(level)` into `EffortRequest::Authorized(level)` for the
   NEXT attempt only (never the current one, never retroactively);
3. a timeline/receipt event for every non-default effort (no silent change);
4. the binding's `supportedReasoning` is the ceiling: the engine's proposal is input, the Registry
   authorizes, the Kernel seals.

## 6. Behavioural compatibility (summary; evidence in the implementation report)

Request bodies byte-identical to `2da0cc3` (read-only run with tool call and reasoning replay:
2 bodies; coding run with a write and policy nudges: 5 bodies). Same top-level keys, tool-schema
digest, model, `reasoning.effort = "low"`. The only behavioural difference is the intended one:
a continuation after a restart keeps its model/route (on `2da0cc3` the same test ran on the new
default `e2e-mock-model-2`).

## 7. Capability provenance: the trust chain (hardening review)

The authorized levels have exactly the provenance of the model/route identity. No side channel
can widen them.

```
Registry configuration (operator data root)
  route.reasoningLevels           (route record; schema: non-empty strings)
  slots.main.allowedReasoning     (operator slot policy, optional; §8)
        │  resolver.compile   (config/registry/resolver.cjs:242-274)
        │    every policy level ∈ route.reasoningLevels, policy ∋ reasoning, else the mode
        │    configuration does not compile (it cannot even be saved)
        ▼
compiled binding { …, reasoning, allowedReasoning? }  → compiled snapshot (registrySnapshotDigest)
        │  native-issuer.issueForGeneration (native-issuer.cjs:155)
        ▼
issued target { …, reasoning, allowedReasoning? }  → targetDigest → issuanceId
        │  (the Registry runs inside the "trusted issuer bridge" identity: deploy/SETUP.md
        │   "Trusted issuer bridge (Controller + JS Registry delivery channel)")
        ▼
Kernel seal_issuance  (lib.rs: recomputes issuanceId from content, validate_complete:
                       reasoning ∈ allowedReasoning when present — contracts/target.rs:69)
        ▼
TaskBindingV1 delivered with the issuance
Kernel seal_task_binding (dispatch.rs:325) → matches_task_issuance (dispatch.rs:368):
   supportedReasoning MUST EQUAL authorized_levels(sealed task target)
   (contracts/task_binding.rs:76, :207) — the Kernel derives, the binding only echoes
        ▼
per attempt: Registry authorizeAttemptTarget re-derives from the presented task target
(native-task-binding.cjs:150); Kernel publish/accept `admits` (dispatch.rs:518, accept.rs:145):
   projection equal (so `allowedReasoning` is identical to the task's) AND
   supportedReasoning == authorized_levels(attempt target) AND effort ∈ it
        ▼
executor: grant target/extension digests == prepared request (authorized.rs:97, :228)
```

**What the broker cannot do** (tested, `em02_attempt_targets.rs`
`capability_tampering_before_the_binding_is_sealed_is_refused`,
`a_route_level_outside_the_slot_policy_is_never_authorized`, JS suite):
- widen or narrow `supportedReasoning` before the binding is sealed, even with the binding
  digest recomputed: the Kernel refuses with `binding-mismatch`, and the Registry refuses to
  authorize under it (`registry-binding-mismatch`);
- add a policy inside the binding's target projection: projection mismatch;
- widen the issued target's `allowedReasoning` without re-deriving its digests: `seal_issuance`
  refuses (`delivery-invalid`, issuanceId mismatch);
- execute an effort outside the target's own policy: `seal_issuance` refuses (`binding-mismatch`);
- use route capability alone: without a slot policy only the default is authorized;
- change the policy of a bound task: any change is a projection change (`binding-mismatch`).

**Trust root (unchanged by EM-02, stated precisely).** The Kernel seals what the authenticated
issuer channel delivers, provided it is self-consistent. The JS Registry is a child process of
the broker, running under the same issuer identity. Within that identity there is no key the
Registry could sign with that the broker could not read. A delivery channel that re-derives every
digest of a task's **first** issuance can therefore choose its policy, exactly as it could choose
its model, route or connection. This is characterized, not hidden, by the test
`capability_has_exactly_the_provenance_of_the_model_identity`: both forgeries are accepted for an
unbound task, and both are refused once the task is bound.

EM-02 therefore gives capability **the same provenance as model identity and no weaker**.
Removing the issuer channel from the trust root would require running the Registry in a separate
trust domain with its own attestation key (a Registry-signed issuance the Kernel verifies). That
is an architectural change, not an EM-02 contract change, and it must not be a second Registry
inside the Kernel. It is listed as an EM-03+ option in the implementation report.

## 8. Slot-level reasoning policy (hardening review)

The Registry had no slot reasoning policy: an assignment was `{logicalModelId, routeId,
reasoning}` with strict unknown-field rejection. The smallest compatible change:

* **Mode configuration** (operator data): optional `slots.<id>.allowedReasoning: string[]`, also
  allowed on `roleOverrides`. Schema (schemas.cjs:168-200): 1..16 distinct visible-ASCII levels
  that include the assignment's `reasoning`.
* **Resolver** (resolver.cjs:242-274): every policy level must be declared by the assigned route
  (`reasoning-level-not-supported`, "never authorized beyond the route"). The sorted policy is
  emitted in the compiled binding only when configured. The resolved-binding schema accepts it
  (schemas.cjs:428, :461).
* **Issuer** (native-issuer.cjs:155): the policy is copied into the issued target only when
  present. **Targets without a policy are byte-identical to before** (same targetDigest,
  issuanceId, snapshot), so every existing configuration and Muse run is unchanged.
* **Selection** (native-target-v2.cjs:327): the saved policy applies to a selection only when the
  selection is that same model and route. Any other selected model gets the default only.
* **Authorized levels** = the slot policy carried in the sealed target, else the default effort
  alone. **A route-declared level is never treated as operator-authorized by itself.** Non-default
  effort is therefore disabled everywhere unless an operator configures a slot policy. The repo
  configuration and every existing data root have none. Controlled test fixtures set one
  explicitly (`registry-slot-policy`).
* The configured default (`low`) is unchanged and is always within the policy (schema-enforced).
* Revocation semantics: a policy or route change applies to tasks issued afterwards. A running
  task keeps the policy sealed at its start (§4; tested).
