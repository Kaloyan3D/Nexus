'use strict';
/**
 * ContextWireProjectorResponsesV2.cjs - CCv2 provider-wire projection for
 * the OpenAI Responses protocol as the PINNED DSH/pi-ai stack emits it.
 *
 * Input: one complete DSH llm/stream request (GenerateOptions: provider,
 * model, messages, system, tools, maxTokens, reasoningEffort, sessionId,
 * temperature) plus the route descriptor its settings.yaml profile resolves
 * to. Output: the exact JSON body the pinned adapter chain posts to
 * <baseURL>/responses, and the token-authority subset of it (model, input,
 * tools, reasoning, max_output_tokens) that REMOTE_MUSE_PRECOUNT counts.
 *
 * Traced (not guessed) from the pinned app tree:
 *   @deepseek-ai/dsh-llm-pi-ai  streamWithSnapshot / textOnlyContext /
 *                                toPiAssistant (replay v2) / profileOptions
 *   @earendil-works/pi-ai 0.82  streamSimple -> buildBaseOptions (maxTokens
 *                                clamp over estimateContextTokens) ->
 *                                openai-responses buildParams ->
 *                                transformMessages -> convertResponsesMessages
 *                                / convertResponsesTools
 * The conformance suite drives that real chain against a local capture
 * server and requires byte-identical bodies.
 *
 * Closed world: anything the pinned chain would render through a path this
 * projector does not reproduce (images, grammar/deferred tools, stop
 * sequences, unknown message roles, unsupported reasoning levels, a
 * settings profile with keys outside the traced set) throws a typed
 * 'context-wire-*' error; callers fail closed. Pure and deterministic
 * except for the PI_CACHE_RETENTION environment lookup pi-ai itself makes
 * (it only affects prompt_cache_retention, never the counted subset).
 */

const RESPONSES_WIRE_REVISION_V1 = 'responses-wire-pi-ai-0.82-dsh-0.1.1-rc.2-v2-reasoning-replay';
const RESPONSES_API = 'openai-responses';
// pi-ai constants (dist/api/openai-responses.js, simple-options.js,
// openai-prompt-cache.js, utils/estimate.js, models.js).
const OPENAI_TOOL_CALL_PROVIDERS = Object.freeze(['openai', 'openai-codex', 'opencode']);
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const CONTEXT_SAFETY_TOKENS = 4096;
const CHARS_PER_TOKEN = 4;
const PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// The counted subset REMOTE_MUSE_PRECOUNT forwards (countPayloadV2).
const COUNTED_KEYS = Object.freeze(['model', 'input', 'tools', 'reasoning', 'max_output_tokens']);

// ---- provider capability: historical reasoning replay ----
//
// reasoningReplay controls ONLY whether provider-issued reasoning from
// earlier responses (DSH `reasoning` blocks, replayed by pi-ai as Responses
// `reasoning` items with rs_* ids / encrypted_content / summaries) is sent
// again. It never disables reasoning generation and never touches the
// request's reasoning settings ({ effort, summary }).
//
//   native - replay as the pinned adapter does (default for every route)
//   none   - replayed reasoning is removed from the DSH request itself, so
//            the ONE transformed request feeds both the exact count
//            projection and the provider send
//
// Bound to exact certified (provider, model) pairs, the same identity the
// OpenCode authority certification binds. OpenCode Go serves Muse Spark
// from pooled upstream callers and the Meta count endpoint cannot decrypt
// OpenCode-issued encrypted_content (live OC01: HTTP 400
// invalid_request_error), so replay is uncountable there; a no-replay
// continuation was proven live to progress (human -> tool A -> tool B ->
// final). A new Muse model on the route needs its own entry (and its own
// certification).
const REASONING_REPLAY_NATIVE = 'native';
const REASONING_REPLAY_NONE = 'none';
const REASONING_REPLAY_MODES = Object.freeze([REASONING_REPLAY_NATIVE, REASONING_REPLAY_NONE]);
const REASONING_REPLAY_CAPABILITIES_V1 = Object.freeze({
  'opencode-go\nmuse-spark-1.3-contributor': REASONING_REPLAY_NONE,
});
function reasoningReplayOfV2(provider, modelId) {
  const key = String(provider) + '\n' + String(modelId);
  return Object.prototype.hasOwnProperty.call(REASONING_REPLAY_CAPABILITIES_V1, key)
    ? REASONING_REPLAY_CAPABILITIES_V1[key]
    : REASONING_REPLAY_NATIVE;
}

