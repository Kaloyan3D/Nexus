# Context Compaction V2 — Frozen Architecture (CCv2 v0.3 + A00 corrections)

Status: **FROZEN** (CCV2-A00). Normative for all V2 work.
Supersedes nothing: `docs/architecture/context-compaction-v1.md` remains the
normative V1 document and V1 production behavior is unchanged.

Provenance of the v0.3 material: the CCv2 v0.3 specification was supplied in
the CCV2-TASK-0001 brief (authority boundaries, conceptual contracts, and
fundamental invariants). No standalone v0.3 document exists in the repository
at the frozen base commit `f1be027` (verified by full-history search for the
v0.3 vocabulary). This document is therefore the single normative V2 source:
it consolidates the supplied v0.3 architecture **and** the corrections that
CCV2-A01 proved necessary against the real pinned DSH host.

Base and host pin:

| Item | Value |
| --- | --- |
| CCv2 base commit | `f1be027` (`feature/context-compaction-v1` tip) |
| Pinned host | `@deepseek-ai/dsh` `0.1.1-rc.2` |
| Host install root | `<installRoot>/app/node_modules/@deepseek-ai` |
| Session module | `@deepseek-ai/dsh-session/lib/index.js` |
| Session format version | `SESSION_FORMAT_VERSION = 0` |

---

## 1. Scope of V2

V2 extends V1 from *one* checkpoint generation per completed task to *many*
ordered generations per session binding, while keeping every V1 safety
guarantee. V2 does not weaken, reinterpret, or bypass any V1 KEEP rule.

Out of scope for V2 (unchanged prohibitions): active-task production
compaction, routing changes, Muse reasoning changes, Dual engine changes,
JEV/Laya, embeddings, Context Compiler implementation, semantic compression,
TaskController authority changes, silent changes to pinned DSH behavior, and
forking or patching DSH.

---

## 2. Authority boundaries

One authority per decision. Every component below owns exactly the listed
decision and is a read-only consumer of every other decision.

| Component | Sole authority over | Explicitly NOT |
| --- | --- | --- |
| `TaskController` | task lifecycle and completion | context projection, checkpoint eligibility |
| `ContextLifecycle` | context lifecycle state machine, thresholds, telemetry | task status, routing, checkpoint content |
| `SafePointDetector` | the operational checkpoint boundary (safe point) | cutting the surface, durability |
| `CheckpointabilityGate` | active-state sufficiency (may this binding be compacted at all) | building or applying anything |
| `SnapshotManager` | capture, versioning, and revalidation of the state a checkpoint is built against — owns the snapshot validation rule and canonical token comparison semantics | what the checkpoint says |
| `CheckpointBuilder` | structured checkpoint construction | trust assignment, sealing, projection |
| `TrustNormalizer` | field provenance/trust classification | checkpoint content authorship, authority elevation |
| `ContentSealer` | checkpoint integrity (identity ↔ content digest) | storage, retention |
| `RetentionPlanner` | the exact projection plan (exact segments, exact payload-bearing node) | executing the plan |
| `TransactionalApply` | projection mutation and durability — invokes the SnapshotManager validation rule verbatim at the final pre-mutation gate and does not redefine it | deciding the boundary, reconciling by re-planning |
| `ContextCompiler` | **future** disposable `ContextView` assembly only | any authority; non-authoritative by construction |
| `DecisionProvider` | **future** advisory recommendations only | any authority; advisory by construction |

`TaskController` remains the sole task lifecycle/completion authority. SnapshotManager owns the snapshot validation rule and canonical token comparison semantics. TransactionalApply invokes that rule verbatim at the final pre-mutation gate and does not redefine it.

### 2.1 No model receives authority over

```text
completion
verification truth
checkpoint eligibility
permissions
durability
repository identity
history deletion
```

A model output may become *content* (a checkpoint field, a rationale, an
advisory recommendation). It never becomes *authority*. Concretely: a harness
model cannot mark a task complete, cannot certify verification, cannot make a
binding checkpointable, cannot grant a permission, cannot declare a write
durable, cannot assert repository identity, and cannot delete history.

---

## 3. Frozen conceptual contracts

These are the minimum contracts. Field names, authority, mutability,
persistence and identity rules are normative; A02+ implements them. A contract
may gain optional fields but may not change the semantics below.

### 3.1 `ContextSnapshotToken` (frozen A05 — supersedes the pre-A05 draft below)

The immutable identity of the exact authoritative task/session/workspace
revision a checkpoint was built from. A sealed checkpoint may be
structurally valid, authentic, and untampered while still being STALE:
integrity and freshness are different properties, proven by different
components (`ContentSealer` vs `SnapshotManager`).

> Supersession note: the pre-A05 draft of this section (tokenId over
> sessionId/taskId/taskInstanceId/workspaceFingerprintId/captureSeq/
> surfaceDigest) described intent before implementation and is superseded
> in full by the frozen A05 contract that follows. No two normative
> snapshot schemas remain: this section is the single definition.

