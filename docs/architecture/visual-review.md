# Visual Review (Phase V0/V1)

Nexus Visual Review is a **model-agnostic, read-only visual verification
capability**: a controller-owned service that sends screenshots to a
vision-capable model and returns a validated, structured design critique.

Phase V0/V1 scope is deliberately narrow:

- **manual invocation only** (`/visual-review`, `aih-visual-review`)
- one visual packet → **one transport call** → validated critique → persisted artifacts
- **no** automatic visual-task detection, repair loops, baselines,
  multi-platform runtimes, human-acceptance automation, or visual completion
  blocking (later phases)

---

## The four identities (must never be conflated)

    MODEL != ROLE != EXECUTION CLASS != PROVIDER

| Identity | Lives in | Owner of the decision | Visual Review mapping |
| --- | --- | --- | --- |
| **MODEL** | `config/model-registry.json` | configuration, never routing code | `deepseek-v4-flash-vision-exp` (`supportsVision: true`, `readOnlyDefault: true`) |
| **ROLE** | the active Engineering Profile (`config/engineering-profiles.json`) | profile binding, validated by capability rules | the optional `visualReviewer` role |
| **EXECUTION CLASS** | `config/routing-policy.json` executionClasses | the deterministic router (`Routing.ps1`) | **none — visual review is not an execution class** |
| **PROVIDER** | `data/settings.yaml` (`llm-pi-ai.providers`) | configuration, referenced by registry id | `deepseek-vision-direct` (OpenAI-compatible, `DEEPSEEK_API_KEY`) |

Routing/controller code never branches on a vendor. The visual model is just
another vendor-neutral registry entry that *declares* capabilities; the
capability rules (PowerShell `Routing.ps1` + shared JS `config/Engineering-Profiles.cjs`
+ UI mirror `ui/nexus-controller/lib/engineering.cjs`) enforce them.

### CAPABILITY is a fifth identity

    MODEL != ROLE != EXECUTION CLASS != PROVIDER != CAPABILITY

Visual Review is a **capability**, never an execution class. Telemetry records
therefore always preserve the task's **real** routing `executionClass` and
represent a visual review as orthogonal fields:

    executionClass: <actual controller execution class>   # never 'visual-review'
    capability: "visual-review"
    role: "visualReviewer"

The telemetry writer (`scripts/Telemetry.ps1`) accepts optional
`-Capability` / `-Role` parameters for exactly this purpose and defaults
`executionClass` to the task record's own class.

## Visual Review != Independent Code Review

The existing **reviewer** role stays exactly what it was: the bounded,
independent *code* reviewer with its own transport requirements
(`requiresSolLocal: true`, provider `sol-local`, Codex/OAuth adapter,
review packets, budgets, telemetry contract). Nothing about
`engineer_normal`, `engineer_deep`, `reviewer`, `solver`, or the
deterministic class changed.

Visual review is an **orthogonal verification capability**, not a new
engineering execution class and not a repurposed reviewer:

| | Independent Code Review (`reviewer`) | Visual Review (`visualReviewer`) |
| --- | --- | --- |
| Subject | source, diffs, invariants | screenshots, layout/design |
| Transport | local Codex/OAuth adapter (`sol-local`) | generic OpenAI-compatible multimodal HTTP |
| Invocation | automatic (policy/routing) + `/review` | **manual only** (`/visual-review`) in V1 |
| Output | verdict pass/fail/uncertain + findings | verdict PASS/REVISE/BLOCK + 9 dimensions + design findings |
| Writes | none (read-only) | none (read-only) |
| Completion authority | never | never |

---

## Architecture

### Source of truth and ownership

- **Model capabilities** — `config/model-registry.json`. A vision-capable
  model is one whose entry explicitly declares `supportsVision: true`. A
  missing declaration is *never* treated as vision-capable.
- **Role requirements** — `scripts/Routing.ps1` (`Get-AihRoleRequirements`) is
  the controller-plane authority; `config/Engineering-Profiles.cjs` and the UI
  mirror it in lockstep (tests keep them aligned).
