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

## 19. A10 transactional active-apply freeze record

A10 is the first (and only) real active CCv2 application path. It answers
“given a fully validated fresh A09 shadow result, can Nexus apply exactly
that already-proven projection to the real DSH surface transactionally,
durably and recoverably?” A10 invents no compaction result: it applies the
one already proven by A09. Frozen invariants:

```text
SHADOW PREDICTS. A10 APPLIES EXACTLY THAT PREDICTION.
NO LIVE MUTATION UNTIL DURABLE INTENT + ALL SAFETY GATES PASS.
```

### 19.1 Authority (`config/ContextActiveApplyV2.cjs`)

One explicit authority, `TransactionalCompactionApplierV2`, exposes one
explicit API, `applyActiveCompactionV2(...)`. It orchestrates existing
authorities and redefines none: A09H `buildCompactedProjectionV2` is the
ONLY projection builder (no `buildActiveProjectionV2`, no active prompt
builder, no independent segment planning); A02 `CompactionOperationV2`
(construct, closed-world validate, atomic freeze, branded durable
read-back, `applyCompactionOperationV2`, `retryMissingSegmentsV2`,
`reconcileCompactionOperationV2`) is the SOLE transaction authority (no
`ActiveCompactionOperationV3`, no second journal); A03/A04 own checkpoint
bytes, seal, and sealed persistence; A05/A06/A07/A08 own freshness,
boundary, coverage, and pressure/retention verdicts verbatim.
Dependency direction is `A10 → A01–A09H`; no foundation module depends
on, imports, or references A10. Production default behavior is unchanged
unless the A10 API is deliberately called: no automatic triggering exists
here (even at CRITICAL pressure), and A13 owns runtime integration.

### 19.2 Frozen transaction ordering

Inside one serialized critical section, with no interleaving await
between observation and mutation (all synchronous), A10 executes:

```text
validate shadow-ready (refuse blocked/no-action/shadow-invalid)
↓ structural seal + artifact + identity/digest binding (refuse)
↓ read-only live observation (single clone point)
↓ reconcile-first probe (pure; block fails closed pre-persistence)
↓ fresh path:  full A05/A06/A07/A08/A09 revalidation (stale on drift)
↓              rebuild barrier via shared A09H builder (stale on drift)
↓ recovery path (probe landed/partial): skip revalidation, converge
↓ persist sealed checkpoint (immutable, read-back validated)
↓ construct A02 operation from the projection (no replanning)
↓ operation/projection equality (block before mutation)
↓ freeze: validate → atomic persist → read back → brand (durable intent)
↓ re-reconcile (diverts cross-process landings to recovery)
↓ A02 apply (payload + anchors) or exact-missing retry (never re-payload)
↓ SessionStore.flush barrier (no COMMITTED without participation)
↓ post-apply readback: actual == predicted (content-exact)
```

Crash before durable operation proof leaves the live session unmodified
(the checkpoint artifact may persist harmlessly). After durable intent,
all failures are durable recoverable operation states, never harmless
reports. The DSH source log is append-only: there is no destructive
rollback, only durable intent plus idempotent application plus forward
reconciliation.

### 19.3 Checkpoint durable-persistence flow (§12–§13)

The real sealed checkpoint becomes durable BEFORE the live surface stops
exposing the historical prefix: canonical sealed bytes →
`persistSealedCheckpointV2` (atomic temp + rename, one file per
generation) → read back → byte/identity/seal revalidation. Identical
bytes reuse the existing file; same generation with different bytes
FAILS CLOSED and never overwrites. Durability scope preserves A05H
wording exactly: atomic plus read-back validated plus
`SessionStore.flush()` participation is process-crash recoverable under
the filesystem/OS contract, never claimed power-loss durable (no fsync).

### 19.4 Operation construction and durable intent (§15–§17)

The A02 operation is constructed directly from the validated projection:
`operation.segments === projection.segments`, `operation.operationId ===
projection.operationId` (the canonical derivation, recomputed),
checkpoint id/digest/generation bound to the sealed checkpoint, source
seqs as the ascending union. Mismatch BLOCKS BEFORE MUTATION. Intent
follows the frozen A02 protocol (construct → closed-world validate →
atomic persist → read back → validate durable bytes → brand); only the
branded read-back handle may mutate the session (A05H proof, enforced
inside A02 apply). A conflicting operation id for the generation FAILS
CLOSED and is never overwritten; an identical prior operation is reused
(idempotent retry). Payload regime is frozen (§20): the applied payload
is the A09H digest-proven WITHOUT-identity canonical bytes with
`sha256(payloadText) === checkpointContentDigest`. The regime-1
full-serialized binding helpers (which require the payload to carry its
own id/digest) do not apply to digest-proven payloads: sha256 of a
self-carrying byte string can never equal its own content digest, so A10
proves binding by field equality plus the digest gate plus byte-identity
recomputation instead.

### 19.5 Final freshness barrier and serialization (§9–§11)

Immediately before mutation, A10 revalidates every binding through the
existing validators (A05 `revalidateBeforeMutation` verbatim at the final
gate, A06 boundary identity plus checkpoint binding, A07 coverage,
A08 retention freshness plus pressure basis, A09 `assertShadowResultFresh`,
generation and provider/model route identity). The last observation
before irreversible mutation rebuilds the pure projection from CURRENT
live state through the shared A09H builder and requires byte-exact
agreement (digest, messages, segments) with the shadow prediction;
anything moved yields STALE with no mutation and no required durable
operation. Observation through mutation runs synchronously inside a
per-session promise-chain critical section, closing the in-process
validate→apply TOCTOU window; an optional caller-supplied external lock
(controller cross-process apply-lock family) wraps the section when
provided. Cross-process exclusion without that hook is narrowed, not
eliminated: A02 durable-intent plus idempotent forward reconciliation
still guarantees one valid final state, and a re-reconcile after the
freeze diverts interceding landings to recovery instead of double
apply. The residual honest statement is frozen: without an adequate
external serialization primitive, the physical cross-process race window
is narrowed by reconciliation, not closed by architecture.

### 19.6 Shadow/active equivalence invariant (§4/§44)

After successful apply, the real model-facing projection must be the A09
prediction. The comparison is content-exact canonical equality modulo
only the volatile host-minted message `id` transport key: live
replacement nodes mint A02 ids while the artifact carries deterministic
shadow ids, so id-inclusive equality would mistake transport for
content. Source-event ids are identical both sides; role, content, and
source (including operation/generation/task bindings and exact
continuation-anchor texts) must be byte-exact. Tool-pairing keys
(`callId`/`toolCallId`) are never stripped. No semantic approximation
anywhere. The expected `projectionDigest` additionally recomputes over
the artifact body, and the payload representation must occur exactly
once (required-state survival through the checkpoint representation, as
A09H proved). Post-apply validation further requires: current user
request exactly once (immediately after apply, after flush, after
restart), balanced tool protocol via the same A09H proof,
byte-identical raw-log prefix (append-only), and exactly one node per
segment.

### 19.7 Retry, recovery, restart (§30–§36)

Calling A10 twice with the same operation/checkpoint/projection/state
appends nothing new: the reconcile-first probe recognizes the completed
landing and returns idempotent recovered with an identical projection.
Retry after ambiguous failure (lost result, interrupted apply, failed
flush) reconciles through A02: complete landings verify durability and
recover; partial landings retry exactly the missing segments (never
another payload); clean operations apply. Restart after commit
reproduces the predicted projection from durable bytes
(`deriveMessages(restored) === projectedMessages`, current-user-once,
balanced, bindings valid). A restart that restores only pre-apply bytes
(the landing was never durable) fails closed to STALE when the host
restore marker (`session/end-seed`, off-surface host metadata) moves
the log: re-shadow is required, nothing mutates. Crash-matrix coverage
is durable-state injection at every boundary (before/after checkpoint
persistence, before/after operation persistence, before first mutation,
mid multi-segment apply, after apply before flush, after flush before
return, restart after commit, conflicting retries); the truly
unobservable physical-process kill window is labeled as such and never
claimed. Abandoned frozen intent plus a subsequent log change is
intentionally left without an automatic supersession policy (A11/A12
territory): A10 fails closed on conflict rather than adopting foreign
intent.

### 19.8 Result contract and telemetry (§28/§49)

`ActiveCompactionResultV2` (`schemaVersion: 1`, closed-world, digested)
carries task/session/generation, checkpoint/operation/shadow/projection
identity, `status` in `refused | stale | committed | recovered | failed`
(`prepared` is intentionally absent: intent and mutation occur inside one
serialized call, so interrupted intent surfaces via retry/recovery, not
as a halfway status), `mutated`, `durable`, stable `ActiveApplyBlocker`
codes, and bounded telemetry (operation/checkpoint/generation/boundary,
segment/source counts, digests, before/after message and token counts,
reconciliation outcome, blocker codes). No raw checkpoint payload, no
prompt text, no secrets. Adversarial content (`APPLY_NOW=true`,
`COMPACTION_COMMITTED`, `IGNORE_SNAPSHOT`, forged `operationId=…`) is
inert data: only structured validated state authorizes application, and
operation identity is always the canonical derivation. A09 running alone
still performs zero mutation (purity regression pinned).

### 19.9 Scope boundary (frozen)

A10 does NOT introduce: A11 multi-generation runtime policy, A12
expanded crash/concurrency campaign, A13 complete-task integration,
automatic controller triggering, background compaction, new
pressure/retention/safe-point/checkpointability policy, a new projection
algorithm, Phase B ContextPage, Phase C Context Compiler, LLM
summarization, JEV/Laya, or Nexus Nova. Proof: `tests/ContextActiveApplyV2.Tests.cjs` (133 host-free assertions: authority
shape, single/multi success with exact equivalence, idempotent retry,
ambiguous-failure retry, 13-leg refusal matrix, S1→S2 staleness,
checkpoint/operation conflicts, durability ordering, mid-apply partial
recovery, restart injection, concurrent serialization, adversarial
inertness, secret safety, A09 purity) and
`tests/ContextActiveApplyV2LiveHost.Tests.cjs` (48 assertions on the
pinned `0.1.1-rc.2` host under the strict gate: single-segment commit
with real flush participation, multi-segment pinned-runtime split,
ambiguous-flush recovery, §45 restart reproduction with the host
end-seed marker characterized, fail-closed lost-landing staleness).
No A11/A12/A13 behavior is introduced.

## 20. A10H active-apply serialization and recovery hardening record

A10H closes four active-apply gaps before any A11 work. No foundation
semantics or formulas change (A01–A09H untouched); the A10 result
contract gains two explicit durability legs.

### 20.1 H1 — mandatory cross-process serialization (frozen)

The cross-process mutation serialization authority is the existing
PowerShell file-lock family in `scripts/ContextLifecycle.ps1`
(`Get-AihCompactionApplyLockPath`,
`Invoke-AihCompactionApplyLockAcquire/Renew/Release`: ledger
`runs/<TaskId>/context-compaction-apply.lock`, atomic O_EXCL create,
bounded lease, owner-token renewal, PID-liveness-fenced takeover, short-
lived named mutex for file mutations), exposed through
`scripts/ContextLifecycleCli.ps1` (`acquire/renew/release-apply-lock`).
No competing lock protocol is introduced: the new
`config/ContextActiveApplyLockClientV2.cjs` only invokes those exact CLI
actions from Node and parses their JSON (same precedent as the XProc
worker). Lock path, format, lease, fencing, and takeover rules live in
PowerShell alone.

A10 treats the client as MANDATORY. The serialized order is frozen:

```text
acquire session mutation serialization
↓ re-read authoritative state
↓ A05/A06/A07/A08/A09 final validation
↓ persist/read-back checkpoint
↓ persist/read-back A02 operation
↓ ownership renew gate
↓ apply
↓ flush
↓ post-apply verification
↓ release serialization (best-effort, idempotent; result stands)
```

No client (or malformed client) refuses with
`active-serialization-unavailable`; a held lock refuses with
`active-serialization-conflict` (live-owner / other-operation /
takeover-raced detail preserved); both with `mutated = false` and no
durable artifact created (acquire precedes all persistence, so even the
checkpoint is never written without the lock). A lost lease at the
post-intent renew gate refuses to apply while keeping the durable
intent (`intentDurable`, `mutated = false`). The in-process promise
chain remains as the inner layer. Two-process proof: independent
processes through the real CLI authority show exclusion (contender
refused while holder owns), identical-operation recovery (same
operation, zero new events, store bytes identical), and conflicting-
operation fail-closed (`active-operation-conflict`, no competing
projection, no lock residue).

### 20.2 H2 — durable-intent/no-landing restart transparency (frozen)

`session/end-seed` is host-owned restore bookkeeping (appended by seed
restore, never on the model-facing surface) and is execution-
transparent for the rebuild barrier (A06 seed-marker precedent). The
barrier reasons over the logical source view with these markers
excluded; projection-digest equality still governs end-to-end. Case A
(marker-only change, durable checkpoint plus branded operation plus
zero landed segments plus same logical state) forward-recovers: the
existing operation is reused, applied, flushed, and the actual
projection equals the original prediction (proven on the pinned host).
Case B (any real user/tool/controller event after the freeze) still
fails closed to STALE with no mutation. The live log itself is never
rewritten for transparency.

### 20.3 H3 — split durability semantics (frozen)

`ActiveCompactionResultV2` (and its telemetry) now carries
`intentDurable` (A02 operation durably persisted and branded; forward
recovery may proceed) and `applicationDurable` (projection landed AND
flush barrier participated AND post-verify passed). `durable` is
derived as `applicationDurable`, enforced structurally
(`durable !== applicationDurable` is invalid even with a consistent
digest). Matrix: pre-intent refusal/failure → both false; operation
persisted without apply → intent true, application false; mutation with
failed flush → intent true, application false (`durable` false: recovery
journal existence never claims application durability); commit/recover
→ both true. Process-crash recoverable versus power-loss durable
wording is unchanged (no fsync added).

### 20.4 H4 — harness registration (frozen)

`scripts/Test-Harness.ps1` is the repository suite runner (correction:
the earlier A10 report misstated that no orchestrator exists;
`tests/Harness.Tests.ps1` is a domain suite, while
`scripts/Test-Harness.ps1` runs the `$suites` collection). A10
registers `ContextActiveApplyV2` (unit), `ContextActiveApplyV2LiveHost`
(with `NEXUS_REQUIRE_CCV2_LIVE_HOST=1`), and `ContextActiveApplyV2XProc`
(two-process H1 proof) immediately after the A09 suites. Existing
harness behavior is otherwise unchanged.

Proof deltas: unit suite grows past 170 assertions (mandatory-lock
refusals with nothing persisted, renew-gate intent-only failure,
end-seed Case A commit plus Case B staleness, full H3 matrix including
the structural `durable !== applicationDurable` rejection, shared-lock
ordering `acquire,renew,release` under concurrency); live suite grows
to 60 assertions (H3 splits, H2 Case A live commit reusing the
pre-crash operation with prediction equality, Case B staleness); new
two-process suite proves exclusion/recovery/conflict through the real
lock authority. No A11/A12/A13 behavior is introduced.

## 21. A11 multi-generation runtime record

A11 introduces the one authoritative generation runtime,
`config/ContextGenerationRuntimeV2.cjs` (`GenerationRuntimeV2`). It owns
generation identity ONLY: allocation, committed-head tracking,
parent-checkpoint lineage, reservation, abandoned-generation supersession,
and restart reconstruction. It owns no safe-point policy, no
checkpointability, no pressure/retention, no shadow projection, and no
active apply (A06/A05/A07/A08/A09/A10 are reused verbatim and never
redefined). No A01–A10H semantic, formula, or contract changes: the A03
parent-id path (string lineage, no generation-1 object check), the A02
single-file operation authority (reused per generation directory), and the
frozen A10 input/result contracts are all untouched.

### 21.1 Durable representation (minimal derived index)

Sealed checkpoints (one `cp-NNNNNN.json` per generation in the shared
checkpoint dir) and per-generation A02 operations (one
`context-compaction-operation-v2.json` per
`operationRoot/generation-NNNNNN/`, frozen A02 persist/read/freeze
reused verbatim) remain the source of truth. A11 adds only a derived
index under `runtimeDir`:

```text
context-generation-runtime-v2.json   - head (highestAllocated,
  latestCommitted + checkpoint id, committed lineage[], superseded[])
generations/<N>/reservation.json      - allocation + source binding
generations/<N>/superseded.json       - terminal supersession marker
```

Records carry ids/digests/bindings/statuses only (never checkpoint
contents, operation state, shadow artifacts, prompt text, or tool
output). All writes are atomic temp+rename with read-back validation
(process-crash recoverable scope, no fsync). Reservation, supersession,
and head digests are deterministic domain-separated hashes
(`nexus/context-generation-{runtime,reservation,supersession}/v1`);
no clock or randomness enters semantic identity. Closed-world exact-key
validation applies to every record and every input; unknown keys fail
closed before any digest use.

### 21.2 Allocation semantics (frozen)

Generation numbers are durable identity: monotonic, never reused, even
for abandoned/stale/superseded/failed generations. `highestAllocated`
and `latestCommitted` are distinct concepts (G1 committed + G2
allocated-stale-superseded leaves latest=G1 while highest=2). The parent
of a new generation is the latest committed checkpoint, not
generation-1 (G1 COMMITTED, G2 SUPERSEDED, G3 COMMITTED validates
`G3.parentCheckpointId == G1.checkpointId`); G1 carries null. Callers
never choose generation numbers (reserve takes no generation field;
generation-typed inputs reject non-integers). Reservation runs under the
same cross-process compaction lock family as A10 (CLI authority; fake
client only in unit tests) plus an in-process per-session chain:
acquire -> reconstruct(+repair) -> refuse on UNRESOLVED -> idempotent
reuse on identical bindings (revisionDigest/boundary/token) -> allocate
highest+1 -> bind source state -> persist/read-back -> release. Changed
source state never rebinds (reservation-conflict); a lost race refuses
with a stable code and converges on retry (two-process proof).

