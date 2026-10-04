Current session preparation: see [SESSION-BOOTSTRAP.md](SESSION-BOOTSTRAP.md). Frozen production is `e0282c11d5bee29359c277cd5a9568ca13d62885`. Fresh authority must be verified and journaled before T00 intent. A fresh normal OC01 certification for this core is required; the older provisioning results below do not authorize calibration. Historical 20261004 / 20261004-02 roots are immutable.

# Certification bootstrap boundary review

Production authority: `ContextAuthorityCertificationV2.cjs` schema 1, exact 20-key bounded record, maximum 8192 bytes, authorityKind REMOTE_MUSE_PRECOUNT. Persisted filename is `data/ccv2-authority/opencode-muse-certification.json`. The schema includes inference and counter provider/baseURL/model, counter fingerprint, context window, margin/output policy revisions, request shape, canary suite/digest, certification/expiry timestamps and status/revocation fields. It contains no install path, source digest or signature. `startupOpencodeAuthorityV2({installRoot})` derives expected identity from installed settings/model registry, loads the local record, checks identity/revocation/expiry, then establishes health using the canary digest. Moving identical persisted bytes between equivalent installs is supported by this value-based loader; the directory locates the record and is not part of its identity.

Current request shape is opencode-muse-request-shape-v3-native-tail-no-replay; suite is oc01-canary-suite-v2. Standard issuance TTL is seven days. Bootstrap does not issue, renew, rewrite, re-sign or extend certificates. Source digest is a separate frozen-source guard; canaryEvidenceDigest is opaque canary evidence, not a source checksum. Arbitrary structurally valid alteration of an unsigned record is not authenticated by the production loader. This helper additionally detects conflicting destination bytes and mutations between reads, but trusts an explicitly selected, production-validated local certification source; it cannot prove historical canary execution cryptographically.

Architecture plan:

1. Truth: normal production startup owns certification verdict; frozen Git source guard owns source equivalence. Bootstrap stores only derived hashes/public identifiers.
2. Ownership: benchmark helper may exclusively publish the exact certificate bytes and bootstrap provenance. It never modifies production sources, the source certificate, or other mutable source state.
3. Direction: benchmark helper consumes production authority/doctor. Production has no dependency on benchmark bootstrap.
4. Boundary: explicit certification-source install root, exact artifact bytes, derived route/runtime identities. No credentials, sessions, journals or other authority files cross.
5. Failure: absent/malformed/expired/revoked/drifted certificates, source mismatch, route mismatch or conflicting destination bytes block before runner construction/submission. No overwrite of existing conflicting authority.
6. Lifecycle: stage runtime, validate source and destination certified identities/effective routes/source guards, atomically publish exact bytes, invoke normal destination startup, record validated provenance, then allow existing live preflight. A provisioning-only command never starts a transport.
7. Tests: real production authority, temporary frozen-source layouts, fixed synthetic certificates inside offline-blocked tests, mutation cases and transport tripwires; no live canary or provider.
8. Compatibility: the known predecessor contract c1b15cdb9bb60e9f91c515ddb88826fdfd78c6de6eee22e87f760ac62f5cf26e is accepted only with successful provenance bound to current contract, root, destination certificate hash and runtime identity. Original identity seal stays unchanged. Roots with any calibration journal/session state cannot bootstrap.
9. Observability: source/destination certificate and runtime identity hashes, source guard verdict, expiry, public suite/shape, destination HEALTHY/valid and optional provisioning-only doctor result. No keys or prompts.
10. Security: source must be explicit or the known LHCB-01 isolated install; symlinks/overlapping roots rejected; exact artifact only; no trust-canary and no expectedIdentity/storeRoot overrides of startup. Normal preflight still gates all prompts and independently verifies live readiness.

`calibrate-fresh ROOT --certification-source SOURCE/nexus-root` accepts an explicit isolated source. Omitting the flag selects the known `~/nexus-bench/ccv2-lhcb-01/nexus-root` source; that root is read only. After runtime staging, bootstrap completes before constructing/executing the calibration runner. The regular certification/runtime preflight remains mandatory before transport startup and every prompt.

