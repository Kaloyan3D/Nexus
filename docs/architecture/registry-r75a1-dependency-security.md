# R7.5A.1 dependency security investigation

Date: 2026-10-12. Baseline lock at `abb1d13`; all affected nodes are production dependencies (dev=false). The npm count of 14 is vulnerable package entries, including six low-severity entries (five propagated from the shared vulnerable leaf), not 14 distinct advisories. There are 22 underlying advisory identifiers. No risk acceptance is used: every underlying advisory is remediated by nine exact overrides. DSH 0.1.1-rc.2, openai-oauth 2.0.0 and the vendored agent bytes remain pinned.

## Ownership and exact lock paths

Every node below is `node_modules/<package>` in the lock. Root paths are actual resolved lock edges; all immediate parents and their constraints are retained in `tmp/r75a1-evidence/dependency-paths.json`. Only openai-oauth is a direct affected dependency; all others are transitive.

| Package | Baseline → candidate | Exact dependency chain from aih-global-runtime |
| --- | --- | --- |
| `@ai-sdk/gateway` | 3.0.66 → 3.0.66 | `openai-oauth` → `ai` → `@ai-sdk/gateway` |
| `@ai-sdk/openai` | 3.0.41 → 3.0.41 | `openai-oauth` → `@openai-oauth/ai-sdk` → `@ai-sdk/openai` |
| `@ai-sdk/provider-utils` | 4.0.19 → 4.0.33 | `openai-oauth` → `@openai-oauth/ai-sdk` → `@ai-sdk/provider-utils` |
| `@modelcontextprotocol/sdk` | 1.30.0 → 1.31.0 | `@deepseek-ai/dsh` → `@deepseek-ai/dsh-mcp-client` → `@modelcontextprotocol/sdk` |
| `@openai-oauth/ai-sdk` | 2.0.0 → 2.0.0 | `openai-oauth` → `@openai-oauth/ai-sdk` |
| `ai` | 6.0.116 → 6.0.116 | `openai-oauth` → `ai` |
| `fast-uri` | 3.1.5 → 3.1.8 | `@deepseek-ai/dsh` → `@deepseek-ai/dsh-mcp-client` → `@modelcontextprotocol/sdk` → `ajv` → `fast-uri` |
| `hono` | 4.13.3 → 4.13.7 | `@deepseek-ai/dsh` → `@deepseek-ai/dsh-mcp-client` → `@modelcontextprotocol/sdk` → `hono` |
| `ip-address` | 10.5.0 → 10.7.1 | `@deepseek-ai/dsh` → `@deepseek-ai/dsh-mcp-client` → `@modelcontextprotocol/sdk` → `express-rate-limit` → `ip-address` |
| `js-yaml` | 4.3.1 → 4.3.2 | `@deepseek-ai/dsh` → `js-yaml` |
| `openai-oauth` | 2.0.0 → 2.0.0 | `openai-oauth` |
| `proxy-addr` | 2.0.7 → 2.0.8 | `@deepseek-ai/dsh` → `@deepseek-ai/dsh-mcp-client` → `@modelcontextprotocol/sdk` → `express` → `proxy-addr` |
| `qs` | 6.15.3 → 6.16.0 | `@deepseek-ai/dsh` → `@deepseek-ai/dsh-mcp-client` → `@modelcontextprotocol/sdk` → `express` → `qs` |
| `sharp` | 0.35.3 → 0.35.5 | `@deepseek-ai/dsh` → `@deepseek-ai/dsh-base` → `@deepseek-ai/dsh-attachment-local` → `sharp` |

## Advisory matrix

All rows: production applicability; transitive ownership and exact paths as above. Chosen version is fixed and verified installed. Links identify advisory evidence retrieved from GitHub advisory API; trigger summaries are independently traced against the installed source.

