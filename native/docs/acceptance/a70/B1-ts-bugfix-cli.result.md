Verification failure fixed and re-run — both now pass.

**Why the last verification command failed:** the failure was in my ad-hoc check harness, not in the fix:
1. First attempt used `require('./node_modules/jiti/lib/index.js')` — that path doesn't exist (`MODULE_NOT_FOUND`). The installed jiti resolves as `require('jiti')` → `/work/src/node_modules/jiti/lib/jiti.cjs`.
2. Second attempt fixed the import but called `createJiti(__filename)` from `node -e`, where `__filename` is literally `[eval]` — jiti requires an absolute file path, so it threw `ERR_INVALID_ARG_VALUE`.

**Corrected verification (passes):**
```
node -e "const {createJiti}=require('jiti'); const j=createJiti(process.cwd()+'/repro.cjs'); const {getQuery,parseQuery}=j('./src/index.ts'); ..."
{"q":"a b"}   <- getQuery('http://example.com/?q=a+b')
{"q":"a b"}   <- parseQuery('q=a+b')
{"q":"a+b"}   <- parseQuery('q=a%2Bb')  (literal plus still preserved)
```

**Full suite:** `npx vitest run` → 13 files, 489 tests, all passed.

**Fix (unchanged, already in place in `src/encoding.ts:165-167`):** `decodeQueryValue` was `decode(text)` and is now `decode(text.replace(PLUS_RE, " "))`, mirroring `decodeQueryKey` — restoring the `+` → space decoding that `encodeQueryValue` (space → `+`) requires.