### 21.3 Outcomes, supersession, and crash repair (frozen)

Per-generation outcomes are RESERVED / COMMITTED / SUPERSEDED /
UNRESOLVED. COMMITTED requires an A10 result with status
committed/recovered, `applicationDurable`, and verified post-apply
projection; the head advances atomically afterwards (never before) and
repeated advancement is idempotent across processes. A commit-before-
head crash repairs deterministically: reconstruction with session
evidence finds the fully-landed generation (regime-2 payload citation
proof) and advances the head without reapplying; a head without durable
application fails closed. SUPERSEDED requires proving zero landed
segments (no payload/anchor/partial/ambiguous state, session evidence
mandatory), an actually stale source binding, and never touches
committed history; artifacts stay immutable. Partial/ambiguous
application is UNRESOLVED: supersession refused, newer allocation
blocked, A02/A10 reconciliation must complete first. A02 recovery
consults `checkOperationSupersededV2` before applying old intent, and
A10 callers consult `assertGenerationEligibleForApplyV2` (the frozen
A10 contract itself is unchanged). Forks (multiple non-terminal
generations, conflicting markers/heads, lineage mismatch) and corrupt
metadata fail closed with stable `generation-*` codes. Telemetry
exposes only bounded facts (heads, active state, counts, outcomes,
blockers). Nothing here auto-triggers compaction (A13 territory); no
A12/A13/Phase-B/Phase-C behavior is introduced.

Proof deltas: new unit suite (147 assertions: allocation, idempotency,
G1->G2->G3 chained commits with latest-only surface, zero-landing
supersession with skipped lineage, partial refusal + unresolved
blocking + forward recovery, commit-before-head repair, crash matrix,
corruption/fork, determinism, security, telemetry, eligibility,
generation-aware entry, superseded non-applicability matrix,
snapshot lifecycle matrix);
new live-host suite (63 assertions on the pinned host: real G1->G2->G3
applies with per-generation restart reconstruction, superseded-G2->G3
skipped lineage, generation-aware entry, snapshot protection
reconstruction, gated superseded recovery refusal); new two-process
suite (27 assertions: reservation race convergence, conflict refusal,
commit-head convergence, cross-process supersession refusal,
stale-handle race, no lock residue). Harness registers all three after
the A10 suites.

### 21.4 A11H generation-aware active entry (frozen)

Supersession safety is architectural, not conventional. The ONLY
supported generation-aware active path is
`applyCurrentGenerationV2({..., request})`, where `request` is the
opaque A10 input (validated by A10 itself; the entry never duplicates
A10 logic or keys). Layering is explicit and mechanically tested:

```text
A02 = transaction primitive (unguarded by design)
A10 = single-generation transactional primitive (no generation ownership)
A11 = authorization + lifecycle authority (owns WHETHER a generation may
      use A10; the runtime module exports no raw apply)
```

Under ONE held cross-process lock acquisition (the generation's own
operation identity; same lock file/owner, reentrant attribution into
A10 so no second CLI acquisition occurs), the entry performs the FINAL
observation: reconstruct (+ repair), active-generation validation,
supersession refusal, unresolved gating (a different unresolved
generation blocks; the same generation proceeds as A10 forward
recovery), reservation/source binding validation (revision, snapshot,
boundary, parent lineage), generation-owned operation-dir derivation
(caller-supplied mismatches fail closed), then exactly one A10
invocation. The in-process chain slot is released before invoking A10
(A10 owns its inner chain; nesting would deadlock) while the
cross-process lock stays held, so no supersession, commit, or rival
apply can interleave the check->apply window. Stale pre-supersession
handles refuse via the under-lock re-read even when an earlier
observation saw the generation as active. Commit remains explicit: the
entry never auto-advances the head. `reconcileGenerationV2` is the
only supported generation-aware reconciliation path (read-only; refuses
superseded generations as permanently non-applicable across restarts).

### 21.5 A11H runtime-snapshot lifecycle policy (frozen)

`snapshotProtectionOfV2` derives PINNED vs SHADOWABLE for every live
host-owned runtime snapshot from durable runtime state plus the live
session only (no in-memory pin state; restart reconstructs
byte-identically, digest
`nexus/context-snapshot-protection/v1`):

- latest live runtime snapshot -> PINNED (current-state requirement);
- any live snapshot while an UNRESOLVED generation exists, or cited in
  an unresolved operation's frozen source set -> PINNED (a newer
  reservation never unpins; G3 over unresolved G2 stays impossible);
- non-current snapshots with no unresolved generation and no recovery
  reference (superseded zero-landing generations, older committed
  lineage behind a newer self-contained commit) -> SHADOWABLE.

This is eligibility/protection policy only: no Phase-B tiers, no
garbage collection, no deletion. A05/A02 pinning mechanics are reused,
never redefined.

## 22. A12 crash / concurrency / recovery hardening record

A12 is a validation + hardening phase: no new feature, no A13
integration, no policy change, no new projection semantics. Frozen
A01-A11H behavior is unchanged except the two named semantic fixes
below (A12-1, A12-2), each justified, regression-proven, and recorded
here. Global rule: NO CRASH OR RACE MAY CREATE TWO VALID
INTERPRETATIONS OF THE SAME TASK STATE.

### 22.1 Deterministic fault injection (frozen)

`config/ContextRecoveryFaultV2.cjs` is the TEST-ONLY injection registry.
Every durable transition exposes precise named fault points
(`reservation|head|supersession : before-temp-write / after-temp-write /
before-rename / after-rename / before-read-back /
after-read-back-before-return`, plus `checkpoint|operation|lock|segment|
flush|post-verify` vocabulary), each default OFF with zero production
behavior change unless a test explicitly arms it in-process. Modes:
`throw`, `return-failure` (sentinel), `simulated-process-loss`
(`ProcessLostV2`, no cleanup, temp leftovers retained). Armed faults are
single-shot by default (retry observes clean state) or sticky with
`{ persistent: true }` for churn tests. Fault errors carry ids/digests
only, never task content. The runtime's `persistJsonAtomic` fires the
scope-appropriate points, so reservation/head/supersession crash matrices
address exact boundaries without timing sleeps.

### 22.2 Frozen recovery-state taxonomy (A12-1 semantic fix)

Per-generation outcomes stay `RESERVED | COMMITTED | SUPERSEDED |
UNRESOLVED`; the transient active states gain
`commit-pending-verification`. A12-1 (justification: A11 classified a
fully-landed-but-head-missing generation as heuristic COMMITTED on
segment presence alone, which §14 forbids because wrong payload,
checkpoint mismatch, wrong anchors, or wrong surface also present all
markers): a fully-landed generation whose committed head was never
advanced is UNRESOLVED/`commit-pending-verification`, NEVER heuristic
COMMITTED. Without the restored authoritative session the landing is
unobservable and the frozen outcome is RESERVED/intent-durable (never a
guess); with the session but without the verified repair pass the
outcome is UNRESOLVED with `reconstructionOutcome=head-repair-pending`.
The head advances ONLY through the rigorous flow. Two terminal paths
exist. (1) Entry + explicit commit (the normal and flush-ambiguous
path): the entry reconstructs WITHOUT repair, so a commit-pending
generation proceeds to A10 forward recovery (reconcile, re-establish
flush durability, re-run post-apply verification, yielding a
recovered/committed result with `applicationDurable`), then
`commitGenerationV2` (which requires `postApplyVerified`, identity
agreement, and re-proven landing) advances the head. Neither the entry
nor the reserve path ever heals: a pending generation blocks newer
allocation until it reaches terminal state. (2) Explicit restart
recovery: `reconstructGenerationRuntimeV2` with `repairHead:true` over a
session RESTORED from durable flushed state advances the head with
deterministic recovered-completion evidence (`buildRecoveredCompletionV2`:
generation/checkpoint/operation ids and digests, landed counts; never
payload/prompt/tool text) after the same evidence chain (durable
checkpoint + durable operation + clean all-landed non-foreign landing +
valid parent chain) plus head write + read-back. STRICT PRECONDITION:
repair requires a restored session, because a live in-memory session may
show landed segments whose flush never succeeded; healing from such a
session would falsely commit unflushed application. Anything ambiguous
fails closed. Regression: the A11 `completed landing classifies as
commit-pending` assertion now expects UNRESOLVED, and
`commit-before-head-crash repair` still heals with restored-session
evidence. Lost-A10-result recovery is path (2): the head repairs from
durable evidence without the lost in-memory result.

### 22.3 A12-2 semantic fix: reservation-only supersession persists

Justification: a generation superseded with no checkpoint ever persisted
carries `checkpointId=null` in its marker (the marker authority permits
null), but the head-index validator demanded a string checkpointId, so
the marker persisted while the head update threw: a half-superseded
state (§16 forbids). Fix at the smallest owning layer: the head
superseded-entry validator mirrors the marker authority (null allowed).
Once durable, a generation is permanently non-applicable through every
supported route (fresh apply, retry, restart reconciliation,
cross-process recovery). Regression: the supersession crash matrix
retries every boundary to terminal SUPERSEDED and proves refusal of
late apply.

### 22.4 Concurrency serialization guarantees (frozen)

One cross-process lock (PowerShell authority
`Invoke-AihCompactionApplyLockAcquire/Renew/Release`, client
`ContextActiveApplyLockClientV2.cjs`) serializes the check->apply
window; the entry re-reads authoritative state under the held lock, so
stale pre-lock observations (including `inspectFirst` handles) refuse.
Proven races (unit ordering + true OS-process barriers, 3x stress):
apply-vs-apply identical -> at most one mutation, others converge to
recovered or idempotent already-committed (verified head healing);
apply-vs-supersede -> exactly one terminal winner (landed refuses
supersession with `generation-cannot-supersede`; zero-landing
supersession makes late apply refuse); reserve-vs-recover -> partial
landing blocks newer generations (`generation-unresolved-operation`);
after entry + commit reach terminal state, the retried reservation
parents from the committed head (never stale); commit-vs-supersede -> committed history
can never be superseded; commit-head-vs-reserve-next -> the reserver
either observes the committed parent or refuses with a stable code and
converges on retry. Lock takeover is per-OPERATION binding: refused with
`held-by-live-owner` while the owner renews its heartbeat; permitted
after lease lapse with a dead/unknown owner (PID + start-time binding
fences live owners even past nominal expiry); a different operationId is
fenced as `held-by-other-operation`, never taken over. Liveness is
proven by renewal heartbeat because the CLI owner process exits
immediately by design.

### 22.5 Artifact corruption behavior (frozen)

Corrupt checkpoint bytes/ids/seals, corrupt operation bodies/identities,
corrupt reservation digests, conflicting duplicate reservations,
committed+superseded markers on one generation, and forked lineage all
fail closed (`generation-runtime-corrupt` / `generation-runtime-fork` /
`generation-head-conflict`); timestamps/mtimes never decide authority
(proven by mtime-manipulation reconvergence); adversarial persisted
task text (`RECOVERY=COMMITTED`, `SUPERSEDE=true`, `GENERATION=999`,
`LOCK_OWNER=me`) is inert data. Missing reservations over committed
lineage resolve via the lineage authority; every other missing artifact
fails closed unless exactly one authoritative source yields one unique
answer. A12-3 was investigated and deliberately NOT enforced:
reservation source bindings are generation-bound observations captured at
reservation time while the sealed snapshot is captured at build time,
so frozen A11 flows legitimately carry different values (G3 reserved
from a moved-state G2 observation, checkpoint built later for G3);
cross-enforcing them contradicts A11. Rebinding stays contained by
monotonic allocation, duplicate-binding fork refusal, digest-validated
records, and commit-time identity agreement.

### 22.5 A12-4 semantic fix: mid-log restore markers stay transparent

Justification: the A10 apply barrier filtered host-only
`session/end-seed` restore markers out of the rebuild event array for H2
transparency, but `eventBySeq` is positional (`events[seq]` valid only
when `event.seq === seq`). After any restart-then-continue flow the marker
sits mid-log with later work after it; filtering shifts every later
position and every lookup misses, so planning falsely yields "no
segments" stale. End-position markers (the only H2-covered shape) were
unaffected, which is why the campaign's true restart-then-continue live
chain is the first flow to expose it. Fix at the smallest owning layers,
preserving H2 intent: (a) A10 passes the live events unfiltered so
positional lookups stay intact (markers are unsurfaced and semantically
neutral: zero tool delta, never a runtime snapshot, excluded from the
shadowed set either way); (b) the A09H projection builder anchors
replacement seqs on the semantic log (markers never advance `maxSeq`)
and excludes markers from the digest's retained-suffix input; (c) the
retained-suffix validator excludes markers on the expectation side too.
Digest equality still governs end-to-end and real drift still fails
closed (Case B proven). Regression: new A12 unit coverage (mid-log
marker applies and commits) plus the live restart-then-continue chain
(G1->G3 across two restarts with markers in range).

### 22.6 Recovery determinism and bounded convergence (frozen)

`recoveryTraceV2` returns the bounded deterministic trace
(observedState/decision/action/result; ids/digests/counts only; no
wall-clock, no PID, no task content): identical durable state yields
identical traces. Repeated reconstruct/reconcile/retry/restart reaches
`COMMITTED`, `SUPERSEDED`, or stable UNRESOLVED within an explicit
bound (3 passes in the campaign); no infinite retry loops. Consecutive
restarts without state changes are byte-identical. The raw DSH log
stays append-only on every path (positional seq invariant asserted per
scenario); final surfaces keep the current user request exactly once,
balanced protocol (`checkMessagesBalanced`), no duplicate payload
segments or continuation anchors, and A07 required-state coverage.

### 22.7 A12 suites and harness (frozen)

`tests/ContextRecoveryV2.Tests.cjs` (unit: fault registry, reservation /
head / supersession crash matrices, fully-landed classification,
lost-result reconstruction, bad-projection fail-closed, apply/supersede
and commit/supersede orderings, reserve-vs-recover blocking, stale
matrix, full restart-state matrix, G1->G2->G4 multi-generation crash
chain, repeated-restart convergence, corrupt/missing/conflicting
campaigns, timestamps, security inertness, secret safety) and
`tests/ContextRecoveryV2XProc.Tests.cjs` (true OS processes through the
real lock CLI: identical apply x3, apply-wins x3, supersede-wins with
stale pre-lock handle, commit-head-vs-reserve-next, dead-owner
takeover), reusing the A11 XProc worker (additive `activeResult` output
field only), and `tests/ContextRecoveryV2LiveHost.Tests.cjs` (pinned
host real-Host crash campaign: flush-throw partial recovery,
fully-landed lost-result repair, zero-landing supersession,
G1->G3 multi-generation chain with restart after every step). Harness
registers all three after the A11 suites; XProc/live suites skip
ENVIRONMENTAL without pwsh/git or the host (never faked; live requires
`NEXUS_REQUIRE_CCV2_LIVE_HOST=1` like other live suites).

## 23. A13 Complete-Task integration (frozen)

One narrow orchestration component (config/ContextCompleteTaskV2.cjs) consumes the proven Phase-A runtime from the real Nexus task lifecycle. It observes controller lifecycle state, invokes the frozen authorities verbatim, and returns a bounded integration outcome. It redefines no policy: no pressure, safe-point, checkpointability, retention, projection, generation, recovery, or completion rule lives in the integration layer.

### 23.1 Production path and completion authority (frozen)

Controller -> evaluateBoundary -> A11 generation-aware entry (applyCurrentGenerationV2, plus reserve/commit/supersede/reconcile/reconstruct/inspect) -> A10 active transaction -> A02 primitive. The controller never calls raw A10/A02 where the A11 lifecycle applies, and the integration module never calls raw A10/A02 itself. CCv2 never decides completion: the deterministic controller (scripts/TaskController.ps1 via scripts/Task.ps1) owns the Complete-Task lifecycle; checkCompletionHealth is a consistency gate (reconstructable runtime, no unresolved compaction, valid projection), never a decision. Pressure never decides completion.

### 23.2 Boundaries, triggers, idempotency (frozen)

Eligible boundaries are committed controller states attested by explicit open/closed flags (stream, tool edge, transition, durability barrier). Frozen A08 recommendations route the trigger: NORMAL/ELEVATED continue without compaction; HIGH/CRITICAL proceed through identical A06/A07 gates; UNKNOWN never invents capacity authorization. Repeated callbacks on one unchanged revision converge via a caller-held fingerprint cache and A11 same-binding convergence. taskMayContinue derives from A11/A12 runtime state: false only while unresolved compaction makes progress unsafe.

### 23.3 Failure, recovery, terminal, restart (frozen)

Pre-mutation failures leave task state untouched. Post-mutation ambiguity (UNRESOLVED) blocks new model/tool progress until recoverUnresolvedGeneration (same-process A11 forward recovery, then explicit commit) or the A12 restart operator converges; the bundle is never persisted. Terminal tasks start no new generations; unresolved state still blocks finalization. resumeTask runs before new work on restart: frozen reconstruct with repair over the restored session, projection validation, may-resume flag. Partial landing restarts to UNRESOLVED (A12 frozen outcome).

### 23.4 Activation and suites (frozen)

Versioned selector compactionVersion / NEXUS_CONTEXT_COMPACTION_V2; the global default stays v1 (zero V2 work, evaluated:false). tests/ContextCompleteTaskV2.Tests.cjs (incl. the real Task.ps1 controller traversal), tests/ContextCompleteTaskV2LiveHost.Tests.cjs (pinned-host proof), and tests/ContextCompleteTaskV2XProc.Tests.cjs + worker (true OS processes through the real CLI lock client) register in Test-Harness.ps1 after the A12 suites.

