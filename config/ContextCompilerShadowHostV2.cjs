'use strict';
/**
 * ContextCompilerShadowHostV2.cjs - CCV2-C07H production shadow installation.
 *
 * The ONE production installation point for Compiler Shadow Mode. Owned by
 * the controller layer (installed from config/AihController.cjs apply(),
 * which supplies installRoot/bindingsPath/log); this module owns the
 * observation hook and the read-only input assembly, and nothing else.
 *
 * Proven seam (read the installed DSH loop before assuming otherwise):
 * the agent/request waterfall resolves ONLY the route config
 * (provider/model/reasoningEffort/maxTokens); messages/system/tools are
 * merged AFTER it in buildRequest, and the FULL final request reaches
 * transport through exactly one llm/stream waterfall
 * (streamWithRegistration, both via preparedCall.stream and
 * loopCtx.llm.stream). Routing/model selection is therefore already
 * authoritative when this hook runs (isolation finalize + DSH
 * model-selection + prepareCall + Routing-Integrity's global-prepend
 * check, which always wraps this normally-ordered global listener).
 * The loop deepFreezes the request, so observation is read-only and the
 * identical stream reference is returned verbatim: C07 cannot influence
 * downstream composition.
 *
 * Per-request behavior (all failures skip or fail open; the request
 * ALWAYS proceeds):
 *   shadowMode off (default)            -> return next() verbatim, zero
 *                                          C07 work (adapter never called,
 *                                          no telemetry, no CCv2 reads).
 *   auxiliary purpose / missing session -> return next() verbatim.
 *   no binding / no CCv2 observation    -> silent skip (no adapter call,
 *     memory for the task                 no telemetry). A session without
 *                                          CCv2 durable memory has no
 *                                          candidate to compare; inventing
 *                                          one would be dishonest.
 *   memory present                      -> exactly one adapter observation
 *                                          per request object, one bounded
 *                                          sanitized telemetry line, same
 *                                          stream reference back.
 *
 * Input assembly reads ONLY already-persisted frozen artifacts and the
 * live request payload; it derives NO compiler policy:
 *   checkpoint : latest generation under
 *                <workspace>/.ai-harness/ccv2/<taskId>/checkpoints/
 *                (frozen one-file-per-generation layout). Sealed builds
 *                are preferred and pass frozen seal+read-back validation;
 *                schema-valid unsealed builds are accepted through frozen
 *                read+validate (observation needs truth, not durability
 *                proof; C08 flows persist sealed and are accepted
 *                unchanged). Absent/invalid/legacy -> skip. The
 *                checkpoint's own namespace triple must match the live
 *                binding triple (namespace isolation).
 *   pages      : <...>/pages/*.json, each frozen-validated (absent dir ->
 *                empty list; any invalid/foreign page -> skip).
 *   decisions  : <...>/tier-decisions.json, each frozen-validated
 *                (absent/invalid -> skip; C02 requires the mandatory set
 *                and fails closed without it, so there is no honest
 *                default). Namespaced decisions must triple-match.
 *   tool tx    : <...>/tool-transactions.json, shape-checked and C02
 *                binding-validated (absent -> empty; invalid -> skip).
 *   turn/text  : the live request's last user text message (typed block
 *                structure only; content never branched on). The candidate
 *                compiles the exact bytes the model receives.
 *   budget     : the single contextCompiler config section (explicit or
 *                skip; never guessed).
 *   counter    : the closed-world 'logical-codepoint-v1' mapping ONLY.
 *                CAVEAT (see C07H record): this is LOGICAL/test tokenizer
 *                telemetry. C08 production enablement requires a verified
 *                runtime tokenizer authority for the target model. The
 *                frozen counter contract is untouched; no model-tokenizer
 *                claim is made anywhere here.
 *   actual     : derived from the live request's typed projection
 *                (message identities + local content digests, typed
 *                hostOwned system bytes, paired tool transactions,
 *                current-turn hash). Mandatory status is NEVER inferred
 *                from prose: every live member is mandatory:false.
 *
 * State binding: actual and candidate share the sealed checkpoint's
 * boundary (generation/id/snapshot revisionDigest) by construction.
 * The adapter's capture/complete check re-reads the sealed revision at
 * completion, so a checkpoint replacement mid-request discards the
 * comparison (STATE_CHANGED). No new freshness authority is invented.
 *
 * Telemetry: one controller-log line per observation carrying the
 * sanitized report summary (IDs/digests/counts only, already proven
 * secret-safe) plus the non-authoritative runtime envelope. The
 * controller log channel never throws into the loop; the adapter
 * additionally isolates sink failures.
 *
 * Explicitly NOT here (C08 scope): prompt rendering, compiled-context
 * selection, legacy-context removal, compiled/legacy fallback, cache
 * control changes. The outgoing provider request is always the
 * legacy/current production projection.
 */

const fs = require('node:fs');
const path = require('node:path');

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const trustV2 = require('./ContextTrustV2.cjs');
const pageV2 = require('./ContextPageV2.cjs');
const tierV2 = require('./ContextMemoryTierV2.cjs');
const compilerV2 = require('./ContextCompilerV2.cjs');
const counterV2 = require('./ContextTokenCounterV2.cjs');
const allocatorV2 = require('./ContextBudgetAllocatorV2.cjs');
const shadowV2 = require('./ContextCompilerShadowV2.cjs');
const storeV2 = require('./ContextPageStoreV2.cjs');
const rehydrationV2 = require('./ContextEvidenceRehydrationV2.cjs');
const sessionSourceV2 = require('./ContextSessionEvidenceSourceV2.cjs');

