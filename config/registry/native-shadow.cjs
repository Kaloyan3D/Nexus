'use strict';

/**
 * A1.2 Controller shadow integration — opt-in, shadow-only, diagnostics-only.
 *
 * Default behavior: OFF. The flag is env-only: NEXUS_NATIVE_SHADOW=1.
 * With the flag disabled this module performs NO work and produces NO
 * observable legacy behavior change (no reads beyond the flag check, no
 * writes, no subprocesses).
 *
 * With the flag enabled, for a REAL committed Controller attempt:
 *   1. resolve the Controller-owned shadow intent (never creates attempts),
 *   2. resolve the real Registry binding for engineering-v2 / muse_main,
 *   3. submit one immutable shadow command to the Rust kernel,
 *   4. record acceptance/refusal diagnostics next to the task ledger.
 *
 * The real Controller keeps using the existing production execution path.
 * This subsystem never changes routing, attempt creation, verification or
 * completion authority, never intercepts real inference, and never dispatches
 * anything: kernel acceptance stays accepted-reserved-dispatch-disabled.
 * An unavailable Rust kernel cannot corrupt production Controller state or
 * produce duplicate attempts: failures are structured shadow diagnostics,
 * recoverable via reconcileTask.
 *
 * Non-atomicity is explicit: the Controller JSONL ledger and the SQLite
 * shadow store share NO transaction. Restart-safe reconciliation discovers
 * already-committed attempts and fills missing shadow records without
 * creating new attempts. Shadow receipts NEVER imply Controller completion.
 */

const fs = require('node:fs');
const path = require('node:path');
const shadowIntent = require('./native-shadow-intent.cjs');
const issuer = require('./native-issuer.cjs');
const bridge = require('./native-shadow-bridge.cjs');

const SHADOW_FLAG = 'NEXUS_NATIVE_SHADOW';
const SHADOW_SCHEMA_VERSION = 1;
const SHADOW_MODE_ID = 'engineering-v2';
const SHADOW_ROLE = 'muse_main';
const MAX_ATTEMPTS_PER_RECONCILE = 64;
const MAX_OUTBOX_LINES = 10000;

function isShadowEnabled(env) {
  try {
    const e = env || process.env || {};
    return e[SHADOW_FLAG] === '1';
  } catch {
    return false;
  }
}

function nowUtc(clock) {
  try {
    if (clock && typeof clock.nowUtc === 'function') return clock.nowUtc();
  } catch { /* fall through */ }
  return new Date().toISOString();
}

function outboxPath(workspace, taskId) {
  return path.join(String(workspace), '.ai-harness', 'runs', String(taskId), 'shadow-outbox.jsonl');
}

function diagnosticsPath(workspace, taskId) {
  return path.join(String(workspace), '.ai-harness', 'runs', String(taskId), 'shadow-diagnostics.jsonl');
}

function appendJsonLine(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * H-03 pin integrity. The outbox is append-only JSONL that the adapter
 * itself wrote — but a truncated write, a corrupt line, or a tampered
 * duplicate pin must NEVER lead to a silent re-pin under a different
 * identity. readOutbox therefore reports corruption explicitly instead of
 * skipping it, and resolvePin fails closed on malformed or ambiguous
 * history (outcome 'uncertain', code 'reconciliation-required').
 */
function readOutbox(workspace, taskId, limit) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : MAX_OUTBOX_LINES;
  let raw;
  try {
    raw = fs.readFileSync(outboxPath(workspace, taskId), 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { records: [], corruptLines: 0, truncated: false };
    throw e;
  }
  const records = [];
  let corruptLines = 0;
  let truncated = false;
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (records.length >= cap) { truncated = true; break; }
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      corruptLines += 1;
    }
  }
  return { records: records, corruptLines: corruptLines, truncated: truncated };
}

