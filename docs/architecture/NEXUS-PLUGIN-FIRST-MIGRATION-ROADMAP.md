# Nexus plugin-first migration roadmap · Revision 2

The approved hybrid architecture uses Nexus `f80d0a324333851db55b4c81f27a1ef24b2b0161` and DSH `dsh-v0.2.2-rc.1` at `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`. The local tip is five commits ahead of remote migration tip `0658c838`. See the [architecture audit](NEXUS-PLUGIN-FIRST-ARCHITECTURE.md) and [CLI contract](NEXUS-CLI-CONTRACT.md) for source references and proposed interfaces.

Use private fixture installations, nonproduction ports, synthetic credentials and blocked egress. Keep EMv1/Dual and EMv2/Muse available during migration. The first-party CLI targets those modes before Nova. New paths under `config/nexus/` and new test names are proposed. Estimates are developer-days and exclude partner wait time.

## P0 · Baseline and architecture contracts

**Owners.** A on composition and routing, B on verification/evidence and platform harness. **Depends on.** The pinned baseline. **Effort.** 3–5 days, moderate.

1. **B01** Freeze `runtime/package-lock.json`, `config/versions.json` and the target commit. Use `scripts/Verify-NexusComposition.mjs`, `scripts/Test-Harness.ps1` and `tests/diagnostics/NexusAuthSweep.cjs` in isolated roots. Record effective preset/tool/service tree, authorized route claims, task/binding/attempt/evidence files and restart behavior.
2. **B02** Add fixture vectors for legacy review refusal/approval, visual verification, interrupted verification and concurrent workspace turns. Compare `origin/dev` only for intended 0.1-to-0.2 semantics in its own fixture roots. Classify known-red lab/environment cases by cause.
3. **B03** Prove real-host Controller admission and flush/read-back, blank preset behavior and missing dependencies. Capture warm p95 and cold boot/memory baseline. Freeze the v1 API operations and envelopes, completion outcomes and delivery/idempotency contract.
4. **B04** First implementation milestone. Add an isolated diagnostic fixture for the pinned DSH Web profile with `--no-open`. Trace one Dual and one Muse synthetic turn through the Controller and DSH persistence. Inspect `scripts/{aih,Startup,Platform}.ps1` for shared launch ownership. Identify every raw owner-peer mutation path for a managed session and test an interception route. DSH Web owner calls skip generic remote-access policy. If no supported seam covers a path, record the missing seam and scope a narrowly pinned guard or upstream extension before P2. Deliver a repeatable fixture and expected trace output.

**GO.** Measured baseline, no unexplained production failures in affected flows, and a documented fail-closed route to shared-host admission. Carry unresolved managed-mutation or startup gaps as blocking P2 gates. **Rollback.** Discard fixture roots. **Preserve.** Runtime pins and production state.

## P1 · Trusted Controller and plugin foundation

**Owners.** A on Controller/composition, B on comparison and fault tests. **Depends on.** P0. **Effort.** 7–12 days, high.

1. **C01** Introduce `config/nexus/{controller,legacy-cli,strategy-index}.cjs`. Extract caller ports from `config/AihController.cjs:1066–1164,1299–1743,2389–2575`. Keep `scripts/{Task,Route,Engineering,Verify-Project,Review}.ps1` as implementation adapters. Preserve arguments, payloads, mutexes and result interpretation.
2. **C02** Introduce `config/nexus/strategies/muse.cjs`. Move Muse through the in-memory strategy index and scoped lifecycle bridge. Preserve `config/Muse-{Isolation,ReasoningGovernor,ReasoningRuntime,ReasoningSignals,ReasoningActivity}.cjs` behavior and model-selection order in `Controller-RequestBoundary.cjs`. Reuse `config/registry/{service,resolver,dsh-adapter,session-binding}.cjs`. Keep Dual's strategy and legacy write adapter. Prepare both modes for the same submit/read/cancel/respond surface.
3. **C03** Update `config/home.cordis.patch.yml`, `scripts/Build-NexusHomePatch.cjs`, `scripts/MusePresetDependencyClosure.cjs` and `scripts/Verify-NexusComposition.mjs` for a single allowlisted Controller host row and a thin Muse bridge. Stage one cohort switch at quiescence. Shadow comparison is read-only.
4. **C04** Run `ControllerRouteSelection`, `ComposedRoutingAuthority`, `ComposedRoutingMatrix`, `RuntimeRoutingTrace`, `MuseIsolation`, the Muse reasoning suites, `RegistryR63Binding` and `TaskIdentity`. Add replay, disposal during setup, duplicate turn events, missing strategy, stale binding and PowerShell timeout/partial-output fixtures.