const HOST_SCHEMA_VERSION = 1;
const SHADOW_POLICY_SECTION = 'contextCompiler';
const ROUTING_POLICY_FILE = 'routing-policy.json';
const CCV2_MEMORY_DIRNAME = 'ccv2';
const AIHARNESS_DIRNAME = '.ai-harness';
const CHECKPOINTS_DIRNAME = 'checkpoints';
const PAGES_DIRNAME = 'pages';
const DECISIONS_FILENAME = 'tier-decisions.json';
const TOOL_TX_FILENAME = 'tool-transactions.json';
const CHECKPOINT_FILE_PATTERN = /^cp-(\d{6})\.json$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,200}$/;
const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

// Logical tokenizer: the ONLY closed-world counter mapping in C07H.
// See the module header caveat: logical telemetry, never a model
// tokenizer claim. Any other value fails the observation closed
// (skip), so a future production tokenizer cannot silently slip in.
const LOGICAL_TOKENIZER_V1 = 'logical-codepoint-v1';

// Auxiliary llm/stream purposes that are never root inference.
// Mirrors Routing-Integrity.cjs exactly: those calls carry a session
// id and even a binding, but must never be shadow-observed as if they
// were the CCv2-compilable inference request.
const AUXILIARY_PURPOSES = Object.freeze(['compaction', 'session-title']);

// Bounded reads: every staged input is capped before parsing so a
// hostile/oversized memory dir fails open (skip) instead of stalling
// the request path.
//
// CCV2-R1 (supersedes pagesMax 256 / 1 MiB decisions / 64 KiB + 512
// tool transactions / 8192-char turn): C07H observes the same real-session
// scale C08 can legally compile (C01 sectionEntriesMax 8192 per section,
// ~1.5k durable units for a 735-step session). Bounds stay finite and
// fail open (skip), never Infinity.
const READ_BOUNDS = Object.freeze({
  policyFileBytes: 1048576,
  bindingsFileBytes: 1048576,
  checkpointEntriesMax: 4096,
  pagesMax: 8192,
  pageFileBytes: 262144,
  decisionsMax: 16384,
  decisionsFileBytes: 33554432,
  toolTxMax: 8192,
  toolTxFileBytes: 4194304,
  requestMessagesMax: 16384,
  tailScanMessagesMax: 20,
  currentTurnTextMax: 2097152,
});

// One installation per ctx (HMR/plugin reload safety): exactly one
// production installation point, no duplicate shadow observers.
const installedCtxs = new WeakSet();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}

function tripleOf(ns) {
  if (!isPlainObject(ns)) return null;
  if (typeof ns.taskId !== 'string' || typeof ns.taskInstanceId !== 'string'
    || typeof ns.sessionId !== 'string') return null;
  return { taskId: ns.taskId, taskInstanceId: ns.taskInstanceId, sessionId: ns.sessionId };
}

function tripleEqual(a, b) {
  return a !== null && b !== null
    && a.taskId === b.taskId && a.taskInstanceId === b.taskInstanceId && a.sessionId === b.sessionId;
}

// ---- single authoritative shadow-mode source ----

/**
 * Resolve the shadow policy from the ONE authoritative source:
 * <installRoot>/config/routing-policy.json -> contextCompiler section.
 * Closed world: { shadowMode: off|observe, budget:{hardMax,target},
 * tokenizer:'logical-codepoint-v1' }. Anything else resolves to off or
 * to skip reasons. Read fresh per request (one small file read, the same
 * cost profile as the isolation plane's per-request binding reads); no
 * cache, so no stale-policy hazard. NEVER throws: unreadable/invalid
 * policy is off.
 */
function resolveShadowPolicyV2(input) {
  const off = (reason) => Object.freeze({
    mode: 'off', budget: null, tokenizer: null, valid: false, reason,
  });
  try {
    const root = input && typeof input.installRoot === 'string' && input.installRoot !== ''
      ? path.resolve(String(input.installRoot)) : null;
    if (root === null) return off('shadow-policy-no-install-root');
    const policyPath = path.join(root, 'config', ROUTING_POLICY_FILE);
    let value = off('shadow-policy-absent');
    try {
      const text = fs.readFileSync(policyPath, 'utf8');
      if (Buffer.byteLength(text, 'utf8') > READ_BOUNDS.policyFileBytes) {
        value = off('shadow-policy-oversize');
      } else {
        const document = JSON.parse(text);
        const section = document && document[SHADOW_POLICY_SECTION];
        if (section !== undefined && section !== null) {
          value = validateShadowPolicySection(section);
        }
      }
    } catch {
      value = off('shadow-policy-invalid');
    }
    return value;
  } catch {
    return off('shadow-policy-failed');
  }
}