const PIN_DIGEST_RE = /^[0-9a-f]{64}$/;
const PIN_STRING_FIELDS = ['commandId', 'taskInstanceId', 'attemptId', 'modeId', 'role', 'resolutionIdCompat'];
const PIN_DIGEST_FIELDS = ['issuanceId', 'targetDigest', 'snapshotDigest', 'modeConfigDigest'];

function isValidPin(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.kind !== 'shadow-pin') return false;
  for (const f of PIN_STRING_FIELDS) {
    if (typeof r[f] !== 'string' || r[f] === '') return false;
  }
  for (const f of PIN_DIGEST_FIELDS) {
    if (typeof r[f] !== 'string' || !PIN_DIGEST_RE.test(r[f])) return false;
  }
  return true;
}

function pinIdentityKey(p) {
  return [p.issuanceId, p.targetDigest, p.snapshotDigest, p.modeConfigDigest, String(p.modeConfigRevision)].join('|');
}

/**
 * Resolve the pin for one commandId. States: 'none' (no history),
 * 'pinned' (exactly one identity), 'unreliable' (truncated file, corrupt
 * lines, or a malformed pin anywhere in history), 'ambiguous' (two or more
 * VALID pins with different identities — never resolved by recency).
 */
function resolvePin(outbox, commandId) {
  const box = outbox || { records: [], corruptLines: 0, truncated: false };
  if (box.truncated) {
    return { state: 'unreliable', pin: null, detail: 'shadow outbox exceeds the bounded scan; history is incomplete and no pin is trusted' };
  }
  if (box.corruptLines > 0) {
    return { state: 'unreliable', pin: null, detail: 'shadow outbox holds ' + box.corruptLines + ' corrupt line(s); a conflicting pin may be hidden in the unreadable region' };
  }
  for (const r of box.records) {
    if (r && r.kind === 'shadow-pin' && !isValidPin(r)) {
      return { state: 'unreliable', pin: null, detail: 'shadow outbox holds a malformed pin record; history is not trusted' };
    }
  }
  const pins = box.records.filter(function (r) { return r && r.commandId === commandId && r.kind === 'shadow-pin'; });
  if (pins.length === 0) return { state: 'none', pin: null, detail: null };
  const identities = new Map();
  for (const p of pins) identities.set(pinIdentityKey(p), p);
  if (identities.size > 1) {
    return { state: 'ambiguous', pin: null, detail: 'conflicting duplicate pins exist for ' + commandId + '; recency does not decide identity' };
  }
  return { state: 'pinned', pin: pins[pins.length - 1], detail: null };
}

function writeDiagnostic(deps, workspace, taskId, record) {
  const clock = (deps && deps.clock) || null;
  const entry = Object.assign({ schemaVersion: SHADOW_SCHEMA_VERSION, atUtc: nowUtc(clock), taskId: taskId }, record);
  try {
    appendJsonLine(diagnosticsPath(workspace, taskId), entry);
  } catch { /* diagnostics must never fail delivery */ }
  return entry;
}

function refused(deps, workspace, taskId, commandId, code, message) {
  return writeDiagnostic(deps, workspace, taskId, { outcome: 'refused', commandId: commandId || null, code: code, message: message });
}

/**
 * Deliver (or recover) ONE shadow command. All inputs are derived from the
 * committed Controller record + trusted Registry issuance by the caller.
 * Returns a diagnostic entry. Never throws, never mutates Controller state.
 */
