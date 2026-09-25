# DSH routing authority build

Nexus pins `@deepseek-ai/dsh-agent@0.1.1-rc.2-nexus.1` from
`runtime/vendor/deepseek-ai-dsh-agent-0.1.1-rc.2-nexus.1.tgz`. Its SHA-256 is
`30843a44a6b2aa03d6841559a97f5533572f480793d6e58087a220f6a7861f5d`.

The source change is `dsh-agent-routing-authority.patch`, based on the upstream
`dsh-v0.1.1-rc.2` tag at commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.
The patch changes the source types, selection logic, tests, README, and agent
package version. It contains no installed `node_modules` edits.

To rebuild in a full checkout of that tag:

1. Apply the patch at the repository root.
2. Install dependencies with `pnpm install --frozen-lockfile`.
3. Run `node node_modules/vitest/vitest.mjs run packages/core/agent/tests/model-selection.spec.ts`.
4. Run `node node_modules/typescript/bin/tsc -b packages/core/agent`.
5. From `packages/core/agent`, bundle `lib/types/index.js` and
   `lib/types/invariant.js` with tsdown for Node ES2024 into `lib`, with
   dependencies external. Emit `.js` names for the ESM package exports.
6. Run `npm pack --ignore-scripts` from that package directory.

The vendored tarball was built from the patched source with the package-local
TypeScript output and tsdown. The full workspace tsdown build was attempted
but its Typert analyzer required unrelated workspace dependencies absent from
the focused install. The focused build, package tests, and Nexus composed
runtime tests passed.