function validateShadowPolicySection(section) {
  const off = (reason) => Object.freeze({
    mode: 'off', budget: null, tokenizer: null, valid: false, reason,
  });
  if (!isPlainObject(section)) return off('shadow-policy-section-invalid');
  const rawMode = section.shadowMode === undefined || section.shadowMode === null
    ? 'off' : String(section.shadowMode);
  if (rawMode !== 'off' && rawMode !== 'observe') {
    return off('shadow-policy-mode-unknown');
  }
  if (rawMode === 'off') {
    return Object.freeze({
      mode: 'off', budget: null, tokenizer: null, valid: true, reason: null,
    });
  }
  const budget = section.budget;
  if (!isPlainObject(budget) || !Number.isInteger(budget.hardMax) || !Number.isInteger(budget.target)) {
    return Object.freeze({
      mode: 'observe', budget: null, tokenizer: null, valid: false, reason: 'shadow-policy-budget-required',
    });
  }
  if (budget.hardMax < allocatorV2.PACKING_BOUNDS.hardMaxMin
    || budget.hardMax > allocatorV2.PACKING_BOUNDS.hardMaxMax
    || budget.target < 0 || budget.target > budget.hardMax) {
    return Object.freeze({
      mode: 'observe', budget: null, tokenizer: null, valid: false, reason: 'shadow-policy-budget-invalid',
    });
  }
  const tokenizer = section.tokenizer === undefined || section.tokenizer === null
    ? null : String(section.tokenizer);
  if (tokenizer !== LOGICAL_TOKENIZER_V1) {
    return Object.freeze({
      mode: 'observe',
      budget: Object.freeze({ hardMax: budget.hardMax, target: budget.target }),
      tokenizer: null,
      valid: false,
      reason: 'shadow-policy-tokenizer-unknown',
    });
  }
  return Object.freeze({
    mode: 'observe',
    budget: Object.freeze({ hardMax: budget.hardMax, target: budget.target }),
    tokenizer,
    valid: true,
    reason: null,
  });
}

// ---- read-only live binding (isolation pattern, no mutation) ----

function readSessionBindingV2(input) {
  try {
    const bindingsPath = input && typeof input.bindingsPath === 'string' ? input.bindingsPath : null;
    const sessionId = input && typeof input.sessionId === 'string' ? input.sessionId : null;
    if (bindingsPath === null || bindingsPath === '' || sessionId === null || sessionId === '') return null;
    let stat = null;
    try {
      stat = fs.statSync(bindingsPath);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > READ_BOUNDS.bindingsFileBytes) return null;
    const document = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
    if (!document || document.schemaVersion !== 1 || !isPlainObject(document.bindings)) return null;
    const binding = document.bindings[sessionId] || null;
    if (!isPlainObject(binding)) return null;
    if (typeof binding.workspace !== 'string' || binding.workspace === '') return null;
    if (typeof binding.taskId !== 'string' || binding.taskId === '') return null;
    return binding;
  } catch {
    return null;
  }
}

// ---- CCv2 observation memory (read-only, bounded, validated) ----

function shadowMemoryDirForV2(workspace, taskId) {
  if (typeof workspace !== 'string' || workspace === '') return null;
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) return null;
  return path.join(workspace, AIHARNESS_DIRNAME, CCV2_MEMORY_DIRNAME, taskId);
}

function listCheckpointGenerationsV2(checkpointsDir) {
  let entries = null;
  try {
    entries = fs.readdirSync(checkpointsDir);
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length > READ_BOUNDS.checkpointEntriesMax) return null;
  const generations = [];
  for (const entry of entries) {
    const match = CHECKPOINT_FILE_PATTERN.exec(entry);
    if (match === null) continue;
    const generation = Number.parseInt(match[1], 10);
    if (Number.isInteger(generation) && generation >= 1) generations.push(generation);
  }
  return generations;
}

function readSealedCheckpointForTaskV2(memoryDir) {
  const skip = (reason) => ({ sealed: null, skipped: reason });
  try {
    if (typeof memoryDir !== 'string' || memoryDir === '') return skip('shadow-no-memory-dir');
    const checkpointsDir = path.join(memoryDir, CHECKPOINTS_DIRNAME);
    const generations = listCheckpointGenerationsV2(checkpointsDir);
    if (generations === null || generations.length === 0) return skip('shadow-no-sealed-checkpoint');
    const latest = Math.max.apply(null, generations);
    let checkpoint = null;
    try {
      const stored = trustV2.readSealedCheckpointV2(checkpointsDir, latest);
      if (stored !== null && isPlainObject(stored.checkpoint)) checkpoint = stored.checkpoint;
    } catch {
      checkpoint = null;
    }
    if (checkpoint === null) {
      try {
        const stored = checkpointV2.readCheckpointV2(checkpointsDir, latest);
        if (stored !== null && isPlainObject(stored.checkpoint)) checkpoint = stored.checkpoint;
      } catch {
        return skip('shadow-checkpoint-unreadable');
      }
    }
    if (checkpoint === null) return skip('shadow-no-sealed-checkpoint');
    if (!isPlainObject(checkpoint.snapshot)
      || typeof checkpoint.snapshot.revisionDigest !== 'string'
      || !HEX64_PATTERN.test(checkpoint.snapshot.revisionDigest)) {
      return skip('shadow-checkpoint-not-snapshot-bound');
    }
    return { sealed: checkpoint, skipped: null };
  } catch {
    return skip('shadow-checkpoint-failed');
  }
}

/**
 * Deterministic staleness signal: the sealed revisionDigest re-read
 * from the observation memory. The adapter passes this as
 * getCurrentRevision, so a checkpoint replacement between capture and
 * completion discards the comparison (STATE_CHANGED). Pure read;
 * throws when unreadable (the adapter maps a probe failure to a
 * not-comparable outcome; the request still proceeds).
 */
function readSealedRevisionForTaskV2(memoryDir) {
  const found = readSealedCheckpointForTaskV2(memoryDir);
  if (found.sealed === null) throw new Error('context-compiler-shadow-no-sealed-checkpoint (DISCARDABLE)');
  return found.sealed.snapshot.revisionDigest;
}

