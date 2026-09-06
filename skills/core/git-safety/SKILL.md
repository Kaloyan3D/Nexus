---
name: git-safety
description: >
  Use before and during every Git operation, especially branch switches,
  commits, pushes, rebases, resets, and any command that can move or discard
  history. Enforces that Git identity is user-owned, that destructive
  operations are preceded by inspection, and that history rewrites preserve a
  recovery path.
---

# Git Safety

## When to use

Use for every Git invocation in a task: status checks, branches, commits,
pushes, merges, rebases, resets, stashes, and hook interactions.

## Identity is user-owned

Git identity belongs to the user, never to the agent:

- NEVER run `git config user.name`, `git config user.email`, or
  `git config --local/--global` to set identity values.
- NEVER set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, or
  `GIT_COMMITTER_EMAIL`.
- NEVER use `git commit --author`, `git -c user.name=...`, or
  `git -c user.email=...`.

Before the first commit of a task, READ the effective identity:

```
git config user.name
git config user.email
```

Preserve it exactly as configured. Verify the result after committing with
`git log -1 --format='%an <%ae> | %cn <%ce>'`. If the configured identity is
unexpected for this user, or author and committer would differ from the
effective configuration, STOP and report instead of "fixing" it.

## Before any destructive operation

Branch switches, resets, checkouts of paths, and clean operations require a
prior inspection in the same task:

```
git status
git branch --show-current
git rev-parse HEAD
```

- Confirm the branch is the one the task intends to change.
- Confirm uncommitted work is either task-scoped or stashed with the stash
  named in the report.
- Never discard working-tree changes you did not create and did not document.

## Pushes, history, hooks

- No unsafe force push: `--force-with-lease` is the maximum permitted force,
  and only after confirming the remote commits being replaced are captured
  (push a recovery branch first).
- No history rewrite (rebase, filter, amend of shared commits) without an
  explicit task need; when rewriting, create a recovery branch at the original
  HEAD and report its name.
- Never bypass hooks casually: `--no-verify` is forbidden as an escape hatch.
  If a hook fails, fix the underlying problem the hook reported. Only a user's
  explicit instruction may skip a hook, and the report must say so.
- Never modify hook scripts or CI configuration to unblock a commit.

## Verify completion

- Identity read before commit and author/committer verified after.
- Branch, status, and HEAD were inspected before every destructive step.
- Any recovery branch created is named in the task report.
- Working tree state at completion is stated explicitly.
