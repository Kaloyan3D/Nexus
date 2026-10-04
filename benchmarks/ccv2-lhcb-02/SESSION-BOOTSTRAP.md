# LHCB-02 controller session boundary

Production freeze: `e0282c11d5bee29359c277cd5a9568ca13d62885` (`e0282c1`). This identity excludes benchmark commits. The identical cherry-picked production change is present on the benchmark branch. LHCB-01 keeps its own freeze and adopted-session behavior.

1. Truth: production `prepareSession` owns the seven session/task/route authority fields. SessionStore and its JSONL backend own blank session persistence. The benchmark independently reads normal state and records identity only after agreement.
2. Ownership: the adapter writes no task ledger, binding, route, manifest or native authority. Its worker invokes the staged controller. Only benchmark journal and binding-observation receipts are benchmark-owned.
3. Direction: benchmark imports the stable production API from the isolated staged runtime. Production knows nothing about this adapter. LHCB-01 infrastructure is reused through the existing explicit dependency seam without edits.
4. Boundary: the worker accepts a known root/session ID and bounded create/prepare operation, returns the public seven fields only, and fixes the request to aih-muse / muse-spark-1.3-contributor-opencode. No prompt or agent is constructed.
5. Failures: wrong runtime, cwd, profile, target, task identity, nonzero initial attempt, missing diagnostic, malformed state or attempted network activity reject before intent. Errors use bounded codes; logs do not contain prompts or credentials.
6. Lifecycle: creation READY → CREATING → normal durable DSH session → CREATED → production preparation → verified identity persisted → PREPARED → T00 READY → SUBMITTED. A known CREATING session can be loaded; repeated preparation recovers its original task instance. SUBMITTED intent is never resent.
7. Tests: runner doubles own explicitly offline fixtures; the separate adapter suite uses real staged controller/PowerShell/SessionStore persistence. Fault hooks bracket session creation, preparation and identity commit. Network transports are blocked in the preparation worker.
8. Compatibility: old journal/root contract seals fail closed. Historical roots ending 20261004 and 20261004-02 are refused, never modified or retried. Rollback uses a separate fresh root with its matching frozen runtime; no migration rewrites historical records.
9. Observability: production nexus-session-prepared and benchmark journal identity must agree. Creation phase identifies bootstrap failures separately from stage failures. Provenance still requires the exact user/RPC event and containing successful turn; controller-error blocked messages are invalid.
10. Security: isolated paths and source guard precede preparation; network transports are denied, no credentials are logged, and exact provider/model selection has no fallback. Calibration still needs normal valid OC01 certification for this new production core. No LHCB-01 certification is adopted by default.

The acceptance probe is a separate bootstrap-only operation on a new throwaway root. It stages e0282c1, creates a blank session, prepares/verifies production authority and records identity, then stops. It neither certifies nor submits T00. Live calibration remains blocked pending fresh normal OC01 certification; no calibration is authorized by this task.

The persistence backend deliberately materializes sessions on the first event. The adapter records only the normal `agent-preset/selected` event and uses `SessionStore.flush`; a resumed SessionStore may add its normal `session/end-seed` marker. These two content-free events are the only pre-prompt events allowed. Durable read-back uses the backend's `meta` header. Neither event is prompt/RPC evidence, and neither can satisfy T00 provenance.

A fresh runtime records its production SHA and staging time. Normal certification must be issued after that staging boundary. Explicit portable provisioning additionally requires matching frozen source/core hashes and stores matching-core provenance; older LHCB-01 certificates cannot cross this freeze boundary. The default LHCB-01 source is disabled.

Bootstrap-only acceptance command (new root required): `node scripts/bench/ccv2-lhcb-02/cli.cjs bootstrap-probe /absolute/new/throwaway-root`. Use pinned Node 24.18.1 with the provider/network blocker. This command does not obtain certification, start the DSH RPC server, or run calibration. It writes a verified PREPARED journal with no T00 stage.

A fresh staged runtime may omit the lazy sessions directory. The runner treats absence as empty before normal SessionStore creation, while refusing an existing populated session tree. It never creates production authority to repair this condition.
