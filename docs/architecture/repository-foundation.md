# Repository Foundation (Phase 3.1) — Architecture

Status: implemented. Scope: the repository foundation that all later Nexus
intelligence phases build on. Everything here is deterministic; no AI
inference, no embeddings, no RAG, no AST, no dependency graph, and no AI
memory are part of this phase (Phase 3.2 concerns, explicitly non-goals).

## Design invariants

1. **Repository-agnostic, multi-repo, monorepo-first.** Nothing assumes a
   single repository or a specific stack.
2. **Never identify a repository by filesystem path.** A logical repository
   identity (repo_*) is independent of where it happens to be checked out.
   Checkout records (checkout_*) carry the physical locations.
3. **Workspace ↔ repository is many-to-many.** WorkspaceRepository links
   carry an optional free-string role; a repository may live in many
   workspaces and a workspace holds many repositories.
4. **Repository-relative POSIX paths only.** All stored file paths are
   normalized repository-relative POSIX paths (forward slashes), never
   absolute paths. Case is preserved; comparisons use case-insensitive keys
   on Windows only.
5. **Deterministic.** IDs, hashes, state hashes, module discovery, and
   classification are all reproducible from the same inputs.

## Identity model (3.1A)

- Machine (mach_*): created once per store, random (never hardware
  derived), hostname/platform recorded for humans, persisted in
  machine.json.
- Workspace (ws_*): name + slug. workspaces.json holds workspaces and the
  workspace↔repository links (including roles).
- Repository (repo_*): vcs is git or none; canonicalRemote is nullable;
  canonicalRemoteKey is the normalized remote used for identity matching
  (git@github.com:user/project.git ≡
  https://github.com/user/project.git; unknown forms are compared as
  opaque raw: keys).
- WorkspaceRepository: the link row (workspace, repository, optional role).
- Checkout (checkout_*): kind is primary, clone, worktree, or non_git;
  bound to a machine; rootPath is a canonicalized absolute path
  (checkout-side only — never used as identity); lastObservation caches a
  cheap Git state probe.

**Registration resolution** (Register-AihRepository), in order:
1. an existing checkout whose canonical root matches the path;
2. otherwise, if the checkout normalized remote key matches exactly ONE
   existing repository → that repository gains a checkout;
3. otherwise, if the key matches MORE THAN ONE candidate repository →
   ambiguity is resolved conservatively: a **separate** repository is
   created. Remote merge only happens on exactly one candidate.
4. explicit linking stays available to humans: Set-AihRepositoryRemote
   overrides a repository canonical remote and Move-AihCheckoutToRepository
   re-parents a checkout.

## Git access (3.1B)

All Git knowledge sits behind the replaceable GitProvider interface
(Set-AihGitProvider; default New-AihGitCliProvider wraps the git CLI,
UTF-8, no prompts, timeouts). Capabilities: isRepository, getRoot,
getHeadSha, getBranch, getRemote, getDefaultBranch, getWorkingTreeStatus,
getTrackedFiles, detectWorktree, plus detached-HEAD detection.

WorkingTreeStatus entries: kinds staged / modified / deleted / renamed /
untracked / unmerged, with repository-relative path and oldPath/newPath
for renames. Edge cases covered by tests: dirty trees, no remote (no
origin assumption — default branch falls back to the local branch),
detached HEAD (getBranch = null), and Git worktrees (registered as
kind = worktree).

## File inventory (3.1C)

Invoke-AihInventoryScan walks the checkout and produces, per file: path,
size, mtimeMs (change detector only — never identity), contentHash,
classification, isBinary, sensitivity, indexability.

- **Hashing**: full sha256:<hex>; files larger than maxFileBytes
  (default 2 MiB) get a **sampled** hash marked sha256s:<hex> (64 KiB
  sample). mtime is never used as identity; it only lets unchanged
  (path, size, mtime) rows reuse the previous hash.
- **Classification** (priority order): generated → vendor → test →
  documentation → config → asset → source → binary/unknown.
- **Sensitivity** (case-insensitive on all platforms): blocked
  (.env, .env.*, *.pem/key/pfx/p12/keystore/jks, id_rsa*/id_ed25519*,
  .git-credentials, .netrc, secrets.*), potential_secret (*.crt/cer/csr,
  *credentials*, *secret*, *token*, .npmrc, .pypirc, *password*), else
  normal.
- **Indexability**: text, binary, excluded_large, excluded_symlink,
  excluded_unreadable.
- **Binary detection**: NUL byte or >30% control bytes in an 8 KiB sample
  (UTF-16 content therefore reads as binary — safe).

**Ignore layers, last match wins (with negation), per-rule base dir:**
1. Nexus defaults (node_modules/, dist/, build/, caches, VCS metadata, …);
2. per-directory .gitignore (shallow→deep), when respect_gitignore;
3. .nexus.yml exclude globs (repo-level configuration);
4. per-directory .nexusignore (repository-specific, strongest layer).

An excluded directory is pruned **unless a later-layer negation could
re-include something beneath it**; in that case the walk descends and
inherits the directory exclusion as an ordered rule, so only explicitly
re-included paths survive (tested: build/ default-ignored, .nexusignore
!build/keep.js re-includes exactly that file). Git-tracked files bypass
ignores entirely, so force-added files under ignored directories stay
visible.

**Symlink/junction safety**: reparse-point directories are never descended;
file symlinks are inventoried but never read (excluded_symlink); a
visited-set plus a root-containment check guards against loops and escapes.

**Configuration** (.nexus.yml / .nexus.yaml, optional): repository.name,
index.respect_gitignore, index.exclude, index.max_file_bytes,
index.sample_bytes, modules.autodetect, security.external_context,
security.blocked_globs, security.sensitive_globs. Unknown keys are
surfaced in configErrors (never silently applied). A strict YAML subset
parser is used; unsupported syntax fails loudly with the file and line.