| Advisory | Severity / package | Trigger | Fixed version used |
| --- | --- | --- | --- |
| [GHSA-2883-xcg3-v3hh](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh) | high / `js-yaml` | js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources | 4.3.2 |
| [GHSA-2vr4-cq9g-pvrc](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-2vr4-cq9g-pvrc) | moderate / `ip-address` | no classifier recognizes the NAT64 local-use range 64:ff9b:1::/48, allowing SSRF and trust-boundary bypass | 10.7.1 |
| [GHSA-4mjr-xmp4-gh2g](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g) | moderate / `qs` | qs: Denial of Service via Attacker Controlled isBuffer | 6.16.0 |
| [GHSA-5jgf-p345-68v8](https://github.com/fastify/fast-uri/security/advisories/GHSA-5jgf-p345-68v8) | high / `fast-uri` | host confusion via skipped IDN canonicalization on scheme-relative references | 3.1.8 |
| [GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h) | high / `@modelcontextprotocol/sdk` | MCP TypeScript SDK: OAuth client could send credentials to an authorization server chosen by the MCP server | 1.31.0 |
| [GHSA-866g-f22w-33x8](https://github.com/advisories/GHSA-866g-f22w-33x8) | low / `@ai-sdk/provider-utils` | Uncontrolled Resource Consumption issue | 4.0.33 |
| [GHSA-crvj-82cr-hjcx](https://github.com/honojs/hono/security/advisories/GHSA-crvj-82cr-hjcx) | moderate / `hono` | Hono: Query parser reads parameters after the URL fragment, causing cache-key and proxy interpretation differentials | 4.13.7 |
| [GHSA-f65p-4m7j-42xc](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc) | high / `fast-uri` | server-side request forgery via malformed IPv6 normalization | 3.1.8 |
| [GHSA-fph4-wmhf-6fwf](https://github.com/fastify/fast-uri/security/advisories/GHSA-fph4-wmhf-6fwf) | high / `fast-uri` | server-side request forgery via repeated hostname percent-decoding | 3.1.8 |
| [GHSA-g6gw-c38x-mqfc](https://github.com/honojs/hono/security/advisories/GHSA-g6gw-c38x-mqfc) | moderate / `hono` | Hono: Unbounded dot-notation nesting in `parseBody()` can cause memory exhaustion | 4.13.7 |
| [GHSA-gqvv-2mrq-wpjv](https://github.com/honojs/hono/security/advisories/GHSA-gqvv-2mrq-wpjv) | moderate / `hono` | Hono: Incomplete fix for CVE-2026-39408: `toSSG()` still writes files outside the output directory | 4.13.7 |
| [GHSA-h3mg-xc3c-68pw](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-h3mg-xc3c-68pw) | moderate / `ip-address` | Address6 builds a parse diagnostic proportional to the input with no length bound, allowing a single long string to stall or crash the process | 10.7.1 |
| [GHSA-hrr3-gc8f-f4qj](https://github.com/fastify/fast-uri/security/advisories/GHSA-hrr3-gc8f-f4qj) | moderate / `fast-uri` | inconsistent host case normalization via percent-encoded octets | 3.1.8 |
| [GHSA-hxh3-vqpv-xpqv](https://github.com/honojs/hono/security/advisories/GHSA-hxh3-vqpv-xpqv) | moderate / `hono` | hono/jsx renders plain strings unescaped in boundary components, leading to XSS | 4.13.7 |
| [GHSA-j6r3-76f7-8jcv](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-j6r3-76f7-8jcv) | moderate / `ip-address` | isInSubnet() and isHostInSubnet() compare addresses of different families as if they shared an address space, allowing an allowlist check to admit an address outside its range | 10.7.1 |
| [GHSA-jqcg-44mw-7w3h](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h) | critical / `proxy-addr` | proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet | 2.0.8 |
| [GHSA-jqff-g426-hqxp](https://github.com/fastify/fast-uri/security/advisories/GHSA-jqff-g426-hqxp) | high / `fast-uri` | host confusion via percent-encoded scheme normalization | 3.1.8 |
| [GHSA-qw65-cvwx-89v3](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3) | high / `fast-uri` | authority injection via an unvalidated port in serialize | 3.1.8 |
| [GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c) | high / `sharp` | sharp: Vulnerabilities in libheif: GHSA-g89c-p67h-r497 and GHSA-2jg2-4ch7-h545 | 0.35.5 |
| [GHSA-rpw4-54j3-4h4q](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rpw4-54j3-4h4q) | moderate / `ip-address` | Address6.isLinkLocal() recognizes fe80::/64 rather than fe80::/10, allowing SSRF and trust-boundary bypass to on-link hosts | 10.7.1 |
| [GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) | high / `sharp` | sharp : Vulnerability in librsvg dependency CVE-2026-96889 | 0.35.5 |
| [GHSA-x5fp-wj9c-mxmx](https://github.com/ljharb/qs/security/advisories/GHSA-x5fp-wj9c-mxmx) | moderate / `qs` | qs array-limit bypass via bracket-key comma parsing | 6.16.0 |

Propagation-only package entries: `@ai-sdk/gateway`, `@ai-sdk/openai`, `@openai-oauth/ai-sdk`, `ai`, and direct `openai-oauth` inherit GHSA-866g-f22w-33x8 through provider-utils. Their versions stay unchanged; updating that shared leaf removes these entries. `fixAvailable:false` describes npm automated top-level remediation, not the absence of a fixed leaf.

## Actual usage, input boundaries and compatibility

### @modelcontextprotocol/sdk

DSH MCP client initializes stdio or StreamableHTTP transports from plugin configuration. Its HTTP factory supplies headers only, not authProvider; no withOAuth/auth/fetchToken use in that client. SDK server exports/examples are installed but the owned webserver and OAuth service use node:http. OAuth credential redirection requires OAuth credentials plus a hostile MCP authorization issuer. Do not infer safety from headers alone: SDK is updated, and future bundled OAuth providers still require expectedIssuer.

Compatibility: Same major, within dsh-mcp-client ^1.12.0.

### fast-uri

AJV imports fast-uri as its URI resolver; MCP external tool schemas reach JSON-schema validation. Owned outbound probes use URL/fetch rather than fast-uri. The six normalization/serialization defects become SSRF only when a URI normalization result governs an outbound request or host policy; that sink was not found in Nexus/AJV. External schema parsing remains exposed.

Compatibility: Same major, within AJV ^3.0.1.

### js-yaml

DSH command/app boot, presets and Cordis include parse configurable YAML. Default merge semantics admit repeated empty merge sources; configuration/plugin includes are an external file boundary. YAML inputs are not all trusted solely because the main preset is shipped.

Compatibility: Patch within ^4.1.0/^4.2.0; normal merge semantics retained.

### proxy-addr

Express request.ip/ips uses proxy-addr. SDK imports Express in its server/auth helpers, not DSH MCP client transport; Nexus DSH webserver and openai-oauth HTTP services use node:http. No production Express trust-proxy setting or IPv4-mapped shorthand was found. The advisory needs a misconfigured trusted subnet and attacker X-Forwarded-For; installed server helpers can expose this if integrated later.

Compatibility: Patch within Express ^2.0.7.

### sharp

DSH attachment-local feeds supplied image bytes to sharp.metadata and full raster decode. MCP image results and user attachments are external inputs. Media-type/size/dimension checks do not prove native decoder safety: format detection runs before some admission checks. Treat decoder vulnerabilities as potentially production-reachable and update the bundled libvips libraries.

Compatibility: Patch within dsh-attachment-local ^0.35.3; Node >=20.9 satisfied by 24.18.1.

### hono

Installed under SDK. SDK Hono server helper/examples exist; DSH MCP client uses SDK Client, and Nexus webserver/OAuth services use node:http. No Hono toSSG, parseBody dot mode, JSX boundary rendering or query-cache route is wired in owned production code. These four server features require separately exposing attacker routes/content.

Compatibility: Patch within SDK ^4.11.4.

### ip-address

SDK Express auth helpers depend on express-rate-limit, whose ipKeyGenerator uses Address6 parsing/subnet logic. No owned SSRF allowlist uses its classifiers. Link-local/NAT64 classifier bugs require a classifier-based trust decision; mixed-family subnet bugs require different-family operands; unbounded diagnostic input can affect code accepting oversized IP strings. Production node:http services do not use this middleware.

Compatibility: Patch within express-rate-limit ^10.2.0.

### qs

Express/body-parser parse extended query/form data. No owned qs comma:true or parse-to-stringify round trip found; SDK Express server helpers remain included. Array overflow requires comma mode with bracket keys; isBuffer crash requires preserved constructor data followed by stringify. Node:http services use their own request handling.

Compatibility: Same major within Express ^6.14.0 and body-parser ^6.15.2.

### @ai-sdk/provider-utils

openai-oauth CLI -> ai and @openai-oauth/ai-sdk -> @ai-sdk/openai use JSON/error response handlers on remote provider HTTP responses. A hostile/compromised upstream can supply an oversized body; this is a production response boundary. Updated handlers use readResponseWithSizeLimit. The upstream default is still 2 GiB, so advisory closure is not a claim of a tight Nexus memory budget.

Compatibility: Exact transitive 4.0.19 constraints require deliberate override to 4.0.33. Adapter loading, actual OpenAI provider completion against a mocked fetch, and JSON success/oversize refusal tested; a nested provider 3.0.12 is added for new utility ABI, leaving existing provider consumers intact.

Source evidence: installed `@deepseek-ai/dsh-mcp-client/lib/index.js` (createTransport, startConnection); `dsh-attachment-local/lib/index.js` (probeImage, detectImage); `dsh-app-boot/lib/index.js` and `cordis-plugin-include`; `dsh-host-webserver/lib/index.js`; `openai-oauth/dist/cli.js` and HTTP service chunks; SDK client/streamableHttp and server/express/auth; `ajv/dist/runtime/uri.js`; `express/lib/request.js`; `express-rate-limit/dist/index.mjs`; utility `dist/index.js` response handlers. These installed sources were read, not executed with real credentials.

## Manifest and lock decisions

`runtime/package.json` adds exact overrides for SDK 1.31.0, fast-uri 3.1.8, js-yaml 4.3.2, proxy-addr 2.0.8, sharp 0.35.5, hono 4.13.7, ip-address 10.7.1, qs 6.16.0 and provider-utils 4.0.33. No direct dependency pin changes. Lock resolution was performed in disposable `tmp/r75a1-dependencies/app` with existing lock, `--package-lock-only --ignore-scripts --legacy-peer-deps`, then inspected before copying to source. No audit fix command used.

The lock changes those nine packages, sharp 0.35.5 platform assets and libvips 1.3.4 assets, and adds nested `@ai-sdk/provider-utils/node_modules/@ai-sdk/provider` 3.0.12 (previous consumer ABI remains available). A pre-existing vendored-agent lock discrepancy was corrected: resolved path now matches the manifest `file:../runtime/vendor/...`; its integrity is the actual unchanged archive SHA512 `gIs1cjZOSttokWZ+MKPhPzvxFC67R8a9OzfijiJd+e3JsAXw9DhY3XBVuoxO7rmYUozdC7VqK4piF+0wsyhGLQ==`. Archive bytes equal `git show abb1d13:runtime/vendor/...`; no vendor code was edited. Actual RuntimeRoutingTrace exercises its installed request seam independently.

## Residual risks

Both production and full npm audits are separately retained; neither suppresses advisories. Native Windows binaries, paid/live provider transport, interactive terminal operations and provider memory/load limits remain unverified. Patched MCP SDK alone is insufficient for future bundled OAuth providers lacking expectedIssuer; Nexus currently configures none. Native image processing still requires ordinary resource controls. The provider-utils 2 GiB default remains a workload risk, not an unremediated advisory or a proven Nexus exploit. No security acceptance owner is invented because no advisory is accepted.