function readBoundedJsonFileV2(filePath, maxBytes) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { present: false, value: null };
  }
  if (!stat.isFile() || stat.size > maxBytes) return { present: true, value: null, oversize: true };
  try {
    return { present: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')), oversize: false };
  } catch {
    return { present: true, value: null, oversize: false, malformed: true };
  }
}

function readStagedPagesV2(memoryDir, bindingTriple) {
  const skip = (reason) => ({ pages: null, skipped: reason });
  try {
    const pagesDir = path.join(memoryDir, PAGES_DIRNAME);
    let entries = null;
    try {
      entries = fs.readdirSync(pagesDir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { pages: [], skipped: null };
      return skip('shadow-pages-unreadable');
    }
    const files = entries.filter((entry) => typeof entry === 'string' && entry.endsWith('.json'));
    if (files.length > READ_BOUNDS.pagesMax) return skip('shadow-pages-oversize');
    const pages = [];
    for (const file of files) {
      const loaded = readBoundedJsonFileV2(path.join(pagesDir, file), READ_BOUNDS.pageFileBytes);
      if (!loaded.present || loaded.oversize === true || loaded.malformed === true
        || !isPlainObject(loaded.value)) {
        return skip('shadow-page-unreadable');
      }
      const check = pageV2.validateContextPageV2(loaded.value);
      if (!check.valid) return skip('shadow-page-invalid');
      const pageTriple = tripleOf(loaded.value.namespace);
      if (!tripleEqual(pageTriple, bindingTriple)) return skip('shadow-page-namespace-mismatch');
      pages.push(loaded.value);
    }
    pages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { pages, skipped: null };
  } catch {
    return skip('shadow-pages-failed');
  }
}

function readStagedDecisionsV2(memoryDir, bindingTriple) {
  const skip = (reason) => ({ decisions: null, skipped: reason });
  try {
    const loaded = readBoundedJsonFileV2(
      path.join(memoryDir, DECISIONS_FILENAME), READ_BOUNDS.decisionsFileBytes);
    if (!loaded.present) return skip('shadow-no-tier-decisions');
    if (loaded.oversize === true || loaded.malformed === true || !Array.isArray(loaded.value)) {
      return skip('shadow-tier-decisions-invalid');
    }
    if (loaded.value.length === 0 || loaded.value.length > READ_BOUNDS.decisionsMax) return skip('shadow-tier-decisions-invalid');
    const decisions = [];
    for (const entry of loaded.value) {
      const check = tierV2.validateMemoryTierDecisionV2(entry);
      if (!check.valid) return skip('shadow-tier-decision-invalid');
      if (isPlainObject(entry.namespace)) {
        const decisionTriple = tripleOf(entry.namespace);
        if (decisionTriple !== null && !tripleEqual(decisionTriple, bindingTriple)) {
          return skip('shadow-decision-namespace-mismatch');
        }
      }
      decisions.push(entry);
    }
    return { decisions, skipped: null };
  } catch {
    return skip('shadow-tier-decisions-failed');
  }
}

function readStagedToolTransactionsV2(memoryDir) {
  const skip = (reason) => ({ transactions: null, skipped: reason });
  const ok = (transactions) => ({ transactions, skipped: null });
  try {
    const loaded = readBoundedJsonFileV2(
      path.join(memoryDir, TOOL_TX_FILENAME), READ_BOUNDS.toolTxFileBytes);
    if (!loaded.present) return ok([]);
    if (loaded.oversize === true || loaded.malformed === true || !Array.isArray(loaded.value)) {
      return skip('shadow-tool-transactions-invalid');
    }
    if (loaded.value.length > READ_BOUNDS.toolTxMax) return skip('shadow-tool-transactions-invalid');
    const transactions = [];
    for (const entry of loaded.value) {
      if (!isPlainObject(entry)
        || typeof entry.pageId !== 'string' || !PAGE_ID_PATTERN.test(entry.pageId)
        || typeof entry.callId !== 'string' || entry.callId === '' || entry.callId.length > 256
        || !(Number.isInteger(entry.callSeq) || entry.callSeq === null)
        || !Number.isInteger(entry.resultSeq)) {
        return skip('shadow-tool-transaction-invalid');
      }
      transactions.push({
        pageId: entry.pageId, callId: entry.callId,
        callSeq: entry.callSeq, resultSeq: entry.resultSeq,
      });
    }
    return ok(transactions);
  } catch {
    return skip('shadow-tool-transactions-failed');
  }
}

// ---- CCV2-M01 staged exact material + lossless-replacement coverage ----

/**
 * B03 exact material for blob-backed HOT/WARM staged pages (R1 WARM_EXACT):
 * each is rehydrated through the frozen B03 authority from the task's B02
 * store, with the live session exact source proving tool-unit balance.
 * Returns { material } or { material:null, skipped } (never partial).
 */
function readStagedExactMaterialV2(input) {
  const skip = (reason) => ({ material: null, skipped: reason });
  try {
    if (!isPlainObject(input) || typeof input.workspace !== 'string' || input.workspace === '') return skip('shadow-exact-material-invalid');
    const sealed = input.sealed;
    const namespace = {
      taskId: sealed.taskId, taskInstanceId: sealed.taskInstanceId, sessionId: sealed.sessionId,
      workspaceId: sealed.workspaceId, repositoryId: sealed.repositoryId, checkoutId: sealed.checkoutId,
    };
    const tierByPage = new Map();
    for (const decision of input.decisions) {
      if (typeof decision.pageId === 'string') tierByPage.set(decision.pageId, decision.tier);
    }
    const needs = input.pages.filter((page) => typeof page.exactBlobRef === 'string'
      && (tierByPage.get(page.id) === 'HOT' || tierByPage.get(page.id) === 'WARM'));
    if (needs.length === 0) return { material: [], skipped: null };
    const contextRoot = storeV2.contextRootForV2(path.resolve(input.workspace), namespace.taskId);
    const sessionSource = sessionSourceV2.isSessionExactSourceV2(input.sessionSource) ? input.sessionSource : null;
    const material = [];
    for (const page of needs) {
      if (page.kind === 'tool-result' && sessionSource === null) return skip('shadow-exact-material-session-unavailable');
      material.push(rehydrationV2.rehydrateContextPageV2({
        contextRoot, pageId: page.id, expectedNamespace: namespace,
        sessionSource: page.kind === 'tool-result' ? sessionSource : undefined,
      }));
    }
    return { material, skipped: null };
  } catch {
    return skip('shadow-exact-material-unavailable');
  }
}

const COVERAGE_FILENAME = 'coverage.json';

/** Producer-written coverage of model-visible messages (null when absent). */
function readStagedCoverageV2(memoryDir) {
  try {
    const loaded = readBoundedJsonFileV2(path.join(memoryDir, COVERAGE_FILENAME), READ_BOUNDS.decisionsFileBytes);
    if (!loaded.present) return { coverage: null, skipped: null };
    const value = loaded.value;
    if (!isPlainObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.messageHashes)
      || value.messageHashes.length > READ_BOUNDS.requestMessagesMax
      || !value.messageHashes.every((hash) => typeof hash === 'string' && HEX64_PATTERN.test(hash))
      || (value.currentTurnMessageHash !== null && !(typeof value.currentTurnMessageHash === 'string' && HEX64_PATTERN.test(value.currentTurnMessageHash)))) {
      return { coverage: null, skipped: 'shadow-coverage-invalid' };
    }
    return { coverage: { hashes: new Set(value.messageHashes), currentTurnMessageHash: value.currentTurnMessageHash }, skipped: null };
  } catch {
    return { coverage: null, skipped: 'shadow-coverage-invalid' };
  }
}

