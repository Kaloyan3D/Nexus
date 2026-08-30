# Architecture decision records

This file records the architectural decisions that future Nexus changes should not accidentally undo.

These are concise ADR-style summaries. Detailed implementation history remains in `docs/nexus-ui.md` and `docs/vnext-architecture.md`.

---

## ADR-001 — Deterministic controller owns engineering state

**Status:** Accepted

### Decision

Task identity, routing policy, attempts, verification truth, review requirements, operator gates, and final completion are controller-owned durable state.

Models perform engineering work but do not become authoritative by asserting that work is complete, verified, or safe.

### Why

Conversation state is temporary and model judgments are not a reliable state machine. Durable deterministic state enables resumability, bounded retries, auditable verification, policy enforcement, and truthful UI.

### Consequences

- completion must be evaluated by controller logic;
- UI should render records rather than infer lifecycle from prose;
- model/context changes must not erase task identity;
- new features that mutate engineering state should go through controller contracts.

---

## ADR-002 — DeepSeek is the ordinary root executor; Codex is bounded review

**Status:** Accepted

### Decision

DeepSeek V4 Flash owns normal planning/implementation/debugging/repair. Codex is a fresh bounded independent review path and is not a permanent parent agent.

Writable Codex solving is exceptional and user-approved.

### Why

This keeps ordinary work fast/cost-bounded while preserving an independent escalation/review seam for repeated evidence-backed failures and critical boundaries.

### Consequences

- ordinary completion can happen with zero Codex calls;
- a review route does not replace the root executor shown in the Control Room;
- automatic review must obey packet/call/file/diff/context/output limits;
- “hard task” alone is not a routing rule.

---

## ADR-003 — Workspace + task identity, resolved from session binding

**Status:** Accepted

### Decision

Task IDs are not globally unique. Any cross-record join must be scoped by the authoritative session binding to normalized workspace + task ID.

### Why

Multiple repositories naturally create identifiers such as `TASK-0001` or `TASK-0003`. Joining by task ID alone caused stale routing/review data from other workspaces to surface in the active task.

### Consequences

- server resolves workspace/task from the session binding;
- routing/activity/review/verification readers match workspace + task;
- records without trustworthy workspace identity fail closed for cross-workspace joins;
- browser-supplied file/workspace paths are not an authority substitute.

---

## ADR-004 — Control Room uses additive DSH UI extension points

**Status:** Accepted

### Decision

The Nexus Controller/Control Room uses additive UI extension points such as `shell.overlay`, header actions, and composer seats. It does not take ownership of DSH's native single-seat `details` surface.

### Why

Registering a second owner in the native `details` single slot caused a loader collision and would make Nexus replace upstream functionality rather than extend it.

### Consequences

- native DSH Details remains functional;
- Control Room is an overlay/drawer surface;
- future Nexus UI features should prefer official/additive seats before bundle patching.

---

## ADR-005 — RUNNING model and PREFERRED model are different concepts

**Status:** Accepted

### Decision

The UI separates the effective routed executor (`RUNNING`) from the session-preferred/root model and effort (`PREFERRED`).

### Why

A session may prefer/allow MAX while deterministic routing selects HIGH for `deepseek_normal`. Conflating the two makes routing appear broken or encourages the preference to override controller policy.

### Consequences

- model identity and reasoning effort are displayed separately;
- UI should not synchronize PREFERRED down to the current route;
- PREFERRED should not override deterministic execution-class routing;
- redundant PREFERRED presentation may be hidden when it equals RUNNING.

---

## ADR-006 — Polling transports state; it does not create Activity

**Status:** Accepted

### Decision

Control Room polling is a transport/read mechanism. Lifecycle Activity is built from authoritative records and must not be generated from differences between polls.

### Why

Poll-based event synthesis creates fake events on reload, duplicate transitions, and timing artifacts.

### Consequences

- reload must not create Activity rows;
- verification start is deduplicated semantically across attempt/evidence sources;
- a future SSE/delta transport can replace polling without changing producer/storage semantics.

---

## ADR-007 — Verification failure is distinct from verifier failure

**Status:** Accepted

### Decision

A verification command may return valid structured failed-check data with a non-zero process exit. That is a valid failed verification. Infrastructure/launch/malformed-output failure is a different state.

### Why

Treating every non-zero verifier exit as an infrastructure exception left attempts stuck in `verifying` and discarded valid evidence.

### Consequences

- verification-shaped JSON can be consumed from an expected non-zero result;
- completed failed checks produce FAILED evidence/attempt state;
- incomplete verification without finished evidence reconciles to `interrupted / verification-incomplete`;
- UI must not present incomplete infrastructure failure as normal failed-check evidence.

---

## ADR-008 — Operator actions are gate-advertised and server-validated

**Status:** Accepted

### Decision

The Control Room renders only actions explicitly advertised by the current operator gate. The browser sends bounded identifiers to a controller endpoint; it never edits task/gate ledgers directly.

### Why

Generic UI actions such as force complete, reroute, or skip verification would bypass deterministic controller authority and create stale/race hazards.

### Consequences

- gate actions validate session/gate/action/request identity;
- stale or resolved gates reject actions;
- duplicate/replay handling is explicit;
- adding a new operator action requires a controller transition and an `allowedActions` contract, not just a new button.

---

## ADR-009 — Persistence uses explicit durable-field boundaries

**Status:** Accepted

### Decision

Persistent session bindings are serialized through an explicit whitelist of durable fields. Runtime-only objects are never persisted implicitly.

### Why

A live DSH session reference was once attached to an in-memory binding and then accidentally serialized, causing runaway persistence behavior.

### Consequences

- new runtime helper fields do not become durable automatically;
- persistence schema changes are intentional;
- readers remain tolerant of older optional binding fields.

---

## ADR-010 — Fail closed instead of inventing engineering truth

**Status:** Accepted

### Decision

When Nexus cannot prove a route, attempt, verification result, duration, gate, or workspace identity, the UI/controller should expose unavailable/not-run/idle/error state rather than fabricate a successful-looking value.

### Why

A Control Room is useful only if its information can be trusted.

### Consequences

- no fake Attempt 0;
- no synthetic timestamps/durations;
- no fake PASS from missing evidence;
- no implicit operator buttons;
- corrupt/missing subsystems degrade independently instead of poisoning healthy state.