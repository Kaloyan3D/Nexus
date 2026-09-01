# Engineering Mode Hardening (Phase 3.2.5)

Status: Phase 3.2.5 · Engineering Mode hardening — deterministic, task-local.

## Purpose

Phase 3.2.5 plus TASK-0016 changes Engineering Mode from a single task-level model decision
("Engineer Deep for the whole task") into a step/milestone-level, evidence-
driven engineering loop:

    task -> task/requirement compiler -> evidence collection -> working set v0
         -> Epistemic Action Policy (reuse/retrieve/probe/reason/execute/verify)
         -> planner -> routine execution (ENGINEER NORMAL)
             |  deterministic escalation reasons only
             +-> TEMPORARY DEEP ESCALATION (ENGINEER DEEP)
                   -> decision / hypothesis / plan ARTIFACT
                   -> explicit DE-ESCALATION
                   -> ENGINEER NORMAL
         -> structured tool execution -> failure classifier -> retry policy
         -> targeted verification -> requirement traceability -> completion

The independent reviewer stays a SEPARATE role and authority boundary: it is
never selected by, and never participates in, the engineering loop.

## Profile configuration vs controller semantics

The controller reasons ONLY in semantic execution roles:

    engineer_normal | engineer_deep | reviewer

The active Engineering Profile (config/engineering-profiles.json, resolved
through config/model-registry.json and the operator's
data/settings.yaml engineering-profile: key) binds each role to
provider/model/reasoning. Controller code never branches on a model id or
vendor. Current shipped configuration (PROFILE CONFIGURATION, not semantics):

    Engineer Normal -> GLM-5.3 Flash        (glm-5.3-flash, reasoning high)
    Engineer Deep   -> GLM-5.3 Flash MAX    (glm-5.3-flash, reasoning max)
    Reviewer        -> GPT-5.6 Sol          (gpt-5.6-sol,  reasoning medium)

A future profile can map the same roles to any other vendor without
controller changes. A stronger manual tier (e.g. GLM-5.3 MAX) may exist as an
operator-selected profile binding; it is never an automatic escalation target
in Phase 3.2.5.

## Modules (scripts/Engineering/, all deterministic, task-local)

- Shared.ps1        task/artifact identity guards, hashing, redaction, JSON.
- Requirements.ps1  Requirement Compiler (REQ-NNN, statuses, traceability).
- WorkingSet.ps1    Working Set v0 (compact current-state representation).
- StepRouting.ps1   step/milestone role selection, escalation signatures,
                    anti-oscillation, explicit de-escalation.
- Failures.ps1      failure classifier + stable signatures (task-local).
- RetryPolicy.ps1   two-strike retry discipline.
- EvidenceGate.ps1  evidence-before-architecture gate + decision artifacts.
- Execution.ps1     structured tool execution (run_command / run_powershell /
                    run_test records with classification).
- EpistemicPolicy.ps1 task-local uncertainty, deterministic action selection,
                    structured conflicts/probes, provenance, hypotheses.
- Verification.ps1  Verification Strategy v0 (scoped verification, reasons,
                    requirement links).
- Telemetry.ps1     per-task/per-role engineering metrics (never invents
                    missing provider metrics).

All state lives under the task's OWN run directory:

    <workspace>/.ai-harness/runs/<taskId>/
      requirements.json         Requirement Compiler state
      working-set.json          Working Set v0
      epistemic-state.json      uncertainty/evidence/hypothesis current state
      epistemic-actions.jsonl   selected/routed/completed actions and probes
      step-routing.jsonl        one record per engineering model step
      failures.json             normalized failure ledger (task-local)
      retry-log.jsonl           two-strike retry decisions
      decisions/DEC-NNNN.json   architecture decision artifacts
      verification-log.jsonl    verification plans + results
      tool-executions.jsonl     structured execution records
      engineering-metrics.json  aggregated telemetry

Every artifact carries the immutable taskInstanceId. Reading an artifact
whose taskInstanceId does not match the caller's expected instance treats it
as stale (never merged across generations), so a re-allocated display id can
never inherit another generation's engineering state.

## Authority order (Working Set)

1. current explicit user instruction
2. current working tree
3. deterministic compiler/code intelligence/repository facts
4. explicit human architecture decision
5. validated current task-local Working Set fact
6. LLM inference (never overrides source truth)

Invalidation: file content hash changes drop/flag affected facts; test
failures contradicting a fact clear it; a newer user instruction replaces the
objective; a recorded architecture decision supersedes the hypothesis it
answered. Stale facts are never silently kept.

## Step routing (default Normal, temporary Deep)

Routine work selects engineer_normal. engineer_deep is selected ONLY for a
deterministic escalation reason backed by task-local structured state
(escalation request with reason + question + evidence refs). Reasons:

    architecture-decision, conflicting-evidence,
    repeated-failure-new-hypothesis, security-sensitive, high-risk-refactor,
    migration-design, cross-system-contract, ambiguous-requirements,
    complex-debugging, provider-runtime-boundary,
    unknown-high-impact-behavior, incompatible-invariants,
    uncertain-persistence-semantics

Anti-oscillation: the escalation signature is
sha256(taskInstanceId + milestoneId + normalized question + hypothesisKey +
evidenceVersion). While a Deep escalation is open, the same signature cannot
escalate again; a materially new question/hypothesis/evidence state produces
a new signature and MAY escalate. Task length, prompt length, file counts,
and previous Deep calls are NEVER escalation signals.

