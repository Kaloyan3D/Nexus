# TASK-0039: composer preference ownership

## Proven failure and pinned contracts

Investigated on `feature/muse-integration`, starting at
`8ba01b0c3e73e6bfb17d28115b782a40e17cd0c5`, with a clean working tree.
The installed files were current. The real browser reproduced Normal
Engineering beside the raw DeepSeek V4 Flash / Max control.

The observed cause was **not an absent right outlet**: both outlets existed.
The browser reported `slot entry crashed in 'conversation.input.right'`:
`userFacingProfiles(null)` read `null.profiles`, called by
`initialProfileChoice` in the initial `useEngineeringEditor` effect. The
boundary removed the selector and its body-marker effect; the upstream model
control remained. `shell.overlay` could crash through the same editor hook.
The previous SSR tests did not execute this effect.

A second runtime defect prevented the shared mode bridge from mounting.
The visible picker was upstream (its menu included Standard/PTC/Minimal/
Creator), not Nexus. The mode plugin waited for `remote.agentPresets` and
`remote.settings`. Pinned DSH instead exposes RPC through `connection.api`;
`remote` is the event face. The corrected plugin uses object payloads,
`response.result`, and `sessions.noteAgentPreset` after host confirmation.
Browser diagnostics then showed preset `aih-engineering`, mode `engineering`,
source `mode-selection`, owner `profiles`.

Actual installed source inspected (all packages `0.1.1-rc.2`):

- `app/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`:
  `ConversationRoot` computes `zone` only when both `session` and `inputState`
  exist; `rightItems` is null otherwise (original lines 7193–7197, 7242).
  `InputBar` independently renders `conversation.input.model` (4097).
  Its declaration is `single`, originally `scope: "session"` (10082–10085).
- `dsh-client-ui-renderer/lib/client.js`: `renderOutletContent` rejects a
  strict session seat without `sessionId` (755–756), then selects only
  `host.entriesOfSlot(slotKey)[0]` for single slots (795–798). Returning null
  from the winner does not delegate to another entry. Crashes abdicate.
  `bindSnapshotSelector` requires a selector argument (154–159).
- `dsh-web-frontend/dist/assets/index-ClqxG24t.js`: embedded SlotCore rejects
  equal-priority single entries; lowest priority wins. `entriesOfSlot` skips
  abdicated entries. `dsh-cordis-client-runner/lib/client.js` additionally
  assigns automatic lower priorities to dynamic non-chain registrations.
- `dsh-client-ui-model-selection/lib/client.js`: original model registration
  (777–793) owns locale, directory injection, load/select, and `ModelSelect`.
  `ModelSelect` is not exported as a stable delegation API.
- `dsh-client-ui-agent-preset/lib/client.js`: pinned RPC contracts in
  `writeDefaultPreset`, `AgentPresetSeatController.load/apply`, and `apply`:
  `connection.api`, `{}` roster request, `{sessionId, agentPreset}` selection,
  `{ns, patch}` settings write, `response.result`, top-level summary
  `agentPreset`, and `sessions.noteAgentPreset`.

Thus the proposed input-readiness sequence is a real independent lifecycle
defect, but it was not the observed crash's immediate cause.

## Ownership decision and architecture review

Option C uses the existing UI installer and exact pinned source blocks in
`ui/nexus-ui/composer-contract.json`. `Patch-NexusComposer.ps1` validates
versions and unambiguous before/after blocks for both bundles before writing.
Changed, duplicate, mixed, or unsupported contracts fail closed. Reapplication
is idempotent and preserves LF/CRLF.

The model seat becomes `session-maybe`. Its original registration wraps the
original `ModelSelect` in the Nexus-provided `ComposerPreference`; it skips
directory creation without a session. Engineering renders `EngineeringSelector`,
legacy renders the original element with its original props, locale, directory,
load and select. No Model/Effort implementation is copied. This works when
the right outlet is absent because InputBar renders the preference seat
independently. `ExecutorChip` now renders only read-only pills.