- **Role bindings** — the active Engineering Profile. `visualReviewer` is an
  **optional** role: both built-in profiles bind it to
  `deepseek-v4-flash-vision-exp / high`; legacy and operator-defined custom
  profiles may omit it, and every satisfiability check (`bindingsSatisfiable`,
  `Test-AihEngineeringProfileBindings`, editor `save-custom`) treats its
  absence as valid. When a binding *is* present it must satisfy the same
  capability rules.
- **The visual packet and result** — `.ai-harness/runs/<TASK-ID>/visual/iteration-XX/`
  in the engineering workspace (`packet.json`, `result.json`, screenshot
  copies; `transport-error.json` for diagnostics). The runs tree is
  git-ignored, so screenshots are never committed automatically.
- **Validation authority** — the controller service (`scripts/VisualReview.ps1`)
  is the *single* schema authority. The transport script parses the model
  text best-effort, but the controller plane re-parses and strictly
  validates every result.

### Dependency direction

    VisualReview.ps1 (controller plane)
      -> Common.ps1 / Routing.ps1 / TaskController.ps1 / Telemetry.ps1
      -> runtime node -> Invoke-VisualReview.mjs (transport only)
      -> provider (OpenAI-compatible chat-completions endpoint)

The transport depends on nothing in the controller plane; it receives a
request file and environment, and writes nothing. Capture-VisualEvidence.ps1
(`scripts/Capture-VisualEvidence.ps1`) is the only V1 evidence-capture runtime
(Android/ADB: `screencap` writes the PNG **on the device**, `adb pull`
transfers it to a deterministic host path — no binary data ever crosses a
PowerShell text pipe).

### The visualReviewer role contract

    writable: false · requiresTools: false · requiresSolLocal: false
    requiresReasoning: true · requiresVision: true

### Safety / authority (non-negotiable)

The visual reviewer **CAN**: inspect screenshots, compare them against
references, critique layout/design, produce structured findings.

The visual reviewer **CANNOT** and is structurally prevented from:

- editing code, proposing patches/diffs — the result contract is a **strict
  allowlist**; any additional key (a `patch`, `diff`, `edits`, …) fails the
  review closed with `visual-review-schema-invalid`
- using shell or tools — it is never mounted as a tool/subagent; the
  transport sends one text+image chat request and executes nothing
- writing repository files — the transport writes nothing; artifacts are
  persisted by the controller service only
- committing, altering task state, claiming human acceptance, or gaining
  completion authority — every packet/result/failure envelope carries
  `readOnly: true`, `completionAuthority: false`, `humanAcceptance: false`;
  the task ledger is never mutated by a visual review (telemetry only)

The deterministic controller remains the completion authority.

---

## Command surface

- `/visual-review <screenshot path(s)> [question]` — controller-owned in the
  same spirit as `/review` and `/verify`: the bridge decomposes the prompt
  deterministically (path-shaped tokens that resolve to files become evidence;
  non-existent path tokens are kept so the service fails closed with a
  structured `image path does not exist` error), then invokes
  `VisualReview.ps1 -Execute`. The turn is rejected (no engineering model
  call); the validated findings are posted back to the engineering session.
- `bin/aih-visual-review.cmd` — CLI equivalent (same controller service,
  `-TaskId` required).
- `scripts/Capture-VisualEvidence.ps1 -OutputPath <artifact>` — deterministic
  Android-only screenshot capture (device file + `adb pull`).

The visual model is **never** exposed as a normal writable subagent tool.

---

## Output contract

    verdict: PASS | REVISE | BLOCK
    score: 0-10
    dimensions: hierarchy · spacing · density · typography · alignment ·
                colorDiscipline · interactionClarity · brandFidelity ·
                platformQuality   (each 0-10, all required, no extras)
    findings[]: id · severity (blocker|high|medium|low) · category · area ·
                observation · whyItMatters · recommendation ·
                confidence (high|medium|low)
    strengths[]: string
    summary: string

Strict allowlists everywhere: extra top-level keys, extra dimensions, extra
finding keys, unknown severity/confidence values, non-numeric scores, and
malformed JSON all fail closed (`visual-review-schema-invalid`).

