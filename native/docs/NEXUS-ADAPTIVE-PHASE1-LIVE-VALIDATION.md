# Nexus Adaptive — Phase 1 (Registry + real OpenCode Go provider): status

**Verdict for Phase 1: INCOMPLETE — the live part was NOT executed.** The environment's permission classifier denied the first billable provider action (`authorize` + `verify` of the adaptive route). I did not work around it. Phase 2 (default mode + Desktop) was therefore **not started**, as the mission requires a successful Phase 1 first.

## What is done (offline, tested, committed as "Phase 1 — offline part")
| Item | Result |
|---|---|
| First-party onboarding path (no JSON editing) | `scripts/Setup-NativeOpenCodeGo.cjs --adaptive` adds a DISTINCT model `meta/muse-spark-1.3-contributor-adaptive` (engines `["nexus-adaptive-v1"]` only) and route `opencode-go-native/muse-adaptive` (same provider/connection/remote model/transport `openai-responses`, ladder low/medium/high/xhigh, saved `probe-required`). Idempotent: a repeated run reports "already present" and creates no duplicate. Historical Muse Spark entries untouched (asserted byte-identical). |
| Real verification mechanism, extended not bypassed | `scripts/Verify-NativeOpenCodeGoRoute.cjs authorize|verify --adaptive`. The single-use authorization record names ONE route and states the exact request list: **8 requests** (1 GET models; a text probe per authorized effort low/medium/high/xhigh, each requiring the provider to acknowledge that effort; stream; tool call; tool-result continuation). A default-route record cannot verify the adaptive route and vice versa. Verification is per level: a level whose probe fails is never claimed. |
| Explicit, authorized save only | The adaptive ModeConfiguration is written only with `--save-adaptive-config`, only after the route verified, and refused if any authorized level is unsupported. Verification alone saves nothing. |
| Tests | `NativeOpenCodeGoRoute` 12/12 (4 new), `RegistryAdaptiveMode` 27, `RegistryCore` 46, `RegistryR3UI` 29, `NativeTargetV2` 18; R3 preflight rehearsal 13/13; new E2E `r3_an_adaptive_task_selecting_an_unverified_route_is_refused_before_any_request` (real broker: refused at submission, zero provider requests); `cargo fmt --check` clean. The full battery/gate were NOT re-run for this commit. |
| Finding from the offline work | the Registry's route verification probes every declared effort level and requires the provider to echo the requested effort; a route can end up verified for a SUBSET of levels (and the adaptive configuration is then refused). This is the mechanism through which "provider accepts low/medium/high/xhigh" is evidenced — only a live run can show it. |
| Owner's registry state | the setup step (offline, no network) WAS applied to `~/.nexus-interactive-dev/registry` after a backup (`registry.bak-pre-adaptive-202610240118`): the adaptive model and route now exist there as `probe-required`; **no ModeConfiguration was saved and nothing was verified**. |

## What is blocked (needs your decision)
The live steps are billable provider calls with the stored credential, and the tool permission layer refused them. To proceed, either allow me to run these two commands (or run them yourself), then tell me to continue:
```fish
cd ~/Projects/Nexus; set H $HOME/.nexus-interactive-dev
node scripts/Verify-NativeOpenCodeGoRoute.cjs authorize --data-root $H/registry --acknowledge-billable --adaptive      # records exactly 8 requests
node scripts/Verify-NativeOpenCodeGoRoute.cjs verify    --data-root $H/registry --credentials $H/credentials.json --adaptive --save-adaptive-config
```
(The key is read only by the verify script after the record is consumed; it is never printed.) Afterwards the remaining Phase 1 scenarios (first adaptive task, tool calls, effort history, failure/escalation, continuation, replay after an effort transition, authorization audit) run via `NEXUS_HOME=$H nexus runtime start` and `nexus intent submit … --engineering-mode engineering-v2-adaptive`, on a disposable synthetic repository, exactly as the R3 plan lists; a transition that does not occur naturally will be reported UNOBSERVED.

## Not claimed
Verified route, valid persisted adaptive configuration, any real adaptive task, effort transitions, replay, recovery: all **UNVERIFIED**. R74 (issue #35) unchanged. macOS/Windows UNVERIFIED.