async function deliverShadowCommand(shadow, issuance, kernelIntent, opts, deps) {
  const o = opts || {};
  const d = deps || {};
  const workspace = o.workspace;
  const taskId = o.taskId;
  const commandId = shadow.commandId;
  const invoke = d.invokeBridge || bridge.invokeBridge;
  const dbPath = typeof o.dbPath === 'string' ? o.dbPath : (typeof d.dbPath === 'string' ? d.dbPath : '');
  const witnessPath = typeof o.witnessPath === 'string' ? o.witnessPath : (typeof d.witnessPath === 'string' ? d.witnessPath : '');
  const runOpts = { kernelBin: o.kernelBin || d.kernelBin, repoRoot: o.repoRoot || d.repoRoot, dbPath: dbPath, witnessPath: witnessPath, timeoutMs: o.timeoutMs || d.timeoutMs };
  return bridge.withCommandLock(commandId, async function () {
    // Lost-ACK fast path: a durable receipt already exists for this
    // commandId. Reuse it after verifying it carries OUR issuance identity;
    // a mismatch is surfaced as an explicit conflict, never guessed success.
    const prior = invoke('receipt', { commandId: commandId }, runOpts);
    if (prior.ok && prior.status === 'ok' && prior.response && prior.response.receipt) {
      const r = prior.response.receipt;
      if (r.issuanceId === issuance.issuanceId && r.targetDigest === issuance.targetDigest && r.snapshotDigest === issuance.snapshotDigest) {
        appendPin(deps, workspace, taskId, shadow, issuance);
        return writeDiagnostic(d, workspace, taskId, { outcome: 'replayed', commandId: commandId, issuanceId: r.issuanceId, status: r.status, note: 'durable receipt already existed; acknowledgment recovered by commandId read' });
      }
      return refused(d, workspace, taskId, commandId, 'command-conflict', 'existing receipt for ' + commandId + ' carries different identity; prior authority is preserved and no new receipt is written');
    }
    if (!prior.ok) {
      // Transport failure reading prior state: surface explicitly and never
      // guess success. With no prior pin this attempt was never delivered
      // (error); with a pin a receipt may already exist unseen (uncertain).
      if (o.priorPin) {
        return writeDiagnostic(d, workspace, taskId, { outcome: 'uncertain', commandId: commandId, code: prior.code, message: 'prior receipt state is unreadable (' + prior.code + ') but a shadow pin exists; outcome unknown, reconciliation required — success is never assumed' });
      }
      return writeDiagnostic(d, workspace, taskId, { outcome: 'error', commandId: commandId, code: prior.code, message: 'kernel unavailable before any delivery (' + prior.code + '); Controller state is untouched and no attempt was created' });
    }
    const acquired = invoke('acquire', { taskInstanceId: shadow.taskInstanceId, backend: bridge.KERNEL_BACKEND }, runOpts);
    if (!acquired.ok) {
      return writeDiagnostic(d, workspace, taskId, { outcome: 'error', commandId: commandId, code: acquired.code, message: 'kernel unavailable during acquire (' + acquired.code + '); Controller state is untouched and no attempt was created' });
    }
    if (acquired.status !== 'ok') {
      return refused(d, workspace, taskId, commandId, acquired.code || 'lease-refused', acquired.message || 'generation lease refused');
    }
    const lease = acquired.response && acquired.response.lease;
    if (!lease || typeof lease.leaseEpoch !== 'number' || typeof lease.storeIncarnation !== 'string') {
      return refused(d, workspace, taskId, commandId, 'bad-response', 'generation lease is malformed; refusing to submit');
    }
    const sealed = invoke('seal', { resolution: issuance.resolution }, runOpts);
    if (!sealed.ok) {
      return writeDiagnostic(d, workspace, taskId, { outcome: 'error', commandId: commandId, code: sealed.code, message: 'kernel unavailable during seal (' + sealed.code + '); Controller state is untouched' });
    }
    if (sealed.status !== 'ok') {
      return refused(d, workspace, taskId, commandId, sealed.code || 'seal-refused', sealed.message || 'issuance seal refused');
    }
    const accepted = invoke('accept', { intent: kernelIntent, resolution: issuance.resolution, snapshot: issuance.snapshot, lease: { epoch: lease.leaseEpoch, storeIncarnation: lease.storeIncarnation } }, runOpts);
    if (!accepted.ok) {
      return writeDiagnostic(d, workspace, taskId, { outcome: 'error', commandId: commandId, code: accepted.code, message: 'kernel unavailable during accept (' + accepted.code + '); Controller state is untouched, reconciliation required' });
    }
    if (accepted.status === 'ok') {
      appendPin(deps, workspace, taskId, shadow, issuance, lease);
      const receipt = accepted.response.receipt;
      return writeDiagnostic(d, workspace, taskId, { outcome: accepted.response.replayed === true ? 'replayed' : 'delivered', commandId: commandId, issuanceId: issuance.issuanceId, leaseEpoch: lease.leaseEpoch, status: receipt && receipt.status, commandDigest: receipt && receipt.commandDigest });
    }
    if ((accepted.code || '') === 'command-conflict') {
      // Same commandId, changed identity: the prior authority wins. Read it
      // back so the outcome is explicit instead of a bare refusal.
      const reread = invoke('receipt', { commandId: commandId }, runOpts);
      const receipt = reread.ok && reread.status === 'ok' ? reread.response.receipt : null;
      return refused(d, workspace, taskId, commandId, 'command-conflict', 'shadow identity changed for an existing committed command; prior receipt ' + (receipt ? 'reused (' + receipt.commandDigest + ')' : 'unreadable — reconciliation required'));
    }
    if ((accepted.code || '') === 'stale-lease') {
      return refused(d, workspace, taskId, commandId, 'stale-lease', 'lease is stale; no transparent generation replacement is performed for an existing committed command');
    }
    return refused(d, workspace, taskId, commandId, accepted.code || 'accept-refused', accepted.message || 'shadow command refused');
  });
}

