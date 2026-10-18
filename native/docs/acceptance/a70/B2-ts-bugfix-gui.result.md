Root cause found and fixed. Verified with the project's test suite.

**Root cause — `src/encoding.ts:165-167`:**
`decodeQueryValue()` was just `decode(text)` (`decodeURIComponent`), with no `+` → space conversion. Per `application/x-www-form-urlencoded` semantics (and symmetric with this repo's own `encodeQueryValue`, which encodes space as `+` at `src/encoding.ts:59-71`), a literal `+` in a query value means space, while a literal plus is encoded as `%2B`. So `getQuery("http://example.com/?q=a+b")` → `parseQuery` (`src/query.ts:65`) → `decodeQueryValue("a+b")` returned `"a+b"` instead of `"a b"`. Notably the sibling `decodeQueryKey` (`src/encoding.ts:153-155`) already did `text.replace(PLUS_RE, " ")` — the value decoder was the odd one out, which is why this looks like a regression from someone dropping that line.

**Fix (`src/encoding.ts`):**
```ts
export function decodeQueryValue(text: string): string {
  return decode(text.replace(PLUS_RE, " "));
}
```
now mirrors `decodeQueryKey`. Round-trips correctly: `"a b"` ⇄ `"a+b"`, `"a+b"` ⇄ `"a%2Bb"` (the `%2B` contains no literal `+`, so it's untouched by the replace and decodes back to `+`).

**Other modules checked for the same mistake:**
- `decode` (raw `decodeURIComponent`) — correctly leaves `+` alone (generic decoder, also used for paths/hashes where `+` is literal).
- `decodePath` — correctly does NOT convert `+` (plus is literal in paths).
- `parseAuth`/`parseHost` (`src/parse.ts`) use `decode` — correct.
- `parseQuery`/`getQuery`/`withQuery`/`filterQuery`/`normalizeURL`/`resolveURL` all funnel through `decodeQueryValue`/`decodeQueryKey`, so they're all fixed by this one change. `grep PLUS_RE` confirms the only decode site missing the replacement was `decodeQueryValue`.

**Tests:** `npm install --legacy-peer-deps` (plain `npm ci` fails — repo ships `pnpm-lock.yaml`, no `package-lock.json`; plain `npm install` fails on an `unbuild`/`typescript` peer conflict), then `npx vitest run`: **13 files, 489 tests, all passed**.