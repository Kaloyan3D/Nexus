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
structurally valid, integrity-sealed, and untampered while still being STALE:
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
- Threat model (frozen A05H): the seal is an unkeyed integrity seal —
  domain-separated SHA-256 over canonical metadata providing deterministic
  tamper detection and record-integrity binding. It detects
  inconsistent/partial modification when the expected identities are
  trusted. It is NOT keyed authentication: it is not a signature, not a
  MAC, and sealDigest validation is not proof that data came from Nexus.
  A04 does not defend against an attacker that can arbitrarily rewrite
  checkpoint files and recompute all public SHA-256 identities
  (`checkpointContentDigest`, `checkpointId`, `sealDigest`). Malicious
  local-writer resistance, if ever required, needs a separately designed
  keyed MAC/signature authority (explicitly out of scope for A05H; no
  HMAC/key management is introduced here).

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
- Save points are process-crash recoverable (atomic + read-back validated;
  not claimed power-loss durable, see §8): an attempt resumes by reconciling
  the frozen operation, never by re-planning.

---

## 8. Failure semantics (KEEP everywhere)

Unprovable completion, ambiguous usage, malformed checkpoint, write failure,
instance mismatch, repository mismatch, missing append seam, unbalanced cut,
empty surface, unproven checkpointability, snapshot token mismatch, split plan
without exactly one payload segment, crash before apply, flush failure, or a
non-participating persistence listener: **all keep the old context and let the
session continue.** No half-compacted state exists. All lifecycle writes are
atomic.

Frozen durability scope (A05H): metadata persistence (operations, attempts,
checkpoints, sealed checkpoints, snapshot tokens) is atomic (temp file +
rename) + read-back validated + process-crash recoverable under the
filesystem/OS contract; power-loss durability is NOT claimed (no fsync
barrier — the repository has no proven cross-platform fsync helper, and no
new storage subsystem is introduced in this hardening pass; power-loss
hardening is deferred as a separate future task). The authoritative session
durability barrier remains the real DSH `SessionStore.flush()` contract
proven in A01/A02.

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
integrity-sealed, and untampered may still be STALE, and stale state BLOCKs before
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

---

## 13. A06 safe-point freeze record

A06 answers ONE question and NOTHING else:

```text
Is the current execution boundary safe for checkpoint creation
and future context compaction?
```

It does NOT decide whether compaction is needed, whether the task is
checkpointable (A07), what should be retained, or how the prompt is
rebuilt. Authority: `SafePointDetector`
(`config/ContextSafePointV2.cjs`) is the SOLE V2 safe-boundary authority
(boundary classification, open-edge detection, the safe-point decision,
stable refusal reasons, boundary identity). No other CCv2 component
redefines what "safe" means. The only production seam is
`detectSafePointV2()` (plus the pure binding helpers); no triggers, no
automatic checkpoint creation, no projection mutation.

Core invariant (frozen): NO CHECKPOINT ACROSS AN OPEN EXECUTION EDGE.
A checkpoint may only be created at an execution boundary where Nexus can
produce a coherent authoritative state without cutting through an
in-flight protocol interaction.

### 13.1 `SafePointDecisionV2` (frozen)

```text
SafePointDecisionV2 {
  schemaVersion     : integer (1)
  safe              : boolean
  boundarySeq       : integer | null   — exact durable session event seq
  boundaryKind      : SafePointBoundaryKind | null
  blockers          : SafePointBlocker[] — { code, detail }, code-sorted
  inspectedRevision : { taskRevision, sessionRevision, runtimeSnapshotId }
}
```

- `safe === true` requires empty `blockers` and a grounded boundary;
  unsafe requires at least one blocker and carries a NULL boundary.
- Closed world (A05H rule): input and decision objects are exact-key
  validated BEFORE any derived logic; unknown fields FAIL CLOSED (throw,
  never "safe"). `validateSafePointDecision()` additionally rejects
  `safe`-with-blockers, `unsafe`-without-blocker, and unknown codes.