/**
 * CCV2-M01 lossless-replacement proof (supersedes the fixture-era
 * "exactly one live user-text message" rule WHEN producer coverage exists):
 * the last live user-text message must be the current turn, and every
 * OTHER live message must hash-match a message the staged memory
 * represents. Any uncovered live message fails safe (null = proven).
 */
function checkLiveCoverageV2(messages, coverage, liveTurnText) {
  if (!Array.isArray(messages) || coverage === null) return 'coverage-unavailable';
  let turnIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const texts = messages[index] && messages[index].role === 'user' ? textBlocksOf(messages[index]) : null;
    if (texts !== null && texts.length > 0) { turnIndex = index; break; }
  }
  if (turnIndex === -1) return 'current-turn-missing';
  if (textBlocksOf(messages[turnIndex]).join('\n') !== liveTurnText) return 'current-turn-mismatch';
  if (coverage.currentTurnMessageHash !== null
    && sha256HexUtf8(canonicalJsonOf(messages[turnIndex])) !== coverage.currentTurnMessageHash) {
    return 'current-turn-not-staged-turn';
  }
  for (let index = 0; index < messages.length; index += 1) {
    if (index === turnIndex) continue;
    if (!coverage.hashes.has(sha256HexUtf8(canonicalJsonOf(messages[index])))) return 'live-message-uncovered';
  }
  return null;
}

// ---- live request projection (typed structure only) ----