**GO.** One Controller authority, equivalent normalized Muse traces, unchanged Dual/DeepSeek outcomes, explicit Muse review refusal and no delegation, zero extra model calls and agreed admission overhead. **Rollback.** Drain switched sessions and restore the earlier preset bridge for new work. **Preserve.** Ledger schemas, legacy CLIs, V1 and CCv2 restrictions, and the DSH loop.

## X0 · Early Complex feasibility

**Owner.** B, isolated fixtures. **Depends on.** P0 baseline and P1 scope fixtures for the end-to-end proof. **Effort.** 2–4 days, moderate. Start during P1.

1. **X00** Add lab-only `tests/diagnostics/NovaActivationProbe.mjs` and a private profile overlay under the fixture root. On pinned DSH Web, create a constrained coordinator and start a local `spawn` child through `ctx.subagents.startActivation`. Specify exact child ID, independent preset, complete fake model route, explicit cwd, bounded depth and caller-only delivery. Inspect session header, lineage, effective permissions, tool schemas, captured route and observed root/child hooks. Compare tagged `activation-presets.spec.ts`, `activation-policy.spec.ts` and `spawn-in-process.e2e.ts`.
2. **X01** Test rejection of a wider parent sandbox, unauthorized inherited tools or root hooks, route drift, cancellation before publication, active cancellation and parent shutdown. Await exact activation disposal even when the result settled. Confirm no remaining handles/jobs and durable session read-back. If public activation cannot express the needed scope or setup, run the same fixture through an owned `ctx.agents.create` handle and pre-publication setup. Prove the equivalent ownership and teardown.

**GO.** One activation path demonstrates distinct routes, exact ownership and lineage, constrained tools, reliable cancellation and no post-drain writes. **NO-GO.** Unconfined child, root hooks or ambiguous teardown block P5. **Rollback.** Remove the fixture install. **Preserve.** All production presets. X0 does not block P2 or P4.

## P2 · First-party Nexus CLI for existing modes

**Owners.** A on launcher/transport and wrappers, B on parity/fault fixtures as capacity allows. **Depends on.** P1 and P0's startup/mutation gates. **Effort.** 9–15 days, high.

