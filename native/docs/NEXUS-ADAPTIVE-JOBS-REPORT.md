# Nexus Adaptive + Background Jobs — Integration Report

**Branch:** `feature/rust-native-core` · **Local commits only, no push/merge**

## Verdict

`nexus-adaptive-v1` is now the unified coding engine: adaptive reasoning,
the reasoning-signals tool, and the four native Background Job tools in one
frozen catalog, through the existing Desktop Adaptive workflow. No new
permanent user-facing engine was created, and no user has to choose between
"Adaptive" and "Jobs".

## Architecture decisions

- **One new frozen profile, not a new engine.** `ToolProfile::RepoCodeAdaptiveJobsV1`
  (`native/nexus-model/src/repo_tools.rs`) = the six coding tools +
  `muse_update_reasoning_state` + `job_start`, `job_status`, `job_logs`,
  `job_stop` (11 tools). Frozen digest
  `d8650029799af93456f31c0c9b42cafeab46afc88490ada1197ed50105a87ecd`.
- **Historical catalogs are byte-identical** (pinned in tests):
  `RepoInspectV1` `b06d9c9f…`, `RepoCodeV1` `e464de5c…`,
  `RepoCodeMuseSignalsV1` `7c7c9bc1…`, `RepoCodeJobsV1` `18168580…`.
- **Mapping:** `engine::tool_catalog_profile` maps the exact id
  `nexus-adaptive-v1` to `RepoCodeAdaptiveJobsV1`; the experimental signals
  engine still maps to `RepoCodeMuseSignalsV1`, `muse-v0-jobs` still maps to
  `RepoCodeJobsV1`, other coding runs to `RepoCodeV1`, read-only to
  `RepoInspectV1`. Desktop needed no change: the existing Adaptive mode
  already selects this engine, and the catalog follows from the sealed
  engine identity.
- **Explicit migration, conversation-scoped.** At run start (before catalog
  verification/binding), the broker checks the conversation's earliest run
  record: if it recorded the historical signals digest, the conversation
  keeps `RepoCodeMuseSignalsV1` for all its runs. New conversations adopt
  the unified catalog. The catalog is chosen once per run from the sealed
  engine identity plus this migration rule and is bound for the whole run —
  never changed in response to model text or mutable permissions, so
  provider tool bytes stay stable for prompt caching.
- **Authority unchanged.** The job tools are broker-handled (no Kernel tool
  id, like the signals tool) and dispatch through the existing validated
  `crate::jobs` interface and broker-owned JobManager: Direct Workspace,
  frozen standing grants, authorized `devPorts`, sandbox isolation,
  revocation/cancellation, and the Direct writer-lease coordination all
  apply exactly as before. Offering the tools grants nothing — an
  unauthorized exposed port fails closed with the grant/dev-port reason.
- **Governor preserved.** Signals handling (`Shared.signals`) is enabled for
  the new profile exactly as for the signals profile; reasoning-state
  handling, effort limiter, and per-attempt issuance are untouched. The s6
  Governor and s7 A614 budget tests pass against the unified catalog, still
  under the sealed 440,000 B budget / 450,000 B guard.
- **Receipt-grounded completion.** `job_start` joins the unverified-claim
  ledger: a refused/failed/cancelled start blocks a verified-completion
  summary until a real executed start (or other genuine execution evidence)
  supersedes it; `job_status`/`job_logs`/`job_stop` are queries, not claims.

## Request-size overhead

- Canonical tool bytes: signals catalog 7,686 B → unified catalog 9,599 B.
- **+1,913 canonical bytes per Adaptive request** — exactly the four job
  definitions, nothing else moved (measured and pinned in
  `the_adaptive_jobs_catalog_is_signals_plus_jobs_and_history_is_unchanged`).
- Token overhead is tokenizer-dependent; at roughly 4 chars/token this is
  on the order of ~0.5k tokens per request. This is an approximation, not a
  provider-measured token count; no live provider call was made.