function failWire(code, detail) {
  throw new Error('context-wire-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---- pi-ai utilities (verbatim semantics) ----

function sanitizeSurrogates(text) {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function shortHash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function safeJsonStringify(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 'undefined' : text;
  } catch {
    return '[unserializable]';
  }
}

// ---- route descriptor (settings.yaml profile, closed world) ----

const PROFILE_KEYS = Object.freeze(['displayName', 'apiKeyEnv', 'api', 'baseURL', 'reasoning', 'compat', 'models']);
const PROFILE_COMPAT_KEYS = Object.freeze(['supportsDeveloperRole']);
const MODEL_KEYS = Object.freeze(['id', 'name', 'input', 'contextWindow', 'maxTokens', 'reasoningEfforts']);

function scalarOf(raw) {
  const text = raw.trim();
  if (text === '' || text.indexOf(' #') !== -1) return null;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.length >= 2 ? text.slice(1, -1) : null;
  }
  return text;
}

function flowListOf(raw) {
  const text = raw.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  const items = inner.split(',').map((item) => scalarOf(item));
  return items.some((item) => item === null) ? null : items;
}

function positiveIntOf(raw) {
  const text = scalarOf(raw);
  if (text === null || !/^[1-9][0-9]*$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Resolve the route descriptor of one provider/model from settings.yaml
 * text, mirroring dsh-llm-pi-ai resolveRouteModels / resolveModelReasoning
 * / resolveModelCompat for a route the installed pi-ai catalog does not
 * describe. Returns null (fail closed) on any key outside the traced set,
 * any parse doubt, or a route/model/api mismatch. Never throws.
 */
function readResponsesRouteFromSettingsV2(settingsText, providerId, modelId) {
  try {
    if (typeof settingsText !== 'string' || typeof providerId !== 'string' || typeof modelId !== 'string') return null;
    const lines = settingsText.split('\n');
    const header = '    ' + providerId + ':';
    const start = lines.findIndex((line) => line.replace(/\s+$/, '') === header);
    if (start === -1) return null;
    const block = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index].replace(/\s+$/, '');
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      if (!line.startsWith('      ')) break;
      block.push(line);
    }
    const profile = { compat: {}, models: [] };
    let section = null;
    let model = null;
    let efforts = null;
    for (const line of block) {
      const indent = line.length - line.trimStart().length;
      const body = line.trim();
      if (indent === 6) {
        section = null;
        model = null;
        efforts = null;
        const match = /^([A-Za-z]+):(.*)$/.exec(body);
        if (match === null || PROFILE_KEYS.indexOf(match[1]) === -1 || profile[match[1]] !== undefined && match[1] !== 'compat' && match[1] !== 'models') return null;
        if (match[1] === 'compat' || match[1] === 'models') {
          if (match[2].trim() !== '') return null;
          section = match[1];
          continue;
        }
        const value = scalarOf(match[2]);
        if (value === null) return null;
        profile[match[1]] = value;
        continue;
      }
      if (section === 'compat' && indent === 8) {
        const match = /^([A-Za-z]+):(.*)$/.exec(body);
        if (match === null || PROFILE_COMPAT_KEYS.indexOf(match[1]) === -1) return null;
        const value = scalarOf(match[2]);
        if (value !== 'true' && value !== 'false') return null;
        profile.compat[match[1]] = value === 'true';
        continue;
      }
      if (section === 'models' && indent === 8) {
        const match = /^- id:(.*)$/.exec(body);
        if (match === null) return null;
        const id = scalarOf(match[1]);
        if (id === null) return null;
        model = { id };
        efforts = null;
        profile.models.push(model);
        continue;
      }
      if (section === 'models' && model !== null && indent === 10) {
        efforts = null;
        const match = /^([A-Za-z]+):(.*)$/.exec(body);
        if (match === null || MODEL_KEYS.indexOf(match[1]) === -1 || match[1] === 'id' || model[match[1]] !== undefined) return null;
        if (match[1] === 'reasoningEfforts') {
          if (match[2].trim() === 'false') {
            model.reasoningEfforts = false;
          } else {
            if (match[2].trim() !== '') return null;
            model.reasoningEfforts = {};
            efforts = model.reasoningEfforts;
          }
        } else if (match[1] === 'input') {
          const list = flowListOf(match[2]);
          if (list === null || list.some((item) => item !== 'text' && item !== 'image')) return null;
          model.input = list;
        } else if (match[1] === 'contextWindow' || match[1] === 'maxTokens') {
          const value = positiveIntOf(match[2]);
          if (value === null) return null;
          model[match[1]] = value;
        } else {
          const value = scalarOf(match[2]);
          if (value === null) return null;
          model[match[1]] = value;
        }
        continue;
      }
      if (efforts !== null && indent === 12) {
        const match = /^([a-z]+):(.*)$/.exec(body);
        if (match === null || THINKING_LEVELS.indexOf(match[1]) === -1 || efforts[match[1]] !== undefined) return null;
        const raw = match[2].trim();
        if (raw === '' || raw === 'null' || raw === '~') {
          if (match[1] !== 'off') return null;
          efforts[match[1]] = null;
        } else {
          const value = scalarOf(raw);
          if (value === null || value === '') return null;
          efforts[match[1]] = value;
        }
        continue;
      }
      return null;
    }
    if (profile.api !== RESPONSES_API) return null;
    const entry = profile.models.find((candidate) => candidate.id === modelId);
    if (entry === undefined || profile.models.filter((candidate) => candidate.id === modelId).length !== 1) return null;
    if (!Number.isInteger(entry.contextWindow) || !Number.isInteger(entry.maxTokens)) return null;
    let reasoning = false;
    let thinkingLevelMap = null;
    if (entry.reasoningEfforts !== undefined && entry.reasoningEfforts !== false) {
      const declared = THINKING_LEVELS.filter((level) => entry.reasoningEfforts[level] !== undefined);
      if (!declared.some((level) => level !== 'off')) return null;
      thinkingLevelMap = {};
      for (const level of THINKING_LEVELS) {
        const wire = entry.reasoningEfforts[level];
        if (wire === undefined) thinkingLevelMap[level] = null;
        else if (wire !== null) thinkingLevelMap[level] = wire;
      }
      reasoning = true;
    }
    const defaultReasoning = profile.reasoning === undefined ? null : profile.reasoning;
    if (defaultReasoning !== null && THINKING_LEVELS.indexOf(defaultReasoning) === -1) return null;
    return Object.freeze({
      provider: providerId,
      api: RESPONSES_API,
      modelId,
      input: Object.freeze((entry.input === undefined ? ['text'] : entry.input).slice()),
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      reasoning,
      thinkingLevelMap: thinkingLevelMap === null ? null : Object.freeze(thinkingLevelMap),
      defaultReasoning,
      supportsDeveloperRole: profile.compat.supportsDeveloperRole === undefined ? true : profile.compat.supportsDeveloperRole,
      supportsLongCacheRetention: true,
      cacheRetention: null,
      reasoningReplay: reasoningReplayOfV2(providerId, modelId),
    });
  } catch {
    return null;
  }
}

function checkRouteV2(route) {
  if (!isPlainObject(route) || route.api !== RESPONSES_API || typeof route.provider !== 'string' || typeof route.modelId !== 'string') {
    failWire('route-invalid', 'a Responses route descriptor is required');
  }
  if (!Number.isInteger(route.contextWindow) || !Number.isInteger(route.maxTokens) || route.maxTokens <= 0) {
    failWire('route-invalid', 'route window/maxTokens required');
  }
  if (typeof route.reasoning !== 'boolean' || !Array.isArray(route.input)) failWire('route-invalid', 'route reasoning/input required');
  // Unknown capability fails closed: a route that does not state one of the
  // frozen modes is never projected.
  if (REASONING_REPLAY_MODES.indexOf(route.reasoningReplay) === -1) failWire('route-invalid', 'route reasoningReplay capability unknown');
}

function assistantHasReasoningV2(message) {
  return isPlainObject(message) && message.role === 'assistant' && Array.isArray(message.content)
    && message.content.some((block) => isPlainObject(block) && block.type === 'reasoning');
}

/**
 * Apply the route's reasoningReplay capability to DSH request messages.
 * native: the same array. none: every assistant message carrying
 * `reasoning` blocks is replaced by a copy without them - the remaining
 * content blocks are the SAME objects in the same order, and a pi-ai replay
 * envelope drops exactly the matching block entries (replay stays valid,
 * so text signatures and fc_* item ids survive). Every other message is
 * returned by reference. Pure; never mutates its input.
 */
function applyReasoningReplayV2(messages, route) {
  if (!Array.isArray(messages)) failWire('input-invalid', 'messages required');
  if (!isPlainObject(route) || REASONING_REPLAY_MODES.indexOf(route.reasoningReplay) === -1) {
    failWire('route-invalid', 'route reasoningReplay capability unknown');
  }
  if (route.reasoningReplay === REASONING_REPLAY_NATIVE) return messages;
  return messages.map((message) => {
    if (!assistantHasReasoningV2(message)) return message;
    const keep = [];
    message.content.forEach((block, index) => {
      if (!(isPlainObject(block) && block.type === 'reasoning')) keep.push(index);
    });
    const source = message.source;
    let nextSource = source;
    if (isPlainObject(source) && source.replayState !== undefined) {
      const state = source.replayState;
      const blocks = isPlainObject(state) && Array.isArray(state.blocks) && state.blocks.length === message.content.length
        ? keep.map((index) => state.blocks[index])
        : null;
      // An envelope that no longer lines up with the content degrades to
      // foreign history in the adapter either way; keep it untouched so the
      // projector and the adapter take the same degraded path.
      nextSource = Object.freeze(Object.assign({}, source, blocks === null ? {} : { replayState: Object.freeze(Object.assign({}, state, { blocks: Object.freeze(blocks) })) }));
    }
    return Object.freeze(Object.assign({}, message, {
      content: Object.freeze(keep.map((index) => message.content[index])),
      source: nextSource,
    }));
  });
}

function supportedThinkingLevelsV2(route) {
  if (!route.reasoning) return ['off'];
  return THINKING_LEVELS.filter((level) => {
    const mapped = route.thinkingLevelMap === null ? undefined : route.thinkingLevelMap[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

// ---- DSH content helpers ----

function contentHasImageV2(blocks) {
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'image') return true;
    if (block.type === 'tool-result' && contentHasImageV2(block.content)) return true;
  }
  return false;
}

function flattenTextV2(message) {
  return message.content.filter((block) => isPlainObject(block) && block.type === 'text').map((block) => block.text).join('');
}

function toolResultTextV2(blocks) {
  return blocks.map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? toolResultTextV2(block.content) : '')).join('');
}

function parseArgumentsV2(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    // tolerate model malformations with {} (dsh-llm-pi-ai parseArguments)
  }
  return {};
}

