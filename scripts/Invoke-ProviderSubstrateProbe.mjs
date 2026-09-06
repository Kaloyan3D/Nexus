#!/usr/bin/env node
/**
 * Invoke-ProviderSubstrateProbe.mjs — Phase M2.1 (TASK-0037) Hardening 5.
 *
 * Proves that the REAL DSH provider substrate recognizes a Nexus-managed
 * provider route end-to-end, entirely OFFLINE (no credentials, no network):
 *
 *   FileSettingsProvider (real cordis Context, real settings.yaml)
 *     -> the pinned @deepseek-ai/dsh-llm-pi-ai section schema (Config)
 *     -> substrate.apply on a real cordis Context
 *     -> the REAL PiAiAdapter captured from ctx.llm.registerAdapter
 *     -> adapter.listModels / adapter.resolveModel recognize the route
 *
 * What this proves WITHOUT a live key: the managed route's shape, protocol
 * declarations, model ids, context window, output ceiling and reasoning map
 * are parsed, validated and served by the pinned substrate exactly as the
 * transport will see them. Live-credential behavior is a separate opt-in gate
 * (NEXUS_META_LIVE_TEST, see MuseProvider.ps1) and is NOT exercised here.
 *
 * Output: a JSON record on stdout; exit 0 when every expectation holds.
 * Exits non-zero with the failing expectation on any mismatch (fail closed).
 *
 * Usage:
 *   node Invoke-ProviderSubstrateProbe.mjs --settings <settings.yaml> \
 *        --packages <dir containing @deepseek-ai pinned packages> \
 *        [--provider meta-model-api] [--model muse-spark-1.3-contributor] \
 *        [--expect-context 1048576] [--expect-max-tokens 131072] \
 *        [--expect-models muse-spark-1.3-contributor]
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

function fail(message) {
  console.error("SUBSTRATE-PROBE FAIL: " + message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const settingsPath = args.settings;
const packagesRoot = args.packages;
if (typeof settingsPath !== "string" || settingsPath === "") fail("--settings <settings.yaml> is required");
if (typeof packagesRoot !== "string" || packagesRoot === "") fail("--packages <dir> is required");
if (!existsSync(settingsPath)) fail("settings document missing: " + settingsPath);

const providerId = typeof args.provider === "string" && args.provider !== "" ? args.provider : "meta-model-api";
const modelId = typeof args.model === "string" && args.model !== "" ? args.model : "muse-spark-1.3-contributor";
const expectContext = Number(args["expect-context"] ?? 1048576);
const expectMaxTokens = Number(args["expect-max-tokens"] ?? 131072);
const expectModels = typeof args["expect-models"] === "string" && args["expect-models"] !== ""
  ? args["expect-models"].split(",").map((s) => s.trim()).filter(Boolean)
  : [modelId];

async function importPinned(packageName) {
  const candidate = path.join(packagesRoot, packageName, "lib", "index.js");
  if (!existsSync(candidate)) fail("pinned package not found: " + candidate);
  return import(pathToFileURL(candidate).href);
}

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail ?? "" });
  if (!ok) fail("check '" + name + "' failed: " + (detail ?? ""));
}

const cordis = await importPinned("@deepseek-ai/cordis");
const settingsFile = await importPinned("@deepseek-ai/dsh-settings-file");
const substrate = await importPinned("@deepseek-ai/dsh-llm-pi-ai");

// 1. A REAL cordis Context: the substrate and the settings provider are
//    written against it; stub contexts shaped like {} crashed here before.
const ContextCtor = cordis.Context ?? cordis.default?.Context;
if (typeof ContextCtor !== "function") fail("the pinned cordis package did not export a Context constructor");
const ctx = new ContextCtor();
try {
  // Probe seams: the substrate registers through the llm host seam and logs
  // through ctx.logger. A bare Context has neither — provide the narrowest
  // seams the substrate's registration path touches, and CAPTURE the real
  // adapter the substrate constructs (that capture is the probe's payload).
  if (!ctx.logger) ctx.logger = { info() {}, warn() {}, error() {}, debug() {} };
  let capturedAdapter;
  let capturedRoutes;
  let directory;
  ctx.llm = {
    registerAdapter(routes, adapter) {
      capturedRoutes = [...routes];
      capturedAdapter = adapter;
      return { replace() {} };
    },
    registerConfigurableProviders(entries) {
      directory = { entries, replace() {} };
      return directory;
    },
    registerModelDiscovery() {}
  };

  // 2. The REAL file settings provider over the REAL document.
  const provider = new settingsFile.FileSettingsProvider(ctx, {
    path: settingsPath,
    dshHome: path.dirname(settingsPath),
    watch: false,
    debounceMs: 0
  });
  const document = await provider.load();
  record("settings-loaded", document !== undefined && document !== null && typeof document === "object",
    "the real settings document parsed");

  const section = document && document["llm-pi-ai"];
  record("section-present", section !== undefined && section !== null && typeof section === "object",
    "the llm-pi-ai section exists in the document");

  // 3. The pinned substrate's own section schema validates the section.
  if (typeof substrate.Config !== "function") fail("the pinned substrate did not export its Config schema");
  const parsed = substrate.Config(section);
  record("section-schema-valid", parsed !== undefined && parsed !== null && typeof parsed === "object",
    "the substrate Config schema accepted the llm-pi-ai section");

  // 4. apply() on the real Context: resolveProfiles builds the real provider
  //    profiles and registerAdapter hands back the REAL adapter. The
  //    settings/authorization injections stay pending fibers (no services are
  //    provided), which is exactly why the probe is offline: no login flow and
  //    no settings re-source ever run, while provider resolution happens
  //    synchronously inside apply().
  substrate.apply(ctx, parsed);
  record("adapter-registered", typeof capturedAdapter === "object" && capturedAdapter !== null,
    "substrate.apply constructed and registered the real PiAiAdapter");
  record("route-registered", Array.isArray(capturedRoutes) && capturedRoutes.includes(providerId),
    "registered routes: " + JSON.stringify(capturedRoutes));

  // 5. The REAL adapter answers the route's model directory offline.
  const models = await capturedAdapter.listModels(providerId);
  const listedIds = models.map((m) => m.id);
  for (const expected of expectModels) {
    record("list-models:" + expected, listedIds.includes(expected),
      "route directory: " + JSON.stringify(listedIds));
  }

  const resolved = await capturedAdapter.resolveModel(providerId, modelId);
  record("resolve-model", resolved !== undefined && resolved !== null,
    "the substrate resolved " + providerId + "/" + modelId);
  const contextWindow = resolved && resolved.context && resolved.context.contextWindow;
  record("context-window", Number(contextWindow) === expectContext,
    "contextWindow=" + String(contextWindow) + " expected=" + String(expectContext));
  if (resolved && resolved.defaultMaxTokens !== undefined) {
    record("output-ceiling", Number(resolved.defaultMaxTokens) === expectMaxTokens,
      "defaultMaxTokens=" + String(resolved.defaultMaxTokens) + " expected=" + String(expectMaxTokens));
  } else {
    record("output-ceiling", false, "resolveModel exposed no defaultMaxTokens");
  }

  // 6. The reasoning map is the route's reasoningEfforts: every configured
  //    level must be offered by the substrate, and unconfigured Nexus levels
  //    must be absent (fail closed at the boundary, no omission-as-off).
  // The substrate exposes the route's reasoningEfforts map as
  // reasoning.efforts: [{ id, name }...] with reasoning.defaultEffort naming
  // the route's configured default (the real descriptor shape).
  const reasoningLevels = resolved && resolved.reasoning && Array.isArray(resolved.reasoning.efforts)
    ? resolved.reasoning.efforts.map((l) => (l && typeof l.id === "string" ? l.id : String(l)))
    : [];
  record("reasoning-map-present", reasoningLevels.length > 0,
    "offered levels: " + JSON.stringify(reasoningLevels));
  for (const level of ["minimal", "low", "medium", "high", "xhigh"]) {
    record("reasoning-level:" + level, reasoningLevels.includes(level),
      "offered levels: " + JSON.stringify(reasoningLevels));
  }
  for (const refused of ["off", "max"]) {
    record("reasoning-level-refused:" + refused, !reasoningLevels.includes(refused),
      "the contributor route must not offer " + refused);
  }

  try { if (typeof ctx.dispose === "function") await ctx.dispose(); } catch {}

  const record_ = {
    probe: "provider-substrate",
    settings: settingsPath,
    provider: providerId,
    model: modelId,
    status: "ready",
    checks
  };
  const rendered = JSON.stringify(record_, null, 2);
  console.log(rendered);
  // --out mirrors the record to a file: a supervisor that spawns this probe
  // with stdio ignored (sandboxed runners, service hosts) still gets the
  // full record without needing to capture piped output.
  if (typeof args.out === "string" && args.out !== "") {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.out, rendered + "\n");
  }
} catch (error) {
  try { if (typeof ctx.dispose === "function") await ctx.dispose(); } catch {}
  fail(error && error.stack ? error.stack : String(error));
}
