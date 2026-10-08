'use strict';
// ContextTokenizerRegistryV2.cjs - CCV2-C08H production tokenizer registry.
// The ONE adapter-layer authority for verified production tokenizers.
// Exact provider/model pairs only; C01-C06 untouched. First entry:
// flash-max-direct + flash-high-direct / deepseek-v4-flash from the
// official DeepSeek v4 artifact (see config/tokenizers provenance).
// Dependency-free byte-level BPE proven id-for-id against the
// reference engine; framing reproduces the official chat_template.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_REVISION_V1 = 'context-tokenizer-registry-v1';
const ENGINE_REVISION_V1 = 'deepseek-v4-bpe-engine-r1';
const FRAMING_REVISION_V1 = 'deepseek-v4-chat-template-r1';
const TOKENIZER_DIR = path.join(__dirname, 'tokenizers');
const TOKENIZER_JSON_FILE = path.join(TOKENIZER_DIR, 'deepseek-v4-tokenizer.json');
const TOKENIZER_CONFIG_FILE = path.join(TOKENIZER_DIR, 'deepseek-v4-tokenizer-config.json');
const PINNED_JSON_SHA256 = '89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614';
const PINNED_CONFIG_SHA256 = '841f8cf146e3f0ad1082594a31f68ecf7608c20467ef355081333d85bbaeb1cb';
const PINNED_VOCAB_SIZE = 128000;
const PINNED_MERGE_COUNT = 127741;
const PINNED_ADDED_COUNT = 1283;
const TOKENIZER_FINGERPRINT_V1 = 'deepseek-v4-official-bpe-r1-89085f12ef79';
const FW = String.fromCharCode(0xFF5C);
const LS = String.fromCharCode(0x2581);
const MARKER_BOS = '<' + FW + 'begin' + LS + 'of' + LS + 'sentence' + FW + '>';
const MARKER_EOS = '<' + FW + 'end' + LS + 'of' + LS + 'sentence' + FW + '>';
const MARKER_USER = '<' + FW + 'User' + FW + '>';
const MARKER_ASSISTANT = '<' + FW + 'Assistant' + FW + '>';
const LF = String.fromCharCode(10);
const EXPECTED_MARKER_IDS = Object.freeze([
  [MARKER_BOS, 0], [MARKER_EOS, 1], [MARKER_USER, 128803], [MARKER_ASSISTANT, 128804],
]);
const PRODUCTION_ENTRIES = Object.freeze([
  Object.freeze({ provider: 'flash-max-direct', model: 'deepseek-v4-flash' }),
  Object.freeze({ provider: 'flash-high-direct', model: 'deepseek-v4-flash' }),
]);
function failRegistry(code, detail) {
  throw new Error('tokenizer-registry-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}
function sha256HexBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function bytesToUnicodeV2() {
  const map = new Array(256);
  const ranges = [[33, 126], [161, 172], [174, 255]];
  const covered = new Set();
  for (const pair of ranges) {
    for (let b = pair[0]; b <= pair[1]; b += 1) covered.add(b);
  }
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (covered.has(b)) map[b] = String.fromCharCode(b);
    else { map[b] = String.fromCharCode(256 + n); n += 1; }
  }
  return Object.freeze(map);
}
const REGEXP_SYNTAX_CHARS = '^$.|?*+()[]{}\\';
function escapeRegExpPiece(text) {
  const value = String(text);
  let out = '';
  for (const ch of value) {
    out += (REGEXP_SYNTAX_CHARS.indexOf(ch) === -1 ? ch : '\\' + ch);
  }
  return out;
}
function rustWhitespaceClassV2(negated) {
  const chars = String.fromCharCode(9, 10, 11, 12, 13, 32, 133, 160, 5760)
    + String.fromCharCode(0x2000) + '-' + String.fromCharCode(0x200A)
    + String.fromCharCode(0x2028, 0x2029, 0x202F, 0x205F, 0x3000);
  return (negated === true ? '[^' : '[') + chars + ']';
}
function rustWhitespaceSourceV2(source) {
  const text = String(source);
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '\\' && index + 1 < text.length) {
      const next = text[index + 1];
      if (next === 's') { out += rustWhitespaceClassV2(false); index += 1; continue; }
      if (next === 'S') { out += rustWhitespaceClassV2(true); index += 1; continue; }
      out += ch + next;
      index += 1;
      continue;
    }
    out += ch;
  }
  return out;
}
function splitIsolated(text, pattern) {
  const out = [];
  pattern.lastIndex = 0;
  let cursor = 0;
  let match = null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    out.push(match[0]);
    cursor = match.index + match[0].length;
    if (pattern.lastIndex < cursor) pattern.lastIndex = cursor;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
let cachedModel = null;
function loadDeepseekV4ModelV2() {
  if (cachedModel !== null) return cachedModel;
  let jsonBytes = null;
  let document = null;
  try {
    jsonBytes = fs.readFileSync(TOKENIZER_JSON_FILE);
    document = JSON.parse(jsonBytes.toString('utf8'));
  } catch (error) {
    failRegistry('artifact-unreadable', 'vendored tokenizer.json is missing or malformed');
  }
  if (sha256HexBytes(jsonBytes) !== PINNED_JSON_SHA256) {
    failRegistry('artifact-tampered', 'vendored tokenizer.json does not match the pinned sha');
  }
  let configBytes = null;
  try {
    configBytes = fs.readFileSync(TOKENIZER_CONFIG_FILE);
    JSON.parse(configBytes.toString('utf8'));
  } catch (error2) {
    failRegistry('artifact-unreadable', 'vendored tokenizer-config.json is missing or malformed');
  }
  if (sha256HexBytes(configBytes) !== PINNED_CONFIG_SHA256) {
    failRegistry('artifact-tampered', 'vendored tokenizer-config.json does not match the pinned sha');
  }
  const model = document.model;
  if (!isPlainObject(document) || !isPlainObject(model) || model.type !== 'BPE') {
    failRegistry('artifact-invalid', 'tokenizer.json is not a BPE model document');
  }
  const vocab = model.vocab;
  const merges = model.merges;
  const added = document.added_tokens;
  if (!isPlainObject(vocab) || !Array.isArray(merges) || !Array.isArray(added)) {
    failRegistry('artifact-invalid', 'tokenizer.json lacks vocab/merges/added_tokens');
  }
  if (Object.keys(vocab).length !== PINNED_VOCAB_SIZE
    || merges.length !== PINNED_MERGE_COUNT
    || added.length !== PINNED_ADDED_COUNT) {
    failRegistry('artifact-invalid', 'vocab/merge/added counts differ from the pinned artifact');
  }
  const normalizer = document.normalizer;
  if (!isPlainObject(normalizer) || normalizer.type !== 'Sequence'
    || !Array.isArray(normalizer.normalizers) || normalizer.normalizers.length !== 0) {
    failRegistry('artifact-invalid', 'normalizer is not the pinned empty sequence');
  }
  const pre = document.pre_tokenizer;
  if (!isPlainObject(pre) || pre.type !== 'Sequence'
    || !Array.isArray(pre.pretokenizers) || pre.pretokenizers.length !== 4) {
    failRegistry('artifact-invalid', 'pre_tokenizer is not the pinned 4-step sequence');
  }
  const vocabMap = new Map();
  for (const key of Object.keys(vocab)) vocabMap.set(key, vocab[key]);
  const rankMap = new Map();
  for (let index = 0; index < merges.length; index += 1) {
    const entry = merges[index];
    const cut = entry.indexOf(' ');
    if (cut === -1) failRegistry('artifact-invalid', 'malformed merge entry');
    rankMap.set(entry.slice(0, cut) + ' ' + entry.slice(cut + 1), index);
  }
  const addedContents = [];
  const addedIds = new Map();
  for (const entry of added) {
    if (!isPlainObject(entry) || typeof entry.content !== 'string' || !Number.isInteger(entry.id)) {
      failRegistry('artifact-invalid', 'malformed added token');
    }
    addedContents.push(entry.content);
    addedIds.set(entry.content, entry.id);
  }
  const splitPatterns = [];
  for (let step = 0; step < 3; step += 1) {
    const node = pre.pretokenizers[step];
    if (!isPlainObject(node) || node.type !== 'Split' || !isPlainObject(node.pattern)
      || typeof node.pattern.Regex !== 'string' || node.behavior !== 'Isolated' || node.invert !== false) {
      failRegistry('artifact-invalid', 'pre_tokenizer step is not the pinned Split');
    }
    splitPatterns.push(new RegExp(rustWhitespaceSourceV2(node.pattern.Regex), 'gu'));
  }
  const byteStep = pre.pretokenizers[3];
  if (!isPlainObject(byteStep) || byteStep.type !== 'ByteLevel') {
    failRegistry('artifact-invalid', 'pre_tokenizer step 3 is not ByteLevel');
  }
  const ordered = addedContents.slice().sort((a, b) => b.length - a.length);
  const addedPattern = new RegExp('(' + ordered.map(escapeRegExpPiece).join('|') + ')', 'gu');
  const built = {
    vocabMap, rankMap, addedIds, splitPatterns, addedPattern,
    bytesToUnicode: bytesToUnicodeV2(),
    fileDigest: sha256HexBytes(jsonBytes),
    configDigest: sha256HexBytes(configBytes),
  };
  const probe = (text) => encodeIdsV2(built, text);
  for (const pair of EXPECTED_MARKER_IDS) {
    const ids = probe(pair[0]);
    if (ids.length !== 1 || ids[0] !== pair[1]) {
      failRegistry('artifact-invalid', 'marker identity drift for id ' + pair[1]);
    }
  }
  cachedModel = Object.freeze(built);
  return cachedModel;
}
function bpeMergeV2(symbols, rankMap) {
  const merged = symbols.slice();
  for (;;) {
    let bestRank = Infinity;
    let bestIndex = -1;
    for (let index = 0; index < merged.length - 1; index += 1) {
      const rank = rankMap.get(merged[index] + ' ' + merged[index + 1]);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestIndex = index;
      }
    }
    if (bestIndex === -1) return merged;
    const pair = merged[bestIndex] + merged[bestIndex + 1];
    const next = [];
    let index = 0;
    while (index < merged.length) {
      if (index < merged.length - 1 && merged[index] + merged[index + 1] === pair) {
        next.push(pair);
        index += 2;
      } else {
        next.push(merged[index]);
        index += 1;
      }
    }
    merged.length = 0;
    for (const symbol of next) merged.push(symbol);
  }
}
function byteLevelEncodeV2(model, piece) {
  const bytes = new TextEncoder().encode(piece);
  let out = '';
  for (const byte of bytes) out += model.bytesToUnicode[byte];
  return out;
}
function encodeIdsV2(model, text) {
  if (typeof text !== 'string') failRegistry('encode-invalid', 'text must be a string');
  if (text === '') return [];
  const ids = [];
  const segments = splitIsolated(text, model.addedPattern);
  for (const segment of segments) {
    const addedId = model.addedIds.get(segment);
    if (addedId !== undefined) {
      ids.push(addedId);
      continue;
    }
    let pieces = [segment];
    for (const pattern of model.splitPatterns) {
      const next = [];
      for (const piece of pieces) {
        const parts = splitIsolated(piece, pattern);
        for (const part of parts) next.push(part);
      }
      pieces = next;
    }
    for (const piece of pieces) {
      if (piece === '') continue;
      const symbols = Array.from(byteLevelEncodeV2(model, piece));
      const merged = bpeMergeV2(symbols, model.rankMap);
      for (const symbol of merged) {
        const id = model.vocabMap.get(symbol);
        if (id === undefined) failRegistry('encode-unk', 'no vocab entry for a merged symbol');
        ids.push(id);
      }
    }
  }
  return ids;
}
function createDeepseekV4CounterV2() {
  const model = loadDeepseekV4ModelV2();
  const counter = {
    tokenizerFingerprint: TOKENIZER_FINGERPRINT_V1,
    countText(text) {
      if (typeof text !== 'string') {
        throw new Error('tokenizer-registry-counter-invalid: deepseek v4 adapter requires a string (DISCARDABLE)');
      }
      return encodeIdsV2(model, text).length;
    },
  };
  return Object.freeze(counter);
}
function encodeDeepseekV4V2(text) {
  const model = loadDeepseekV4ModelV2();
  return Object.freeze(encodeIdsV2(model, text));
}
function resolveProductionTokenizerV2(input) {
  try {
    if (!isPlainObject(input)) return null;
    const provider = input.provider;
    const model = input.model;
    if (typeof provider !== 'string' || typeof model !== 'string') return null;
    let found = null;
    for (const entry of PRODUCTION_ENTRIES) {
      if (entry.provider === provider && entry.model === model) { found = entry; break; }
    }
    if (found === null) return null;
    return Object.freeze({
      provider: found.provider,
      model: found.model,
      tokenizerFingerprint: TOKENIZER_FINGERPRINT_V1,
      engineRevision: ENGINE_REVISION_V1,
      framingRevision: FRAMING_REVISION_V1,
      source: 'deepseek-official-tokenizer',
      verified: true,
      registryRevision: REGISTRY_REVISION_V1,
      createCounter: createDeepseekV4CounterV2,
    });
  } catch (error) {
    return null;
  }
}
function templateConfigDigestV2() {
  return loadDeepseekV4ModelV2().configDigest;
}
function frameDeepseekChatV2(input) {
  if (!isPlainObject(input)) failRegistry('frame-invalid', 'framing input must be an object');
  const systems = Array.isArray(input.systemTexts) ? input.systemTexts : null;
  const turn = input.turnText;
  const prime = input.generationPrime === undefined ? true : input.generationPrime;
  if (systems === null || typeof turn !== 'string' || typeof prime !== 'boolean') {
    failRegistry('frame-invalid', 'systemTexts plus turnText plus generationPrime are required');
  }
  for (const system of systems) {
    if (typeof system !== 'string') failRegistry('frame-invalid', 'every system text must be a string');
  }
  const kept = systems.filter((system) => system !== '');
  let joined = '';
  for (let index = 0; index < kept.length; index += 1) {
    joined += (index === 0 ? '' : LF + LF) + kept[index];
  }
  const framedText = MARKER_BOS + joined + MARKER_USER + turn + (prime === true ? MARKER_ASSISTANT : '');
  const model = loadDeepseekV4ModelV2();
  const ids = encodeIdsV2(model, framedText);
  let markerTokens = 0;
  for (const id of ids) {
    if (id === 0 || id === 128803 || id === 128804) markerTokens += 1;
  }
  return Object.freeze({
    framedText,
    ids: Object.freeze(ids),
    tokens: ids.length,
    markerTokens,
    framingRevision: FRAMING_REVISION_V1,
    templateDigest: model.configDigest,
    tokenizerFingerprint: TOKENIZER_FINGERPRINT_V1,
  });
}
function describeProductionTokenizerV2(descriptor) {
  try {
    if (!isPlainObject(descriptor) || descriptor.verified !== true) {
      return Object.freeze({ valid: false });
    }
    return Object.freeze({
      valid: true,
      provider: descriptor.provider,
      model: descriptor.model,
      tokenizerFingerprint: descriptor.tokenizerFingerprint,
      engineRevision: descriptor.engineRevision,
      framingRevision: descriptor.framingRevision,
      source: descriptor.source,
      registryRevision: descriptor.registryRevision,
    });
  } catch (error) {
    return Object.freeze({ valid: false });
  }
}
module.exports = {
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_REVISION_V1,
  ENGINE_REVISION_V1,
  FRAMING_REVISION_V1,
  TOKENIZER_FINGERPRINT_V1,
  PINNED_JSON_SHA256,
  PINNED_CONFIG_SHA256,
  PRODUCTION_ENTRIES,
  MARKER_BOS,
  MARKER_EOS,
  MARKER_USER,
  MARKER_ASSISTANT,
  loadDeepseekV4ModelV2,
  createDeepseekV4CounterV2,
  encodeDeepseekV4V2,
  resolveProductionTokenizerV2,
  frameDeepseekChatV2,
  describeProductionTokenizerV2,
  templateConfigDigestV2,
};
