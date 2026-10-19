# Registry → Native runtime integration: plan and first Nexus task

Status of the ground truth (verified in the repository, not assumed):
* The Model Registry (R1–R7, `config/registry/*`) is the **only** model authority and stays authoritative. It is **not** missing from the Native runtime: since A1.2/A2.3 the Native chain already consumes it. `native-issuer.cjs` compiles mode `engineering-v2` / role `muse_main` from the Registry, `native-target-v2.cjs` (note: *v2*; there is no `native-target.cjs`) issues the sealed `ExecutionTargetV2` extension (endpoint, billing, limits, credential **reference**), `native-intent-bridge.cjs` (`target-info`, `issue`) exposes it to the broker, which seals it into the Kernel before every provider request.
* What the Native runtime cannot do yet: **choose among Registry targets**. The broker's `intent-models` returns exactly one model (whatever the saved `engineering-v2` `main` slot resolves to: `meta/muse-spark-1.3-contributor-native` via route `opencode-go-native/muse`). The Registry holds 10 providers, 9 models, 11 routes, 10 connections (only `conn-opencode-go-native` is `connected`).
* Do **not** build another registry, copy catalog data into Native, or hand-write endpoints/limits in Rust.

Status: **checkpoint 1 is done and committed** (`567a6f0` Registry catalog + selection, `be08c2e` Rust contracts, broker refusal and tests). Checkpoint 2 is prepared below; checkpoints 3-4 are written only after the previous one is merged and green.

Checkpoints (each ends with verified code **and** tests before the next starts; each is one bounded Nexus task):

1. **Contract and adapter (read-only).** A Registry-derived catalog of native-issuable targets and an optional, validated *selection* for issuance. No UI, no provider call.
2. **Model resolution and execution binding.** A run (and a conversation) is bound to one resolved target; limits come from the target; per-connection credential references; the Kernel seal is unchanged.
3. **Desktop Registry integration.** Model picker and read-only status in the Desktop; selection travels as identities only.
4. **Real multi-model/provider acceptance.** Real runs on at least two Registry models/providers through the Desktop (needs a second connected provider and explicit authorization).

## Checkpoint 1 — acceptance criteria
* `config/registry/native-intent-bridge.cjs` gains a `catalog` command returning, for every enabled model×route×connection the Registry knows: `providerId, logicalModelId, remoteModelId, routeId, connectionId, connectionStatus, protocol, contextLimitTokens, outputLimitTokens, billingTier, dataUse, issuable, reason`. `issuable=false` always carries a machine reason (`connection-not-connected`, `protocol-unsupported`, `no-credential-ref`, `context-unknown`, …). It derives only from `service.getCatalog()` / the effective snapshot and `native-target-v2` rules; it never contains a secret, a credential value or a path.
* `target-info` and `issue` accept an optional selection `{logicalModelId, routeId}`. Without it behaviour is byte-identical to today (the saved `engineering-v2` slot). With it the issuance is compiled from the same trusted pipeline with the selected slot **in memory only** (the saved mode configuration is never written), role `muse_main`, mode `engineering-v2`; an unknown or non-issuable selection fails closed with the catalog's reason. The selection is bound into the digests so the Kernel seal proves what was issued.
* Rust: `nexus-client` gets typed `RegistryTarget` (serde, camelCase) and the broker's `intent-models` returns them (backward compatible: existing `AllowedModel` fields keep their meaning; extra fields optional). The default model is unchanged. A submit naming a model that is not issuable is refused before a run exists.
* Tests: JS (`tests/NativeRegistryCatalog.Tests.cjs`) with a fixture registry containing one issuable and several non-issuable targets (each reason covered), byte-identical default issuance (golden digest from the current code), selection fails closed, no secret strings in any output. Rust: serde/contract tests, broker test with the existing scripted-provider fixture proving a selected second fixture model receives the request, and a non-issuable one is refused with no run. Existing suites unchanged and green.

Out of scope for checkpoint 1: UI, execution binding changes, credential handling, saving Registry data, new providers.

## The first actionable Nexus task
Paste the text below into Nexus Desktop on the **Nexus** project (conversation: new). It is also saved verbatim as `R-NATIVE-1-registry-native-adapter.task.txt` (≈3.1 KB).