### 23.5 A13H restart hardening (frozen)

resumeTask is the single restart-recovery entry (async): reconstruct with repair, then durable-only recovery of an UNRESOLVED generation (or an active generation holding a frozen A02 operation) from reservation + sealed checkpoint + branded operation read-back + restored session: frozen A11 reconcile classifies, the frozen A02 retry lands only missing segments, the flush barrier is re-established exactly once, and frozen A11 repair advances the head with recovered completion. No new pressure, retention, shadow, or reservation is created (recovery, not re-planning); insufficient artifacts fail closed with integration-recovery-evidence-incomplete. Unknown/unreadable runtime fails closed everywhere (boundary, resume, completion health): taskMayContinue and mayResume are false and healthy is false unless a clean or terminal runtime is successfully reconstructed.

---

## 24. B01 ContextPage freeze record (Phase B — Durable Task Memory)

B01 begins Phase B by freezing the production `ContextPage` contract: the
bounded, structure-aware, exact/source-linked memory unit that later phases
will persist (B02), rehydrate (B02/B03), retrieve (B03/C03/D05), and
materialize (B04/C01). B01 mints and validates pages only; it creates no
store, no index, and no view.

```text
Checkpoint  = authoritative current task state (TaskController/A03)
ContextPage = bounded exact/source-linked historical evidence unit (B01)
ContextView = future disposable model-facing working set (Phase C)
```

A `ContextPage` is NOT task completion authority, verification authority,
checkpoint authority, permission authority, repository truth, retention
authority, a model-facing prompt by itself, a semantic-search result, or
summary-as-truth. Core invariant: CCv2 may forget from the prompt; CCv2
must never forget from the task. Every valid page answers WHAT exact
evidence, WHERE it came from, WHO/WHAT supplied it, WHICH
task/security namespace owns it, and HOW mutation is detected.

### 24.1 Production schema (frozen)

Authority: `config/ContextPageV2.cjs` (sole mint/validate authority).
`createContextPageV2`, `validateContextPageV2`,
`canonicalizeContextPageV2`, `deriveContextPageIdV2`,
`deriveContextPageDigestV2`, plus the pure read-only helpers
`derivePageSourceFromEvidenceRef` and `describeContextPageV2`.

```text
ContextPageV2 {
  schemaVersion           : integer (1)
  id                      : string — 'cxp_' + 32 hex (section 24.5)
  kind                    : 9 frozen kinds (section 24.3)
  namespace               : { taskId, taskInstanceId, sessionId,
                              workspaceId, repositoryId | null,
                              checkoutId | null } (section 24.2)
  provenance              : A04 TrustProvenance + fieldKind (section 24.4)
  mutability              : 'immutable' | 'versioned' (section 24.6)
  sourceSeqs              : integer[] ascending unique >= 0 (section 24.7)
  sourceBinding           : null | repository-span | artifact (section 24.8)
  contentHash             : sha256 hex of the exact backing (section 24.9)
  exactText               : string | null — redacted persistable bytes
  exactBlobRef            : 'blob:sha256:<hex>' | null (B02-resolvable)
  extract                 : string | null — source-exact substring
  semanticGloss           : string | null — advisory prose only
  entities/symbols/files/tags : sorted deduplicated string sets
  createdAtGeneration     : integer >= 1
  lastNeededAtGeneration  : integer | null — metadata only
  rehydratable            : boolean — derived (section 24.10)
}
```

Differences from the illustrative v0.3 schema: (1) the six-value v0.3
`trust` label is replaced by the full frozen A04 `provenance` record
(sourceKind/trust/sourceRefs/authorityScope/fieldKind) with trust
deterministically derived by the A04 TrustNormalizer — no competing trust
model; (2) task binding is the explicit nested `namespace` object
(taskId/taskInstanceId/sessionId/workspaceId/repositoryId/checkoutId)
reusing Phase-A identity semantics, with the permission-domain dimension
explicitly deferred (no first-class permission-domain authority exists in
the repository; section 24.2); (3) `id` derivation, `contentHash`
semantics, `rehydratable` derivation, extract-exactness, and advisory
vs identity separation are frozen here (they were unspecified in v0.3);
(4) generation 0/null does not exist: the earliest evidence binds
generation 1.

### 24.2 Namespace binding (frozen)

The page carries the minimum explicit namespace that enforces retrieval
isolation: `taskId`, `taskInstanceId`, `sessionId`, `workspaceId`,
`repositoryId` (nullable), `checkoutId` (nullable) — reusing the frozen
Phase-A identity authorities (A03/A05 shapes). Any mismatch between page
namespace and authoritative task/repository identity is INVALID.
`validateContextPageV2(page, { expectedNamespace })` enforces
task/taskInstance/session/workspace/repository equality before any
retrieval use, so a future index never infers ownership from page text.
No cross-task sharing is invented. Permission/security domain: DEFERRED
— no first-class permission-domain authority exists yet, so B01 freezes
the strongest currently authoritative namespace and documents the gap
rather than fabricating a domain. A future phase may add one explicit
bound field; until then cross-domain isolation rides on task + instance
+ workspace/repository separation.

### 24.3 Page kinds (frozen, closed world)

`requirement | repo-span | diff | tool-result | verification | decision |
failure | conversation | other`. Unknown kinds FAIL CLOSED; `other` must
be explicitly supplied, never defaulted. `tool-result` pages claim a
balanced protocol transaction and therefore require >= 2 `sourceSeqs`
(call + result); a one-sided tool page is rejected
(`context-page-tool-transaction-unbalanced`).

### 24.4 Trust/provenance binding (frozen)

B01 reuses the frozen A04 authority verbatim. The caller names
`sourceKind` + grounded `sourceRefs`; the A04 `normalizeField` path
derives `trust` from the closed (sourceKind, fieldKind) mapping, where
`fieldKind` is fixed per page kind (`requirement→requirement-text`,
`repo-span/diff→repository-fact`, `tool-result→tool-fact`,
`verification→verification-outcome`, `decision→decision-statement`,
`failure→failure-detail`, `conversation→user-intent`, `other→agent-text`).
Callers MUST NOT supply trust. A04 origin-preservation rules apply
(e.g. controller normalization of requirement text must retain the
user/policy source ref). Repository/tool/model content never becomes
authoritative because it is stored in a page: adversarial source text
remains `evidence` or `untrusted-data` with zero control-flow effect.

### 24.5 Page identity (frozen)

```text
pageId = 'cxp_' + sha256Hex(UTF-8('nexus/context-page/v1' LF taskId LF
         taskInstanceId LF sessionId LF workspaceId LF repositoryId LF
         checkoutId LF createdAtGeneration LF kind LF mutability LF
         contentHash LF canonicalJson(sourceSeqs)
         LF canonicalJson(sourceBinding) LF provenanceKey))[0..32)
provenanceKey = sourceKind LF trust LF fieldKind LF
                canonicalJson(sourceRefs) LF authorityScope
```

No timestamp, no randomness, no process identity, no mtime. The identity
binds the task-bound semantic page identity strongly enough that the
same id can never address different exact backing (contentHash is in the
domain). Advisory metadata (`extract`, `semanticGloss`, `entities`,
`symbols`, `files`, `tags`, `lastNeededAtGeneration`) and the derived
`rehydratable` flag NEVER enter the identity: an LLM-generated gloss
cannot change the identity of exact evidence. Validation recomputes the
id; any stale id after a semantic change REJECTS
(`context-page-id-mismatch`).

### 24.6 Content vs page identity; mutability (frozen)

`contentHash` is the identity of the exact backing bytes/content;
`pageId` is the identity of the task-bound contract. Identical exact
bytes in different tasks hash identically but yield different page ids
(proven cross-task). `immutable` means the page identity/backing cannot
change — changed evidence is a new page. `versioned` means the page
binds one exact version/content hash of a versioned source; it MUST NOT
be read as permission to edit the page in place. Historical page records
are immutable representations of their bound version either way.

### 24.7 Source sequences; structure-aware units (frozen)

`sourceSeqs` are canonical DSH/session event seqs: integers >= 0,
strictly ascending, unique (duplicates/unsorted/negatives fail with
stable codes). Array indexes are never substitutes for event seqs.
Empty `sourceSeqs` are allowed ONLY with an alternate exact source
binding (`exactText`, `exactBlobRef`, or `sourceBinding`). Token ranges
are NOT the page identity: B01 pages are structure-aware units (user
request → complete instruction; tool protocol → balanced transaction;
source file → symbol or contiguous exact line range; git → semantic
hunk; test output → bounded error cluster + blob ref; decision → one
decision; verification → operation + result; narration only for
uncaptured task-relevant state). B01 provides the contract capable of
representing these units exactly; no automatic chunk discovery exists.

### 24.8 Exact backing; exactText; exactBlobRef (frozen)

Every page has ONE provable exact backing route: inline redacted
`exactText`, digest-bearing `exactBlobRef`, digest-bearing
`sourceBinding` (`repository-span { path, contentDigest, startLine,
endLine, symbol? }` or `artifact { artifactId, contentDigest }`), or
canonical session events (`sourceSeqs`). No page exists on
`semanticGloss`/tags/entities/summary/`extract` alone. `exactText` is
exact persistable evidence, never free-form summarization: redaction
(the frozen A03 pipeline) runs BEFORE identity, oversized exact
evidence fails closed (`context-page-exact-too-large`; bulk belongs
behind B02 `exactBlobRef`), and re-running redaction must be a fixed
point. `exactBlobRef` is validated as `blob:sha256:<hex>` with NO
storage lookup at B01 (B02 owns the store; no ad-hoc store is faked).
`extract`, when present, requires present `exactText` and must be a
source-exact substring of it (still exact after redaction);
`semanticGloss` is advisory prose that MUST NOT replace exact evidence,
change `contentHash`, change verification truth, or promote trust.

### 24.9 contentHash; rehydration; revalidation (frozen)

`contentHash` binds the exact backing: sha256 of the redacted exact
bytes when `exactText` is present (derived, never caller-chosen);
otherwise the digest embedded in `exactBlobRef`/`sourceBinding`; for
pure session-seq pages the caller-attested sha256, structurally
validated at B01 and resolved by B02/B03 (documented, not hidden).
Co-present routes must agree. Validation recomputes the hash whenever
exact bytes are available and rejects mismatch
(`context-page-content-mismatch`); digest-bearing bindings are checked
for agreement; trust-by-path alone (a path with no content digest) is
never accepted. `rehydratable: true` means the contract contains a
deterministic exact retrieval route verifiable NOW (`exactText`,
`exactBlobRef`, or a digest-bearing `sourceBinding`); pure session-seq
pages carry valid source-linked evidence with `rehydratable: false`
until B02/B03 binds session resolution. The stored flag must equal the
derivation in both directions.

### 24.10 Canonical form; closed world; bounds; paths (frozen)

Canonical serialization reuses the frozen A03 canonicalizer (sorted
keys, arrays keep author order, no whitespace): equivalent pages are
byte-identical; no clock/pid/randomness enters digests. All validators
are closed-world (unknown top-level/namespace/provenance/binding keys,
enum values, and scalar/array types fail closed), including an explicit
ban on reasoning-store fields (`chainOfThought`, `hiddenReasoning`, …).
Set-like metadata is canonically sorted + deduplicated at creation
(`sourceSeqs` order is semantic and is validated, never reordered).
Bounds: exactText 8192 chars; extract/semanticGloss 1000; metadata sets
32 entries (128 chars; files 500); sourceSeqs 512; canonical page
16384 bytes — each boundary tested ±1. Paths (`files[]`, span paths)
follow the B01-frozen relative-POSIX rule (no absolute/escape/traversal/
empty segments/backslash; 500 chars) since no existing authority owns
page source paths. `files[]` and repo locators never resolve through
host-global paths.

### 24.11 Requirement/decision authority note (frozen)

A requirement/decision page is historical evidence/material. The current
authoritative requirement/decision remains owned by the
checkpoint/TaskController structures: creating a page mutates no
controller state and promotes no trust (proven by the A04 derivation
legs in the B01 suite).

### 24.12 EvidenceRef compatibility (frozen)

`derivePageSourceFromEvidenceRef` is a pure read-only adapter from a
frozen EvidenceRef to a page source fragment (`event` + numeric locator
→ `sourceSeqs`; otherwise a digest-bearing `artifact` binding, digest
mandatory; taskInstanceId must match). It redefines no EvidenceRef
semantics and modifies no A03/A04/A07 authority.

### 24.13 Scope boundary (frozen)

B01 introduces NO blob/page store, NO content-addressed store, NO
EvidenceIndex, NO rehydration, NO lexical/symbol/file/embedding/semantic
retrieval, NO ContextView, NO Context Compiler, NO budget packing, NO
memory-tier assignment, and NO JEV/Laya/DECIDE. Proof:
`tests/ContextPageV2.Tests.cjs` (175 assertions, 0 failures) asserting
the contract matrix plus the absence of persistence/retrieval/tier/view
surface on the authority. Harness entry `ContextPageV2` registers after
the A13 suites. No live-host suite exists: B01 defines a storage-free
contract proven by deterministic fixtures, and no DSH-host behavior is
consumed (B02/B03 will prove resolution against the pinned host).

Phase-A regressions remain green (see task report). Next: CCV2-B02
(Content-Addressed Evidence Store) — not begun here.

## 25. B02 Content-Addressed Evidence Store freeze record (Phase B)

B02 implements the durable storage layer for validated B01 pages and exact
evidence. B02 persists and integrity-proves; it does NOT rank, retrieve by
relevance, compile views, or rehydrate for a compiler (B03 owns resolution
semantics across EvidenceRef/Page/Blob/repository/session source).

### 25.1 Production authority (frozen)

Authority: `config/ContextPageStoreV2.cjs` (sole durable-store authority).
`putBlobV2`, `readBlobV2`, `hasBlobV2`, `putContextPageV2`,
`readContextPageV2`, `hasContextPageV2`, `deriveContextPageRecordDigestV2`,
`updatePageAdvisoryV2`, `readPageAdvisoryV2`, `deriveEvidenceBindingIdV2`,
`putEvidenceV2`, `readEvidenceV2`, `persistEvidenceV2`,
`validateContextPageStoreV2`, `inspectContextPageStoreV2`,
`describeContextPageStoreV2`, `contextRootForV2`. No durable-store
semantics live anywhere else. B01 (`config/ContextPageV2.cjs`) is consumed
verbatim: storage validates pages, never repairs them, and the pageId
formula is untouched.

### 25.2 Storage layout (frozen)

```text
<workspace>/.ai-harness/runs/<taskId>/context/
  blobs/<aa>/<digest>.blob
  pages/<aa>/<pageId>.json
  advisory/<aa>/<pageId>.<advisoryDigest>.json
  evidence/<aa>/<bindingId>.json
```

`contextRootForV2(workspace, taskId)` derives the root from the Phase-A run
layout (no second storage root). `<aa>` is a hash shard. Filenames derive
ONLY from hex digests / frozen id patterns, never from page text, evidence
text, or caller paths. Roots must be absolute + normalized; taskIds must
match the safe run-identity pattern; every derived path is proven under the
root (traversal / absolute-path injection rejected).

### 25.3 Blob identity and bytes (frozen)

`blobRef = 'blob:sha256:' + sha256Hex(persisted exact bytes)`, compatible
with the B01 `exactBlobRef` form. String input travels the canonical
persistable-text route: the frozen A03 redaction pipeline runs BEFORE
identity over the WHOLE input verbatim, so a blob digest always equals the
B01 `contentHash` of identical text. Buffer input is stored byte-exact with
the caller attesting persistable/redacted bytes. Either way: stored bytes
=== hashed bytes. Blobs are immutable: no update operation exists; one
changed byte is a new digest and a new blob.

Frozen string-route bounds (`BLOB_STRING_MAX_BYTES` = 2 MiB,
`BLOB_MAX_WORD_RUN` = 4096): the reused pipeline costs quadratically in the
longest continuous word run (measured 4K chars ~23ms, 16K ~330ms, 65K
~4.7s; B01 is safe through its 8192-char exactText bound). Oversized or
long-run string evidence FAILS CLOSED and directs the caller to the attested
Buffer route. The bounds are linear-time enforced, so refusal is fast.

### 25.4 Blob write/read protocol (frozen)

Write order: canonicalize -> digest -> final path -> (exists? verify +
reuse : temp + verify + exclusive claim + read-back + recompute). No caller
receives a durable blob ref before read-back proof. Same path with
verifying bytes reuses idempotently; same path with DIVERGING bytes FAILS
CLOSED (corruption or identity conflict; never overwrite). Read order:
validate ref syntax -> safe path -> read -> SHA-256 -> compare
(`context-blob-content-mismatch` on divergence; `context-blob-missing` when
absent). One mutated byte on disk is refused on every read path.

### 25.5 Page persistence protocol (frozen)

Only B01-valid pages persist (invalid pages are refused, never repaired).
Blob-backed pages require PRE-EXISTING durable blob proof whose recomputed
hash equals the page `contentHash` (page-before-blob is forbidden). The
persisted record is the envelope `{ schemaVersion, page,
pageRecordDigest }` with canonical bytes; writes claim exclusively, then
read back and revalidate. Same page twice is idempotent (same identity,
same bytes, dedup reported). Same `pageId` with different canonical bytes
FAILS CLOSED and leaves the original record untouched (proven: advisory
difference keeps the B01 pageId but the second write is refused).

### 25.6 Full page-record integrity (frozen)

`pageRecordDigest = sha256Hex(canonical JSON of the full page record)` via
the frozen B01 canonicalizer (`deriveContextPageRecordDigestV2`). Evidence
identity (`pageId`/`contentHash`, advisory-excluding by B01 design) is
therefore distinct from stored-record integrity: `semanticGloss`/`tags`
tampering on disk keeps a legitimate `pageId` but is detected through the
record digest on every read and by store validation. The B01 pageId formula
is unchanged.

