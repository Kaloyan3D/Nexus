'use strict';
/**
 * ContextMemoryProducerHostV2.cjs - CCV2-M01 production producer wiring.
 *
 * The ONE production installation point for durable-memory production:
 * AihController.apply() calls installMemoryProducer(ctx, deps) and every
 * task-bound session then maintains <workspace>/.ai-harness/ccv2/<taskId>/
 * automatically (no script, no hand-written fixture, no manual pages).
 *
 * Per session a strictly serial queue drives ContextMemoryProducerV2:
 *   - ordinary events ingest SYNCHRONOUSLY inside the session/event
 *     listener, so a unit completed by a tool result is staged before the
 *     loop can issue the next root request;
 *   - turn/end (the only A06-safe boundary) waits for the DSH durability
 *     barrier (ctx.sessions.flush) and then seals with the observed
 *     durable seq; later events queue behind it, never reorder;
 *   - a session first seen mid-log (restart, pre-M01 session) bootstraps by
 *     replaying its canonical prefix through the same step (deterministic).
 * Never throws into the loop: a producer failure records a durable blocker
 * in producer state (hosts then skip/fall back) and logs once.
 *
 * Kill switch: NEXUS_CCV2_PRODUCER=off disables production (default on).
 */

const producerV2 = require('./ContextMemoryProducerV2.cjs');
const sessionSourceV2 = require('./ContextSessionEvidenceSourceV2.cjs');

