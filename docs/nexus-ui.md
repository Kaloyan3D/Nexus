# Nexus UI — architecture decisions

Phase 1 of the Nexus rebrand turns the installed DeepSeek Harness (DSH) web
client into the Nexus interface: a distinct product identity, a dark-first
premium theme, and structural polish — without adding any functionality and
without renaming any upstream package, API, or internal identifier.

## Layering: how the Nexus look is applied

Upstream priority order (per the task's architectural rules): official DSH
extension points first, theme tokens second, Nexus-owned code third, small
deterministic patches last. Direct upstream structural patching was avoided
entirely.

| Concern | Mechanism | Layer |
| --- | --- | --- |
| Brand slots (sidebar mark/name, hero mark) | @nexus/ui-brand client plugin registers `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark` | Official slots |
| Dark theme palette | @nexus/ui-brand calls `ctx.theme.overrideTokens(...)` with ~90 semantic tokens for light+dark | First-class theme extension |
| Motion, focus rings, radii | @nexus/ui-brand injects a small stylesheet scoped to stable data-attribute hooks | Nexus-owned CSS |
| Plugin composition | `config/home.cordis.patch.yml` inserts the @nexus/ui-brand row and disables `ui-brand-official` | Cordis patch layer (HOME, last) |
| App shell title / favicon / manifest | `scripts/Patch-NexusUi.ps1` edits the pinned `dsh-web-frontend` dist in place | Deterministic patch |
| Runtime title / hero copy / welcome copy | Same script edits renderer/conversation/settings-models client bundles | Deterministic patch |

## The @nexus/ui-brand package (`ui/nexus-ui/`)

- `package.json` — declares `dsh.client` (`platform: web`) and injects after
  runtime + conversation + sidebar + theme so the brand slots and theme service
  exist when the plugin applies. The host-side `lib/index.js` is deliberately
  inert (no services, no webserver rows): profiles without the web client
  (tui, headless) load it harmlessly.
- `lib/client.js` — the whole visual system:
  - `NEXUS_PALETTE` — the single central value set (one object per the
    "central values" requirement).
  - `NEXUS_THEME_TOKENS` — palette mapped onto DSH semantic tokens
    (`--dsw-alias-*`, `--dsw-specific-*`, `--dsw-static-*`) as
    `{ light, dark }` pairs, applied through the first-class
    `ctx.theme.overrideTokens` extension. The user's Appearance preference
    keeps working (the built-in light scheme is preserved and restyled).
  - `NEXUS_CSS` — structural refinements that tokens cannot express, scoped
    only to stable contract hooks: `:root` motion durations, `:focus-visible`
    outline, `[data-composer-card]` radius, hero-phase menu radius,
    scrollbar styling. Never hashed CSS-module class names.
  - Brand components — `NexusMark` (geometric hexagonal node ring + hub
    core, inline SVG, violet `#7C5CFF`) and `NexusBrandName` ("NEXUS"
    wordmark with tracked-out spacing). Registered with the exact nested
    `ctx.slots.inject` pattern the official brand plugin uses, so the fallback
    DeepSeek fish can never render (the official row is disabled in the home
    patch for determinism rather than relying on shadow priority).
- `nexus-favicon.svg` — the same mark on a dark rounded tile; replaces the
  DeepSeek whale favicon.
- `patch-copy.json` — single source for every brand copy string the patch
  script applies (title, hero headlines en+zh, welcome notice en+zh), kept as
  data so the PowerShell driver stays pure ASCII (repo convention).

## Why patches at all

Five strings are not reachable through any official extension point:
- `dist/index.html` `<title>` (static shell title)
- `dist/favicon.svg` (static file, no injection hook)
- `dist/manifest.webmanifest` (PWA identity)
- `dsh-client-ui-renderer` `productTitle` (runtime `document.title`)
- `dsh-client-ui-conversation` hero headline dict (locale registration
  throws on duplicates; the dict is bundle-owned)
- `dsh-client-ui-settings-models` `WELCOME_NOTICE_COPY` (same reason)

These are the only upstream files touched, all under
`scripts/Patch-NexusUi.ps1`.

## Patch script design (`scripts/Patch-NexusUi.ps1`)

- Version-guarded: refuses to run unless `dsh-web-frontend` is exactly
  `0.1.1-rc.2` (the pinned runtime).
- Fail-closed: every replacement requires the source string to appear exactly
  once. Zero matches with the target already present = already patched
  (second run, no-op). Zero matches without the target = structure changed →
  throw. Multiple matches = ambiguous → throw. Welcome-notice block matched as
  a unit (regex, CRLF/LF tolerant), then rewritten in place.
- Idempotent: running twice leaves byte-identical files (asserted by the test
  suite) and the package copy is refreshed from the source tree.
- ASCII-only driver; all copy text lives in `ui/nexus-ui/patch-copy.json`
  (read as explicit UTF-8), keeping the repo's PowerShell files ASCII.
- Installs `@nexus/ui-brand` into `data/profiles/node_modules/@nexus/ui-brand`
  — the flat module fallback directory the runtime already heals with
  symlinks for its own closure; a real foreign directory survives that
  process and `npm ci` never touches `data/`.
- Appends `ui-theme: preference: dark` to `data/settings.yaml` only when no
  `ui-theme` section exists — a user's explicit preference is never
  overwritten. `config/settings.yaml` carries the dark default for fresh
  installs.
- Called by `scripts/Setup.ps1` right after `Patch-ControlRoomUi.ps1`
  (which covers update paths too, since Update delegates to Setup).

## Theme mapping highlights

- Backgrounds: `bg-base #09090B`, `bg-layer-1 #0D0D10`, `bg-layer-2 #111116`,
  `bg-layer-3 / module-platform / bubble #17171D`, `bg-overlay / menu /
  tooltip / toast #1F1F26`.
- Borders: l1/l2/l3/l4 from `#27272F` at increasing opacity.
- Text: primary `#F5F5F7`, secondary `#A1A1AA`, tertiary/caption `#71717A`,
  dimmed `#52525B`.
- Accent: brand/state-business/button-primary `#7C5CFF`, hover `#9177FF`,
  info `#49C6E5`; success `#32D583`, warning `#F5A524`, error `#F04438`.
- Interactive: hover `#FFFFFF12`, active `#FFFFFF1F`, hover-accent
  `#7C5CFF33`.
- Sidebar: fill `#0D0D10`, nav active `#17171D` + violet accent, nav hover
  `#111116`.
- Shadows: minimal (lv1 1px / lv2 4px / lv3 12px at low alpha).
- Light scheme: white surfaces, `#E4E4E7` borders, `#18181B` text, same
  violet accent — a coherent counterpart rather than the upstream default.

## Mode-selection UI

The agent-preset seat (Control Room picker) is token-driven, so the Nexus
palette flows into it automatically. Structural polish is limited to the
stable contract hooks (`[data-phase]`, `[data-composer-card]`,
`button[aria-haspopup="menu"]` in hero phase); hashed CSS-module class names
are never targeted.

## Verification

- `tests/Harness.Tests.ps1` — Nexus section asserts real-install state,
  then builds a CRLF fixture (minimal dist/bundles/settings), runs the patch
  twice (idempotency by SHA-256), and proves fail-closed behavior on a
  tampered upstream file.
- `scripts/Doctor.ps1` — permanent Nexus checks (package installed, home
  patch rows, dist title/favicon/manifest, renderer title, dark default).
- Manual: headless-browser screenshot pixel sampling (sidebar #0D0D10, page
  #09090B, violet mark at the sidebar brand position, no DeepSeek blue
  glow), boot graph contains `@nexus/ui-brand` and no
  `dsh-client-ui-brand-official`, served title "Nexus".

## Phase 2 limitations

- Hero glow behind the brand mark stays the upstream blue (`#6187D8`,
  hardcoded in the conversation bundle; left as-is for Phase 1 stability —
  it is a glow, not the fish).
- The connection demo answer in `dsh-client-ui-connection` still mentions
  DeepSeek (demo-only copy, untouched).
- Browser favicon is updated in `dist/`, but any already-pinned/installed
  PWA caches may keep the old icon until reinstall.
- The Nexus theme is applied at client boot; a flash of the upstream dark
  theme is possible before plugin application (the boot script already sets
  the dark attribute, so this is minimal).
