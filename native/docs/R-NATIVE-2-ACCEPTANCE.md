# R-NATIVE-2 — acceptance record

Checkpoint 2 of the Registry → Native integration: **model resolution and execution binding**. The implementation was written by Nexus itself (conversation runs 9–12), then reviewed, repaired and given real acceptance tests by an independent reviewer. This file maps every item of `tasks/R-NATIVE-2-model-resolution-and-binding.task.txt` to the evidence that exists in the repository. Items without end-to-end evidence are said so.

All sandbox-dependent tests were run with `NEXUS_REQUIRE_SANDBOX=1`: a test that cannot run (no sandbox/toolchain) **fails** instead of printing "NOT RUN" and counting as passed. (Without that switch, 65 `code_a56` tests silently return early on a host without the sandbox. That is how the delivered patch showed "61 passed" while it broke every coding run.)

## Requirement → evidence

| # | Requirement | Evidence (test) | Level |
|---|---|---|---|
| 1 | One shared resolution before the run exists (explicit → conversation → default); unknown / non-issuable / ambiguous refused; no silent fallback | `resolution.rs` unit tests (default, explicit, route, ambiguous, unknown, non-issuable, conversation); `rn2_a_run_without_any_selection_uses_the_default_target_exactly_as_before`; `rn2_the_default_target_is_the_saved_slot_even_when_another_issuable_route_sorts_first`; `rn1_selected_second_registry_model_reaches_provider_and_non_issuable_is_refused` | broker + daemon + sandbox + TLS fixture |
| 2 | Optional route identity (`logicalModelId`, `routeId`) on `ModelSelection`; old JSON still parses; ambiguity listed | serde back-compat in `nexus-client/tests/registry_target.rs`; `rn2_the_cli_selects_model_and_route_end_to_end…` (model + route, route alone, mismatch refused); `ambiguous-target` in `resolution.rs` unit tests | `ambiguous-target` is **unit-level only** (the fixture Registry has no two issuable routes for one provider/model) |
| 3 | Run binding: every turn uses the same issued target; record carries identity, no credential material | `rn2_a_coding_run_on_the_second_model_is_bound_to_it_and_its_connection_on_every_provider_call` (every request of a 5-turn coding run: model, credential, output cap; run record and conversation record contain no secret / `credential://`) | end to end. A per-turn *mismatch* refusal is not provoked (a run cannot change target mid-run by construction) |
| 4 | Conversation binding: reuse, explicit switch + note, stale refusal, no fallback, byte-identical context | `rn2_a_conversation_keeps_its_target_switches_only_explicitly_and_says_so`; `rn2_a_conversation_whose_target_is_no_longer_issued_is_refused_before_any_run_and_never_falls_back` (a real Registry change); `rn2_the_conversation_context_is_byte_identical_whatever_the_target` | end to end |
| 5 | Limits from the target; default unchanged | `rn2_the_small_window_target_compacts_and_writes_its_memory_earlier_the_default_does_not_change` (default 1M-token window: 0 compactions, no memory request; 8192-token target: compacts **and** asks for working memory; every request ≤ the target's 512 output cap); `effective_context_budget` / `effective_output_cap` unit tests | end to end. The bytes-per-token factor (4) is a documented constant in `resolution.rs` |
| 6 | Credentials by connection | the same bound-run tests assert target B's request carries credential B and never credential A, and the reverse after a switch (two fixture connections, two secrets) | end to end |
| 7 | Catalog `issuable` equals what `issue` accepts, with the same reason | `rn2_catalog_issuable_is_exactly_what_issuance_accepts_with_the_same_reasons` (every target of the fixture Registry incl. the built-in providers: accepted/refused matches, refusal message carries the catalog reason); the same comparison run read-only on the real Registry during review: 11 targets, 0 mismatches | automated on the fixture; the real-Registry run was a one-off script, not a repository test |
| 8 | CLI: `intent thread send --model/--route`, `intent submit --model/--route`, `intent models --targets` | `rn2_the_cli_selects_model_and_route_end_to_end_and_lists_the_targets` (real `nexus` binary against the fixture broker; listing has no secrets) | `thread send` and `models --targets` end to end; `intent submit --model/--route` is implemented but only covered by the earlier R-NATIVE-1 model-only test |

## Defects found in the delivered patch (all fixed in this change)

* **D1 (blocker)** — the per-run check read the issued route from `extension.routeId` / `resolution.routeId`, which do not exist (the field is `core.routeId`). Every coding run, the default one included, was rejected with "Registry target differs…".
* **D2** — a run with no selection took the *first issuable route in catalog order*, not the saved `engineering-v2` slot. Identical on the real Registry today (only `opencode-go-native` is issuable); would silently change the default as soon as another issuable route sorted first. Now the saved default is used (`Broker::default_selection`).
* **D3** — the working-memory trigger used the configured budget while compaction used the target's, so a small-window target compacted without ever asking the model for its working memory.
* **Desktop backend** — `apps/nexus-desktop/src-tauri` (a separate crate) did not compile against the new `ThreadSend` / `ModelSelection` fields. Fixed (the Desktop sends no model until R-NATIVE-3).
* Not a defect (withdrawn during review): "stale target not refused" was a test replaying an idempotency key.

## Known behaviours and limitations (stated, not hidden)

* **30-second catalog cache.** The broker caches the Registry catalog (and the default model) for 30 s. Right after a Registry change (a model disabled, a connection lost) a send can still be *accepted* and then fail closed at issuance ("failed before submission: registry-selection-not-issuable … model-disabled"); after the cache expires the same send is refused up front with the catalog reason. The test waits for that. Nothing unsafe is ever issued: issuance re-checks.
* **Multi-UID tests are not run here.** 49 tests are `#[ignore]`d and need a prepared multi-UID host (`MULTUID-PROCEDURE.md`). They exercise the production-profile identity separation, which this change does not touch, but they were **not executed** for this milestone.
* `ambiguous-target` and the per-turn mismatch refusal have unit-level coverage only (see table).
* The default selection is built from the saved slot's (provider, remote model, logical model); if two routes shared one logical model, the first in catalog order would be taken. Not the case in any configured Registry.
* `rn2_binding.rs` (written by Nexus) only tests pure helpers. The real evidence is the `rn2_*` tests in `code_a56.rs` / `broker_a53.rs`.
* A conversation's bound target is not yet shown by `thread-get` / `thread-list` (planned for R-NATIVE-3).
* The Desktop cannot choose a model yet (R-NATIVE-3); real multi-provider runs need a second connected provider (R-NATIVE-4).
* The compaction budget uses 4 bytes per token of the target's window and the 1M-token default keeps today's 1.2 MB budget; other windows are an estimate, not a tokenizer.

## Test infrastructure added with the acceptance tests

* Fixture Registry: large-window default model (8192 tokens made every test compact), a second model on a **second connection with its own credential** and a 512-token output cap, a configured-but-unverified third model, and two helper subcommands (`registry-first`, `registry-disable`).
* `NEXUS_REQUIRE_SANDBOX=1` turns a skipped sandbox test into a failure.
* `native_bin` honours `CARGO_TARGET_DIR` in `code_a56.rs` and `inspect_a55.rs`. The four `code_a56` tests Nexus reported as failing (`a56_production_v1_refuses_to_start_with_repo_code`, three `a613_…`) failed with `spawn nexusd: NotFound` for exactly this reason (its sandbox builds into `/work/env/target`): reproduced, then fixed.