function appendPin(deps, workspace, taskId, shadow, issuance, lease) {
  try {
    appendJsonLine(outboxPath(workspace, taskId), {
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'shadow-pin',
      atUtc: nowUtc(deps && deps.clock),
      commandId: shadow.commandId,
      taskInstanceId: shadow.taskInstanceId,
      attemptId: shadow.attemptId,
      modeId: issuance.modeId,
      role: issuance.role,
      issuanceId: issuance.issuanceId,
      targetDigest: issuance.targetDigest,
      snapshotDigest: issuance.snapshotDigest,
      modeConfigDigest: issuance.modeConfigDigest,
      modeConfigRevision: issuance.modeConfigRevision,
      resolutionIdCompat: issuance.resolutionIdCompat,
      leaseEpoch: lease && typeof lease.leaseEpoch === 'number' ? lease.leaseEpoch : null,
    });
  } catch { /* the pin is an optimization; delivery already succeeded */ }
}

/**
 * Observe ONE committed Controller attempt in shadow (opt-in flag required).
 * options: { workspace, taskId, taskInstanceId?, attemptId?, installRoot,
 *   dataRoot, repoRoot?, dbPath?, witnessPath?, kernelBin?, timeoutMs? }
 */
async function observeCommittedAttempt(options, deps) {
  const o = options || {};
  const d = deps || {};
  const workspace = o.workspace;
  const taskId = o.taskId;
  if (!isShadowEnabled(o.env !== undefined ? o.env : d.env)) {
    return { outcome: 'skipped-disabled', commandId: null, code: 'shadow-disabled', message: 'native shadow is OFF (default); no shadow work performed and legacy behavior is unchanged' };
  }
  if (typeof workspace !== 'string' || workspace === '' || typeof taskId !== 'string' || taskId === '') {
    return { outcome: 'refused', commandId: null, code: 'shadow-intent-invalid', message: 'workspace and taskId are required' };
  }
  const resolved = shadowIntent.resolveShadowIntent({ workspace: workspace, taskId: taskId, taskInstanceId: o.taskInstanceId, attemptId: o.attemptId }, { reader: d.reader });
  if (!resolved.ok) {
    return refused(d, workspace, taskId, null, resolved.code, resolved.message);
  }
  const shadow = resolved.intent;
  if (String(shadow.executionClass || '').toLowerCase() !== SHADOW_ROLE) {
    return writeDiagnostic(d, workspace, taskId, { outcome: 'skipped-unsupported', commandId: shadow.commandId, code: 'controller-scope-unsupported', message: 'attempt executionClass ' + String(shadow.executionClass) + ' is outside the A1.2 shadow scope (muse_main only); explicitly skipped, never mapped' });
  }
  const issued = issuer.issueTrustedResolution({ installRoot: o.installRoot, dataRoot: o.dataRoot, modeId: SHADOW_MODE_ID, role: SHADOW_ROLE, taskInstanceId: shadow.taskInstanceId }, { service: d.service });
  if (!issued.ok) {
    return refused(d, workspace, taskId, shadow.commandId, issued.code, issued.message);
  }
  const issuance = issued.issuance;
  // Registry pin stability: a configuration change after the pin is an
  // explicit refusal, never a silent re-pin. (Preserving an independently
  // verified immutable pin is A1.3 work.)
  let records = [];
  try {
    records = readOutbox(workspace, taskId);
  } catch (e) {
    return writeDiagnostic(d, workspace, taskId, { outcome: 'uncertain', commandId: shadow.commandId, code: 'shadow-outbox-unreadable', message: 'shadow outbox is unreadable; outcome unknown, reconciliation required' });
  }
  const pinRes = resolvePin(records, shadow.commandId);
  if (pinRes.state === 'unreliable' || pinRes.state === 'ambiguous') {
    // H-03: malformed or ambiguous pin history never resolves to a delivery
    // and never silently re-pins. Recovery requires operator inspection of
    // the outbox (no automatic repair exists in A1.2).
    return writeDiagnostic(d, workspace, taskId, { outcome: 'uncertain', commandId: shadow.commandId, code: 'reconciliation-required', message: 'shadow pin history is ' + pinRes.state + ' (' + pinRes.detail + '); refusing to deliver or re-pin until an operator inspects the outbox' });
  }
  const pin = pinRes.state === 'pinned' ? pinRes.pin : null;
  if (pin && (pin.issuanceId !== issuance.issuanceId || pin.targetDigest !== issuance.targetDigest || pin.snapshotDigest !== issuance.snapshotDigest || pin.modeConfigDigest !== issuance.modeConfigDigest)) {
    return refused(d, workspace, taskId, shadow.commandId, 'registry-changed-after-pin', 'Registry configuration changed after the shadow pin; refusing to overwrite the pinned identity');
  }
  const built = bridge.buildKernelIntent(shadow, issuance);
  if (!built.ok) {
    return refused(d, workspace, taskId, shadow.commandId, built.code, built.message);
  }
  try {
    return await deliverShadowCommand(shadow, issuance, built.intent, Object.assign({}, o, { priorPin: pin || null }), d);
  } catch (e) {
    // Delivery never throws by construction; this is defense in depth so a
    // caller can never mistake an exception for Controller state change.
    return writeDiagnostic(d, workspace, taskId, { outcome: 'error', commandId: shadow.commandId, code: 'shadow-error', message: String((e && e.message) || e).slice(0, 300) });
  }
}