1. **Source of truth:** the visible Nexus mode store for hero/blank sessions;
   controller snapshot/session preset for active sessions; host profile catalog
   and existing global preference endpoint for configuration.
2. **Writers:** mode controller stages selections and uses existing host RPC;
   profile editor uses its existing action endpoint. Preference owner only reads
   mode and delegates the view. RUNNING stays controller-owned.
3. **Dependencies:** patched upstream seat consumes an explicit Nexus service;
   Nexus does not import upstream UI internals. The model service is provided
   independently of seat injection, avoiding a mode/model dependency cycle.
4. **Boundary:** `nexusComposerPreference.Component` accepts standard selector
   hooks, `sessionId`, and an inert original legacy React element. No DOM or
   renderer-private state crosses the boundary.
5. **Failure:** unknown mode fails toward Engineering; loading/null catalogs
   show Profile loading; failed HTTP/JSON/catalog shows unavailable. No raw
   model fallback. Missing owner service leaves the seat unregistered. Patch
   mismatches terminate installation.
6. **Lifecycle:** Cordis owns service/injection lifetimes; React owns selector,
   editor and subscription lifetimes. Blank-session mode changes use the staged
   picker state before RPC completion. Original ModelSelect hooks run only
   when its legacy element renders.
7. **Tests:** actual installed source supplies the right-outlet conditions and
   actual model registration/component. Hook doubles enforce selector arguments;
   initial real editor effects run. RPC doubles use the pinned wire envelope.
8. **Compatibility:** no persisted schema or routing changes. Dynamic Custom
   remains host-catalog driven; Muse remains foundation. Rollback requires
   restoring both plugins and reinstalling pristine pinned upstream packages,
   then applying the prior UI patch together.
9. **Observability:** local `data-nexus-preference-owner`, composer-mode,
   mode-source and preset attributes describe ownership; existing slot-error
   boundaries expose crashes. These attributes do not control CSS visibility.
10. **Security:** no new remote endpoints, permissions, credentials, provider
    dispatch or execution paths. Existing host validation remains authoritative.

The old `applyComposerModeMarker`, its layout effect, and the complete CSS
model-seat suppression rule were removed. No generated CSS-class dependency
or DOM scraping chooses ownership.

Final self-review found no remaining blocker or important finding in the
changed behavior. The review checked single-seat fallback, blank-session
authority, loading failures, original legacy delegation, patch preflight,
and subscription/RPC contracts. No new data-loss or security boundary was
introduced. The primary compatibility limitation is the deliberate upstream
version/source pin; upgrades must update and reverify that contract.

## Verification record

Regression failures were captured before correction in
`C:/AI-Harness/tmp/task-0039/red-panel.log`, `red-ownership.log`,
`red-selector-hook.log`, and `red-mode-contract.log`. The baseline controller
suite had passed while the browser was broken.

The new ownership and mode-contract suites run inside
`NexusControllerPanel.Tests.cjs`, so the existing full harness includes them.
They cover session/input readiness, hero, stale blank-session snapshots,
Engineering/legacy/Engineering, unavailable controller/profile data, absence of
the right outlet, no CSS suppression, actual original legacy UI, independent
RUNNING/PREFERRED, cold-start effects, and pinned RPC boot/selection.
`Harness.Tests.ps1` covers patch installation, CRLF, idempotence and rejection.

Targeted suites: NexusControllerPanel, NexusProfiles (CJS and PowerShell),
EngineeringProfileEditor, EngineeringProfiles, ControllerRouting,
VisualControllerLifecycle, and Harness. Results are recorded under
`C:/AI-Harness/tmp/task-0039/`.