// dsh-llm-pi-ai readReplayState (replay envelope v2). Returns null when the
// envelope is unusable, which degrades the one message to foreign history.
function readReplayStateV2(value) {
  if (!isPlainObject(value)) return null;
  const response = value.response;
  if (!isPlainObject(response) || response.kind !== 'pi-ai' || response.version !== 2) return null;
  for (const key of ['api', 'provider', 'model']) {
    if (typeof response[key] !== 'string' || response[key].length === 0) return null;
  }
  if (['stop', 'length', 'toolUse', 'error', 'aborted'].indexOf(String(response.stopReason)) === -1) return null;
  if (response.responseModel !== undefined && typeof response.responseModel !== 'string') return null;
  if (response.responseId !== undefined && typeof response.responseId !== 'string') return null;
  if (!Array.isArray(value.blocks)) return null;
  for (const block of value.blocks) {
    if (!isPlainObject(block) || ['text', 'reasoning', 'tool-call'].indexOf(String(block.type)) === -1) return null;
    for (const signature of ['textSignature', 'thinkingSignature', 'thoughtSignature']) {
      if (block[signature] !== undefined && typeof block[signature] !== 'string') return null;
    }
    if (block.redacted !== undefined && typeof block.redacted !== 'boolean') return null;
  }
  return { response, blocks: value.blocks };
}

