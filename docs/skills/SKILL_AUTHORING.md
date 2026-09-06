# Skill Authoring Guide

This guide covers writing skills for Nexus — globally (the `skills/core`
pack) or per-project (`.agents/skills`). Skills use the standard portable
Agent Skills format; nothing Nexus-specific is required for a skill to work.

## Layout

    <skill-name>/
      SKILL.md          required
      references/       optional: deeper material the model loads on demand
      scripts/          optional: helper scripts (never run automatically)
      templates/        optional: starting templates

- `skill-name` must be kebab-case (`[a-z0-9]+(-[a-z0-9]+)*`) and must match
  the `name` in the frontmatter.
- Keep SKILL.md concise: roughly 50-200 meaningful lines. Put depth in
  `references/` files, not in the body.
- A flat single-file form (`<root>/<anything>.md`) is also supported by the
  native provider; use it only for tiny fixtures or personal notes.

## Frontmatter

    ---
    name: database-engineering
    description: >
      Use for schema design, migrations, queries, and persistence changes.
    ---

- `name` — required, kebab-case, unique per scope.
- `description` — required, non-empty. This is the routing surface: it is
  what the model (and humans) see in the catalog before loading anything.
  Write it as "Use when ..." with the concrete situations that should
  trigger the skill.
- Optional: `whenToUse` (extra routing guidance),
  `disable-model-invocation` (human/catalog-only skill),
  `user-invocable: false`, and a `metadata` mapping. Unknown fields are
  ignored by the native parser.

## Writing the body

Every core skill must answer four questions:

1. **WHEN should I use this?** — an explicit "When to use" section.
2. **WHAT workflow should I follow?** — ordered, concrete steps with the
   artifacts each step produces.
3. **WHAT mistakes are forbidden?** — explicit "Forbidden"/"Rules" section;
   prefer NEVER/always statements over vibes.
4. **HOW do I verify completion?** — a "Verify completion" checklist.

Prefer procedural instructions over encyclopedia content. Do not paste large
documentation dumps into SKILL.md; put depth in `references/` material
instead.

## Content policy

- No project-specific facts in core skills (that is Memory's job): the core
  pack carries reusable engineering procedure, not repository trivia.
- No identity hardcoding: never embed a specific person's name or email in a
  skill; refer to "the effective configured identity" instead. Project- or
  user-specific policy documents may add exact identities outside the pack.
- Scripts and templates ship inert. They execute only when a user or model
  explicitly runs them through normal, permission-checked tooling.

## Where skills live

| Location | Scope | Managed by |
| --- | --- | --- |
| `skills/core/<name>/` (this repo) | canonical source for the global pack | version control |
| `~/.agents/skills/<name>/` | user-global, installed | `scripts/Install-NexusSkills.ps1` |
| `<repo>/.agents/skills/<name>/` | project | the repository/user |
| `<repo>/.dsh/skills/<name>/` | project | the repository/user |
| `data/skills/` (Nexus runtime `$DSH_HOME`) | user-dsh machine-local | you |

## Publishing a core skill change

1. Edit or add the skill under `skills/core/`.
2. Validate: the test suite checks names, descriptions, bodies, and
   duplicates (`tests/NexusSkills.Tests.ps1`).
3. Sync to the user root: `scripts/Install-NexusSkills.ps1` (reports
   installed/updated/unchanged).
4. If the skill changes selection behavior, update the eval cases in
   `tests/fixtures/skill-evals/cases.json` and run
   `scripts/Invoke-SkillEvals.ps1`.

## Malformed skills

Native discovery ignores invalid skills with a logged diagnostic
(`skill file ... ignored: ...`): missing name or description, non-kebab-case
names, unparseable frontmatter. The installer treats the same conditions in
its own source as hard failures before writing anything. Duplicated names
within one scope resolve by native precedence rules; do not rely on that —
keep names unique.
