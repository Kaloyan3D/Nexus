#!/usr/bin/env node
'use strict';
/**
 * CCv2-ActivationReplay.cjs - offline, read-only forensic replay of the RC1.1
 * context-pressure activation gate over a recorded DSH session log.
 *
 * For every root request (each step's assistant/message marks the request
 * that produced it) it rebuilds the request's surface messages from the
 * durable log, evaluates decideActivationV2 exactly as the production seam
 * does, and compares the gate's pressure bound with the
 * provider-reported prompt of that same request (the assistant/message usage
 * of the step). Output is content-free: counts, tokens, decisions, reasons.
 *
 * Usage:
 *   node scripts/CCv2-ActivationReplay.cjs --session-log <session.jsonl.zstd>
 *     [--runtime <nexus root>] [--policy pressure|always]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const gate = require('../config/ContextActivationPressureV2.cjs');
const wire = require('../config/ContextWireProjectorResponsesV2.cjs');

const SURFACE = Object.freeze(['user/message', 'assistant/message', 'tool/result']);

function messageOfSurfaceEvent(event) {
  return event.type === 'user/message' ? event.data : event.data.message;
}
function promptOf(usage) {
  const tokens = gate.sampleTokensOfV2(usage);
  return tokens === null ? null : tokens - usage.outputTokens;
}

/**
 * Pure replay over decoded events. route: the Responses wire route
 * capability; mode: resolveActivationModeV2 result.
 */
function replayActivationV2(events, route, mode) {
  const rows = [];
  const messages = [];
  const usageByStep = new Map();
  let replaced = false;
  for (const event of events) {
    if (event.type === 'assistant/message' && event.data && event.data.usage !== undefined) {
      usageByStep.set(event.data.turn + '/' + event.data.step, promptOf(event.data.usage));
    }
  }
  // The request of a step is sent after DSH has appended that step's
  // pre-request surface (skill instructions, runtime context, spliced
  // follow-ups land AFTER step/start). It is therefore evaluated at the
  // step's assistant/message, over every surface message before it.
  for (const event of events) {
    if (event.type === 'assistant/message' && event.data) {
      const decision = gate.decideActivationV2({ mode, route, events: events.slice(0, event.seq), messages: messages.slice() });
      const actualPrompt = usageByStep.has(event.data.turn + '/' + event.data.step) ? usageByStep.get(event.data.turn + '/' + event.data.step) : null;
      rows.push({
        turn: event.data.turn, step: event.data.step, decision: decision.decision, reason: decision.reason, detail: decision.detail,
        pressureTokens: decision.pressureTokens, latchTokens: decision.latchTokens, actualPrompt,
        boundHolds: actualPrompt === null || decision.pressureTokens === null ? null : decision.pressureTokens >= actualPrompt,
        surfaceReplaced: replaced,
      });
    }
    if (SURFACE.indexOf(event.type) !== -1) {
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') replaced = true;
      messages.push(messageOfSurfaceEvent(event));
    }
  }
  return rows;
}

function summarize(rows, thresholds) {
  const byTurn = {};
  for (const row of rows) {
    const t = byTurn[row.turn] || (byTurn[row.turn] = { requests: 0, native: 0, activate: 0, maxPressure: 0, maxActualPrompt: 0 });
    t.requests += 1;
    if (row.decision === 'NATIVE') t.native += 1; else t.activate += 1;
    if (Number.isInteger(row.pressureTokens)) t.maxPressure = Math.max(t.maxPressure, row.pressureTokens);
    if (Number.isInteger(row.actualPrompt)) t.maxActualPrompt = Math.max(t.maxActualPrompt, row.actualPrompt);
  }
  const measured = rows.filter((row) => row.boundHolds !== null);
  const reasons = {};
  for (const row of rows) reasons[row.reason + (row.detail ? '/' + row.detail : '')] = (reasons[row.reason + (row.detail ? '/' + row.detail : '')] || 0) + 1;
  const slack = measured.map((row) => row.pressureTokens - row.actualPrompt).sort((a, b) => a - b);
  return {
    activationTokens: thresholds.activationTokens,
    requests: rows.length,
    native: rows.filter((row) => row.decision === 'NATIVE').length,
    activate: rows.filter((row) => row.decision === 'ACTIVATE').length,
    firstActivation: rows.find((row) => row.decision === 'ACTIVATE') || null,
    reasons,
    boundChecked: measured.length,
    boundViolations: measured.filter((row) => row.boundHolds === false).map((row) => ({ turn: row.turn, step: row.step, pressureTokens: row.pressureTokens, actualPrompt: row.actualPrompt })),
    boundSlackTokens: slack.length === 0 ? null : { min: slack[0], p50: slack[Math.floor((slack.length - 1) / 2)], max: slack[slack.length - 1] },
    surfaceReplaced: rows.some((row) => row.surfaceReplaced),
    byTurn,
  };
}

async function decodeLogV2(logPath, runtimeRoot) {
  const sessionLib = path.join(runtimeRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
  const { decodeStorageRecord } = await import(pathToFileURL(sessionLib).href);
  const text = execFileSync('zstd', ['-dc', logPath], { maxBuffer: 2 * 1024 * 1024 * 1024 }).toString('utf8');
  const rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const events = rows.slice(rows.length > 0 && rows[0].type === 'session' && rows[0].seq === undefined ? 1 : 0).flatMap((row) => decodeStorageRecord(row));
  events.forEach((event, index) => { if (event.seq !== index) throw new Error('activation-replay-log-not-contiguous'); });
  return events;
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1];
  if (!args['--session-log']) throw new Error('activation-replay-session-log-required');
  const runtimeRoot = path.resolve(args['--runtime'] || path.join(os.homedir(), '.local', 'share', 'nexus'));
  const settings = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'config', 'settings.yaml'), 'utf8');
  const route = wire.readResponsesRouteFromSettingsV2(settings, 'opencode-go', 'muse-spark-1.3-contributor');
  const mode = gate.resolveActivationModeV2({ contextCompiler: { mode: 'active', activation: args['--policy'] || 'pressure' } });
  const events = await decodeLogV2(path.resolve(args['--session-log']), runtimeRoot);
  const rows = replayActivationV2(events, route, mode);
  console.log(JSON.stringify(summarize(rows, gate.deriveActivationThresholdsV2(route)), null, 1));
}

module.exports = { replayActivationV2, summarize, decodeLogV2 };
if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error && /^activation-replay-[a-z-]+$/.test(error.message) ? error.message : 'activation-replay-failed');
    process.exitCode = 1;
  });
}
