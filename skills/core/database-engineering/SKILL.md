---
name: database-engineering
description: >
  Use for schema design, migrations, query work, and persistence changes in
  any store. Enforces deterministic migrations, backwards compatibility where
  required, constraints that encode invariants, and tested, non-destructive
  migration paths.
---

# Database Engineering

## When to use

Use when creating or changing tables, columns, constraints, indexes, queries,
or migration scripts; when moving data; or when deciding what is canonical
versus derived.

## Workflow

1. **Model the invariants** — write down the rules that must always hold.
   Each invariant should map to a constraint (unique, foreign key, check,
   not null) so the store enforces it, not the application alone.
2. **Design the migration** — one deterministic, re-runnable-from-scratch
   path from the current schema to the target. Migrations are permanent
   artifacts: they are tested today and they run again on the next fresh
   environment.
3. **Preserve compatibility** where the task requires it: old readers keep
   working during the transition (add-then-backfill-then-constrain, expand/
   contract). Know the deployment's requirement; do not assume it.
4. **Move data in transactions** — logical units of work are atomic. Long
   backfills get batching with resumable progress, not one giant implicit
   transaction unless the store makes that safe.
5. **Justify every index** with the query that uses it (columns, order,
   selectivity). An index without a query is cost with no benefit.
6. **Mark canonical versus derived** — for every new column or table, state
   whether it is authoritative or re-derivable, and where re-derivation
   happens.

## Rules

- Deterministic migrations only: same start state plus same migration yields
  same end state. No wall-clock defaults hidden in DDL, no environment reads.
- No silent destructive migration: dropping or narrowing columns/tables
  requires an explicit stated data-loss decision in the task, never an
  incidental side effect.
- Backwards compatibility is preserved where the task or deployment requires
  it; when a breaking change is genuinely intended, the report says so and
  names what breaks.
- Migrations are permanently tested: the suite applies the full migration
  chain from empty to current as part of verification, and a fix to schema or
  migration code updates those tests.
- Application code validates input, but constraints remain the backstop.

## Verify completion

- Migration applies cleanly from empty (fresh) and from the current shipped
  state (existing) — both exercised where both exist.
- Invariants are enforced by constraints, not by convention.
- Every index maps to a named query.
- Canonical versus derived status is stated for new data.
- Rollback or forward-fix strategy is stated.
