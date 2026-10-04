# Runtime pressure-lock inventory race

Official run5 reached a genuine CP-500 at E37 (480239 tokens), then stopped during E41's host immutable-evidence inspection. A normal runtime writer removed `.ai-harness/runs/TASK-0001/context-pressure.lock` between directory enumeration and file reading. The failed run remains infrastructure-invalid; its checkpoint is not reused for a comparison. A separate post-failure E01–E41 diagnostic passed every public and holdout gate. E42 and T99 were not executed.

The scanner already excluded `.ai-harness/**` from the protected hash result, but traversed it before applying that exclusion. The correction applies the existing directory exclusion before traversal. It does not catch or suppress missing fixture files, add retries, wait for unrelated writers, change the phase lifecycle, change production code, or change workload inputs or thresholds.

Architecture review:
1. Source of truth: public fixture evidence/tools and host contracts own immutable benchmark inputs; candidate src owns implementation.
2. Ownership: normal runtime owns generated `.ai-harness` state and transient locks; that state is outside the fixture evidence hash contract.
3. Direction: phase evidence inspection reads fixture-owned paths; closed physical checkpoint capture separately reads the full mutable runtime namespace.
4. Boundary: `protectedHashes` returns path/hash values, with the same protected path set as before for ordinary directory layouts.
5. Failure semantics: disappearing fixture files still fail closed; runtime-generated directory contents are never opened by this inspector.
6. Lifecycle: unchanged. No recovery, replay, additional waits, or lock ownership changes.
7. Test seam: injected file disappearance deterministically reproduces ENOENT in the original code; permanent controls verify real fixture disappearance, symlink rejection, root secret scanning and ordinary harness-named files.
8. Compatibility: same workload hash and released phase bytes. Old failed roots remain preserved; the changed harness contract requires fresh calibration and native execution.
9. Observability: run5's benchmark-failure report and separate native prefix diagnostic distinguish infrastructure failure from model correctness.
10. Security: unsupported root entries still reject; all other directories retain strict shared inventory checks; source grading and snapshot sealing retain their existing link checks. Root file secret scanning remains enabled.