1. **L01** Add `scripts/nexus-cli.cjs`, `bin/linux/nexus.sh` and `bin/nexus.cmd`. Wire them through `setup.sh`, `scripts/{Setup,Complete-Install,Platform}.ps1` and `scripts/Update.ps1` where required. Test removal using each supported installer channel’s existing uninstall flow. Implement v1 parsing, UTF-8 input, size and digest checks, stable JSON/exit classes and TTY following. Preserve `aih` shims. Publish pinned Node plus the CLI entrypoint for Windows automation and test direct argv with Unicode and metacharacters.
2. **L02** Share existing startup mechanics from `scripts/{aih,Startup,Platform}.ps1` through proposed `scripts/NexusHost.ps1` and a platform writer guard. Keep one approved pinned `dsh --profile web --no-open` host per canonical install/session store, with election and lifetime ownership through drain. Add authenticated descriptor/readiness and proposed `config/nexus/task-ipc.cjs` to `config/home.cordis.patch.yml`. Prove the private POSIX socket and Windows named-pipe ACL before the corresponding releases. Route `scripts/{Stop,Update}.ps1` through authenticated drain for managed hosts and test forced recovery separately.
3. **L03** Add `config/nexus/{task-api,intake,dsh-sessions,interaction}.cjs`. Wire `ui/nexus-controller/lib/{index,client}.js` to the same task API. Route explicit owner-only workspace setup through `scripts/NexusWorkspace.ps1` identity resolution and the DSH Workspace Registry. Guard managed sessions at raw DSH mutation boundaries, including owner-peer access. Use the keyed allocation in `scripts/TaskController.ps1:215–252`, binding in `config/AihController.cjs:2910–3053` and exact DSH session identity with pre-publication setup. Keep legacy execution status in its ledger. Persist intake key and delivery intent, flush/read back the one accepted DSH input, and reconcile crash windows. Route managed operator decisions through one host approval broker, including a typed explicit-verification action for legacy tasks that need it.
4. **L04** Add `tests/{NexusCliContract,NexusCliHost,NexusTaskApiParity,NexusCliRecovery}.Tests.cjs`. Run GUI and concurrent CLI clients on one synthetic host. Compare normalized authority records in both modes, including verification and legacy review/gate behavior. Race startup and same-key requests. Test old running host, endpoint impersonation/ACL, foreign workspace, owner-peer bypass, mode revocation, missing mandatory plugin, Markdown file errors and golden JSON/exit codes. Kill CLI before/after receipt and host at each durable boundary. Test cancel/complete race, restart resume/hold, and approved, denied, expired and simultaneous operator responses. Run `SetupUpgrade`, `NexusRouteAdmission`, `NexusModeContract` and CCv2 restriction tests on appropriate roots.

**GO.** One host and writer, equivalent GUI/CLI semantics, one durable accepted task/input per key, verified disconnect behavior and no raw mutation bypass. Per-platform launch, Unicode path, upgrade, IPC and process tests must pass before support claims. **NO-GO.** Insecure endpoint, second host, lost acceptance or unverifiable task boundary. **Rollback.** Disable managed admissions, drain/park, retain a reader for accepted IDs, restore prior launcher/package selection. **Preserve.** Dual/Muse semantics, existing ledger schema, DSH lifecycle and CCv2 policy.

## P3 · Nova authority, evidence and review contracts

**Owners.** B on journal/evidence fixtures while A ships P2, A on final admission and pins. **Depends on.** P1 and frozen P2 task API. **Effort.** 8–14 days, high.

1. **N01** Add `config/nexus/{contracts,task-store,evidence}.cjs`. Implement the recommended Controller-owned journal for new Nova tasks with durable intake/effect records, unique task revision, exact attempt CAS, protected evidence and rebuildable index. Keep legacy records and cohort readers. Refuse Nova identities in `scripts/Task.ps1` and `scripts/TaskController.ps1:437`.
2. **N02** Add `config/nexus/{admission,budget}.cjs`. Pin composition and authorized role resolution before inference. Extend existing `config/registry/modes/engineering-v3.json` and resolver validation, keeping Nova non-runnable until ready. Reserve/settle per-purpose budgets. Test revocation, retries and untracked auxiliary calls.
3. **N03** Add `config/nexus/{snapshot,verification,review}.cjs`. Adapt `scripts/{Verify-Project,Project,Engineering}.ps1` to exact immutable snapshot receipts and trusted runner isolation. Test with a fake independent review process. Implement repair and completion transitions and failure states. Run fault injection on journal, evidence and external acknowledgements.
4. **N04** Expose Nova through `config/nexus/task-api.cjs` and `ui/nexus-controller/lib/index.js` without changing v1 CLI semantics. Retest startup-only composition, default mode preferences, stale/fake evidence, lost writes, teardown and no shell/fs/PTC/MCP access to protected task state.

