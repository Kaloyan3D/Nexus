# EM-04C2 S10 — `RegistryR74RollbackRecovery` investigation

Tree: `~/Projects/Nexus-s10-preflight` (base `d90bbf0faa29da89e4883f126b321cbba278320c`), uncommitted. Baseline worktree for comparison: `~/Projects/Nexus-r74-baseline-d90bbf0` (new, detached at `d90bbf0`; no other worktree modified). Activation untouched (`MUSE_V1_PRODUCTION_ENABLED = false`, adaptive mode dormant, no rename, no provider).

## 1. Verdict
**CHANGES REQUIRED (narrow).** No evidence that request-boundary authorization is bypassed. One of three observed failures is fully diagnosed: the bundled PowerShell/.NET host crashed inside a controller CLI and the Native controller **refused** (fail-closed). The other two earlier failures were not diagnosable (their error text was not captured) and the underlying host fault is unexplained. The suite is not shown to be deterministic-green; I do not claim it is.

## 2. Reproduction commands
```bash
# lock-file-pinned dependencies, offline, local npm cache only (no network)
P=$HOME/.cache/s10-pinned-app; N=$HOME/.local/share/nexus/runtime/node
mkdir -p $P/runtime $P/app && cp -r runtime/{package.json,package-lock.json,patches,vendor} $P/runtime/ && cp runtime/package*.json $P/app/
PATH=$N/bin:$PATH $N/bin/node $N/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev --legacy-peer-deps --offline --prefix $P/app
# full disposable-environment run (preflight tree, or the baseline worktree with --suites '^tests/(Muse|Registry|Native|Controller|Aih)[A-Za-z0-9]*\.Tests\.cjs$')
NEXUS_JSENV_APP=$P/app node scripts/EM04C2-JsEnvironment.cjs --out ~/.cache/<dir> --report <file.json>
# R74 alone, in a kept environment
node scripts/EM04C2-JsEnvironment.cjs --keep --out ~/.cache/<dir> --suites '^tests/RegistryR74'
```
Same Node (bundled 24.18.1), pwsh 7.5.3, suite order (sorted names, serial), pinned app for every run below. The suite itself runs its scenarios in batches of 2 concurrently (`RegistryR74RollbackRecovery.Tests.cjs`, `main`), each spawning pwsh `Task.ps1` hosts and fresh node children.

## 3. Results: baseline vs preflight (full pinned runs)
| Tree | Runs | R74 result |
|---|---|---|
| `d90bbf0` baseline | 4 (1 + 3) | **pass 4/4** (3 other suites env-UNVERIFIED: no `native/target` in that worktree; unrelated) |
| preflight, before diagnostics | 3 | **fail 3/3** (system toolchain; pinned; S9-era tree earlier also failed R74/R75 as "transient") |
| preflight, with diagnostics | 5 | fail 1/5 (loop run 1), pass 4/5 |
| preflight final tree | 1 | pass (54/54) |
R74 alone: 0 failures in 10 runs (5 + 3 final + earlier). R74 after the preceding suite list (replayed in order): pass. CPU load (8–14 busy loops) produced failures of a *different* kind (pwsh `Task.ps1 create-task` "Command failed"); moderate load (4 loops) did not reproduce. The failure rates are too low and too different between sessions to attribute any rate difference to the tree: baseline 0/4 vs preflight 1/5 in the diagnosed set is not significant, and the first three preflight failures happened the same day on a busier machine. **The suite is flaky; it is not shown to be tree-specific, and it is not shown to be pre-existing in the full run either** (a flake of this rate would pass 4/4 in about half of cases).