De-escalation: recording the Deep artifact (decision/hypothesis/plan through
EvidenceGate.ps1) closes the open escalation; the next step is engineer_normal
again. Deep is a minority role by construction whenever work is routine.

## Epistemic Action Policy v0

The action policy answers a different question from StepRouting:

    Axis A: what operation best reduces decision-relevant uncertainty?
            reuse | retrieve | probe | reason | execute | verify

    Axis B: when model work is needed, which semantic engineering role?
            engineer_normal | engineer_deep

Fresh authoritative evidence selects REUSE (P0). Repository-answerable state
selects RETRIEVE (P1) through the existing ContextEngine/Working Set path. An
empirical or mixed question selects PROBE when a deterministic experiment is
safe, trivial/low cost, materially relevant, and has medium/high expected
information gain (P2). Non-observable judgment selects REASON; that action
still defaults to Engineer Normal and may reach Deep only through the existing
structured escalation gate. A justified implementation step selects EXECUTE.
Correctness evidence selects VERIFY and delegates to Verification Strategy v0.

The policy is deterministic over structured inputs. It does not run a model,
does not parse free-form model deliberation, and does not add an always-on
classifier call. The GUI bridge has a small conservative adapter that turns
the operator's current prompt into structured action-policy input; richer
callers use Engineering.ps1 uncertainty/action fields directly. The selected
action and reason are persisted before the engineering turn.

Only `safe` probes are eligible for automatic execution. `mutating`,
`external`, and `dangerous` risks remain recorded but are not auto-run. Probe
execution reuses Execution.ps1 rather than introducing a shell stack and
records probeId, operation, target, cost/risk, timestamps, exit status,
observed value, evidence hash, and whether the uncertainty was resolved.
Failed probes feed the existing failure classifier and never fabricate a
resolution.

Evidence conflicts are exact structured conflicts: current authoritative
observations sharing a normalized subject but carrying different normalized
value hashes set `evidenceConflict=true`. No value is silently overwritten.
A later authoritative probe can resolve the question, while every earlier
observation remains in `knownEvidence` for audit.

Hypothesis signatures include uncertainty id, normalized hypothesis, and the
Working Set evidence version. An identical hypothesis under unchanged evidence
is returned as duplicate/non-progress; new evidence permits reconsideration.
There is no correctness limit on the number of hypotheses. The existing
two-strike retry gate remains authoritative: a repeated failure is not unlocked
by merely claiming more investigation.

Deep is not sticky. A Deep artifact may identify a missing empirical fact and
close its escalation. The next `probe` action is explicitly routed to Engineer
Normal. If the observation resolves the decision, Deep does not resume. If
judgment remains, the changed evidence version can justify a new escalation
signature through the existing gate.

## Two-strike retry policy

Same normalized failure signature + same normalized hypothesis:
first occurrence allows ONE direct corrective retry; the second occurrence
blocks blind retry until an investigation is recorded plus a materially
changed hypothesis (normalized key differs) and a materially different
action. Whitespace/quoting/rewording does not change the hypothesis key.
Different signatures are independent. A second-strike complex failure is a
deterministic repeated-failure-new-hypothesis escalation candidate.

## Structured execution

Engineering.ps1 invoke-tool preserves {operation, executable, argv, cwd,
timeoutMs} (run_command), {script | scriptPath, argv, cwd, timeoutMs}
(run_powershell, transported as an encoded command — no nested shell
quoting chains), records exitCode/stdout/stderr/duration/timedOut, and
classifies every failure (executable-not-found, path-not-found, permission,
syntax-parse, patch-target-not-found, patch-ambiguous,
file-changed-since-read, timeout, test-failure, build-failure,
dependency-environment, provider-capacity, provider-response-shape,
controller-infrastructure, review-context-quality, unknown). Credentials are
never persisted (redaction applies to records).

## Verification Strategy v0

Deterministic scope heuristics only (no Test Impact Analysis):
local-change -> targeted relevant verification; milestone -> relevant
regression group; cross-cutting -> broader regression suite; final -> the
configured project/full harness verification. Every verification records
WHY it was selected and the requirementIds it evidences. Verification
results update requirement verificationStatus (IMPLEMENTED != VERIFIED).
Required unverified requirements block controller completion when the
policy engineering.completionRequiresVerifiedRequirements (shipped: true)
is active and a requirements.json exists for the task.

## Integration points

- scripts/Engineering.ps1: the single CLI surface (actions per module).
- config/AihController.cjs: engineering pre-steps first persist an epistemic
  action, then compose it with StepRouting and begin the attempt; `/verify`
  records VERIFY without fabricating a model call; turn completion closes the
  action lifecycle; failure records are classified.
- config/Engineering-Isolation.cjs: resolves the request model from
  profile(role(stepRole ?? executionClass)) — read-only enforcement.
- scripts/Routing.ps1 / Routing state: carries the stepRole alongside the
  durable task-level execution class (task-level classification remains for
  initial planning/UI metadata; it never permanently pins every step).
- scripts/TaskController.ps1: completion gate consults Requirement traceability.

## Phase boundaries (not in 3.2.5)

No Knowledge Graph, no Test Impact Analysis, no embeddings/vector search,
no semantic reranking, no persistent memory (the Working Set and Epistemic
Action Policy are NOT memory), no learned router, no historical task learning,
no provider-specific reasoning-text parsing, and no third automatic execution
tier. The policy is task-local orchestration, not Phase 3.3.