### 25.7 Advisory metadata versioning (frozen)

Historical core page records are immutable representations even when source
type is `versioned`. Advisory refreshes (`semanticGloss`, sets,
`lastNeededAtGeneration`) NEVER rewrite the core file; they land as
separate derived records under `advisory/` bound to (`pageId`,
`contentHash`) by their own digest, and they cannot exist without their
core. An LLM gloss cannot mutate durable evidence identity. Overlay
semantics belong to B03.

### 25.8 EvidenceRef durable binding (frozen)

Phase-A EvidenceRef semantics are reused VERBATIM (closed-world keys, kinds,
bounds from the frozen checkpoint authority; the ref round-trips byte-free
of reinterpretation). B02 adds only the deterministic join: columns
(`pageId`, `contentHash`, `exactBlobRef`, `namespace`) plus
`evidenceBindingId = 'ev_' + sha256Hex('nexus/evidence-binding/v1' LF
taskInstanceId LF evidenceId)[0..32)`. No UUID, no clock, no competing
identity model. Write order blob -> page -> evidence: page durability (full
revalidation incl. blob re-proof) precedes dependent EvidenceRef
durability. A binding whose ref digest disagrees with its page contentHash
is refused; bindings revalidate fully on every read.

### 25.9 Namespace isolation; dedup vs ownership (frozen)

Blob deduplication is content-driven and namespace-independent WITHIN one
store domain (identical bytes converge on one blob file; proven: one 1 MiB
blob backing two namespace-distinct page records with distinct pageIds).
Page/evidence ownership is namespace-bound: every task-owned read REQUIRES
an explicit expected namespace, and Task B reading Task A records FAILS
CLOSED even for identical backing bytes. Separate task run roots hold
separate blob copies (isolation dominates cross-filesystem sharing). The
internal blob reader always re-hashes; it is not a namespace bypass because
page/evidence reads re-prove namespace AND blob binding together.

### 25.10 Atomicity, crash, orphan, restart (frozen)

Every authority-bearing record: temp write -> validate -> exclusive claim
(hard-link; rename fallback re-verifies read-back equality) -> read-back ->
revalidate. Durability scope uses the A05H wording: process-crash
recoverable under the filesystem/OS contract, NOT power-loss durable (no
fsync). Temp files (`*.tmp-<pid>-*`) are never authoritative; readers open
only exact deterministic filenames. Crash injection around every stage
(temp creation/complete/claim/read-back for blob, page, evidence),
including a real SIGKILL hammer on large blob writes, proves restart
observes only absent-or-valid records, never half-valid authority. Orphan
blobs (blob durable, page absent) are safe and reported; B02 implements NO
garbage collection. Missing-blob pages fail closed without flipping
`rehydratable`. Concurrent identical writers converge (link-claim +
byte-compare); concurrent conflicting writers yield exactly one winner with
every loser failing closed (proven across real OS processes).

### 25.11 Evidence policies (frozen)

Small exact evidence may stay inline (`INLINE_EXACT_MAX_BYTES` = 4096:
`persistEvidenceV2` refuses oversized `exactText` without a blob route, so
behavior never varies accidentally). Large evidence travels as blob +
bounded page metadata (proven: 1 MiB log fixture, page record 861 bytes,
well under the B01 16 KiB bound). `validateContextPageStoreV2` checks page
records, record digests, namespace binding, blob references, content hashes,
and evidence bindings (bounded; never relevance-ordered). Telemetry
(`inspect`/`describe`) carries digests, byte counts, kinds, namespaces only
— never evidence content, never secrets. Exact source bytes that are hostile
or instruction-shaped are stored as inert bytes with derived untrusted
provenance and zero control-flow effect.

### 25.12 Tool-source deferred validation boundary (frozen)

B01 structurally guarantees a `tool-result` page claims a balanced
transaction (call + result seqs) but does not resolve DSH event types. B02
stores such pages exactly as validated and DOES NOT fix this: B03 MUST
perform source-resolution validation for session-backed pages and prove
referenced seqs form the claimed canonical evidence unit.

### 25.13 Scope boundary (frozen)

B02 introduces NO lexical/symbol/file search, NO relevance ordering, NO
numeric-closeness index, NO ContextView, NO Context Compiler, NO budget
packing, NO memory-tier assignment, NO JEV/Laya/DECIDE, and NO
user/compiler-facing rehydration pipeline (B03). Proof:
`tests/ContextPageStoreV2.Tests.cjs` (134 assertions), plus
`tests/ContextPageStoreV2Crash.Tests.cjs` (15) and
`tests/ContextPageStoreV2XProc.Tests.cjs` (12, real OS processes)
asserting the integrity matrix plus absence of retrieval/compiler/tier/view
surface. Harness entries `ContextPageStoreV2`, `ContextPageStoreV2Crash`,
`ContextPageStoreV2XProc` register after `ContextPageV2`.

B01 and Phase-A regressions remain green (see task report). Next: CCV2-B03
(Exact Rehydration) — not begun here.

## 26. B02H Evidence Store hardening freeze record (Phase B)

B02H closes three narrow durability/security ambiguities without redesigning
B01 or B02. Section 25 stays frozen with one additive note: the B02 unit
suite count moved 134 → 141 when the H2 brand boundary migrated the
attested-bytes legs (same coverage, stricter contract). All identities,
ordering, bounds, layout, and namespace semantics from B01/B02 are
unchanged.

### 26.1 Fallback exclusive-create claim (frozen)

Audit result (H1.5): no overwrite-capable rename remains in the authority
(the single fallback `renameSync` was removed; a source scan in the B02H
suite asserts its absence). The claim ladder is now: exclusive hard-link
claim first; any link failure other than EEXIST (EPERM/EXDEV/ENOSYS) falls
through to an exclusive create-if-absent (`'wx'`) of the full verified
content, then read-back verification. EEXIST on either path means a rival
holds the identity: byte-identical rivals converge, diverging rivals fail
closed with `context-store-conflict`. A rival-held file that fails
integrity verification is crash debris (e.g. a torn fallback write) and is
reported as `context-store-corrupt`: never adopted, never overwritten.
Fallback crash semantics are degraded by physics, documented honestly: a
crash mid-`'wx'`-write can leave a torn authoritative file; every read path
fails closed on it, store validation reports it as a failure entry, and
recovery is operator removal of the identified file (the primary link path
is unaffected: its crash debris is temp-only and idempotent retry just
works). No timestamp arbitration exists anywhere.

### 26.2 Forced-fallback seam (frozen)

`NEXUS_B02_FORCE_FALLBACK_CLAIM=1` in process environment skips the
link attempt and exercises the fallback deterministically for the whole
process. Default production behavior is unchanged (proven by a child
without the variable), no timing oracle is used, and no task/user content
can select the strategy. Forced-fallback proof: blob/page/evidence through
the real fallback (unit, 16), identical + conflicting writers across real
OS processes reusing the production worker (XProc, 11: exactly one winner,
all losers `context-store-conflict`, restart identifies the same winner,
aftermath validates).

### 26.3 Buffer route classification (frozen)

Every production entry reaching `putBlobV2` is classified: A.
already-redacted exact bytes — the string route and branded text, both
through the frozen A03 pipeline; B. opaque binary artifacts — branded
binary only, with explicit artifact descriptor; C. arbitrary untrusted
textual bytes — MUST travel route A (string/branded text, bounds enforced)
and can never be relabeled. Treating C as A or B is rejected, not assumed.

### 26.4 Raw Buffer rejection + proof boundary (frozen)

`putBlobV2` accepts `string | PersistableExactBytes`; a raw arbitrary
Buffer (textual or binary, including through `persistEvidenceV2.blobBytes`)
FAILS CLOSED with `context-blob-attestation-required`. The brand lives on a
module-private unique symbol (NOT the global registry): unforgable without
module access, so no user-controlled boolean (`alreadyRedacted: true` or
equivalent) can satisfy it. Factory `createPersistableExactBytesV2`: `{text}`
runs the frozen pipeline (byte-identical digest to the string route,
proven); `{binary, artifactId, note?}` enforces non-empty bytes within
`PERSISTABLE_BINARY_MAX_BYTES` (64 MiB) and a redaction-stable descriptor.
Predicate `isPersistableExactBytesV2` exposes the check for tests and later
phases. `putBlobV2`/`persistEvidenceV2` report the bounded `kind`
(`'text' | 'binary'`) in their results.

### 26.5 Large text evidence outcome (frozen)

No chunked/streamed redaction adapter was introduced: chunking cannot reduce
the pipeline's total backtracking cost (the sum over runs is unchanged) and
any newline-splitting adapter risks diverging from whole-input verbatim
semantics (B01 digest compatibility) or leaking cross-line matches. The
frozen outcome per input shape: large normal test/build logs (short runs)
travel the whole-input pipeline fast (proven: 1 MiB secret-bearing log
redacts in ~145ms with zero surviving secrets); long unbroken
secret-bearing runs fail closed fast via the linear run scan (safe outcome,
nothing persists); oversized strings fail closed. No secret persists in any
case, and large evidence never needs an unchecked bytes route.

### 26.6 Binary evidence semantics (frozen)

Branded binary is byte-exact, digest-bound, and binds page identity exactly
like text (proven: blob-backed `tool-result` page with an `artifact`
sourceBinding over a binary blob). Descriptor (`artifactId`, optional
`note`) is redaction-stable and safe to quote; the BYTES carry no secrecy
guarantee (no text policy can apply to opaque bytes) and MUST NOT be
materialized as controller/model text by later phases — recorded here as a
B03 constraint. Textual logs must never be relabeled binary to skip
redaction: genuine binary means non-textual bytes with a named artifact.

### 26.7 A03 redaction reuse (frozen)

A03 remains the sole redaction authority. The store carries no independent
secret pattern (suite asserts absence of every A03-specific token) and
calls `redactCheckpointTextV2` verbatim on the only text path.

### 26.8 Advisory revision determinism (frozen)

No `mtime`/`ctime`/directory-order heuristic selects advisory state
(suite asserts absence); no current/latest/listing advisory API exists and
none is introduced — B02 deliberately has no concept of "current advisory"
(a future manifest/CAS pointer, if ever needed, belongs to a later phase).
`readPageAdvisoryV2(pageId, advisoryDigest)` reads exactly the addressed
immutable record. Proven with A1/A2/A3 on one page: core bytes, pageId,
and contentHash unchanged; each revision distinctly digest-addressed and
immutable; restart resolves identically; store validates core + three
advisories.

### 26.9 Scope boundary (frozen)

B02H adds `createPersistableExactBytesV2` / `isPersistableExactBytesV2`
(proof boundary, not retrieval), the internal claim seam, and four suites:
`tests/ContextPageStoreV2Fallback.Tests.cjs` (16),
`tests/ContextPageStoreV2FallbackXProc.Tests.cjs` (11, real OS processes),
`tests/ContextPageStoreV2Secrets.Tests.cjs` (32),
`tests/ContextPageStoreV2Advisory.Tests.cjs` (19). No B01/B02 identity,
ordering, bound, layout, or namespace change. No retrieval, ranking,
rehydration, or compiler surface.

B01, B02, and Phase-A regressions remain green (see task report). Next:
CCV2-B03 (Exact Rehydration) — not begun here.





## 27. B03 Exact Rehydration freeze record (Phase B)

B03 implements identity-driven exact evidence rehydration over the frozen
B01 ContextPage contract and the frozen B02 store. B03 answers "I already
know exactly which evidence I need; give me that exact validated evidence"
and NOTHING else. Relevance search, ranking, lexical/symbol/file lookup,
BM25, embeddings, vector stores, reranking, ContextView, Context Compiler,
budget packing, memory-tier policy, and JEV/Laya/DECIDE are explicitly out
of scope (proven absent from the B03 production surface by source scan).
B01 (section 24), B02 (section 25), and B02H (section 26) are unchanged;
the B02H closing line naming B03 as "not begun" is superseded by this
record alone.

### 27.1 Production authority (frozen)

Authority: `config/ContextEvidenceRehydrationV2.cjs` (sole rehydration
authority). `rehydrateEvidenceRefV2`, `rehydrateContextPageV2`,
`resolvePageBackingV2`, `validateRehydratedEvidenceV2`,
`describeRehydrationV2`, `deriveRehydrationDigestV2`, plus the
re-exported session-digest producers `deriveSessionEvidenceDigestV2` /
`canonicalSessionEvidenceTextV2`. Two narrow adapters supply bytes/events
and never declare verified:true:
`config/ContextSessionEvidenceSourceV2.cjs` (canonical session source:
`createMemorySessionSourceV2`, `wrapDshSessionV2`,
`projectSessionEventV2`, digest producers) and
`config/ContextRepositoryEvidenceSourceV2.cjs` (exact file/artifact
supply: `createRepositoryExactSourceV2`,
`createArtifactExactSourceV2`). No exact-rehydration policy lives in the
store, compiler, or controller. The module holds no cache and no mutable
state: reads are restart-safe by construction.

### 27.2 RehydratedEvidence contract (frozen)

`RehydratedEvidenceV2 { schemaVersion:1, evidenceId|null, pageId, kind,
contentHash, namespace, provenance, sourceRoute, mediaType,
exactText|null, exactBytes|null, sourceIdentity, resultDigest,
verified:true }`, closed-world (unknown fields fail;
`validateRehydratedEvidenceV2` recomputes content and result digests).
`sourceRoute` is one of `inline-exact|blob|session|repository|artifact`;
`mediaType` is `text|binary`. Text carries `exactText` only; binary
carries `exactBytes` (Buffer) only, never a text projection.
Manufacture of `verified:true` without the authority is impossible: the
proof brand lives on a module-private unique symbol (B02H pattern), and
validation rejects brand-less or extended objects. RehydratedEvidence is
evidence transport, not task truth: B03 owns zero authority over task
completion, verification truth, requirement status, permission state,
checkpoint generation, retention, prompt inclusion, or memory tier.

### 27.3 Resolution paths (frozen)

EvidenceRef-first: a known `{taskInstanceId, evidenceId}` (optionally the
full Phase-A ref as a hint) resolves directly through the durable B02
binding (`readEvidenceV2`); no retrieval system rediscovers it. Page-ID
resolution takes a known `pageId` without a fabricated EvidenceRef
(`evidenceId` stays null). No query string, no relevance prompt, no
candidate list exists anywhere in the authority. Backing priority is
deterministic: `inline-exact > blob > sourceBinding > session`.
Co-present routes must already agree (B01 creation + B02 read-time proof);
B03 re-verifies each touched edge explicitly and never trusts caller-held
objects: production flow re-reads durable state on every call.

### 27.4 Binding chain (frozen)

EvidenceRef -> durable binding -> ContextPage -> exact backing ->
rehydrated bytes/text. Every edge must agree on evidenceId, pageId,
contentHash, namespace, and source identity where applicable: hinted-ref
fields diverging from the durable binding fail as binding-mismatch, a
binding whose contentHash/namespace diverges from its page fails as
binding-mismatch, and any backing digest divergence fails as
content-mismatch or source-mismatch. Phase-A EvidenceRef semantics are
reused verbatim (frozen checkpoint keys/kinds/bounds); no EvidenceRef V2
semantics were introduced.

### 27.5 Namespace-first validation (frozen)

Every call requires an explicit `expectedNamespace` (absent/null fails
as namespace-required); the frozen store/page authorities enforce it
BEFORE any evidence returns. Cross-task reads fail closed even for
byte-identical blobs/pages (proven); wrong workspace/repository/checkout
fail closed (proven); ownership is never inferred from page contents.

### 27.6 Backing routes (frozen)

Inline exactText: durable page -> validate -> namespace -> recompute
sha256(UTF-8 exactText) -> compare contentHash -> return persistable text.
Blob: durable page -> namespace -> read via the B02 authority only (never
direct store paths) -> recompute SHA-256 -> verify blobRef and page
contentHash -> return text or binary per section 27.7. Text blobs must
strictly decode as UTF-8 and already be in persistable redacted form;
malformed text encodings fail closed as media-type-invalid. Large evidence
travels the blob route unbounded by the B01 16 KiB page-metadata bound
(proven: ~1 MiB log round-trips fully, never truncated); errors/telemetry
stay bounded and carry no content.

### 27.7 Text vs binary boundary (frozen)

B02H branded binary stays opaque: non-UTF-8 or long-run blob bytes return
as `exactBytes` with `mediaType:binary`, never decoded, never rendered
into prompts, never executed or parsed as instructions (proven byte-exact).
Text-blob bytes must equal the persisted redacted bytes exactly; B03 never
re-runs lossy transforms, never unredacts, never guesses secrets:
`<redacted>` stays `<redacted>`. The declared-artifact route
(`sourceBinding.kind=artifact`) always returns opaque binary regardless
of byte printability, preserving the boundary for UTF-8-valid artifact
bytes. Binary evidence appears in telemetry only as byte count, digest,
route, and mediaType.

### 27.8 Session route (frozen)

Canonical session identity:
`projectEvent = {seq,type,data}` (all other host fields ignored);
`canonicalText = canonicalJson({domain, sessionId, events})`;
`sessionDigest = sha256HexUtf8(A03-redacted canonicalText)`.
Lookup is by canonical seq identity (`event.seq === seq`, never array
index); the DSH seed-boundary marker is transparent because it carries a
non-requested seq. The sessionId must equal the page namespace sessionId.
Pure-session pages (`rehydratable:false`) resolve iff a session source is
supplied AND the attested contentHash equals this digest; the stored page
is never rewritten (proven still `rehydratable:false` after rehydration).
Without a provable route they are refused as not-rehydratable, never
guessed. For byte-backed pages with seqs, the session linkage is
supplementary provenance proof (seq identity + session binding, plus the
tool-unit proof for tool-result pages); contentHash still binds the byte
route. The DSH adapter (`wrapDshSessionV2`) resolves against the live
session object and owns no persistence.