---
Implement checkpoint 1 of the Registry→Native integration. The Model Registry (R1–R7, config/registry/*) is already advanced and stays the only model authority: do NOT create another registry, copy catalog data into Rust, or hand-write endpoints or limits. Note: the module is config/registry/native-target-v2.cjs (there is no native-target.cjs).

Read first: config/registry/native-intent-bridge.cjs (commands target-info, issue, attempt-add), native-target-v2.cjs, native-issuer.cjs, service.cjs (getCatalog, effectiveSnapshot, compilePreview), tests/NativeRepoInspectBridge.Tests.cjs, native/nexus-broker/src/server.rs (models(), submit_with), native/nexus-client/src/intent_client.rs (AllowedModel).

Goal: let the Native runtime LIST and, later, SELECT Registry targets, read-only for now.

1. Bridge command `catalog` (node config/registry/native-intent-bridge.cjs catalog <repoRoot> <dataRoot>): for every enabled model x route x connection return providerId, logicalModelId, remoteModelId, routeId, connectionId, connectionStatus, protocol, contextLimitTokens, outputLimitTokens, billingTier, dataUse, issuable (bool) and reason (a machine code when not issuable, e.g. connection-not-connected, protocol-unsupported, no-credential-ref, context-unknown). Use the same rules native-target-v2.cjs already enforces; reuse its helpers, do not duplicate them. Never emit credential values, credential references' contents or filesystem paths.
2. `target-info` and `issue` take an optional selection {logicalModelId, routeId}. No selection => byte-identical output and digests to today (add a golden test first). With a selection => compile through the same trusted pipeline with the main slot overridden IN MEMORY only (never write the saved engineering-v2 configuration); unknown or non-issuable selections fail closed with the catalog reason; the selection must be part of what the digests cover.
3. Rust: add a typed RegistryTarget (serde camelCase) to nexus-client and return the catalog from the broker's `intent-models` while keeping every existing AllowedModel field and the default model unchanged (extra fields optional). A submit that names a model that is not issuable must be refused before a run exists.
4. Tests: tests/NativeRegistryCatalog.Tests.cjs with a fixture registry (one issuable target, non-issuable ones covering each reason, a secret-looking credential reference that must never appear in output); golden default issuance; selection fails closed; Rust contract tests; one broker test with the existing scripted TLS provider fixture showing a selected second fixture model receives the request and a non-issuable one is refused with no run created.

Constraints: no UI changes, no execution-binding or credential changes, no new dependencies, keep the Kernel seal and sealed-extension formats untouched. Run: node tests/NativeRepoInspectBridge.Tests.cjs, your new JS test, cargo fmt --check, cargo clippy -p nexus-broker -p nexus-client --all-targets -- -D warnings, cargo test -p nexus-client -p nexus-broker. Fix what you break. Finish with the list of changed files and the test results; do not widen the task.
---

## Checkpoint 2 — model resolution and execution binding (prepared, not started)
Task text: `R-NATIVE-2-model-resolution-and-binding.task.txt` (verbatim, ≈7 KB). It is grounded in verified gaps left by checkpoint 1:
* coding runs (`inspect.rs`) still issue only the default target, so the selection reaches only the model-only path;
* conversations carry no target; context/output limits are global constants rather than the target's;
* the catalog's `issuable` is not proven equal to what `issue` accepts; route identity is not part of the selection.

Start it in Nexus Desktop (project **Nexus**, new conversation; the project snapshot must be refreshed first so it contains checkpoint 1):

    Implement checkpoint R-NATIVE-2 from `native/docs/tasks/R-NATIVE-2-model-resolution-and-binding.task.txt`.

    Read the complete task specification and the files it lists before modifying code.
    Implement only this checkpoint, on top of the committed R-NATIVE-1 contracts. Preserve default OpenCode Go behaviour.
    Work autonomously in the isolated project workspace, implement the required changes and tests, run the required checks and report their real results.
    Do not start R-NATIVE-3 (Desktop UI) or real multi-provider execution.
    Do not modify the original repository, commit, push or deploy.
    Deliver a reviewable patch, the test results and any remaining limitations.

### Independent review protocol (Claude as reviewer, Nexus as implementer)
1. Do not interfere while the run is productive; stop it only for a proven non-productive loop (evidence first).
2. Never accept the final report as evidence. Copy the run's working tree (`code-base/worktrees/<task>`) to a scratch directory, and run there: `cargo fmt --check`, clippy for the affected crates, `cargo test --workspace`, both JS suites. Rerun a failing load-flaky test alone before judging it.
3. Check each numbered item of the task against the actual diff and a test that exercises the real path (not only a unit test of a helper). Look especially for: a second copy of an issuance rule, a silent fallback to the default model, credential material in records, changed default limits, tests that cannot fail.
4. Apply the patch to the branch only after review, commit as logical local commits, never push.
5. Anything the run claims but did not execute is recorded as incomplete, and sent back to Nexus as a `continue` with the exact missing items.

## After checkpoint 2
Checkpoint 3 (Desktop picker and read-only status; selection travels as identities only) and 4 (real multi-model acceptance, needs a second connected provider and explicit authorization) follow the same rule: written only after the previous checkpoint is merged and green.
