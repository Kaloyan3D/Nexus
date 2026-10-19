# R-NATIVE-3 — acceptance record

Checkpoint 3 of the Registry → Native integration: **Desktop Registry integration** (model picker, read-only Models status, identities only). Written by Nexus (run 14), then recovered: the patch was kept, its checks could not run in Nexus's sandbox, and an independent reviewer repaired it and added the missing tests. Evidence below was produced with `NEXUS_REQUIRE_SANDBOX=1` (a skipped sandbox test fails) and, for the Tauri crate, `CARGO_INCREMENTAL=0`.

## Requirement → evidence
| # | Requirement | Evidence | Level |
|---|---|---|---|
| 1 | `thread-get` / `thread-list` expose the conversation's bound target as identities only; absent when unbound | `code_a56::rn3_the_conversations_bound_target_is_exposed_as_identities_only_and_absent_when_unbound` (real broker + daemon + sandbox + TLS fixture: a created-only thread has no key; after a selected send exactly four fields; no connection/limits in the summary; no secret/path anywhere; an explicit switch moves it); `threads::tests::the_bound_target_*` | end to end + unit |
| 2 | Tauri `intent_targets`; `thread_send` / `intent_submit` accept an identities-only selection, validated before the broker; allowlist | `desktop_intent_targets_reads_the_registry_catalog`, `desktop_thread_send_forwards_identities_only`, `desktop_intent_submit_forwards_the_selection_identities_and_rejects_malformed_ones` (fake broker: frames inspected; malformed or half selections never reach the socket), `build_manifest_matches_handler_list`, `capability_grants_exactly_registered_commands`, the authority guard `intent_commands_use_only_the_unprivileged_broker_client` (original global guard unchanged + a scoped vocabulary check on the three selection commands) | Tauri backend tests |
| 3 | Picker: default first and sends no selection; unavailable targets disabled with the reason in words; a switch on an existing conversation is explicit; never falls back | `rn3.test.tsx`: picker offers/disabled/keyboard/bound/switch; the composer sends **no `model` key** by default and exactly the four identities for a choice; switch note and send; a refusal keeps the selection and the typed text visible; an older broker without a catalog still sends with the default | Vitest through the real components |
| 4 | Read-only Models view with limits and status, nothing secret | `rn3.test.tsx` "Models view": every target row, limits, Issuable/Unavailable with reason, no control inside the table, keyboard-reachable scroll region, no secret-like text; error state | Vitest |
| 5 | Run and conversation show the model and route | `rn3.test.tsx` "where the model is shown": run badge, conversation header; older payloads render | Vitest |
| 6 | Refusal wording; the 30-second cache window explained honestly | `refusalMessage` / `failedBeforeSubmissionMessage` tests; a rejected run with `registry-selection-not-issuable` shows "The Registry changed after the model list was read… Pick the model again", with no retry | Vitest |
| 7 | Accessibility and narrow width | labelled `combobox`, `role=status` switch note, `aria-live` bound note, keyboard operation, scroll region with `tabindex`, compact layout (viewport 720) renders and sends; the stylesheet rules (picker wraps and shrinks, the 10-column table scrolls sideways) are asserted from the source | **not testable in jsdom:** real pixel layout and overflow |
| – | Rust ↔ TypeScript contract | golden files `apps/nexus-desktop/src/test/contract/*.json`: Rust must serialize exactly them (`registry_target::the_registry_target_wire_shape…`, `threads::…wire_shape…`) and `contract.test.ts` types them against the TypeScript interfaces (`tsc`) | both directions |

## Defects in the delivered patch (all fixed)
* The default send always added `model: null` (the code comment claimed "byte-for-byte the same request"; two existing tests failed).
* Nexus's tests were written against an imagined `RegistryTarget` (`routeReason`, `reasonCode`, `routeEligibility`…) and imagined wording: 5 TypeScript errors, 1 ESLint error, 4 failing new tests. The TypeScript contract now matches the Rust struct (required versus omitted fields).
* The Models table put 10 cells into a 5-column grid (and a 2-column rule on narrow windows); the picker had no styles. Fixed (scrollable region, wrapping picker).
* The Tauri authority guard failed on the word "credentials" in new comments, and Nexus's added second guard scanned the whole backend for words that legitimately occur elsewhere (`approval_lifetime_secs`, `max_output…`): comments reworded; the original global guard is unchanged and the new vocabulary check is scoped to the three selection-carrying commands.
* `thread_send` has 10 named arguments (clippy `too_many_arguments`): kept by design (the frontend/backend contract is named arguments) with a documented `#[allow]`.
* Unformatted Rust in the Tauri crate.

## Known behaviours and limitations
* The broker caches the Registry catalog for 30 s (see R-NATIVE-2): right after a Registry change a send can be accepted and then end "failed before submission"; the Desktop says so. After the cache expires the send is refused up front.
* 49 multi-UID tests are `#[ignore]`d (prepared multi-UID host required) and were not executed.
* `cargo clippy -D warnings` for the Tauri crate was red before this milestone because of two dead-code items in `backend.rs` (`MAX_PAGE_LIMIT` and the old `conversation_read` helper, superseded since A5.3.1 by `desktop_contract::conversation_read`, which has the same 1-500 page clamp and is what the Tauri command calls). They were removed in a separate cleanup commit; the clippy gate is green.
* The Tauri crate fails to link with incremental compilation in this environment (undefined `anon…llvm` symbols); with `CARGO_INCREMENTAL=0` it builds and tests normally.
* The Desktop is tested against a fake API and fake-broker sockets; no test drives the real Tauri window against a live broker.
* Nexus's run could not execute the frontend or Tauri checks in its sandbox: see `diagnostics/DIAG-r-native-3-run14.md` and the updated tool description.
* **Not solved here:** the model/tool-call degeneration that ended run 14 (long narration instead of tool calls) is a separate, high-priority investigation. The `failing-checks` completion class only prevents such a run from being accepted as verified.