```text
ContextSnapshotToken {
  schemaVersion      : integer (1)
  snapshotTokenId    : string  — 'cst_' + sha256('nexus/context-snapshot-token/v1'
                                 LF taskId LF taskInstanceId LF sessionId
                                 LF generation LF revisionDigest)[0..32)
  revisionDigest     : string  — sha256('nexus/context-snapshot-revision/v1'
                                 LF canonicalJson(revisionBody)); see below
  taskId             : string
  taskInstanceId     : string
  sessionId          : string
  workspaceId        : string
  repositoryId       : string | null
  checkoutId         : string | null
  generation         : integer — the checkpoint generation this token was
                                 captured for (generation-bound)
  safePointBoundarySeq : integer
  sessionRevision    : integer — highest durable session event seq at capture
                                 (monotonic append-only authority)
  taskRevision       : string  — sha256 over the canonical normalized
                                 task-state body (objective/requirements/
                                 constraints/progress/decisions/failures/
                                 verification/continuation), derived ONLY by
                                 SnapshotManager.deriveTaskRevision
  repositoryRevision : { headCommit: string | null,
                         indexDigest: sha256-hex | null,      // staged state
                         worktreeDigest: sha256-hex | null }  // unstaged state
  runtimeRevision    : { runtimeSnapshotSeq: integer | null, // A01/A02 host seq
                         runtimeSnapshotId: string | null,    // derived rss_<seq>
                         runtimeSnapshotDigest: sha256-hex | null } // derived
  capturedAtUtc      : string  — ISO-8601 UTC, AUDIT ONLY (never freshness)
}
```

`revisionBody` (the ONLY input to `revisionDigest`) is the normalized
`{ taskId, taskInstanceId, sessionId, workspaceId, repositoryId,
checkoutId, safePointBoundarySeq, sessionRevision, taskRevision,
repositoryRevision, runtimeRevision }`. It EXCLUDES `snapshotTokenId`,
`revisionDigest`, `capturedAtUtc`, AND `generation`: `revisionDigest` is
pure authoritative-state identity (byte-identical state in another
generation yields the SAME digest), while `snapshotTokenId` stays
generation-bound through its own formula and `revalidate()` still compares
generation explicitly (`snapshot-generation-mismatch`).

- Authority: `SnapshotManager` (`config/ContextSnapshotV2.cjs`) creates it.
  `CheckpointBuilder` embeds the captured ids verbatim and never mints
  them. `TransactionalApply` invokes `revalidate()` verbatim at the final
  pre-mutation gate and never redefines freshness. Nobody else may mint,
  derive, compare, or mutate snapshot identity.
- Mutability: **immutable** after creation.
- Persistence: the checkpoint/operation embed ONLY the ids
  (`snapshot.snapshotTokenId/revisionDigest`, `operation.snapshotTokenId`).
  Ids alone cannot revalidate after restart, so the FULL token persists as
  one immutable atomic file per token id (`snapshot-<tokenId>.json`, no
  overwrite with different bytes, read-back validated, generation-scoped by
  the bound generation inside). Embedded-only persistence is NOT sufficient.
- Identity: `snapshotTokenId` and `revisionDigest` are **derived, never
  free text**, recomputed on every validation. A merely nonempty string is
  never sufficient. Token ids (`cst_…`) are distinct from checkpoint ids
  (`ccp_…`) and operation ids (`ccop_…`); no digest is overloaded for
  snapshot semantics.
- Grounded primitives (nothing fabricated): session = durable event seq
  (monotonic: any intervening append stays STALE forever); task = digest
  over normalized task state (state-based: exact revert validates again);
  repository = HEAD + staged + unstaged fingerprints (HEAD alone is NOT
  freshness); runtime = current host-owned runtime snapshot seq (A01/A02
  PINNED-current / shadowable-superseded policy: a changed current
  snapshot BLOCKs).
- Capture consistency: `capture()` is pure over one caller-supplied state
  object; `captureConsistent(readStateFn, …)` reads before/after and fails
  closed (`snapshot-capture-inconsistent`) when the revision projection
  moved mid-capture. A mixed-revision token is never accepted.
- Revalidation rule: immediately before model-facing mutation, re-read
  authoritative state and call `revalidate(token, current)` (aka
  `revalidateBeforeMutation`). `VALID` → mutation may proceed; any other
  result → **KEEP/BLOCK** with a stable closed-world reason
  (`snapshot-task-stale`, `snapshot-session-stale`, `snapshot-head-stale`,
  `snapshot-index-stale`, `snapshot-worktree-stale`,
  `snapshot-runtime-stale`, `snapshot-generation-mismatch`,
  `snapshot-boundary-mismatch`, identity mismatches, …). Freshness is
  revision-based; `capturedAtUtc` age is never consulted.
- Mid-apply semantic (frozen, choice B): the host cannot lock repo + task +
  session state across a whole multi-segment apply, so A05 revalidates at
  the final pre-mutation boundary (before the FIRST new append) and the A02
  reconciliation state machine governs every append already begun. Freshness
  is required to BEGIN an operation; operation identity + durable segment
  evidence governs an operation already begun. Zero landed + stale → BLOCK
  all new mutation; durably landed segments still reconcile to completion.