## Transport discipline (V1.1)

One visual-review invocation performs **at most two provider calls**: exactly
one retry, only for clearly transient transport failures —

- empty assistant content (observed once against the live provider)
- HTTP 429 / HTTP 5xx
- transport timeout
- malformed provider transport envelope (HTTP 200 without a usable response body)

Never retried: a valid PASS/REVISE/BLOCK result, any schema-valid result,
deterministic local validation failures (strict schema, missing/invalid
screenshot, capability rejection), and non-transient provider rejections
(HTTP 4xx). When a retry occurs the evidence of **both** attempts is persisted
as `transport-retry.json` in the iteration directory, and `result.json`
(`transport.attemptCount` / `transport.attempts`) plus every failure
diagnostic carry the full attempt list.

## Failure semantics (fail closed)

| Situation | errorKind | Transport called |
| --- | --- | --- |
| task/profile/role/provider unresolved | `visual-review-resolution-failed` / `visual-review-role-unbound` / `visual-review-target-unresolved` / `visual-review-provider-unresolved` | no |
| model lacks explicit `supportsVision` | `visual-review-not-vision-capable` | no |
| no/invalid screenshot, budget violation | `visual-review-packet-rejected` | no |
| API key missing | `visual-review-api-key-missing` | no |
| HTTP/provider failure, timeout (429/5xx/empty content/malformed envelope) | `visual-review-provider-error` / `visual-review-timeout` / `visual-review-transport-error` | once + one bounded transient retry (max 2 calls) |
| malformed model JSON | `visual-review-schema-invalid` | once — deterministic schema failures are never retried |
| schema violation (incl. forbidden patch keys) | `visual-review-schema-invalid` | once — deterministic schema failures are never retried |

Failures are structured JSON on stdout with exit code 3 (CLI) and are
surfaced as controller messages by the bridge. V1.1 adds exactly one bounded
retry for transient transport failures (see Transport discipline above).

### Retry ownership (hard invariant)

`Invoke-VisualReview.mjs` is the **only** retry owner: one logical visual-review
invocation performs at most **2 provider HTTP attempts** (the single bounded
transient retry above). The V2 controller never re-invokes the review service
after the transport has exhausted its bounded retry — a transport-exhausted
invocation (`visual-review-empty-content`, `visual-review-timeout`,
`visual-review-transport-error`, `visual-review-provider-response-shape`,
non-transient `visual-review-provider-error`) is terminal for that invocation:
the loop emits one structured failure, marks the visual status `unavailable`
with the reason, and does not burn the iteration. A later **explicit**
execution/resume may start a NEW logical invocation, which is a distinct
operation — never hidden retry multiplication.

### Telemetry terminology (per visual-review invocation)

    visualReviewInvocations      # 1 per logical invocation of the service
    providerTransportAttempts    # provider HTTP attempts the transport made (≤2)
    successfulStructuredReviews  # 1 only when a validated structured result exists

Failed invocations write telemetry with `successfulStructuredReviews: 0` and
`modelCalls: 0` — a successful review is never dressed up as a bare
`modelCalls` count.

## Testing

- `tests/VisualReview.Tests.ps1` — model registry vision capability, role
  resolution, non-vision rejection, editor exposure, missing screenshot,
  invalid image path, provider failure, malformed model JSON, forbidden
  output keys, result schema validation, packet/evidence persistence,
  deterministic iteration numbering, read-only invariant, no completion
  authority, task-state invariance, backward-compatible (custom) profiles,
  and unchanged reviewer behavior — all through the **mocked transport**
  (`-MockResponseFile`), fully deterministic.
- `tests/VisualReviewBridge.Tests.cjs` — command detection, deterministic
  request decomposition, JS capability plane, backward-compatible profile
  satisfiability, registry contract.

The real transport path (provider HTTP) is exercised only by the manual
smoke test; automated tests never reach the network.

## Phase V2 — automatic visual verification and repair loop

For significant UI work the controller runs the whole visual pipeline
**automatically** — the engineering session never types `/visual-review`:

    IMPLEMENT → deterministic verification → runtime capture → visual review
    → deterministic adjudication → controller verdict → repair handoff
    → re-verification → recapture → re-review → PASS | exhausted | unavailable

