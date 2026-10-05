# Structured cloning in the grading realm

Run8's E16 model implementation used Node 24's `structuredClone` to preserve the original canonical document. Public Node execution supports that API, but the restricted grading VM omitted it. Its ReferenceError made all six supported rollback cases fail. With cloning available, the same unchanged candidate passes all six cases. This is a grader defect (C), not an established Native reasoning failure. Run8 was stopped before changing the grader, has no eligible checkpoint, and remains scientifically invalid.

The grader now provides structured cloning of its supported JSON document values entirely inside the candidate realm. It preserves nested documents, opaque own keys, aliases and cycles, and permits ordinary internal Date, RegExp, buffer, typed-array, Map and Set cloning. Functions and symbols reject with a realm-owned DataCloneError. Ownership transfer is outside the fixture's JSON caller contract and fails closed. No host function, value or exception is injected into candidate code. This is not a claim to expose every Node global or every transferable platform type.

1. Source of truth: the declared JSON contracts and independently calculated expected values remain unchanged.
2. Ownership: candidate modules own their local copies; canonical fixture inputs remain immutable.
3. Dependency: the restricted grader provides supported cloning; production and model workspaces remain unchanged.
4. Boundary: all clone functions and returned values are created in the VM realm.
5. Failure: unsupported transfer and noncloneable function/symbol values reject; existing one-second candidate limits remain.
6. Lifecycle: cloning allocates local objects; it creates no process, persistence or background work.
7. Tests: actual missing-global RED, native JSON-copy comparison, opaque keys, cycle/alias and collection assertions, and constructor-escape rejection.
8. Compatibility: the changed grader hash requires fresh calibration and an official root; no failed root is resumed or promoted.
9. Observability: original failed grades and corrected diagnostic cases remain separate, with diagnostic eligibility false.
10. Security: code generation, import restrictions, strict input/output snapshots and host-object isolation remain enforced.