const PRODUCER_ENV = 'NEXUS_CCV2_PRODUCER';
const installedCtxs = new WeakMap();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function producerEnabledV2(env) {
  const source = isPlainObject(env) ? env : process.env;
  const raw = String(source[PRODUCER_ENV] === undefined || source[PRODUCER_ENV] === null ? '' : source[PRODUCER_ENV]).trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

/**
 * Create the per-process producer registry. deps:
 *   bindingFor(sessionId) -> { workspace, taskId, taskInstanceId } | null
 *   flush(session)        -> Promise<boolean> (DSH durability barrier)
 *   log(record)           -> void
 *   authorityFor?(binding)-> controller authority reader (tests)
 */
function createProducerRegistryV2(deps) {
  const safeDeps = isPlainObject(deps) ? deps : {};
  const sessions = new Map();
  const log = typeof safeDeps.log === 'function' ? safeDeps.log : () => {};

  function entryFor(session) {
    const sessionId = session && typeof session.id === 'string' ? session.id : null;
    if (sessionId === null) return null;
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const binding = typeof safeDeps.bindingFor === 'function' ? safeDeps.bindingFor(sessionId) : null;
    if (!isPlainObject(binding) || typeof binding.workspace !== 'string' || typeof binding.taskId !== 'string'
      || typeof binding.taskInstanceId !== 'string' || binding.taskInstanceId === '') return null;
    let producer = null;
    try {
      producer = producerV2.openMemoryProducerV2({
        workspace: binding.workspace,
        namespace: {
          taskId: binding.taskId,
          taskInstanceId: binding.taskInstanceId,
          sessionId,
          workspaceId: binding.workspace,
          repositoryId: null,
          checkoutId: null,
        },
        controllerAuthority: typeof safeDeps.authorityFor === 'function'
          ? safeDeps.authorityFor(binding)
          : producerV2.controllerAuthorityReaderV2(binding.workspace, binding.taskId, binding.taskInstanceId),
      });
    } catch (error) {
      log({ event: 'ccv2-producer-open-failed', sessionId, taskId: binding.taskId, error: String(error && error.message).slice(0, 240) });
      const dead = { sessionId, session, producer: null, queue: [], busy: false, reported: true };
      sessions.set(sessionId, dead);
      return dead;
    }
    const entry = { sessionId, session, producer, queue: [], busy: false, reported: false, bootstrapped: false };
    sessions.set(sessionId, entry);
    return entry;
  }

  function liveEvents(entry) {
    return Array.isArray(entry.session.events) ? entry.session.events : [];
  }

  function ingestOptions(entry, durability) {
    return {
      eventsThrough: (seq) => liveEvents(entry).slice(0, seq + 1),
      eventAt: (seq) => liveEvents(entry)[seq],
      durability,
    };
  }

  function reportBlocker(entry) {
    const described = entry.producer.describe();
    if (described.blocker !== null && !entry.reported) {
      entry.reported = true;
      log({ event: 'ccv2-producer-blocked', sessionId: entry.sessionId, blocker: described.blocker });
    }
  }

  async function flushed(entry) {
    let participated = false;
    try {
      participated = typeof safeDeps.flush === 'function' ? (await safeDeps.flush(entry.session)) === true : false;
    } catch (error) {
      log({ event: 'ccv2-producer-flush-failed', sessionId: entry.sessionId, error: String(error && error.message).slice(0, 240) });
      participated = false;
    }
    return { flushedSeq: participated ? liveEvents(entry).length - 1 : null, flushParticipated: participated };
  }

  // Serial drain: synchronous for ordinary events, async only across a
  // durability barrier (bootstrap prefix or a turn/end seal).
  function drain(entry) {
    if (entry.busy || entry.producer === null) return;
    while (entry.queue.length > 0) {
      if (entry.producer.blocked()) {
        // Durable blocker: production stops for this session (fail closed).
        entry.queue.length = 0;
        return;
      }
      const next = entry.queue[0];
      const processed = entry.producer.processedThroughSeq();
      const needsBootstrap = next.seq > processed + 1;
      if (needsBootstrap || next.type === 'turn/end') {
        entry.busy = true;
        flushed(entry).then((durability) => {
          try {
            if (needsBootstrap) {
              const prefix = liveEvents(entry).slice(processed + 1, next.seq);
              entry.producer.ingest(prefix, ingestOptions(entry, durability));
            } else {
              entry.queue.shift();
              entry.producer.ingest([next], ingestOptions(entry, durability));
            }
            reportBlocker(entry);
          } catch (error) {
            log({ event: 'ccv2-producer-ingest-failed', sessionId: entry.sessionId, error: String(error && error.message).slice(0, 240) });
          } finally {
            entry.busy = false;
            drain(entry);
          }
        }, () => { entry.busy = false; });
        return;
      }
      const batch = [];
      while (entry.queue.length > 0 && entry.queue[0].type !== 'turn/end'
        && entry.queue[0].seq === entry.producer.processedThroughSeq() + 1 + batch.length) {
        batch.push(entry.queue.shift());
      }
      if (batch.length === 0) {
        // Out-of-order or already-processed event: drop duplicates only.
        if (entry.queue[0].seq <= entry.producer.processedThroughSeq()) { entry.queue.shift(); continue; }
        return;
      }
      try {
        entry.producer.ingest(batch, ingestOptions(entry, { flushedSeq: null, flushParticipated: false }));
        reportBlocker(entry);
      } catch (error) {
        log({ event: 'ccv2-producer-ingest-failed', sessionId: entry.sessionId, error: String(error && error.message).slice(0, 240) });
        return;
      }
    }
  }

  function onSessionEvent(session, event) {
    try {
      if (!isPlainObject(event) || !Number.isInteger(event.seq)) return;
      const entry = entryFor(session);
      if (entry === null || entry.producer === null) return;
      entry.session = session;
      entry.queue.push(event);
      drain(entry);
    } catch (error) {
      log({ event: 'ccv2-producer-event-failed', error: String(error && error.message).slice(0, 240) });
    }
  }

  /** Live B03 session exact source for hosts (null when unknown). */
  function sessionSourceFor(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry || !entry.session) return null;
    try {
      return sessionSourceV2.wrapDshSessionV2(entry.session);
    } catch {
      return null;
    }
  }

  /**
   * Read-only live-session accessor for the OpenCode projection's CCv2
   * RC1.1 activation gate. null when unknown. events() is a snapshot copy of
   * the durable event log (later appends never race a decision).
   */
  function liveSessionFor(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry || !entry.session) return null;
    return Object.freeze({ sessionId, events: () => liveEvents(entry).slice() });
  }

  /** Test/diagnostic hook: resolves when the session queue is idle. */
  async function idle(sessionId) {
    for (let spin = 0; spin < 10000; spin += 1) {
      const entry = sessions.get(sessionId);
      if (!entry || (!entry.busy && entry.queue.length === 0)) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  function describe(sessionId) {
    const entry = sessions.get(sessionId);
    return entry && entry.producer ? entry.producer.describe() : null;
  }

  return Object.freeze({ onSessionEvent, sessionSourceFor, liveSessionFor, idle, describe });
}

/**
 * Install the ONE production producer on ctx (session/event listener).
 * Returns { installed, registry } and never throws into startup.
 */
function installMemoryProducer(ctx, deps) {
  try {
    if (!ctx || typeof ctx.on !== 'function') return { installed: false, reason: 'no-hook-surface', registry: null };
    if (!producerEnabledV2(isPlainObject(deps) ? deps.env : undefined)) {
      return { installed: false, reason: 'producer-disabled', registry: null };
    }
    const safeDeps = isPlainObject(deps) ? deps : {};
    if (typeof safeDeps.bindingFor !== 'function') return { installed: false, reason: 'no-binding-source', registry: null };
    if (installedCtxs.has(ctx)) return { installed: true, reason: 'already-installed', registry: installedCtxs.get(ctx) };
    const registry = createProducerRegistryV2(safeDeps);
    ctx.on('session/event', (subject, event) => { registry.onSessionEvent(subject, event); });
    installedCtxs.set(ctx, registry);
    return { installed: true, reason: null, registry };
  } catch {
    return { installed: false, reason: 'install-failed', registry: null };
  }
}

module.exports = {
  PRODUCER_ENV,
  producerEnabledV2,
  createProducerRegistryV2,
  installMemoryProducer,
};