### Visual Requirement Detector (deterministic)

`scripts/VisualRequirement.ps1` classifies every task as
`none | recommended | required` from deterministic evidence only — never
LLM keyword guessing: task changed paths/extensions and diff content
classification, project type, skills, and project policy. Evidence is
persisted (`reasons[]`, `signals`) to `runs/<TASK>/visual/detection.json`.
A project `.ai-harness/visual-policy.json` overrides the generic rules
(OpenRank marks significant UI REQUIRED). A skill containing the marker
"Significant UI work remains UNVERIFIED until it has been inspected on an
emulator or device" elevates `recommended` to `required` when a visual
surface is touched.

### Visual state (first-class controller state)

`runs/<TASK>/visual/state.json` — separate from engineering attempt
identity:

    requirement · required · status pending|reviewing|revise|pass|exhausted|unavailable
    iteration (1-based) · maxIterations (3) · latestVerdict · latestScore
    humanAcceptance:false (never auto-set) · trigger · repairPending
    repairBaselineAttempt · lastVerificationAttempt · history[] · manualReviews[]
    visualPreflight (deterministic preflight result; see below)

The iteration counter advances **only** on a validated review — capture
failures, provider failures, and schema failures never burn budget. The
counter never exceeds 3; iteration 1 is a composition pass, iteration 2
refinement (previous screenshots + previous findings travel in the packet;
the reviewer classifies each as resolved|improved|unchanged|regressed|
not-applicable), iteration 3 polish/verify.

**Previous-finding coverage contract (hard, deterministic).** When a
previous result is packed, `previousReview` MUST contain exactly one
entry per previous finding id. Omissions and invented ids fail closed
(`visual-review-schema-invalid`, violation names the id); the request
text enumerates the ids explicitly, and without a previous result the
contract is not applied (manual reviews are unaffected). The loop
resolves the previous result to the structured `result.json` FILE inside
the iteration directory on both the loop and the service side.

### Visual Preflight != Visual Review (complementary capabilities)

Every automatic loop iteration runs two distinct gates in order:

**visualPreflight** — deterministic, geometry/token/pixel assertions only
(`Get-AihVisualPreflight` in `scripts/VisualLoop.ps1`; result persisted to
`preflight.json` and `state.visualPreflight`): PNG magic, IHDR geometry
(200–8192 px per side, truncated headers fail), pixel-variance sampling
(a near-uniform image fails), the capture budget, and a question/token
budget estimate. It makes **no provider call**, may PASS independently,
and a preflight PASS is **never** a visual-review PASS — a required visual
task must not become `VISUAL_REVIEW_PASS` from preflight alone. The
`-Action preflight` surface runs capture + preflight only (no reviewer
call, no iteration burn).

**visualReview** — the real multimodal gate: capability `visual-review`,
role `visualReviewer`, resolved strictly as role → engineering-profile
binding → model registry (`supportsVision: true`) → provider, and executed
by the same controller-owned `VisualReview.ps1` service the manual
`/visual-review` command uses. It returns the structured PASS/REVISE/BLOCK
result. Automatic V2 **never** searches primaryEngineer, deepEngineer,
reviewer, solver, fallback, or arbitrary delegation/workflow model
candidates for a vision model; if the visualReviewer cannot be invoked
(role unbound, target unresolved, not vision-capable, provider/key
unresolved, transport down, capture or preflight failure) the visual
status becomes `unavailable` with the recorded reason — the loop never
fabricates or infers a visual-review PASS.

### Automatic loop mechanics

- Normal GUI engineering completion enters the controller's automatic visual
  gate. The bridge first invokes `VisualLoop.ps1 -Action detect`; non-visual
  tasks return without verification or vision work. For a REQUIRED task the
  controller runs deterministic verification, then the completion tail invokes
  `VisualLoop.ps1 -Action iterate`. Explicit `/verify` remains supported and
  reaches the same completion tail.
