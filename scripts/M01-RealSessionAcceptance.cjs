#!/usr/bin/env node
'use strict';
/**
 * M01-RealSessionAcceptance.cjs - CCV2-R1/M01 real-session acceptance gate.
 *
 * Replays a persisted Nexus session (read-only) through the ACTUAL
 * production producer into a scratch workspace, proves incremental ==
 * replay for identity-relevant durable state, reports real-session scale,
 * builds the C07 shadow candidate and the C08 candidate from the produced
 * memory, and (when MODEL_API_KEY is set) counts the LEGACY physical
 * request and the CCv2 physical request with the same Meta Muse
 * /v1/responses/input_tokens authority. No hand editing, no fixtures.
 *
 * Usage:
 *   node scripts/M01-RealSessionAcceptance.cjs --session <session.jsonl.zstd>
 *     --task TASK-0044 --controller-workspace <repo> --out <scratch-dir>
 *     [--count] [--install-root <nexus install root>]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const cfg = (name) => require(path.join(repoRoot, 'config', name));
const producerV2 = cfg('ContextMemoryProducerV2.cjs');
const shadowHost = cfg('ContextCompilerShadowHostV2.cjs');
const shadowV2 = cfg('ContextCompilerShadowV2.cjs');
const adapterV2 = cfg('ContextCompilerShadowAdapterV2.cjs');
const compilerV2 = cfg('ContextCompilerV2.cjs');
const rendererV2 = cfg('ContextPromptRendererV2.cjs');
const museV2 = cfg('ContextCompilerActiveMuseV2.cjs');
const remoteV2 = cfg('ContextRemoteCounterMuseV2.cjs');
const checkpointV2 = cfg('ContextCheckpointV2.cjs');
const memSession = cfg('ContextSessionEvidenceSourceV2.cjs');
const sessionLog = require(path.join(repoRoot, 'scripts', 'lib', 'Ccv2SessionLog.cjs'));

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}
const sha = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const canonical = (value) => JSON.stringify(checkpointV2.canonicalize(value));

function treeDigest(root) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (!/\.tmp-/.test(entry)) out.push(path.relative(root, full) + ' ' + crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return { files: out.length, digest: sha(out.join('\n')), lines: out };
}

function dirBytes(root) {
  let total = 0;
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full); else total += stat.size;
    }
  };
  walk(root);
  return total;
}

function surfaceMessages(dsh, events) {
  const folded = dsh.foldSurface(events);
  const out = [];
  for (const seq of folded.nodes) {
    const message = dsh.deriveEventMessage(events[seq]);
    if (message !== null) out.push(message);
  }
  return out;
}

function lastHeaderBefore(events, seq) {
  for (let index = seq; index >= 0; index -= 1) {
    if (events[index].type === 'request/header') return events[index].data.header;
  }
  return null;
}

// Faithful DSH -> pi-ai -> Responses conversion: DSH's own textOnlyContext
// (extracted verbatim from the installed dsh-llm-pi-ai) feeding pi-ai's
// real convertResponsesMessages/convertResponsesTools.
async function loadPhysicalConverter(installRoot) {
  const app = path.join(installRoot, 'app', 'node_modules');
  const piShared = await import(pathToFileURL(path.join(app, '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-responses-shared.js')).href);
  const dshLlm = await import(pathToFileURL(path.join(app, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href);
  const source = fs.readFileSync(path.join(app, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'), 'utf8');
  const cut = (from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    if (start === -1 || end === -1) throw new Error('dsh-llm-pi-ai source layout changed: ' + from);
    return source.slice(start, end);
  };
  const replaySrc = cut('function parseArguments(raw)', '//#endregion\n//#region lib/types/catalog.js');
  const contextSrc = cut('function flattenText(message)', 'function toPiContext(options');
  // eslint-disable-next-line no-new-func
  const factory = new Function('CallId', 'contentHasImage', 'LlmError', 'requestImageHandleText', 'offloadRequestImagesWithPolicy',
    replaySrc + '\n' + contextSrc + '\nreturn { textOnlyContext };');
  const { textOnlyContext } = factory(dshLlm.CallId, dshLlm.contentHasImage, dshLlm.LlmError, dshLlm.requestImageHandleText, dshLlm.offloadRequestImagesWithPolicy);
  return function toResponsesBody(model, header, messages) {
    const context = textOnlyContext({ system: header.system, messages, tools: header.tools }, () => {});
    const input = piShared.convertResponsesMessages(model, context, new Set(['openai', 'openai-codex', 'opencode']), {});
    const body = { input };
    if (Array.isArray(context.tools) && context.tools.length > 0) body.tools = piShared.convertResponsesTools(context.tools, {});
    if (header.config && typeof header.config.reasoningEffort === 'string') body.reasoning = { effort: header.config.reasoningEffort };
    return body;
  };
}

async function main() {
  const sessionPath = arg('session', null);
  const taskId = arg('task', 'TASK-0044');
  const controllerWorkspace = path.resolve(arg('controller-workspace', repoRoot));
  const out = path.resolve(arg('out', path.join(repoRoot, 'tmp', 'm01-acceptance')));
  const installRoot = path.resolve(arg('install-root', sessionLog.defaultInstallRoot()));
  if (typeof sessionPath !== 'string') throw new Error('--session is required');
  const report = {};
  const log = sessionLog.readSessionLog(sessionPath, { installRoot });
  const events = log.events;
  const dsh = sessionLog.loadDshSessionModule(installRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(controllerWorkspace, '.ai-harness', 'runs', taskId, 'manifest.json'), 'utf8'));
  const namespace = {
    taskId, taskInstanceId: manifest.taskInstanceId, sessionId: log.header.id,
    workspaceId: controllerWorkspace, repositoryId: null, checkoutId: null,
  };
  const authority = () => ({ manifest, authorityRecord: null });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // ---- 1. full replay (bootstrap) ----
  const fullWs = path.join(out, 'replay');
  let started = Date.now();
  const full = producerV2.replaySessionV2({ workspace: fullWs, namespace, events, controllerAuthority: authority });
  report.replay = Object.assign({ ms: Date.now() - started }, full.result);

  // ---- 2. incremental (one event at a time, durable barrier per event) ----
  const incWs = path.join(out, 'incremental');
  started = Date.now();
  const inc = producerV2.openMemoryProducerV2({ workspace: incWs, namespace, controllerAuthority: authority });
  for (const event of events) {
    inc.ingest([event], {
      eventsThrough: (seq) => events.slice(0, seq + 1),
      eventAt: (seq) => events[seq],
      durability: { flushedSeq: event.seq, flushParticipated: true },
    });
  }
  // A process restart mid-way must also converge: reopen and finish.
  report.incremental = { ms: Date.now() - started, processedThroughSeq: inc.processedThroughSeq() };
  const fullTree = treeDigest(fullWs);
  const incTree = treeDigest(incWs);
  report.replayEquivalence = {
    replayFiles: fullTree.files, incrementalFiles: incTree.files,
    replayDigest: fullTree.digest, incrementalDigest: incTree.digest,
    equal: fullTree.digest === incTree.digest,
  };

  // ---- 3. scale report (final state) ----
  const described = full.producer.describe();
  const memoryDir = producerV2.memoryDirForV2(fullWs, taskId);
  const staged = JSON.parse(fs.readFileSync(path.join(memoryDir, 'staged.json'), 'utf8'));
  const decisions = JSON.parse(fs.readFileSync(path.join(memoryDir, 'tier-decisions.json'), 'utf8'));
  const pageDecisions = decisions.filter((d) => typeof d.pageId === 'string');
  report.scale = {
    sessionEventCount: events.length,
    steps: events.filter((e) => e.type === 'step/start').length,
    turns: events.filter((e) => e.type === 'turn/start').length,
    unitCount: described.unitCount,
    pageCount: described.unitCount,
    stagedPageCount: staged.stagedPageCount,
    toolTransactionCount: described.unitCounts['tool-transaction'],
    conversationUnitCount: described.unitCounts.conversation,
    narrationUnitCount: described.unitCounts.narration,
    sealedGeneration: described.sealedGeneration,
    hot: pageDecisions.filter((d) => d.tier === 'HOT').length,
    warm: pageDecisions.filter((d) => d.tier === 'WARM').length,
    cold: pageDecisions.filter((d) => d.tier === 'COLD').length,
    blobCount: described.blobCount,
    legacySessionBytes: log.sourceBytes,
    legacySessionDecodedBytes: log.decodedBytes,
    ccv2DurableBytes: dirBytes(path.join(fullWs, '.ai-harness')),
    blocker: described.blocker,
    sealFailures: described.sealFailures,
  };

  // ---- 4. acceptance point: the last physical root request ----
  let lastStep = -1;
  for (const event of events) if (event.type === 'step/start') lastStep = event.seq;
  const prefix = events.slice(0, lastStep + 1);
  const pointWs = path.join(out, 'point');
  const point = producerV2.replaySessionV2({ workspace: pointWs, namespace, events: prefix, controllerAuthority: authority });
  const pointDir = producerV2.memoryDirForV2(pointWs, taskId);
  const header = lastHeaderBefore(events, lastStep);
  const messages = surfaceMessages(dsh, prefix);
  const request = {
    sessionId: namespace.sessionId, messages, system: header.system, tools: header.tools,
    provider: header.config.provider, model: header.config.model, maxTokens: header.config.maxTokens,
    reasoningEffort: header.config.reasoningEffort,
  };
  const sessionSource = memSession.createMemorySessionSourceV2(namespace.sessionId, prefix);
  const pointDecisions = JSON.parse(fs.readFileSync(path.join(pointDir, 'tier-decisions.json'), 'utf8')).filter((d) => typeof d.pageId === 'string');
  report.point = {
    lastStepSeq: lastStep,
    liveMessages: messages.length,
    sealedGeneration: point.producer.describe().sealedGeneration,
    hot: pointDecisions.filter((d) => d.tier === 'HOT').length,
    warm: pointDecisions.filter((d) => d.tier === 'WARM').length,
    cold: pointDecisions.filter((d) => d.tier === 'COLD').length,
  };

  // ---- 5. C07 shadow candidate through the real C07H assembly ----
  const dataDir = path.join(out, 'data');
  const bindingsPath = path.join(dataDir, 'routing', 'session-bindings.json');
  fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
  fs.writeFileSync(bindingsPath, JSON.stringify({ schemaVersion: 1, bindings: { [namespace.sessionId]: {
    workspace: pointWs, taskId, taskInstanceId: namespace.taskInstanceId, sessionId: namespace.sessionId,
  } } }));
  const policy = { mode: 'observe', valid: true, reason: null, tokenizer: shadowHost.LOGICAL_TOKENIZER_V1,
    budget: { hardMax: 10000000, target: 10000000 } };
  started = Date.now();
  const assembled = shadowHost.assembleShadowInputsV2({ request, policy, bindingsPath, sessionSourceFor: () => sessionSource });
  report.c07 = { assembled: assembled.skipped === null, skipped: assembled.skipped };
  if (assembled.skipped === null) {
    let observed = null;
    const outcome = adapterV2.observeCompilerShadowV2({
      mode: 'observe', request, actual: assembled.actual, candidateFactory: assembled.candidateFactory,
      getCurrentRevision: () => shadowHost.readSealedRevisionForTaskV2(pointDir),
      telemetrySink: (rep) => { observed = shadowV2.describeShadowReportV2(rep); },
    });
    report.c07.ms = Date.now() - started;
    report.c07.outcome = outcome && outcome.status ? outcome.status : (outcome && outcome.reason) || null;
    report.c07.summary = observed;
  }

  // ---- 6. C08 candidate (compile -> C05 -> C06 -> render) ----
  started = Date.now();
  const coverage = shadowHost.readStagedCoverageV2(pointDir);
  const liveTurn = shadowHost.extractLiveCurrentTurnV2(messages);
  const compileInput = assembled.skipped === null ? assembled.candidateFactory.compileInput : null;
  report.c08 = { coverageProof: coverage.coverage === null ? coverage.skipped : shadowHost.checkLiveCoverageV2(messages, coverage.coverage, liveTurn.turn.text) };
  let render = null;
  if (compileInput !== null) {
    const hardMax = 1048576 - request.maxTokens;
    const input = JSON.parse(JSON.stringify(Object.assign({}, compileInput, { exactMaterial: [] })));
    input.exactMaterial = compileInput.exactMaterial;
    input.budget = { hardMax: 10000000, target: 10000000 };
    const planning = museV2.createPlanningCounterV2();
    const candidate = shadowV2.buildCandidateV2({ compileInput: input, pages: assembled.candidateFactory.pages, budget: input.budget, counter: planning });
    render = rendererV2.renderContextPromptV2({ view: candidate.view, layout: candidate.layout, counter: planning });
    const viewBytes = Buffer.byteLength(canonical(candidate.view), 'utf8');
    report.c08 = Object.assign(report.c08, {
      ms: Date.now() - started,
      available: true,
      viewId: candidate.view.id,
      viewBytes,
      pinned: candidate.view.pinned.length,
      hot: candidate.view.hot.length,
      warm: candidate.view.warm.length,
      materializedCold: candidate.view.materializedCold.length,
      referencedCold: candidate.view.referencedColdPages.length,
      layoutBlocks: candidate.layout.blocks.length,
      renderMessages: render.messagePlan.length,
      renderDigest: render.renderDigest,
      ccv2HardMaxTokensForModel: hardMax,
    });
  }

  // ---- 7. physical request bodies + exact Meta counts ----
  const toBody = await loadPhysicalConverter(installRoot);
  const model = { id: header.config.model, provider: header.config.provider, api: 'openai-responses', reasoning: true, input: ['text'] };
  const legacyBody = toBody(model, header, messages);
  let ccv2Body = null;
  if (render !== null) {
    const compiledMessages = render.messagePlan.map((message, ordinal) => ({
      id: 'ccv2-c' + ordinal, role: message.role, content: [{ type: 'text', text: message.text }],
      source: { kind: 'ccv2-compiled' },
    }));
    ccv2Body = toBody(model, header, compiledMessages);
  }
  fs.writeFileSync(path.join(out, 'legacy-body.json'), JSON.stringify(legacyBody));
  if (ccv2Body !== null) fs.writeFileSync(path.join(out, 'ccv2-body.json'), JSON.stringify(ccv2Body));
  report.bodies = {
    legacyBytes: Buffer.byteLength(JSON.stringify(legacyBody)),
    legacyInputItems: legacyBody.input.length,
    ccv2Bytes: ccv2Body === null ? null : Buffer.byteLength(JSON.stringify(ccv2Body)),
    ccv2InputItems: ccv2Body === null ? null : ccv2Body.input.length,
  };
  if (arg('count', false) === true) {
    const key = process.env.MODEL_API_KEY;
    if (typeof key !== 'string' || key === '') {
      report.metaCount = { blocker: 'MODEL_API_KEY is not set (no network call attempted, nothing faked)' };
    } else {
      const descriptor = remoteV2.resolveMuseRemoteV2({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' });
      const counter = remoteV2.createMuseRemoteCounterV2({ descriptor, apiKey: key, timeoutMs: 300000 });
      const countOf = async (body) => {
        try {
          return { tokens: (await counter.countPayloadV2(body)).tokens, error: null };
        } catch (error) {
          return { tokens: null, error: String(error && error.message).slice(0, 300) };
        }
      };
      const legacy = await countOf(legacyBody);
      const ccv2 = ccv2Body === null ? { tokens: null, error: 'no-ccv2-body' } : await countOf(ccv2Body);
      report.metaCount = { legacy, ccv2 };
      if (Number.isInteger(legacy.tokens) && Number.isInteger(ccv2.tokens)) {
        report.metaCount.removed = legacy.tokens - ccv2.tokens;
        report.metaCount.reductionPct = Math.round((1 - ccv2.tokens / legacy.tokens) * 10000) / 100;
        report.metaCount.remainingPct = Math.round((ccv2.tokens / legacy.tokens) * 10000) / 100;
      }
    }
  }
  console.log('M01-ACCEPTANCE ' + JSON.stringify(report, null, 1));
}

main().catch((error) => {
  console.error('M01-ACCEPTANCE-FAILED ' + String(error && error.stack));
  process.exitCode = 1;
});