function foreignAssistantV2(message) {
  const source = isPlainObject(message.source) && message.source.kind === 'model' ? message.source : undefined;
  const content = [];
  for (const block of message.content) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text });
    else if (block.type === 'tool-call') content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArgumentsV2(block.arguments) });
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-foreign',
    provider: source !== undefined && source.provider !== undefined ? source.provider : 'dsh-foreign',
    model: source !== undefined && source.model !== undefined ? source.model : 'dsh-foreign',
    stopReason: content.some((piece) => piece.type === 'toolCall') ? 'toolUse' : 'stop',
  };
}

function replayedAssistantV2(message, source) {
  const state = readReplayStateV2(source.replayState);
  if (state === null) return null;
  if (state.response.provider !== source.provider || state.response.model !== source.model) return null;
  if (state.blocks.length !== message.content.length) return null;
  const content = [];
  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index];
    const replay = state.blocks[index];
    if (!isPlainObject(block) || replay.type !== block.type) return null;
    if (block.type === 'text') {
      content.push(Object.assign({ type: 'text', text: block.text }, replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {}));
    } else if (block.type === 'reasoning') {
      content.push(Object.assign({ type: 'thinking', thinking: block.text },
        replay.thinkingSignature !== undefined ? { thinkingSignature: replay.thinkingSignature } : {},
        replay.redacted !== undefined ? { redacted: replay.redacted } : {}));
    } else if (block.type === 'tool-call') {
      content.push(Object.assign({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArgumentsV2(block.arguments) },
        replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {}));
    } else {
      return null;
    }
  }
  return {
    role: 'assistant',
    content,
    api: state.response.api,
    provider: state.response.provider,
    model: state.response.model,
    stopReason: state.response.stopReason,
  };
}

