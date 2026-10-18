Root cause found and fixed. Report:

**Root cause — `src/encoding.ts:165-167`:**
`decodeQueryValue()` was `return decode(text)` — it called `decodeURIComponent` directly without first converting `+` to a space. Per `application/x-www-form-urlencoded` semantics (and symmetric with this repo's own `encodeQueryValue`, which encodes spaces as `+` at `src/encoding.ts:59-64`), a literal `+` in a query string means a space; a literal plus is transmitted as `%2B`. So `getQuery("http://example.com/?q=a+b")` → `parseQuery` (`src/query.ts:65`) → `decodeQueryValue("a+b")` returned `"a+b"` instead of `"a b"`.

Note the asymmetry that made it obvious: `decodeQueryKey` right above it (`src/encoding.ts:153-155`) already did `decode(text.replace(PLUS_RE, " "))` and has tests proving `+` → space (`test/encoding.test.ts:200`). `decodeQueryValue` lost the same `.replace(PLUS_RE, " ")` — that was the regression.

**Fix (one line, `src/encoding.ts`):**
```ts
export function decodeQueryValue(text: string): string {
  return decode(text.replace(PLUS_RE, " "));
}
```
This mirrors `decodeQueryKey` and round-trips correctly: `encodeQueryValue("a b")` → `"a+b"` → `decodeQueryValue("a+b")` → `"a b"`, while `encodeQueryValue("a+b")` → `"a%2Bb"` → `decodeQueryValue("a%2Bb")` → `"a+b"`.

**Other modules checked for the same mistake:**
- `src/query.ts` `parseQuery` — delegates to `decodeQueryKey`/`decodeQueryValue`; fixed by the change. No other `+` handling there.
- `src/utils.ts` `getQuery` — delegates to `parseQuery(parseURL(input).search)` (`src/utils.ts:394-398`); fixed transitively. Same for `normalizeURL`/`resolveURL` which round-trip through `parseQuery`/`stringifyQuery`.
- `src/url.ts` `$URL` constructor — uses `parseQuery(parsed.search)` (`src/url.ts:36`); fixed transitively.
- `decode` (generic) and `decodePath` (`src/encoding.ts:125-143`) intentionally do *not* convert `+` → space — correct, since `+` is literal in paths/hash; `encodePath` encodes `+` as `%2B` (`src/encoding.ts:99`). No change needed there.

**Verification:**
- `npm ci` fails in this repo (it uses `pnpm-lock.yaml`, no `package-lock.json`), and plain `npm install` fails on a peer conflict (`unbuild` wants TS 5 vs root TS 6), so I installed with `npm install --legacy-peer-deps` (400 packages OK).
- `npx vitest run`: **13 test files, 489 tests, all passed.**
- I did not add new tests; existing `decodeQueryKey` `+` tests plus the full suite (query/encoding/utilities/normalize) cover the behavior.