For an existing failed, unused root, `provision-certification ROOT --certification-source SOURCE/nexus-root` performs only certificate bootstrap and normal doctor validation; preload `benchmarks/ccv2-lhcb-02/grader/offline.cjs`. This command requires the offline blocker and cannot run any calibration stage. It records metadata under `reports/certification-bootstrap.json`. Conflicting destination bytes are never overwritten; expired/revoked records require a proper human-operated OC01 recertification, not renewal by this helper.

The runtime identity hash covers production identity, actual settings hash, Responses route, protected source bytes (routing policy excluded because arm mode differs), app package/lock hashes, staged Node/DSH versions and actual composed immutable preset/profile hashes. It is an identity fingerprint, not a digest of every third-party dependency or executable byte. Normal staging, source guard and doctor runtime checks remain separate requirements. Nothing here claims cryptographic authenticity for an unsigned persisted canary record.

Portability compares a root-independent core: certified route identity, effective provider/counter identity and Responses route from data/settings.yaml, protected source bytes, app package/lock hashes and staged Node/DSH versions. Every certified/effective identity field must match exactly. Full runtime fingerprints are recorded independently and may differ because of unrelated local settings and root-specific dependency links; each composed runtime must still pass its own production source guard/pinned immutable-file validation. This distinction is tested with a permitted unrelated settings comment and a rejected actual provider URL change.

Doctor's import-only Node child uses the exact shared LHCB-01 offline preload path, whose code already owns the child allowlist. The benchmark dependency seam supplies that preload location while retaining the LHCB-02 manifest/root ownership/guards. This fixes wrapper-path rejection without changing the shared blocker, doctor logic or certification authority; a real isolated-runtime import regression demonstrates zero attempts.

## Verification and existing-root probe

Pinned Node 24.18.1 verification:

- All LHCB-02 suites: `--test tests/Ccv2Lhcb02*.cjs` — 168/168 PASS, including 21 new certification tests; zero skipped.
- Affected LHCB-01 suites: `--test tests/Ccv2Lhcb.Tests.cjs tests/Ccv2Lhcb.AutoRunner.Tests.cjs` — 112/112 PASS; zero skipped.
- Total: 280 PASS, zero failures/skips. Final offline audit assertions reported no network attempts.
- `git diff --check` and staged diff check PASS.
- Production source guard PASS against `081c54070ee0ae62a8ae303bbcde9f930174cbed`, zero differing paths. No production source or threshold changes.

Exactly one provisioning-only probe was executed against the preserved root `/home/kaloyan/nexus-bench/ccv2-lhcb-02-calibration-morning-20261004`, using the explicitly selected source `/home/kaloyan/nexus-bench/ccv2-lhcb-01/nexus-root`. It used the pinned Node with the offline blocker and CLI `provision-certification`, never `calibrate` or `calibrate-fresh`.

Result: PASS; normal doctor certification HEALTHY/valid, liveReady true, runtimeReady true and source guard PASS. Session created: false. Prompt submitted: false. Provider calls: 0. Network attempts: 0. Calibration was not rerun. The original root identity seal was retained; successful bootstrap provenance permits the narrowly specified predecessor contract.

Public probe provenance (also stored in the failed root's `reports/certification-bootstrap.json`):

| Field | Value |
| --- | --- |
| Source and destination certificate SHA-256 | `3f26eb1e25180b9f6a2ec38757f5be7fe0e5e509c36b05a7e9b91779719f378e` |
| Expiry, unchanged | `2026-10-10T15:12:26.349Z` |
| Source runtime identity SHA-256 | `e4a9274fcdf1164633cf856c7beb062d0813dd7128bfad0f06c33d222207208c` |
| Destination runtime identity SHA-256 | `45721b9f37311b9cf84b2622fe6661b87e3b1f4d8de5c81e22787ff2c00d8d98` |
| Original contract SHA-256 | `c1b15cdb9bb60e9f91c515ddb88826fdfd78c6de6eee22e87f760ac62f5cf26e` |
| Bootstrap contract SHA-256 | `b7ceaffc65c09cce4833cbebb9c8a3ae0dab0478759f06b3b8a70b6a2c62c7ff` |

The differing full runtime fingerprints reflect local settings/dependency-link layout; certified/effective route identities, core versions/manifests and protected source bytes matched. Each install's composed immutable state independently passed the normal source guard. The source certificate was neither altered nor renewed, and no unrelated mutable authority state was copied.
