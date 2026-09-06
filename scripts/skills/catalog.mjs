// Nexus skill catalog seam over the pinned native DeepSeek Harness skill
// capability. READ-ONLY: this module boots the same @deepseek-ai/dsh-skill
// registry and @deepseek-ai/dsh-skill-filesystem provider packages that the
// Nexus runtime composition mounts (host row `skill`/`skill-filesystem` in
// the dsh-base bundle plus the per-preset rows in data\.agent-presets\*), and
// exposes native discovery and body loading without re-implementing any
// precedence, parsing, or watching. This is the read seam future Nexus
// Unified Retrieval consumes to ask "what skills are available for this
// scope?"; it must stay query-only.
//
// Usage from Node:
//   const { createSkillCatalog } = await import(new URL('../skills/catalog.mjs', import.meta.url))
//   const catalog = await createSkillCatalog({ dshHome, agentsHome, customSkillDirs })
//   const skills = await catalog.list(cwd)
//   const body = await catalog.get('skill-name', cwd)
//   await catalog.close()
//
// CLI mode:
//   node scripts/skills/catalog.mjs --cwd <dir> [--name <skill>] [--json]
//       [--dsh-home <dir>] [--agents-home <dir>] [--custom-dir <dir>]...
//
// Native semantics preserved verbatim (lower rank wins duplicates):
//   project-dsh 100 < project-agents 200 < custom 300 < user-dsh 400
//   < user-agents 500 < bundled 600

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..');
const appNodeModules = path.join(repoRoot, 'app', 'node_modules');

const packageEntry = (packageName, entry) =>
  pathToFileURL(path.join(appNodeModules, packageName, entry)).href;

async function importPackage(packageName) {
  // Each package's own imports resolve from app\node_modules because the
  // importing module lives inside it; only the entry path is explicit here.
  return await import(packageEntry(packageName, path.join('lib', 'index.js')));
}

/**
 * Boot the native skill registry plus filesystem provider with Nexus's
 * effective root resolution. Providers are always booted with watching
 * disabled: this seam is a point-in-time inspection, not a long-lived
 * watcher, and the live runtime owns its own watchers.
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] User .dsh-style home. Defaults to
 *   $DSH_HOME, then <repo>\data (the Nexus runtime override), then ~/.dsh.
 * @param {string} [options.agentsHome] Shared agents home. Defaults to
 *   $DSH_AGENTS_HOME, then ~/.agents (matching the native provider).
 * @param {string[]} [options.customSkillDirs] Extra roots scanned between
 *   project and user roots (native customSkillDirs semantics).
 * @param {boolean} [options.includeDefaultRoots] Include project and user
 *   roots; defaults to true (native default).
 * @returns {Promise<{list: Function, get: Function, close: Function}>}
 */
export async function createSkillCatalog(options = {}) {
  const { Context } = await importPackage('@deepseek-ai/cordis');
  const dshSkill = await importPackage('@deepseek-ai/dsh-skill');
  const fsProvider = await importPackage('@deepseek-ai/dsh-skill-filesystem');

  const dshHome = options.dshHome
    ?? process.env.DSH_HOME
    ?? path.join(repoRoot, 'data');
  const agentsHome = options.agentsHome
    ?? process.env.DSH_AGENTS_HOME
    ?? path.join(process.env.USERPROFILE || process.env.HOME || repoRoot, '.agents');
  const customSkillDirs = options.customSkillDirs ?? [];

  const ctx = new Context();
  ctx.plugin(dshSkill.SkillRegistry);
  ctx.plugin({
    name: 'skill-filesystem',
    inject: ['skills'],
    apply: fsProvider.apply
  }, {
    dshHome,
    agentsHome,
    customSkillDirs,
    includeDefaultRoots: options.includeDefaultRoots ?? true,
    watch: false
  });

  // Deterministic settle: plugin application completes asynchronously, so
  // wait (bounded) until the registry service is resolvable before any list.
  for (let attempt = 0; attempt < 200 && ctx.skills === undefined; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (ctx.skills === undefined) {
    throw new Error('skill registry service did not resolve after plugin boot');
  }

  return {
    /** Invocation-neutral native summaries for a workspace cwd. */
    async list(cwd) {
      return await ctx.skills.list({ cwd: cwd ?? process.cwd() });
    },
    /** Full native definition (frontmatter + body) for one skill name. */
    async get(name, cwd) {
      return await ctx.skills.get(name, { cwd: cwd ?? process.cwd() });
    },
    /**
     * Release seam resources. The provider runs with watching disabled, so
     * there are no watchers to stop; a CLI/test process ends its lifecycle
     * here. Exists so future seams that acquire resources keep one call site.
     */
    async close() {
      return undefined;
    }
  };
}

function cliArguments(argv) {
  const args = { customDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error('missing value for ' + token);
      return argv[i];
    };
    switch (token) {
      case '--cwd': args.cwd = next(); break;
      case '--name': args.name = next(); break;
      case '--dsh-home': args.dshHome = next(); break;
      case '--agents-home': args.agentsHome = next(); break;
      case '--custom-dir': args.customDirs.push(next()); break;
      case '--json': args.json = true; break;
      default: throw new Error('unknown argument: ' + token);
    }
  }
  return args;
}

export async function runCli(argv) {
  const args = cliArguments(argv);
  const catalog = await createSkillCatalog({
    dshHome: args.dshHome,
    agentsHome: args.agentsHome,
    customSkillDirs: args.customDirs
  });
  try {
    if (args.name !== undefined) {
      const skill = await catalog.get(args.name, args.cwd);
      if (skill === undefined) {
        process.exitCode = 1;
        return { error: 'skill "' + args.name + '" not found in the catalog' };
      }
      return skill;
    }
    const skills = await catalog.list(args.cwd);
    return {
      cwd: args.cwd ?? process.cwd(),
      count: skills.length,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        source: skill.source,
        scope: scopeOf(skill.source),
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
        provider: skill.provider,
        resourceBase: skill.resourceBase
      }))
    };
  } finally {
    await catalog.close();
  }
}

/** Map a native source label to a coarse scope for Nexus views. */
export function scopeOf(source) {
  switch (source) {
    case 'project-dsh':
    case 'project-agents': return 'project';
    case 'user-dsh':
    case 'user-agents': return 'user';
    case 'custom': return 'custom';
    case 'bundled': return 'bundled';
    case 'runtime': return 'runtime';
    default: return 'custom';
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const payload = await runCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}