- The bridge and `VisualLoop.ps1` share the standard UTF-8 `-PayloadFile`
  contract for workspace and task-instance identity. A standalone invocation
  with direct `-Workspace` arguments is not a substitute for this production
  integration seam.
- Runtime capture reuses `Capture-VisualEvidence.ps1` (viewport mode; one
  adb target); a capture failure sets status `unavailable` — never a
  fabricated PASS.
- Scenario contract: `.ai-harness/visual-scenarios.json`
  `{id, platform, captures:[{name, mode:'viewport'|'file'}]}`, max 5
  screenshots per iteration (budget raised 4→5); previous screenshots
  travel as references (max 4).
- The review service is invoked with `-Trigger automatic -VisualIteration N`;
  manual `/visual-review` stays `-Trigger manual` and its results never
  advance the automatic iteration (state.history is automatic-only;
  manualReviews records the operator run).
- **Re-verification gate**: after a repair handoff the loop fails closed
  (`visual-review-reverification-required`) until a FRESH deterministic
  verification with a newer evidence attempt exists — the ordering
  repair → /verify → capture → review is structural.

### Adjudication (the reviewer is advisory)

`Test-AihVisualFindingAdjudication` deterministically rejects or downgrades
findings that conflict with frozen project invariants (e.g. "add a 7th
strength row" vs exactly-6-groups), debug/emulator tooling (Expo dev-client
gear), invented elements, or out-of-scope semantics. Verdicts are
`accepted | partially-accepted | rejected` with a persisted reason
(`adjudication.json`).

### Controller verdict policy

BLOCK on reviewer BLOCK or any accepted blocker; REVISE on reviewer REVISE
or any accepted high finding; PASS only on reviewer PASS with no accepted
blocker/high findings. Conservative defaults; thresholds are policy-
overridable, no project-specific numbers are hard-coded.

### Repair handoff

On REVISE the loop posts a compact structured packet (HIGH/MEDIUM/IGNORED
sections with Actions) as a `controller-visual-repair` message. The visual
reviewer never edits files; repairs happen in the engineering session.

### Convergence

- reviewer/controller PASS → visual status `pass` → completion allowed with
  `VISUAL_REVIEW_PASS · HUMAN_REVIEW_PENDING` in the controller message.
  Human acceptance stays external (V3); nothing is committed automatically.
- 3 iterations without PASS → `exhausted`; capture/provider failure →
  `unavailable`. Both block completion via the completion gate
  (`Test-AihTaskCompletion` visual reason) and request operator attention.
- A verification failure exits the loop into normal engineering failure
  semantics.

### V2 automatic-bridge regression fixed

The original V2 bridge called `VisualLoop.ps1` through the controller payload
transport, but the script neither accepted `-PayloadFile` nor decoded the
workspace/task-instance fields. Production automatic calls therefore failed
during PowerShell parameter binding, while direct standalone tests passed.
The bridge then swallowed that launch failure and could proceed without a
visual state. The corrected path shares the payload contract, automatically
starts from a successful required-UI engineering turn, and persists
`unavailable` when a required visual state exists but controller invocation
fails. No skill catalog participates in detection, routing, or invocation.

### Structured output (V1.1 hardening)

The transport requests provider-level constrained output
(`response_format: {"type":"json_object"}`) and the system/user prompt
explicitly require a single JSON object. A request may pass an explicit
responseFormat object (e.g. `json_schema` through a compatible API) that is
forwarded verbatim — no vendor-specific controller branching. Provider-level
constrained output does NOT replace Nexus validation:

    provider constrained structured output → JSON parse →
    Nexus strict allowlist/schema validation → accepted result

Prose, arrays, markdown-wrapped JSON prose, and schema-invalid objects all
fail closed; fenced JSON remains parseable as a tolerated secondary path.

### Observability and telemetry

Telemetry records `trigger`, `visualIteration`, `visualVerdict`,
`visualScore`, `acceptedFindings`, `rejectedFindings` while `executionClass`
stays the real task class. The Control Room task surface shows the visual
requirement/status/iteration/verdict/score/accepted/rejected/trigger and the
human-review-pending flag without overloading the routing badge.
