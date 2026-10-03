# Candidate runbook

UNFROZEN / LIVE_CALIBRATION_REQUIRED. Use the pinned Node 24.18.1 executable. All commands below are offline except the existing `calibrate` command, which is not authorized or run in this delivery.

```sh
NODE=/home/kaloyan/nexus-bench/ccv2-lhcb-01/nexus-root/runtime/node/bin/node
CLI=/home/kaloyan/Projects/Nexus/scripts/bench/ccv2-lhcb-02/cli.cjs
$NODE $CLI inspect
$NODE $CLI reconstruct /tmp/ledger-lab-v2-candidate
$NODE $CLI grade-candidate /tmp/ledger-lab-v2-candidate
```

`inspect` reports content-free phase counts, bytes, fingerprints, graph fan-in/out, edge distance and hidden-probe coverage. All byte counts are NON-AUTHORITATIVE; no token/pressure estimate is fabricated. `reconstruct` requires an empty directory and builds every release in order, with no installed dependencies or network. The reconstructed fixture contains deliberate defects: grading it should FAIL. Fix source before expecting candidate correctness to pass; the reference positive control exists only outside the released fixture in offline tests. `grade-candidate` checks all phases, immutable artifacts, hidden probes and final integration. Its report never grants official benefit eligibility.

`candidate.phaseAcceptance` accepts a pre-work inventory and original source/incident tool results, verifies inspection fingerprints, code changes, immutable prior files and cumulative checks. All phases permit implementation; review phases add automated review checks. Live runner integration must bind these inputs to durable authority, not arbitrary caller receipts. Existing six-phase calibration retains hardened RPC/idle/flush/prefix semantics and never resends unresolved submitted intent. Old contract roots must be recreated.

`candidate-snapshot` checks offline byte-equivalent workspace/state/durable clones before arm policy configuration. It does not produce a runtime CP-500 checkpoint or prove resumed live history. Official run/arms/checkpoint/restore remain unavailable. Keep credentials out of fixture files and commands. Investigate incomplete intent, then use a fresh root rather than clearing/resending it.

```sh
$NODE --test tests/Ccv2Lhcb02.Tests.cjs tests/Ccv2Lhcb02.AutoRunner.Tests.cjs tests/Ccv2Lhcb02.Workload.Tests.cjs
$NODE --test tests/Ccv2Lhcb.Tests.cjs tests/Ccv2Lhcb.AutoRunner.Tests.cjs
```

Before live calibration: validate meaningful evidence depth, native decision telemetry availability and tool confinement. Full official execution also needs progressive durable runtime snapshots/restore and natural pressure measurement. A passing offline candidate is not a frozen or calibrated benchmark.
