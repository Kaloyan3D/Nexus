'use strict';

// Registry R5 - subscription and delegated connection descriptors.
// See docs/integration/claude-subscription-r5.md for the full contract.
//
// Three integrations, one rule: CLIs own every credential.
//  1. ChatGPT/Codex OAuth (EXISTING, reused): the third-party openai-oauth
//     package owns the PKCE flow, the loopback service and the
//     Codex-compatible auth file. Nexus owns only a non-secret Connection
//     record plus a live check. This is NOT the official Sign in with
//     ChatGPT delegation.
//  2. Claude Pro/Max subscription agent (NEW): the official Claude Code CLI
//     owns login/session/refresh via native login. Nexus never extracts
//     or copies Claude tokens: the hook surface exposes file METADATA
//     (exists/size/mtime) and CLI stdout only. No byte-read hook exists.
//  3. OpenCode Go API-key access (EXISTING): unchanged api-key record.

const SUBSCRIPTION_SCHEMA_VERSION = 1;

const CODEX_BUILTIN_PROVENANCE = 'r5-builtin-codex-oauth';
const CLAUDE_BUILTIN_PROVENANCE = 'r5-builtin-claude-subscription';

const CODEX_AUTH_METHOD = 'codex-oauth (third-party openai-oauth package: PKCE loopback flow, Codex-compatible auth file, local service on 127.0.0.1:10531; Nexus holds no token; NOT official Sign in with ChatGPT delegation)';
const CLAUDE_AUTH_METHOD = 'claude-cli-session (official Claude Code CLI native auth: claude auth login/status/logout; Pro/Max subscription verified via claude auth status JSON; Nexus never reads, exports or copies token bytes)';

const CODEX_PROVIDER_ID = 'sol-local';
const CODEX_CONNECTION_ID = 'conn-sol-local';
const CODEX_EXPECTED_MODEL = 'gpt-5.6-sol';

const CLAUDE_PROVIDER_ID = 'claude-code-subscription';
const CLAUDE_CONNECTION_ID = 'conn-claude-code-subscription';
const CLAUDE_MODEL_ID = 'claude-subscription-agent';
const CLAUDE_ROUTE_ID = 'claude-code-subscription/claude-subscription-agent';

const OPENCODE_PROVIDER_ID = 'opencode-go';
const OPENCODE_CONNECTION_ID = 'conn-opencode-go';

// --- Built-in specialization (ids/availability/enabled never change) ---
// Applied to legacy-derived records so the Registry describes the real
// substrate. Executability of existing sol-local / opencode-go routes is
// preserved exactly; only transport, access type, connection kind and the
// non-secret base URL become accurate.

const PROVIDER_SPECIALIZATIONS = Object.freeze({
  'sol-local': Object.freeze({
    transportId: 'local-openai-compatible',
    authType: 'local-server',
    baseUrl: 'http://127.0.0.1:10531/v1',
  }),
  'opencode-go': Object.freeze({
    transportId: 'openai-responses',
    authType: 'api-key',
    baseUrl: 'https://opencode.ai/zen/go/v1',
  }),
  'meta-model-api': Object.freeze({
    transportId: 'openai-chat-completions',
    authType: 'api-key',
    baseUrl: 'https://api.meta.ai/v1',
  }),
});

const CONNECTION_SPECIALIZATIONS = Object.freeze({
  'sol-local': Object.freeze({ connectionKind: 'subscription-delegated', authMethod: CODEX_AUTH_METHOD }),
  'opencode-go': Object.freeze({ connectionKind: 'api-key', authMethod: 'api-key (OPENCODE_API_KEY; OpenCode Go API billing, not a subscription)' }),
  'meta-model-api': Object.freeze({ connectionKind: 'api-key', authMethod: 'api-key (MODEL_API_KEY; Meta direct API billing, not a subscription)' }),
});

const ROUTE_SPECIALIZATIONS = Object.freeze({
  'sol-local': Object.freeze({ accessType: 'subscription-delegated', transport: 'local-openai-compatible' }),
  'opencode-go': Object.freeze({ accessType: 'api-key', transport: 'openai-responses' }),
  'meta-model-api': Object.freeze({ accessType: 'api-key', transport: 'openai-chat-completions' }),
});

function specializeBuiltinProvider(provider) {
  if (!provider || typeof provider.id !== 'string') return provider;
  const spec = PROVIDER_SPECIALIZATIONS[provider.id];
  if (!spec) return provider;
  const next = Object.assign({}, provider, spec);
  if (!next.name) next.name = provider.id;
  return next;
}

function specializeBuiltinConnection(connection) {
  if (!connection || typeof connection.providerId !== 'string') return connection;
  const spec = CONNECTION_SPECIALIZATIONS[connection.providerId];
  if (!spec) return connection;
  return Object.assign({}, connection, spec);
}

function specializeBuiltinRoute(route) {
  if (!route || typeof route.providerId !== 'string') return route;
  const spec = ROUTE_SPECIALIZATIONS[route.providerId];
  if (!spec) return route;
  const next = Object.assign({}, route, { accessType: spec.accessType });
  next.compatibility = Object.assign({}, route.compatibility || {}, { transport: spec.transport });
  return next;
}

// --- Claude subscription built-ins (synthesized, additive) ---

