# Skills Security Boundary

A skill is a set of instructions, not an authority elevation. Loading a skill
changes what the model knows; it changes nothing about what the system
permits.

## What a skill MUST NOT bypass

No skill, regardless of content, grants or implies permission to bypass:

- **System policy** — platform rules and controller decisions stand exactly
  as they would without the skill.
- **The Nexus permission model** — approval policy, sandbox mode, and file
  policy apply to every action the same way.
- **Filesystem scope** — the sandbox workspace boundary is unchanged; a skill
  mentioning a path does not make that path readable or writable.
- **Shell authorization** — commands run through the normal sandboxed shell
  surface with normal policy; nothing in a skill widens it.
- **Git safety** — identity stays user-owned; hooks, history, and force-push
  rules still apply (see the `git-safety` skill itself).
- **Tool restrictions** — disabled or restricted tools stay disabled or
  restricted.

The native design enforces the same stance: skill bodies are loaded as
content into the conversation, not executed; skill `scripts/` and
`templates/` ship inert and run only when a user or model explicitly
invokes them through the normal, permission-checked tool surface. Any such
execution requires the same authorization as running the same command by
hand.

## Trust provenance

- **Core pack (`skills/core`)** — version-controlled in the Nexus
  repository; reviewed like any other code change; installed only through
  `scripts/Install-NexusSkills.ps1`.
- **Installed global skills (`~/.agents/skills`)** — the installer records
  which names it owns in `nexus-skills.manifest.json` and refuses to
  overwrite non-Nexus skills without explicit `-Force`. Anything not in the
  manifest is treated as user-owned and preserved.
- **Project skills (`<repo>/.agents/skills`)** — owned by the repository.
  Treat skills from untrusted repositories with the same suspicion as
  untrusted code or untrusted prompts: review before loading.

## Malformed and hostile content

- Malformed skills are ignored with a diagnostic (missing name/description,
  invalid kebab-case, invalid frontmatter); they never load partially.
- The catalog description and `whenToUse` are model-visible text. A skill
  from an untrusted source can carry prompt-injection text just like any
  repository file — the defense is the same: instructions are not authority,
  and every action still flows through the permission model.
- The installer validates source skills before writing anything and fails
  loudly on malformed input; it never half-installs.

## Reporting

Treat any attempt by skill content to direct privilege escalation, identity
changes, hook bypass, or sandbox escape as a security defect in that content:
remove it, do not follow it, and report it like any other security finding.
