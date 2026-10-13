'use strict';
/**
 * ContextRepositoryEvidenceSourceV2.cjs - CCV2-B03 exact repository/artifact sources.
 *
 * Narrow ADAPTERS (not authority): exact file/artifact byte suppliers for the
 * B03 rehydration authority (config/ContextEvidenceRehydrationV2.cjs). These
 * modules NEVER declare verified:true and perform NO store, page, or
 * EvidenceRef writes.
 *
 * Exact-resolution contract (frozen, NOT search):
 *
 *   repository-span: open EXACTLY the bound relative POSIX path under the
 *     adapter root, verify containment (no absolute/escape/traversal), decode
 *     strict UTF-8 (malformed bytes fail closed - the route claims textual
 *     evidence), select lines startLine..endLine inclusive (1-based, LF
 *     split), hash sha256HexUtf8(span). The frozen sourceBinding
 *     contentDigest binds THE EXACT SELECTED SPAN (not the whole file, not an
 *     artifact record); B01 never reinterpreted it and B03 does not either.
 *     A present symbol is a locator hint that the span must contain as an
 *     exact substring, otherwise the locator no longer addresses the bound
 *     content. Changed file bytes fail closed as source-mismatch: newer
 *     content is NEVER returned under the old evidence identity.
 *
 *   artifact: read EXACTLY the bound artifactId through the adapter. The
 *     frozen binding contentDigest binds the exact artifact bytes. Artifact
 *     bytes are OPAQUE (B02H binary boundary): returned as exactBytes with
 *     mediaType binary, never UTF-8-coerced, never redacted (no text policy
 *     applies to opaque bytes), never rendered as model/controller text by
 *     this layer. Live repository files may carry unredacted secrets; exact
 *     span text is returned verbatim (mutation detection runs on the raw
 *     source) and secret-bearing sources should be snapshotted through the
 *     redacted B02 blob route instead. Telemetry/describe paths carry only
 *     digests and byte counts, never source bytes.
 *
 * B03H authority domain (frozen, section 28): every file-backed adapter is
 * bound at construction to ONE explicit authorized domain (rootDir, exposed
 * as authorityDomain). Resolution is normalize -> resolve (realpath) ->
 * containment check -> read. Lexical containment alone is NOT sufficient:
 * symlinks (file or directory) resolving outside the domain fail closed,
 * as do alternate spellings. A bespoke readArtifact function is an
 * explicit controller-provided capability, not a filesystem authority; the
 * B03 authority still enforces namespace-before-bytes and the content
 * digest on whatever it returns. These adapters are NOT a generic local
 * file read primitive: only exact bound locators resolve, and only inside
 * the authorized domain.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function failRepo(reason, detail) {
  throw new Error('v2-repository-source: ' + reason + (detail ? ' (' + detail + ')' : '') + ' (BLOCK/KEEP)');
}

function sha256HexBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Frozen B01 relative-POSIX path shape (mirrored, never widened): relative,
// printable ASCII, no backslash, no empty/dot/dotdot segments.
function assertExactRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath === '') {
    failRepo('context-rehydration-source-mismatch', 'exact source path is required');
  }
  if (relPath.length > 500) failRepo('context-rehydration-source-mismatch', 'exact source path exceeds the bound');
  if (relPath.startsWith('/')) failRepo('context-rehydration-source-mismatch', 'absolute source paths are forbidden');
  if (relPath.includes('\\')) failRepo('context-rehydration-source-mismatch', 'host-global escapes are forbidden');
  if (!/^[\x20-\x7E]+$/.test(relPath)) {
    failRepo('context-rehydration-source-mismatch', 'source path is not printable ASCII');
  }
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      failRepo('context-rehydration-source-mismatch', 'path traversal is forbidden');
    }
  }
  return relPath;
}

function assertSafeRoot(rootDir) {
  if (typeof rootDir !== 'string' || rootDir === '' || !path.isAbsolute(rootDir)) {
    failRepo('context-rehydration-source-missing', 'adapter root must be an absolute path');
  }
  const normalized = path.normalize(rootDir);
  if (normalized !== rootDir) failRepo('context-rehydration-source-missing', 'adapter root must be normalized');
  return normalized;
}

function joinUnder(root, relPath) {
  const target = path.join(root, relPath);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(withSep)) {
    failRepo('context-rehydration-source-mismatch', 'derived source path escapes the adapter root');
  }
  if (target.includes('\0') || target !== path.normalize(target)) {
    failRepo('context-rehydration-source-mismatch', 'derived source path is not canonical');
  }
  return target;
}

// B03H symlink containment (frozen): lexical checks reject spelling tricks,
// but only the resolved filesystem identity proves domain membership. A
// symlink (file or ancestor directory) pointing outside the authorized
// domain fails closed here, before any byte is read.
function assertContainedRealpath(rootDir, target, missingDetail) {
  let realRoot = null;
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch {
    failRepo('context-rehydration-source-missing', 'authorized domain is not resolvable');
  }
  let realTarget = null;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    failRepo('context-rehydration-source-missing', missingDetail);
  }
  const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realTarget !== realRoot && !realTarget.startsWith(withSep)) {
    failRepo('context-rehydration-source-mismatch', 'resolved source path escapes the authorized domain');
  }
  return realTarget;
}

// RepositoryExactSourceV2 { kind, rootDir, repositoryId?, checkoutId?,
// readFileBytes(relPath)->Buffer, readSpanText(relPath,startLine,endLine)->string }.
function createRepositoryExactSourceV2(options) {
  if (!options || typeof options !== 'object') {
    failRepo('context-rehydration-source-missing', 'adapter options are required');
  }
  const rootDir = assertSafeRoot(options.rootDir);
  const repositoryId = options.repositoryId === undefined || options.repositoryId === null
    ? null : String(options.repositoryId);
  const checkoutId = options.checkoutId === undefined || options.checkoutId === null
    ? null : String(options.checkoutId);
  function readFileBytes(relPath) {
    assertExactRelativePath(relPath);
    const target = joinUnder(rootDir, relPath);
    const realTarget = assertContainedRealpath(rootDir, target, 'exact source is not readable');
    let bytes = null;
    try {
      const stat = fs.statSync(realTarget);
      if (!stat.isFile()) failRepo('context-rehydration-source-missing', 'exact source is not a file');
      bytes = fs.readFileSync(realTarget);
    } catch (error) {
      if (error && typeof error.message === 'string' && error.message.indexOf('v2-repository-source:') === 0) throw error;
      failRepo('context-rehydration-source-missing', 'exact source is not readable');
    }
    return bytes;
  }
  function decodeStrictUtf8(bytes) {
    let text = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      failRepo('context-rehydration-media-type-invalid', 'repository source is not strict UTF-8 text');
    }
    return text;
  }
  function readSpanText(relPath, startLine, endLine) {
    if (!Number.isInteger(startLine) || startLine < 1) {
      failRepo('context-rehydration-source-mismatch', 'span startLine is not a 1-based line');
    }
    if (!Number.isInteger(endLine) || endLine < startLine) {
      failRepo('context-rehydration-source-mismatch', 'span endLine precedes startLine');
    }
    const bytes = readFileBytes(relPath);
    const text = decodeStrictUtf8(bytes);
    const lines = text.split('\n');
    if (endLine > lines.length) {
      failRepo('context-rehydration-source-mismatch', 'span exceeds the exact source line count');
    }
    return lines.slice(startLine - 1, endLine).join('\n');
  }
  return Object.freeze({
    kind: 'repository-exact-source',
    rootDir, authorityDomain: rootDir, repositoryId, checkoutId, readFileBytes, readSpanText,
  });
}

// ArtifactExactSourceV2 { kind, readArtifactBytes(artifactId)->Buffer }.
// The default file-backed form resolves artifactIds shaped as
// 'file:<relative-posix-path>' under the adapter root; callers with a
// bespoke artifact store supply readArtifact directly.
function createArtifactExactSourceV2(options) {
  if (!options || typeof options !== 'object') {
    failRepo('context-rehydration-source-missing', 'adapter options are required');
  }
  if (typeof options.readArtifact === 'function') {
    const custom = options.readArtifact;
    function readArtifactBytes(artifactId) {
      if (typeof artifactId !== 'string' || artifactId === '' || artifactId.length > 256) {
        failRepo('context-rehydration-source-mismatch', 'artifact identity is required');
      }
      const bytes = custom(artifactId);
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        failRepo('context-rehydration-source-missing', 'artifact bytes are not available');
      }
      return Buffer.from(bytes);
    }
    return Object.freeze({ kind: 'artifact-exact-source', readArtifactBytes });
  }
  const rootDir = assertSafeRoot(options.rootDir);
  const PREFIX = 'file:';
  function readArtifactBytes(artifactId) {
    if (typeof artifactId !== 'string' || artifactId === '' || artifactId.length > 256) {
      failRepo('context-rehydration-source-mismatch', 'artifact identity is required');
    }
    if (!artifactId.startsWith(PREFIX)) {
      failRepo('context-rehydration-source-missing', 'artifact identity is not file-bound');
    }
    const relPath = artifactId.slice(PREFIX.length);
    assertExactRelativePath(relPath);
    const target = joinUnder(rootDir, relPath);
    const realTarget = assertContainedRealpath(rootDir, target, 'artifact is not readable');
    let bytes = null;
    try {
      const stat = fs.statSync(realTarget);
      if (!stat.isFile()) failRepo('context-rehydration-source-missing', 'artifact is not a file');
      bytes = fs.readFileSync(realTarget);
    } catch (error) {
      if (error && typeof error.message === 'string' && error.message.indexOf('v2-repository-source:') === 0) throw error;
      failRepo('context-rehydration-source-missing', 'artifact is not readable');
    }
    if (bytes.length === 0) failRepo('context-rehydration-source-missing', 'artifact bytes are empty');
    return bytes;
  }
  return Object.freeze({ kind: 'artifact-exact-source', rootDir, authorityDomain: rootDir, readArtifactBytes });
}

function isRepositoryExactSourceV2(value) {
  return Boolean(value && typeof value === 'object'
    && value.kind === 'repository-exact-source'
    && typeof value.readFileBytes === 'function' && typeof value.readSpanText === 'function');
}

function isArtifactExactSourceV2(value) {
  return Boolean(value && typeof value === 'object'
    && value.kind === 'artifact-exact-source'
    && typeof value.readArtifactBytes === 'function');
}

module.exports = {
  createRepositoryExactSourceV2,
  createArtifactExactSourceV2,
  isRepositoryExactSourceV2,
  isArtifactExactSourceV2,
  sha256HexBytes,
  sha256HexUtf8,
};