| Targeted suite | Executed result |
| --- | --- |
| NexusControllerPanel.Tests.cjs | PASS, including ownership and mode-contract tests |
| NexusProfiles.Tests.cjs | PASS, 33 checks |
| NexusProfiles.Tests.ps1 | PASS, 61 checks |
| EngineeringProfileEditor.Tests.ps1 | PASS, 43 assertions |
| EngineeringProfiles.Tests.ps1 | PASS, 104 assertions |
| ControllerRouting.Tests.ps1 | PASS, 83 assertions |
| VisualControllerLifecycle.Tests.cjs | PASS, REVISE → repair → reverify → PASS |
| Harness.Tests.ps1 | PASS, 267 assertions including patch contracts |

Full harness command:
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Test-Harness.ps1 -ContinueOnFailure -ReportPath C:/AI-Harness/tmp/task-0039/verified-harness.json`.
Final totals are recorded in that JSON and the task's final report.
The first run completed all suites without failures but could not write its
report because console redirection held the same `.log` path open. The repeat
uses a separate `verified-harness.console.log` destination.

## Real browser acceptance: PASS

1. Used `scripts/Stop.ps1`; confirmed the tracked Nexus process stopped and
   port 3080 had no listener.
2. Installed with `Patch-NexusUi.ps1` / `Patch-ControlRoomUi.ps1`; verified
   controller and mode-selector source/installed SHA-256 equality.
3. Restarted with official `scripts/aih.ps1 -InstallRoot C:/AI-Harness`.
   Final acceptance launch PID was 52752; provider/readiness checks passed.
4. Reloaded `http://127.0.0.1:3080/` and stayed on the existing empty New Session
   in OpenRank. A fresh page also showed Profile during the session-less hero.
5. Normal Engineering showed Profile and no raw Model/Effort control.
6. Selected DeepSeek Only on the same blank session: original DeepSeek V4 Flash
   / Max returned immediately, while the picker still showed Applying.
7. Selected Normal Engineering: Profile returned immediately during Applying.
   No message, reload, timeout, or session recreation between mode switches.
8. Inspected the Profile popover and read-only Muse foundation metadata.

Evidence directory: `C:/AI-Harness/tmp/task-0039/`.

- `before.png`, `browser-errors-before.json`: reproduced failure.
- `engineering-final.png`: Engineering after the final cold restart.
- `legacy-final.png`: original Model/Effort restored.
- `engineering-return-final.png`: immediate switch back.
- `profile-popover-final.png`: working real profile editor.
- `muse-foundation-final.png`: read-only metadata and disabled Select Profile.
- `runtime-acceptance.json`: visible mode, derived mode, both outlet flags,
  mounted EngineeringSelector, preference owner, and zero slot errors.
- `startup-acceptance.log`, `install.log`: official runtime procedure.

Production Muse remains `selectable=false`, `runnable=false`,
`availability=foundation`. No M3 code or Muse execution was added.

## Changed files

- `ui/nexus-controller/lib/client.js`: loading safety, preference owner service,
  separate pills, visible loading/unavailable state, removal of CSS suppression.
- `ui/nexus-mode-selector/lib/client.js`: pinned RPC/service/summary contracts.
- `ui/nexus-ui/composer-contract.json`: exact upstream before/after blocks.
- `scripts/Patch-NexusComposer.ps1`: validated deterministic integration patch.
- `scripts/Patch-NexusUi.ps1`: install entry point for that patch.
- `tests/NexusComposerOwnership.Tests.cjs`: actual pinned composer contract.
- `tests/NexusModeContract.Tests.cjs`: mode service and RPC behavior.
- `tests/NexusControllerPanel.Tests.cjs`: effect regression, independent surfaces,
  and inclusion of both new suites in the normal harness.
- `tests/Harness.Tests.ps1`: patch install/idempotence/refusal coverage.
- `tests/SetupUpgrade.Tests.ps1`: corrected RPC contract expectations.
- `docs/architecture/nexus-profiles.md`, `docs/nexus-ui.md`: current ownership.
- `docs/architecture/composer-preference-ownership.md`: this evidence record.