- Checkpoint binding: `checkpoint.snapshot` is `{ snapshotTokenId,
  revisionDigest }` embedded verbatim from the real capture (legacy
  pre-A05 `null/null` checkpoints remain structurally valid but are NEVER
  reinterpreted as bound). The snapshot slot is part of the canonical
  checkpoint payload, so any reference change moves
  `checkpointContentDigest` → `checkpointId` → `sealDigest` naturally; no
  new seal formula exists. Integrity (`validateSealedCheckpoint`) vs
  freshness (`revalidate`) are proven separately.
- Operation binding: `operation.snapshotTokenId ==
  checkpoint.snapshot.snapshotTokenId == captured token.snapshotTokenId`
  (revision digest bound transitively through the checkpoint). Any
  mismatch → **BLOCK**. A02 durable-before-mutation ordering is unchanged;
  freshness validation is inserted as the final gate before the first
  mutation.

### 3.2 `CheckpointabilityResult`

```text
CheckpointabilityResult {
  checkpointable : boolean
  reason         : string           — machine-readable
  blockers       : string[]         — every failing precondition
  evaluatedAtUtc : string
  taskInstanceId : string
  sessionId      : string
}
```

- Authority: `CheckpointabilityGate` only. This is the **active-state
  sufficiency** decision.
- Mutability: immutable value object, recomputed per evaluation.
- Persistence: recomputable; may be recorded in telemetry, never as authority.
- Identity: bound to exactly one `taskInstanceId` (a `taskId` alone is
  insufficient — a restored workspace may re-allocate a display id).
- Fail-closed: an unprovable precondition yields `checkpointable: false`.

### 3.3 `CCv2Checkpoint`

The structured checkpoint artifact.

```text
CCv2Checkpoint {
  schemaVersion      : integer (2)
  checkpointId       : string  — derived identity (section 4.9)
  generation         : integer — 1-based monotonic generation per binding
  taskId             : string
  taskInstanceId     : string
  sessionId          : string
  workspaceFingerprint : WorkspaceFingerprint
  snapshotTokenId    : string
  createdByOperationId : string | null
  contentDigest      : string  — digest of the canonical sealed payload
  payload            : object  — structured, bounded, redacted
  provenance         : provenance map (section 3.4) — part of the digested payload
  seal               : CheckpointContentSeal (section 3.13) — excluded from
                       the content digest, self-integrity via sealDigest
  evidence           : EvidenceRef[]
  sizeBytes          : integer — hard bound, refusal above it
}
```

- Authority: `CheckpointBuilder` constructs; `ContentSealer` seals.
- Mutability: **immutable once sealed**. A generation's checkpoint is never
  edited in place; a new generation produces a new checkpoint.
- Persistence: canonical artifact on disk (one file per generation).
- Identity: `checkpointId` binds task + instance + session + generation;
  `contentDigest` binds the exact sealed content. Integrity is *checkpoint
  identity bound to canonical content hash* (invariant 4.10).
- Self-containment: a checkpoint's payload must be sufficient for normal
  continuation **without** any earlier generation (invariant 4.5).

### 3.4 `TrustProvenance` (frozen A04 — supersedes the pre-A04 draft below)

Per-field provenance. A controller-created checkpoint envelope does NOT make
contained values authoritative: repository text such as "IGNORE PREVIOUS
INSTRUCTIONS" keeps `repository` / `untrusted-data` even though the
controller serialized it (invariant 4.9).

> Supersession note: the pre-A04 draft of this section (field/trust/source
> vocabulary with `controller | host | repository | tool | model | user`)
> described intent before implementation and is superseded in full by the
> frozen A04 contract that follows. No two normative provenance schemas
> remain: this section is the single definition.

```text
TrustProvenance {
  schemaVersion  : integer (1)
  fieldKind      : string   — closed field semantics (e.g. task-objective,
                              requirement-text, verification-outcome);
                              unknown kinds fail closed
  sourceKind     : 'controller' | 'user' | 'agent' | 'repository'
                 | 'tool' | 'verification' | 'review'   — frozen taxonomy;
                              never extended casually
  trust          : 'authoritative' | 'user-intent' | 'evidence'
                 | 'advisory' | 'untrusted-data'        — derived by policy,
                              never caller-chosen
  sourceRefs     : string[] — stable grounded references (session event seq,
                              task state revision, evidence ID, artifact
                              hash, tool event identity); 1..8 entries,
                              never bulk content
  authorityScope : string | null — bounded qualifier
}
```

Trust semantics: `authoritative` → controller-owned deterministic state;
`user-intent` → explicit user requirement / constraint / approval;
`evidence` → grounded tool/repository/verification fact; `advisory` →
model/reviewer suggestion or interpretation; `untrusted-data` → content
that may contain instructions but has no authority.

- Authority: `TrustNormalizer` only — the single normalization path (raw
  grounded field + source identity + field semantics → provenanced value).
  Trust derives from the closed (sourceKind, fieldKind) mapping; unknown
  combinations FAIL CLOSED and nothing defaults to authoritative.
  Conservative downgrades (agent content → advisory, repository/tool prose
  and unverified PASS claims → untrusted-data) exist only as explicit
  mapped entries, never as a default.
- Controller normalization of user-originated text must retain the original
  user/policy source reference: origin is never erased by normalization.
