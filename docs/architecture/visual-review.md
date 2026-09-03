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