Failing check differed every time, so it is not one deterministic assertion:
1. `R75A actual request boundary rejects drift after pre-step`: `{"kind":"reject","errorCode":null,"request":null,"nextCount":0,"attemptsDelta":0}` — **rejected** (no request reached `next`), but with no error code. Error text not captured.
2. `G genuine legacy stays compatible…`: `Expected values to be strictly equal`. Not captured further.
3. (diagnosed) `F pending snapshot without route completion remains refused ON…`: the controller diagnostic was
   `binding-validation-inconclusive … task identity could not be validated: aih-controller: Task.ps1 failed (exit unknown): Unhandled exception. System.IO.FileLoadException: The given assembly name was invalid. File name: 'System.Runtime.Serialization.Formatters, Version=8.1.0.0, Culture=neutral, PublicKeyToke<garbage byte>'`
   i.e. the **PowerShell host process crashed** while loading an assembly whose name string was corrupted in memory. The run was refused; the test expected the specific code `registry-binding-mismatch`.

## 4. Classification
* (1) real authorization failure: **no evidence**. In every captured failure the boundary refused (`reject`, nothing reached the model pipeline, 0 attempts); none observed an *allowed* outcome. R74 contains the deterministic fail-closed controls for inconclusive identity (`F inconclusive task identity preserves Registry state and rejects with either flag`) and corrupt authority.
* (4) independent cause, evidenced for failure 3: host runtime fault in bundled pwsh 7.5.3 / .NET (corrupted assembly-name string). Not reproduced by 200 concurrent assembly loads (4-way) or 240 concurrent cold-cache module imports (6-way, fresh HOME each round), no MCE/EDAC kernel messages. The **trigger of the host fault is unknown**; a memory-corruption signature suggests a runtime or environment problem, not repository code. Failures 1 and 2 are plausibly the same family (a code-less exception in the child; a controller CLI failing under the same conditions) but that is inference, not evidence.
* (2) harness isolation / (3) async assertion error: not supported by the evidence; scenario fixtures use separate roots; I found no shared mutable state, but did not exhaustively prove its absence.

## 5. What changed (no assertion weakened, no expected code changed, no retry)
* `tests/RegistryR74RollbackRecovery.Tests.cjs`: the child process now also prints `errorMessage` (stack, 600 chars) for a rejected request; **diagnostic only, never asserted on**, so a code-less rejection can be explained next time.
* `scripts/EM04C2-JsEnvironment.cjs`: failing suites now keep `outputTail` (6,000 chars) in the report; the failure-class table moved to `scripts/lib/em04c2-gate-lib.cjs` (`JS_ENV_CLASSES`, `classifyJsFailure`). New class `env:pwsh-host-runtime-fault` (a `Task.ps1` failure with `Unhandled exception. System.…`): such a suite is **UNVERIFIED (exit 3), never PASS and never silently retried**; a lock-file version mismatch, any authorization outcome and every other assertion remain **REAL**.
* `tests/EM04C2GateNegativeControls.Tests.cjs`: +1 check (14 total) pinning exactly that classification boundary.

## 6. Final validation matrix (exact final tree, uncommitted)
| Check | Result |
|---|---|
| R74 alone ×3 (kept env) | 3/3 pass (36/36 scenarios each) |
| Full lock-file-pinned JS suite (54 suites incl. all Registry/Native/Controller/Aih and R3UI, NativeTargetV2, R74/R751) | **54/54 pass** (0 REAL, 0 UNVERIFIED) |
| Release gate (all sections, `--bodies`, negative controls) | **PASS (acceptance run)** |
| `cargo fmt --check`, strict clippy (workspace, prodgate) | clean |
| Full offline workspace battery `NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast` | **1,232 passed / 0 failed / 57 ignored** (91 result lines) — one run on the final tree (Rust sources unchanged since the earlier identical run) |
Initial failures were reported above (3/3 before diagnostics; 1/5 after); the passing reruns are additional samples, not a replacement of those failures.

## 7. To close
Either (a) capture one more failure with the new `errorMessage`/`outputTail` and confirm it is the same pwsh host fault (then it is classified `env:pwsh-host-runtime-fault`), or (b) the owner accepts R74 as an environmental flake of the bundled PowerShell host, with the new UNVERIFIED-not-PASS handling. The separate requirement of two consecutive green batteries on the exact S10 activation commit is unchanged.