## Module discovery (3.1D)

Invoke-AihModuleDiscovery runs an ordered detector registry over the
inventory — one module per directory, deterministic order: package.json
(with workspaces → monorepo metadata), pnpm-workspace.yaml, turbo.json,
nx.json, .sln (projects parsed into metadata), *.csproj, pyproject.toml,
setup.py, Cargo.toml (workspace aware), go.mod, pom.xml, Gradle
(settings.gradle / build.gradle). Marker files (pnpm/turbo/nx) merge as
metadata into the same-directory package.json module. A repository with
no known manifests receives a **generic root module** so every repository
has a usable module tree. Module ids are deterministic: sha256 of
repositoryId|path.

## Snapshot engine (3.1E)

RepositorySnapshot (snap_*): branch/commitSha (nullable for non-git),
stateHash, isDirty, status ∈ building / ready / failed / superseded, plus
stats. Snapshot files (snapshot_files) and snapshot modules
(snapshot_modules) are persisted per snapshot; content-addressed
**file objects** (file_objects, keyed by hash+size) let identical content
reuse identity across snapshots and checkouts.

**State hash** = sha256 over a stable serialization: HEAD sha (or
no-git/unborn), dirty flag, every working-tree change entry
(kind|path|oldPath|content hash), and the full inventory digest
(sorted path|hash pairs). It differentiates same-HEAD clean vs dirty vs
*different* dirty states, and is reproducible (no timestamps).

**Build flow** (Invoke-AihSnapshotBuild): checkout inspect → scan
inventory → discover modules → compute hashes (reusing previous snapshot
rows by (path, size, mtime)) → assemble snapshot → optional -Validator
seam → **atomic activation** under a named mutex: the snapshot becomes
ready inside snapshots.json first, other ready snapshots of the checkout
become superseded, and the checkout pointer is written **last**. A failed
build records failed + reason and never touches the active pointer. On
startup, Repair-AihSnapshotStates reconciles stale building rows to
failed(build_aborted) and repairs dangling pointers by re-resolving the
newest ready snapshot. Get-AihActiveSnapshot also self-heals on read.

## Services, events, API (3.1F)

Services (higher layers never touch storage or Git directly):
Get-AihMachineIdentity, New-AihWorkspace and workspace queries,
Register-AihRepository, Get-AihRepository(List), Get/Remove-AihCheckout,
Get-AihCheckoutList, Set-AihRepositoryRemote,
Move-AihCheckoutToRepository, Invoke-AihInventoryScan,
Resolve-AihRepositoryConfig, Invoke-AihModuleDiscovery,
Invoke-AihSnapshotBuild, Get-AihSnapshot(List/Files/Modules),
Get-AihActiveSnapshot, Get-AihModuleList, Get-AihRepositoryStatus,
Format-AihRepositoryStatusText.

CLI-equivalent operations (internal API): Invoke-AihIntelligenceCommand
with workspace-create, workspace-list, repo-add, repo-list, repo-status,
repo-scan, snapshot-list, module-list.

**In-process event bus** (no external broker): Subscribe-AihIntEvent
(wildcard patterns), Unregister-AihIntEventSubscription, journal persisted
as JSONL (events.jsonl), tolerant reader. Events: repository.registered,
checkout.registered, repository.state.changed, snapshot.build.started,
snapshot.build.completed, snapshot.activated, snapshot.failed,
module.discovered. Subscriber failures are journaled as
event.handler.error and never break the emitter.

## Storage layout

Under the store root (default C:AI-Harnessdataintelligence, gitignored):

    machine.json                      # machine identity
    events.jsonl                      # event journal
    workspaces.json                   # workspaces + workspace_repositories
    repositories.json                 # repositories + repository_configs rows
    checkouts.json                    # checkouts (pointer per checkout)
    modules/<repoId>/modules.json     # latest repository modules
    snapshots/<repoId>/snapshots.json # snapshot registry (status source)
    snapshots/<repoId>/<snapId>/      # files.json, modules.json, config.json
    file-objects/objects.json         # content-addressed file objects

All writes go through Write-AihAtomicJson (temp + move) under a named
mutex per store (Use-AihIntelligenceLock), matching Nexus conventions
(UTF-8, prefixed IDs, Set-StrictMode -Version Latest).

## Extension points

- GitProvider (replace the CLI adapter with a library or a server-side
  implementation).
- Inventory config (globs, limits, sensitivity/blocked globs).
- Module detector registry (ordered, additive).
- Snapshot -Validator seam (policy checks between build and activation).
- Event subscriptions (e.g. Phase 3.2 indexing on snapshot.activated).

## Known limitations

- Remote normalization covers git@host:path.git and scheme URLs; exotic
  remotes compare as opaque keys (still deterministic).
- .gitignore support is a pragmatic subset (patterns, negation, anchors,
  dir-only); corner cases behave per the layered rules documented above,
  not byte-for-byte git.
- Hash reuse requires matching (path, size, mtimeMs); a same-size,
  same-mtime content change is only caught on the next full-hash rebuild.
- Module discovery parses manifests with lightweight, deterministic
  extractors; it does not evaluate package managers or build scripts.
- Non-git repositories have branch/commitSha = null and their state hash
  is inventory-only.
- The store is per-machine; multi-machine sync is out of scope.

## Phase 3.2 confirmation

No embeddings, no RAG, no AST parsing, no dependency graph, and no AI
memory are implemented here — deliberately. The event bus and snapshot
engine are the seams Phase 3.2 will consume.
