'use strict';

// Nexus Skills runtime tests: prove the native DSH skill capability that the
// Nexus composition mounts actually discovers, diagnoses, and loads skills —
// including the precedence, flat-form, malformed, and hello-fixture cases —
// using the exact pinned packages from app/node_modules. No model is involved.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const appNodeModules = path.join(repoRoot, 'app', 'node_modules');

function packageEntry(packageName) {
  return pathToFileURL(path.join(appNodeModules, packageName, 'lib', 'index.js')).href;
}

let passed = 0;
function ok(condition, name) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('PASS: ' + name);
}

async function makeFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-skills-rt-'));
}

async function makeCatalog(options) {
  const catalogModule = await import(pathToFileURL(path.join(repoRoot, 'scripts', 'skills', 'catalog.mjs')).href);
  return await catalogModule.createSkillCatalog(options);
}

async function main() {
  const { Context } = await import(packageEntry('@deepseek-ai/cordis'));
  const dshSkill = await import(packageEntry('@deepseek-ai/dsh-skill'));
  const fsProvider = await import(packageEntry('@deepseek-ai/dsh-skill-filesystem'));

  // -- 2/4/10/11: valid SKILL.md discovered from project .agents -------------
  {
    const root = await makeFixture();
    try {
      const skillDir = path.join(root, '.agents', 'skills', 'project-valid');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
        '---\nname: project-valid\ndescription: Valid project skill for discovery verification.\n---\nBody marker PROJECT_VALID_BODY.\n');
      const catalog = await makeCatalog({ dshHome: root, agentsHome: path.join(root, 'none') });
      const skills = await catalog.list(root);
      const found = skills.find((s) => s.name === 'project-valid');
      ok(found, '2: valid SKILL.md is discovered through the native registry');
      ok(found && found.source === 'project-agents', '4: project .agents/skills discovery reports source project-agents');
      ok(found && found.description === 'Valid project skill for discovery verification.', '10: catalog exposes description without loading the body');
      const loaded = await catalog.get('project-valid', root);
      ok(loaded && loaded.content.includes('PROJECT_VALID_BODY'), '11: body load returns the expected skill content');
      await catalog.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // -- 5: project .dsh discovery ----------------------------------------------
  {
    const root = await makeFixture();
    try {
      const skillDir = path.join(root, '.dsh', 'skills', 'project-dsh-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
        '---\nname: project-dsh-skill\ndescription: Project skill living under the .dsh root.\n---\nBody.\n');
      const catalog = await makeCatalog({ dshHome: root, agentsHome: path.join(root, 'none') });
      const skills = await catalog.list(root);
      const found = skills.find((s) => s.name === 'project-dsh-skill');
      ok(found && found.source === 'project-dsh', '5: project .dsh/skills discovery reports source project-dsh');
      await catalog.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // -- 3: flat single-file form -------------------------------------------------
  {
    const root = await makeFixture();
    try {
      const skillsDir = path.join(root, '.agents', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      const flatFixture = path.join(repoRoot, 'tests', 'fixtures', 'skills-flat', 'note-taker.md');
      fs.copyFileSync(flatFixture, path.join(skillsDir, 'flat-form-note-taker.md'));
      const catalog = await makeCatalog({ dshHome: root, agentsHome: path.join(root, 'none') });
      const skills = await catalog.list(root);
      const found = skills.find((s) => s.name === 'flat-form-note-taker');
      ok(found && found.source === 'project-agents', '3: flat single-file .md skill form is discovered');
      const loaded = await catalog.get('flat-form-note-taker', root);
      ok(loaded && typeof loaded.content === 'string' && loaded.content.length > 0, '3: flat skill body loads');
      await catalog.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // -- 6: global/user discovery (user-agents and user-dsh) ---------------------
  {
    const root = await makeFixture();
    try {
      const agentsHome = path.join(root, 'agents-home');
      const dshHome = path.join(root, 'dsh-home');
      const userAgentsSkill = path.join(agentsHome, 'skills', 'user-agents-skill');
      const userDshSkill = path.join(dshHome, 'skills', 'user-dsh-skill');
      fs.mkdirSync(userAgentsSkill, { recursive: true });
      fs.mkdirSync(userDshSkill, { recursive: true });
      fs.writeFileSync(path.join(userAgentsSkill, 'SKILL.md'),
        '---\nname: user-agents-skill\ndescription: Global skill installed into the user agents root.\n---\nBody.\n');
      fs.writeFileSync(path.join(userDshSkill, 'SKILL.md'),
        '---\nname: user-dsh-skill\ndescription: Global skill living in the user dsh home root.\n---\nBody.\n');
      const cwd = path.join(root, 'empty-project');
      fs.mkdirSync(cwd, { recursive: true });
      const catalog = await makeCatalog({ dshHome, agentsHome });
      const skills = await catalog.list(cwd);
      const byName = new Map(skills.map((s) => [s.name, s]));
      ok(byName.get('user-agents-skill') && byName.get('user-agents-skill').source === 'user-agents', '6: global user-agents root skills are discovered outside any project');
      ok(byName.get('user-dsh-skill') && byName.get('user-dsh-skill').source === 'user-dsh', '6: global user-dsh root skills are discovered');
      await catalog.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // -- 7: precedence — repository skill overrides the global skill -------------
  {
    const root = await makeFixture();
    try {
      const agentsHome = path.join(root, 'agents-home');
      const globalSkill = path.join(agentsHome, 'skills', 'frontend-design-fidelity');
      const projectSkill = path.join(root, '.agents', 'skills', 'frontend-design-fidelity');
      fs.mkdirSync(globalSkill, { recursive: true });
      fs.mkdirSync(projectSkill, { recursive: true });
      fs.writeFileSync(path.join(globalSkill, 'SKILL.md'),
        '---\nname: frontend-design-fidelity\ndescription: GLOBAL VERSION of the design fidelity skill.\n---\nGlobal body.\n');
      fs.writeFileSync(path.join(projectSkill, 'SKILL.md'),
        '---\nname: frontend-design-fidelity\ndescription: PROJECT VERSION of the design fidelity skill.\n---\nProject body.\n');
      const catalog = await makeCatalog({ dshHome: root, agentsHome });
      const skills = await catalog.list(root);
      const winner = skills.find((s) => s.name === 'frontend-design-fidelity');
      ok(winner && winner.source === 'project-agents', '7: repository skill wins over same-name global skill (native precedence)');
      ok(winner && winner.description.includes('PROJECT VERSION'), '7: the winning catalog entry is the repository version');
      const loaded = await catalog.get('frontend-design-fidelity', root);
      ok(loaded && loaded.content.includes('Project body'), '7: loading the shadowed name loads the repository body');
      await catalog.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // -- 8/9: malformed skills are rejected and diagnosed -------------------------
  {
    const root = await makeFixture();
    try {
      const skillsRoot = path.join(root, '.agents', 'skills');
      const invalidName = path.join(skillsRoot, 'invalid-name');
      const missingDesc = path.join(skillsRoot, 'missing-description');
      const badYaml = path.join(skillsRoot, 'bad-frontmatter');
      for (const dir of [invalidName, missingDesc, badYaml]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(invalidName, 'SKILL.md'),
        '---\nname: Not_Kebab Valid!\ndescription: Name violates the kebab-case grammar.\n---\nBody.\n');
      fs.writeFileSync(path.join(missingDesc, 'SKILL.md'),
        '---\nname: missing-description-skill\n---\nBody.\n');
      fs.writeFileSync(path.join(badYaml, 'SKILL.md'),
        '---\nname: [unclosed-bracket\ndescription: malformed yaml here\n---\nBody.\n');

      const diagnostics = [];
      const ctx = new Context();
      // The default logger threshold is INFO (1), which filters warns (2);
      // open the sink to DEBUG so native discovery diagnostics are observable.
      const exporter = {
        levels: { default: 3 },
        export(message) {
          if (message.type === 'warn') diagnostics.push(message.args.map(String).join(' '));
        }
      };
      ctx.logger.exporter(exporter);
      ctx.plugin(dshSkill.SkillRegistry);
      ctx.plugin({ name: 'skill-filesystem', inject: ['skills'], apply: fsProvider.apply },
        { dshHome: root, agentsHome: path.join(root, 'none'), watch: false });
      for (let i = 0; i < 200 && ctx.skills === undefined; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const skills = await ctx.skills.list({ cwd: root });
      ok(skills.length === 0, '8: malformed skill name is rejected by native discovery');
      ok(!skills.some((s) => s.name === 'missing-description-skill'), '9: frontmatter without description is not silently loaded');
      ok(!skills.some((s) => s.name === '[unclosed-bracket'), '9: invalid frontmatter is not silently loaded');
      const joined = diagnostics.join('\n');
      ok(joined.includes('ignored: invalid skill name'), '9: native diagnostic names the invalid skill name');
      ok(joined.includes('ignored: frontmatter requires name and description'), '9: native diagnostic names the missing description');
      ok(joined.includes('ignored: invalid YAML frontmatter'), '9: native diagnostic names the invalid frontmatter');
      const getInvalid = await ctx.skills.get('Not_Kebab Valid!', { cwd: root }).catch(() => undefined);
      ok(getInvalid === undefined, '8: an invalid name cannot be loaded either');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // -- 20: hello fixture loads with its unique marker ---------------------------
  {
    const root = await makeFixture();
    try {
      const skillsRoot = path.join(root, '.agents', 'skills');
      fs.mkdirSync(skillsRoot, { recursive: true });
      fs.cpSync(path.join(repoRoot, 'tests', 'fixtures', 'skills', 'nexus-skill-test'), path.join(skillsRoot, 'nexus-skill-test'), { recursive: true });
      const catalog = await makeCatalog({ dshHome: root, agentsHome: path.join(root, 'none') });
      const skills = await catalog.list(root);
      const found = skills.find((s) => s.name === 'nexus-skill-test');
      ok(found && found.description.includes('testing whether Nexus Agent Skills discovery and loading works'), '20: hello test skill is cataloged with its description');
      const loaded = await catalog.get('nexus-skill-test', root);
      ok(loaded && loaded.content.includes('NEXUS_SKILL_TEST_OK'), '20: hello test skill body loads with the NEXUS_SKILL_TEST_OK marker');
      await catalog.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log('PASS: nexus-skills runtime suite (' + passed + ' assertions)');
}

main().catch((error) => { console.error(error); process.exitCode = 1 });