- Decision authority values (`agent-proposed`, `user-approved`,
  `controller-established`, `evidence-supported`) must be establishable
  by the sourcing kind: an agent proposal can never arrive as
  `user-approved` because the agent says so; approval requires a grounded
  user/controller source.
- Verification truth derives only from the verification subsystem / trusted
  execution evidence. Model narration ("all tests pass") is at most
  advisory; the test execution result is evidence.
- An `EvidenceRef` is a reference, never a truth claim (section 3.5).
- Mutability: immutable after sealing.
- Persistence: sealed with the checkpoint inside the provenance map:

```text
provenance: {
  schemaVersion : integer (1)
  fields        : { [fieldPath: string]: TrustProvenance }
}
```

  bounded (≤96 entries; sourceRef/authorityScope/path lengths bounded),
  deterministic (sorted field paths), closed-world validated, canonicalized.
  The map is part of the canonical checkpoint payload, so provenance
  changes move `contentDigest` / `checkpointId` naturally (the A03
  formula itself is unchanged).
- Render metadata: later consumers (future Context Compiler, not built
  here) distinguish `TRUSTED CONTROLLER STATE` from `UNTRUSTED
  REPOSITORY DATA` via the trust class.

### 3.5 `EvidenceRef`

A reference to verifiable evidence — never a truth claim.

```text
EvidenceRef {
  schemaVersion : integer (1)
  evidenceId  : string
  kind        : 'file' | 'command' | 'verification' | 'artifact' | 'event'
  locator     : string   — path, command id, or canonical event seq
  digest      : string | null
  observedAtUtc : string
  taskInstanceId : string
}
```

- Authority: whoever observed the evidence records the reference;
  `CheckpointBuilder` copies it verbatim.
- Mutability: immutable.
- Identity: cross-generation evidence is **excluded**, never merged (V1 rule
  preserved).
- An `EvidenceRef` never asserts PASS/FAIL. Verification truth stays with
  the controller's verification gate.

### 3.6 `WorkspaceFingerprint`

Repository/workspace identity binding.

```text
WorkspaceFingerprint {
  schemaVersion     : integer (1)
  workspaceId     : string
  repositoryId    : string
  checkoutId      : string
  executionRoot   : string   — absolute
  checkoutRootPath: string   — absolute
  baseCommit      : string | null
  headCommit      : string | null
  cleanWorktree   : boolean | null
}
```

- Authority: the existing Nexus workspace resolution. V2 does not add a second
  writer.
- Mutability: immutable per binding.
- Identity: unknown git state is **fail-closed** (V1 F8 rule preserved).
- A checkpoint, an operation, and an apply attempt must all agree on this
  fingerprint or the operation is refused.

### 3.7 `CompactionAttempt`

One attempt to evaluate/plan/apply exactly one generation.

```text
CompactionAttempt {
  schemaVersion  : integer (1)
  attemptId      : string
  operationId    : string
  taskId         : string
  taskInstanceId : string
  sessionId      : string
  generation     : integer
  state          : 'inactive' | 'eligible' | 'checkpoint-ready'
                 | 'apply-pending' | 'awaiting-durability' | 'applied' | 'blocked'
  snapshotTokenId: string | null
  planId         : string | null
  startedAtUtc   : string
  finishedAtUtc  : string | null
  result         : 'applied' | 'reconciled' | 'blocked' | 'failed' | 'in-progress'
  reason         : string | null
}
```

- Authority: state transitions are owned by `ContextLifecycle`;
  `TransactionalApply` records the apply-side result.
- Mutability: append-only attempt history. A finished attempt is never edited.
- Persistence: persisted (attempts journal), atomic writes only.
- Identity: bound to one `operationId` and one `generation`.
- `applied` never rolls back. Re-entry reconciles, never re-plans.

### 3.8 `CompactionOperationV2`

The frozen projection plan for one generation.

```text
CompactionOperationV2 {
  schemaVersion         : integer (2)
  operationId           : string  — canonical derived identity (section 4.9)
  attemptId             : string  — durable attempt identity (attempt ≠ generation)
  taskId                : string
  taskInstanceId        : string
  sessionId             : string
  checkpointId          : string
  checkpointGeneration  : integer — 1-based monotonic generation per binding
  workspace             : string
  repositoryId          : string | null
  checkoutId            : string | null
  checkpointPath        : string | null
  checkpointContentDigest : string — sha256 of the exact payload text applied
  snapshotTokenId       : string | null — null until ContextSnapshotToken exists (A02 temporary semantics)
  safePointBoundarySeq  : integer — highest canonical seq proven safe
  sourceEventSeqs       : integer[] — ascending, unique, every shadowed node
  segments              : OperationSegment[] — canonical start-ascending order
  lifecycle             : 'frozen' | 'applying' | 'awaiting-durability' | 'applied' | 'blocked'
}

OperationSegment {
  start          : integer
  end            : integer
  sourceEventSeqs: integer[]
  role           : 'payload' | 'continuation'   // see section 4.11
}
```

- Authority: `RetentionPlanner` produces the plan; `TransactionalApply`
  executes it verbatim and never widens or recomputes it.
