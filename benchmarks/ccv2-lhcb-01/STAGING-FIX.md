# Isolated runtime staging defect: fix and verification

CCV2-LHCB-01 isolated runtime dependency closure VERIFIED.
OC01 native-tail plumbing dry-run PASS.
LIVE PROVIDER CERTIFICATION NOT YET RUN.

Scope: `benchmark/ccv2-lhcb-01`, harness HEAD
`ec2ccf28d14a00d855a6f25c458ec1b13750dca8`, plus the uncommitted fix listed below.
Production authority remains `081c54070ee0ae62a8ae303bbcde9f930174cbed`.

## Root cause and reproduction

`init.cjs` applied `S.secretName(relativePath)` to immutable runtime code while
copying dependency trees. That mutable-state filter matches any path component
containing `credentials` or `secrets`. It therefore discarded entire executable
packages, including `@deepseek-ai/dsh-credentials` and
`@deepseek-ai/dsh-credentials-local`, despite their presence as real directories
in the offline source. This was a class of omissions, not two absent npm installs.

Doctor checked the session codec, PowerShell file and runtime marker without
importing the Muse stack. Those checks passed for the incomplete graph.
The added regression first failed at the staged Muse import (1 failed, exit 1).
After adding behavioral doctor checks, the old root reported:

```json
{
  "ready": false,
  "reason": "dependency-import-failed",
  "missingPackages": [
    "@deepseek-ai/dsh-credentials",
    "@deepseek-ai/dsh-credentials-local",
    "@deepseek-ai/dsh-llm-pi-ai"
  ]
}
```

## Exact files changed

Modified:

- `scripts/bench/ccv2-lhcb/init.cjs`
- `scripts/bench/ccv2-lhcb/doctor.cjs`
- `benchmarks/ccv2-lhcb-01/grader/offline.cjs`
- `tests/Ccv2Lhcb.Tests.cjs`
- `benchmarks/ccv2-lhcb-01/RUNBOOK.md`
- `benchmarks/ccv2-lhcb-01/REVIEW.md`

Added: `benchmarks/ccv2-lhcb-01/STAGING-FIX.md`.

## Fixed staging and behavioral readiness

The strategy is faithful offline copying of the full approved dependency trees,
not a hand-maintained closure and not a pair of package exceptions. Sources are
only `app/package.json`, `app/package-lock.json`, `app/node_modules`,
`runtime/node` and `runtime/pwsh` in the existing normal installation. Neither
its data nor credential stores are eligible. The state/snapshot secret filter
remains intact; it is no longer used for immutable package code.

Both app manifests must match the frozen runtime manifests before copying.
Traversal validates dependency links before any copy, rejects escapes and
cycles, then dereferences bounded links. Approved destinations are replaced
rather than merged, preventing stale modules during permitted restaging. Root
ownership/safety and the existing before-experiments restriction remain enforced.

Before writing the staged marker, init runs the same import probe used by doctor.
The probe executes the isolated `runtime/node/bin/node`, checks the pinned version,
resolves from its `app/package.json` through `createRequire`, and dynamically
imports the resolved ESM or CommonJS entrypoints. It covers cordis, session codec,
both credentials packages, the actual `dsh-llm-pi-ai` provider entrypoint and
additional OC01 imports (LLM, agent, loop, tools, system prompt, invariants, YAML).
The session codec must also expose `decodeStorageRecord`.

The child has a stripped environment without credential values and an explicit
network blocker. It does not create provider plugins or requests. Failure reports
safe package identifiers; raw import exceptions/output are not returned. A new
subprocess allowance permits an isolated byte-identical copy of the test Node
only when the same offline blocker is explicitly preloaded. Other command and
network restrictions remain in force.

## Regression coverage

The permanent suite now has 34 tests. The two added tests cover:

1. Construct an isolated root and copy the actual approved offline runtime through
   the same helper used by staging. Independently import the five requested Muse
   authorities with its own pinned Node. Verify doctor readiness. Remove
   `dsh-credentials` from that temporary installation and verify readiness becomes
   false, with deterministic identification of the missing package and affected
   provider import. No user credential store is used.
2. Copy credential/secrets-named code and a bounded directory alias, proving the
   copy retains code while excluding source data. Reject a link into source data,
   a dependency cycle and mismatched package manifest before copying.

