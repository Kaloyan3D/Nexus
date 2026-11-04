# ProjectHandoffV1 — future concept (DESIGN ONLY, not implemented)

Status: **design-only in A5.3.** No `project-design` intent type exists. The
broker rejects every intent type except `model-only`
(`unsupported-intent-type`). Arthur is not modified, no SDK exists, no
knowledge synchronization, device pairing, multi-agent engineering or
automatic implementation is introduced.

## Intended flow

```
Arthur collects/organizes ideas ─ user presses "Start Work" ─▶ Arthur's Rust backend
   builds a ProjectHandoffV1 ─▶ `nexus intent submit --intent -` (JSON on stdin)
   ─▶ nexus-broker ─▶ Controller ─▶ Registry ─▶ Kernel grant ─▶ model executor
   ◀─ architecture/roadmap result (`nexus intent result --json`) ─ Arthur displays it
```

Nexus designs; **implementation and autonomous coding need separate,
explicit authorization** and are out of scope for this contract.

## Proposed shape

A future `NexusIntentV1.intentType = "project-design"` would carry (as the
bounded `content` payload, or a dedicated typed field once the contract is
versioned) a `ProjectHandoffV1`:

| Field | Meaning |
|---|---|
| `schema` | `"arthur.project-handoff/v1"` |
| `project.id`, `project.version` | stable identity and monotonically increasing version |
| `project.title`, `description`, `goals[]` | what the project is for |
| `ideas[]`, `relations[]` | organized ideas (`id`, `text`) and typed links between them |
| `requirements.functional[]`, `requirements.nonFunctional[]` | stated requirements |
| `constraints[]`, `technicalPreferences[]` | hard limits vs. soft preferences |
| `decisions[]`, `openQuestions[]` | already-made decisions and what is still open |
| `provenance[]` | references to Arthur knowledge objects (`{kind, id, version}`) — references only, no sync |
| `deliverables[]` | requested outputs, e.g. `architecture`, `modules`, `dependencies`, `roadmap` |
| `payloadDigest` | sha-256 over the canonical JSON of everything above (immutable once sent) |
| `authorization` | `{ action: "start-work", userInitiated: true, at, projectVersion }` — explicit user consent bound to this exact version and digest |

## Rules a future implementation must keep

1. **Immutable payload.** Nexus recomputes `payloadDigest`; a mismatch is a rejection. The digest feeds the existing idempotency key so a re-sent identical handoff is the same run.
2. **Explicit Start Work.** `authorization.userInitiated` must be true and bound to `projectVersion` + `payloadDigest`; background or inferred handoffs are refused.
3. **Text-only first.** Design output is model text; no tool, file or process authority is granted by a handoff. Code generation is a *different* intent type behind its own approval path (A4.2-style human approval).
4. **Bounded.** Size limits like `model-only` (and an explicit output budget); cost remains an estimate unless the provider reports it.
5. **No ambient identity.** Arthur is identified by the OS peer credential like any other client (see the same-UID caveat in A5.3-EVIDENCE.md); `provenance[]` is data, not authorization.
6. **Results are untrusted text** to Arthur's UI as well.

## Calling convention (works today for `model-only`)

See `nexus-cli/examples/external_consumer.rs`: spawn `nexus --json intent submit --input - --wait --idempotency-key <stable>`
with the flattened document on stdin, then parse the `nexus.intent.cli/v1` envelope
(`run.state`, `run.taskId`, `run.attemptId`, `run.providerId`, `run.remoteModelId`, `text`,
`error.{code,class}`). Arthur never needs the issuer CLI, an issuer capability or a provider key.