- Mutability: **frozen once persisted**. Retry reuses byte-identical values.
- Persistence: persisted before any mutation, atomically.
- Identity: `operationId` is **canonical derived identity**
  (`nexus/context-compaction-operation/v2` LF taskId LF taskInstanceId LF
  sessionId LF checkpointGeneration LF checkpointId, SHA-256, `ccop_`
  prefix) and is **recomputed on every validation**. The V1 domain
  (`.../v1`, triple only) is unchanged; V1 and V2 IDs never collide.
  Closed-world validation additionally requires: unique ascending
  `sourceEventSeqs`; every segment endpoint equal to its own first/last
  source seq; segments listed in strictly start-ascending canonical order;
  pairwise-disjoint segment source sets whose union multiset, sorted,
  exactly equals `sourceEventSeqs` (set-partition semantics: past
  generations interleave replacement seqs with older live seqs on the
  surface, so a segment keeps surface-application order inside);
  and every seq `<= safePointBoundarySeq`.
- Exactly one segment carries `role: 'payload'` (section 4.11).
- `snapshotTokenId = null` was the explicit A02 temporary value. Since A05
  (frozen section 3.1), snapshot-bound operations carry the exact captured
  `cst_…` token id, bound by `SnapshotManager.assertOperationBindsSnapshot`
  (`operation.snapshotTokenId == checkpoint.snapshot.snapshotTokenId ==
  captured token`); legacy `null` operations remain structurally valid but
  are never treated as snapshot-bound.
- One file per generation. `applied` requires durable evidence, never
  in-memory presence alone.

### 3.9 `ContextPage`

One bounded, addressable page of canonical material.

```text
ContextPage {
  pageId    : string
  kind      : 'history' | 'checkpoint' | 'evidence' | 'repository'
  locator   : string  — canonical event seq range or artifact path
  byteRange : { start: integer, end: integer }
  contentDigest : string
  trust     : TrustProvenance['trust']
  taskInstanceId : string
  generation: integer | null
}
```

- Authority: the future `ContextCompiler` mints pages **only** as a derived
  view over canonical material. No page is ever a source of truth.
- Mutability: immutable; a page is re-derivable at any time.
- Persistence: **not authoritative**; pages may be cached and discarded.

### 3.10 `ContextView`

```text
ContextView {
  viewId        : string
  taskInstanceId: string
  sessionId     : string
  generation    : integer | null
  pages         : ContextPage[]
  budget        : ContextBudget
  assembledAtUtc: string
  disposable    : true
}
```

- Authority: **none**. `ContextView` is a future disposable assembly for the
  model-facing request only.
- Mutability: immutable per assembly; never edited.
- Persistence: **never** persisted as truth. Deleting every `ContextView`
  must lose nothing.
- Forbidden: a `ContextView` may never be consulted to decide completion,
  verification, eligibility, permissions, durability, repository identity, or
  deletion.

### 3.11 `ContextBudget`

```text
ContextBudget {
  budgetTokens   : integer
  usedTokens     : integer | null
  reservedTokens : integer
  policy         : string
  measuredAtUtc  : string
}
```

- Authority: advisory accounting only. `usedTokens: null` means *unavailable*
  and must never be fabricated as `0` (V1 telemetry rule preserved).
- Mutability: immutable per measurement.

### 3.12 `DecisionProvider`

```text
DecisionProvider {
  providerId : string
  kind       : 'advisory'
  recommend(input) -> {
    recommendation : string
    rationale      : string
    confidence     : number   // 0..1, advisory only
    authority      : 'none'
  }
}
```

- Authority: **advisory only**, always. A recommendation that is not adopted
  changes nothing.
- A `DecisionProvider` may not: choose the cut boundary, mark completion,
  certify verification, set checkpoint eligibility, grant permissions, declare
  durability, assert repository identity, or delete history.
- Mutability: providers are stateless with respect to authority; their outputs
  are inputs to a decision owned by a component in section 2, never the
  decision.

### 3.13 `CheckpointContentSeal` (frozen A04R)

The authoritative seal record for one sealed checkpoint generation. The seal
lives in the SAME immutable checkpoint record (one atomic file per
generation) but is EXCLUDED from the A03 content-digest computation, so both
A03 formulas are preserved byte-for-byte.

```text
CheckpointContentSeal {
  schemaVersion           : integer (1)
  checkpointId            : string  — must equal the checkpoint's id
  checkpointContentDigest : string  — sha256 hex, must equal the checkpoint's digest
  generation              : integer — must equal the checkpoint's generation
  taskId                  : string
  taskInstanceId          : string
  sessionId               : string
  sealedAtUtc             : string  — explicit builder input, never clock-read
  algorithm               : 'sha256'
  sealDigest              : string  — sha256 hex over the seal record itself
}
```

Frozen seal-record digest (domain-separated; no recursive hashing):

```text
sealDigest = sha256Hex(UTF-8('nexus/context-content-seal/v1' LF
                             canonicalJson(seal excluding sealDigest)))
```

Three separate responsibilities: `checkpointContentDigest` → canonical
checkpoint content identity (A03); `checkpointId` → generation/content
identity (A03); `sealDigest` → integrity of the complete seal metadata,
covering `sealedAtUtc` — so an instant-only mutation fails validation
with `checkpoint-seal-record-digest-mismatch`.

