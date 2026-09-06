# Deterministic Code Intelligence (Phase 3.2)

Deterministic, content-addressed code intelligence for Nexus repositories: language
detection, structural symbol extraction, definitions/references/occurrences with
honest resolution evidence, snapshot-scoped indexing with incremental reuse, and
snapshot diffing. No AI, no embeddings, no vector database, no LLM symbol extraction.

## Storage architecture

Phase 3.1 hardening Fix 1: high-cardinality intelligence data must never live in
whole-document JSON that gets rewritten on change. The default store is
`content-addressed-v1` (replacable via `Set-AihCodeIntelligenceStore`, process-global
DI seam; store instances are isolated per intelligence store root):

| Path | Content | Write pattern |
| --- | --- | --- |
| `code-intelligence/file-intelligence/<hh>/<cfi_*.json>` | One immutable `FileIntelligence` document per (contentHash, provider, providerVersion, schema) | Write-once; one changed source file creates exactly one new document |
| `code-intelligence/snapshots/<repoId>/<snapId>/mapping.jsonl` | Per-file rows: path, contentHash, language, status, reuse flag, fileIntelligenceId, moduleId | Append-only |
| `code-intelligence/snapshots/<repoId>/<snapId>/symbol-index.jsonl` | One row per definition (symbol), snapshot-scoped path | Append-only |
| `code-intelligence/snapshots/<repoId>/<snapId>/ref-index.jsonl` | One row per reference/call/import occurrence | Append-only |
| `code-intelligence/snapshots/<repoId>/<snapId>/state.json` | Activation state: status, stats, timestamps | Atomic, written last |

Demonstrated invariant (scale suite): after indexing 817 files, changing ONE source
file and re-indexing produces `indexed=1, reused=807` and exactly ONE new
file-intelligence document. Historical snapshot intelligence is never destroyed.

## Pipeline (Phase 3.2E)

`Invoke-AihCodeIntelligenceIndex` consumes the Phase 3.1 inventory and snapshot rows
(`Get-AihSnapshotFiles`, module membership) — the ignore engine and inventory are the
single source of truth; no logic is duplicated. Per file: deterministic language
detection -> priority-ordered provider selection -> content-addressed cache lookup
-> analyze or reuse -> append mapping/symbol/ref rows -> atomic activation.
Indexing an already-activated snapshot is idempotent.

## Language detection (Phase 3.2B)

`Get-AihLanguageDetection` uses deterministic evidence only, in priority order:
exact filename, extension, shebang token, module context. Registered languages:
TypeScript, JavaScript, C#, Python, PowerShell, Rust, Go, Java, JSON, YAML, Markdown.
Unknown files are recorded as `unsupported` — never guessed. Third parties extend via
`Register-AihLanguage`.

## Providers and capability matrix (Phase 3.2C)

Providers are priority-ordered capability objects (CanHandle / capabilities /
Analyze / version). The shipped providers are tier-4 deterministic structural
parsers: line/brace/indent based, in-process, no external tools, no semantic model.
Compiler-grade or SCIP providers can be registered ahead of them (`Register-AihCodeIntelligenceProvider`).

| Provider | Version | Languages | Capabilities |
| --- | --- | --- | --- |
| `structural-ts` | 1.0.0 | typescript, javascript | syntax, symbols, definitions, references, imports, exports, occurrences |
| `structural-csharp` | 1.0.0 | csharp | syntax, symbols, definitions, references, imports, occurrences |
| `structural-python` | 1.0.0 | python | syntax, symbols, definitions, references, imports, occurrences |
| `structural-powershell` | 1.0.0 | powershell | syntax, symbols, definitions, references, occurrences |

A provider that throws is isolated: the file records `failed` with a diagnostic, the
snapshot still activates as `ready_with_failures`, and `intelligence.file.failed` fires.
Provider identity (id + version) participates in file-intelligence identity, so a
parser upgrade deterministically invalidates the cache and re-parses.

## Resolution policy — never fake semantic resolution (Phase 3.2D)

| Occurrence role | Resolution values | Meaning |
| --- | --- | --- |
| `definition` | `exact` | The symbol record itself (line/column evidence) |
| `import` | `name-binding` | Bound name recorded; raw target kept verbatim, target NOT resolved |
| `export` | declaration evidence | Named/default/star/re-export |
| `call` | `unresolved` | Bare-name syntactic call; target intentionally not claimed |
| `reference` | `same-file-unique` | Exactly one same-file definition carries the name |
| `reference` | `ambiguous-unresolved` | Multiple same-file candidates — never invented |