function claudeBuiltinRecords() {
  const provider = {
    schemaVersion: 1,
    id: CLAUDE_PROVIDER_ID,
    name: 'Claude Pro/Max (Claude Code subscription agent)',
    transportId: 'agent-sdk',
    status: 'enabled',
    authType: 'subscription-agent',
    metadata: {
      billingSource: 'claude-subscription',
      executionKind: 'agent-sdk',
      loginCommand: 'claude auth login',
      logoutCommand: 'claude auth logout',
      tokenHandling: 'nexus-never-handles-tokens',
    },
  };
  const model = {
    schemaVersion: 1,
    id: CLAUDE_MODEL_ID,
    vendor: 'Anthropic',
    displayName: 'Claude Subscription Agent (Pro/Max via Claude Code)',
    checkpoint: 'claude-code-cli-managed',
    capabilities: {
      textInput: true,
      imageInput: true,
      toolCalling: true,
      streaming: true,
      reasoning: true,
    },
    enabled: true,
    // Empty engine scope: eligible for NO orchestration engine in R5.
    // Engineering-mode execution integration is pending R6 controller work;
    // R5 ships the connection plus adapter contracts only.
    engines: [],
  };
  const connection = {
    schemaVersion: 1,
    id: CLAUDE_CONNECTION_ID,
    providerId: CLAUDE_PROVIDER_ID,
    connectionKind: 'subscription-agent',
    authMethod: CLAUDE_AUTH_METHOD,
    credentialRef: 'credential://connections/' + CLAUDE_CONNECTION_ID,
    status: 'unknown',
    provenance: CLAUDE_BUILTIN_PROVENANCE,
  };
  const route = {
    schemaVersion: 1,
    id: CLAUDE_ROUTE_ID,
    providerId: CLAUDE_PROVIDER_ID,
    logicalModelId: CLAUDE_MODEL_ID,
    remoteModelId: 'claude-code-cli-managed',
    accessType: 'subscription-agent',
    connectionId: CLAUDE_CONNECTION_ID,
    executionKind: 'agent-sdk',
    // The CLI manages model/reasoning selection internally; Nexus records a
    // single opaque level so the route shape stays valid without inventing
    // a reasoning contract the subscription path does not expose.
    reasoningLevels: ['managed'],
    compatibility: {
      transport: 'agent-sdk',
      toolRoundTrip: 'agent-managed',
      streaming: 'agent-managed',
      vision: 'declared',
    },
    availability: 'auth-required',
    enabled: true,
    provenance: CLAUDE_BUILTIN_PROVENANCE,
  };
  return { provider, model, connection, route };
}

// Append-only merge of the Claude built-ins into a canonical snapshot.
// Idempotent: existing Claude ids are left untouched (never duplicated,
// never overwritten), so repeated merges and operator overlays stay stable.
function appendClaudeBuiltins(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { snapshot, added: [] };
  const built = claudeBuiltinRecords();
  const added = [];
  function has(list, id) {
    return Array.isArray(list) && list.some((e) => e && e.id === id);
  }
  const next = {
    schemaVersion: snapshot.schemaVersion,
    modes: snapshot.modes,
    models: Array.isArray(snapshot.models) ? snapshot.models.slice() : [],
    providers: Array.isArray(snapshot.providers) ? snapshot.providers.slice() : [],
    routes: Array.isArray(snapshot.routes) ? snapshot.routes.slice() : [],
    connections: Array.isArray(snapshot.connections) ? snapshot.connections.slice() : [],
  };
  if (!has(next.providers, built.provider.id)) { next.providers.push(built.provider); added.push(built.provider.id); }
  if (!has(next.models, built.model.id)) { next.models.push(built.model); added.push(built.model.id); }
  if (!has(next.connections, built.connection.id)) { next.connections.push(built.connection); added.push(built.connection.id); }
  if (!has(next.routes, built.route.id)) { next.routes.push(built.route); added.push(built.route.id); }
  return { snapshot: next, added };
}

// --- Secret hygiene ---
// SECRET_SHAPE matches the R4 probe redaction set plus JWT-shaped tokens.
// Every live-check result and every adapter event is scanned before return.

const SECRET_SHAPE = /sk-(live|proj|svcacct)-[A-Za-z0-9._-]+|sk-ant-[A-Za-z0-9._-]+|xox[bap]-[A-Za-z0-9-]+|gh[pous]_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

function assertNoSecrets(value, where) {
  let text = null;
  try { text = JSON.stringify(value); } catch (e) { return [{ code: 'secret-scan-failed', path: where, message: 'value is not JSON-serializable; withheld' }]; }
  if (typeof text === 'string' && SECRET_SHAPE.test(text)) {
    return [{ code: 'secret-material-rejected', path: where, message: 'secret-shaped material detected; value withheld' }];
  }
  return [];
}

// --- Hook surface (injected seams; defaults use node builtins) ---
// Deliberately narrow: statMeta returns METADATA ONLY ({ exists, size,
// mtimeMs } or null); there is no byte-read hook, so token content cannot
// be pulled into Nexus by construction. execFile runs a bounded CLI process
// and returns { code, stdout, stderr } (output is scanned on return).