/**
 * Deterministic restart/recovery flow over a bounded scope: every committed
 * attempt of the bound generation that lacks a shadow record is delivered;
 * already-accepted commands reuse their receipts by commandId; duplicates
 * collapse to one authoritative receipt; conflicts and stale generations
 * are explicit refusals. Never creates attempts, never infers completion.
 */
async function reconcileTask(options, deps) {
  const o = options || {};
  const d = deps || {};
  if (!isShadowEnabled(o.env !== undefined ? o.env : d.env)) {
    return { outcome: 'skipped-disabled', reconciled: [], replayed: [], refused: [], errors: [], truncated: false };
  }
  const workspace = o.workspace;
  const taskId = o.taskId;
  if (typeof workspace !== 'string' || workspace === '' || typeof taskId !== 'string' || taskId === '') {
    return { outcome: 'refused', reconciled: [], replayed: [], refused: [{ attemptId: null, code: 'shadow-intent-invalid', message: 'workspace and taskId are required' }], errors: [], truncated: false };
  }
  const reader = d.reader || shadowIntent.defaultReader();
  let taskRecord = null;
  try {
    taskRecord = reader.readTaskRecord(workspace, taskId);
  } catch (e) {
    return { outcome: 'uncertain', reconciled: [], replayed: [], refused: [], errors: [{ attemptId: null, code: 'controller-unreadable', message: String((e && e.message) || e) }], truncated: false };
  }
  const authoritativeInstance = taskRecord && typeof taskRecord.taskInstanceId === 'string' ? taskRecord.taskInstanceId : '';
  if (authoritativeInstance === '' || (typeof o.taskInstanceId === 'string' && o.taskInstanceId !== '' && o.taskInstanceId !== authoritativeInstance)) {
    const entry = refused(d, workspace, taskId, null, 'stale-task-instance', 'reconciliation binding does not own this task generation; refusing');
    return { outcome: 'refused', reconciled: [], replayed: [], refused: [{ attemptId: null, code: entry.code, message: entry.message }], errors: [], truncated: false };
  }
  let records = null;
  try {
    records = reader.readAttemptRecords(workspace, taskId);
  } catch (e) {
    return { outcome: 'uncertain', reconciled: [], replayed: [], refused: [], errors: [{ attemptId: null, code: 'controller-unreadable', message: String((e && e.message) || e) }], truncated: false };
  }
  if (!records || records.length === 0) {
    return { outcome: 'nothing-to-do', reconciled: [], replayed: [], refused: [], errors: [], truncated: false };
  }
  const seen = new Map();
  for (const r of records) {
    if (r && r.taskId === taskId && r.taskInstanceId === authoritativeInstance && typeof r.attemptId === 'string' && r.attemptId !== '') {
      seen.set(r.attemptId, r);
    }
  }
  const attemptIds = Array.from(seen.keys()).sort();
  const truncated = attemptIds.length > MAX_ATTEMPTS_PER_RECONCILE;
  const scope = attemptIds.slice(0, MAX_ATTEMPTS_PER_RECONCILE);
  const summary = { outcome: 'reconciled', reconciled: [], replayed: [], refused: [], errors: [], truncated: truncated };
  for (const attemptId of scope) {
    let entry;
    try {
      entry = await observeCommittedAttempt(Object.assign({}, o, { taskInstanceId: authoritativeInstance, attemptId: attemptId }), d);
    } catch (e) {
      entry = { outcome: 'error', commandId: null, code: 'shadow-error', message: String((e && e.message) || e) };
    }
    if (entry.outcome === 'delivered') summary.reconciled.push({ attemptId: attemptId, commandId: entry.commandId || null });
    else if (entry.outcome === 'replayed') summary.replayed.push({ attemptId: attemptId, commandId: entry.commandId || null });
    else if (entry.outcome === 'skipped-disabled' || entry.outcome === 'skipped-unsupported') summary.refused.push({ attemptId: attemptId, code: entry.code, message: entry.message });
    else if (entry.outcome === 'refused') summary.refused.push({ attemptId: attemptId, code: entry.code, message: entry.message });
    else summary.errors.push({ attemptId: attemptId, code: entry.code || entry.outcome, message: entry.message || entry.outcome });
  }
  return summary;
}

module.exports = {
  SHADOW_FLAG: SHADOW_FLAG,
  SHADOW_SCHEMA_VERSION: SHADOW_SCHEMA_VERSION,
  SHADOW_MODE_ID: SHADOW_MODE_ID,
  SHADOW_ROLE: SHADOW_ROLE,
  isShadowEnabled: isShadowEnabled,
  observeCommittedAttempt: observeCommittedAttempt,
  reconcileTask: reconcileTask,
  readOutbox: readOutbox,
  resolvePin: resolvePin,
  isValidPin: isValidPin,
  outboxPath: outboxPath,
  diagnosticsPath: diagnosticsPath,
};
