# Context Compaction V1 - Controller-Owned Checkpointing plus Threshold-Gated Reset

## 1. Problem

Real Nexus/Muse engineering sessions accumulate hundreds of thousands of
effective input tokens. The old transcript, tool results, intermediate
exploration, and repeated repository reads are re-processed on every later
root model call even after the logical task that produced them is complete.
V1 stops carrying the full raw execution transcript forever: after a
sufficiently large task is authoritatively COMPLETE, Nexus preserves durable
controller state, a compact structured checkpoint, and a small continuity
tail, while dropping the old raw execution history from MODEL-FACING context.
The user-visible transcript stays intact (append-only log; see section 7).

This is NOT a memory system, NOT semantic classification, NOT summarization
(no LLM call exists anywhere in V1), and NOT permission to delete history.

## 2. Ownership (one authority per decision)

- Task lifecycle: TaskController.ps1 ONLY. ContextCompaction never mutates
  task status and never overrides routing.
- Completion signal: Test-AihTaskCompletion (deterministic controller gate:
  evidence.json plus acceptance criteria plus verification PASS plus review
  disposition plus requirements plus visual gates). The bridge reads it in
  runCompletionTail; nothing else may declare COMPLETE.
- Context-lifecycle decisions: scripts/ContextLifecycle.ps1 (threshold,
  pressure, checkpoint, state machine, telemetry) surfaced through
  scripts/ContextLifecycleCli.ps1. The bridge (config/AihController.cjs)
  only orchestrates CLI calls plus one session append.
- Root pressure signal: DSH assistant/chunk usage events
  (engineeringUsageOfEvent): effectiveInputTokens =
  uncachedInputTokens + cacheReadTokens. Filtered by
  config/ContextCompaction.cjs rootUsageCandidateOf.
- Routing/model selection: unchanged (Routing.ps1 plus isolation layers).
  The checkpoint carries a routingProvenance disclaimer and no target.
- Muse reasoning: untouched (no governor changes).

## 3. Authoritative completion source

A task is eligible ONLY after Test-AihTaskCompletion returns complete for
that exact taskInstanceId (taskId alone is insufficient; a restored workspace
may re-allocate a display id). Active, ready, failed, verifying, or
review-gated tasks evaluate to keep. Unprovable completion keeps old context.

## 4. Authoritative usage source

Per root engineering call: effectiveInputTokens = uncachedInputTokens +
cacheReadTokens from the DSH usage chunk. Tracked per task generation in
.ai-harness/runs/<TASK>/context-pressure.json: latest and peak effective
input, cumulative uncached/cache-read/output, rootModelCallCount, split by
engine (muse/dual) and role (muse_main/engineer_normal/engineer_deep).
Step-id replay is idempotent. Reviewer (rejected at the recorder boundary),
visual-review (no recorder role), worker/subagent (unbound sessions plus
isWorkerSession filter), and ambiguous usage never enter the metric. No cost
is inferred. The LATEST context-bearing root call is the primary pressure
signal: it represents what the next call would re-process without compaction.

## 5. Threshold

One authority: $AihContextCompactionThresholdTokens = 120000 in
scripts/ContextLifecycle.ps1 (Get-AihContextLifecycleThreshold; invalid
configuration throws). A controller-complete task MAY become eligible when
latest root effective input >= 120000. No magic numbers elsewhere.

## 6. State machine

inactive -> eligible -> checkpoint-ready -> applied, plus blocked.
Transitions are explicit, persisted in context-lifecycle.json, and idempotent
(repeated eligible/checkpoint-ready/applied return the same state; applied
never rolls back). checkpoint-ready and applied require a validated
checkpoint for the same taskInstanceId. Any failure before applied keeps the
original context; crash/restart is safe (eligible and checkpoint-ready reload
deterministically).

## 7. Supported model-context seam (exact)

DSH session surface projection (packages dsh-session plus dsh-compaction in
the pinned host):

- session.append('user/message', message, { surfaceOp: { op: 'replace',
  start, end }, sourceEventSeqs }) replaces one surface span with a single
  node. deriveMessages() (the model-facing projection) then renders the
  checkpoint plus the retained tail; the raw append-only log keeps every
  event, so replay stays deterministic and the user transcript (rendered from
  append-origin events) is untouched.