**GO.** Exact authorized receipts, complete crash/replay coverage and zero false completion. **Rollback.** Disable Nova admission, retain journal and compatible readers. **Preserve.** Legacy task and registry contracts and the CLI's stable response schemas.

## P4 · Nova Simple and Sentry

**Owners.** B on Sentry, A on strategy and rollout. **Depends on.** P3, P2 parity and approved Sentry protocol/isolation/risk policy. **Effort.** 8–14 days, high.

1. **S01** Agree the v1 protocol and add `config/nexus/providers/sentry.cjs`, process fixtures and one trusted composition row. Supply scoped read-only snapshot, bounded JSON, cancellation/deadline and independent identity. Test killed/stuck reviewer, forged or late result, stale snapshot, wrong task/attempt/workspace and incomplete coverage.
2. **S02** Add `config/nexus/strategies/nova-simple.cjs`. Reuse Muse agent behavior. Run deterministic verification and required Sentry through the Nova completion gate. Repair with bounded budget and fresh receipts. Keep Muse's existing review policy separate. Simple selection has zero coordinator/classifier calls.
3. **S03** Add canary rows via `scripts/Build-NexusHomePatch.cjs` and readiness via registry/UI projections. Run GUI and CLI with synthetic transport and fake then approved real Sentry. Check equal outcomes on verification/review failure or operator hold. Evaluate authorized live review benchmarks separately.

**GO.** One implementing agent, zero coordinator calls, exact receipt binding and identical Controller decisions across clients. Required reviewer failure yields hold/failure. **Rollback.** Disable new Simple admissions, drain/park pinned cohort, retain its reader. **Preserve.** EMv1/EMv2, compaction and permissions.

## P5 · Nova Complex

**Owners.** A on `config/nexus/strategies/nova-complex.cjs`, B on `config/nexus/dsh-agents.cjs` and recovery. **Depends on.** X0 and P4. **Effort.** 8–14 days, high.

1. **X02** Productize the X0-proven activation path with independent worker preset, complete route, explicit work grant and exact disposal. Patch required composition rows through `scripts/Build-NexusHomePatch.cjs`. Reuse DSH jobs where appropriate.
2. **X03** Validate and persist coordinator plan, budget and one worker intent before dispatch. One initial planning call plus one bounded replan in the canary. Test orphaned intent, child crash during commit, parent cancel during setup and revoked worker route.
3. **X04** Exercise verify/Sentry, repair and repeated blockers on real pinned DSH with synthetic transport. Measure calls/cost per verified task under the benchmark plan.

**GO.** No unauthorized request, unowned agent, double attempt or double spend. Same completion contract as Simple. **Rollback.** Disable Complex for new tasks, drain/hold its cohort. **Preserve.** Lower modes and the stock AgentFactory.

## P6 · Nova Parallel

**Owners.** A on `config/nexus/strategies/nova-parallel.cjs`, B on `config/nexus/{worktrees,integration}.cjs`. **Depends on.** P5 and per-platform worktree isolation. **Effort.** 12–20 days, very high.

1. **P01** Validate acyclic plans, deterministic ready order, concurrency and budget, transitive failure and recovery. Reuse P5 worker port. Start with two active workers.
2. **P02** Compare DSH experimental worktree support with approved Git plumbing. Allocate exact base and allowed roots. Deny sibling worktrees, shared refs/config/hooks and external links. Record intent before spawn and quarantine uncertain artifacts.
3. **P03** Use one integration owner and deterministic import/conflict handling. Validate artifact origin/digest, reverify and review integrated snapshot, and compare destination state before publish. Test interrupted merge, conflict, stale base, dirty destination, duplicate artifact, saturation and partial cancellation.

**GO.** No escapes or unowned worktree, exact integrated-candidate receipts, proven restart/cleanup and measured performance. **Rollback.** Disable Parallel admission and preserve candidate artifacts while draining/quarantining. **Preserve.** Lower strategies and Controller completion authority.