### 27.9 Tool-transaction source proof (frozen)

A `tool-result` page requires a session exact source (absent fails as
source-missing) and proof that the exact resolved events form the claimed
supported unit, reusing the frozen A06 field spellings and balance
semantics: at least one assistant tool-call, at least one tool/result,
every result closes a call opened earlier in the set, every call is closed
later in the set, running balance never negative and ends at zero, no
duplicate seq/call identity, no non-protocol event inside the claimed unit.
The negative matrix fails closed as tool-protocol-invalid: call only,
result only, wrong result for call, result before call, interleaved
incompatible unit, mutated protocol identity; wrong session/seq fail as
source-mismatch/source-missing; mutated session payload fails the digest
as source-mismatch. A structurally valid B01 page whose source disproves
the unit still fails. Proven live against the pinned host (call/result
append, flush, destroy, seeded restore, rehydrate) and for pure-session
tool pages through the digest route.

### 27.10 Repository/artifact exact-source semantics (frozen)

Resolution only from the already-known locator, never lookup: repository
spans open EXACTLY the bound relative POSIX path under the adapter root
(containment-proven, no absolute/escape/traversal), strict-UTF-8-decode,
select lines startLine..endLine inclusive (1-based LF split), and compare
sha256(span) to BOTH the binding contentDigest and the page contentHash.
The frozen contentDigest binds THE EXACT SELECTED SPAN (not the whole
file); a present symbol must occur in the span as an exact substring.
Changed file bytes fail as source-mismatch: newer content is never served
under the old identity (proven). Artifacts resolve EXACTLY by artifactId
(file-backed form: `file:<relative-path>`); bytes are opaque binary and
the digest must match binding and page (proven, including mutation
refusal). No recency heuristic selects anything; no file/symbol search
exists (proven absent by source scan). General lookup belongs to C03.

### 27.11 Content identity chain (frozen)

For every valid chain all applicable identities agree: EvidenceRef digest
(when present), binding contentHash, page contentHash, blobRef digest,
binding contentDigest, session digest, span/artifact digest. Any
disagreement fails closed. Advisory metadata (semanticGloss, tags,
entities, symbols, files, lastNeededAtGeneration, summary-shaped hints)
never selects returned bytes; a tampered advisory record fails the B02
record digest (proven), and a perfect gloss over missing backing still
fails (proven). The deterministic result digest binds
pageId/contentHash/sourceRoute/mediaType/namespace/sourceIdentity for
integrity/telemetry/idempotency only; it creates no competing evidence
identity.

### 27.12 Failure semantics (frozen)

Stable codes: `context-rehydration-evidence-not-found`,
`context-rehydration-not-rehydratable`,
`context-rehydration-namespace-required`,
`context-rehydration-namespace-mismatch`,
`context-rehydration-binding-mismatch`,
`context-rehydration-content-mismatch`,
`context-rehydration-source-missing`,
`context-rehydration-source-mismatch`,
`context-rehydration-tool-protocol-invalid`,
`context-rehydration-media-type-invalid`,
`context-rehydration-unknown-field`. Underlying B01/B02 causes are mapped
(never leaked with content) and bounded to 240 chars. A failed
rehydration mutates nothing: no task/prompt/store/session/repository
change, no replacement page, no lastNeededAtGeneration or access-time
write (proven: 100 reads leave byte-identical durable state; no temp
files). Rehydrated hostile text keeps frozen provenance with zero trust
promotion (proven: injection-shaped evidence stays advisory/untrusted).
Secrets: only persistable redacted forms return on A03/B02H-owned routes;
result, errors, telemetry, and describe paths are scanned secret-free
(proven). Live repository spans return verbatim source bytes, so
secret-bearing files should be snapshotted through the redacted blob route.

### 27.13 Determinism, idempotency, read-only (frozen)

Same known identity + same expectedNamespace -> byte-identical result
(proven across entry shapes, 100 reads, six simultaneous OS processes, and
process restart). No clocks, randomness, or process identity enter
identity. Ordinary reads need no locks. Observational latencies only (no
correctness thresholds; no latency enters identity).

### 27.14 Scope boundary (frozen)

B03 adds `rehydrateEvidenceRefV2` / `rehydrateContextPageV2` /
`resolvePageBackingV2` / `validateRehydratedEvidenceV2` /
`describeRehydrationV2` / `deriveRehydrationDigestV2` plus the two
source adapters and three suites:
`tests/ContextEvidenceRehydrationV2.Tests.cjs` (238 assertions),
`tests/ContextEvidenceRehydrationV2LiveHost.Tests.cjs` (20, pinned
`@deepseek-ai/dsh-session@0.1.1-rc.2`, gated REQUIRED-MISSING under
`NEXUS_REQUIRE_CCV2_LIVE_HOST=1` when the host is absent),
`tests/ContextEvidenceRehydrationV2XProc.Tests.cjs` (33, real OS
processes) with `tests/ContextEvidenceRehydrationV2XProc.Worker.cjs`.
Harness entries register after `ContextPageStoreV2Advisory`. No memory
tier, ContextView, compiler, budget, embedding, or ranking behavior.

B01, B02, B02H, and Phase-A regressions remain green (see task report). Next:
CCV2-B04 (Memory Tier Mapping) - not begun here.
## 28. B03H Rehydratability Semantics + Exact-Source Boundary Hardening (Phase B)

B03H freezes two narrow B03 contract boundaries without redesigning B01,
B02, or B03: (H1) the stored rehydratable flag vs runtime exact
resolvability, with an explicit B04 handoff rule; (H2) the artifact (and
shared repository-span) exact-source authorization boundary; (H3) the
media-type determinism audit. Sections 24-27 are unchanged. All
identities, digests, reason codes, and resolution paths from B03 hold
verbatim; B03H is purely additive (one pure helper, two exports, realpath
containment, exposed authority domain).

### 28.1 Stored page.rehydratable is frozen (H1.1)

The B01 derivation (byte-strong route present at mint: exactText,
exactBlobRef, or digest-bearing sourceBinding) is preserved verbatim. No
old page is mutated; no rehydratable:false is rewritten to true merely
because a SessionSource, RepositorySource, or ArtifactSource exists at
runtime. Proven: a pure-session page still reads back rehydratable:false
from the store after successful exact rehydration.

### 28.2 Runtime exact resolvability (H1.2)

Separate deterministic concept: whether B03 can currently prove an exact
route for a page PLUS the explicitly supplied exact-source authority. The
pure capability helper inspectExactResolutionV2(page, sources) exposes it
with no reads, no byte resolution, and no authority:

inspectExactResolutionV2(page, { sessionSource?, repositorySource?,
artifactSource? }) -> frozen { resolvable, mode, requiresExternalSource,
storedRehydratable, durablySelfBacked }

EXACT_RESOLUTION_MODES (frozen): durable-inline, durable-blob,
exact-session-source, exact-repository-source, exact-artifact-source. The
validated RehydratedEvidenceV2.sourceRoute already carries the sibling
route vocabulary (inline-exact, blob, session, repository, artifact); the
mode names are the pre-read capability view of the same routes.
Resolvability comes ONLY from durable exact backing OR an explicit exact
source authority whose shape is present (and, for session routes, bound to
the page sessionId). It NEVER comes from semanticGloss, summaries, similar
pages, or any match heuristic. The inspector is closed-world on its
sources argument and returns resolvable:false with mode:null for invalid
pages. Structural capability is not proof: a mutated source is
capability-present but fails at proof time inside rehydration (proven),
so effective resolvability is decided by the rehydration attempt.

### 28.3 Resolution matrix (H1.4, proven)

inline page: stored true, resolvable true, mode durable-inline, no
external authority. Blob page: stored true, resolvable true, mode
durable-blob. Pure-session page without source: stored false, mode
exact-session-source, resolvable false (rehydration refused as
not-rehydratable, never guessed). Pure-session page with valid bound
session authority: stored false, resolvable true, proof verifies, stored
flag untouched. Pure-session page with wrong-session authority:
capability-absent (false) and proof fails closed. Repository binding
page: exact-repository-source, resolvable iff the repository authority is
supplied. Artifact binding page: exact-artifact-source, resolvable iff
the artifact authority is supplied.

### 28.4 B04 handoff rule (H1.3, frozen)

B04 MUST NOT use ContextPage.rehydratable as the sole test for whether
evidence can move to a rehydrate-on-demand tier. B04 must distinguish
durably self-backed (durable-inline, durable-blob:
requiresExternalSource false) vs exactly source-resolvable
(exact-*-source with the authority supplied: requiresExternalSource true)
vs not exactly resolvable. B03 owns proof of exact resolution; B04 owns
tier policy. The inspector's requiresExternalSource/durablySelfBacked
fields are the executable form of this partition.

### 28.5 Artifact authority domain (H2.1, frozen)

Every file-backed exact source is bound at construction to ONE explicit
authorized domain: rootDir, exposed as authorityDomain. The domain is the
strongest existing authority available (controller-provided adapter root);
no broad filesystem authority is invented. A bespoke readArtifact function
is an explicit controller-provided capability, not a filesystem
authority: namespace-before-bytes and the content digest still apply to
whatever it returns. The adapters are NOT a generic local-file read
primitive: only exact bound locators resolve, and only inside the domain.

### 28.6 Path containment (H2.2, frozen)

Resolution order: normalize, resolve (realpath), containment check, read.
Lexical checks (relative POSIX, printable ASCII, no empty/dot/dotdot
segments, canonical form) reject spelling tricks; the resolved filesystem
identity proves domain membership. File or directory symlinks resolving
outside the domain fail closed before any byte is read, as do absolute
outside-root paths and non-canonical spellings. Reads proceed through the
verified real path.

### 28.7 Namespace before bytes (H2.3, proven)

Required order holds in the authority: expectedNamespace validation (via
the frozen store read) precedes exact-identity validation, which precedes
the adapter read, hash, and compare. Proven: a wrong-namespace artifact
read refuses with namespace-mismatch while a counting adapter proves zero
reads occurred, for both file-backed and capability-form sources.

### 28.8 Negative artifact matrix (H2.4, proven)

Valid artifact in the allowed root passes. Wrong namespace, ../
traversal, absolute outside-root path, symlink file escape (even with a
matching digest), symlink directory escape, and non-canonical spelling
refuse. Correct path with wrong hash and mutated bytes refuse as
source-mismatch; missing artifacts refuse as source-missing; non-file
identities are not resolved by the file adapter. No file search, no
latest-artifact heuristic (scope scan unchanged). The repository-span
route shares the containment primitive (symlinked span proven to refuse).

### 28.9 Media-type determinism (H3, frozen)

Classification is a pure function of the frozen source contract: strict
UTF-8 via TextDecoder fatal (no locale, no platform default encoding),
fixed ASCII word-run classes (no filesystem metadata), and the frozen
deterministic redaction pipeline (no mtime, no randomness). Same bytes
yield the same mediaType on every host and restart. Text-to-binary
conservative fallback (long word runs) is allowed and stable; binary is
never coerced to model-facing text; decodable-but-not-persistable bytes
fail closed as media-type-invalid. Proven: repeated binary reads,
mtime-shift insensitivity, multibyte-text stays text, lone continuation
and overlong encodings stay binary, fallback byte-exactness.

### 28.10 Scope and suites (frozen)

B03H adds inspectExactResolutionV2 / EXACT_RESOLUTION_MODES, realpath
containment, and authorityDomain exposure. No change to B01 pageId,
B01 contentHash, the stored rehydratable field, B02 blob identity, the
page store, EvidenceRef bindings, EvidenceRef resolution, result
identity, or Phase-A EvidenceRef semantics. New suite
tests/ContextEvidenceRehydrationV2H.Tests.cjs (64 assertions) registered
in the harness after ContextEvidenceRehydrationV2XProc. No tier, view,
compiler, budget, embedding, or ranking behavior.

B01, B02, B02H, B03, and Phase-A regressions remain green (see task
report). Next: CCV2-B04 (Memory Tier Mapping) - not begun here.

## 29. B04 Memory Tier Mapping (Phase B)

B04 freezes the deterministic mapping between Nexus task-memory objects
and the five CCv2 memory tiers. Production authority:
config/ContextMemoryTierV2.cjs. B04 answers "what class of memory an
object belongs to + what storage/materialization behavior that tier
permits" and NOTHING else: it emits policy metadata (tier, reason code,
storage/materialization descriptors, exact-resolution eligibility). It
builds no ContextView and no Context Compiler (Phase C), and owns no
token budget, retrieval ranking, search, embeddings, reranking, prompt
assembly, compression ladder, or JEV/Laya/DECIDE behavior.

### 29.1 Tier world (frozen)

MemoryTier is closed-world: PINNED, HOT, WARM, COLD, ARCHIVE. Unknown
tiers FAIL CLOSED. PINNED is correctness-critical current state
(task identity, active constraints, unresolved approvals, runtime
policy, current task binding, uncuttable tool protocol, latest
applicable checkpoint): exact/structured, always materialized when
applicable. HOT is immediate execution state (current user turn, recent
failure, current edit target, short active tool interaction, immediate
next action): usually exact, direct model-facing candidate. WARM is
durable task knowledge (accepted decisions, repository discoveries,
prior verification, milestone state, partly resolved failure):
checkpoint + exact refs, selectively materialized later. COLD is
historical evidence/execution bulk (large old logs, old file reads, old
tool output, superseded hypotheses, historical diffs): exact
ContentPage/blob, reference by default, exact rehydration on demand.
ARCHIVE is the canonical append-only history: not normally
model-facing, audit/disaster recovery. COLD is addressable exact
evidence intended for potential rehydration; ARCHIVE is the canonical
full record used primarily for audit/recovery. One canonical event may
underlie both an ARCHIVE source and a derived COLD page without
duplicating authority.

### 29.2 Decision contract (frozen)

MemoryTierDecisionV2 carries schemaVersion 1, tier, reasonCode,
exactness (structured-authoritative / exact-inline / exact-source /
exact-blob / canonical-history), storageBehavior (authoritative-state /
active-working-set / durable-reference / content-addressed /
canonical-archive), materializationPolicy (mandatory / normally-visible
/ selective / reference-by-default / recovery-only), an optional
materializationIntent (mandatory only for HOT current-user-turn with
exact preservation), requiresExactResolution + exactResolutionMode for
COLD, subject/page/contentHash/namespace/trust metadata, a resolution
snapshot, and deterministic true. B04 defines the policy; it never
constructs the model prompt. No ContextView, token list, or ordered
messages leave this module.

### 29.3 Authority order and PINNED hard rule (frozen)

Classification respects: mandatory correctness state -> PINNED;
immediate active execution state -> HOT; durable current task knowledge
-> WARM; old exact evidence with safe exact recovery -> COLD; canonical
historical transcript only -> ARCHIVE. Anything required for correctness
of the next legal continuation is never classified below PINNED merely
because it is old, large, rarely accessed, or semantically low
relevance. Active requirements and constraints are authoritative
structured state (PINNED), never COLD for lack of recent mention.
Satisfied/superseded historical evidence may later rest WARM/COLD per
exact policy. The current user instruction is HOT (plus mandatory
materialization intent when correctness requires exact preservation).
Unresolved/open tool protocol is PINNED (A06 continuity); completed
balanced transactions rest HOT/WARM while still required. The actively
investigated failure is HOT; failure identity still needed for
continuation is WARM; large historical failure logs with safe exact
backing are COLD; rejected/resolved hypotheses are COLD while the
canonical source remains ARCHIVE. Accepted decisions are WARM (PINNED
only as active correctness constraints); raw discussion leading to them
is COLD/ARCHIVE. Current verification truth is WARM (PINNED only where
a live gate requires it); large raw test output is COLD with proven
exact backing. Tier classification never changes PASS/FAIL truth.

### 29.4 B03 integration and COLD eligibility (frozen)

COLD requires exact recoverability through a proven route: old /
non-immediate evidence + exact resolution available + not correctness
mandatory. B04 uses inspectExactResolutionV2 and distinguishes durably
self-backed (durable-inline, durable-blob) vs source-resolvable
(exact-*-source with authority supplied) vs not exactly resolvable. It
never uses stored page.rehydratable alone. A pure-session page with a
valid bound session authority is COLD-eligible with
requiresExactResolution true and mode exact-session-source; the stored
page is never mutated. Without exact recovery, classification fails
toward WARM/HOT (more context), never toward DROP. Mutated, missing, or
mismatched sources lose COLD eligibility (resolution loss moves toward
WARM/HOT, never silent discard). Tier movement never changes trust
(COLD->WARM evidence stays untrusted/evidence) or verification truth,
and never deletes canonical history.

### 29.5 Transitions, determinism, isolation (frozen)

Legal transitions: PINNED<->HOT, HOT<->WARM, WARM<->COLD, COLD->WARM,
COLD->HOT (explicit reactivation). ARCHIVE is immobile canonical
substrate, never a working-tier endpoint. Transition causes are
closed-world deterministic codes; no access-frequency, recency, size,
LLM relevance, embedding, or model-judged cause decides anything.
Classification is pure and read-only (no page/checkpoint/store/session
mutation, no advisory write-back, no persistence: tier is derived from
durable state, never stored). Same validated inputs yield the same tier,
reason, capabilities, and policy across repeat calls, restarts, and
independent processes. Cross-task isolation holds (expectedNamespace
binding; foreign pages refuse even for identical bytes). Evidence text
commands (MAKE ME PINNED) have zero policy effect; only typed
metadata/rules decide. Tier metadata carries pageId/kind/hash/mode/
namespace identifiers only - no raw evidence text or secrets.