- Nexus provenance is its own (source kind plugin / aih-controller / form
  context-checkpoint), NOT the DSH compact-checkpoint marker, so the host
  compaction invariant and backend lock never interact with controller
  checkpoints; no compaction/* events are emitted and no history is deleted.
- The cut is tool-pairing balanced (balancedRetainCut mirrors the DSH
  boundary rule: no unanswered tool call crosses the cut) and keeps a bounded
  tail (default 6 nodes / 6000 chars).
- Applied on the next agent/pre-step after completion, revalidating
  eligibility plus checkpoint provenance immediately before the append.

## 8. Checkpoint schema (context-checkpoint.json, schemaVersion 1)

Identity: schemaVersion, taskId, taskInstanceId (plus checkpointOf),
workspace executionRoot, engine, executionClass. Task: redacted description,
acceptance criteria, authoritative status, created/completed timestamps.
Execution: attempt count plus timeline, risk, review request, completion
authority. Repository state: base commit, HEAD, worktree clean flag, changed
files with staged/unstaged flags (capped at 200, NO diffs). Verification:
structured outcomes plus acceptance evidence (cross-generation evidence is
excluded, never merged). Routing provenance: disclaimer only, no target.
Pressure snapshot. Continuity: bounded final user request plus assistant
report (historical context, not truth; no tool transcripts, no shell output,
no reasoning). Hard size bound: 64 KiB serialized, else refused (KEEP).

## 9. Context projection after compaction

Next root request receives: normal system/persona/instructions, authoritative
controller/task/routing state, the compact checkpoint, the small retained
tail, the new user request, and normal repository/tool access. It no longer
receives the shadowed tool outputs, repeated reads, failed hypotheses, and
shell logs. The repository stays the source of truth for code detail.

## 10. Failure semantics (KEEP everywhere)

Unprovable completion, ambiguous usage, malformed checkpoint, write failure,
instance mismatch, repository mismatch, missing append seam, unbalanced cut,
empty surface, crash before apply: all keep the old context and let the
session continue. No half-compacted state exists (the replace either lands
atomically in the log or nothing changes). All lifecycle writes are atomic
(Write-AihAtomicJson).

## 11. Security and privacy

Checkpoints are redacted (ConvertTo-AihContextRedactedText, mirroring the
controller diagnostic redactor): bearer tokens, sk-/api-key shapes, codex and
github token shapes, password/secret/authorization assignments, and sensitive
JSON fields become <redacted>; texts are bounded. Never persisted: env dumps,
raw provider requests, massive shell output, hidden reasoning.

## 12. Telemetry (context-compaction-telemetry.json)

sessionId, taskId, taskInstanceId, engine, thresholdTokens,
latest/peakEffectiveInputTokens, cumulative uncached/cache-read/output,
rootModelCallCount, eligibilityDecision plus reason, checkpoint path/size,
checkpointApplied, appliedAtUtc, blockedReason. After apply, the first root
call records postCompactionEffectiveInputTokens and the diagnostic
firstCallTokenReduction = pre - post (a token-processing comparison, NOT
monetary savings). Never fabricated when the usage signal is unavailable.

## 13. Non-goals (explicit)

No scope governor, no semantic classifier, no summarization LLM, no
embeddings/vector stores, no continuation model, no cross-project or
long-term memory, no dynamic thresholds, no cost estimation, no history
deletion, no active-task compression, no subagent/reviewer/visual compaction,
no provider switching, no reasoning changes, no new fallback model, no
artifact cleanup.

## 14. Known limitations

- One checkpoint generation per task; a session that keeps working after
  completion accumulates pressure on the completed generation (eligibility
  was already decided; no re-compaction loop in V1).
- Post-completion usage on the same binding is recorded but cannot trigger a
  second compaction (applied never rolls back).
- Replay without a step id counts twice (bounded, same as the existing
  engineering usage path); replay with a step id is idempotent.
- Windows live acceptance is a follow-up gate; deterministic PS tests plus
  the Linux live projection proof ship in V1.

## 15. Future V2 directions (not implemented)

Task-scope classification, semantic continuation detection, adaptive
thresholds, multi-checkpoint lifecycle, smarter retention. None of this is in
V1.

