'use strict';
/**
 * ContextSessionEvidenceSourceV2.cjs - CCV2-B03 canonical session exact source.
 *
 * Narrow ADAPTER (not authority): exposes canonical DSH/session events to the
 * B03 rehydration authority (config/ContextEvidenceRehydrationV2.cjs) and
 * freezes the deterministic session-evidence digest that pure-session pages
 * attest. This module NEVER declares verified:true and performs NO store,
 * page, or EvidenceRef writes.
 *
 * Frozen session-evidence identity (B03):
 *
 *   projectEvent(event) = { seq, type, data }  (canonical projection; every
 *     other host field - ids, timestamps, runtime derivations - is ignored)
 *   canonicalText = canonicalJson({ domain, sessionId, events:[projected...] })
 *   redactedText  = A03 redactCheckpointTextV2(canonicalText) (fixed point,
 *     never truncated)
 *   sessionDigest = sha256HexUtf8(redactedText)
 *
 * A pure-session B01 page (sourceSeqs only, caller-attested contentHash)
 * carries sufficient B03 identity iff its attested contentHash equals this
 * digest over the exact canonical events. The digest binds sessionId (no
 * cross-session reuse), seq (no array-index substitution), type+data (no
 * payload mutation), and the redacted persistable form (no secret return).
 *
 * Event lookup rule (frozen): resolve by canonical seq identity
 * (event.seq === requested seq), NEVER by array index alone. A dense array
 * whose element fails the seq check is a source mismatch, not a shifted hit.
 */

const checkpointV2 = require('./ContextCheckpointV2.cjs');

const SESSION_EVIDENCE_DOMAIN_V1 = 'nexus/context-session-evidence/v1';
const SESSION_EVIDENCE_SCHEMA_VERSION = 1;

function failSession(reason, detail) {
  throw new Error('v2-session-source: ' + reason + (detail ? ' (' + detail + ')' : '') + ' (BLOCK/KEEP)');
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

// Canonical projection: exactly { seq, type, data }. Unknown host fields are
// dropped (they are runtime derivations, not evidence identity); missing
// seq/type/data fails closed.
function projectSessionEventV2(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    failSession('context-rehydration-source-mismatch', 'session event is not an object');
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    failSession('context-rehydration-source-mismatch', 'session event seq is not canonical');
  }
  if (typeof event.type !== 'string' || event.type === '') {
    failSession('context-rehydration-source-mismatch', 'session event type is required');
  }
  if (event.data === undefined || event.data === null || typeof event.data !== 'object') {
    failSession('context-rehydration-source-mismatch', 'session event data is required');
  }
  return { seq: event.seq, type: event.type, data: event.data };
}

function canonicalSessionEvidenceTextV2(sessionId, eventsInOrder) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    failSession('context-rehydration-source-mismatch', 'sessionId is required');
  }
  if (!Array.isArray(eventsInOrder) || eventsInOrder.length === 0) {
    failSession('context-rehydration-source-mismatch', 'ordered session events are required');
  }
  const projected = eventsInOrder.map((event) => projectSessionEventV2(event));
  const canonical = JSON.stringify(checkpointV2.canonicalize({
    domain: SESSION_EVIDENCE_DOMAIN_V1,
    sessionId,
    events: projected,
  }));
  const headroom = canonical.length * 2 + 4096;
  const redacted = checkpointV2.redactCheckpointTextV2(canonical, headroom);
  if (redacted.endsWith('...<truncated>')) {
    failSession('context-rehydration-source-mismatch', 'session evidence exceeds the deterministic redaction bound');
  }
  if (redacted === '') {
    failSession('context-rehydration-source-mismatch', 'session evidence is empty after redaction');
  }
  return redacted;
}

function deriveSessionEvidenceDigestV2(sessionId, eventsInOrder) {
  return sha256HexUtf8(canonicalSessionEvidenceTextV2(sessionId, eventsInOrder));
}

