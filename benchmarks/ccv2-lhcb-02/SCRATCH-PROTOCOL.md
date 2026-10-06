# LHCB-02 scratch protocol revision 1

Official15 remains permanently INFRASTRUCTURE_INVALID under its old frozen protocol. It nevertheless established natural CP-500 at E43/480825. This new revision separates legitimate temporary engineering diagnostics from persistent source mutation; every new claim requires new hashes, fresh calibration and three completed arms. No old snapshot authorizes this revision.

## Architecture review before implementation

1. Source of truth: benchmark scratch.cjs owns the path, inventory and deterministic lifecycle. Durable session events remain execution authority; scratch is not implementation authority.
2. Ownership: host runner creates/resets one owned directory outside workspace; candidate writes temporary diagnostics there only. Persistent implementation edits remain src only. Runtime-owned .ai-harness and Git state retain their existing exclusions.
3. Dependencies: calibration, official runner, namespace isolation and snapshot selection consume the scratch policy. The policy depends only on benchmark filesystem primitives; production has no dependency on it.
4. Boundary: LHCB_SCRATCH names the candidate-visible absolute scratch directory. Inventory receipts contain hashes/counts, not source additions. Scratch bytes never cross into candidate snapshots or grader inputs. Arbitrary repository-root probes remain failures.
5. Failures: symlinks, hardlinks, special files, malformed paths and nonempty scratch at seal/restore fail closed. No protocol failure retries or automatic candidate repair. Cleanup follows only validated ownership and never follows links.
6. Lifecycle: create on namespace start; reset contents before each prompt; inspect after durable completion; record receipt and reset before grading/checkpoint. Restore starts with empty scratch. On abnormal exit retain scratch in the failed root for diagnosis; a new attempt begins empty.
7. Test seams: real temporary directories and actual namespace execution; no provider or timing sleeps. Unit snapshot inputs remain explicitly synthetic, never scientific evidence.
8. Compatibility: official15 and older artifacts are read-only historical records. New prompt contracts/hash identity intentionally differ. No production, obligation, algorithm or provider-policy change; rollback is the archived old revision, not reuse of its live checkpoint.
9. Observability: per-stage scratch receipts report created file count and hashes, empty reset verification; source hashes and provider metrics remain independent. An empty final scratch directory is required at CP sealing.
10. Security: scratch cannot expose host reports/graders/credentials. Symlinks and hardlinks are rejected; path resolution rejects traversal. Candidate source aliases to scratch are rejected by existing no-link inventory. Persistent additions/deletions/mutations outside src still fail; no arbitrary repository write exemption.

## Candidate contract

Persistent implementation edits belong only in src/. Use $LHCB_SCRATCH for temporary scripts, Python probes, generated diagnostic input/output and ad-hoc verification programs. Repository-root probes are forbidden. Scratch resets before and after EVERY phase, including T00/T99, identically for all arms. Never depend on scratch across phases or arms; never move/link scratch files into persistent candidate output. Scratch is outside candidate source, excluded from grading and all snapshots. Do not use symlinks, hardlinks or path traversal to escape the supplied scratch boundary.

Engineering algorithms, 46 phase count, correctness obligations, production source and thresholds remain unchanged. Provider failures retain the existing bounded identical policy. No E47+ pressure expansion is part of this revision.