## Consumer track · Arthur Studio

**Owners.** One Nexus developer and a Studio maintainer. **Depends on.** Stable P2 CLI and configured workspace grant. Nova/Sentry smoke follows P4. **Effort.** 1–3 days, low.

1. **K01** Use the [CLI example](NEXUS-CLI-CONTRACT.md#7-arthur-studio-usage-and-support-gates). Studio exports Markdown, saves a stable key, launches the installed Nexus binary with an argument array, records task/session IDs, then queries status/result. Keep the Nexus-side fixture in `tests/NexusCliStudioHandoff.Tests.cjs`. Studio product code belongs to its own follow-up.
2. **K02** Test missing file, rejected workspace, host unavailable, lost acknowledgement/retry, acceptance versus completion and actual Nova review hold after P4.

**GO.** CLI-only handoff with authorized workspace and truthful status. **NO-GO.** Consumer requires private DSH credentials, Controller imports or workspace grants derived from Markdown. **Rollback.** Stop the consumer invocation and keep accepted tasks observable. **Preserve.** Studio's knowledge ownership and Nexus's execution authority.

## Independent track · CCv2

**Owner.** Available engineer, separate lab. **Depends on.** P0. **Effort.** 4–7 days for Basic summary experiment. Full engine 3–6 developer-weeks if warranted, plus any fencing/storage work.

1. **F01** Preserve `config/ContextDurableMutationPolicyV2.cjs` and the deny in `scripts/ContextLifecycle.ps1`. Run `ContextRestrictedProductionV2`, `ContextRestrictedProjectionV2`, `ContextRestrictedDshCompaction` and V1 crash/acceptance. If extracting projection hooks from `AihController.cjs:3321–3369`, preserve fallback request bytes and route boundary.
2. **F02** In a lab preset, use Basic's summarizer subclass and read-only CCv2 compiler/retrieval modules. Compare `ContextCompaction.cjs`, `ContextGenerationRuntimeV2.cjs` and `ContextActiveApplyV2.cjs` for functionality outside the summary seam. Test command, pressure, switch, overflow and tool-pair replay.
3. **F03** Port 0.1-pinned lab probes and short-lease negative controls to 0.2 fixture APIs. Exercise suspension/takeover/kill/append/flush/finalization/recovery. Distinguish lifetime ownership from a revocable epoch. Full engine research follows ownership and replay proof.

**GO for lab.** Production deny byte-identical and valid replay with nonmutating CCv2 inputs. **NO-GO for durable production.** Missing writer/finalization proof, benchmarks or approval. **Rollback.** Use Basic for new sessions and preserve compatible readers. **Preserve.** V1 bridge, historical negative evidence and independent scheduling.

## Two-developer critical path

- **First milestone.** A owns B01/B03/B04 and B owns B02. Deliver pinned synthetic Dual and Muse traces, a Web-without-browser composition/readiness proof, the managed mutation inventory and task API/ownership fixture contracts. P1 is the first runtime code milestone.
- **Shared foundation.** A owns C01–C03 and B owns C04. B starts X0 while the P1 bridge settles, then moves to journal/evidence fixtures. Failed X0 blocks P5 only.
- **Parallel after P1.** A leads L01–L04. B starts P3's journal/evidence reducers and Sentry protocol fixtures once the P2 task API is frozen. P2 ships legacy mode support independently. Studio smoke can follow immediately.
- **Nova path.** Join P2 and P3 for P4's shared-host canary, then P5 and P6. P0–P4 total 35–60 developer-days excluding X0, partner waits and platform-specific fixes. Plan 5–8 calendar weeks with two developers and sequential gates. CCv2 runs when capacity permits.

**Release rule.** A NO-GO freezes new admissions for the affected cohort. Preserve readers and evidence while resolving the failing seam. P1 delivers the plugin foundation, P2 the first usable CLI, and P4 Nova Simple with Sentry.
