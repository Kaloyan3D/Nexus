# CCv2 Native — Reuse Inventory and Integration Plan

Status: **inventory only**. No CCv2 code is implemented, ported or enabled by
the M8.1 reliability closure. CCv2 is an existing legacy Nexus implementation
(JavaScript, `config/Context*V2.cjs`); the next track reuses it rather than
rewriting it in Rust.

## What exists (legacy, `config/`)

46 `Context*V2.cjs` modules. The relevant groups:

| Group | Modules | Role |
|---|---|---|
| Compiler core | `ContextCompilerV2.cjs` (1886 lines) | `compileContextV2`, `buildContextCompilationPlanV2`, `deriveMandatoryManifestV2`, `enumerateContextCandidatesV2`, `applyDeterministicContextPolicyV2`, `validateContextCompilationPlanV2`, `describeContextCompilationPlanV2`; versioned schema + policy revision constants |
| Shadow path | `ContextCompilerShadowV2.cjs` (1354), `ContextShadowV2.cjs`, `ContextCompilerShadowAdapterV2.cjs`, `ContextCompilerShadowHostV2.cjs` | Compile-without-applying, comparison and adapter seams — the legacy shadow-mode machinery |
| Active path | `ContextCompilerActiveV2.cjs` (509), `ContextCompilerActiveHostV2.cjs`, `ContextCompilerActiveMuseV2.cjs`, `ContextCompilerActiveOpencodeV2.cjs`, `ContextCompilerActiveOpencodeHostV2.cjs`, `ContextActiveApplyV2.cjs`, `ContextActiveApplyLockClientV2.cjs` | Applying a compiled plan to a live host session, with apply locking |
| Budget & pressure | `ContextBudgetAllocatorV2.cjs`, `ContextPressureV2.cjs`, `ContextActivationPressureV2.cjs`, `ContextCompressionLadderV2.cjs`, `ContextCompaction.cjs` | Token budgets, pressure signals, compression ladder |
| Evidence & memory | `ContextEvidenceIndexV2.cjs`, `ContextEvidenceRehydrationV2.cjs`, `ContextRepositoryEvidenceSourceV2.cjs`, `ContextSessionEvidenceSourceV2.cjs`, `ContextMemoryProducerV2.cjs`, `ContextMemoryProducerHostV2.cjs`, `ContextCheckpointV2.cjs`, `ContextCheckpointabilityV2.cjs` | Evidence indexing/rehydration, memory production, checkpointability |
| Tokens | `ContextTokenCounterV2.cjs`, `ContextTokenizerRegistryV2.cjs`, `ContextRemoteCounterMuseV2.cjs` | Token counting and tokenizer registry |
| State & trust | `ContextSnapshotV2.cjs`, `ContextPageStoreV2.cjs`, `ContextPageV2.cjs`, `ContextViewV2.cjs`, `ContextRetentionV2.cjs`, `ContextSafePointV2.cjs`, `ContextRecoveryFaultV2.cjs`, `ContextTaskAuthorityV2.cjs`, `ContextAuthorityCertificationV2.cjs`, `ContextTrustV2.cjs`, `ContextDurableMutationPolicyV2.cjs`, `ContextGenerationRuntimeV2.cjs`, `ContextCompleteTaskV2.cjs` | Snapshots, paging, retention, task authority, mutation policy |
| Wire | `ContextPromptLayoutV2.cjs`, `ContextPromptRendererV2.cjs`, `ContextWireProjectorResponsesV2.cjs`, `ContextRetrieverV2.cjs` | Prompt layout/rendering and Responses-API projection |

## Native integration points (existing seams, no new architecture)

| CCv2 need | Native seam today |
|---|---|
| Run JS modules without a Rust rewrite | The broker already supervises Node workers (`nexus-broker/src/engine/worker_bridge.rs`, deny-all permission mode, bounded slots). A CCv2 worker is one more worker kind behind the same bridge. |
| Conversation/thread state as compiler input | `nexus-broker/src/threads.rs` (durable conversation record: prior runs, context reconstruction) and the run store (`store.rs`) |
| Task authority (what must never be dropped) | The Kernel task/attempt identity and the run's frozen bindings in `inspect.rs`; CCv2 `ContextTaskAuthorityV2` maps onto these, it does not replace them |
| Where compiled context would be consumed | The run loop in `nexus-broker/src/inspect.rs`, at the same point the current native compaction runs |
| Current behavior to beat | `nexus-broker/src/context.rs::compact()` — the deterministic Native compaction; shadow mode compares CCv2 output against exactly this |
| Token accounting | `nexus-broker/src/request_budget.rs` and provider usage on `IntentRun` (`usage_input_tokens`, `context_compactions`) — the economics baseline |
| Model/request boundary | `nexus-model` request preparation; CCv2 output must enter as a compiled item list, never as grant/scope/tool changes. Context compilation grants no authority. |

## Smallest implementation path (next track)

1. **Shadow worker**: run `ContextCompilerShadowV2` in a broker worker on
   completed turns. Inputs are derived from the thread record and the items
   the native loop actually sent. Output is journaled as a shadow artifact
   (plan digest, selected/dropped candidates, token estimate) and never
   sent to a provider.
2. **Correctness validation**: for a corpus of recorded conversations,
   assert the shadow plan never drops mandatory-manifest items (task
   authority, latest user intent, unresolved tool pairs), and diff its
   item selection against `context.rs::compact()` outcomes.
3. **Token economics**: compare shadow-plan token estimates with actual
   `usage_input_tokens` and compaction frequency across the corpus; publish
   the delta distribution, not just the mean.
4. **Benchmark gate**: pre-registered acceptance thresholds (no mandatory
   drops, estimate error bound, net token saving vs the current compaction
   on long conversations, no latency regression beyond a stated bound).
5. **Selective activation**: only after the gate, enable CCv2-compiled
   context per-engine as a new versioned engine/profile (the `muse-v0-jobs`
   pattern from M7.1), default off, old profiles byte-identical. Rollback
   is profile selection, not code.

Explicit non-goals for that track: rewriting CCv2 modules in Rust, changing
Kernel authority, letting compiled context alter grants/tools, or activating
for all engines at once.