Existing fake-runtime fixtures now supply a Node executable for the behavioral
probe; no assertion or correctness gate was weakened.

## Executed gates

| Gate | Result and evidence |
|---|---|
| New regression before fix | FAIL as expected: staged Muse dependency import failed; exit 1 |
| New regression after fix | PASS: 1 passed, 0 failed, 0 skipped; zero network attempts |
| Full LHCB suite | PASS: 34 passed, 0 failed, 0 skipped; 259008.212562 ms; zero network attempts |
| Focused final new regressions | PASS: 2 passed, 0 failed, 0 skipped; 38000.406803 ms; zero network attempts |
| Recreate default root using fixed init | PASS, exit 0 |
| Recreated doctor and status | PASS, exit 0; runtime ready true, missingPackages empty, source guard pass true |
| Staged full app dependency tree vs offline source | PASS: 31,275 files compared by SHA-256, no differing paths |
| OC01 native-tail dry-run | PASS, exit 0; no certification written to the isolated installation |
| Normal Nexus sentinel | PASS: settings/policy/binding hashes and credential-store stat metadata unchanged |
| Protected production diff | PASS, exit 0, no output |
| Syntax checks of changed init/doctor | PASS |
| `git diff --check` | PASS, exit 0 |
| Live provider certification / benchmark | UNVERIFIED: deliberately not run |

Commands:

```sh
/home/kaloyan/.local/share/nexus/runtime/node/bin/node --test tests/Ccv2Lhcb.Tests.cjs
PATH=/home/kaloyan/.local/share/nexus/runtime/node/bin:$PATH node --test --test-name-pattern='offline staging preserves|dependency staging preserves' tests/Ccv2Lhcb.Tests.cjs
/home/kaloyan/.local/share/nexus/runtime/node/bin/node scripts/bench/ccv2-lhcb/cli.cjs init
/home/kaloyan/.local/share/nexus/runtime/node/bin/node scripts/bench/ccv2-lhcb/cli.cjs doctor
/home/kaloyan/.local/share/nexus/runtime/node/bin/node scripts/bench/ccv2-lhcb/cli.cjs status
git diff --check
git diff --exit-code 081c54070ee0ae62a8ae303bbcde9f930174cbed -- config scripts/lib scripts/CCv2-ActivationReplay.cjs scripts/OC01-OpenCodeMuseCanary.cjs scripts/OC01-NativeTailLive.cjs runtime ui bin
```

The old marked root was removed only after verifying no sessions, certification,
credentials, runs or snapshots. The replacement was created through normal init;
no manual package additions were used. The full dependency-tree comparison also
confirms copied modules were not silently omitted or fetched.

## Recreated root and OC01 dry-run

Root: `/home/kaloyan/nexus-bench/ccv2-lhcb-01`.

```json
{
  "runtime": {"ready": true, "reason": null, "missingPackages": []},
  "sourceGuard": {"pass": true, "differingPaths": []},
  "certification": {"health": "QUARANTINED", "state": "missing"},
  "liveReady": false
}
```

The actual frozen OC01 script ran under the isolated pinned Node with
`--dry-run-native-tail 1`. Its environment was stripped of credentials and a
separate temporary preload allowed only localhost sockets while rejecting
external sockets, DNS, fetch, UDP and subprocesses. The strict all-network blocker
used by the unit suite cannot be used for this dry-run because OC01 intentionally
uses a scripted HTTP loopback upstream. The extra audit line follows OC01's final
line; no production script was changed:

```text
CCV2-OC01 native-tail DRY RUN — PASS (no certification written)
LHCB external-network audit: 0 attempts; 2 loopback connections
```

The dry-run recorded four scripted upstream requests, three compiled requests and
zero conformance anomalies. Its local test counters used the production dry-run
transport, not an external provider. A post-run check confirms no installed
certification, credentials, durable sessions, benchmark runs or snapshots.

Aggregate JSON and safe test/dry-run logs are saved under the root's
`state/verification.json` and `state/verification/`, including the temporary
loopback guard for reproducibility. No source code in protected production paths
changed, no npm/pnpm/npx install or fetch was used, and no push or commit occurred.
Future live certification still requires operator credentials in the isolated
installation and the full provider canary. The live benchmark remains unexecuted.