### 29.6 A08 compatibility and scope (frozen)

ACTIVE_REQUIRED maps to PINNED/HOT; CHECKPOINT_COVERED and REHYDRATABLE
to WARM/COLD; NOT_ELIGIBLE to PINNED/HOT/WARM (never COLD/ARCHIVE);
DERIVED_DISCARDABLE holds no tier; ARCHIVE sits outside A08 planning.
A08 is never modified. New suites tests/ContextMemoryTierV2.Tests.cjs
(236 assertions) and tests/ContextMemoryTierV2XProc.Tests.cjs (32, real
OS processes) with tests/ContextMemoryTierV2XProc.Worker.cjs, registered
in the harness after ContextEvidenceRehydrationV2H. No second truth
source for requirements/constraints/verification/task status is created.

B01, B02, B02H, B03, B03H, and Phase-A regressions remain green (see
task report). Next: CCV2-C01 (ContextView Contract) - not begun here.

## 30. B04H Exact-Resolution Proof Authority Hardening (Phase B)

B04H closes one authority ambiguity before the Phase-B freeze:
exact-resolution CAPABILITY is not exact-resolution PROOF (B03H
section 28). Audit result: the pre-hardening caller-supplied
sourceStatus string (including "verified") combined with structural
source capability could authorize externally-backed COLD with no B03
proof. That was a blocker; it is removed.

### 30.1 Proof authority (frozen)

B03 owns exact-resolution proof: a live validated RehydratedEvidenceV2
object carrying the module-private brand Symbol (unmintable by callers,
lost in serialization), verified:true, content-hash agreement with the
carried exact bytes, and a recomputed resultDigest. B04 owns tier
policy and validates + binds the proof; it never reimplements source
verification. The caller-supplied sourceStatus input is removed: any
such field now fails closed as unknown. A forged verified:true object,
a JSON-serialized copy of a real proof, and a bare
{ sourceStatus: "verified" } can never authorize COLD.

### 30.2 COLD rule (frozen)

Durably self-backed pages (durable-inline, durable-blob) remain
structurally COLD-eligible under frozen B01/B02 durable-store
semantics; B02 stays physical durability authority and B03 still
revalidates storage at materialization. External routes
(exact-session-source, exact-repository-source, exact-artifact-source)
require a B03-validated resolutionProof before tier COLD with
reason tier-cold-source-resolvable. Structural adapter presence alone
yields WARM with tier-keep-more-context-no-exact-resolution.

### 30.3 Proof binding (frozen)

Every proof binds pageId, contentHash, expected namespace, resolution
mode (sourceRoute mapped to inspector mode, and the two must agree),
and source identity. Mismatch in any field invalidates the proof
 cross-page and cross-task replay refuse. Proofs are
point-in-time for the bound source identity/revision, never a permanent
availability guarantee: mutated/missing sources cannot mint fresh
proofs, and stale decisions never bypass later B03 validation.

### 30.4 Conservative authorities (frozen)

mandatoryCorrectness stays a controller-asserted boolean; prose and
string forms fail closed, so untrusted evidence text can never set it.
Proofs are inapplicable to authoritative state subjects,
settled transactions, durable routes, and ARCHIVE (fail closed).

### 30.5 Phase-C handoff (frozen)

A B04 decision never guarantees external evidence still resolves at
future inference time. A COLD external page selected for
materialization must run B03 exact rehydration again: success uses the
exact evidence; failure takes conservative larger-context / KEEP
behavior. An old B04 proof never skips B03 validation.

### 30.6 Scope and suites (frozen)

No change to B01 page identity/contentHash/rehydratable semantics, B02
identity/durability, B03 verification/namespace/result identity, or A08
retention. New suite tests/ContextMemoryTierV2H.Tests.cjs (49
assertions) registered after ContextMemoryTierV2XProc. Existing B04
suites consume the proof contract (capability-only sessions classify
WARM, including cross-process where proofs cannot travel).

B01, B02, B02H, B03, B03H, B04, and Phase-A regressions remain green
(see task report). Next: CCV2-C01 (ContextView Contract) - not begun
here.
## 31. C01 ContextView Contract (Phase C)

C01 freezes the disposable model-facing working set compiled from durable
Nexus Task Memory for ONE inference. Production authority:
config/ContextViewV2.cjs. No Phase-A/B source file was modified
(additive-only); no compiler, retrieval, packing, compression,
embeddings, DECIDE, or prompt rendering exists anywhere in C01.

### 31.1 Authority boundary (frozen)

Checkpoint = authoritative task state. ContextPage = durable exact
historical evidence descriptor. MemoryTierDecision = deterministic memory
policy. ContextView = disposable model-facing working set for ONE
inference. A ContextView is NOT task truth, durability proof,
verification/completion/retention authority, EvidenceRef authority, a
checkpoint replacement, or canonical history. Deleting every ContextView
loses zero durable task truth. The module persists NOTHING, queries NO
live controller state, and performs NO search/packing/compression.
Conceptual exports: createContextViewV2, validateContextViewV2,
canonicalizeContextViewV2, deriveContextViewIdV2,
deriveContextViewDigestV2, describeContextViewV2.

### 31.2 Schemas (frozen)

ContextViewV2 exact keys: schemaVersion(1), id, namespace (full 6-field
frozen namespace), checkpointBinding, turnRef|null, pinned, hot, warm,
materializedCold, referencedColdPages, tokenBudget,
compilerPolicyRevision, compilationTrace, mandatoryRefs, viewDigest,
disposable(true, invariant). The architecture baseline name
retrievedPages is frozen as the canonical field materializedCold (exact
COLD material already chosen by a future compiler; C01 performs no
retrieval); a retrievedPages key fails closed with a rename pointer.

MaterializedContextV2 exact keys: schemaVersion, id (derived cxm_, never
caller-supplied), tier (PINNED/HOT/WARM/COLD; ARCHIVE absent), sourceType
(checkpoint-state/current-turn/context-page/rehydrated-evidence/
runtime-state), sourceId, contentHash (= sha256 of exactText, enforced),
provenance (full frozen TrustProvenance), mediaType (text only; binary
fails closed, never silently decoded), exactText (bounded), mandatory,
tierDecision (validated B04 decision, binding below), evidence? (fresh
B03 binding record for external COLD), toolTransaction? (balanced unit
for protocol subjects).

ContextReferenceV2 exact keys: pageId, contentHash, evidenceId?, kind,
provenance, exactResolutionMode (any frozen B03H mode), namespace
(task/instance/session triple), tierDecision (COLD, validated).
Identity-only: no page text, no summary-as-evidence. Referenced-only
COLD remains known but its exact bytes are NOT in the view.

ContextMandatoryRefV2 exact keys: sourceId, kind (7-kind closed world),
contentHash?. ContextDecision exact keys: pageId?, action
(PIN/LOAD/EXTRACT/REFERENCE/SKIP), reasonCode, deterministic (must be
true; no DecisionProvider exists), provider?, confidence?.

### 31.3 Identity and integrity (frozen)

entryId = cxm_ + sha256Hex(UTF-8(nexus/context-view-material/v1 LF
section LF tier LF sourceType LF sourceId LF contentHash)).slice(0, 32).
viewId = cxv_ + sha256Hex(UTF-8(nexus/context-view/v1 LF
canonicalJson(identityBody))).slice(0, 32); identityBody binds namespace,
checkpoint generation/id/contentHash, snapshot revision, turnRef, compiler
policy revision, budget, mandatory refs (view order), ordered
materialized contents (section/id/sourceId/contentHash/tier), and ordered
referenced identities. No clock, UUID, PID, or mtime. The compilation
trace is observability, NOT identity: trace-only differences share
viewId. viewDigest = sha256Hex(UTF-8(nexus/context-view-digest/v1 LF
canonicalJson(view WITHOUT id + viewDigest))) covers membership, order,
content, references, budget, trace, checkpoint binding, namespace, and
policy. Canonical serialization reuses frozen A03 canonicalize; equal
inputs serialize byte-identically across calls, restarts, processes.

### 31.4 Binding and preservation (frozen)

Namespace: every tier decision, evidence record, and cold reference
triple-must-match the view namespace; cross-task inclusion fails closed.
Checkpoint binding: generation/id/contentHash plus A05 revisionDigest as
snapshotRevision (explicit null for legacy checkpoints); binding only, no
freshness authority. Tier preservation: entry.tier must equal its B04
decision tier and its section tier; page-backed entries bind
decision.pageId/contentHash to sourceId/contentHash; state-backed entries
carry page-less decisions. Caller relabeling is impossible through the
validated decision. Trust preservation: entry provenance must carry the
decision trust class and pass authority-legality; rehydrated provenance
must equal entry provenance; B03 verification never upgrades trust.
Content never self-declares authority through prose.

### 31.5 Membership invariants (frozen)

One semantic source -> one materialized representation (plus the
checkpoint:full marker carve-out owned by its own exactly-once rule).
Current-turn at most once (source identity, not text equality). Latest
full checkpoint (checkpoint:full) at most once. Balanced tool units: a
protocol-subject entry without a call+result unit fails; one-sided units
fail. Mandatory manifest: every ref accounted exactly once with hash
agreement where given; missing/duplicate/drift fails closed. C01 never
creates the manifest (C02 derives it). Budget is a validated contract
(0 <= target <= hardMax; when used is known, 0 <= used <= hardMax;
used:null = explicit unknown, never guessed); target is the preferred
materialization target and hardMax the absolute ceiling, so a known
used may honestly exceed target but never hardMax (C04H correction).
C01 computes nothing and never decides WHY used exceeds target (C04
owns allocation and packing-policy correctness).

### 31.6 External-COLD handoff (frozen)

External-route COLD (exact-session/ repository/artifact-source) requires
a fresh B03 evidence binding record: route/mode agreement, recomputed
B03 resultDigest, namespace + provenance binding. The old B04 decision
alone never counts as materialized evidence (stale-proof rule); C01
validates binding agreement, never rehydrates, never vouches freshness
(C02 rebuild responsibility). Durably self-backed COLD needs no external
record; the exactText/contentHash equation is its check.
Referenced-only COLD needs no fresh bytes.

### 31.7 Bounds and safety (frozen)

Structural schema-safety bounds only (per-section 256, references 512,
trace 1024, mandatory 256, exactText 8192 chars, view 1 MiB); never the
C04 model token budget. Closed-world exact keys at every level; unknown
fields fail closed. describeContextViewV2 emits ids, hash prefixes,
counts, tiers, budget metadata only: no prompts, blobs, or credentials.
Creation/validation is pure and read-only; outputs deeply frozen.

### 31.8 Suites (frozen)

New suites tests/ContextViewV2.Tests.cjs (123 assertions) and
tests/ContextViewV2XProc.Tests.cjs (+ worker, 16 assertions), registered
after ContextMemoryTierV2H. Fixtures cover PINNED requirement/constraint,
HOT current-user turn + active failure, WARM decision + verification,
materialized COLD test log, referenced-only COLD repo page, ARCHIVE
exclusion, mandatory refs, live B03 session-route proof binding, tool
protocol units, hostile-evidence inertness, and cross-task isolation.
Phase A, B01, B02(+H), B03(+H), B04(+H) regressions remain green (see
task report). Next: CCV2-C02 (Deterministic Context Compiler) - not
begun here.

## 32. C02 Deterministic Context Compiler (Phase C)

C02 freezes the deterministic policy that decides what is
mandatory / current / eligible for ONE inference. Production authority:
config/ContextCompilerV2.cjs. No Phase-A/B/C01 source file was modified
(additive-only); no retrieval, packing, compression, embeddings,
reranking, semantic scoring, DECIDE, or prompt rendering exists anywhere
in C02.

### 32.1 Authority boundary (frozen)

Checkpoint = authoritative task state. ContextPage = durable exact
historical evidence descriptor. MemoryTierDecision = deterministic memory
policy. CompileInput = closed-world caller-supplied known state.
ContextCompilationPlan = disposable compiler state (candidates +
deterministic decisions + mandatory manifest + plan digest).
ContextView = disposable model-facing working set for ONE inference,
constructed only through the C01 authority, which remains the final
structural gate: a compiler output that C01 rejects fails the
compilation closed. Deleting every plan and view loses zero durable
task truth. The module persists NOTHING, queries NO live controller
state, scans NO store / session / repository, and performs NO
search / packing / compression.
Conceptual exports: compileContextV2, buildContextCompilationPlanV2,
deriveMandatoryManifestV2, enumerateContextCandidatesV2,
applyDeterministicContextPolicyV2, validateContextCompilationPlanV2,
describeContextCompilationPlanV2.

### 32.2 CompileInput contract (frozen)

CompileInputV2 exact keys: checkpoint (validated A03, never prose-mined),
currentTurn|null (turnId/text/revision, verbatim exact preservation),
namespace (full 6-field compile ownership), snapshotRevision (must equal
the checkpoint snapshot slot, explicit null for legacy checkpoints),
runtimeState (openProtocol|null with callId/recordText; one-sided units
are never materialized - without a balanced unit compilation fails
closed per A06 semantics), pages (explicit known ContextPages, never
discovered), tierDecisions (explicit B04 decisions, tier truth),
evidenceRefs (known identities with namespace triples; without a backing
page they stay identity-only deferred candidates for C03),
exactMaterial (already-supplied B03 results, brand-validated; never
fetched), budget (hardMax/target contract only; used is caller-forbidden
and always stored null), compilerPolicyRevision (must be
context-compiler-v1). Unknown, scoring, advisory-authority, and
provider keys (score, embeddingSimilarity, llmPriority, forcePinned,
authority, confidence, provider, ranking, query, used, ...) fail closed
as unknown input.

### 32.3 Namespace-first ownership (frozen)

Before candidate processing, the checkpoint triple, every page triple,
every tier-decision triple (where present), every exact-material triple,
every evidenceRef triple, and the snapshot binding must agree with the
compile namespace. Foreign state fails closed before any output, even
for byte-identical content: deduplication never confers access.

### 32.4 Mandatory manifest derivation (frozen)

C02 owns creation of the C01 mandatory manifest, derived
deterministically from authoritative structured state (never prose):
every active requirement (checkpoint:requirement:<id>), every active
constraint (checkpoint:constraint:<index>), every unresolved approval
(checkpoint:approval:<index>), the task objective
(checkpoint:objective, the mandatory-checkpoint-state slice), the open
tool protocol when present (runtime:open-protocol:<callId>), and the
current user turn when B04 asserts materializationIntent = mandatory
(current-turn:<turnId>). Every mandatory ref binds sourceId, C01 kind,
and contentHash. Mandatory state cannot be filtered: a mandatory
candidate without PIN/LOAD materialization, a missing B04 decision for
mandatory state, or a missing mandatory turn fails the compilation
closed; no trace action can waive it (C01 ignores the trace for
membership).

### 32.5 Candidate contract and identity (frozen)

ContextCandidateV2 exact keys: schemaVersion(1), candidateId, subjectKind
(frozen B04 vocabulary), sourceId, tier (PINNED/HOT/WARM/COLD, plus
ARCHIVE observability only), mandatory, contentHash, pageId, evidenceId,
provenance (frozen TrustProvenance), materializationState
(exact-available / reference-only / requires-retrieval / archive-only),
deterministicReasonCode (stable compiler-* vocabulary), deterministic
(true; provider and confidence are omitted, never guessed). No score,
no priority, no relevance, no confidence exists on a candidate.
candidateId = ccx_ + sha256Hex(UTF-8(
nexus/context-compiler-candidate/v1 LF taskId LF taskInstanceId LF
sessionId LF subjectKind LF sourceId LF tier LF pageId LF
contentHash)).slice(0, 32): namespace, subject kind, source identity,
tier, page/evidence identity, and content identity bound; no clock, no
UUID, no PID, no mtime. Unknown tier/subject/state/source fails closed.

### 32.6 Deterministic policy and ordering (frozen)

Policy inputs only: authority class, B04 tier, mandatory state,
current-turn identity, exact availability, known structured task state.
Never: semantic similarity, model scoring, model confidence, embedding
scores, wall-clock recency, access frequency. Priority is
classification, not packing: correctness (PINNED) > current execution
(HOT) > durable task knowledge (WARM) > historical evidence (COLD),
with ARCHIVE recorded as archive-only observability. Internal outcomes
PIN/LOAD/REFERENCE/DEFER map onto the C01 trace vocabulary
PIN/LOAD/REFERENCE/SKIP (DEFER -> SKIP as non-authoritative
observability meaning not selected into this baseline view, never
permanently discarded; EXTRACT is never emitted at C02).
Ordering is identity-relevant and deterministic: PINNED, HOT, WARM
state, WARM pages, materialized COLD, referenced COLD, deferred,
archive; sequential checkpoint state preserves canonical array order;
set-like page candidates sort by stable page identity; page input order
never leaks into view identity. One semantic source yields one canonical
candidate: duplicate enumeration, same source with conflicting tier /
contentHash / namespace, or a mandatory source eligible for
reference-only treatment fails closed.

### 32.7 Materialization rules (frozen)

PINNED state renders deterministically from frozen structured fields
(requirement / constraint / approval / objective templates) with
A04-legal provenance; bytes hash to the claimed content identity.
Current user turn materializes verbatim exactly once (source identity,
not text equality); a second representation of the same turn identity
fails closed. Active failures render from typed failure state; no
historical logs are pulled. WARM state (accepted active decisions,
verification outcomes, continuation failure state) renders from the
checkpoint; exact WARM pages with inline bytes are kept (conservative
rule: no WARM is discarded for size before C04); WARM without available
bytes defers as requires-retrieval for C03. COLD pages with
durable-inline bytes materialize without proof; all other COLD without
fresh supplied B03 evidence stays identity-only referenced. External
COLD (exact-session/repository/artifact-source) materializes only when
a live B03 result binds this page, this content revision, this
namespace, the decision mode, and the entry provenance (route/mode
agreement, recomputed resultDigest, text bytes hashing to contentHash);
any mismatch, any brand-less clone, or any proof for an unknown page
fails closed. The old B04 resolution proof alone yields reference-only,
never materialization. Durable-blob COLD without supplied bytes stays
referenced. Tool-protocol subjects (open protocol, completed
transactions) materialize only with balanced call+result units; the
callId derives deterministically from the page provenance refs (or the
supplied open-protocol record). ARCHIVE never enters the view.

