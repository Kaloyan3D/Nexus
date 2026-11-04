Done — the `withoutQuery` feature was already implemented in the working copy (from prior sessions) and I verified/completed it.

What changed:
- `src/utils.ts`: added `withoutQuery(input: string, keys: string | string[]): string` next to `withQuery`/`filterQuery`. It parses the URL with `parseURL`, splits the raw `search` on `&` (preserving raw encoding/order of kept params), drops every pair whose key decodes (via `decodeQueryKey`) to one of the requested keys (request keys are also decoded, so `"a%20b"` matches `"a b"`, and `+` decodes as space), then re-stringifies with `stringifyParsedURL`. If nothing was removed it returns `input` unchanged; if no params remain the `?` disappears (handled by `stringifyParsedURL` with empty search).
- Export: `src/index.ts` already does `export * from "./utils"`, so `withoutQuery` is exported from the package entry point like the other helpers — no change needed.
- `test/query.test.ts`: imports `withoutQuery` and has a `describe("withoutQuery")` block with ~30 cases covering: basic removal (single/array keys), removing all keys, missing key unchanged, empty keys array, no query, hash preservation/removal, hash-only inputs, relative URLs (`foo?…`, `./foo?…`, `../foo?…`, `?…`), repeated keys all removed, empty values/bare keys, order preservation, encoding preservation, decoded-key matching (`a%20b`, `a+b` vs `a b`), full/protocols-relative URLs, values containing `=`/`?`.
- `README.md`: added `### withoutQuery(input, keys)` entry in the API docs section with description and example.

Verification:
- Installed deps with `npm install --legacy-peer-deps` (needed: project uses pnpm lockfile, `npm ci` unavailable, plain install had a TS peer conflict; pnpm binary unavailable).
- `npx tsc --noEmit` — pass.
- `npx vitest run --typecheck` — 14 files, 526 tests passed, no type errors.
- `npx prettier -c src/utils.ts test/query.test.ts` — pass (the previously failing prettier check now passes).
- `npx eslint .` — pass.