## Tests actually run

- `cargo test -p nexus-model` — pass (includes catalog digest/byte pins).
- `cargo test -p nexus-broker --lib` — 303 passed, 0 failed, 7 ignored.
- Focused broker tests — `aj_`, `s6`, `s7`, `em04c1`, `m71_`, `demo_`:
  pass, including the two new acceptance tests:
  - `aj_adaptive_runs_signals_and_the_full_job_lifecycle_on_a_real_server`:
    signals call, unauthorized port 9999 refused with dev-port reason,
    authorized `job_start` on 4321 with real bridge URL, host HTTP fetch
    through the bridge, status/logs, file edit observed by foreground tools
    while the server runs, `job_stop`, AdaptiveJobs digest on the run
    record, provider bodies carrying both `job_start` and
    `muse_update_reasoning_state`, completion not marked unverified after
    the authorized lifecycle supersedes the refused start.
  - `aj_an_existing_conversation_keeps_its_signals_catalog`: a conversation
    whose first run recorded the signals digest stays on signals; its
    provider bodies never offer `job_start`.
- Revocation/cancellation behaviour is covered by the existing M7/M7.1
  broker and tools suites (e.g. `m71_b_job_outlives_its_run_until_the_grant_is_revoked`),
  all passing in the full battery; the AJ test itself covers unauthorized
  execution failing closed rather than a separate mid-run revocation.
- **Full workspace battery** on executable source `51f3641`:
  `NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace` — **1506 passed,
  0 failed, 64 ignored**.
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
  `cargo fmt --all --check` — clean.
- Prodgate (`tools/prodgate`) — pass, with the production-gate pin updated
  to the unified catalog and all five frozen digests verified.
- Tauri (`apps/nexus-desktop/src-tauri`) — pass.
- Desktop — `npx tsc --noEmit` clean, `npx eslint src` clean,
  `npx vitest run` — 21 files, 188 tests passed. No Desktop source change
  was needed.

## Provider-body regression

Dump (`NEXUS_BODY_DUMP_DIR`, code_a56: 225 passed, 195 test files, 1742
bodies) checked against `M8.1-EG-BASELINE.json`: 301 differences, fully
classified — 299 skeleton diffs across 19 adaptive-engine tests plus the 2
new `aj_` tests. Independent proof: removing exactly the four job tools
from each differing body reproduces the EG baseline skeleton for **299/299**
bodies; every affected body carries the single 11-tool array. New versioned
baseline minted as `test-vectors/provider-bodies/M8.1-AJ-BASELINE.json`
(source `51f3641`) and verified `BASELINE MATCH`; all older baselines are
preserved untouched.

## Known limitations

- Token overhead is an approximation from byte size; no live provider
  token measurement was run.
- Conversation grandfathering keys on the earliest stored run's
  `toolCatalogDigest`; run records predating digest recording (absent
  digest) adopt the unified catalog on their next run.
- The pre-existing `muse-v0-jobs` engine/mode remains in the registry as
  historical implementation; Adaptive is the unified surface and no new
  permanent engine was added. Retiring the old jobs mode is a separate
  product decision.
- Jobs remain offline-network-class (Controlled-Internet jobs unsupported),
  and the Git metadata creation-window limitation from M6/M7.1 is unchanged
  and still explicitly reported, not prevented.
- Watch-style servers (`next dev`, `cargo watch`, Kestrel) remain untested
  as job payloads; the acceptance server is a real Node HTTP server.

## Commits

- `bc5d81d` — feat(native): Adaptive+Jobs catalog
- `340a839` — test(native): Adaptive+Jobs acceptance
- `b49d865` — test(native): s6/s7 digest pins follow the unified catalog
- `51f3641` — style(native): rustfmt (final executable source)
- `5839173` — test(native): M8.1-AJ provider baseline + prodgate pin

**Final executable source SHA: `51f3641`.** Later commits change tests,
baselines, and this report only.