function toPiAssistantV2(message) {
  const source = message.source;
  if (!isPlainObject(source) || source.kind !== 'model' || source.replayState === undefined) return foreignAssistantV2(message);
  const replayed = replayedAssistantV2(message, source);
  return replayed === null ? foreignAssistantV2(message) : replayed;
}

// dsh-llm-pi-ai textOnlyContext (the path for requests without images).
function toPiMessagesV2(messages) {
  const out = [];
  for (const message of messages) {
    if (!isPlainObject(message) || !Array.isArray(message.content)) failWire('input-invalid', 'every message needs content blocks');
    if (message.role === 'system') {
      out.push({ role: 'user', content: flattenTextV2(message) });
      continue;
    }
    if (message.role === 'assistant') {
      out.push(toPiAssistantV2(message));
      continue;
    }
    if (message.role !== 'user') failWire('unsupported-content', 'unknown message role');
    const text = flattenTextV2(message);
    const results = message.content.filter((block) => isPlainObject(block) && block.type === 'tool-result');
    if (text.length > 0 || results.length === 0) out.push({ role: 'user', content: text });
    for (const result of results) {
      out.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        content: [{ type: 'text', text: toolResultTextV2(result.content) || '(no output)' }],
        isError: result.isError === undefined ? false : result.isError,
      });
    }
  }
  return out;
}

// ---- pi-ai estimate (maxTokens clamp input) ----

