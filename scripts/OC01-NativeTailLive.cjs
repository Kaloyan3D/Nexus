'use strict';
/**
 * OC01-NativeTailLive.cjs - live ACTIVE-TAIL-NATIVE canary phase for
 * request-shape opencode-muse-request-shape-v2-native-tail.
 *
 * Drives the REAL pinned DSH loop (cordis + LlmRuntime + invariants +
 * SessionStore + AgentLoop + ToolRuntime), the REAL dsh-llm-pi-ai adapter
 * configured from the installed settings.yaml profile, the real M01
 * producer, Routing-Integrity and installOpencodeActiveProjection, with the
 * real Meta count endpoint. The adapter's baseURL points at a local
 * recording proxy that forwards every request unchanged to OpenCode Go and
 * streams the response back, so the exact posted body is observed.
 *
 * Health for the run comes from a certification written to a TEMPORARY
 * store inside the run's fixture root (process-local); the installed
 * certification store is never read or written here. OC01 certifies the
 * installed store only after this phase passes.
 *
 * Output is content-free: counts, typed stages/reasons, sha256 digests of
 * canonical bodies. Never prompts, tool payloads, bodies or credentials.
 *
 * dryRun: the upstream is an in-process scripted Responses endpoint and the
 * Meta counter uses a local deterministic transport (plumbing check only;
 * never certifies).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const PROVIDER = 'opencode-go';
const MODEL = 'muse-spark-1.3-contributor';
const OPENCODE_HOST = 'opencode.ai';
const SKILL = 'nexus-engineering-workflow';
const SECOND_SKILL = 'spec-reader';
const TURN_ONE = 'Canary turn one. Reply with one short sentence acknowledging the task.';
const TURN_TWO = 'Canary turn two. First call the load_skill tool with name "' + SKILL + '". After it reports loaded, call load_skill once with name "'
  + SECOND_SKILL + '". After that, reply with the single word DONE. Never load the same skill twice.';

const sha = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}
const canon = (value) => JSON.stringify(canonicalize(value));
const COUNTED_KEYS = ['model', 'input', 'tools', 'reasoning', 'max_output_tokens'];
function countedSubset(body) {
  const out = {};
  for (const key of COUNTED_KEYS) if (body[key] !== undefined) out[key] = body[key];
  return out;
}
function itemKind(item) {
  return item && typeof item.type === 'string' ? item.type : (item && typeof item.role === 'string' ? 'role:' + item.role : 'unknown');
}

// ---- scripted upstream (dry run only) ----
function scriptedResponseItems(body, scenario) {
  const input = Array.isArray(body.input) ? body.input : [];
  const last = input[input.length - 1] || {};
  const text = JSON.stringify(input);
  const reasoning = (id) => ({ type: 'reasoning', id, summary: [], encrypted_content: 'DRY-ENC-' + id });
  if (text.indexOf('Canary turn two') === -1) {
    return [reasoning('rs_dry_0'), { type: 'message', id: 'msg_dry_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Acknowledged.', annotations: [] }] }];
  }
  // Fault scenario: the model keeps reloading the workflow skill.
  if (scenario === 'reload-loop' && last.type === 'function_call_output') {
    return [reasoning('rs_dry_loop'), { type: 'function_call', id: 'fc_dry_loop_' + input.length, call_id: 'call_dry_loop_' + input.length, name: 'load_skill', arguments: JSON.stringify({ name: SKILL }), status: 'completed' }];
  }
  if (last.type === 'function_call_output' && last.output === 'loaded') {
    return [reasoning('rs_dry_2'), { type: 'function_call', id: 'fc_dry_2', call_id: 'call_dry_2', name: 'load_skill', arguments: JSON.stringify({ name: SECOND_SKILL }), status: 'completed' }];
  }
  if (last.type === 'function_call_output') {
    return [reasoning('rs_dry_3'), { type: 'message', id: 'msg_dry_3', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] }];
  }
  return [reasoning('rs_dry_1'), { type: 'function_call', id: 'fc_dry_1', call_id: 'call_dry_1', name: 'load_skill', arguments: JSON.stringify({ name: SKILL }), status: 'completed' }];
}
function scriptedSse(body, index, scenario) {
  const items = scriptedResponseItems(body, scenario);
  const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(countedSubset(body))) / 4);
  const events = [{ type: 'response.created', response: { id: 'resp_dry_' + index, status: 'in_progress', output: [] } }];
  items.forEach((item, i) => events.push({ type: 'response.output_item.done', output_index: i, item }));
  events.push({ type: 'response.completed', response: { id: 'resp_dry_' + index, status: 'completed', output: items, usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } } });
  return events.map((event) => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
}
function dryMetaTransport() {
  return {
    postJson: async (req) => {
      const bytes = Buffer.byteLength(typeof req.bodyJson === 'string' ? req.bodyJson : JSON.stringify(req.bodyJson));
      return { status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: Math.ceil(bytes / 4) }) };
    },
  };
}

// Content-free summary of a Responses SSE stream: output item kinds + usage.
function responseSummary(text) {
  const out = { completed: false, outputKinds: [], usage: null };
  for (const block of String(text || '').split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    let event = null;
    try { event = JSON.parse(line.slice(6)); } catch { continue; }
    if (event.type === 'response.completed') {
      const response = event.response || {};
      out.completed = true;
      out.outputKinds = Array.isArray(response.output) ? response.output.map(itemKind) : [];
      if (response.usage) {
        out.usage = { inputTokens: response.usage.input_tokens, cachedTokens: response.usage.input_tokens_details ? response.usage.input_tokens_details.cached_tokens : null,
          outputTokens: response.usage.output_tokens, reasoningTokens: response.usage.output_tokens_details ? response.usage.output_tokens_details.reasoning_tokens : null };
      }
    }
  }
  return out;
}

// ---- recording proxy ----
function startProxy(options) {
  const posted = [];
  const upstreamStatus = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const record = { path: req.url, bodyText, responseText: '' };
      posted.push(record);
      const index = posted.length;
      if (index > options.maxRequests) {
        upstreamStatus.push('capped');
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"canary request cap reached","type":"invalid_request_error","code":"canary_cap"}}');
        return;
      }
      if (options.dryRun) {
        upstreamStatus.push(200);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        record.responseText = scriptedSse(JSON.parse(bodyText), index, options.dryScenario);
        res.end(record.responseText);
        return;
      }
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (['host', 'content-length', 'connection'].indexOf(key.toLowerCase()) !== -1) continue;
        headers[key] = value;
      }
      headers['content-length'] = Buffer.byteLength(bodyText);
      const upstream = https.request({ hostname: OPENCODE_HOST, path: req.url, method: req.method, headers, timeout: 300000 }, (up) => {
        upstreamStatus.push(up.statusCode);
        const passHeaders = {};
        for (const [key, value] of Object.entries(up.headers)) {
          if (['content-length', 'transfer-encoding', 'connection'].indexOf(key.toLowerCase()) !== -1) continue;
          passHeaders[key] = value;
        }
        res.writeHead(up.statusCode, passHeaders);
        up.on('data', (chunk) => { record.responseText += chunk; res.write(chunk); });
        up.on('end', () => res.end());
      });
      upstream.on('timeout', () => upstream.destroy(new Error('canary-upstream-timeout')));
      upstream.on('error', (error) => {
        upstreamStatus.push('transport:' + String(error && error.code || 'error').slice(0, 32));
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"canary upstream transport failure","type":"server_error"}}');
      });
      upstream.end(bodyText);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, posted, upstreamStatus, port: server.address().port })));
}

/**
 * input: { installRoot, appRoot, repoRoot, canaryDigest, dryRun?, maxRequests?,
 *          reasoningEffort?, turnTimeoutMs?, log? }
 * returns { ok, failures: [..typed..], report }
 */
