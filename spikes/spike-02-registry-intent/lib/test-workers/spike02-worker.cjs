'use strict';
// SPIKE-02 throwaway test worker — spawned as a SEPARATE OS process by
// tests/Spike02RegistryIntent.Tests.cjs for cross-process concurrency (F-03)
// and real process-termination crash tests (F-06). One invocation, one line
// of JSON on stdout (or a crash exit code), then exit.
// Usage: node spike02-worker.cjs '<JSON args>'
// Synthetic inputs only; operates exclusively on caller-supplied temp dirs.
const path = require('node:path');
const store = require('../controller-intent-store.cjs');
const kernel = require('../kernel-inbox-mock.cjs');

function out(doc) {
  process.stdout.write(JSON.stringify(doc) + '\n');
}

function main() {
  const args = JSON.parse(process.argv[2] || '{}');
  if (args.mode === 'commit') {
    try {
      const result = store.commitIntent(args.dataRoot, args.fields);
      out({ ok: true, created: result.created, attemptId: result.intent.attemptId });
    } catch (error) {
      out({ ok: false, code: (error && error.code) || 'unknown' });
    }
    return;
  }
  if (args.mode === 'acquire') {
    try {
      const lease = kernel.acquireGeneration(args.kernelRoot, { taskInstanceId: args.taskInstanceId, backend: args.backend }, { witnessRoot: args.witnessRoot || undefined });
      out({ ok: true, leaseEpoch: lease.leaseEpoch });
    } catch (error) {
      out({ ok: false, code: (error && error.code) || 'unknown' });
    }
    return;
  }
  if (args.mode === 'deliver') {
    try {
      const result = kernel.deliverCommand(args.kernelRoot, { intent: args.intent, issued: args.issued }, { witnessRoot: args.witnessRoot || undefined });
      out({ ok: true, created: result.created });
    } catch (error) {
      out({ ok: false, code: (error && error.code) || 'unknown' });
    }
    return;
  }
  if (args.mode === 'die-before-commit') {
    // Real process termination BEFORE any persistence write.
    process.exit(3);
  }
  if (args.mode === 'commit-no-ack') {
    // Commit durably, then die WITHOUT returning an acknowledgment.
    store.commitIntent(args.dataRoot, args.fields);
    process.exit(0);
  }
  if (args.mode === 'commit-loop') {
    // Commit many distinct commands; the parent SIGKILLs us mid-loop.
    for (let i = 0; i < args.count; i++) {
      const fields = { ...args.fields, commandId: args.prefix + i, attemptId: args.prefix + 'attempt-' + i };
      try { store.commitIntent(args.dataRoot, fields); } catch { /* conflict: ignore, keep looping */ }
    }
    out({ ok: true, done: true });
    return;
  }
  out({ ok: false, code: 'unknown-mode' });
}

main();
