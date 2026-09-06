---
name: architecture-review
description: >
  Use when introducing a new subsystem, boundary, service, or persistence
  layout, or when a change crosses module ownership. Reviews source of truth,
  ownership, dependency direction, failure semantics, and migration cost
  before code is written.
---

# Architecture Review

## When to use

Use before implementing: a new module or subsystem; a new service or process
boundary; a new persistence layer or cache; a shared library others will
depend on; any change that moves ownership of state or data.

## The ten questions

Answer each explicitly in the plan. "N/A" must be justified, not assumed.

1. **Source of truth** — which single component owns each datum? Every other
   read is derived and must be re-derivable.
2. **Ownership** — who may write each piece of state? Everyone else is a
   consumer with a read seam, never a second writer.
3. **Dependency direction** — dependencies point from volatile to stable.
   No cycles; the lower layer cannot know its callers.
4. **Service boundaries** — what crosses the boundary as an explicit contract
   (types, API, events)? What is forbidden from crossing (internal state,
   live objects, implicit globals)?
5. **Failure semantics** — what happens when each dependency is down, slow,
   or returns garbage? Timeouts, retries, and partial results are designed,
   not discovered.
6. **State lifecycle** — creation, valid transitions, and teardown for every
   stateful thing. Who disposes it; what happens on abnormal exit.
7. **Test seams** — where do tests substitute doubles or inject time, I/O,
   and randomness? If the design has no seam, tests will patch or sleep.
8. **Migration and compatibility** — what existing data, callers, or files
   must keep working during and after the change, and what is the rollback?
9. **Observability** — what distinguishes a healthy system from a failing one
   from outside: logs, metrics, or states that answer "is it working?"
10. **Security implications** — new inputs, outputs, privilege boundaries, or
    persistence of sensitive data; the permission model that must gate them.

## Prefer and avoid

- Prefer explicit contracts over shared mutable state.
- Prefer one derivable copy of truth over synchronized duplicates.
- Prefer boring, local failure over clever global recovery.
- Avoid duplicate sources of truth even when duplication is convenient.
- Avoid boundaries that require every caller to know internal orderings.

## Verify completion

- Each of the ten questions has a written, reviewable answer.
- Contracts that cross boundaries exist in code or are specified precisely.
- The failure of each dependency has a designed behavior, not an assumption.
- The migration path and rollback are stated where existing behavior changes.