async function runNativeTailLive(input) {
  // Production reasoning effort (settings.yaml opencode-go `reasoning: xhigh`).
  const opts = Object.assign({ dryRun: false, maxRequests: 10, reasoningEffort: 'xhigh', turnTimeoutMs: 900000 }, input);
  const repoRoot = opts.repoRoot;
  const cfg = (name) => require(path.join(repoRoot, 'config', name));
  const host = cfg('ContextCompilerActiveOpencodeHostV2.cjs');
  const opencode = cfg('ContextCompilerActiveOpencodeV2.cjs');
  const remote = cfg('ContextRemoteCounterMuseV2.cjs');
  const cert = cfg('ContextAuthorityCertificationV2.cjs');
  const wire = cfg('ContextWireProjectorResponsesV2.cjs');
  const integrity = cfg('Routing-Integrity.cjs');
  const profiles = cfg('Engineering-Profiles.cjs');
  const producerHost = cfg('ContextMemoryProducerHostV2.cjs');
  const appRequire = createRequire(path.join(opts.appRoot, 'package.json'));
  const appModules = path.join(opts.appRoot, 'node_modules', '@deepseek-ai');
  const { Context } = appRequire('@deepseek-ai/cordis');
  const llmMod = appRequire('@deepseek-ai/dsh-llm');
  const SessionStore = appRequire('@deepseek-ai/dsh-session').default;
  const SystemPrompt = appRequire('@deepseek-ai/dsh-system-prompt').default;
  const toolsPackage = appRequire('@deepseek-ai/dsh-tools');
  const agentPackage = appRequire('@deepseek-ai/dsh-agent');
  const AgentLoop = appRequire('@deepseek-ai/dsh-agent-loop').default;
  const Invariants = appRequire('@deepseek-ai/dsh-invariants').default;
  const piAi = appRequire('@deepseek-ai/dsh-llm-pi-ai');
  const Credentials = appRequire('@deepseek-ai/dsh-credentials-local').default;
  const YAML = appRequire('yaml');
  const llmInvariant = await import(pathToFileURL(path.join(appModules, 'dsh-llm', 'lib', 'invariant.js')).href);
  const loopInvariant = await import(pathToFileURL(path.join(appModules, 'dsh-agent-loop', 'lib', 'invariant.js')).href);

  const failures = [];
  const fail = (code, detail) => failures.push(detail === undefined ? code : code + ':' + String(detail).slice(0, 200));
  const report = { mode: opts.dryRun ? 'dry-run' : 'live', requests: [], compiled: [], usage: [], anomalies: 0 };

  // Fixture root: the INSTALLED settings/model registry, active policy,
  // one bound task session. Temporary certification store.
  const fxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc01-nt-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oc01-nt-ws-'));
  const dataRoot = path.join(fxRoot, 'data');
  fs.mkdirSync(path.join(fxRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
  for (const name of ['settings.yaml', 'model-registry.json']) {
    fs.copyFileSync(path.join(opts.installRoot, 'config', name), path.join(fxRoot, 'config', name));
  }
  // RC1.1: the canary context never reaches the pressure gate; certification
  // pins activation explicitly (activation-forced-by-policy on every line).
  fs.writeFileSync(path.join(fxRoot, 'config', 'routing-policy.json'), JSON.stringify({ version: 3, contextCompiler: { mode: 'active', activation: 'always' } }));
  const sessionId = 'sess-oc01-native-tail-' + crypto.randomBytes(4).toString('hex');
  const binding = {
    sessionId, taskInstanceId: 'task_oc01_nt_0001', taskId: 'TASK-OC01-NT',
    workspace, workspaceId: workspace, repositoryId: 'repo-oc01-nt', checkoutId: 'co-oc01-nt',
    preset: 'aih-muse', engine: 'muse',
  };
  const bindingsPath = path.join(dataRoot, 'routing', 'session-bindings.json');
  fs.writeFileSync(bindingsPath, JSON.stringify({ schemaVersion: 1, bindings: { [sessionId]: binding } }));
  const stateFile = profiles.routingStatePath(fxRoot, binding);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(Object.assign({}, binding, { profile: MODEL, provider: PROVIDER, model: MODEL, reasoning: opts.reasoningEffort })));
  const identity = host.currentOpencodeIdentityV2({ installRoot: fxRoot });
  if (identity.known !== true) {
    fail('identity-unknown');
    return { ok: false, failures, report };
  }
  report.requestShapeRevision = identity.identity.requestShapeRevision;
  const tempStore = path.join(dataRoot, 'ccv2-authority');
  cert.certifyOpencodeV2(tempStore, identity.identity, opts.canaryDigest);

  const proxy = await startProxy({ dryRun: opts.dryRun, maxRequests: opts.maxRequests, dryScenario: opts.dryRun ? opts.dryScenario : null });
  const profileSection = YAML.parse(fs.readFileSync(path.join(fxRoot, 'config', 'settings.yaml'), 'utf8'))['llm-pi-ai'].providers[PROVIDER];
  const DRY_KEY_ENV = 'NEXUS_OC01_DRY_RUN_LOCAL_KEY';
  const piProfile = Object.assign({}, profileSection, { baseURL: 'http://127.0.0.1:' + proxy.port + '/zen/go/v1' });
  if (opts.dryRun) {
    process.env[DRY_KEY_ENV] = 'dry-run-local-key';
    piProfile.apiKeyEnv = DRY_KEY_ENV;
  }
  const previous = { home: process.env.DSH_HOME, root: process.env.AIH_INSTALL_ROOT };
  process.env.DSH_HOME = dataRoot;
  process.env.AIH_INSTALL_ROOT = fxRoot;
  opencode.resetOpencodeHealthV2();
  const epochBefore = remote.processCounterResilienceV2().cacheEpochV2();
  const logs = [];
  const entered = [];
  const sent = [];
  const counted = [];
  let ctx = null;
  try {
    ctx = new Context();
    await ctx.plugin(Invariants);
    await ctx.plugin(llmMod.default);
    await ctx.plugin(llmInvariant);
    if (!opts.dryRun) await ctx.plugin(Credentials, { path: path.join(opts.installRoot, 'data', '.credentials.yaml'), watch: false });
    await ctx.plugin(piAi, { providers: { [PROVIDER]: piProfile } });
    await ctx.plugin(SessionStore);
    await ctx.plugin(SystemPrompt, { persona: 'Nexus OC01 native-tail canary. Use tools exactly as the user instructs.' });
    await ctx.plugin(toolsPackage.default);
    await ctx.plugin(agentPackage.default);
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(loopInvariant);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const skillLoads = [];
    ctx.tools.register(toolsPackage.defineTool({
      name: 'load_skill',
      description: 'Load a named skill. Returns "loaded" when the skill is available.',
      parameters: { name: { type: 'string', required: true, description: 'Skill name.' } },
      output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: value }] },
      execute: async (args) => {
        skillLoads.push(String(args.name));
        return args.name === SKILL ? 'loaded' : 'loaded: ' + String(args.name).slice(0, 40);
      },
    }));
    integrity.apply(ctx);
    const producer = producerHost.installMemoryProducer(ctx, {
      bindingFor: (id) => (id === sessionId ? binding : null),
      flush: async () => true,
      authorityFor: () => () => ({
        manifest: {
          schemaVersion: 1, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, description: 'OC01 native-tail canary objective.',
          status: 'implementing', acceptanceCriteria: ['Progress through a multi-step tool turn.'], verification: { required: [], outcomes: [] },
          failureSignatures: [], baseCommit: 'oc01',
        },
        authorityRecord: null,
      }),
      log: (entry) => logs.push(entry),
      env: {},
    });
    if (producer.installed !== true) fail('producer-not-installed');
    // The real Meta counter, created by the HOST from the key it resolves at
    // completion through the production resolver (managed credential store,
    // exactly as AihController wires it). Every whole-payload count is
    // recorded (the exact object the counter serializes) without changing
    // behavior. The key never leaves the host/counter.
    const resolveMetaApiKey = opts.dryRun
      ? async () => 'dry-run-local-key'
      : async () => {
        const found = await ctx.credentials.resolve('MODEL_API_KEY');
        return found && typeof found.value === 'string' && found.value !== '' ? found.value : undefined;
      };
    report.metaKeySource = opts.dryRun ? 'dry-run' : (typeof process.env.MODEL_API_KEY === 'string' && process.env.MODEL_API_KEY !== '' ? 'env' : 'managed-credential-store');
    const recordPayload = async (fn, shape) => {
      const entry = { shapeCanon: canon(shape), tokens: null, error: null };
      counted.push(entry);
      try {
        const result = await fn(shape);
        entry.tokens = result.tokens;
        return result;
      } catch (error) {
        entry.error = { code: error && typeof error.code === 'string' ? error.code : null,
          httpStatus: error && error.counterFailure ? error.counterFailure.httpStatus : null };
        throw error;
      }
    };
    let countersCreated = 0;
    const createMetaCounter = (input) => {
      countersCreated += 1;
      const realCounter = remote.createMuseRemoteCounterV2(Object.assign({}, input, opts.dryRun ? { transport: dryMetaTransport() } : {}));
      return Object.assign({}, realCounter, {
        countPayloadV2: (shape) => recordPayload(realCounter.countPayloadV2, shape),
        beginCountOperationV2: (options) => {
          const op = realCounter.beginCountOperationV2(options);
          return Object.assign({}, op, { countPayloadV2: (shape) => recordPayload(op.countPayloadV2, shape) });
        },
      });
    };
    ctx.on('llm/stream', (options, next) => { entered.push(options); return next(); }, { global: true });
    const installed = host.installOpencodeActiveProjection(ctx, {
      installRoot: fxRoot, bindingsPath, log: (entry) => logs.push(entry),
      sessionSourceFor: producer.registry.sessionSourceFor, liveSessionFor: producer.registry.liveSessionFor,
      resolveMetaApiKey, createMetaCounter, prewarm: false,
    });
    if (installed.installed !== true) fail('projection-not-installed', installed.reason);
    report.healthAtStart = opencode.opencodeHealthV2({ provider: PROVIDER, model: MODEL });
    ctx.on('llm/stream', (options, next) => { sent.push(options); return next(); }, { global: true });
    const agent = ctx.agentLoop.create(sessionId, { provider: PROVIDER, model: MODEL, maxTokens: 4096, reasoningEffort: opts.reasoningEffort });
    const errors = [];
    ctx.on('agent/error', ({ error }) => { errors.push(String((error && error.code) || (error && error.name) || 'error').slice(0, 64)); });
    const turn = async (text) => {
      const idle = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('canary turn timed out')), opts.turnTimeoutMs);
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject === agent && status === 'idle') { clearTimeout(timer); dispose(); resolve(); }
        });
      });
      agent.followup(llmMod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
      await idle;
      await producer.registry.idle(sessionId);
    };
    await turn(TURN_ONE);
    report.turn1 = { requests: sent.length, errors: errors.length, sealedGeneration: producer.registry.describe(sessionId).sealedGeneration };
    if (producer.registry.describe(sessionId).sealedGeneration < 1) fail('turn1-not-sealed');
    const turn2Start = sent.length;
    await turn(TURN_TWO);
    report.errors = errors.slice();
    if (errors.length > 0) fail('agent-errors', errors.join(','));
    report.upstreamStatus = proxy.upstreamStatus.map(String);
    if (proxy.upstreamStatus.some((status) => status !== 200)) fail('upstream-non-200', proxy.upstreamStatus.join(','));
    if (proxy.posted.length !== sent.length) fail('send-count-mismatch', proxy.posted.length + '/' + sent.length);

    // ---- evaluation (content-free) ----
    const decisions = logs.filter((entry) => entry && entry.event === 'ccv2-opencode-active-decided');
    const usageLines = logs.filter((entry) => entry && entry.event === 'ccv2-opencode-usage-observed');
    report.anomalies = logs.filter((entry) => entry && entry.event === 'ccv2-opencode-anomaly-revoked').length;
    if (decisions.length !== sent.length) fail('decision-count-mismatch', decisions.length + '/' + sent.length);
    let countCursor = 0;
    sent.forEach((derived, index) => {
      const decision = decisions[index] || {};
      const body = proxy.posted[index] ? JSON.parse(proxy.posted[index].bodyText) : null;
      const row = {
        index, turn: index < turn2Start ? 1 : 2, projectionMode: decision.projectionMode || null,
        fallbackReason: decision.fallbackReason === undefined ? null : decision.fallbackReason,
        fallbackStage: decision.fallbackStage === undefined ? null : decision.fallbackStage,
        attemptFailureStage: decision.attemptFailureStage || null, nativeTailSkip: decision.nativeTailSkip || null,
        inputItems: body ? body.input.map(itemKind) : null,
        reasoningReplay: decision.reasoningReplay === undefined ? null : decision.reasoningReplay,
        replayedReasoningBlocksOmitted: decision.replayedReasoningBlocksOmitted === undefined ? null : decision.replayedReasoningBlocksOmitted,
        response: proxy.posted[index] ? responseSummary(proxy.posted[index].responseText) : null,
      };
      report.requests.push(row);
      if (row.turn === 2 && row.projectionMode !== 'CCV2_COMPILED') fail('turn2-not-compiled', index + ':' + row.fallbackReason + '@' + row.fallbackStage + '/' + row.attemptFailureStage + '/' + row.nativeTailSkip);
      if (row.projectionMode !== 'CCV2_COMPILED' || body === null) return;
      // Two whole-payload counts per compilation: reserve, then final.
      const reserve = counted[countCursor];
      const final = counted[countCursor + 1];
      countCursor += 2;
      const postedCounted = canon(countedSubset(body));
      const original = entered[entered.indexOf(derived) - 1];
      const anchor = original.messages.findIndex((m) => m.role === 'user' && JSON.stringify(m.content).indexOf('Canary turn two') !== -1);
      // Lossless tail under reasoningReplay=none: non-reasoning objects by
      // reference; an assistant copy keeps its surviving blocks by reference.
      const tailByReference = anchor > 0 && derived.messages.length === original.messages.length - anchor
        && derived.messages.every((m, i) => {
          const o = original.messages[anchor + i];
          if (m === o) return true;
          const kept = o.role === 'assistant' ? o.content.filter((b) => b.type !== 'reasoning') : null;
          return kept !== null && m.id === o.id && m.content.length === kept.length && kept.every((b, j) => m.content[j] === b);
        });
      const developerFirst = body.input[0] && body.input[0].role === 'developer';
      const noUserTranscript = body.input.every((item) => !(item.role === 'user' && JSON.stringify(item.content).indexOf('[tool-call') !== -1));
      const turnOnce = proxy.posted[index].bodyText.split('Canary turn two').length === 2 && derived.system.indexOf('Canary turn two') === -1;
      const calls = body.input.filter((item) => item.type === 'function_call');
      const outputs = body.input.filter((item) => item.type === 'function_call_output');
      const correlated = calls.every((c) => outputs.some((o) => o.call_id === c.call_id)) && outputs.every((o) => calls.some((c) => c.call_id === o.call_id));
      const compiled = {
        index,
        countedEqualsPosted: final !== undefined && final.error === null && final.shapeCanon === postedCounted,
        countedDigest: final === undefined ? null : sha(final.shapeCanon),
        postedDigest: sha(postedCounted),
        reserveCounted: reserve !== undefined && reserve.error === null,
        preCount: final === undefined ? null : final.tokens,
        tailMessages: derived.messages.length,
        tailByReference,
        systemPrefix: typeof derived.system === 'string' && derived.system.startsWith(original.system + host.CCV2_SYSTEM_SEPARATOR_V1),
        developerFirst,
        noUserTranscript,
        currentTurnOnce: turnOnce,
        functionCalls: calls.length,
        functionCallOutputs: outputs.length,
        correlated,
        historicalReasoningItems: body.input.filter((item) => item.type === 'reasoning').length,
        reasoningSettings: body.reasoning ? { effort: body.reasoning.effort, summary: body.reasoning.summary } : null,
        metaAccepted: reserve !== undefined && reserve.error === null && final !== undefined && final.error === null,
        freshReasoningReturned: row.response !== null && row.response.outputKinds.indexOf('reasoning') !== -1,
        signalPreserved: derived.signal === original.signal,
      };
      report.compiled.push(compiled);
      if (compiled.historicalReasoningItems !== 0) fail('historical-reasoning-replayed', String(index));
      if (row.reasoningReplay !== 'none') fail('reasoning-replay-not-none', String(index));
      if (compiled.reasoningSettings === null || compiled.reasoningSettings.effort !== opts.reasoningEffort) fail('reasoning-settings-changed', String(index));
      for (const key of ['countedEqualsPosted', 'reserveCounted', 'metaAccepted', 'freshReasoningReturned', 'systemPrefix', 'developerFirst', 'noUserTranscript', 'currentTurnOnce', 'correlated', 'signalPreserved']) {
        if (compiled[key] !== true) fail('compiled-proof-' + key, String(index));
      }
      const projection = wire.projectResponsesWireV2({ request: derived, route: wire.readResponsesRouteFromSettingsV2(fs.readFileSync(path.join(fxRoot, 'config', 'settings.yaml'), 'utf8'), PROVIDER, MODEL) });
      if (JSON.stringify(projection.wireBody) !== proxy.posted[index].bodyText) fail('projector-differs-from-posted', String(index));
    });
    // Multi-step progression (B): the skill call + "loaded" are the last
    // native items of the NEXT request, and the model progresses.
    const skillIndex = report.requests.findIndex((row, i) => row.turn === 2 && proxy.posted[i]
      && JSON.parse(proxy.posted[i].bodyText).input.some((item) => item.type === 'function_call_output'));
    let nativeCausal = false;
    if (skillIndex !== -1) {
      const items = JSON.parse(proxy.posted[skillIndex].bodyText).input;
      const lastCall = items[items.length - 2];
      const lastOut = items[items.length - 1];
      let args = {};
      try { args = JSON.parse(lastCall.arguments); } catch { args = {}; }
      nativeCausal = lastCall.type === 'function_call' && lastCall.name === 'load_skill' && args.name === SKILL
        && lastOut.type === 'function_call_output' && lastOut.call_id === lastCall.call_id && lastOut.output === 'loaded';
    }
    report.progression = {
      turn2Requests: sent.length - turn2Start,
      skillLoads: skillLoads.map((name) => (name === SKILL ? 'workflow' : name === SECOND_SKILL ? 'second' : 'other')),
      workflowLoads: skillLoads.filter((name) => name === SKILL).length,
      nativeCausalAfterSkill: nativeCausal,
      capped: proxy.upstreamStatus.indexOf('capped') !== -1,
    };
    if (report.progression.turn2Requests < 3) fail('no-multi-step');
    if (report.progression.skillLoads.join(',') !== 'workflow,second') fail('unexpected-tool-sequence', report.progression.skillLoads.join(','));
    if (!nativeCausal) fail('skill-not-native-causal');
    if (report.progression.workflowLoads !== 1) fail('workflow-skill-reloaded', String(report.progression.workflowLoads));
    if (report.progression.capped) fail('request-cap-reached');
    // Usage observer (E).
    report.usage = usageLines.map((u) => ({ inputTokens: u.inputTokens, uncachedInputTokens: u.uncachedInputTokens, cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens, preCount: u.preCount, margin: u.margin, drift: u.preCountDrift, withinMargin: u.withinMargin }));
    if (usageLines.length !== report.compiled.length) fail('usage-not-observed', usageLines.length + '/' + report.compiled.length);
    if (usageLines.some((u) => u.withinMargin !== true)) fail('usage-over-margin');
    if (report.anomalies > 0) fail('anomaly-revoked');
    report.countersCreatedByHost = countersCreated;
    if (countersCreated < report.compiled.length) fail('host-did-not-create-counter');
    report.cacheEpochBefore = epochBefore;
    report.cacheEpochAfter = remote.processCounterResilienceV2().cacheEpochV2();
    report.healthAtEnd = opencode.opencodeHealthV2({ provider: PROVIDER, model: MODEL });
    if (report.healthAtEnd !== 'HEALTHY') fail('route-quarantined-during-run');
    if (report.compiled.length === 0) fail('nothing-compiled');
    if (!report.compiled.some((c) => c.functionCalls >= 2 && c.functionCallOutputs >= 2)) fail('no-two-tool-native-continuation-compiled');
    if (report.cacheEpochAfter !== report.cacheEpochBefore) fail('cache-epoch-bumped');
    const finalRow = report.requests[report.requests.length - 1];
    if (!finalRow || !finalRow.response || finalRow.response.outputKinds.indexOf('function_call') !== -1 || finalRow.response.outputKinds.indexOf('message') === -1) {
      fail('no-final-response-after-tools');
    }
  } catch (error) {
    // Typed only: an error message may quote request content.
    fail('exception', (error && typeof error.code === 'string' && error.code) || (error && error.name) || 'unknown');
  } finally {
    if (ctx) await ctx.fiber.dispose().catch(() => {});
    proxy.server.close();
    if (opts.dryRun) delete process.env[DRY_KEY_ENV];
    if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
    if (previous.root === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previous.root;
    opencode.resetOpencodeHealthV2();
    fs.rmSync(fxRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, failures, report };
}

module.exports = { runNativeTailLive, TURN_TWO, SKILL };