function estimateMessageTokensV2(message) {
  if (message.role === 'user' || message.role === 'toolResult') {
    const content = message.content;
    let chars = 0;
    if (typeof content === 'string') chars = content.length;
    else for (const block of content) chars += block.type === 'text' ? block.text.length : 4800;
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
  let chars = 0;
  for (const block of message.content) {
    if (block.type === 'text') chars += block.text.length;
    else if (block.type === 'thinking') chars += block.thinking.length;
    else chars += block.name.length + safeJsonStringify(block.arguments).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// Historical pi assistants carry zero usage (DSH emptyPiUsage), so the
// usage-anchored branch never applies: the estimate is the full char sum.
function estimateContextTokensV2(systemPrompt, piMessages, tools) {
  let tokens = 0;
  for (const message of piMessages) tokens += estimateMessageTokensV2(message);
  if (systemPrompt) tokens += Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  if (tools !== undefined && tools.length > 0) tokens += Math.ceil(safeJsonStringify(tools).length / CHARS_PER_TOKEN);
  return tokens;
}

// ---- pi-ai transformMessages + convertResponsesMessages ----

function normalizeIdPartV2(part) {
  const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, '_');
  const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
  return normalized.replace(/_+$/, '');
}

function normalizeToolCallIdV2(route, id, source) {
  if (OPENAI_TOOL_CALL_PROVIDERS.indexOf(route.provider) === -1) return normalizeIdPartV2(id);
  if (!id.includes('|')) return normalizeIdPartV2(id);
  const [callId, itemId] = id.split('|');
  const normalizedCallId = normalizeIdPartV2(callId);
  const isForeign = source.provider !== route.provider || source.api !== RESPONSES_API;
  let normalizedItemId = isForeign
    ? (() => { const hashed = 'fc_' + shortHash(itemId); return hashed.length > 64 ? hashed.slice(0, 64) : hashed; })()
    : normalizeIdPartV2(itemId);
  if (!normalizedItemId.startsWith('fc_')) normalizedItemId = normalizeIdPartV2('fc_' + normalizedItemId);
  return normalizedCallId + '|' + normalizedItemId;
}

function transformMessagesV2(route, messages) {
  const toolCallIdMap = new Map();
  const transformed = messages.map((msg) => {
    if (msg.role === 'user') return msg;
    if (msg.role === 'toolResult') {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      return normalizedId && normalizedId !== msg.toolCallId ? Object.assign({}, msg, { toolCallId: normalizedId }) : msg;
    }
    const isSameModel = msg.provider === route.provider && msg.api === RESPONSES_API && msg.model === route.modelId;
    const content = [];
    for (const block of msg.content) {
      if (block.type === 'thinking') {
        if (block.redacted) {
          if (isSameModel) content.push(block);
          continue;
        }
        if (isSameModel && block.thinkingSignature) { content.push(block); continue; }
        if (!block.thinking || block.thinking.trim() === '') continue;
        content.push(isSameModel ? block : { type: 'text', text: block.thinking });
        continue;
      }
      if (block.type === 'text') {
        content.push(isSameModel ? block : { type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'toolCall') {
        let call = block;
        if (!isSameModel && call.thoughtSignature) {
          call = Object.assign({}, call);
          delete call.thoughtSignature;
        }
        if (!isSameModel) {
          const normalizedId = normalizeToolCallIdV2(route, call.id, msg);
          if (normalizedId !== call.id) {
            toolCallIdMap.set(call.id, normalizedId);
            call = Object.assign({}, call, { id: normalizedId });
          }
        }
        content.push(call);
        continue;
      }
      content.push(block);
    }
    return Object.assign({}, msg, { content });
  });
  const result = [];
  let pendingToolCalls = [];
  let existingToolResultIds = new Set();
  const insertSyntheticToolResults = () => {
    for (const call of pendingToolCalls) {
      if (!existingToolResultIds.has(call.id)) {
        result.push({ role: 'toolResult', toolCallId: call.id, content: [{ type: 'text', text: 'No result provided' }], isError: true, synthetic: true });
      }
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };
  for (const msg of transformed) {
    if (msg.role === 'assistant') {
      insertSyntheticToolResults();
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') continue;
      const calls = msg.content.filter((block) => block.type === 'toolCall');
      if (calls.length > 0) {
        pendingToolCalls = calls;
        existingToolResultIds = new Set();
      }
      result.push(msg);
    } else if (msg.role === 'toolResult') {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else {
      insertSyntheticToolResults();
      result.push(msg);
    }
  }
  insertSyntheticToolResults();
  return result;
}

function parseTextSignatureV2(signature) {
  if (!signature) return undefined;
  if (signature.startsWith('{')) {
    try {
      const parsed = JSON.parse(signature);
      if (parsed.v === 1 && typeof parsed.id === 'string') {
        if (parsed.phase === 'commentary' || parsed.phase === 'final_answer') return { id: parsed.id, phase: parsed.phase };
        return { id: parsed.id };
      }
    } catch {
      // fall through to the legacy plain-string handling
    }
  }
  return { id: signature };
}

function convertResponsesMessagesV2(route, systemPrompt, piMessages, facts) {
  const items = [];
  const transformed = transformMessagesV2(route, piMessages);
  if (systemPrompt) {
    const role = route.reasoning && route.supportsDeveloperRole !== false ? 'developer' : 'system';
    items.push({ role, content: sanitizeSurrogates(systemPrompt) });
  }
  let msgIndex = 0;
  for (const msg of transformed) {
    if (msg.role === 'user') {
      items.push({ role: 'user', content: [{ type: 'input_text', text: sanitizeSurrogates(msg.content) }] });
    } else if (msg.role === 'assistant') {
      const output = [];
      const isDifferentModel = msg.model !== route.modelId && msg.provider === route.provider && msg.api === RESPONSES_API;
      let textBlockIndex = 0;
      for (const block of msg.content) {
        if (block.type === 'thinking') {
          if (block.thinkingSignature) {
            let item = null;
            try {
              item = JSON.parse(block.thinkingSignature);
            } catch {
              failWire('unsupported-content', 'reasoning replay signature is not JSON');
            }
            output.push(item);
            facts.reasoningItems += 1;
          }
        } else if (block.type === 'text') {
          const parsed = parseTextSignatureV2(block.textSignature);
          const fallbackId = textBlockIndex === 0 ? 'msg_pi_' + msgIndex : 'msg_pi_' + msgIndex + '_' + textBlockIndex;
          textBlockIndex += 1;
          let msgId = parsed !== undefined ? parsed.id : undefined;
          if (!msgId) msgId = fallbackId;
          else if (msgId.length > 64) msgId = 'msg_' + shortHash(msgId);
          output.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: sanitizeSurrogates(block.text), annotations: [] }],
            status: 'completed',
            id: msgId,
            phase: parsed !== undefined ? parsed.phase : undefined,
          });
        } else if (block.type === 'toolCall') {
          const [callId, itemIdRaw] = block.id.split('|');
          let itemId = itemIdRaw;
          if ((isDifferentModel && itemId !== undefined && itemId.startsWith('fc_')) || !(itemId !== undefined && itemId.startsWith('fc_'))) {
            itemId = undefined;
          }
          output.push({ type: 'function_call', id: itemId, call_id: callId, name: block.name, arguments: JSON.stringify(block.arguments) });
          facts.functionCalls += 1;
        }
      }
      if (output.length === 0) continue;
      items.push(...output);
    } else if (msg.role === 'toolResult') {
      const [callId] = msg.toolCallId.split('|');
      const text = msg.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      items.push({ type: 'function_call_output', call_id: callId, output: sanitizeSurrogates(text.length > 0 ? text : '(no tool output)') });
      facts.functionCallOutputs += 1;
      if (msg.synthetic === true) facts.syntheticToolResults += 1;
    }
    msgIndex += 1;
  }
  return items;
}

// ---- the projection ----

/**
 * Project one DSH request to the exact Responses body the pinned adapter
 * chain posts. input: { request, route, env? }. Returns frozen
 * { wireBody, countedBody, facts }. Throws 'context-wire-*' on anything
 * outside the reproduced chain (callers fail closed).
 */
function projectResponsesWireV2(input) {
  if (!isPlainObject(input) || !isPlainObject(input.request)) failWire('input-invalid', 'request required');
  const request = input.request;
  const route = input.route;
  checkRouteV2(route);
  const env = isPlainObject(input.env) ? input.env : (typeof process !== 'undefined' ? process.env : {});
  if (request.provider !== route.provider || request.model !== route.modelId) failWire('route-mismatch', 'request route differs from the descriptor');
  if (!Array.isArray(request.messages)) failWire('input-invalid', 'messages required');
  if (request.stop !== undefined) failWire('unsupported-option', 'stop sequences are rejected by the pinned adapter');
  if (request.system !== undefined && typeof request.system !== 'string') failWire('input-invalid', 'system must be a string');
  if (request.maxTokens !== undefined && (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0)) failWire('input-invalid', 'maxTokens');
  for (const message of request.messages) {
    if (!isPlainObject(message) || !Array.isArray(message.content)) failWire('input-invalid', 'every message needs content blocks');
    if (contentHasImageV2(message.content)) failWire('unsupported-content', 'image content is not projected');
  }
  // dsh-llm-pi-ai: resolveReasoningLevel(options.reasoningEffort ?? profile.reasoning); 'off' -> omitted.
  const level = request.reasoningEffort !== undefined ? String(request.reasoningEffort) : (route.defaultReasoning === null ? undefined : route.defaultReasoning);
  const supported = supportedThinkingLevelsV2(route);
  if (level !== undefined && supported.indexOf(level) === -1) failWire('reasoning-unsupported', 'route does not support the requested effort');
  const reasoningEffort = level === undefined || level === 'off' ? undefined : level;
  const facts = { reasoningItems: 0, functionCalls: 0, functionCallOutputs: 0, syntheticToolResults: 0 };
  // reasoningReplay=none: the request must already be the transformed one
  // (applyReasoningReplayV2). Filtering here would change the counted body
  // but not the adapter's send, so a request still carrying replayable
  // reasoning is refused instead.
  if (route.reasoningReplay === REASONING_REPLAY_NONE && request.messages.some(assistantHasReasoningV2)) {
    failWire('reasoning-replay-forbidden', 'route forbids historical reasoning replay');
  }
  const piMessages = toPiMessagesV2(request.messages);
  const systemPrompt = request.system;
  const tools = Array.isArray(request.tools) && request.tools.length > 0
    ? request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    : undefined;
  // pi-ai buildBaseOptions: clampMaxTokensToContext over the estimate.
  const requestedMax = request.maxTokens !== undefined ? request.maxTokens : route.maxTokens;
  const estimateTokens = estimateContextTokensV2(systemPrompt, piMessages, tools);
  const maxTokens = route.contextWindow <= 0
    ? Math.max(1, requestedMax)
    : Math.min(requestedMax, Math.max(1, route.contextWindow - estimateTokens - CONTEXT_SAFETY_TOKENS));
  // pi-ai openai-responses buildParams (compat defaults: no strict mode,
  // no grammar tools, no tool search, no explicit prompt-cache mode).
  const envRetention = env.PI_CACHE_RETENTION;
  const cacheRetention = route.cacheRetention !== null && route.cacheRetention !== undefined
    ? route.cacheRetention
    : (envRetention === 'long' ? 'long' : 'short');
  const sessionId = request.sessionId === undefined ? undefined : String(request.sessionId);
  const input2 = convertResponsesMessagesV2(route, systemPrompt, piMessages, facts);
  const params = {
    model: route.modelId,
    input: input2,
    stream: true,
    prompt_cache_key: cacheRetention === 'none' || sessionId === undefined ? undefined : Array.from(sessionId).slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join(''),
    prompt_cache_retention: cacheRetention === 'long' && route.supportsLongCacheRetention !== false ? '24h' : undefined,
    prompt_cache_options: undefined,
    store: false,
  };
  if (maxTokens) params.max_output_tokens = Math.max(maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
  if (request.temperature !== undefined) params.temperature = request.temperature;
  if (tools !== undefined) {
    const unique = new Map();
    for (const tool of tools) unique.set(tool.name, tool);
    const immediate = Array.from(unique.values());
    if (immediate.length > 0) {
      params.tools = immediate.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
    }
  }
  if (route.reasoning) {
    const map = route.thinkingLevelMap;
    if (reasoningEffort !== undefined) {
      const mapped = map !== null && map[reasoningEffort] !== undefined && map[reasoningEffort] !== null ? map[reasoningEffort] : reasoningEffort;
      params.reasoning = { effort: mapped, summary: 'auto' };
      params.include = ['reasoning.encrypted_content'];
    } else if (route.provider !== 'github-copilot' && !(map !== null && map.off === null)) {
      params.reasoning = { effort: map !== null && map.off !== undefined ? map.off : 'none' };
    }
  }
  // JSON round trip: the exact serialized body (undefined members dropped).
  const wireBody = JSON.parse(JSON.stringify(params));
  const countedBody = {};
  for (const key of COUNTED_KEYS) {
    if (wireBody[key] !== undefined) countedBody[key] = wireBody[key];
  }
  return Object.freeze({
    revision: RESPONSES_WIRE_REVISION_V1,
    wireBody: deepFreezeV2(wireBody),
    countedBody: deepFreezeV2(countedBody),
    facts: Object.freeze(Object.assign(facts, {
      messageCount: request.messages.length,
      inputItemCount: wireBody.input.length,
      estimateTokens,
      maxOutputTokens: wireBody.max_output_tokens === undefined ? null : wireBody.max_output_tokens,
      maxTokensClamped: maxTokens !== requestedMax,
      reasoningReplay: route.reasoningReplay,
    })),
  });
}

function deepFreezeV2(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreezeV2(value[key]);
  }
  return value;
}

module.exports = {
  REASONING_REPLAY_NATIVE,
  REASONING_REPLAY_NONE,
  REASONING_REPLAY_MODES,
  REASONING_REPLAY_CAPABILITIES_V1,
  reasoningReplayOfV2,
  applyReasoningReplayV2,
  RESPONSES_WIRE_REVISION_V1,
  RESPONSES_API,
  COUNTED_KEYS,
  THINKING_LEVELS,
  readResponsesRouteFromSettingsV2,
  supportedThinkingLevelsV2,
  projectResponsesWireV2,
};
