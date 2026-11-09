'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createServer, Socket } = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { resolveAihPowerShellHost } = require('./AihTestTransport.cjs');

async function createBoundaryFixture(installRoot, fault) {
  if (!installRoot) throw new Error('NEXUS_RUNTIME_ROOT must name a composed DSH installation');
  const source = fs.realpathSync(installRoot);
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nexus-boundary-'));
  const install = path.join(base, 'install');
  const data = path.join(install, 'data');
  let booted;
  let SDK;
  const agents = new Map();
  const initialEnvironment = { ...process.env };
  const initialCwd = process.cwd();
  const originalConnect = Socket.prototype.connect;
  let outboundAttempts = 0;
  async function close() {
    try { if (booted) await booted.shutdown.shutdown(0); }
    finally {
      booted = undefined;
      agents.clear();
    }
  }
  async function dispose() {
    try { await close(); }
    finally {
      for (const key of Object.keys(process.env)) if (!Object.hasOwn(initialEnvironment, key)) delete process.env[key];
      Object.assign(process.env, initialEnvironment);
      process.chdir(initialCwd);
      Socket.prototype.connect = originalConnect;
      // Remove the fixture-owned links themselves before any recursive
      // deletion. In particular the Windows junction targets are the shared
      // test installation and must never be part of the cleanup traversal.
      for (const item of ['app', 'runtime']) {
        const link = path.join(install, item);
        const stat = fs.lstatSync(link, { throwIfNoEntry: false });
        if (!stat) continue;
        assert(stat.isSymbolicLink(), 'expected fixture-owned link: ' + link);
        await fs.promises.unlink(link);
      }
      try {
        await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (cause) {
        const remaining = fs.readdirSync(base, { recursive: true }).slice(0, 20);
        throw new Error('Boundary fixture cleanup failed; remaining entries: ' + JSON.stringify(remaining), { cause });
      }
    }
  }

  async function start() {
    const launch = await SDK.load('@deepseek-ai/dsh-launch-environment');
    const { runProfile } = await SDK.load('@deepseek-ai/dsh/profile-boot');
    const environment = launch.createLaunchEnvironmentSnapshot([{ source: 'process', values: {
      ...process.env, DSH_HOME: data,
    } }]);
    const occupied = fault === 'startup' ? createServer() : null;
    try {
      if (occupied) await once(occupied.listen(0, '127.0.0.1'), 'listening');
      const port = occupied ? String(occupied.address().port) : '0';
      booted = await runProfile({ environment, profile: 'web', patchFiles: [],
        args: ['--no-open', '--host', '127.0.0.1', '--port', port] });
      assert(booted.ctx.agentPresets && booted.ctx.webServer, 'real DSH profile did not start');
    } finally {
      if (occupied?.listening) await new Promise(resolve => occupied.close(resolve));
    }
  }

  try {
    fs.mkdirSync(data, { recursive: true });
    for (const item of ['app', 'runtime']) {
      fs.symlinkSync(path.join(source, item), path.join(install, item), process.platform === 'win32' ? 'junction' : 'dir');
    }
    for (const item of ['config', 'scripts']) fs.cpSync(path.join(source, item), path.join(install, item), { recursive: true });
    // Copy only managed composition, never operator credentials, storage, or bindings.
    for (const item of ['.agent-presets', 'OpenCode-SessionHeader.cjs', 'Routing-Integrity.cjs']) {
      fs.cpSync(path.join(source, 'data', item), path.join(data, item), { recursive: true });
    }
    fs.mkdirSync(path.join(data, 'profiles'));
    fs.cpSync(path.join(source, 'data', 'profiles', 'node_modules'), path.join(data, 'profiles', 'node_modules'), { recursive: true });
    fs.copyFileSync(path.join(install, 'config', 'settings.yaml'), path.join(data, 'nexus-settings.yaml'));
    require(path.join(install, 'scripts', 'Build-NexusHomePatch.cjs')).build(install);
    // This private host has no browser client, telemetry or published token.
    fs.appendFileSync(path.join(data, 'cordis.patch.yml'),
      '- id: web-runtime\n  config:\n    printUrl: false\n    openBrowser: false\n- id: desktop-product-telemetry\n  disabled: true\n');
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const keep = /^(?:PATH|PATHEXT|SystemRoot|SystemDrive|WINDIR|ComSpec|OS|ProgramFiles(?:\(x86\))?|ProgramW6432|ProgramData|CommonProgramFiles(?:\(x86\))?|CommonProgramW6432|TEMP|TMP|TMPDIR|LANG|LC_.*|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+))$/i;
    for (const key of Object.keys(process.env)) if (!keep.test(key)) delete process.env[key];
    Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
      DSH_HOME: data, AIH_INSTALL_ROOT: install, AIH_TOOLCHAIN_ROOT: install, DSH_TELEMETRY_DISABLED: '1' });
    if (process.platform === 'win32') {
      // Windows PowerShell expects these profile directories, even with
      // -NoProfile. Give it test-owned paths instead of the runner's home.
      process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
      process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
      fs.mkdirSync(process.env.APPDATA, { recursive: true });
      fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
      process.env.HOMEDRIVE = path.parse(home).root.slice(0, 2);
      process.env.HOMEPATH = home.slice(2);
      const windowsHost = resolveAihPowerShellHost(source);
      process.env.PSModulePath = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
      const startedAt = Date.now();
      await promisify(execFile)(windowsHost,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-FileHash -InputStream ([IO.MemoryStream]::new()) | Out-Null; if (-not $?){exit 1}'],
        { timeout: 30000, windowsHide: true });
      console.log('DSH boundary Windows PowerShell startup: ' + (Date.now() - startedAt) + ' ms');
    }
    const appRequire = createRequire(path.join(install, 'app', 'package.json'));
    const load = name => import(pathToFileURL(appRequire.resolve(name)).href);
    SDK = { load, dshVersion: appRequire('@deepseek-ai/dsh/package.json').version };
    if (fault === 'bypass') {
      const guard = path.join(data, '.agent-presets', 'aih-deepseek', 'Controller-RequestBoundary.cjs');
      assert(fs.lstatSync(guard).isFile(), 'mutation target must be a regular fixture file');
      assert.equal(path.relative(data, fs.realpathSync(guard)), path.relative(data, guard), 'mutation target escaped the fixture');
      const text = fs.readFileSync(guard, 'utf8');
      const anchor = '    let target = boundary.targetFor(payload)';
      assert.equal(text.split(anchor).length, 2, 'mutation anchor is unique');
      fs.writeFileSync(guard, text.replace(anchor, '    return next()\n' + anchor));
    }
    process.chdir(base);
    // Real DSH still owns the listener and dispatch. No client connection is
    // necessary in this in-process fixture, including model catalog requests.
    Socket.prototype.connect = function () {
      outboundAttempts++;
      throw new Error('Outbound connection attempted by the DSH security fixture');
    };
    await start();
    const { installModelSelection, agentEvents } = await load('@deepseek-ai/dsh-agent');
    const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
    const { prepareSession } = require(path.join(install, 'config', 'AihController.cjs'));
    async function createSession({ sessionId = randomUUID(), cwd, agentPreset }, resume = false) {
      fs.mkdirSync(cwd, { recursive: true });
      const ctx = booted.ctx;
      const resolved = await ctx.agentPresets.resolve(agentPreset);
      const agentOptions = ctx.agentDefaultModel.currentSelection();
      const options = { agentOptions, setup: async agentCtx => {
        installModelSelection(agentCtx);
        await ctx.agentPresets.mount(agentCtx, resolved.id);
      } };
      const handle = resume ? await ctx.agents.resume({ ...options, resumeSessionId: sessionId }) :
        await ctx.agents.create({ ...options, sessionId, meta: { cwd, agentPreset: resolved.id } });
      agents.set(sessionId, handle.agent);
      return handle.agent;
    }
    async function probe(sessionId, action, extra = {}) {
      const startedAt = Date.now();
      const agent = agents.get(sessionId);
      assert(agent, 'probe requires a live fixture-owned DSH agent');
      if (action === 'prepare') {
        const result = await prepareSession(booted.ctx, { sessionId, cwd: agent.session.header.cwd,
          preset: booted.ctx.agentPresets.presetForSession(agent.session), profileId: extra.profileId });
        return { ok: true, result };
      }
      const dispatch = agentEvents(booted.ctx, agent);
      const messages = action === 'prestep' ? [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/verify' }] })] : [];
      const header = Object.getOwnPropertyDescriptor(agent.session, 'header');
      // DSH derives session.id from header. Preserve the real scope identity
      // while exercising the guard's missing-header branch.
      if (extra.noHeader) Object.defineProperty(agent.session, 'id', { configurable: true, value: sessionId });
      if (extra.worker || extra.noHeader) Object.defineProperty(agent.session, 'header', {
        configurable: true, value: extra.noHeader ? undefined : { ...agent.session.header, origin: 'subagent', delegationDepth: 1 },
      });
      const payload = { messages, turn: 1, step: 1, signal: new AbortController().signal, modelSelection: agent.model.current() };
      let nextCount = 0;
      try {
        if (action === 'arm' || action === 'prestep') {
          const result = await dispatch.waterfall('agent/pre-step', payload, async () => {
            nextCount++;
            return { kind: 'enter', messages: [] };
          });
          return { nextCount, result };
        }
        const result = await dispatch.waterfall('agent/request', payload, async () => {
          nextCount++;
          return agent.model.current();
        });
        return { nextCount, result };
      } catch (error) {
        if (typeof error.code !== 'string') throw error;
        return { nextCount, result: { kind: 'reject', refused: true, code: error.code } };
      } finally {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= 5000) console.log(`DSH boundary probe ${action} took ${elapsed} ms`);
        if (extra.noHeader) delete agent.session.id;
        if (extra.worker || extra.noHeader) {
          if (header) Object.defineProperty(agent.session, 'header', header);
          else delete agent.session.header;
        }
      }
    }
    return { base, install, data, dshVersion: SDK.dshVersion, createSession, probe,
      restart: async () => { await close(); await start(); },
      outboundAttempts: () => outboundAttempts, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

module.exports = { createBoundaryFixture };
