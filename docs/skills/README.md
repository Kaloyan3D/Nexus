# Nexus Skills

Nexus engineering skills are built directly on the native DeepSeek Harness
(DSH) Agent Skills capability. Nexus does not include a skill engine of its
own: discovery, frontmatter parsing, precedence, cataloging, loading, and
hot-change watching are all native DSH behavior. This directory productizes
that capability — the canonical global skill pack, the installer that
publishes it, the inspection view, the evals, and the documentation.

## Runtime architecture (what Nexus actually mounts)

The pinned DSH runtime provides the capability in three native packages:

| Native package | Role |
| --- | --- |
| `@deepseek-ai/dsh-skill` | The skill registry service (`ctx.skills`): merges provider catalogs, resolves one winning skill per name, loads bodies. Host plane. |
| `@deepseek-ai/dsh-skill-filesystem` | Local filesystem provider: discovers directory-bundle and flat Markdown skills from project, custom, and user roots; watches roots for changes. |
| `@deepseek-ai/dsh-tool-skill` | The model-facing `skill` tool plus the durable `<available_skills>` session catalog. |

Where they are mounted in the actual Nexus composition:

- Host plane (every mode): the `dsh-base` bundle mounts rows `skill`
  (registry), `skill-filesystem`, and `tool-skill`.
- Agent plane (engineering presets): the deployed presets
  `data/.agent-presets/aih-engineering` and `aih-deepseek` mount their own
  scoped `skill-filesystem` + `tool-skill` rows, so project-root discovery is
  per-session and the catalog is per-agent.

`scripts/Verify-SkillsRuntime.ps1` checks all of this deterministically
against the pinned packages and the resolved composition artifacts, and boots
the native stack end-to-end against a disposable fixture.

## Discovery roots and precedence

Native filesystem-provider roots, and the rank that decides duplicate names
(lower wins). Native DSH precedence is authoritative — Nexus never reorders:

| Rank | Source label | Root |
| --- | --- | --- |
| 100 | project-dsh | `<repo>/.dsh/skills` |
| 200 | project-agents | `<repo>/.agents/skills` |
| 300 | custom | native `customSkillDirs` configuration |
| 400 | user-dsh | `$DSH_HOME/skills` (Nexus runtime: `data/skills`) |
| 500 | user-agents | `~/.agents/skills` (or `$DSH_AGENTS_HOME/skills`) |
| 600 | bundled | `$DSH_BUNDLED_SKILL_DIR` |

A repository-owned skill therefore overrides a global skill with the same
name, and Nexus-installed global skills (user-agents) never shadow project or
custom skills. Precedence is proven by tests against the native registry.

## Skill format

Standard portable Agent Skills format (`.agents`-compatible):

    <skill-name>/
      SKILL.md          required; YAML frontmatter with name + description
      references/       optional deep-dive material loaded on demand
      scripts/          optional helper scripts (never auto-executed)
      templates/        optional starting templates

Frontmatter:

    ---
    name: skill-name          kebab-case; must match the directory name
    description: >            when the model should use this skill
      ...
    ---

Nexus adds no required metadata. A skill with nothing but `SKILL.md`
frontmatter functions everywhere DSH skills work. See
[SKILL_AUTHORING.md](SKILL_AUTHORING.md).

## Global versus project skills

- **Global engineering skills** — the version-controlled canonical pack in
  `skills/core`, installable into the user's native global root
  `~/.agents/skills` with `scripts/Install-NexusSkills.ps1`. They apply
  while Nexus works on any repository.
- **Project skills** — repository-owned skills under `<repo>/.agents/skills`
  (preferred, portable) or `<repo>/.dsh/skills`. The repository/user owns
  these files; Nexus never generates project skills automatically.

## Global installation strategy (selected)

Two viable strategies were evaluated:

1. **Install/copy into `~/.agents/skills` (SELECTED)** —
   `scripts/Install-NexusSkills.ps1` syncs the canonical pack into the
   user's native global Agent Skills root with an ownership manifest.
2. **Mount via native `customSkillDirs` (evaluated, not selected)** — pinning
   the Nexus checkout path into the preset composition would couple global
   skills to one environment variable (`AIH_INSTALL_ROOT`), lose the skills
   for any session that boots `dsh` outside the Nexus launcher, and require
   preset regeneration on every setup. Rejected in favor of the standard
   user root.

The installer is deterministic, idempotent, preserves unrelated skills,
refuses to overwrite non-Nexus skills without explicit `-Force` ownership
(documented policy), never deletes, needs no administrator rights, and works
on Windows PowerShell 5.1.

## Inspection and observability

- `scripts/Get-NexusSkills.ps1` — read-only catalog view (name, source,
  scope, model-invocable, resolved path, description) for any workspace.
- `scripts/skills/catalog.mjs` — the same native catalog as a Node seam for
  future consumers: Unified Retrieval asks "what skills are available for
  this scope?" through this read-only seam.

## Security boundary

Skills are instructions, not authority. See [SECURITY.md](SECURITY.md).

## Evals

`scripts/Invoke-SkillEvals.ps1` runs the deterministic selection evals
(cases A-E). See [EVALS.md](EVALS.md).

## Memory boundary

Skills are procedural knowledge ("how to safely design a DB migration").
Memory is experienced/project knowledge ("this repository uses schema v6 and
migrations are forward-only"). The two stay separate stores with separate
lifecycles; a future Unified Retrieval layer may combine them at query time,
which is exactly why the catalog seam above is read-only and query-shaped.
