Refactor complete.

**Created**
- `src/slashes.ts` — `hasTrailingSlash`, `withoutTrailingSlash`, `withTrailingSlash`, `hasLeadingSlash`, `withoutLeadingSlash`, `withLeadingSlash`, `cleanDoubleSlashes` (+ `TRAILING_SLASH_RE`), moved verbatim.
- `src/protocol.ts` — `isRelative`, `HasProtocolOptions`, `hasProtocol` (overloads + impl), `isScriptProtocol`, `withHttp`, `withHttps`, `withoutProtocol`, `withProtocol` (+ `PROTOCOL_*` regexes), moved verbatim.

**Changed**
- `src/utils.ts` — removed moved code, kept `JOIN_LEADING_SLASH_RE` (only used by `joinURL`); imports needed helpers from `./protocol`/`./slashes` and does `export * from "./protocol"; export * from "./slashes";` so `src/utils.ts` still re-exports everything.
- `src/index.ts` — added `export * from "./protocol"; export * from "./slashes";`. Public API unchanged.
- `src/parse.ts` — `from "./utils"` → `from "./protocol"` for `hasProtocol` (avoids circular import).
- `src/url.ts` — `from "./utils"` → `from "./slashes"` for `withoutLeadingSlash, withTrailingSlash`.
- No behaviour changes.

**Verification**
- `npx tsc --noEmit` — pass
- `npx eslint .` — pass
- `npx vitest run --typecheck` — 14 files, 491 tests passed, no type errors
- `npx prettier -c src test` — **fails, unrelated to this change**: the only flagged file is `src/punycode.ts`, which I did not create or modify. Evidence: it is a vendored minified file (`// Tree-shaked + Minified version of punycode@2.1.1...`, `/* eslint-disable */ // @ts-nocheck`), and `npx prettier -c` on every file I touched/created (`src/index.ts src/utils.ts src/slashes.ts src/protocol.ts src/parse.ts src/url.ts src/encoding.ts src/query.ts test`) passes: “All matched files use Prettier code style!”. Fixing `punycode.ts` formatting is out of scope for this refactor and would touch vendored code, so I left it as-is.