- Authority: `ContentSealer` mints after `TrustNormalizer` provenance
  normalization (never seal before normalization; secrets redacted before
  sealing, never after).
- Mutability: **immutable**. Any meaningful change creates a new generation;
  persisting different bytes for an already persisted generation is refused.
- Validation order: parse → checkpoint/provenance → contentDigest →
  checkpointId → seal structural → seal field binding → recompute
  sealDigest → compare. Any mismatch → **BLOCK** with stable codes
  (`checkpoint-seal-missing`, `checkpoint-seal-invalid`,
  `checkpoint-seal-id-mismatch`, `checkpoint-seal-digest-mismatch`,
  `checkpoint-seal-generation-mismatch`,
  `checkpoint-seal-record-digest-mismatch`).
- Determinism: identical checkpoint + provenance + sealedAtUtc →
  byte-identical seal, sealDigest, and sealed bytes. A different explicit
  sealedAtUtc leaves contentDigest/checkpointId unchanged and moves
  sealDigest/sealed bytes (expected).

---

## 4. Fundamental invariants

### 4.1 Identity

```text
taskId + taskInstanceId
sessionId
workspace/repository identity
checkpoint generation
```

must match the active binding. Any mismatch in any component → **KEEP**
(no mutation). A `taskId` alone is never sufficient.

### 4.2 Safe point

The active projection may not be modified without a proven safe point. A safe
point requires, at minimum: authoritative completion for the exact
`taskInstanceId`, a captured `safePointBoundarySeq`, and no open tool
protocol group crossing the boundary.

### 4.3 Checkpointability

```text
no checkpointability proof  →  no active compaction
```

The gate's `checkpointable: false` or an absent/unprovable result keeps the
original context.

### 4.4 Snapshot consistency

A checkpoint is built against a captured **versioned** state
(`ContextSnapshotToken`) and the state is **revalidated before mutation**.
A mismatch between capture and apply → KEEP. Planning against a moving surface
is forbidden.

### 4.5 Self-contained generation

```text
CP3 must not require CP1 + CP2
```

for normal continuation. Each generation's payload is complete on its own:
dropping every earlier generation must not reduce the information available
for continuation.

### 4.6 Latest-only projection

Canonical storage may contain `CP1 → CP2 → CP3`. The **model-facing
projection contains only the latest applicable full checkpoint**. Earlier
generations may remain in canonical storage and may remain present as
*addressable history*, but they are not model-facing as active full
checkpoints.

### 4.7 Append-only history

Raw canonical session events remain recoverable. A projection replacement
changes the *derived* surface only; it never deletes a canonical event. The
user-visible transcript (append-origin events) stays intact.

### 4.8 Current prompt

Any user event after the frozen checkpoint boundary survives **exactly once**.
Never 0 copies. Never 2 copies.

### 4.9 Trust

Repository/tool/model-derived text never gains controller authority merely
because it is rendered inside a controller checkpoint. Trust is attached per
field by `TrustNormalizer` and is immutable after sealing.

### 4.10 Integrity

Checkpoint identity binds to the canonical checkpoint **content hash**. A
checkpoint whose content does not hash to its recorded identity is refused.
The complete seal record is independently bound by `sealDigest`
(section 3.13); neither digest covers the other (no recursive hashing).

### 4.11 One full checkpoint payload per generation  *(A00 correction — see section 6)*

```text
one generation  =  exactly one full checkpoint payload node in the projection
```

A generation whose shadowed source range is split by host-owned runtime-context
snapshot nodes produces **one replacement node per segment** — this is a
non-negotiable property of the pinned host (section 5.2). Exactly one of those
nodes carries the full checkpoint payload (the `payload` segment); every other
segment node carries a bounded **continuation anchor** that references the
operation identity and **carries no checkpoint payload**.

Forbidden projection shape:

```text
CP2
runtime snapshot
CP2
```

Required projection shape:

```text
CP2 (payload)
runtime snapshot
continuation anchor (operationId, segment k/n)
retained tail
```

### 4.12 Host runtime-policy ownership

Nexus MUST NOT synthesize the host runtime-policy snapshot. DSH owns
runtime-policy projection. The authority is the **last** runtime-context
snapshot on the surface (DSH supersede framing); Nexus only ever excludes
host-owned snapshot nodes from a shadowed range and never appends one.

---

## 5. Pinned host contract (verified against the installed host)

Every statement below was executed against
`@deepseek-ai/dsh-session@0.1.1-rc.2` during CCV2-A01. Line references are to
`<installRoot>/app/node_modules/@deepseek-ai/dsh-session/lib/index.js`.

### 5.1 Supported projection seam

- `session.append(type, data, { surfaceOp: 'append' })` appends to the surface
  tail.
- `session.append('user/message', data, { surfaceOp: { op: 'replace', start,
  end }, sourceEventSeqs })` replaces one **contiguous live span** with exactly
  one node (module line ~427: the span is spliced with the single new seq).
- `deriveMessages()` folds the live surface with the per-node rule
  `deriveEventMessage` (line ~278). The raw log (`session.events`) is
  append-only and untouched.
- Replacement range endpoints must be **currently live surface nodes**
  (line ~339–350).