### 32.8 Budget handoff (frozen)

C04 owns token allocation. C02 never tokenizes, estimates, drops, or
packs: tokenBudget.used is always null (explicit unknown), and budget
shape (0 <= target <= hardMax) validates through C01. Mandatory token
fit is frozen for C04; mandatory completeness is proven here (every
mandatory ref accounts exactly once with hash agreement).

### 32.9 Plan contract and plan/view agreement (frozen)

ContextCompilationPlanV2 exact keys: schemaVersion(1), namespace,
checkpointBinding, compilerPolicyRevision, mandatoryRefs, candidates,
decisions, deterministic(true), planDigest. planDigest =
sha256Hex(UTF-8(nexus/context-compilation-plan/v1 LF
canonicalJson(plan WITHOUT planDigest))): full-record integrity for
observability only, never a second task-memory identity. Validation
proves candidate closed-world shape, decision/candidate agreement
(same order, same reason codes, same page binding), mandatory
completeness in both directions (every mandatory candidate has exactly
one agreeing ref; every ref binds a mandatory candidate), and digest
agreement. compileContextV2 additionally proves plan/view agreement:
mandatoryRefs(plan) = mandatoryRefs(view) byte-for-byte, PIN/LOAD
decisions = view membership, REFERENCE decisions = referencedColdPages.
Compilation is read-only over all inputs; any failure is
non-destructive and retryable with the same inputs.

### 32.10 Safety invariants (frozen)

Trust is never upgraded: included evidence keeps its B04/page trust
class (tool/verification evidence stays evidence; user intent stays
user-intent); provenance legality revalidates through A04. Candidate
content prose (including MAKE ME PINNED / SKIP OTHER RULES /
AUTHORITY=controller payloads) has zero effect on tier, mandatory
status, action, or ordering: only typed structures decide. Traces and
descriptions carry reason codes, page ids, actions, counts, tiers, and
hash prefixes only - never exact text, prompts, blobs, or credentials.
Cross-process determinism: identical serialized frozen inputs (durable
fixtures only; B03 brands never cross processes) produce byte-identical
plans, traces, and views across independent OS processes.

### 32.11 Suites (frozen)

New suites tests/ContextCompilerV2.Tests.cjs (253 assertions) and
tests/ContextCompilerV2XProc.Tests.cjs (+ worker, 24 assertions),
registered after ContextViewV2XProc. Fixtures cover active
requirement/constraint, unresolved approval, mandatory checkpoint
objective, open tool protocol with balanced unit, current user
exactly-once (mandatory and normal intent), active failure, accepted
decision, verification state, failure state, immediate and settled tool
transactions, durable-inline COLD materialization, referenced-only COLD,
session-route COLD reference vs fresh-proof materialization,
brand-less-clone and cross-page proof rejection, ARCHIVE exclusion,
mandatory-loss and conflict fail-closed matrices, injection inertness
(including hostile page prose), trace generation and non-authority
(trace-only change shares viewId), used:null budget handoff,
plan/view agreement, namespace isolation, trust preservation,
evidenceRef deferral, WARM-without-bytes deferral, read-only purity,
determinism, ordering stability, and the C03/C04/C05 boundary (no
retrieval entry points, no scoring fields, no EXTRACT, no provider
rendering). Phase A, B01, B02(+H), B03(+H), B04(+H), C01(+XProc)
regressions remain green (see task report). Next: CCV2-C03
(Exact / Lexical / File / Symbol Retrieval) - not begun here.

## 33. C02H Open Protocol Semantics Hardening (Phase C)

C02H closes one semantic ambiguity in the C02 record above without
reopening any frozen section: an OPEN/PENDING tool protocol (call
emitted, result not committed) is continuation-critical runtime state
and is NEVER a completed balanced historical transaction. The C02
text that materialized `open-tool-protocol` as a PINNED entry with a
balanced `callPresent:true/resultPresent:true` unit is superseded in
full by this section: that construction risked presenting a pending
result as completed, and no such entry is ever produced again. The
retired vocabulary (`runtimeState.openProtocol`, its record text, and
the `compiler-pin-open-protocol` reason code) no longer exists in the
compiler authority. No Phase-A, B-series, or C01 file was modified.

### 33.1 Frozen protocol ground truth (consumed, never redefined)

A06 SafePointDetector owns the distinction: a request without a
result is an open edge (`safe-point-tool-call-open` when the dispatch
start was never recorded, `safe-point-tool-result-pending` when the
call is recorded but no result is committed), and an assistant
message that still carries tool-call blocks is NEVER a safe
boundary; `tool-result-committed` is the boundary kind that closes
tool execution. B03 owns the balance proof for evidence units: a
result closes a call only when its callId matches an OPEN call and
its seq follows the call seq; call-only, result-only, wrong-result,
and result-before-call units are rejected, and balance must end at
zero. B01 grounds it durably: a tool-result page requires call +
result seqs, so pending protocol is unrepresentable as durable
evidence. C02 consumes all three truths and redefines none of them.

### 33.2 The inference-boundary answer (frozen)

A ContextView is compiled for ONE root-model inference. While a tool
call is unmatched, the mandatory next input to any new inference
(the committed result) does not exist, and the open edge is never a
boundary per A06. The compiler therefore treats a pending protocol
as an illegal inference boundary: compilation fails closed with the
stable code `context-compiler-protocol-open` and emits no plan, no
candidates, and no view. The failure is non-destructive and
retryable: callers retry at a legal boundary once the result
commits. No synthetic balance, no placeholder result, and no
"balanced for rendering" fiction exist anywhere in this path.

### 33.3 Pending representation (frozen)

`runtimeState.pendingProtocol` carries exactly the A06 pending
identity: `{ callId, callSeq }`, where `callSeq: null` means the
dispatch start was never recorded (call-open) and a recorded
`callSeq` with no result means result-pending. Both block. Any
non-null pending identity fails validated-input assembly itself, so
every compiler entry point (enumerate, manifest, policy, plan,
compile) refuses before any candidate exists. Pending protocol can
therefore never reach a baseline view, a trace, or a mandatory
manifest.

### 33.4 Completed-transaction proof (frozen)

A completed transaction materializes only with an explicit
caller-supplied matched binding per tool-result page
(`toolTransactions: [{ pageId, callId, callSeq, resultSeq }]`).
Each binding is validated against the page's exact backing without
resolving any session event (no reads, no discovery): the page must
be a known `tool-result` page; `callId` must bind the page protocol
identity (`tool-event:<callId>` provenance ref); both seqs must be
inside the page's exact `sourceSeqs`; `callSeq` must strictly precede
`resultSeq`. Wrong-result bindings (callId mismatch, seqs outside
the backing), result-before-call bindings, bindings for
non-transaction or unknown pages, and conflicting duplicate bindings
all fail closed (`protocol-open` for balance violations,
`input-invalid` for unknown shapes/pages, `content-conflict` for
clashing duplicates). A protocol-subject page without a binding has
no candidate at enumeration time: seq count alone never balances.
The emitted C01 unit reuses the bound `callId` with a genuinely
balanced `callPresent:true/resultPresent:true` claim.

### 33.5 Mandatory vs materializable (frozen)

An unmatched protocol remains mandatory B04 continuation state
(`open-tool-protocol` still classifies PINNED), and a supplied B04
decision for it is acknowledged (validated, namespace-checked). But
mandatory-for-safe-continuation is not legal-model-facing-
materialization: the decision yields no candidate, no mandatory ref,
and no trace entry. No `tool-protocol` mandatory ref is ever emitted
without a real result.

### 33.6 C01 interaction (no modification, explicit justification)

C01 is untouched. Its frozen rules are exactly the honesty property
C02H relies on: protocol-subject entries require balanced units,
one-sided units fail (`context-view-tool-protocol-unbalanced`),
missing units fail (`context-view-tool-protocol-incomplete`), and
C01 carries no pending-protocol vocabulary. Because the real runtime
lifecycle never presents pending protocol as model-facing state (see
33.2), no pending representation is needed in C01, so weakening it
to admit one-sided units would only legalize the fiction this
section forbids.

### 33.7 Suites (frozen)

New suite tests/ContextCompilerV2H.Tests.cjs (40 assertions),
registered after ContextCompilerV2XProc: completed call/result
materialization with matched bindings; result-pending and call-open
blocking (compile, plan, and enumeration entry points) with input
purity; wrong-result (callId mismatch, seqs outside backing,
non-transaction and unknown pages); result-before-call (reversed and
equal seqs); no balancing by seq count; duplicate/conflicting
bindings; no-synthetic-result source proof; prompt-projection safety
(pending wins over a same-call completed binding; every emitted unit
genuinely balanced); the mandatory/materializable distinction; and
the C01 unmodified gate (one-sided and missing units still rejected
there). The C02 suite was updated to the honest shape (251
assertions): steady-state fixtures carry explicit matched bindings,
and the old balanced-open-protocol expectations are replaced by
blocking expectations. Phase A, B01, B02(+H), B03(+H), B04(+H),
C01(+XProc), C02(+XProc) regressions remain green (see task report).
Next: CCV2-C03 (Exact / Lexical / File / Symbol Retrieval) - not
begun here.

## 34. C03 Exact / Lexical / File / Symbol Retrieval (Phase C)

C03 implements the deterministic retrieval layer and NOTHING else: given
the current compile request, which already-stored exact evidence should
be returned. Retrieval cascade: exact EvidenceRef / Page ID, then exact
file identity, then exact symbol identity, then deterministic lexical
retrieval. Stop there. C03 implements no embeddings, no semantic
retrieval, no learned ranking, no DECIDE, no budget packing, and no
compression. Primary rules: exact references always win, and retrieval
answers evidence relevance/access, never task truth. No Phase-A,
B-series, C01, or C02 file was modified.

### 34.1 Authority boundary (frozen)

One retrieval authority: config/ContextRetrieverV2.cjs. One derived
index authority: config/ContextEvidenceIndexV2.cjs. Responsibilities
stay narrow: the retriever owns query validation, namespace-first
orchestration, route priority, deterministic lexical scoring, duplicate
merging, limit semantics, trace, and the C02 handoff adapter; the index
owns derived namespace-scoped token binding over validated B01 pages.
Frozen ownership is unchanged: TaskController/Checkpoint = task truth;
B01/B02/B03 = exact evidence identity/storage/rehydration; B04 =
memory tier policy; C02 = compiler candidate policy; C03 = retrieval
of evidence; C04 = what fits in budget (not begun here). Retrieval
changes no requirement status, verification truth, task status, tier,
trust, or checkpoint state.

### 34.2 Request contract (frozen)

Closed-world ContextRetrievalRequestV2: namespace, exactEvidenceIds
(evidenceId strings or { evidenceId, taskInstanceId?, evidenceRef? }
objects defaulting to the request namespace), exactPageIds, fileIdentities
({ path, contentHash?, repositoryId? }), symbolIdentities
({ symbol, file?, repositoryId? }), lexicalTerms, optional
candidatePageIds, integer limit (0-100), mode
(identity-only | exact-materialized), contextRoot (required whenever an
exact route is used), evidenceIndex + pages (required whenever a
file/symbol/lexical route is used), and optional pass-through
session/repository/artifact sources for materialized backings. Unknown
keys, embedding/vector/semanticPrompt/LLM-query/confidence/model/
provider fields, non-integer or out-of-range limits, and unknown modes
fail closed with retrieval-request-invalid.

### 34.3 Namespace before ranking (frozen)

Ordering is fixed: validate the request namespace, constrain the
index/store namespace, then resolve/rank, then return evidence. Every
supplied page is revalidated under the request namespace before any
ranking; the derived index namespace must equal the request namespace;
exact routes pass expectedNamespace into the frozen B02/B03
authorities. Cross-task and cross-repository pages fail closed before
ranking (retrieval-namespace-mismatch); search-then-filter never occurs.

### 34.4 Exact routes (frozen)

Known EvidenceRef and known pageId resolve directly through the frozen
B03/store authorities (identity-only mode reads binding + page headers;
exact-materialized mode calls rehydrateEvidenceRefV2 /
rehydrateContextPageV2 and returns B03-verified bytes). Exact failures
(missing, corrupt, namespace mismatch, source mismatch) are returned as
error entries with stable reasons (retrieval-exact-not-found,
retrieval-exact-content-mismatch, retrieval-namespace-mismatch) and are
NEVER silently replaced by a lexical/file/symbol near-match. Optional
unrelated results may accompany the errors, but no result ever claims
to satisfy the failed exact identity.

### 34.5 Exact-first ordering (frozen)

Categorical route priority: exact-evidence (1) > exact-page (2) >
file (3) > symbol (4) > lexical (5). A lexical match cannot outrank a
known exact ref regardless of numeric score. Exact routes use
score:null with scoreClass exact-v1; file/symbol use score:null with
identity scoreClasses; only lexical carries a numeric score
(scoreClass lexical-v1).

### 34.6 File identity semantics (frozen)

File retrieval means known exact normalized file identity to pages
referring to that file, never fuzzy filename search. Normalization
mirrors frozen B01 path rules (relative POSIX, no absolute escape, no
backslash, no traversal, no empty/dot segments). Priority: path +
contentHash > path only; a claimed contentHash admits only pages whose
contentHash equals that exact revision, so an old revision query never
silently returns newer bytes. repositoryId claims must equal the
request namespace repositoryId (retrieval-file-repository-mismatch).
Bare filenames never match across directories.

### 34.7 Symbol identity semantics (frozen)

Symbol retrieval means known symbol identity within the request
namespace to exact pages carrying it. Matching is byte-exact and
case-sensitive (Parse != parse); no embeddings, no fuzzy expansion.
An unqualified ambiguous symbol returns all carriers deterministically
(pageId ascending); symbol + file narrows to the matching file
identity. Unknown symbols are clean no-matches; foreign-repository
claims fail closed (retrieval-symbol-repository-mismatch).

### 34.7b Lexical contract (frozen)

Lexical retrieval is deterministic textual matching over bounded
indexed fields (kind, files, symbols, entities, tags, extract,
semanticGloss, inline-bounded exactText when present on the validated
page object; blob/session backings contribute metadata only, so a 1 MiB
blob is never scanned per request). semanticGloss may aid relevance but
is never evidence truth. Normalization is frozen: NFKC, locale-free
lowercase, maximal [a-z0-9] runs, 64-char cap, sorted deduplicated
token sets. No synonym expansion: a query matches only literal indexed
terms. Scoring is transparent and frozen: per-token best-field weights
(files/symbols 50, tags/entities 30, extract/exactText 20, kind 10,
semanticGloss 5) plus a 15-point exact-phrase bonus; ties break by
pageId ascending. No recency, mtime, access-count, filesystem-order,
or random ranking exists.

### 34.8 Result contract (frozen)

RetrievedEvidenceV2 entries carry pageId, evidenceId (exact-evidence
route only), contentHash, route, scoreClass, score (numeric for
lexical, null otherwise), matchedFields, frozen provenance verbatim,
namespace, optional B03 rehydratedEvidence (materialized exact routes
only), and deterministic:true. Results add a namespace-bound
resultDigest over identities/routes/scores/matched fields plus an
errors array (exact failures) and a bounded trace (pageId, route,
matchedFields, scoreClass, score, stable reasonCode; no evidence
content). validateRetrievalResultV2 enforces the closed world, single
occurrence per pageId, route-priority order, score shape per route,
known reason codes, and digest agreement. describeRetrievalResultV2
exposes ids/routes/scores/hash prefixes only. Duplicate discoveries
merge to one entry preserving the strongest route.

### 34.9 Limit and candidate semantics (frozen)

limit applies ONLY to optional non-exact results; explicitly requested
exact EvidenceRefs/pageIds are mandatory obligations never truncated
(8 exact refs with limit=3 return all 8 plus at most 3 optional).
candidatePageIds (the C02 handoff set) restricts file/symbol/lexical
discovery to that set; exact obligations are unaffected. When lexical
ordering ties, all tied candidates are returned within the limit
(fail-toward-more-evidence, never semantic preference).

### 34.10 Index role and persistence (frozen)

The EvidenceIndex is derived, rebuildable, namespace-scoped, and
non-authoritative: deleting/rebuilding it loses zero durable task
truth. It is built only from caller-supplied B01 pages revalidated
here (validateContextPageV2 under the request namespace); arbitrary
filesystem text, prompt contents, unvalidated JSON, env dumps, and
hidden reasoning are never indexed. Entries bind namespace, pageId,
contentHash, kind, files, symbols, entities, tags, and source
identity. The index is an in-memory derived object with a canonical
serialization (same pages -> byte-identical logical index); no second
evidence database exists and no persisted artifact outranks canonical
page/store state. Stale entries (missing page, contentHash divergence,
tamper breaking the builtFromDigest) fail closed with
retrieval-index-stale and never become evidence. Index describe output
carries ids and hash prefixes only; secret safety follows the frozen
B01 redaction pipeline (traces/describes never carry evidence text).

### 34.11 Safety invariants (frozen)