function defaultHooks() {
  const fs = require('node:fs');
  const cp = require('node:child_process');
  return {
    statMeta(p) {
      try {
        const st = fs.statSync(p);
        return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
      } catch (e) { return null; }
    },
    execEnv() {
      try { return Object.assign({}, process.env); } catch (e) { return null; }
    },
    execFile(cmd, args, opts) {
      const timeoutMs = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 15000;
      return new Promise((resolve) => {
        let settled = false;
        const done = (result) => { if (!settled) { settled = true; resolve(result); } };
        let child = null;
        try {
          child = cp.execFile(cmd, args || [], { timeout: timeoutMs, maxBuffer: 262144, windowsHide: true }, (error, stdout, stderr) => {
            done({ code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0), stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!(error && error.killed) });
          });
        } catch (e) {
          done({ code: 1, stdout: '', stderr: String((e && e.message) || e), spawnFailed: true });
          return;
        }
        if (opts && opts.signal) {
          if (opts.signal.aborted) { try { child.kill(); } catch (e2) {} done({ code: 1, stdout: '', stderr: 'cancelled', cancelled: true }); return; }
          opts.signal.addEventListener('abort', () => { try { child.kill(); } catch (e3) {} done({ code: 1, stdout: '', stderr: 'cancelled', cancelled: true }); }, { once: true });
        }
      });
    },
    fetchJson(url, opts) {
      const timeoutMs = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 8000;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const waiter = opts && opts.signal ? () => ctrl.abort() : null;
      if (waiter && opts.signal) opts.signal.addEventListener('abort', waiter, { once: true });
      return fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } }).then(
        (res) => res.text().then((text) => {
          let body = null;
          try { body = JSON.parse(text); } catch (e) { body = null; }
          return { status: res.status, body };
        }),
        (e) => ({ status: 0, error: String((e && e.name === 'AbortError') ? 'timeout-or-cancelled' : ((e && e.message) || e)) })
      ).finally(() => {
        clearTimeout(timer);
        if (waiter && opts && opts.signal) { try { opts.signal.removeEventListener('abort', waiter); } catch (e) {} }
      });
    },
  };
}

function codexAuthPath(userHome, env) {
  if (env && typeof env.CODEX_HOME === 'string' && env.CODEX_HOME !== '') return env.CODEX_HOME + '/auth.json';
  return (userHome || '') + '/.codex/auth.json';
}

function claudeCredentialsMetaPath(userHome) {
  return (userHome || '') + '/.claude/.credentials.json';
}

function err(code, p, message) {
  return { code, path: p, message };
}

// --- Live checks (bounded, cancellable, non-secret) ---
// checkCodexConnection stats the auth file (metadata only) and lists the
// local /models endpoint. It never reads the auth file and never starts
// the OAuth service (owned by the launcher and Set-OpenAiOAuth.ps1).

async function checkCodexConnection(input) {
  const o = input || {};
  const hooks = o.hooks || defaultHooks();
  const errors = [];
  const authPath = codexAuthPath(o.userHome, o.env);
  let authMeta = null;
  try { authMeta = hooks.statMeta(authPath); } catch (e) { authMeta = null; }
  const authFilePresent = !!(authMeta && authMeta.exists && authMeta.size > 0);
  if (!authFilePresent) errors.push(err('codex-auth-missing', 'connection.conn-sol-local', 'Codex auth file is absent or empty; complete the ChatGPT/Codex OAuth login (third-party Codex flow, NOT official Sign in with ChatGPT)'));
  let models = [];
  let serviceReachable = false;
  const baseUrl = typeof o.oauthBaseUrl === 'string' && o.oauthBaseUrl !== '' ? o.oauthBaseUrl : 'http://127.0.0.1:10531/v1';
  try {
    const modelsUrl = baseUrl.replace(/\/+$/, '') + '/models';
    const res = await hooks.fetchJson(modelsUrl, { timeoutMs: o.timeoutMs, signal: o.signal });
    if (res && res.status === 200 && res.body && Array.isArray(res.body.data)) {
      serviceReachable = true;
      models = res.body.data.map((m) => (m && m.id)).filter((id) => typeof id === 'string');
    } else {
      errors.push(err('codex-service-unreachable', 'connection.conn-sol-local', 'local Codex OAuth service did not return a model list (status ' + String(res && res.status) + '); start it via the Nexus launcher'));
    }
  } catch (e) {
    errors.push(err('codex-service-unreachable', 'connection.conn-sol-local', 'local Codex OAuth service check failed: ' + String((e && e.message) || e)));
  }
  const modelAvailable = models.indexOf(CODEX_EXPECTED_MODEL) !== -1;
  if (serviceReachable && !modelAvailable) {
    errors.push(err('codex-model-unavailable', 'connection.conn-sol-local', CODEX_EXPECTED_MODEL + ' is not advertised for this account'));
  }
  const connected = authFilePresent && serviceReachable && modelAvailable;
  const status = connected ? 'connected' : ((authFilePresent || serviceReachable) ? 'unknown' : 'not-connected');
  const detail = {
    connectionId: CODEX_CONNECTION_ID,
    providerId: CODEX_PROVIDER_ID,
    status,
    authFilePresent,
    authFileSize: authMeta && typeof authMeta.size === 'number' ? authMeta.size : null,
    serviceReachable,
    modelAvailable,
    models: models.slice(0, 50),
    billingSource: 'chatgpt-codex-subscription (user-owned ChatGPT account via third-party Codex OAuth)',
    authMethod: CODEX_AUTH_METHOD,
  };
  return { ok: connected, status, detail, errors: errors.concat(assertNoSecrets(detail, 'connection.conn-sol-local')) };
}

