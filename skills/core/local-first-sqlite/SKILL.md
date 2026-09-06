---
name: local-first-sqlite
description: >
  Use for apps where a local SQLite database is the canonical store and the
  UI renders from it. Enforces the canonical transaction then invalidation
  then reread flow, forbids restart workarounds and whole-database copies
  into UI state, and requires cross-screen synchronization tests.
---

# Local-First SQLite

## When to use

Use when the application treats SQLite (or another local database) as the
source of truth and any UI — screens, tabs, panels — reads from it. Typical
symptoms that demand this skill: a list does not update after a write, data
appears only after an app restart, or two screens disagree.

## The invariant

    SQLite canonical state
      -> successful transaction
      -> UI invalidation
      -> canonical reread

Every write goes through the database. After the transaction succeeds, every
mounted surface that depends on the changed data is invalidated and re-reads
from the database. Nothing else is authoritative.

## State classification

Classify every piece of state explicitly:

- **Canonical** — lives in SQLite only. Screens hold no copy; they hold
  queries or subscriptions.
- **Derived** — computed from canonical data (aggregates, view models).
  Recomputed on invalidation; never persisted as an independent truth.
- **Transient UI state** — focus, text field drafts, animations. Lives in
  component state; never forced into the database and never treated as data
  loss when discarded.

## Rules

- NEVER solve stale UI by requiring a restart. If a restart fixes it, the
  invalidation chain is broken; fix the chain.
- NEVER duplicate the whole database into Redux/Zustand/atom state just to
  gain reactivity. Use targeted subscriptions or invalidation per query.
- Writes are transactions: multi-step logical changes commit atomically or
  not at all, and the UI reflects the outcome, not an intermediate state.
- After a successful write, invalidate precisely the queries the write can
  affect — broad invalidation is acceptable, stale caches are not.
- Reads are reactive at the seam the platform offers (observed queries,
  change streams, invalidation keys); a screen mounts by reading current
  state and then stays current.

## Verification

- Cross-screen test: write on screen A; screen B (mounted at the time)
  reflects it without user action.
- Mounted-screen test: the surface showing the data is the one that updates;
  do not only test navigation-after-write.
- Failure test: a failed transaction leaves canonical state and UI unchanged.
- Restart is exercised only as a durability check, never as the
  synchronization mechanism.

## Verify completion

- Every write path demonstrably ends in invalidation plus reread.
- No component holds a second copy of canonical data.
- Cross-screen and mounted-screen synchronization are covered by tests that
  ran green in this task.