- `Session.fromRestore(id, seed, header)` is the public restore path
  (line ~1371); it validates storage format, envelopes, seq contiguity,
  surface transitions and header fields, then appends a `session/end-seed`
  marker.
- `SessionStore.flush(session)` (line ~1791) is the durability barrier: it
  dispatches `session/flush` to listeners and returns whether at least one
  listener participated.

### 5.2 Non-negotiable split constraint

`assertProvenance` (line ~335) rejects any replacement whose
`sourceEventSeqs` does not include **every** shadowed surface node:

```text
surface replace: sourceEventSeqs must include every shadowed surface node; missing …
```

Observed during the A01 probe: a single-span replace over a range containing an
owned `@deepseek-ai/dsh-system-prompt` snapshot node **throws** unless the
snapshot is cited — and citing it shadows it. Consequently, excluding a
host-owned snapshot that lies strictly inside the shadowed range **requires
splitting the plan into one segment per contiguous run and therefore one
replacement node per segment.**

### 5.3 Runtime-context snapshot ownership

Runtime-context nodes are `user/message` events whose
`data.source = { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`.
DSH commits them itself; the **last** one on the surface is authoritative.

### 5.4 Session format

`SESSION_FORMAT_VERSION = 0`. Incompatible logs are rejected; no migration is
provided. V2 must not write a log an older runtime would read incorrectly.

---

## 6. A00 correction 1 — split segments and the checkpoint payload

**Disproven v0.3 assumption.** The v0.3 material treats a generation's
projection as *one replacement node* (carrying the checkpoint). The pinned host
makes that impossible whenever the shadowed range is split by a host-owned
runtime-context snapshot. Carrying the same checkpoint payload in every segment
node — which is what the V1 plan construction does — puts the full checkpoint
into the model-facing projection **once per segment**. A01 measured exactly 2
copies for a 2-segment generation, with the projection
`CP / runtime snapshot / CP`.

**Required architecture change (now frozen in 4.11 and 3.8).**

1. `RetentionPlanner` produces segments with an explicit `role`.
2. Exactly one segment has `role: 'payload'`; it is the earliest segment of
   the generation (the canonical position of the compacted region).
3. Every other segment has `role: 'continuation'` and is replaced by a bounded
   continuation anchor of the form
   `<nexus-context-continuation operation="…" generation="n" segment="k/n"/>`
   — operation identity only, **no payload**.
4. `TransactionalApply` refuses a frozen plan whose segments do not contain
   exactly one `payload` role, or that contains any payload text outside the
   payload segment.
5. A generation therefore yields exactly one full checkpoint payload in
   `deriveMessages()`, regardless of how many segments the host forces.

This is an architecture correction, not a test accommodation: no production V1
code was changed, and the correction is enforced by the V2 contract above.

---

### 6.1 A00 finding 2 — retained host runtime snapshots accumulate (not blocking)

**Observed.** A01 measured the model-facing projection after each generation
(real pinned host, real store):

```text
after CP1 : [CP-payload, snapshot(A), anchor, user, assistant, user]
after CP2 : [CP-payload, snapshot(A), anchor, assistant, snapshot(B), user]
after CP3 : [CP-payload, snapshot(A), anchor, snapshot(B), anchor,
             assistant, snapshot(C), user]
```

Every host-owned runtime-context snapshot that falls inside a shadowed range is
**excluded** from that range (the V1 exclusion invariant kept by section 4.12)
and therefore survives in the projection forever. After three generations all
three snapshots — A (stale), B (stale) and C (current) — are still model-facing.

**Severity: important, not blocking.**

- Authority is still correct: DSH's supersede framing makes the LAST snapshot
  authoritative, A01 asserts exactly one authoritative snapshot per generation
  and after every restore, and each snapshot's own text states that it
  supersedes earlier ones.
- Therefore invariant 4.6 (latest-only *checkpoint* projection) is not
  violated: the accumulation concerns runtime-context snapshots, not
  checkpoints.
- But projection size grows by one snapshot per policy change, and stale policy
  text remains visible to the model.

**Required A02 decision (do not improvise).** Choose and freeze one:

1. *Keep the V1 exclusion* (status quo): accept bounded, documented
   accumulation, and add a measurable ceiling with telemetry; or
2. *Exclude only the authoritative snapshot*: allow a stale host-owned snapshot
   that is not the last one on the surface to be shadowed with the bulk. This
   is compatible with the host (superseded snapshots carry no authority) but it
   **weakens a V1 invariant**, so it may not be introduced silently and must
   come with its own failure proofs.

Until A02 decides, the V1 exclusion invariant stands.

---

## 7. State machine

```text
inactive → eligible → checkpoint-ready → apply-pending
        → awaiting-durability → applied        (terminal, never rolls back)
blocked                                        (reachable from any state)
```

Per generation. `applied` is per generation, not per task: generation *n+1*
starts its own `inactive → …` cycle on the same binding.

- Transitions are explicit, persisted, and idempotent.
- `checkpoint-ready` requires a validated checkpoint for the same
  `taskInstanceId`; `apply-pending` requires a validated frozen operation.
- `applied` requires durable evidence, never in-memory presence.
- Save points are crash-safe: an attempt resumes by reconciling the frozen
  operation, never by re-planning.

---

## 8. Failure semantics (KEEP everywhere)