function textBlocksOf(message) {
  if (!isPlainObject(message) || !Array.isArray(message.content)) return null;
  const texts = [];
  for (const block of message.content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  return texts;
}

// DSH ToolCallBlock identity is `id` (dsh-llm types.d.ts); `callId` is
// accepted only as the frozen A06 legacy alias (ContextShadowV2 /
// EvidenceRehydration precedence). ToolResultBlock identity is
// `toolCallId`; ToolMessageSource carries `callId`.
function toolCallBlockIdOf(block) {
  if (!isPlainObject(block) || block.type !== 'tool-call') return null;
  if (typeof block.id === 'string' && block.id !== '') return block.id;
  if (typeof block.callId === 'string' && block.callId !== '') return block.callId;
  return null;
}

function callIdsOfMessage(message) {
  const calls = [];
  const results = [];
  if (!isPlainObject(message) || !Array.isArray(message.content)) return { calls, results };
  for (const block of message.content) {
    if (!isPlainObject(block)) continue;
    const callId = toolCallBlockIdOf(block);
    if (callId !== null) calls.push(callId);
    if (block.type === 'tool-result') {
      const bound = typeof block.toolCallId === 'string' && block.toolCallId !== ''
        ? block.toolCallId
        : (typeof block.callId === 'string' && block.callId !== '' ? block.callId : null);
      if (bound !== null) results.push(bound);
    }
  }
  const source = message.source;
  if (isPlainObject(source) && typeof source.callId === 'string' && source.callId !== '') {
    const hasResult = message.content.some((block) => isPlainObject(block) && block.type === 'tool-result');
    if (hasResult && results.indexOf(source.callId) === -1) results.push(source.callId);
  }
  return { calls, results };
}

/**
 * Pair live tool transactions across the composed messages by typed
 * call identity (mirrors the frozen balanced-cut direction: protocol
 * STRUCTURE, never prose). balanced = exactly the complete unit the
 * frozen authorities require; ambiguity resolves to unbalanced (never
 * trusted), and unbalanced actual units simply claim no coverage.
 */
function pairLiveToolTransactionsV2(messages) {
  const seenCalls = new Map();
  const seenResults = new Map();
  const order = [];
  messages.forEach((message) => {
    const { calls, results } = callIdsOfMessage(message);
    for (const callId of calls) {
      if (!seenCalls.has(callId)) {
        seenCalls.set(callId, 0);
        order.push(callId);
      }
      seenCalls.set(callId, seenCalls.get(callId) + 1);
    }
    for (const callId of results) {
      seenResults.set(callId, (seenResults.get(callId) || 0) + 1);
    }
  });
  return order.map((callId) => ({
    callId,
    balanced: seenCalls.get(callId) === 1 && (seenResults.get(callId) || 0) >= 1,
  }));
}

/**
 * Open-protocol scan over the message tail (typed blocks only). A tail
 * assistant tool-call with no later matching result means the protocol
 * is genuinely open: C02 fails closed (protocol-open) and the shadow
 * reports the candidate unavailable while inference proceeds. Doubt
 * resolves to null (compile proceeds; frozen C02 still guards).
 */
function derivePendingProtocolV2(messages) {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const tail = messages.slice(Math.max(0, messages.length - READ_BOUNDS.tailScanMessagesMax));
    const pairs = pairLiveToolTransactionsV2(messages);
    const balancedSet = new Set();
    for (const tx of pairs) {
      if (tx.balanced === true) balancedSet.add(tx.callId);
    }
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const { calls } = callIdsOfMessage(tail[index]);
      for (const callId of calls) {
        if (!balancedSet.has(callId)) return { callId, callSeq: null };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function extractLiveCurrentTurnV2(messages) {
  const skip = (reason) => ({ turn: null, skipped: reason });
  try {
    if (!Array.isArray(messages) || messages.length === 0) return skip('shadow-no-live-messages');
    if (messages.length > READ_BOUNDS.requestMessagesMax) return skip('shadow-live-messages-oversize');
    for (const message of messages) {
      if (!isPlainObject(message) || typeof message.role !== 'string') return skip('shadow-live-message-invalid');
    }
    // The current turn is the latest user TEXT message (tool-result
    // messages are user-role but carry no turn text and are skipped
    // over). Typed block structure only; content never branched on.
    let turnMessage = null;
    let turnTexts = null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role !== 'user') continue;
      const texts = textBlocksOf(messages[index]);
      if (texts !== null && texts.length > 0) {
        turnMessage = messages[index];
        turnTexts = texts;
        break;
      }
    }
    if (turnMessage === null || turnTexts === null) return skip('shadow-no-live-user-turn');
    const text = turnTexts.join('\n');
    if (text === '' || text.length > READ_BOUNDS.currentTurnTextMax) return skip('shadow-live-turn-unusable');
    return { turn: { turnId: 'live', text, revision: null }, skipped: null };
  } catch {
    return skip('shadow-live-turn-failed');
  }
}

function memberIdForV2(role, index, message) {
  const safeRole = /^[a-z]{1,32}$/.test(role) ? role : 'unknown';
  let suffix = '';
  if (isPlainObject(message) && typeof message.id === 'string' && /^[A-Za-z0-9_\-]{1,128}$/.test(message.id)) {
    suffix = ':' + message.id;
  }
  return 'live:' + safeRole + ':' + index + suffix;
}

/**
 * Actual-side members from the composed request: one typed member per
 * message (source identity + local content digest), plus the
 * host-owned system contract bytes as HOST_EXTERNAL by structural
 * position (the system FIELD, never text matching). Mandatory status
 * is never inferred from prose: every live member is mandatory:false.
 */
function deriveActualMembersV2(messages, systemText) {
  const members = [];
  messages.forEach((message, index) => {
    members.push({
      sourceId: memberIdForV2(message.role, index, message),
      shownHash: sha256HexUtf8(canonicalJsonOf(message)),
      sourceHash: sha256HexUtf8(canonicalJsonOf(message)),
      kind: 'EXACT',
      tier: 'HOT',
      section: 'hot',
      mandatory: false,
      hostOwned: false,
      reference: false,
      tokens: null,
    });
  });
  if (typeof systemText === 'string' && systemText !== '') {
    members.push({
      sourceId: 'dsh:system-controller-contract',
      shownHash: sha256HexUtf8(systemText),
      sourceHash: sha256HexUtf8(systemText),
      kind: 'EXACT',
      tier: 'PINNED',
      section: 'pinned',
      mandatory: false,
      hostOwned: true,
      reference: false,
      tokens: null,
    });
  }
  return members;
}

// ---- full input assembly (read-only, fail-open via skip) ----

function skipResult(reason) {
  return Object.freeze({ skipped: reason, actual: null, candidateFactory: null, sealed: null, policy: null });
}

/**
 * Assemble { actual, candidateFactory } for one live request from
 * frozen artifacts + the request payload. Returns { skipped } when no
 * honest observation is possible (never throws). Derives NO compiler
 * policy: staged data is validated and passed through; live
 * structure is measured, never interpreted.
 */
function assembleShadowInputsV2(input) {
  try {
    if (!isPlainObject(input)) return skipResult('shadow-input-invalid');
    const request = isPlainObject(input.request) ? input.request : null;
    if (request === null) return skipResult('shadow-request-invalid');
    const policy = isPlainObject(input.policy) ? input.policy : null;
    if (policy === null || policy.mode !== 'observe' || policy.valid !== true
      || !isPlainObject(policy.budget) || typeof policy.tokenizer !== 'string') {
      return skipResult('shadow-policy-inactive');
    }
    const binding = readSessionBindingV2({ bindingsPath: input.bindingsPath, sessionId: request.sessionId });
    if (binding === null) return skipResult('shadow-no-binding');
    const bindingTriple = tripleOf({
      taskId: binding.taskId,
      taskInstanceId: typeof binding.taskInstanceId === 'string' ? binding.taskInstanceId : null,
      sessionId: typeof binding.sessionId === 'string' && binding.sessionId !== ''
        ? binding.sessionId : request.sessionId,
    });
    if (bindingTriple === null || bindingTriple.taskInstanceId === null) return skipResult('shadow-binding-incomplete');
    const memoryDir = shadowMemoryDirForV2(binding.workspace, bindingTriple.taskId);
    if (memoryDir === null) return skipResult('shadow-workspace-invalid');
    const checkpointFound = readSealedCheckpointForTaskV2(memoryDir);
    if (checkpointFound.sealed === null) return skipResult(checkpointFound.skipped);
    const sealed = checkpointFound.sealed;
    const sealedTriple = tripleOf({
      taskId: sealed.taskId,
      taskInstanceId: sealed.taskInstanceId,
      sessionId: sealed.sessionId,
    });
    if (!tripleEqual(sealedTriple, bindingTriple)) return skipResult('shadow-checkpoint-namespace-mismatch');
    const stagedPages = readStagedPagesV2(memoryDir, bindingTriple);
    if (stagedPages.pages === null) return skipResult(stagedPages.skipped);
    const stagedDecisions = readStagedDecisionsV2(memoryDir, bindingTriple);
    if (stagedDecisions.decisions === null) return skipResult(stagedDecisions.skipped);
    const stagedTx = readStagedToolTransactionsV2(memoryDir);
    if (stagedTx.transactions === null) return skipResult(stagedTx.skipped);
    const exact = readStagedExactMaterialV2({
      workspace: binding.workspace, sealed, pages: stagedPages.pages, decisions: stagedDecisions.decisions,
      sessionSource: typeof input.sessionSourceFor === 'function' ? input.sessionSourceFor(request.sessionId) : null,
    });
    if (exact.material === null) return skipResult(exact.skipped);

    const messages = Array.isArray(request.messages) ? request.messages : null;
    if (messages === null) return skipResult('shadow-no-live-messages');
    const liveTurn = extractLiveCurrentTurnV2(messages);
    if (liveTurn.turn === null) return skipResult(liveTurn.skipped);

    let counter = null;
    try {
      if (policy.tokenizer !== LOGICAL_TOKENIZER_V1) return skipResult('shadow-tokenizer-unknown');
      counter = counterV2.createCodepointTestCounterV2();
    } catch {
      return skipResult('shadow-counter-unavailable');
    }

    const members = deriveActualMembersV2(messages, request.system);
    const livePairs = pairLiveToolTransactionsV2(messages);
    // Token accounting over the exact canonical bytes each comparable
    // member's shown hash binds (same bytes, same fingerprint).
    let comparableTokens = 0;
    try {
      for (let index = 0; index < messages.length; index += 1) {
        comparableTokens += counterV2.countTextVerifiedV2(counter, canonicalJsonOf(messages[index]));
      }
    } catch {
      return skipResult('shadow-tokens-unavailable');
    }

    const actual = {
      schemaVersion: shadowV2.SHADOW_SCHEMA_VERSION,
      namespace: bindingTriple,
      checkpointBinding: {
        checkpointGeneration: sealed.generation,
        checkpointId: sealed.checkpointId,
        snapshotRevision: sealed.snapshot.revisionDigest,
      },
      turnRef: { turnId: 'live', revision: null },
      members,
      currentTurn: {
        turnId: 'live',
        textHash: sha256HexUtf8(liveTurn.turn.text),
        revision: null,
      },
      toolTransactions: livePairs,
      verification: null,
      comparableTokens,
      tokenizerFingerprint: counter.tokenizerFingerprint,
    };

    const compileInput = {
      checkpoint: sealed,
      currentTurn: { turnId: 'live', text: liveTurn.turn.text, revision: null },
      namespace: {
        taskId: sealed.taskId,
        taskInstanceId: sealed.taskInstanceId,
        sessionId: sealed.sessionId,
        workspaceId: sealed.workspaceId,
        repositoryId: sealed.repositoryId,
        checkoutId: sealed.checkoutId,
      },
      snapshotRevision: sealed.snapshot.revisionDigest,
      runtimeState: { pendingProtocol: derivePendingProtocolV2(messages) },
      pages: stagedPages.pages,
      tierDecisions: stagedDecisions.decisions,
      evidenceRefs: [],
      exactMaterial: exact.material,
      toolTransactions: stagedTx.transactions,
      budget: { hardMax: policy.budget.hardMax, target: policy.budget.target },
      compilerPolicyRevision: compilerV2.COMPILER_POLICY_REVISION_V2,
    };

    return Object.freeze({
      skipped: null,
      policy,
      sealed,
      memoryDir,
      actual: Object.freeze(actual),
      candidateFactory: Object.freeze({
        compileInput,
        pages: stagedPages.pages,
        budget: { hardMax: policy.budget.hardMax, target: policy.budget.target },
        counter,
      }),
    });
  } catch {
    return skipResult('shadow-assembly-failed');
  }
}

// ---- the production llm/stream observer ----

function defaultTelemetrySinkV2(log) {
  return (report, envelope) => {
    try {
      const summary = shadowV2.describeShadowReportV2(report);
      log(Object.assign({ event: 'ccv2-compiler-shadow-observed' }, summary, {
        candidateMs: envelope && typeof envelope.candidateMs === 'number' ? envelope.candidateMs : null,
        comparisonMs: envelope && typeof envelope.comparisonMs === 'number' ? envelope.comparisonMs : null,
        totalMs: envelope && typeof envelope.totalMs === 'number' ? envelope.totalMs : null,
      }));
    } catch {
      // Telemetry is never an availability dependency (the adapter
      // additionally isolates sink failures).
    }
  };
}

/**
 * Create the llm/stream waterfall listener. Contract: calls next(),
 * observes the final request read-only, returns the IDENTICAL stream
 * reference. Never throws into the waterfall (any internal failure
 * keeps the transport path intact).
 */
function createShadowStreamListenerV2(deps) {
  const seen = new WeakSet();
  const safeDeps = isPlainObject(deps) ? deps : {};
  const adapterModule = isPlainObject(safeDeps.adapterModule)
    && typeof safeDeps.adapterModule.observeCompilerShadowV2 === 'function'
    ? safeDeps.adapterModule
    : require('./ContextCompilerShadowAdapterV2.cjs');
  return function compilerShadowStreamListener(request, next) {
    const stream = next();
    try {
      if (!isPlainObject(request)) return stream;
      if (typeof request.purpose === 'string' && AUXILIARY_PURPOSES.indexOf(request.purpose) !== -1) return stream;
      if (typeof request.sessionId !== 'string' || request.sessionId === '') return stream;
      const policy = resolveShadowPolicyV2({ installRoot: safeDeps.installRoot });
      if (policy.mode !== 'observe' || policy.valid !== true) return stream;
      // The guard counts observations, not sightings: OFF-mode and
      // skipped passes never mark the object, so a later eligible pass
      // over the same request still observes exactly once.
      if (seen.has(request)) return stream;
      seen.add(request);
      const assembled = assembleShadowInputsV2({
        request,
        policy,
        bindingsPath: safeDeps.bindingsPath,
        sessionSourceFor: safeDeps.sessionSourceFor,
      });
      if (assembled.skipped !== null || assembled.actual === null || assembled.candidateFactory === null) return stream;
      const memoryDir = assembled.memoryDir;
      let outcome = null;
      try {
        outcome = adapterModule.observeCompilerShadowV2({
          mode: 'observe',
          request,
          actual: assembled.actual,
          candidateFactory: assembled.candidateFactory,
          getCurrentRevision: () => readSealedRevisionForTaskV2(memoryDir),
          telemetrySink: defaultTelemetrySinkV2(safeDeps.log),
        });
      } catch {
        return stream;
      }
      void outcome;
    } catch {
      // Any observer failure keeps the transport path intact.
    }
    return stream;
  };
}

/**
 * Install the ONE production shadow observer on ctx (llm/stream,
 * global, normal order: always inside Routing-Integrity's
 * global-prepend check, always outside the terminal adapter).
 * Idempotent per ctx (HMR/plugin reload safety). Validates deps and
 * never throws: a failed installation simply reports
 * { installed:false } while controller startup proceeds.
 */
function installCompilerShadowObserver(ctx, deps) {
  try {
    if (!ctx || typeof ctx.on !== 'function') return { installed: false, reason: 'no-hook-surface' };
    if (installedCtxs.has(ctx)) return { installed: true, reason: 'already-installed' };
    const safeDeps = isPlainObject(deps) ? deps : {};
    if (typeof safeDeps.installRoot !== 'string' || safeDeps.installRoot === '') {
      return { installed: false, reason: 'no-install-root' };
    }
    if (typeof safeDeps.bindingsPath !== 'string' || safeDeps.bindingsPath === '') {
      return { installed: false, reason: 'no-bindings-path' };
    }
    if (typeof safeDeps.log !== 'function') return { installed: false, reason: 'no-log-channel' };
    ctx.on('llm/stream', createShadowStreamListenerV2(safeDeps), { global: true });
    installedCtxs.add(ctx);
    return { installed: true, reason: null };
  } catch {
    return { installed: false, reason: 'install-failed' };
  }
}

module.exports = {
  HOST_SCHEMA_VERSION,
  SHADOW_POLICY_SECTION,
  LOGICAL_TOKENIZER_V1,
  AUXILIARY_PURPOSES,
  READ_BOUNDS,
  resolveShadowPolicyV2,
  readSessionBindingV2,
  shadowMemoryDirForV2,
  listCheckpointGenerationsV2,
  readSealedCheckpointForTaskV2,
  readSealedRevisionForTaskV2,
  readStagedPagesV2,
  readStagedDecisionsV2,
  readStagedToolTransactionsV2,
  readStagedExactMaterialV2,
  readStagedCoverageV2,
  checkLiveCoverageV2,
  textBlocksOf,
  pairLiveToolTransactionsV2,
  derivePendingProtocolV2,
  extractLiveCurrentTurnV2,
  deriveActualMembersV2,
  assembleShadowInputsV2,
  createShadowStreamListenerV2,
  installCompilerShadowObserver,
};