- Determinism: pure over the input; no clock, no randomness, stable
  code-sorted blockers. No timing heuristics anywhere (no "quiet for
  Nms", no text-length inference): streaming state comes from unclosed
  `assistant/chunk` runs, never from timing.
- Security: classification derives ONLY from trusted protocol/controller/
  runtime structure (event types/seqs/markers, controller flags, runtime
  flags). Repository/tool/model TEXT (including "SAFE_POINT=true") is
  inert data.

### 13.2 Boundary taxonomy (frozen)

Every category names a real production boundary:

| Kind | Grounded meaning |
| --- | --- |
| `user-turn-committed` | tail message-producing event is `user/message` |
| `assistant-turn-committed` | tail is a text-only `assistant/message` (a message still carrying `tool-call` blocks is NEVER safe) |
| `tool-result-committed` | tail is `tool/result` with every requested call resolved |
| `controller-step-committed` | tail is a `step/end` closing a committed DSH/controller step |
| `task-complete` | controller completion committed plus every other safety leg |

### 13.3 Unsafe-state taxonomy (frozen codes)

`safe-point-assistant-stream-open` (unclosed chunk run),
`safe-point-tool-call-open` (request with no recorded `tool/call` start),
`safe-point-tool-result-pending` (started call with no committed result),
`safe-point-tool-transaction-open` (open `step`),
`safe-point-controller-transition-open` (controller mutation in progress,
including uncommitted completion), `safe-point-session-not-durable`
(boundary beyond the observed `flushedSeq` or no participating flush),
`safe-point-runtime-transition`, `safe-point-protocol-unbalanced` (open
`turn` per the `interruptedTurnClosers` rule), and
`safe-point-boundary-unavailable` (empty log or no message-producing
event). Two binding legs extend the code list: `safe-point-state-changed`
(detect->capture race) and `safe-point-boundary-mismatch` (A03 binding).
Codes are never weakened: the V1 open-tool protection
(`balancedRetainCut`) stays intact, and A06 owns its V2 classification
rather than proxying a boolean.

Tool lifecycle rule (frozen): a `tool-call` request without its matching
`tool/result` is UNSAFE; `call-open` vs `result-pending` stay separate
because `tool/call` presence distinguishes them. One finished tool never
covers an unresolved sibling: ALL obligations of the turn must close.
Failure boundaries are explicit: a durably recorded error result closes
its obligation (`failure != unsafe forever`).

### 13.4 Durability, controller, runtime (frozen)

- Durability: `boundarySeq` (the tail event seq) must be durably
  established (`flushedSeq >= boundarySeq` with a participating
  `SessionStore.flush()` barrier). Memory presence alone never suffices;
  A02 durability semantics are unchanged and A06 duplicates none of them.
- Controller: `transitionOpen`, or `taskStatus == complete` without
  `completionCommitted`, blocks (milestone/completion/requirement
  half-applies are never checkpointed through).
- Runtime: `transitionOpen` blocks; the current snapshot seq follows the
  A01/A02 host-owned rule (last host-owned runtime-context node on the
  live surface) and is observed, never synthesized. A06 creates no
  runtime snapshots.
- `safePointBoundarySeq` is the pinned DSH canonical append-log ordinal
  (Outcome A, hardened): the authoritative per-event `seq` field of the
  last execution event. The host assigns `seq` equal to log length at
  `append`, rejects any restore seed whose persisted `seq` differs from
  its index, rejects non-contiguous surface transitions, and carries the
  ordinal explicitly in storage (`seq0` chunk-row base). Position and
  persisted field therefore agree by host contract, never by JS
  coincidence; A06 additionally revalidates contiguity and fails closed
  on absent or malformed seqs. The host `session/end-seed`
  seed-boundary marker is transparent to boundary identity (storage
  bookkeeping, no execution semantics), so a restore reports the exact
  same boundary. No array indexes, message counts, surface counts,
  prompt positions, or clocks are ever used as boundary authority.

### 13.5 Ordering, races, bindings (frozen)

Required future order: `SafePointDetector` -> safe boundary confirmed ->
`SnapshotManager.capture()` -> `CheckpointBuilder`. A snapshot captured
at an unsafe boundary must never become authoritative.

Capture race (frozen): a SAFE decision is NOT a timeless capability.
`assertSafePointFresh()` compares the decision `inspectedRevision`
(`taskRevision`, `sessionRevision`, `runtimeSnapshotId`) plus the
boundary against the capture-time observation; any movement -> BLOCK
with `safe-point-state-changed` (retry). A05 capture consistency
(`captureConsistent` / `revalidate`) remains the mechanism that rejects
mixed/stale revisions.

A03 binding (frozen): `checkpoint.safePointBoundarySeq` MUST equal the
exact A06 `boundarySeq` used for capture (`assertCheckpointBindsSafePoint`;
mismatch -> BLOCK). A02 compatibility (frozen): no A02 operation is ever
created from an unsafe boundary; A06 precedes operation creation and
changes no durable operation/reconciliation semantics.

Restart (frozen): a committed boundary replays to the exact same
boundary seq and kind and remains SAFE across restore with no renumbering
(the seeded events are the durable bytes verbatim and the seed-boundary
marker is transparent); reordered or gapped seeds are rejected by the host
restore boundary itself, so restored ordering cannot move a previously
valid boundary. Incomplete protocol state replays as incomplete and never
becomes falsely safe. A05 relationship (frozen): A05 answers "is the state still
the same state that was captured?"; A06 answers "is NOW a coherent
boundary at which capture may occur?". Current-user-message invariant
(A01 4.8) is preserved: the safe boundary is the tail seq, so the active
request sits AT the boundary and survives exactly once.

Proof: `tests/ContextSafePointV2.Tests.cjs` (unit matrix, 81 assertions)
and `tests/ContextSafePointV2LiveHost.Tests.cjs` (real pinned-host proof
under `NEXUS_REQUIRE_CCV2_LIVE_HOST=1`, 41 assertions). Harness entries:
`ContextSafePointV2`, `ContextSafePointV2LiveHost`. Known limitation
(UNVERIFIED, never simulated): a spontaneous host-driven transition
landing mid-detect has no offline inducer; the architecture relies on the
A05 capture-consistency retry for that window.
---

## 14. A07 checkpointability-gate freeze record

Production module `config/ContextCheckpointabilityV2.cjs` is the sole V2
checkpointability authority (`CheckpointabilityGate`). It answers exactly
one question: can the current authoritative task state be represented by
a CCv2 checkpoint completely enough to resume correctly without silently
losing required task semantics? Core invariant: CCv2 may forget from the
prompt; CCv2 must never forget from the task.

### 14.1 `CheckpointabilityDecisionV2` (frozen)

```text
CheckpointabilityDecisionV2 {
  schemaVersion         : integer (1)
  checkpointable      : boolean (true iff blockers is empty)
  taskId, taskInstanceId, sessionId : string (binding)
  safePointBoundarySeq: integer (authorizing A06 boundary)
  snapshotTokenId     : string (authorizing A05 token)
  revisionDigest      : string (authorizing A05 revision)
  requiredState       : { count: integer, digest: sha256 hex }
  representableState  : { count: integer, digest: sha256 hex }
  blockers            : [{ code: frozen code, detail: string|null }] (sorted)
}
```

Closed-world validation applies to every A07 protocol object (task state,
evaluate input, coverage input, decision): unknown keys FAIL CLOSED before
any digest, comparison, or decision. No field is ever silently stripped.

### 14.2 Required state, inventory, coverage (frozen)

- Required authoritative state is every current authoritative fact whose
  absence could change future execution (identity, objective, active
  requirements, constraints, progress, decisions, repository references,
  required evidence, failures, retry state, verification, continuation,
  safe-point boundary, snapshot identity). Derived/cache/advisory state
  never enters the contract; the explicit non-required classes (UI state,
  render state, derived caches, temp indexes, derived summaries,
  non-continuation telemetry, recomputable ranking data) are omitted only
  as classes, never by judgment.
- `AuthoritativeStateInventoryV2` items carry `{ stateKind, stateId,
  sourceKind, authorityScope, requiredForContinuation, contentDigest }`
  plus the A03 destination. Raw giant content and secrets never enter the
  inventory: bounded identities and redacted (frozen A03 redaction)
  digests only.
- Coverage invariant: every `requiredForContinuation === true` item is
  either represented in its A03 destination section or deterministically
  reconstructible from a referenced authoritative durable source
  (`durable-reference` with an accessible locator). No third category
  exists; a stale (inaccessible) reference never counts as coverage.
- Forward-safety: any authoritative state with no representation or
  reconstruction rule (declared via `unsupportedState`) BLOCKS with
  `checkpointability-unsupported-authoritative-state`. Schema evolution
  can never silently drop new controller state.
- Authority preservation uses A04 provenance semantics verbatim (the A04
  `TrustNormalizer` is the oracle; derived trust must stay inside
  authoritative/user-intent/evidence). Downgrade or elevation mismatches
  BLOCK. A valid `ContentSeal` proves the bytes did not change
  inconsistently; it never proves the bytes contain all required state.
- Ephemeral state (open handles, callbacks, IPC, unpersisted handles,
  volatile streams, model runtime refs) required for continuation BLOCKS
  with `checkpointability-ephemeral-state-required`.
- Size preflight enforces the frozen A03 bounds and the 64 KiB serialized
  bound without truncation, summarization, or dropping required state
  (`checkpointability-size-bound-exceeded`).

### 14.3 Bindings, ordering, races (frozen)

- A07 requires a valid A06 decision with `safe === true` whose
  `boundarySeq` authorizes the evaluated state
  (`checkpointability-safe-point-required`); A06 logic is consumed, never
  duplicated.
- A07 requires the matching A05 token (task/instance/session/generation/
  boundary identity plus revision equality). Absent or mismatched tokens
  BLOCK with `checkpointability-snapshot-required`; tokens that no longer
  describe live reality BLOCK with `checkpointability-snapshot-stale`.
  No timestamp freshness is introduced: revision semantics only.
- Required order: A06 detect SAFE -> A05 capture -> A07 evaluate -> A05
  freshness verification -> checkpoint construction. Revision movement
  between capture and evaluation BLOCKS with
  `checkpointability-state-changed` (retry).
- Pre-build (`evaluateCheckpointabilityV2`) answers whether the state CAN
  be represented. Post-build (`assertCheckpointCoverageV2`) answers
  whether the produced checkpoint DOES represent everything required,
  including authority preservation per mandatory A04 path. A03 structural
  validity never implies semantic completeness. The A03 builder owns
  construction; it never owns checkpointability.
- Digests (frozen formulas): `requiredStateDigest = SHA256(UTF8(
  'nexus/context-required-state/v1' LF
  canonicalJson(normalizedRequiredStateInventory)))` and likewise
  `representedStateDigest` under `'nexus/context-represented-state/v1'`.
  No timestamps, no traversal-order dependence. Coverage is proven by the
  explicit item mapping, not by digest equality.
- No LLM or heuristic ever decides importance: classification is
  deterministic over authority metadata. Repository/tool/model text is
  inert data.

### 14.4 Blocker codes and proofs (frozen)

Stable codes: `checkpointability-safe-point-required`,
`checkpointability-snapshot-required`, `checkpointability-snapshot-stale`,
`checkpointability-unsupported-authoritative-state`,
`checkpointability-required-state-uncovered`,
`checkpointability-authority-mismatch`,
`checkpointability-objective-incomplete`,
`checkpointability-requirement-uncovered`,
`checkpointability-constraint-uncovered`,
`checkpointability-decision-uncovered`,
`checkpointability-evidence-unavailable`,
`checkpointability-failure-state-uncovered`,
`checkpointability-verification-state-uncovered`,
`checkpointability-continuation-incomplete`,
`checkpointability-ephemeral-state-required`,
`checkpointability-size-bound-exceeded`, `checkpointability-state-changed`,
`checkpointability-checkpoint-coverage-mismatch`. Codes collapse only where
the state model cannot distinguish them; `checkpointable === true` iff
`blockers` is empty.

Restart semantics (frozen): a persisted checkpoint plus its token file
reload to byte-identical artifacts that still cover every required item;
no required semantic depends on the old prompt. Multi-generation
semantics (frozen): at every generation the current required state is a
subset of checkpoint-covered or reconstructible state; each generation is
self-contained; no retention policy is introduced here.

Proof: `tests/ContextCheckpointabilityV2.Tests.cjs` (unit matrix, 104
assertions) and `tests/ContextCheckpointabilityV2LiveHost.Tests.cjs`
(real pinned-host proof under `NEXUS_REQUIRE_CCV2_LIVE_HOST=1`, 25
assertions). Harness entries: `ContextCheckpointabilityV2`,
`ContextCheckpointabilityV2LiveHost`. No A08 pressure/retention logic and
no automatic checkpoint/compaction trigger are introduced.

---

## 15. A08 pressure + retention freeze record

A08 is the deterministic CCv2 **policy/planning plane**. It answers two
questions and NOTHING else: (1) how much usable context headroom remains,
and (2) what existing context may leave the active prompt without violating
the frozen A01-A07 safety contracts. A08 performs NO compaction: it never
deletes context, never mutates the session projection, never triggers a
checkpoint, and never performs automatic compaction. Pressure may REQUEST
compaction; retention may PROPOSE what is eligible to leave; neither
mutates the live session. A09 observes plans in shadow mode; A10 is the
first stage allowed to apply one.

Core rule (frozen): pressure NEVER overrides safety. Permission to compact
requires A06 SAFE + A05 FRESH + A07 CHECKPOINTABLE + an A08 actionable plan.
CRITICAL pressure with any safety leg refusing yields `blocked`, never
`compact anyway`.

Authorities (frozen, one decision each; no policy duplicated elsewhere):

- `ContextPressureV2` (`config/ContextPressureV2.cjs`): provider-capacity
  accounting, explicit reserves, headroom computation, frozen threshold
  policy, deterministic level + recommendation.
- `RetentionPlannerV2` (`config/ContextRetentionV2.cjs`): closed-world
  retention classification, contiguous-prefix candidate boundary, retained
  suffix planning, projected savings, plan identity, stale-plan validation.
  A05/A06/A07 verdicts are consumed verbatim through their own validators
  and never redefined here.

Provider capacity (frozen): the ONLY grounded source is
`config/model-registry.json` (`contextWindow` per model id) via
`resolveProviderCapacity()`. Unknown model, missing registry, or missing
`contextWindow` yields `known: false`, level `UNKNOWN`, recommendation
`blocked` with `pressure-capacity-unknown`. Invented windows are
FORBIDDEN. UNKNOWN is first-class: eligibility analysis may still be
produced, but no HIGH / CRITICAL level and no token headroom may be
claimed without grounded capacity.

Context cost (frozen precedence): real provider tokenizer/count, then the
existing Nexus deterministic estimator (none exists; reserved), then the
explicit conservative estimate (`ceil(UTF-8 bytes / 4)`, always recorded
with `method` and `exact: false`). Estimated counts are never represented
as exact provider token counts.

Frozen pressure formulas:

```text
usableCapacity = providerCapacity - reservedOutput - reservedProtocol - reservedSafety
headroom       = usableCapacity - currentActiveContextCost
usedFraction   = currentActiveContextCost / usableCapacity
```

Frozen default reserves (`nexus/context-reserve-policy/v1`): output 8192,
protocol 4096, safety 4096. Callers SHOULD supply grounded per-route
reserves; defaults apply only for null inputs and are always reported
verbatim. Reserves that consume the whole window fail closed
(`pressure-accounting-invalid`).

Frozen threshold policy (`nexus/context-pressure-policy/v1`), evaluated on
`usedFraction` (headroom-based, never age/message-count based): `>= 0.95`
CRITICAL, `>= 0.85` HIGH, `>= 0.70` ELEVATED, else NORMAL. Recommendation
mapping: NORMAL `none`, ELEVATED `prepare`, HIGH `compact-when-safe`,
CRITICAL `compact-required`, UNKNOWN `blocked`. Hysteresis exits (0.90 /
0.80 / 0.65) and `minimumReclaimTokens` (2048) are frozen alongside for A09
thrash protection; the level itself is a pure enter-threshold function.
Projected reclaim below 2048 yields `retention-insufficient-reclaim`, even
under CRITICAL (honest block, never compact).

Retention classes (frozen closed world): `ACTIVE_REQUIRED`,
`CHECKPOINT_COVERED`, `REHYDRATABLE`, `DERIVED_DISCARDABLE`,
`NOT_ELIGIBLE`. Eligibility derives ONLY from authority metadata
(continuation requirements, A07 coverage, durability, reconstructibility,
protocol position). Age alone never makes an event eligible; size alone
never makes content eligible; prompt/repository/tool text has zero policy
effect (content-bearing input fields FAIL CLOSED). Required uncovered
state is `NOT_ELIGIBLE`; A07-covered historical state is
`CHECKPOINT_COVERED` (releasable only after A07 post-build PASS plus
persisted seal); validated durable references yield `REHYDRATABLE`
(stale or dangling refs are `NOT_ELIGIBLE`); explicitly non-authoritative
derived state is `DERIVED_DISCARDABLE`; the current user request is
`ACTIVE_REQUIRED` and survives exactly once. A derived flag can never
rescue uncovered required state.

Boundary semantics (frozen): compaction is a contiguous eligible old prefix
plus a retained suffix. The candidate boundary is a real authoritative DSH
event seq at or before `safePointBoundarySeq` (never a message index,
timestamp, or array guess). One non-eligible event inside the prefix moves
the cut earlier or BLOCKS; the planner never skips around it. Declared
protocol spans (tool request/result, stream, controller transition) are
never split; the cut moves earlier or blocks with
`retention-boundary-mismatch`. Units must tile `[0..maxSeq]` contiguously.

Frozen plan identity (no timestamps in the digested body):

```text
retentionPlanDigest = SHA256(UTF8('nexus/context-retention-plan/v1' LF canonicalJson(planBodyWithoutDigestOrId)))
retentionPlanId     = 'crp_' + SHA256('nexus/context-retention-plan-id/v1' LF taskId LF generation LF retentionPlanDigest)[0:32]
```

Every actionable plan binds `taskId`, `taskInstanceId`, `sessionId`,
`generation`, `snapshotTokenId`, `revisionDigest`, `safePointBoundarySeq`,
and the provider route/capacity. `assertRetentionPlanFresh()` BLOCKS with
`retention-plan-stale` on ANY drift (snapshot, revision, boundary,
generation, model route, capacity). Persisted plans reload validated but
never auto-authorize: freshness plus live A05 revalidation gate every use.
No cross-generation reuse (G1 plans are stale in G2).

Projected savings (`projectedReclaimTokens`, `projectedRetainedTokens`,
`projectedHeadroomAfterTokens`) are deterministic sums of declared unit
costs with honest precision (`exact` only when every unit cost is exact,
else `estimated`). Telemetry for A09 shadow comparison carries
counts/digests/ids/levels/blocker codes only; secrets and raw contents
never enter plans or telemetry.

Scope limit (no over-reading): A08 introduces NO A09 shadow execution, NO
A10 active apply, NO Phase B ContextPage/memory tiers, no
`CompactionOperationV2`, no checkpoint-schema/seal change, no LLM
judgment, no semantic retrieval, no summarization. A01 projection
compatibility is proven read-only (the retained suffix references real DSH
seqs; nothing is written).

Proof: `tests/ContextPressureV2.Tests.cjs` (pressure matrix, 50
assertions), `tests/ContextRetentionV2.Tests.cjs` (retention/safety/race/
multi-generation/determinism/security/restart/large-context matrices, 108
assertions), and
`tests/ContextPressureRetentionV2LiveHost.Tests.cjs` (real pinned-host
proof under `NEXUS_REQUIRE_CCV2_LIVE_HOST=1`, 49 assertions: multi-turn
session with closed tool lifecycle, read-only planning, projection dry run,
continued-work staleness, open-edge blocking). Harness entries:
`ContextPressureV2`, `ContextRetentionV2`,
`ContextPressureRetentionV2LiveHost`. No A09/A10 logic is introduced.

---

## 16. A08H pressure-authority + safe-cut hardening record

A08H closes three authority/binding gaps before freezing A08. Frozen
A01-A07 semantics are unchanged; A08 retention classes and the digest/id
formula SHAPES are unchanged (the plan v1 body gains two bound fields,
explicitly amended below; the branch is unreleased so no migration
exists).

H1 capacity authority (frozen): the discovered existing production
authority is `Get-AihReviewerModelCapacity` in `scripts/CodexReview.ps1`
(TASK-0012): provider `/models` metadata when it declares capacity, then
the deterministic model-registry capability entry, then UNKNOWN (never
fabricated). `resolveProviderCapacity(modelId, providerModelsMetadata)`
in `config/ContextPressureV2.cjs` implements the SAME order on the
Node side (no second competing resolver): declared provider metadata
wins over any caller-asserted value; a claimed `model-registry` source
is verified against the registry and refused on mismatch; otherwise the
registry resolves automatically; nothing declaring anything yields
UNKNOWN. Field scan order mirrors the PS lists verbatim
(context_window first, truncation semantics included). Malformed
capability containers fail closed; well-formed documents that declare
nothing fall back per the existing policy. A08 never fetches provider
metadata: the caller supplies the grounded document (or null). Every
pressure decision records `capacitySource` (`provider-models-metadata` |
`model-registry` | `caller-asserted` | `unknown`); null capacity implies
`unknown` and vice versa (validated). The validator additionally
recomputes `usableCapacityTokens` and `remainingHeadroomTokens` from
capacity minus reserves (forgery-closed).

H2 historical-cut authorization (frozen): A06 is the sole safe-boundary
authority for historical candidate cuts. New A06-owned pure/read-only
`classifyHistoricalBoundaryV2()` (plus
`validateHistoricalBoundaryDecision()`) reuses the frozen
`detectSafePointV2` state machine verbatim over the authoritative prefix
`events[0..candidateSeq]` (durability must cover the candidate; current
controller/runtime observations reused fail-closed). Retention computes
the latest retention-eligible prefix end, then walks unit-aligned
eligible ends backward (skipping span-splitting cuts) asking A06 about
each exact seq; the first A06-safe end is the candidate. None yields
`candidateCompactionBoundarySeq = null`, `actionable = false`, and the
explicit blocker `retention-no-safe-boundary`. `eligiblePrefixEndSeq`
stays informational (may exceed the authorized cut); projected reclaim
counts only the A06-authorized cut. The plan validator enforces
`candidate <= eligiblePrefix`, full eligibility of the cut prefix, and
`retainedSuffixStartSeq == candidate + 1` (0 when null).

H3 pressure-basis binding (frozen): one deterministic digest covers every
pressure-policy assumption a persisted plan stays actionable under:

```text
pressureBasisDigest = SHA256(UTF8('nexus/context-pressure-basis/v1' LF canonicalJson({thresholdPolicyId, reservePolicyId, reserves, providerModelId, providerCapacityTokens, capacitySource, costMethod, costExact})))
```

Every retention plan embeds `pressureBasisDigest` (null only when the
embedded pressure decision is itself invalid, in which case the plan is
blocked and `actionable` must be false). Plan validation recomputes the
basis from the embedded pressure decision (`retention-basis-mismatch` on
drift/tamper). `assertRetentionPlanFresh()` BLOCKS with
`retention-plan-stale` when the current basis differs (including when it
is missing), so persisted plans never survive route, capacity, source,
policy-id, reserve, or cost-honesty changes without replanning. No
timestamps enter the basis. Telemetry on both authorities carries the
new source/basis identities (counts/ids only).

Proof deltas: `tests/ContextPressureV2.Tests.cjs` (77 assertions: H1
precedence/fallback/UNKNOWN/malformed/claim/source-recording plus H3
basis sensitivity); `tests/ContextRetentionV2.Tests.cjs` (133 assertions:
H2 unsafe-intermediate-cut refusal with backward selection to the
A06-safe seq, no-safe-cut blocking with zero reclaim, H3 basis
recompute/tamper/drift/missing proofs);
`tests/ContextPressureRetentionV2LiveHost.Tests.cjs` (54 assertions:
A06 historical authorization of live seq 5 as `tool-result-committed`
with plan-candidate equality, live seq-3 `tool-call-open` refusal,
basis-bound freshness). No A09 logic is introduced.

## 17. A09 core shadow-mode freeze record

A09 introduces exactly one orchestration authority,
`ShadowCompactionEvaluatorV2` in `config/ContextShadowV2.cjs`, and
redefines no lower-level authority. The frozen invariant is:

```text
SHADOW MAY PREDICT. SHADOW MAY COMPARE. SHADOW MAY REPORT.
SHADOW MUST NOT APPLY.
```

Dependency direction (frozen): `A09 -> A01-A08H` only. No frozen
foundation module references Shadow Mode (proven by the A09 unit suite
reading every foundation source). The evaluator never executes
`CompactionOperationV2`, never persists checkpoints/snapshots/tokens,
never mutates the session log, projection, controller state, or
snapshots, performs no model call, and reads no clock: `createdAtUtc`
and `sealedAtUtc` are explicit caller inputs, so repeated evaluation of
identical state is byte-identical (same `shadowDigest`, same `shadowId`).

Pipeline (frozen order; every lower-layer verdict consumed verbatim
through its own validator, never redefined): A06 safe-point decision
(`validateSafePointDecision`) -> A05 structural validity plus freshness
(`validateSnapshotToken`, `revalidate` against caller-supplied current
state) -> A07 (`validateCheckpointabilityDecision`) -> pressure
(`validatePressureDecision`; UNKNOWN claims no headroom and blocks) ->
retention (`validateRetentionPlan`; consumed verbatim including the
`retention-insufficient-reclaim` no-action leg and the NONE-recommendation
no-action leg) -> real A03 checkpoint build (mapped contract shapes;
`parentCheckpointId` carries A03 lineage for generation > 1 and is null
for generation 1; shadow lineage is never persisted as production
lineage) -> real A04 seal (`buildSealedCheckpointV2`, revalidated by
`validateSealedCheckpoint`) -> A07 post-build coverage
(`assertCheckpointCoverageV2` over the sealed checkpoint) -> pure
hypothetical projection (`buildProjectedContextV2`, reusable by A10;
cloned isolated events, seq identity preserved per A01 append-only
semantics) -> deterministic validation (retained-suffix exactness,
current request exactly once, protocol balance with no orphaned tool
edge, no split protocol span, checkpoint/plan/snapshot/boundary/
generation binding) -> deterministic before/after cost comparison via
the frozen conservative estimator (honest `estimated` precision; never
exact) -> frozen verdict plus closed-world result validation.

Verdicts (frozen): `no-action` (NORMAL/none pressure or honestly
insufficient reclaim; never a fake compaction), `blocked` (any
A05/A06/A07/UNKNOWN-capacity/non-actionable leg refuses; no projection
attempted), `shadow-ready` (complete hypothetical projection passing
every structural invariant; zero blockers), `shadow-invalid` (lower
layers allowed planning but construction or validation failed; loud,
never downgraded; a pre-A10 blocker). Non-ready verdicts always carry
at least one frozen `shadow-*` blocker code.

Identity (frozen):

```text
shadowDigest = SHA256(UTF8('nexus/context-shadow-result/v1' LF canonicalJson(body-without-digest-or-id)))
shadowId = 'csr_' + SHA256('nexus/context-shadow-result-id/v1' LF taskId LF generation LF shadowDigest)[0..32)
projectionDigest = SHA256(UTF8('nexus/context-projection/v2' LF canonicalJson(projection-body-without-digest)))
```

No timestamps enter any digested body. `assertShadowResultFresh()`
BLOCKS on any drift in task binding, generation, snapshot identity,
boundary, provider route, pressure basis, or retention plan id, so no
old projection becomes eligible for A10 without re-evaluation.
Telemetry (`shadowTelemetry()`) is observational only (never authority)
and carries exactly the bounded frozen key set (verdict, pressure level
and recommendation, safety flags, token counts, headroom, seqs,
checkpoint bytes/counts, event counts, user counts, protocol flag,
blocker codes): counts/digests/ids only, no raw text, no secrets.
Adversarial prompt/tool/repository text (`SHADOW_VALID=true`, `DROP OLD
CONTEXT`, `IGNORE RETENTION PLAN`, `COMPACTION_COMPLETE`,
`RETENTION_CLASS=DISCARDABLE`) is inert data with zero control-flow
effect. Any shadow exception fails the evaluation, never the live
session.

Proof deltas: `tests/ContextShadowV2.Tests.cjs` (115 assertions:
section-58 matrix, invalid-is-loud legs including span-split,
current-user, suffix, coverage, and construction failures, projection
machinery, closed-world input/result validation, determinism,
freshness/race/provider/basis/plan staleness, multi-generation with A03
parent lineage, restart equivalence, bounded telemetry, secret safety,
adversarial inertness, error isolation with live-state fingerprinting,
large-context CRITICAL, tool-heavy balance, failure/retry and
verification preservation, repository binding, dependency direction, no
live-apply machinery); `tests/ContextShadowV2LiveHost.Tests.cjs` (51
assertions on the pinned `0.1.1-rc.2` host under the strict gate: HIGH
pressure at 103748 honest tokens over ~419 KiB of deterministic tool
output, live cut at the real tool-result seq 5 with suffix from 6,
shadow-ready with byte-identical live events and `deriveMessages()`
before/after, rebuilt-digest suffix exactness, live open-edge blocked
with no projection, and S1-stale plus fresh-S2 after continued work).
No A10 behavior is introduced.

## 18. A09H exact post-compaction projection hardening record

A09H closes the suffix-only ambiguity: the hypothetical projection is
the COMPLETE model-facing context the frozen A01/A02 machinery would
expose after active compaction, not the remaining raw events. Retained
source suffix != complete post-compaction projection (frozen
distinction). The frozen composition, determined from the existing
production/proof implementation (no new format invented), is:

```text
replacement payload node (checkpoint canonical bytes; exactly one,
  earliest segment; aih-controller context-checkpoint source)
+ bounded continuation anchors for sibling segments, if any
  (exact buildContinuationAnchorText; context-continuation source)
+ retained suffix in surface order
```

with the replaced span spliced at its surface position per the host
`applySurfacePlan`, operation identity from the real
`deriveCanonicalOperationIdV2`, segment roles from the real
`shapeSegmentsWithRoles` over the real `planCompactionSegmentsV2`
shadowed-surface partition, and per-node message derivation mirroring
the pinned host `deriveEventMessage` verbatim (0.1.1-rc.2). The payload
text is FORCED by the frozen reconcile gate
(`sha256(payloadText)` MUST equal `checkpointContentDigest`): the only
frozen byte string with that property is the A03 canonical content
bytes (checkpoint minus id/digest/seal, provenance included); any other
rendering fails the digest gate, so this is determination, not
invention. The live proof asserts the mirror equals the real host
message projection on live data, so host drift fails loudly.

`buildCompactedProjectionV2` (plus `buildShadowCheckpointV2` and
`validateCompactedProjectionV2`) is the shared pure builder A10 will
later validate-then-apply; no shadow-only algorithm exists and no
second projection policy is introduced. `projectionDigest` covers the
complete artifact including payload text and all messages, so changed
checkpoint state changes the digest with an identical suffix (proven).
Continuation presence is proven deterministically over the payload
(objective/requirements/decisions with frozen redaction-equality,
constraints, next action, unresolved questions, verification outcomes,
failure/retry obligations, progress) with stable refusal codes
(`shadow-payload-unproven`, `shadow-projection-messages`,
`shadow-continuation-incomplete` alongside the existing suffix,
current-user, protocol, and coverage codes).

Token accounting measures equivalent model-facing message surfaces:
`beforeContextTokens` is the current message cost,
`projectedContextTokens` is the complete hypothetical message cost
(payload plus anchors plus retained suffix), both honest
`estimated`; frozen `projectedReclaimTokens = before - projected` with
the invariant `projected >= payload cost`. The result additionally
carries `reclaimComparison` (`a08PlannedReclaimTokens`,
`a09ProjectedReclaimTokens`, `deltaTokens`, `basisNote`): A08 plans in
unit token-cost basis while A09 measures the complete message basis
including the payload representation, so the delta is explicit and A09
never silently inherits a suffix-only estimate. Telemetry gains exactly
the message/payload/suffix/delta counters (still counts/ids only).

Proof deltas: unit suite grows to 159 assertions (complete-projection
contract, payload digest gate and sensitivity, required-state-via-payload
preservation, eight-way mutation matrix including suffix-only rejection,
message-basis costs with the payload invariant, A08/A09 delta integrity,
tool-heavy closed lifecycle with a non-surface tool/call seq, mirror
sanity); live suite grows to 62 assertions (mirror-host equivalence,
independent rebuild through the shared builder with digest equality,
payload-once, prefix-absent, required-state-via-payload, cost breakdown
`before=103479 payload=1104 suffix=74 projected=1177 reclaim=102302
a08planned=103604 delta=-1302`). No A10 behavior is introduced.

