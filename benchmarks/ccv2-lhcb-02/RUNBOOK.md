# Runbook

Use the existing pinned executable; the CLI rejects other Node versions. The following command is the first live calibration run (not executed in this delivery):

```sh
/home/kaloyan/nexus-bench/ccv2-lhcb-01/nexus-root/runtime/node/bin/node /home/kaloyan/Projects/Nexus/scripts/bench/ccv2-lhcb-02/cli.cjs calibrate /home/kaloyan/nexus-bench/ccv2-lhcb-02-calibration-01
```

Inherit OPENCODE_API_KEY and MODEL_API_KEY through the environment using the established LHCB-01 credential authority. Do not write them into fixture, receipts or command arguments. The command prepares the isolated root, stages the local runtime, validates frozen source/thresholds/certification, starts its owned process, then submits T00 and six engineering phases. Port readiness and ownership are enforced by the existing transport. Reuse this command for interruption recovery; a submitted intent is inspected, never retransmitted. An intent persisted before its RPC may have no durable user event; this stays unresolved and fails closed. Start a new throwaway calibration after investigating, rather than clearing or resending that intent.

`prepare ROOT` creates fixture/runtime source layout with no provider calls. `command ROOT` emits the live command. `status ROOT` reads an existing report. Official run, arms, checkpoint loops and arbitrary stages are not CLI options.

Outputs: state/calibration-journal.json, state/release-E*.json, state/request-telemetry.json, reports/calibration.json. Durable original session evidence lives solely in the isolated runtime. Review content-free acceptance criteria and workload hypothesis before freeze. A PASS still leaves WORKLOAD_INADEQUATE / INSUFFICIENT_DATA / NOT_MEASURED until the missing progressive checkpoint/restore, final integration grader and tool isolation are implemented and independently verified. Matching metadata alone is insufficient.

Offline verification:

```sh
/home/kaloyan/nexus-bench/ccv2-lhcb-01/nexus-root/runtime/node/bin/node --test tests/Ccv2Lhcb02.Tests.cjs tests/Ccv2Lhcb02.AutoRunner.Tests.cjs
```