Unprovable completion, ambiguous usage, malformed checkpoint, write failure,
instance mismatch, repository mismatch, missing append seam, unbalanced cut,
empty surface, unproven checkpointability, snapshot token mismatch, split plan
without exactly one payload segment, crash before apply, flush failure, or a
non-participating persistence listener: **all keep the old context and let the
session continue.** No half-compacted state exists. All lifecycle writes are
atomic.

---

## 9. Non-goals (V2, unchanged from V1 unless V2 states otherwise)

No scope governor, no semantic classifier, no summarization LLM, no
embeddings/vector stores, no continuation model, no cross-project or long-term
memory, no dynamic thresholds, no cost estimation, no history deletion, no
active-task compression, no subagent/reviewer/visual compaction, no provider
switching, no reasoning changes, no new fallback model, no artifact cleanup.

---

## 10. Open items deferred to CCV2-A02

- Implement `RetentionPlanner` segment roles and continuation anchors in
  production (`scripts/ContextLifecycle.ps1`, `config/ContextCompaction.cjs`,
  `config/AihController.cjs`) and enforce them in the frozen-operation
  validator.
- Extend `CompactionOperationV2` persistence to carry `generation`,
  `snapshotTokenId`, `safePointBoundarySeq` and segment roles.
- Generation-aware `operationId` derivation (add `generation` to the domain
  string) plus JS/PS parity tests.
- Multi-generation lifecycle tests, telemetry per generation, and the
  PowerShell acceptance gate.
- `ContextCompiler` / `DecisionProvider` remain unimplemented.

No V2 production behavior may be enabled before A02.

---

## 11. A01 verification record

The frozen contracts above are backed by an executed proof, not by intention:

| Item | Value |
| --- | --- |
| Proof | `tests/ContextCompactionV2DshGenerationProof.Tests.cjs` |
| Host | real `@deepseek-ai/dsh-session` `0.1.1-rc.2` — real `SessionStore` on a real cordis `Context` |
| Durability | real `store.flush()` -> `session/flush` barrier |
| Restore | real `store.create(id, { seedSource: 'persistence', seed, meta })` -> `Session.fromRestore` |
| Result | 114 assertions, 0 failures |

Observed projection per generation (real `deriveMessages()`):

```text
raw       : [user, user, host-runtime-snapshot(A), 10x(tool-call, tool-result), user, assistant, user]
after CP1 : [CP-payload, host-runtime-snapshot(A), CP-anchor, user, assistant-text, user]
after CP2 : [CP-payload, host-runtime-snapshot(A), CP-anchor, assistant-text,
             host-runtime-snapshot(B), user]
after CP3 : [CP-payload, host-runtime-snapshot(A), CP-anchor,
             host-runtime-snapshot(B), CP-anchor, assistant-text,
             host-runtime-snapshot(C), user]
```

Segment counts: CP1 = 2, CP2 = 2, CP3 = 3. Payload nodes per generation: 1.
Canonical log: 26 raw events -> 48 events, every raw event byte-identical
throughout. Every generation and every restore kept exactly one full
checkpoint payload model-facing, one authoritative runtime snapshot, a
tool-balanced projection, and the current user message exactly once.

A01 scope limit (no over-reading): A01 proved host projection behavior and
reused the V1 balanced-cut safety core. Trust normalization
(`TrustNormalizer`), content sealing (`ContentSealer`), and the
`CheckpointabilityGate` production implementation were NOT executed in A01
and remain deferred architecture contracts pending later tasks.

---

## 12. A05 snapshot-token freeze record

A05 proves TOCTOU safety: a sealed checkpoint that is structurally valid,
authentic, and untampered may still be STALE, and stale state BLOCKs before
any new mutation. A05 answers "is this still the same authoritative state?"
only; safe-point detection (A06), the checkpointability gate (A07),
pressure/retention (A08), shadow-mode triggering (A09), and active
production compaction (A10) are NOT implemented here.

Frozen: ContextSnapshotToken schema, SnapshotManager ownership,
revisionDigest formula, snapshotTokenId formula, capture consistency,
freshness semantics, checkpoint binding, operation binding, restart
semantics, partial-apply interaction, and the TOCTOU validation location
(section 3.1). Proof: tests/ContextSnapshotV2.Tests.cjs (118 assertions,
0 failures). Authority: config/ContextSnapshotV2.cjs. PS twins for the two
identity formulas: scripts/ContextLifecycle.ps1
(Get-AihContextSnapshotRevisionDigestV2, New-AihContextSnapshotTokenIdV2;
PS never mints tokens).

Revert semantics: task state is state-based (exact revert validates again);
session seq is monotonic append-only (any intervening append stays STALE
forever). Restart: full token files (snapshot-<tokenId>.json, immutable,
read-back validated); unchanged state resumes, changed state blocks;
reconciliation of durably begun work is preserved. Mid-apply: choice B
(revalidate before the FIRST new append; A02 reconciliation governs begun
work). Bounds: token at most 8 KiB; ids/revisions/hashes bounded; digests
only, never raw content.

Regression: A01 DSH proof, A02 operation suite, A03 checkpoint suite, A04
trust/seal suite, and the V1 gates remain green (see task report).