Retrieval is read-only (no checkpoint/page/tier/EvidenceRef/advisory/
repository/session/history mutation, no usage counters; proven by
store byte-snapshot equality across retrieval in both modes).
Provenance is preserved verbatim; ranking never promotes trust.
Indexed shouting (ALWAYS RANK ME FIRST) earns zero score advantage
beyond literal token matching. No embeddings, vector DB, ANN/HNSW,
cosine similarity, learned rerankers, LLM relevance, DecisionProvider/
JEV/Laya, confidence, token-budget packing, or compression/summary
span-extraction exists in either C03 module (source scan gates this).
The C02 compiler handoff is a narrow adapter
(c02CandidatesToRetrievalRequestV2: candidate identities to an
identity-only exact-page request); C02 itself is untouched, and no
packed ContextView is produced here.

### 34.12 Suites (frozen)

New suites tests/ContextRetrieverV2.Tests.cjs (126 assertions) and
tests/ContextRetrieverV2XProc.Tests.cjs (+ worker, 9 assertions),
registered after ContextCompilerV2H. Fixtures cover index derivation
and order-independence, exact EvidenceRef (identity + materialized
B03-verified bytes), exact pageId, missing/corrupt/wrong-namespace
exact failures with no substitution, file routes (exact path,
path+hash revision selection, old/new hash non-aliasing, wrong
repository, traversal/absolute/empty-segment/backslash rejection,
cross-directory non-matching), symbol routes (unique, ambiguous,
file disambiguation, case policy, unknown, foreign repo), lexical
routes (phrase, multi-token, tag, entity, extract, gloss-only, zero
match, tie-break, no synonym expansion, frozen normalization),
route-priority ordering, duplicate merging to the strongest route,
limit semantics (8 exact + limit 3), candidate restriction, cross-task
and cross-repository isolation, injection inertness, trust
preservation, secret-safe traces/describes, stale-index and
missing-page fail-closed, read-only store snapshots, in-process
repeat determinism, closed-world request rejection, the C02 handoff
seam, the no-embeddings/reranker/packing/compression source scan, and
a deterministic quality baseline (exact-ref/file/symbol hit rates and
lexical recall@6, all 1.000 on the fixture; cross-task leaks 0).
XProc proves two simultaneous independent processes return
byte-identical retrieval results and agree with in-process retrieval.
Phase A, B01, B02(+H), B03(+H), B04(+H), C01(+XProc), C02(+H+XProc)
regressions remain green (see task report).

### 34.13 C03H Unicode lexical retrieval hardening (frozen)

C03H closes one retrieval-correctness defect without reopening any
frozen section: the C03 lexical tokenizer split on ASCII-only
[^a-z0-9], silently discarding every non-ASCII letter and number
(Bulgarian/Greek/CJK evidence tokenized to zero tokens; café
fragmented to caf; Straße fragmented to stra + e). Exact EvidenceRef /
Page-ID / file / symbol routes, B03 rehydration, route priority,
scoring weights, and all upstream semantics are unchanged.

Frozen Unicode normalization (unicode-lexical-v1): NFKC, then
locale-independent String.prototype.toLowerCase (never
toLocaleLowerCase, never Intl, never locale segmentation), then
maximal [\p{L}\p{N}]+ runs with the u flag (Unicode letters plus
Unicode decimal/numeric characters, including ASCII). Different
scripts stay different tokens: no transliteration (грешка never
becomes greshka), no translation, no synonyms, no stemming, no
diacritic stripping (café != cafe, frozen). Identifier policy is
frozen: '_' and '$' (and all punctuation/symbols/emoji/controls)
split tokens, so get_user -> get + user and $user -> user; exact
symbol identity remains a separate byte-exact case-sensitive route
never derived from lexical tokens. Case folding is ECMAScript
default mapping, not linguistic: ß stays ß (frozen token [straße]);
U+0130 İ folds to i + combining dot (token [i]); Σ/σ/ς fold to
σ/σ/ς (final sigma ς preserved). Punctuation/emoji-only input
tokenizes to zero tokens: explicit zero lexical match, never an
exception. Length bound unit is frozen as Unicode code points
(Array.from length, cap 64), so surrogate pairs are never split or
corrupted (40 astral letters kept, 65 dropped). Phrase matching reuses
the same NFKC + case-folded text, so Unicode phrases (грешка при
вход) behave deterministically with the frozen phrase bonus.
Token-gated scoring is unchanged: a contiguous substring that is not
a token (e.g. user inside userId, 日本語 inside a longer CJK run)
does not score; CJK segmentation stays coarse by design (no
language-specific segmenter; literal Unicode runs are preserved and
retrievable on run equality). Prompt-injection and secret-safety
posture is unchanged (Unicode shouting earns zero advantage;
traces/describes carry no evidence text in any script).

Index identity: the derived index now carries lexicalRevision
(unicode-lexical-v1) bound into builtFromDigest and indexId, so an
ASCII-token index and a Unicode-token index over identical pages have
different identities; pre-revision indexes fail validation
(context-evidence-index-revision-mismatch). No durable task-truth
migration exists because the index is derived/rebuildable/
non-authoritative.

Permission-domain boundary (documentation clarification, no new
system): the frozen namespace model is exactly six keys (taskId,
taskInstanceId, sessionId, workspaceId, repositoryId, checkoutId);
no independent permissionDomain field exists in B01/C03, and none is
invented here. The enforced boundary is full six-key namespace
equality before ranking for pages, index, and exact B03/store reads;
no broader cross-domain retrieval is permitted, and any hypothetical
frozen permission field would be enforced pre-ranking (none is
currently ignored).

Suites: new tests/ContextRetrieverV2H.Tests.cjs (99 assertions)
covering the normalization audit matrix, Bulgarian hits/no-match,
German ß, accented Latin (whole tokens, café != cafe frozen),
Greek, CJK (exact-run retrieval, coarse-sub-run documented
no-match), mixed identifiers, numerics (including Arabic-Indic
٢٠٢٦), Unicode phrase matching, empty-token and code-point bounds,
no-transliteration, no-translation, unchanged weights/priority,
Unicode injection inertness, Unicode secret safety, revision
identity, and the permission-boundary assertion; XProc now carries
Bulgarian/accented-Latin/Greek/CJK/mixed fixtures with
byte-identical cross-process results. C03 (126), C03 XProc, and all
Phase-A/B/C01/C02 regressions remain green (see task report).
## 35. C04 Budgeted Packing (Phase C)

C04 freezes deterministic token-budget accounting and packing for the
already-safe Context Compiler working set. Production authorities:
config/ContextBudgetAllocatorV2.cjs (packing) plus the narrow counter
contract config/ContextTokenCounterV2.cjs. No Phase-A/B/C01/C02/C03
source file was modified (additive-only); no shortening, no
re-representation, no similarity search, no scoring, no DECIDE, no
prompt rendering exists anywhere in C04.

### 35.1 Authority boundary (frozen)

C02 decides what is structurally eligible. C03 decides which exact
evidence is retrievable/relevant. C04 decides which already-safe
material fits (here). C05 will own representation reduction, C06
cache-aware layout. Packing never changes truth: it chooses
materialized vs reference/omitted view membership only. Tier,
requirement status, verification truth, provenance, retrieval route,
and durable evidence are untouched. Deleting every plan and packed
view loses zero durable task truth. C04 performs no lexical/file/
symbol search, no store reads, no session/repository access, and no
rehydration: it consumes supplied C03 results as already-materialized
view membership. If material is missing, C04 discovers no
replacements.

### 35.2 Token-counter authority (frozen)

A budget claim requires an explicit counting authority. C04 never
divides characters, multiplies words, reads model names, or consults
historical averages, and the core hard-codes no provider or model
family. Contract: { tokenizerFingerprint: string,
countText(text: string): number }. The same text under the same
fingerprint must return the same non-negative integer; negative, NaN,
Infinity, fractional, or disagreeing counts fail closed, as do
counter exceptions (no heuristic fallback, ever). Ordinary caller
metadata (tokenCount fields, prior used values) is never authoritative
and never silently accepted: unknown budget keys fail closed, and
every packed count is computed in-operation through the validated
counter, verified twice per unique text, bound to (materialId,
contentHash). No persistent count cache exists in C04; per-operation
memoization is performance-only and keyed by exact material identity,
so changed text/contentHash always recounts. Without a valid counter,
packing fails closed with context-budget-tokenizer-unavailable; C04
cannot certify the packed view and does not guess.

### 35.3 Tokenizer fingerprint (frozen)

Every packed result binds tokenizerFingerprint. Changing the
tokenizer means a different packing authority/result identity: plan
validation under a foreign fingerprint fails closed with
context-budget-fingerprint-mismatch. Counters carrying closures are
never serialized; cross-process packing rebuilds the authority from
its fingerprint string only (deterministic test adapter
test-codepoint-v1, one token per Unicode code point, TEST ONLY and
never a model tokenizer or production fallback). No real-model
hard-budget safety may be claimed until a runtime supplies a counter
matching that model's tokenization contract (C08 boundary).

### 35.4 Usable budget (frozen)

C04 consumes an already-derived usable input budget { hardMax, target }
with 0 <= target <= hardMax. hardMax is the absolute correctness
boundary; target is the preferred packed size. Upstream owns usable
budget derivation (contextWindow - reservedOutput -
fixedRuntimeReserve - toolProtocolReserve - safetyMargin); C04 never
derives model limits from model names and never treats a provider
advertised window as hardMax. Provider/system/tool framing overhead is
owned upstream of hardMax: C04 measures logical model-facing text
only and claims no final wire-level provider token use.

### 35.5 Mandatory survival (frozen)

Every C01 mandatory entry (PINNED authoritative state, mandatory HOT
current user, other mandatory manifest entries) is kept before any
optional packing; mandatoryUsed is the exact sum of mandatory token
costs. mandatoryUsed > hardMax fails closed with
compiler-mandatory-over-budget and emits no view: mandatory truth is
never shortened, omitted, or converted to a reference, and C05 is
never invoked to rescue it. mandatoryUsed == hardMax is valid with
mandatory material only. target < mandatoryUsed <= hardMax is valid
with optional material omitted/referenced and used == mandatoryUsed;
packing never fails merely because mandatory exceeds target.

### 35.6 Target vs hardMax (frozen)

Optional packing stops at the requested target and never causes
target overflow: an optional entry is kept only while the running
total stays within target, so target overflow is legal ONLY because
of mandatory material (plan validation proves used <= max(target,
mandatoryUsed) and no non-mandatory KEEP carries tokens while used
exceeds target). Non-mandatory HOT may not overflow target:
correctness material that may exceed target means mandatory
material. Requested-target honesty (C04H): the plan and the packed
view carry the caller-requested target even when used > target; hardMax
is never adjusted and no derived target value is ever called target.
58k of meaningful deterministic context stays preferable to 60k filled
with noise: correctness outranks utilization.

### 35.7 Packing priority (frozen)

Classes: 0 mandatory correctness (every mandatory entry, any tier) >
1 non-mandatory HOT > 2 selected WARM > 3 exact materialized COLD.
No model scoring, no per-token value arithmetic, no retrieval
reranking: within a class the deterministic C02/C03 view order is
reused verbatim with the view order index as the frozen tie-break.
Greedy baseline as context-budget-packer-v1: keep all mandatory, walk
optional entries in (class, view-order) sequence, keep a whole entry
when it fits the requested target, otherwise leave it unmaterialized.
Within one class a blocked entry is skipped and the class continues
(whole-entry first-fit); once any entry of class N is blocked, every
lower class is gated with packing-blocked-by-higher-priority, so
lower-priority evidence never fills budget while higher-priority
material waits. Each materialized entry is atomic: KEEP the exact
entry or leave it unmaterialized (REFERENCE/OMIT); truncation,
slicing, rewriting, and re-representation belong to C05.

### 35.8 COLD and WARM behavior (frozen)

Materialized COLD that fits stays materialized; COLD that does not
fit falls back to referencedColdPages with pageId, contentHash,
EvidenceRef identity where available, exact resolution route
(B03-mode-bound), and provenance preserved (model-view decision only;
no evidence is deleted). Dropped COLD that cannot form a valid COLD
reference stays observable as OMIT. Dropped WARM is never deleted
from durable task memory; it records REFERENCE/SKIP-from-view as the
frozen representation allows, otherwise an observable OMIT in the
plan (no identity-only WARM reference representation exists in C01).
Referenced-only COLD identity metadata is NOT counted as evidence
text: the plan records referenceMetadataCount separately and C04
never labels it as provider cost.

### 35.9 Plan, cost, and view contracts (frozen)

ContextTokenCostV2 exact keys: sourceId, materialId, tier, mandatory,
tokens, tokenizerFingerprint, contentHash (bound to the live entry's
exact bytes). ContextPackingPlanV2 exact keys: schemaVersion (1),
tokenizerFingerprint, packingPolicyRevision, compilerPolicyRevision,
hardMax, target (caller-requested preferred target, never rewritten),
mandatoryUsed, optionalUsed, used, referenceMetadataCount,
keptMaterialIds, referencedPageIds, omittedMaterialIds, decisions,
deterministic (true), planDigest (sha256 over
nexus/context-packing-plan/v1 LF canonical JSON without the digest).
Decision exact keys: materialId, tier, mandatory,
action (KEEP/REFERENCE/OMIT), tokens, reasonCode (frozen
packing-* vocabulary), deterministic (true). Plan validation proves
digest agreement, binding agreement, and arithmetic
(mandatory + optional = used, used <= hardMax,
used <= max(target, mandatoryUsed), overflow only from mandatory). The trace explains ephemeral view decisions only: it
cannot change tier, requirement status, verification truth, or delete
evidence. C04 outputs a new C01-valid view with tokenBudget.used =
exact packed logical-token count; C01 remains the final structural
gate (fresh viewId/viewDigest via the frozen derivation), C02 keeps
emitting used:null, and C03 route/score/provenance/identity pass
through byte-identical.

### 35.10 Safety invariants (frozen)

Exact Unicode exactText reaches the counter byte-for-byte (no case
folding, transliteration, or normalization; retrieval normalization
never leaks into accounting); raw binary never reaches accounting
(C01 rejects it first). Evidence prose (KEEP ME / I AM MANDATORY /
PRIORITY=MAX) cannot influence packing: only typed mandatory, tier,
frozen order, and token cost govern. Diagnostics carry ids, tiers,
counts, reason codes, hash prefixes, and totals only. Packing is
read-only over checkpoint/pages/store/decisions/results/history and
deterministic across calls, restarts, and processes (byte-identical
plan/view proven cross-process). Namespace is preserved; provenance
is never upgraded.

### 35.11 Suites (frozen)

New suites tests/ContextBudgetAllocatorV2.Tests.cjs (181 assertions)
and tests/ContextBudgetAllocatorV2XProc.Tests.cjs (+ worker, 27
assertions), registered after ContextRetrieverV2H. Fixtures compile
through the REAL C02 compiler (inline pages incl. Bulgarian/Greek/
CJK/emoji Unicode and injection prose, tool transactions as plain
data); the counter is the REAL contract with the deterministic
reference adapter. Coverage: counter contract, usable-budget shape,
priority classes, exact cost binding + stale recount, happy-path
packing, mandatory overflow/at-limit/above-target/zero-target,
optional exact-fit/plus-one, within-class first-fit, cross-class
gating, HOT>WARM>COLD priority, COLD fallback binding for every
dropped identity, atomicity, injection inertness incl. benign-twin
order equality, fingerprint/budget/tamper rejection, flaky/throwing/
malformed counters, Unicode byte-exact accounting, binary rejection
before accounting, secret safety, trust preservation, plan/view
agreement across four pack shapes, target sweep invariants,
determinism, C01-compat, C02/C03 seam absence, no-retrieval and
no-shortening source scans, metrics arithmetic, and simultaneous +
restart-fresh XProc byte identity with fail-closed unknown
fingerprints. Phase A, B01, B02(+H), B03(+H), B04(+H), C01(+XProc),
C02(+H+XProc), C03(+H+XProc) regressions remain green (see task
report). Next: CCV2-C05 (Compression Ladder) - not begun here.

### 35.12 C04H target/hardMax correction (frozen)

C04 exposed that C01's original used<=target structural invariant
incorrectly conflated preferred target with absolute limit: honest
mandatory overflow (target < mandatoryUsed <= hardMax) could not be
represented without rewriting target to max(target, mandatoryUsed),
a semantic masking C04H removes. Minimal corrections, nothing else:

C01 validates 0 <= target <= hardMax and, when known,
0 <= used <= hardMax; used:null stays valid pre-C04. Membership,
mandatory manifest, tier, provenance, identity, digest, disposable,
trace, and external-COLD proof semantics are unchanged.

C04 packs KEEP-all-mandatory then optional-only-within-requested-target
(optional capacity zero once mandatoryUsed reaches target),
independently requiring mandatoryUsed <= hardMax
(compiler-mandatory-over-budget otherwise). The plan carries one
authoritative requested target (no effectiveTarget field); validation
enforces used = mandatoryUsed + optionalUsed, used <= hardMax, and
used <= max(target, mandatoryUsed), so exactly two legal cases exist:
mandatoryUsed <= target with used <= target, or mandatoryUsed > target
with optionalUsed = 0 and used = mandatoryUsed. Metrics use the real
requested target (utilization may honestly exceed 1.0) with
mandatoryTargetOverflowTokens = max(0, mandatoryUsed - target) exposed
separately. Policy revision stays context-budget-packer-v1: this is a
pre-freeze schema correction (same greedy selection, honest carriage),
not a new algorithm.

New suite tests/ContextBudgetAllocatorV2H.Tests.cjs (33 assertions):
honest overflow, zero target, optional-overflow sweep, mandatory
limits, literal forged/legitimate plan vectors (target=100,
hardMax=150), digest-bound target, and metrics honesty; C01 suite
gains honest-overflow structural vectors (100/120/150 valid,
used>hardMax/target>hardMax/negative invalid, null valid).




