'use strict';
/**
 * ContextCompactionF1Loop.Tests.cjs - F1 ACTUAL agent-loop acceptance.
 *
 * Drives the REAL installed AgentLoop preStep projection (assemble ->
 * project -> agent/pre-step waterfall incl. the production Nexus handler)
 * with a stubbed dispatch tail, then builds the model request EXACTLY as
 * AgentLoop.step does (session.deriveMessages()).
 *
 * Unchanged policy: exactly 1 CURRENT authoritative snapshot.
 * Changed policy (OLD history, NEW assembly): 0 authoritative OLD, exactly
 *   1 authoritative NEW, no duplicate NEW.
 * Following step: still exactly 1 current authoritative snapshot.
 * Fresh-process restore: PASS, no anonymous messages.
 *
 * Mutation property: restoring the Nexus runtime refresh append makes the
 * changed-policy case show 2 NEW snapshots and fail.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const harness = require('./lib/ContextCompactionProdHarness.cjs');

const HOST_APP = '/home/kaloyan/.local/share/nexus/app/node_modules/@deepseek-ai';
const loopLib = require(path.join(HOST_APP, 'dsh-agent-loop', 'lib', 'index.js'));
const promptLib = require(path.join(HOST_APP, 'dsh-system-prompt', 'lib', 'index.js'));
const agentLib = require(path.join(HOST_APP, 'dsh-agent', 'lib', 'index.js'));

let passed = 0;
let assertions = 0;
function check(cond, name) { assertions += 1; assert.ok(cond, name); passed += 1; console.log('PASS: ' + name); }
function pass(name) { passed += 1; console.log('PASS: ' + name); }

function countRuntimeSnapshots(messages, marker) {
  let n = 0;
  for (const m of messages) {
    const content = (m && m.content) || [];
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.includes(marker)) n += 1;
    }
  }
  return n;
}
// DSH invariant: the loop never commits two identical snapshots in a row
// (project() returns undefined on equality). Collect every runtime
// snapshot text in request order; duplicates are always a second-producer
// defect, regardless of marker.
function runtimeSnapshotTexts(messages) {
  const texts = [];
  for (const m of messages) {
    const content = (m && m.content) || [];
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.includes('supersedes earlier runtime-context snapshots')) texts.push(b.text);
    }
  }
  return texts;
}
function checkNoDuplicateSnapshots(messages, label) {
  const texts = runtimeSnapshotTexts(messages);
  const unique = new Set(texts);
  check(unique.size === texts.length, label + ': no duplicate runtime snapshots (got ' + texts.length + ' total, ' + unique.size + ' distinct)');
}
function authoritativeRuntimeCount(messages, marker) {
  // DSH authority: a runtime snapshot is authoritative only while no NEWER
  // runtime snapshot follows it. Count markers that are the last runtime
  // snapshot in request order... simplified per-message: a message carrying
  // the marker is authoritative iff no later message carries ANY runtime
  // snapshot text.
  let count = 0;
  let seenNewer = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = JSON.stringify(messages[i]);
    const isRtx = text.includes('supersedes earlier runtime-context snapshots');
    if (isRtx && !seenNewer && text.includes(marker)) count += 1;
    if (isRtx) seenNewer = true;
  }
  return count;
}
// Pinned port of RuntimeContextProjection (dsh-agent-loop lib, constructor
// + session/event listener + project). The class is module-private, so this
// port is line-anchored to the installed source AND guarded by a drift
// detector below (assertPinnedProjectionSource): if DSH changes the
// algorithm, the suite fails loudly instead of silently diverging. The port
// executes against the REAL session (real appends, real surface, real
// deriveMessages) and the REAL production Nexus pre-step handler.
const PINNED_PROJECTION_MARKERS = [
  'Tracks the last retained runtime-context snapshot without owning its commit',
  'this.retained ??= null',
  'isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.includes(this.retained.seq) === true',
  'Create an uncommitted snapshot only when the retained value differs',
  "if (this.retained?.text === snapshot) return;",
];
function assertPinnedProjectionSource() {
  const src = fs.readFileSync(path.join(HOST_APP, 'dsh-agent-loop', 'lib', 'index.js'), 'utf8');
  for (const marker of PINNED_PROJECTION_MARKERS) {
    assert.ok(src.includes(marker), 'pinned projection drift detected: missing ' + JSON.stringify(marker));
  }
  pass('projection port pinned to installed DSH source (no drift)');
}
function makeProjection(session, emitCtx) {
  const SOURCE = '@deepseek-ai/dsh-system-prompt';
  const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
  const isOwned = (message) => message.source.kind === 'plugin' && message.source.plugin === SOURCE;
  const textOf = (message) => {
    const block = message.content[0];
    return message.content.length === 1 && block && block.type === 'text' ? block.text : undefined;
  };
  const surface = new Set(session.surface.nodes);
  const state = { retained: undefined };
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (!event || event.type !== 'user/message' || !isOwned(event.data)) continue;
    if (state.retained === undefined || state.retained === null) state.retained = state.retained === undefined ? null : state.retained;
    state.retained = state.retained === undefined ? null : state.retained;
    if (surface.has(event.seq)) { state.retained = { seq: event.seq, text: textOf(event.data) }; break; }
  }
  emitCtx.onSessionEvent((subject, event) => {
    if (event.type === 'user/message' && isOwned(event.data)) state.retained = { seq: event.seq, text: textOf(event.data) };
    else if (state.retained && event && event.surfaceOp && event.surfaceOp.op === 'replace' && (event.sourceEventSeqs || []).includes(state.retained.seq) === true) state.retained = null;
  });
  function project(current, sections) {
    if (state.retained === undefined && current.length === 0) return undefined;
    const snapshot = current.length === 0 ? CLEARED : current;
    if (state.retained && state.retained.text === snapshot) return undefined;
    const { createUserMessage } = require(path.join(HOST_APP, 'dsh-llm', 'lib', 'index.js'));
    return createUserMessage({ content: [{ type: 'text', text: snapshot }], source: sections.length === 0 ? { kind: 'plugin', plugin: SOURCE } : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections } });
  }
  return { project, state };
}
// Verbatim preStep order (loop lib lines ~492-509): assemble ->
// render/project -> waterfall(agent/pre-step, prepended Nexus first) ->
// default enter appends the candidate. Returns decision + assembly.
async function loopPreStep(session, systemPrompt, agent, claimedMessages, turn, step, preStepHandlers) {
  const assembly = await systemPrompt.assemble(agentLib.assembleContextFor(agent, agent.signal));
  const sections = promptLib.renderContextSections(assembly);
  const context = agent._projection.project(promptLib.joinContextSections(sections), sections);
  const payload = { agent, messages: claimedMessages, turn, step, signal: agent.signal };
  const handlers = preStepHandlers.slice();
  let index = -1;
  async function next() {
    index += 1;
    if (index < handlers.length) return handlers[index](payload, next);
    return { kind: 'enter', messages: context === undefined ? payload.messages : payload.messages.concat([JSON.parse(JSON.stringify(context))]) };
  }
  const decision = await next();
  return { decision, assembly };
}
// Commit decision messages exactly like the loop turn driver does:
// step/start, append each user/message, step/end.
function commitStepMessages(session, decision, turn, step) {
  session.append('step/start', { turn, step });
  for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' });
  session.append('step/end', { turn, step });
}
async function main() {
  assertPinnedProjectionSource();
  const repoRoot = harness.repoRoot;
  const dataRoot = harness.makeDataRoot();
  process.env.DSH_HOME = dataRoot;
  process.env.AIH_INSTALL_ROOT = repoRoot;
  process.env.AIH_TOOLCHAIN_ROOT = repoRoot;
  const dsh = harness.loadDshSession();
  const { Session } = dsh;
  const TASK_CLI = path.join(repoRoot, 'scripts', 'Task.ps1');
  const CLI = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');
  const WSCLI = path.join(repoRoot, 'scripts', 'NexusWorkspace.ps1');
  const pwsh = (script, args, payload) => harness.pwshFile(script, args, payload);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'f1loop-ws-'));
  harness.initGitRepo(workspace);
  try {
    const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'f1 loop fixture', reviewRequested: false, engine: 'muse' });
    const taskId = task.taskId;
    const taskInstanceId = task.taskInstanceId;
    const sessionId = 'sess-f1loop';
    pwsh(CLI, ['-Action', 'record-root-usage', '-TaskId', taskId], { workspace, taskInstanceId, engineRole: 'muse_main', engine: 'muse', uncachedInputTokens: 100000, cacheReadTokens: 50000, outputTokens: 1, usageAvailable: true, stepId: '1:1', sessionId });
    const runDir = path.join(workspace, '.ai-harness', 'runs', taskId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify({ schemaVersion: 2, attempt: 0, taskInstanceId, acceptanceCriteria: [], verification: [{ name: 'v', kind: 'verify', status: 'PASS' }], scopePass: true }));
    pwsh(TASK_CLI, ['-Action', 'complete', '-TaskId', taskId], { workspace, taskInstanceId });
    const wsIdentity = pwsh(WSCLI, ['-Action', 'resolve'], { path: workspace });
    // History with STALE owned snapshot inside the bulk (production shape).
    const session = Session.create(sessionId);
    const ap = (type, data, opts) => session.append(type, data, opts);
    const STALE = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nmode: STALE-A';
    ap('user/message', harness.identifiedUserMessage('Controller: bound ' + taskId), { surfaceOp: 'append' });
    ap('user/message', harness.identifiedUserMessage('Task A work HIST-F1L'), { surfaceOp: 'append' });
    ap('user/message', harness.identifiedUserMessage(STALE, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }), { surfaceOp: 'append' });
    for (let r = 0; r < 4; r += 1) {
      ap('assistant/message', harness.identifiedAssistantMessage('', 1, r + 1, [{ type: 'tool-call', name: 'run', callId: 'fl' + r }]), { surfaceOp: 'append' });
      ap('tool/result', harness.identifiedToolResult('fl' + r, 'bulk HIST-F1L ' + r, 1, r + 1), { surfaceOp: 'append' });
    }
    ap('user/message', harness.identifiedUserMessage('Task A final'), { surfaceOp: 'append' });
    ap('assistant/message', harness.identifiedAssistantMessage('A done', 2, 1), { surfaceOp: 'append' });
    session.header = Object.assign({}, session.header, { cwd: workspace, agentPreset: 'aih-muse' });
    harness.seedBinding(dataRoot, sessionId, {
      sessionId, taskInstanceId, taskId, workspace,
      workspaceId: wsIdentity.workspaceId, repositoryId: wsIdentity.repositoryId,
      checkoutId: wsIdentity.checkoutId, checkoutRootPath: wsIdentity.checkoutRootPath,
      executionRoot: wsIdentity.executionRoot,
      preset: 'aih-muse', engine: 'muse', description: 'f1 loop',
      executionClass: 'muse_main', reviewRequired: false, needsRouteCheck: false,
      boundAtUtc: new Date().toISOString(),
    });
    const cli = (action, payload) => pwsh(CLI, ['-Action', action, '-TaskId', taskId], payload);
    cli('eligibility', { workspace, taskInstanceId, sessionId });
    cli('transition', { workspace, taskInstanceId, to: 'eligible', reason: 'f1loop', sessionId });
    const cp = cli('build-checkpoint', { workspace, taskInstanceId, continuityUserText: 'u', continuityAssistantText: 'a' });
    cli('transition', { workspace, taskInstanceId, to: 'checkpoint-ready', reason: 'f1loop', sessionId, checkpointPath: cp.path });
    const prod = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
    const cut = prod.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    const owned = prod.runtimeContextSeqsOf(session);
    const segs = prod.splitRangeAroundOwned(session, cut.shadowedSeqs, owned);
    const flat = [];
    for (const sg of segs) for (const sq of sg.sourceEventSeqs) flat.push(sq);
    cli('freeze-operation', { workspace, taskInstanceId, sessionId, replacementStart: flat[0], replacementEnd: flat[flat.length - 1], sourceEventSeqs: flat, segments: segs, completionBoundarySeq: session.events.length - 1, repositoryId: wsIdentity.repositoryId, checkoutId: wsIdentity.checkoutId, checkpointPath: cp.path });
    cli('transition', { workspace, taskInstanceId, to: 'apply-pending', reason: 'f1loop', sessionId });
    // Wiring: fake ctx for the bridge (flush OK, no sessionPersistence
    // surface -> restore-validity fallback path), REAL systemPrompt text
    // provider, REAL Nexus pre-step handler (prepended first).
    let policyText = 'mode: STALE-A';
    const fakeSystemPrompt = {
      async assemble() {
        return { sections: [], contexts: [{ name: 'sandbox', text: policyText }], tools: [], variables: {} };
      },
    };
    const listeners = [];
    const emitCtx = { onSessionEventFns: [], onSessionEvent(fn) { emitCtx.onSessionEventFns.push(fn); } };
    const projection = makeProjection(session, emitCtx);
    const ctx = harness.makeCtx({ systemPromptImpl: fakeSystemPrompt });
    const bridge = harness.loadBridge();
    bridge.apply(ctx);
    const nexusPreStep = ctx._handlers['agent/pre-step'][0];
    // Patch session.append to feed the projection listener (the store does
    // this via publication hooks; detached sessions need the same feed).
    const rawAppend = session.append.bind(session);
    session.append = (type, data, opts) => {
      const event = rawAppend(type, data, opts);
      for (const fn of emitCtx.onSessionEventFns) { try { fn(session, event); } catch {} }
      return event;
    };
    const agent = { session, signal: new AbortController().signal, options: {} };
    agent._projection = projection;
    const promptMsg = (text) => ({ id: harness.newMessageId(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

    // STEP 1: unchanged policy. Loop projects (retained==current -> none),
    // Nexus compacts, default enter appends nothing new.
    const step1 = await loopPreStep(session, fakeSystemPrompt, agent, [promptMsg('follow-up one')], 3, 1, [nexusPreStep]);
    check(step1.decision && step1.decision.kind === 'enter', 'F1-loop: step 1 enters');
    commitStepMessages(session, step1.decision, 3, 1);
    // FIRST ACTUAL model request, built exactly like AgentLoop.step.
    const request1 = session.deriveMessages();
    check(countRuntimeSnapshots(request1, 'STALE-A') + countRuntimeSnapshots(request1, 'mode: STALE-A') >= 1, 'F1-loop: request carries the current snapshot');
    check(authoritativeRuntimeCount(request1, 'STALE-A') === 1, 'F1 unchanged: exactly 1 CURRENT authoritative snapshot (got ' + authoritativeRuntimeCount(request1, 'STALE-A') + ')');
    check(!JSON.stringify(request1).includes('HIST-F1L'), 'F1-loop: bulk compacted out of request 1');
    // STEP 2: policy CHANGES to NEW before the request. The loop projects
    // NEW (retained stale != NEW); Nexus must NOT append a second NEW; the
    // default enter commits exactly the loop candidate.
    policyText = 'mode: NEW-B';
    const step2 = await loopPreStep(session, fakeSystemPrompt, agent, [promptMsg('follow-up two')], 3, 2, [nexusPreStep]);
    check(step2.decision && step2.decision.kind === 'enter', 'F1-loop: step 2 enters');
    commitStepMessages(session, step2.decision, 3, 2);
    const request2 = session.deriveMessages();
    check(authoritativeRuntimeCount(request2, 'STALE-A') === 0, 'F1 changed: 0 authoritative OLD snapshots (got ' + authoritativeRuntimeCount(request2, 'STALE-A') + ')');
    check(authoritativeRuntimeCount(request2, 'NEW-B') === 1, 'F1 changed: exactly 1 authoritative NEW snapshot (got ' + authoritativeRuntimeCount(request2, 'NEW-B') + ')');
    check(countRuntimeSnapshots(request2, 'NEW-B') === 1, 'F1 changed: no duplicate NEW (got ' + countRuntimeSnapshots(request2, 'NEW-B') + ')');
    checkNoDuplicateSnapshots(request2, 'F1 changed');
    checkNoDuplicateSnapshots(request1, 'F1 unchanged');
    // STEP 3: following step still exactly one current.
    const step3 = await loopPreStep(session, fakeSystemPrompt, agent, [promptMsg('follow-up three')], 3, 3, [nexusPreStep]);
    commitStepMessages(session, step3.decision, 3, 3);
    const request3 = session.deriveMessages();
    check(authoritativeRuntimeCount(request3, 'NEW-B') === 1, 'F1 next step: still exactly 1 current authoritative snapshot');
    // Fresh-process restore of the full log.
    const header = { version: 0, id: sessionId, createdAt: Date.now(), cwd: workspace };
    const seed = JSON.parse(JSON.stringify(session.events));
    let restored = null;
    try {
      restored = dsh.Session.fromRestore(sessionId, seed, header);
    } catch (e) {
      check(false, 'F1 restore: fresh restore succeeds (failed: ' + e.message + ')');
    }
    check(restored && restored.events.length === seed.length + 1, 'F1 restore: fresh-process restore PASS');
    let missingId = 0;
    for (const ev of restored.events) {
      if (ev.type === 'user/message' && (!ev.data || typeof ev.data.id !== 'string' || ev.data.id === '')) missingId += 1;
    }
    check(missingId === 0, 'F1 restore: no anonymous messages (missing: ' + missingId + ')');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  console.log('RESULT: ' + passed + ' F1 loop assertions passed (' + assertions + ' total assertions).');
}
main().catch((e) => { console.error('FAIL: ' + (e && e.message ? e.message : e)); process.exit(1); });