Negative ambiguity tests assert that an ambiguous same-file name yields NO resolution.
Member calls (`obj.method()`) are outside the bare-name call scope by design.

## ID semantics (Phase 3.1 hardening Fix 3)

Two ID classes exist. They must never be conflated:

| ID | Class | Derived from | Stability |
| --- | --- | --- | --- |
| `mach_`, `ws_`, `sub_` | Instance-generated | Machine/workspace/subscription records at registration time | Unique per instance; not derived from content |
| `checkout_` | Instance-generated | Checkout registration event | Unique per registration |
| `snap_` | Instance-generated | Snapshot build event | Unique per build; two builds of identical trees differ |
| `repo_` | Logical-identity-derived | Repository identity (deduped by registration) | Stable across checkouts of the same repository |
| `module_` | Logical-identity-derived | `repositoryId + module path` | Stable while the module path exists; a moved module is a new logical module; `metadataHash` versions its manifest-derived metadata |
| `stateHash` | Content-derived | Snapshot state (tracked file hashes + config + head) | Equal only for identical states; NOT a record identifier |
| `cfi_` (fileIntelligenceId) | Content+identity-derived | `v1\|contentHash\|providerId\|providerVersion` | One document per distinct content/provider/version |
| `sym_` (sid) | Content+identity-derived | `fileIntelligenceId\|kind\|qualifiedName\|signature\|container` | Deterministic; identical content reproduces identical sids across snapshots |
| `occ_` (oid) | Content+identity-derived | `fileIntelligenceId\|role\|line\|column\|name` | Position-sensitive; deterministic |

Snapshot-scoped module membership records keep full metadata + `metadataHash` per
snapshot, so "which modules existed in snapshot X", "which module owned file Y in
snapshot X" and module added/removed/moved/manifest-changed history are queryable.
File rows carry `moduleId` (longest-prefix ownership; generic root module owns the rest).

## Snapshot diff (Phase 3.2E)

`Get-AihSnapshotIntelligenceDiff` compares file content hashes and symbol logical
identity (`kind|qualifiedName`). It prefers removed+added over invented moves; a move
is reported only when the same logical identity exists under a different path.

## Services and events (Phase 3.2F)

Query surface: `Find-AihCodeSymbols` / `Find-AihCodeDefinitions`,
`Find-AihCodeReferences`, `Get-AihFileCodeSymbols`, `Get-AihFileCodeImports`,
`Get-AihFileCodeExports`, `Get-AihFileIntelligence`, `Get-AihSnapshotIntelligence`,
`Get-AihCodeIntelligenceStatus` (human-readable diagnostics text).

Journaled lifecycle events: `intelligence.index.started`, `intelligence.file.reused`,
`intelligence.file.indexed`, `intelligence.file.failed`, `intelligence.snapshot.ready`,
`intelligence.snapshot.failed` (plus Phase 3.1 `event.handler.error` isolation).

## Known limitations

- Structural parsers are line/brace/indent heuristics: macros, multi-line strings,
  templating and exotic syntax can confuse ranges. They are deterministic fallbacks,
  not compilers; upstream providers take priority.
- Reference resolution is same-file unique-name only. Cross-file references require
  import-graph traversal — deliberately out of scope here (Phase 3.3 dependency
  graph territory).
- Read queries stream the per-snapshot JSONL indexes (linear scan per query); the
  store seam exists for indexed backends (e.g. SQLite) without touching call sites.
- Occurrence caps (400 calls/file, 100 refs/name, reference scan skips files > 3000
  lines) bound cardinality deterministically.
- Analysis requires the checkout root of the snapshot to be present; missing sources
  record `failed` rather than fabricating results.

## Explicit non-goals (unchanged)

No embeddings, no vector database, no RAG, no AI summaries or memory, no context
builder, no dependency-graph traversal or blast-radius analysis, no graph database,
no LLM symbol extraction, no refactoring. Phase 3.3 (Knowledge Graph) was NOT pulled
forward: nothing here builds a cross-file graph.

## Verification

Suites (all wired into `scripts/Test-Harness.ps1`): CodeFoundation (30 assertions),
CodeParsing (38), CodeIntelligence e2e DoD scenario (31), CodeScale (10), plus
Phase 3.1 hardening: IgnoreRegression (20) and SnapshotModules (19).