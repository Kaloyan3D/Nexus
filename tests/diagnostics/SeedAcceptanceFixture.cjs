'use strict'
// SeedAcceptanceFixture.cjs — authoritative Controller records for ONE UI session, written
// through the real Nexus modules (routing-state naming from status.cjs, gate creation from
// gate.cjs) into a DISPOSABLE install's data directory. The browser acceptance run then
// compares what the UI displays against exactly these records.
//
//   node tests/diagnostics/SeedAcceptanceFixture.cjs <dataRoot> <workspace> <sessionId> [taskId]
//
// Never point this at a real user install: it writes session bindings, routing state,
// a task ledger entry, attempts, evidence and an open operator gate.
const fs = require('node:fs')
const path = require('node:path')
const status = require('../../ui/nexus-controller/lib/status.cjs')
const gate = require('../../ui/nexus-controller/lib/gate.cjs')

const [dataRoot, workspace, sessionId, taskIdArg] = process.argv.slice(2)
if (!dataRoot || !workspace || !sessionId) { console.error('usage: SeedAcceptanceFixture.cjs <dataRoot> <workspace> <sessionId> [taskId]'); process.exit(2) }
if (!path.resolve(dataRoot).includes('nx-')) { console.error('refusing: dataRoot does not look like a disposable test install'); process.exit(2) }
const taskId = taskIdArg || 'TASK-0042'
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const now = new Date().toISOString()

const bindingsFile = path.join(dataRoot, 'routing', 'session-bindings.json')
let bindings = { schemaVersion: 1, bindings: {} }
try { bindings = JSON.parse(fs.readFileSync(bindingsFile, 'utf8')) } catch { /* fresh */ }
const binding = {
  sessionId, taskId, workspace, preset: 'aih-engineering', description: 'Acceptance: fix BLE reconnect issue',
  executionClass: 'deepseek_normal', reviewRequired: true, needsRouteCheck: false, boundAtUtc: now,
}
bindings.bindings[sessionId] = binding
write(bindingsFile, JSON.stringify(bindings))

const stateFile = status.routingStateFileName(workspace, 'aih-engineering', taskId)
write(path.join(dataRoot, 'routing', 'states', stateFile), JSON.stringify({
  taskId, workspace, preset: 'aih-engineering', executionClass: 'deepseek_normal', selectedTier: 3, risk: 'normal',
  reviewRequired: true, reviewRequested: true, lastFailureSignature: '', sameFailureCount: 0, updatedAtUtc: now,
}))
fs.appendFileSync(path.join(dataRoot, 'routing', 'decisions.jsonl'), JSON.stringify({
  recordVersion: 3, timestampUtc: now, taskId, workspace, preset: 'aih-engineering', selectedExecutionClass: 'deepseek_normal',
  executionClass: 'deepseek_normal', provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoning: 'max', risk: 'normal',
  reviewRequired: true, matchedRule: 'default-deepseek',
}) + '\n')
const harness = path.join(workspace, '.ai-harness')
write(path.join(harness, 'state', 'tasks.json'), JSON.stringify({
  schemaVersion: 1, nextSequence: 43, tasks: [{
    schemaVersion: 1, taskId, description: binding.description, status: 'verifying', executionClass: 'deepseek_normal', executor: 'deepseek_normal',
    attempt: 2, maxAttempts: 3, risk: 'normal',
    verification: { required: ['typecheck', 'tests'], outcomes: [
      { name: 'typecheck', status: 'PASS', evidence: 'tsc --noEmit' },
      { name: 'tests', status: 'FAIL', evidence: 'npm test: 1 failing' },
    ] },
    reviewRequested: true, executionClassOverride: 'deepseek_normal', worktree: null, failureSignatures: ['tests-failing'], codexCalls: 0,
    completionAuthority: 'controller', createdAtUtc: now, updatedAtUtc: now, completedAtUtc: null,
  }],
}))
write(path.join(harness, 'state', 'decisions.jsonl'), '')
const runs = path.join(harness, 'runs', taskId)
write(path.join(runs, 'manifest.json'), '{}')
write(path.join(runs, 'attempts.jsonl'), [
  { sequence: 1, status: 'failed', attemptId: 'attempt-1', executionClass: 'deepseek_normal', startedAtUtc: now },
  { sequence: 2, status: 'started', attemptId: 'attempt-2', executionClass: 'deepseek_normal', startedAtUtc: now },
].map((r) => JSON.stringify(r)).join('\n') + '\n')
write(path.join(workspace, 'acceptance-note.txt'), 'file for the Files tab\n')
const created = gate.ensureGate(dataRoot, binding, 'review-required', { attempt: 2, reviewVerdict: 'fail' })
console.log(JSON.stringify({ seeded: true, sessionId, taskId, workspace, stateFile, gateId: created && created.gateId }))