// ---- adapter shape (frozen) ----
// SessionExactSourceV2 { sessionId, readEvent(seq), readEvents(seqs) }.
// readEvent returns the canonical host event object or null when absent;
// readEvents returns an array aligned to the requested seqs. Adapters do
// byte/event supply only: seq-identity and digest checks belong to B03.
function assertSourceShape(source) {
  if (!source || typeof source !== 'object') {
    failSession('context-rehydration-source-missing', 'a session exact source is required');
  }
  if (typeof source.sessionId !== 'string' || source.sessionId === '') {
    failSession('context-rehydration-source-missing', 'session source sessionId is required');
  }
  if (typeof source.readEvent !== 'function' || typeof source.readEvents !== 'function') {
    failSession('context-rehydration-source-missing', 'session source must expose readEvent/readEvents');
  }
  return source;
}

// In-memory/canonical adapter over an explicit event array. Verification of
// contiguity is NOT assumed: lookup scans for event.seq === seq.
function createMemorySessionSourceV2(sessionId, events) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    failSession('context-rehydration-source-missing', 'sessionId is required');
  }
  if (!Array.isArray(events)) {
    failSession('context-rehydration-source-missing', 'events array is required');
  }
  const snapshot = events.slice();
  function readEvent(seq) {
    if (!Number.isInteger(seq) || seq < 0) return null;
    for (const event of snapshot) {
      if (event && typeof event === 'object' && event.seq === seq) return event;
    }
    return null;
  }
  function readEvents(seqs) {
    if (!Array.isArray(seqs)) failSession('context-rehydration-source-mismatch', 'seqs array is required');
    return seqs.map((seq) => readEvent(seq));
  }
  return Object.freeze({ kind: 'memory-session-source', sessionId, readEvent, readEvents });
}

// Live DSH adapter over a real pinned-host session object
// (session.events + session.id). No DSH persistence is owned here: the caller
// holds the session lifecycle (create/append/flush/restore); this adapter
// only resolves canonical seq identity against the live object.
function wrapDshSessionV2(session) {
  if (!session || typeof session !== 'object') {
    failSession('context-rehydration-source-missing', 'a live DSH session object is required');
  }
  if (!Array.isArray(session.events)) {
    failSession('context-rehydration-source-missing', 'live session carries no canonical event log');
  }
  const sessionId = typeof session.id === 'string' && session.id !== ''
    ? session.id
    : (session.header && typeof session.header.id === 'string' ? session.header.id : null);
  if (typeof sessionId !== 'string' || sessionId === '') {
    failSession('context-rehydration-source-missing', 'live session identity is required');
  }
  const liveEvents = () => (Array.isArray(session.events) ? session.events : []);
  function readEvent(seq) {
    if (!Number.isInteger(seq) || seq < 0) return null;
    const events = liveEvents();
    // Fast path: dense log indexed by seq, ACCEPTED ONLY when the resident
    // element proves seq identity. Slow path: full scan (sparse logs).
    const direct = events[seq];
    if (direct && typeof direct === 'object' && direct.seq === seq) return direct;
    for (const event of events) {
      if (event && typeof event === 'object' && event.seq === seq) return event;
    }
    return null;
  }
  function readEvents(seqs) {
    if (!Array.isArray(seqs)) failSession('context-rehydration-source-mismatch', 'seqs array is required');
    return seqs.map((seq) => readEvent(seq));
  }
  return Object.freeze({ kind: 'dsh-session-source', sessionId, readEvent, readEvents });
}

function isSessionExactSourceV2(value) {
  return Boolean(value && typeof value === 'object'
    && typeof value.sessionId === 'string' && value.sessionId !== ''
    && typeof value.readEvent === 'function' && typeof value.readEvents === 'function');
}

module.exports = {
  SESSION_EVIDENCE_DOMAIN_V1,
  SESSION_EVIDENCE_SCHEMA_VERSION,
  projectSessionEventV2,
  canonicalSessionEvidenceTextV2,
  deriveSessionEvidenceDigestV2,
  createMemorySessionSourceV2,
  wrapDshSessionV2,
  isSessionExactSourceV2,
};