// --- R5.1 native authentication (claude auth status) ---
// Primary machine-readable source for the Claude connection. The CLI owns
// credential storage on every OS; Nexus parses the bounded JSON status with
// strict validation and never reads, exports or copies credential bytes.
// Classification is conservative: only an explicit subscription signal
// reports connected. Anything ambiguous is unknown (never eligible).
const CLAUDE_AUTH_STATUS_MAX_BYTES = 65536;

function buildClaudeAuthArgv(action) {
  if (action === 'login') return ['auth', 'login'];
  if (action === 'logout') return ['auth', 'logout'];
  return ['auth', 'status'];
}

function safeStatusLabel(value, maxLen) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t === '') return null;
  return t.slice(0, maxLen > 0 ? maxLen : 80);
}

function nativeMethodLabel(doc) {
  const fields = [doc.authMethod, doc.auth_method, doc.method, doc.type, doc.provider, doc.kind];
  for (const c of fields) { const l = safeStatusLabel(c, 80); if (l) return l; }
  return null;
}

function nativeSubscriptionType(doc) {
  return safeStatusLabel(doc.subscriptionType, 40);
}

function parseClaudeAuthStatus(stdout) {
  const where = 'connection.' + CLAUDE_CONNECTION_ID;
  const text = String(stdout === undefined || stdout === null ? '' : stdout);
  if (text.length > CLAUDE_AUTH_STATUS_MAX_BYTES) {
    return { outcome: 'unknown', authState: 'unparseable', errors: [err('claude-status-oversize', where, 'auth status output exceeded the bounded budget; withheld')] };
  }
  let doc = null;
  try { doc = JSON.parse(text); } catch (e) {
    return { outcome: 'unknown', authState: 'unparseable', errors: [err('claude-status-unparseable', where, 'auth status did not return strict JSON; refusing to infer authentication')] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { outcome: 'unknown', authState: 'unparseable', errors: [err('claude-status-unparseable', where, 'auth status JSON must be an object; refusing to infer authentication')] };
  }
  const secretHit = assertNoSecrets(doc, where);
  if (secretHit.length > 0) {
    return { outcome: 'unknown', authState: 'withheld', errors: [err('secret-material-rejected', where, 'auth status carried secret-shaped material; withheld, never stored')] };
  }
  const statusLabel = safeStatusLabel(doc.status, 40);
  const statusNorm = statusLabel ? statusLabel.toLowerCase() : '';
  if (doc.loggedIn === false || doc.authenticated === false) {
    return { outcome: 'unauthenticated', authState: 'not-logged-in', errors: [err('claude-session-missing', where, 'CLI reports no login; connect with the native login (claude auth login) - Nexus never handles the token')] };
  }
  if (statusNorm === 'expired' || statusNorm === 'invalid' || statusNorm === 'revoked' || doc.expired === true) {
    const revoked = statusNorm === 'revoked';
    return { outcome: 'expired', authState: revoked ? 'revoked' : 'expired', errors: [err(revoked ? 'claude-session-revoked' : 'claude-session-expired', where, 'CLI reports an expired, revoked or invalid login; reconnect with the native login (claude auth login)')] };
  }
  const methodLabel = nativeMethodLabel(doc);
  const methodNorm = methodLabel ? methodLabel.toLowerCase() : '';
  if (methodNorm === 'none') {
    return { outcome: 'unauthenticated', authState: 'not-logged-in', errors: [err('claude-session-missing', where, 'CLI reports no authentication method; connect with the native login (claude auth login)')] };
  }
  if (methodNorm === 'api_key' || methodNorm === 'api-key' || methodNorm === 'api_key_helper' || methodNorm === 'api-key-helper' || /api[-_ ]?key|access[-_ ]?token|bearer|personal[-_ ]?token|setup[-_ ]?token/.test(methodNorm)) {
    return { outcome: 'api-key', authState: 'api-key-identity', method: methodLabel, errors: [err('claude-apikey-identity', where, 'CLI reports a key-based identity (' + String(methodLabel || 'unlabeled') + '); subscription billing is not established, so this connection is not eligible')] };
  }
  if (methodNorm === 'third_party' || methodNorm === 'third-party' || /bedrock|vertex|proxy|custom|endpoint|gateway|byok/.test(methodNorm)) {
    return { outcome: 'alternate', authState: 'alternate-provider-identity', method: methodLabel, errors: [err('claude-alternate-identity', where, 'CLI reports a non-subscription provider identity (' + String(methodLabel || 'unlabeled') + '); subscription billing is not established, so this connection is not eligible')] };
  }
  const subTypeLabel = nativeSubscriptionType(doc);
  const subTypeHit = subTypeLabel ? /^(pro|max|plus|team|enterprise|business|subscriber)$/i.test(subTypeLabel) : false;
  if ((methodNorm === 'claude.ai' || methodNorm === 'claude_ai' || methodNorm === 'claudeai') && doc.loggedIn === true) {
    return { outcome: 'subscription', authState: 'subscription-confirmed', method: methodLabel, errors: [] };
  }
  if (subTypeHit && doc.loggedIn !== false) {
    return { outcome: 'subscription', authState: 'subscription-confirmed', method: methodLabel, errors: [] };
  }
  const apiProviderLabel = safeStatusLabel(doc.apiProvider, 40);
  if (apiProviderLabel && /bedrock|vertex|proxy|custom|endpoint|gateway|byok|third/.test(apiProviderLabel.toLowerCase())) {
    return { outcome: 'alternate', authState: 'alternate-provider-identity', method: methodLabel, errors: [err('claude-alternate-identity', where, 'CLI reports alternate hosted routing (' + String(apiProviderLabel) + '); subscription billing is not established, so this connection is not eligible')] };
  }
  if (doc.loggedIn === true || doc.authenticated === true) {
    return { outcome: 'unknown', authState: 'source-unestablished', method: methodLabel, errors: [err('claude-auth-source-unknown', where, 'CLI reports an authenticated session but no recognizable subscription signal; refusing to infer billing source')] };
  }
  return { outcome: 'unknown', authState: 'source-unestablished', method: methodLabel, errors: [err('claude-auth-source-unknown', where, 'auth status is ambiguous; refusing to infer authentication or billing source')] };
}

// --- R5.1 billing source resolution (actual child-process environment) ---
// Audited Claude Code credential precedence (highest billing impact first):
// explicit API keys/tokens, custom endpoints, cloud-provider routing
// (Bedrock/Vertex), then the native CLI subscription session. The adapter
// inspects the REAL spawn environment via hooks.execEnv() (default: a live
// process.env snapshot taken in the spawning host) - never an unrelated
// caller-provided object. When no environment can be established the
// adapter fails closed. Stored user credentials are never read, cleared
// or modified by any path here.
const BILLING_OVERRIDE_SOURCES = [
  { key: 'ANTHROPIC_API_KEY', kind: 'api-key' },
  { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'api-key' },
  { key: 'ANTHROPIC_BASE_URL', kind: 'custom-endpoint' },
  { key: 'ANTHROPIC_BEDROCK_BASE_URL', kind: 'bedrock' },
  { key: 'CLAUDE_CODE_USE_BEDROCK', kind: 'bedrock' },
  { key: 'CLAUDE_CODE_USE_VERTEX', kind: 'vertex' },
];

function billingOverrideActive(kind, rawValue) {
  const v = String(rawValue === undefined || rawValue === null ? '' : rawValue).trim();
  if (v === '') return false;
  if (kind === 'bedrock' || kind === 'vertex') {
    const low = v.toLowerCase();
    if (low === '1' || low === 'true' || low === 'yes') return true;
    return v.indexOf('http') === 0 || v.indexOf('/') !== -1;
  }
  return true;
}

function resolveBillingEnv(envInput) {
  if (!envInput || typeof envInput !== 'object' || Array.isArray(envInput)) {
    return { ok: false, sources: [], errors: [err('billing-unverifiable', 'claude.execution', 'no execution environment is available, so the billing source cannot be established; refusing to run')] };
  }
  const sources = [];
  for (const spec of BILLING_OVERRIDE_SOURCES) {
    let present = false;
    try { present = billingOverrideActive(spec.kind, envInput[spec.key]); } catch (e) { present = false; }
    if (present) sources.push({ key: spec.key, kind: spec.kind });
  }
  return { ok: true, sources, errors: [] };
}

function checkBillingSeparation(envInput, opts) {
  const resolved = resolveBillingEnv(envInput);
  if (!resolved.ok) return { ok: false, billingSource: null, envSource: null, errors: resolved.errors };
  const o = opts || {};
  const blocking = [];
  for (const s of resolved.sources) {
    if ((s.kind === 'api-key' || s.kind === 'custom-endpoint') && o.allowApiBilling !== true) blocking.push(s);
    else if ((s.kind === 'bedrock' || s.kind === 'vertex') && o.allowAlternateProvider !== true) blocking.push(s);
  }
  if (blocking.length > 0) {
    const names = blocking.map((s) => s.key + ':' + s.kind).join(', ');
    return { ok: false, billingSource: null, envSource: null, errors: [err('billing-boundary', 'claude.execution', 'non-subscription billing sources are active (' + names + '). Subscription-agent execution would silently inherit them. Unset them or pass an explicit per-call opt-in (allowApiBilling for key/endpoint sources, allowAlternateProvider for Bedrock/Vertex); refusing to proceed')] };
  }
  if (resolved.sources.length === 0) return { ok: true, billingSource: 'claude-subscription', envSource: null, errors: [] };
  const onlyApi = resolved.sources.every((s) => s.kind === 'api-key' || s.kind === 'custom-endpoint');
  return { ok: true, billingSource: onlyApi ? 'anthropic-api (explicit opt-in)' : 'alternate-provider (explicit opt-in)', envSource: null, errors: [] };
}

// checkClaudeConnection (R5.1): CLI presence via --version, authentication
// via the native auth status command (JSON output is the documented CLI
// observed as SUPPLEMENTARY metadata only: a stale file never reports
// connected, and a valid login without the assumed file still connects.
// connected requires an explicit subscription outcome from the CLI.
async function checkClaudeConnection(input) {
  const o = input || {};
  const hooks = o.hooks || defaultHooks();
  const where = 'connection.' + CLAUDE_CONNECTION_ID;
  const errors = [];
  let installed = false;
  let version = null;
  try {
    const res = await hooks.execFile(o.claudeBin || 'claude', ['--version'], { timeoutMs: o.timeoutMs || 15000, signal: o.signal });
    if (res && !res.cancelled && typeof res.stdout === 'string') {
      const text = (res.stdout + ' ' + (res.stderr || '')).trim();
      if (res.code === 0 && /claude/i.test(text)) { installed = true; version = text.split('\n')[0].slice(0, 120); }
      else if (res.code !== 0 && text === '') errors.push(err('claude-cli-missing', where, 'Claude Code CLI is not installed or not on PATH (install the official CLI, then run: claude auth login)'));
      else errors.push(err('claude-cli-unusable', where, 'claude --version did not report a usable CLI'));
    } else if (res && res.cancelled) {
      errors.push(err('probe-cancelled', where, 'Claude CLI check cancelled by the caller'));
    } else {
      errors.push(err('claude-cli-missing', where, 'Claude Code CLI is not installed or not on PATH (install the official CLI, then run: claude auth login)'));
    }
  } catch (e) {
    errors.push(err('claude-cli-missing', where, 'Claude Code CLI probe failed: ' + String((e && e.message) || e)));
  }
  let authOutcome = 'skipped';
  let authState = installed ? 'unchecked' : 'cli-missing';
  let authMethod = null;
  if (installed) {
    try {
      const res = await hooks.execFile(o.claudeBin || 'claude', buildClaudeAuthArgv('status'), { timeoutMs: o.timeoutMs || 15000, signal: o.signal });
      if (res && res.cancelled) {
        errors.push(err('probe-cancelled', where, 'Claude auth status check cancelled by the caller'));
        authOutcome = 'unknown';
        authState = 'cancelled';
      } else if (!res || res.code !== 0) {
        authOutcome = 'unknown';
        authState = 'status-unavailable';
        errors.push(err('claude-status-unavailable', where, 'native auth status exited with code ' + String(res && res.code) + '; refusing to infer authentication'));
      } else {
        const parsed = parseClaudeAuthStatus(res.stdout);
        authOutcome = parsed.outcome;
        authState = parsed.authState;
        authMethod = parsed.method || null;
        for (const e of parsed.errors) errors.push(e);
      }
    } catch (e) {
      authOutcome = 'unknown';
      authState = 'status-unavailable';
      errors.push(err('claude-status-unavailable', where, 'native auth status probe failed: ' + String((e && e.message) || e)));
    }
  }
  let sessionFileObserved = false;
  let sessionFileSize = null;
  if (o.userHome) {
    try {
      const meta = hooks.statMeta(claudeCredentialsMetaPath(o.userHome));
      sessionFileObserved = !!(meta && meta.exists && meta.size > 0);
      sessionFileSize = meta && typeof meta.size === 'number' ? meta.size : null;
    } catch (e) { sessionFileObserved = false; }
  }
  const connected = installed && authOutcome === 'subscription';
  let status = 'not-connected';
  if (connected) status = 'connected';
  else if (authState === 'revoked') status = 'revoked';
  else if (installed) status = 'unknown';
  const detail = {
    connectionId: CLAUDE_CONNECTION_ID,
    providerId: CLAUDE_PROVIDER_ID,
    status,
    installed,
    version,
    authState,
    authMethod,
    authSource: installed ? 'native-cli-status (claude auth status, JSON by default)' : null,
    sessionFileObserved,
    sessionFileSize,
    billingSource: connected ? 'claude-subscription (Pro/Max account verified via native CLI auth status; never Anthropic API billing)' : null,
    authMethodNote: CLAUDE_AUTH_METHOD,
  };
  return { ok: connected, status, detail, errors: errors.concat(assertNoSecrets(detail, where)) };
}

// discoverClaudeCapabilities: model hints through the native interface where
// possible (claude --help; no billing, no prompt consumed). Always returns
// the declared agent capability set with honest provenance - never an
// invented OpenAI-compatible model list.

async function discoverClaudeCapabilities(input) {
  const o = input || {};
  const hooks = o.hooks || defaultHooks();
  let modelHints = [];
  let helpAvailable = false;
  try {
    const res = await hooks.execFile(o.claudeBin || 'claude', ['--help'], { timeoutMs: o.timeoutMs || 15000, signal: o.signal });
    if (res && res.code === 0 && typeof res.stdout === 'string' && res.stdout !== '') {
      helpAvailable = true;
      const text = res.stdout.slice(0, 16384);
      const seg = /--model[^\n]*\n([\s\S]{0,600})/.exec(text);
      if (seg) {
        const quoted = seg[0].match(/["'][a-z0-9][a-z0-9._-]*["']/gi) || [];
        const seen = {};
        for (const q of quoted) {
          const name = q.replace(/["']/g, '');
          if (!seen[name]) { seen[name] = true; modelHints.push(name); }
        }
        modelHints = modelHints.slice(0, 20);
      }
    }
  } catch (e) { helpAvailable = false; }
  const capabilities = {
    providerId: CLAUDE_PROVIDER_ID,
    connectionId: CLAUDE_CONNECTION_ID,
    executionKind: 'agent-sdk',
    billingSource: 'claude-subscription',
    models: modelHints,
    modelProvenance: modelHints.length > 0 ? 'cli-help-hints' : 'undeclared (the CLI selects the subscription model; no compatible raw-model list is invented)',
    agentCapabilities: {
      boundedRequests: true,
      cancellation: true,
      streaming: 'stream-json events',
      structuredResults: true,
      sessionContinuity: 'resume-id passthrough',
      workingDirectory: 'caller-provided cwd',
    },
    helpAvailable,
    engineeringMode: 'pending-r6 (connection plus adapter contracts only; not an EM orchestrator in R5)',
  };
  return { ok: true, capabilities, errors: assertNoSecrets(capabilities, 'connection.' + CLAUDE_CONNECTION_ID) };
}

// --- Billing guard ---
// Subscription-agent execution must never silently bill the Anthropic API:
// when ANTHROPIC_API_KEY is present the SDK/CLI may prefer API billing, so
// the adapter fails closed unless the caller explicitly passes
// allowApiBilling true (an auditable, per-call opt-in; never the default).


// --- Narrow Claude execution adapter ---
// Builds the supported CLI contract (print with stream-json output) with
// bounded time, caller cancellation, session continuity (resume id
// passthrough) and structured results tagged with the caller task identity.
// The spawn function is injected (tests use fakes). Stream-json events are
// framed line-delimited; oversized or secret-shaped payloads fail closed.
//
// Declared CLI surface (public Anthropic docs; live verification status is
// recorded in docs/integration/claude-subscription-r5.md):
//   claude --print <prompt> --output-format stream-json --max-turns N
//     [--model m] [--system-prompt s] [--resume id]
//     [--permission-mode plan|acceptEdits] [--allowedTools a,b]

const CLAUDE_MAX_TURNS_DEFAULT = 10;
const CLAUDE_TIMEOUT_MS_DEFAULT = 120000;
const CLAUDE_MAX_EVENT_BYTES = 1048576;
const CLAUDE_MAX_EVENTS = 500;

function buildClaudeArgv(task) {
  const t = task || {};
  const argv = ['--print', String(t.prompt || ''), '--output-format', 'stream-json', '--max-turns', String(Number.isInteger(t.maxTurns) ? t.maxTurns : CLAUDE_MAX_TURNS_DEFAULT)];
  if (typeof t.model === 'string' && t.model !== '') argv.push('--model', t.model);
  if (typeof t.systemPrompt === 'string' && t.systemPrompt !== '') argv.push('--system-prompt', t.systemPrompt);
  if (typeof t.resumeSessionId === 'string' && t.resumeSessionId !== '') argv.push('--resume', t.resumeSessionId);
  if (t.permissionMode === 'plan' || t.permissionMode === 'acceptEdits') argv.push('--permission-mode', t.permissionMode);
  if (Array.isArray(t.allowedTools) && t.allowedTools.length > 0) argv.push('--allowedTools', t.allowedTools.join(','));
  return argv;
}

function parseClaudeStreamEvents(text, taskId) {
  const events = [];
  const errors = [];
  let bytes = 0;
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    bytes += line.length;
    if (bytes > CLAUDE_MAX_EVENT_BYTES) {
      errors.push(err('claude-output-bounded', 'claude.execution', 'CLI output exceeded the bounded event budget; truncated'));
      break;
    }
    let evt = null;
    try { evt = JSON.parse(trimmed); } catch (e) { errors.push(err('claude-event-malformed', 'claude.execution', 'skipping one malformed stream-json line')); continue; }
    const secretHit = assertNoSecrets(evt, 'claude.execution');
    if (secretHit.length > 0) { errors.push(secretHit[0]); continue; }
    events.push({ taskId: taskId || null, event: evt });
    if (events.length >= CLAUDE_MAX_EVENTS) { errors.push(err('claude-output-bounded', 'claude.execution', 'event count exceeded the bounded budget; truncated')); break; }
  }
  let sessionId = null;
  for (const e of events) {
    const inner = e && e.event;
    if (inner && (typeof inner.session_id === 'string' || typeof inner.sessionId === 'string')) { sessionId = inner.session_id || inner.sessionId; break; }
  }
  return { events, sessionId, errors };
}

async function runClaudeAgent(task, deps) {
  const d = deps || {};
  const hooks = d.hooks || defaultHooks();
  let billingEnv = null;
  let billingEnvSource = 'unavailable';
  if (hooks.execEnv) { try { billingEnv = hooks.execEnv(); billingEnvSource = 'child-process'; } catch (e) { billingEnv = null; } }
  if (!billingEnv && d.env) { billingEnv = d.env; billingEnvSource = 'caller-provided'; }
  const billing = checkBillingSeparation(billingEnv, { allowApiBilling: d.allowApiBilling === true, allowAlternateProvider: d.allowAlternateProvider === true });
  if (!billing.ok) return { ok: false, events: [], errors: billing.errors };
  if (!task || typeof task.prompt !== 'string' || task.prompt.trim() === '') {
    return { ok: false, events: [], errors: [err('claude-prompt-required', 'claude.execution', 'a non-empty prompt is required')] };
  }
  if (typeof hooks.spawnEvents !== 'function') {
    return { ok: false, events: [], errors: [err('claude-spawn-unavailable', 'claude.execution', 'no process-spawn hook is available in this host; execution requires the Nexus-owned CLI adapter host')] };
  }
  const argv = buildClaudeArgv(task);
  let outcome = null;
  try {
    outcome = await hooks.spawnEvents(d.claudeBin || 'claude', argv, {
      cwd: task.cwd,
      timeoutMs: Number.isInteger(d.timeoutMs) ? d.timeoutMs : CLAUDE_TIMEOUT_MS_DEFAULT,
      signal: d.signal,
    });
  } catch (e) {
    return { ok: false, events: [], errors: [err('claude-spawn-failed', 'claude.execution', 'CLI spawn failed: ' + String((e && e.message) || e))] };
  }
  if (!outcome) return { ok: false, events: [], errors: [err('claude-spawn-failed', 'claude.execution', 'CLI spawn returned no outcome')] };
  if (outcome.cancelled) return { ok: false, events: [], errors: [err('claude-cancelled', 'claude.execution', 'Claude execution cancelled by the caller')] };
  if (outcome.timedOut) return { ok: false, events: [], errors: [err('claude-timeout', 'claude.execution', 'Claude execution exceeded its bounded time budget')] };
  if (outcome.code !== 0) {
    return { ok: false, events: [], errors: [err('claude-exit-' + String(outcome.code), 'claude.execution', 'CLI exited with code ' + String(outcome.code) + ': ' + String(outcome.stderr || '').slice(0, 500))] };
  }
  const parsed = parseClaudeStreamEvents(outcome.stdout, task.taskId);
  return { ok: parsed.errors.length === 0, events: parsed.events, sessionId: parsed.sessionId, billingSource: billing.billingSource, billingEnvSource, errors: parsed.errors };
}

// --- Unified Connections presentation (non-secret, UI-facing) ---

function describeConnection(connectionId) {
  const base = {
    id: connectionId,
    connectKind: 'manual',
    connectCommand: null,
    disconnectCommand: null,
    supportsCheck: false,
    supportsDiscover: false,
    billingSource: 'unknown',
    executionKinds: [],
    accountSource: 'unknown',
    capabilitiesNote: null,
  };
  if (connectionId === CODEX_CONNECTION_ID) {
    return Object.assign(base, {
      connectKind: 'terminal-oauth',
      connectCommand: 'powershell -File scripts/Set-OpenAiOAuth.ps1 (third-party Codex OAuth; prints a URL to open in your browser)',
      disconnectCommand: null,
      supportsCheck: true,
      supportsDiscover: true,
      billingSource: 'chatgpt-codex-subscription',
      executionKinds: ['raw-model'],
      accountSource: 'user-owned ChatGPT account (Codex-compatible auth file; Nexus holds no token)',
      capabilitiesNote: 'Existing third-party Codex OAuth integration - NOT the official Sign in with ChatGPT delegation. Model gpt-5.6-sol via the local OAuth service.',
    });
  }
  if (connectionId === CLAUDE_CONNECTION_ID) {
    return Object.assign(base, {
      connectKind: 'terminal-login',
      connectCommand: 'claude auth login (official Claude Code CLI native login for Pro/Max; Nexus never handles the token)',
      disconnectCommand: 'claude auth logout',
      supportsCheck: true,
      supportsDiscover: true,
      billingSource: 'claude-subscription',
      executionKinds: ['agent-sdk'],
      accountSource: 'Claude Pro/Max account via native CLI session (never Anthropic API billing unless explicitly opted in per call)',
      capabilitiesNote: 'Subscription agent execution (bounded requests, cancellation, stream-json streaming, resume-id continuity). EM-orchestrator role pending R6.',
    });
  }
  if (connectionId === OPENCODE_CONNECTION_ID) {
    return Object.assign(base, {
      connectKind: 'api-key',
      connectCommand: null,
      disconnectCommand: null,
      // No server-side credential boundary exists in R5 (R4.3 blocker
      // stands): live checks stay credential-gated through the Models and
      // Providers probe endpoints with an explicit offline credential.
      supportsCheck: false,
      supportsDiscover: false,
      billingSource: 'opencode-api-key',
      executionKinds: ['raw-model'],
      accountSource: 'operator OPENCODE_API_KEY (OpenCode Go API billing)',
      capabilitiesNote: 'Existing OpenCode Go API-key access over the Responses transport. Live verification is credential-gated (R4 probe endpoints, offline credential only).',
    });
  }
  return base;
}

module.exports = {
  SUBSCRIPTION_SCHEMA_VERSION,
  CODEX_BUILTIN_PROVENANCE,
  CLAUDE_BUILTIN_PROVENANCE,
  CODEX_AUTH_METHOD,
  CLAUDE_AUTH_METHOD,
  CODEX_PROVIDER_ID,
  CODEX_CONNECTION_ID,
  CODEX_EXPECTED_MODEL,
  CLAUDE_PROVIDER_ID,
  CLAUDE_CONNECTION_ID,
  CLAUDE_MODEL_ID,
  CLAUDE_ROUTE_ID,
  OPENCODE_PROVIDER_ID,
  OPENCODE_CONNECTION_ID,
  PROVIDER_SPECIALIZATIONS,
  CONNECTION_SPECIALIZATIONS,
  ROUTE_SPECIALIZATIONS,
  specializeBuiltinProvider,
  specializeBuiltinConnection,
  specializeBuiltinRoute,
  claudeBuiltinRecords,
  appendClaudeBuiltins,
  assertNoSecrets,
  defaultHooks,
  codexAuthPath,
  claudeCredentialsMetaPath,
  checkCodexConnection,
  checkClaudeConnection,
  discoverClaudeCapabilities,
  checkBillingSeparation,
  resolveBillingEnv,
  parseClaudeAuthStatus,
  buildClaudeAuthArgv,
  safeStatusLabel,
  buildClaudeArgv,
  parseClaudeStreamEvents,
  runClaudeAgent,
  describeConnection,
};
