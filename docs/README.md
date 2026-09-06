# Nexus Documentation

This directory is the current documentation baseline for Nexus.

The short version is in the repository [README](../README.md). The documents here describe the controller contracts, routing semantics, lifecycle, UI integration, storage, endpoints, operations, and the architectural decisions that should remain stable as Nexus evolves.

## Read this first

1. **[Architecture overview](architecture/overview.md)** — the system at a glance and the major authority boundaries.
2. **[Controller and authority](architecture/controller.md)** — what the deterministic controller owns and what models are allowed to do.
3. **[Routing and execution classes](architecture/routing.md)** — how Nexus chooses DeepSeek, deeper reasoning, deterministic work, or independent Codex review.
4. **[Task lifecycle](architecture/task-lifecycle.md)** — tasks, attempts, verification, failure, review, gates, completion, and crash reconciliation.
5. **[Control Room](architecture/control-room.md)** — compact Controller, full room tabs, polling, adapter truthfulness, and operator actions.

## Reference

- **[Repository foundation](architecture/repository-foundation.md)** — Phase 3.1: repository identity and registry, Git state, file inventory, module discovery, snapshot engine, services, and events.
- **[Deterministic code intelligence](architecture/code-intelligence.md)** — Phase 3.2: language detection, structural providers, content-addressed intelligence store, snapshot indexing and reuse, definitions/references, events, and ID semantics.

- **[State and storage](reference/state-and-storage.md)** — project state, run artifacts, runtime journals, identity, append-only histories, and compatibility.
- **[HTTP endpoints](reference/endpoints.md)** — `/nexus/controller.json`, `/nexus/control-room.json`, and `/nexus/gate-action.json`.

## Operations

- **[Setup, testing, and troubleshooting](operations/setup-testing-troubleshooting.md)** — install, startup, diagnostics, tests, common failures, and safe restart guidance.
- **[Nexus on Linux](linux.md)** — native Linux install, XDG layout, PATH setup for bash/fish, pinned runtimes, updates, uninstall, and troubleshooting.
- **[Quick start in Bulgarian](quick-start-bg.md)** — short Bulgarian setup guide.

## Architecture decisions

- **[ADR index](decisions/README.md)** — the decisions future changes should not accidentally undo.

## Detailed implementation and historical notes

These files remain useful, but they are not the preferred starting point for understanding the current architecture:

- **[nexus-ui.md](nexus-ui.md)** — detailed UI implementation history, patching decisions, acceptance notes, and Control Room phases.
- **[vnext-architecture.md](vnext-architecture.md)** — earlier vNext.1 architecture decision record and migration context.

## Documentation rule

When implementation and documentation disagree, implementation plus deterministic tests and producer/storage contracts are authoritative. Update the documentation in the same change that intentionally changes an architectural contract.