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

## Phase 3 — Task Control Room (expanded detail surface)

The compact drawer answers "what is Nexus doing right now". The Control Room
answers "how did this task get here, what happened during execution, what
verification ran, why did a failure/review happen" — from REAL Nexus records
only. No mocked timelines, no inferred attempts, no fake verification, no
synthetic model transitions.

### Surfaces and interaction

- The compact drawer is unchanged. When a task is bound, its header gains an
  expand action (between the status pill and the collapse button).
- Expanding widens the drawer to `min(600px, calc(100vw - 24px))` (the compact
  drawer keeps `min(340px, calc(100vw - 40px))`) and swaps the body for the
  TASK CONTROL ROOM.
- The room has four tabs: **Overview / Activity / Verification / Files**.
  Active tab and room-open state persist in localStorage
  (`nexus.controller.room.view`, `nexus.controller.room.open`).
- Escape collapses the room first, then the drawer. The room never registers
  into `details` or `conversation.details.tool`; it is the same
  `shell.overlay` seat as the compact drawer.
- READ ONLY: the room has no reroute/retry/approve/complete/Codex/edit/stage
  actions. File paths are shown and copyable; nothing opens files.
- Detail polling (`/nexus/control-room.json`, ~4 s while the room is open)
  never touches the compact 1.5 s path, which stays lightweight.

### Data sources (authoritative, per section)

| Section | Source | Semantics |
| --- | --- | --- |
| Status | derived display state (same as compact) | — |
| Root Executor | **last non-escalation routed decision** for the task | review/escalation decisions never replace the primary executor |
| Routing history | every `decisions.jsonl` record for the task, oldest first | PRIMARY = no `escalatedFrom`, class ≠ `codex_review`; REVIEW = `codex_review`; ESCALATION = `escalatedFrom` present, class ≠ `codex_review`. Classification is routing semantics, never model-name guessing |
| Lifecycle | workspace `.ai-harness/state/decisions.jsonl` (`task-created`, `execution-class-selected`, …) | — |
| Attempts | `runs/<task>/attempts.jsonl` grouped by `sequence` | `failed` = failed record; `passed` = started record, no failed record, AND ledger `complete`; else `started`. Attempt 0 never exists — the GUI never calls begin-attempt. Durations only from real start→failure timestamps |
| Verification | `runs/<task>/evidence.json` else ledger `verification.outcomes` | status passed/failed/partial/not-run; checks carry name/status/evidence; acceptance criteria + scopePass from the artifact |
| Failures | ledger `failureSignatures` (first-seen order) + routing-state `sameFailureCount` | — |
| Reviews | `codex_review` decisions + `codexCalls` + `reviewRequired` + `review-packet.json` meta (question, relevant-file count, diff length — never the diff or file contents) + `review-result.json` (verdict, needsBroaderContext, findings severity/location/problem — never evidence text) | — |
| Files | live git porcelain + numstat (worktree + index), cached ~10 s | untracked rows show no line counts; non-repo → `Git unavailable` |

### Detail endpoint

`GET /nexus/control-room.json?session=<id>` — registered through the same
Cordis `webServer` lifecycle injection as the compact route. The session id
resolves server-side to the authoritative binding. Envelope
`{schemaVersion: 1, generatedAtUtc, state, binding, task, execution,
routingHistory, lifecycle, attempts, verification, failures, reviews, git,
controller}`. Unbound sessions get an `idle` envelope; build failures get an
`error: 'control-room-unavailable'` envelope — both HTTP 200,
`application/json; charset=utf-8`, `cache-control: no-store`.

The snapshot is cached per session against a key of source-file mtimes (hard
60 s cap); git detail is cached ~10 s. Immutable historical records are never
recomputed on every poll.

### Fail-closed behavior

Each subsystem degrades independently: a corrupt routing line is skipped, a
corrupt evidence artifact falls back to ledger outcomes (or `not-run`), a
corrupt attempts line is skipped, and a missing/non-repo workspace degrades
the Files view only. No corrupt subsystem can erase healthy sections.

## Phase 1.5 — compact premium layout

Follow-up polish pass. All behavior preserved; no controller/runtime changes.

### Changes
- **Sidebar**: expanded default width 288px (was 280) via a deterministic
  patch of the app-shell layout bundle (`dsh-client-ui-layout`
  `panels.sidebar === 0 ? 280 → 288`). Collapsed rail (56px) and
  user-dragged widths (clamp 264–420) unchanged. Density: logo row 52px,
  inline padding 10px (Nexus CSS).
- **Official logo**: `ui/nexus-ui/assets/nexus-logo.png` (lockup: hexagon
  mark + NEXUS wordmark, 1056×282 content band) replaces the inline SVG mark.
  The icon-only form is `ui/nexus-ui/assets/nexus-mark.png` (288×288 crop,
  regenerated deterministically by `ui/assets-regenerate-mark.ps1`). The
  client plugin renders both images and swaps them with CSS keyed on the
  stable `[data-sidebar-collapsed]` frame attribute; assets are copied into
  `dist/assets/` by the patch script (step 2d) and referenced from
  `/assets/`.
- **Hero headline**: 26px → 30px (target band 28–32), stack gap 12→8, hero
  padding 24→16, composer-hero bottom clearance 32→16, hero input min-height
  52→44 (Nexus CSS, suffix selectors scoped to `[data-phase="hero"]`).
- **Main content width**: `--dsh-chat-content-width` 748px → 900px on
  `[data-phase]`, widening the conversation column and composer
  (`--dsh-composer-card-max-width` derives from it).
- **Primary action violet**: composer send button switched from
  `--dsw-alias-button-info-*` (cyan) to `--dsw-alias-button-primary-*`
  (violet) via deterministic bundle patch; hero glow recolored
  `#6187D8 → #7C5CFF`. Cyan remains only on semantically informational
  controls.
- **Composer**: elevated surface (input-major token → `#17171D`), clearer
  border (l2-darkmode-thin token → full `#27272F`), 10px radius, violet
  `:focus-within` ring (`0 0 0 3px #7C5CFF26`), 15px base font.
- **Hero chips** (mode seat + workspace): shared Nexus surface
  (hover bg + l2 border, 8px radius) so the Normal Engineering / DeepSeek
  Only selector belongs to the shell.
- **Selected rows**: `--dsw-alias-interactive-bg-active` dark → violet tint
  `#7C5CFF2E`; menu/option rows with `[aria-selected=true]` get the accent
  hover tint; active sidebar nav item surface → `#221D38` violet tint.
- **Preview badge**: de-emphasized — transparent bg, tertiary text, 11px.
- **Model selector**: unchanged upstream component; duplicates such as
  "MAX Max" are suppressed by the mode-seat rendering (see verification).

### Patches added in 1.5
- `dsh-client-ui-layout`: sidebar default width 280 → 288.
- `dsh-client-ui-conversation`: send button fill/hover → primary tokens;
  hero glow `#6187D8 → #7C5CFF`.
- `dist/assets/nexus-logo.png` + `nexus-mark.png` copies.

### Verification (CDP-driven live browser session, 1440×900, dark theme)
| Metric | Before (stock/Phase 1) | After (Phase 1.5) |
| --- | --- | --- |
| Expanded sidebar | 280px | **288px** (fresh load and reopen-after-collapse; collapsed rail 56px) |
| Hero headline | 26px/32px | **30px/34px** |
| Hero stack gap | 12px | 8px |
| Hero horizontal padding | 24px | 16px |
| Composer width | 780px (748 content) | **932px** (900 content), still centered |
| Composer radius | 22px (overridden 10px) | **10px** |
| Composer surface | #111116 | **#17171D**, border #27272F, violet focus ring |
| Send button | cyan #49C6E5 | **violet #7C5CFF** (34×34) |
| Hero glow | #6187D8 | **#7C5CFF** |
| Model chip | "DeepSeek V4 Flash MAX Max" | **"DeepSeek V4 Flash MAX"** (effort deduped) |

Behavioral checks (all passed in the live session): workspace selection via
picker, mode seat menu (Standard/PTC/Minimal/Creator/Normal Engineering/
DeepSeek Only), composer typing + mirror, New Session reset to hero, Settings
open, Appearance Light ↔ Dark toggle, sidebar collapse (56px rail, icon mark)
and expand (288px, lockup). Pixel sampling of screenshots confirmed the
lockup (violet+navy+light pixels) in the expanded rail, the icon mark in the
collapsed rail, and the violet send button (max B−R diff 131 ≈ #7C5CFF).

Suites: Harness.Tests.ps1 63/63 (incl. fixture idempotency + fail-closed for
all new patches), ControllerRouting.Tests.ps1 47/47, AihController.Tests.cjs
PASS, Doctor.ps1 all PASS (12 Nexus checks).


---

# Phase 2 — live Controller panel

The Controller panel exposes REAL deterministic-controller state (task ledger,
session bindings, routing state, routing decisions, launcher state, git) in a
right-edge drawer over the Web GUI shell. It is strictly read-only and observes
existing state; it never owns controller behavior.

> TASK-0002 repair (drawer architecture): the first Phase-2 build registered
> into the official `details` seat. That seat is kind `single` / scope
> `session` and is OCCUPIED by the native DetailsPanel (client-ui-conversation)
> at priority 0 — and that occupant declares `conversation.details.tool`. The
> pinned slot core REJECTS an equal-priority second registration ("single slot
> … already has a registration"), so the live loader failed to apply the entry
> and the composition had to disable the row. The pinned architecture offers no
> additive right-column seat (verified in the slot declaration table), so the
> repaired build mounts into `shell.overlay` — the documented additive seat
> for a frame-wide surface of your own — as a right-edge drawer. Native details
> behavior is entirely untouched: the DetailsPanel keeps the `details` seat
> and keeps declaring `conversation.details.tool`; open/close/drag stay
> layout-owned; a ResizeObserver closes the drawer whenever the native details
> column opens, so the two surfaces never overlap.

## Architecture

```
Nexus controller state (task ledger, bindings, routing state,
decisions.jsonl, settings.yaml, aih-state.json, git)
        |
        v
ui/nexus-controller/lib/status.cjs      pure read-only state adapter (CJS)
        |                                (normalize, degrade, derive, git)
        v
lib/index.js                             host plugin: one exact GET route
        |                                (bound via Cordis lifecycle
        |                                injection of the webServer service —
        |                                activates whenever/wherever the
        |                                service becomes available; inert in
        |                                profiles without it)
        |                                /nexus/controller.json?session=<id>
        v
lib/client.js                            client plugin: shell.overlay drawer
                                         (additive list seat, root scope)
                                         + session-header toggle
        v
Web GUI frame overlay layer (click-through layer; the drawer surface opts
back into pointer events; right edge, width min(340px, 100vw - 40px))
```

Layering follows the Phase 1 priority: official slots/extension points first
(the ADDITIVE `shell.overlay` list seat — the documented "additive seat for
a frame-wide surface of your own" — and the `conversation.session.header.actions`
additive seat), Nexus-owned plugin second, Nexus-owned CSS third, no upstream
patch at all. The `details` seat and its `conversation.details.tool`
child are deliberately left to the native occupants (see the repair note
above); the controller never registers into either.

## Authoritative source for every displayed field

| Panel field | Source | Live update |
| --- | --- | --- |
| Task id / description / status | `<workspace>/.ai-harness/state/tasks.json` (ledger) | poll 1.5 s |
| Session → task binding | `data/routing/session-bindings.json` | poll 1.5 s |
| Execution class / review-required | routing state `data/routing/states/<sha256>.json` (falls back to binding) | poll 1.5 s |
| Executor provider / model / reasoning | the **last non-escalation** decision in `data/routing/decisions.jsonl` — the decision that owns primary execution; review/escalation records (`escalatedFrom` set) never replace it just because they are newer; if only escalations exist (edge), the newest record is the fail-closed fallback; display name from `data/settings.yaml` `llm-pi-ai.providers.*.models[].name` | poll 1.5 s |
| Attempt | `task.attempt` / `task.maxAttempts` (ledger; real max = 3); attempt 0 renders `—` (no attempt started), positive attempts render `N / max` unchanged | poll 1.5 s |
| Verification | `task.verification.outcomes[]` (status PASS/FAIL/SKIP; written by the controller's own evidence step) | poll 1.5 s |
| Codex reviews | `task.codexCalls` (real recorded count; never triggers Codex) | poll 1.5 s |
| Context | live `useProjection('contextPressure')` (same source as the composer ring) | push (client projection) |
| Working vs waiting | live `useSession(s => s.running)` folded over the file state | push (client store) |
| Git | `git -c core.quotepath=false status --porcelain=v1` + `diff --numstat HEAD` + branch, cached 10 s per workspace server-side | poll 1.5 s (cached 10 s) |
| Controller status / pid | `data/aih-state.json` | poll 1.5 s |

Every value degrades fail-closed: missing/corrupt files become `null` and
the UI renders "—" or omits the row. No fake telemetry anywhere.

## Display-state mapping (smallest truthful set)

`unavailable` (transport/HTTP failure: fetch error, non-200, unparseable
envelope, or a host-side envelope error — the controller state cannot be
read at all; NEVER `idle`) · `idle` (HEALTHY controller with no active
work — no binding) · `starting` (bound, ledger record absent) ·
`working` (ready/implementing — GUI sessions never call begin-attempt, so a
live task stays `ready` through its whole turn) · `reviewing` (running &&
codex_review) · `repairing` (running && deepseek_deep) · `verifying`
(ledger status `verifying`, CLI-owned, shown even while idle) · `waiting`
(bound but agent loop idle) · `complete` · `failed`. The client folds the
session's live `running` flag over the file-derived state; VERIFYING is
exempt because deterministic verification runs through the CLI outside the
agent loop. File-level fail-closed degradation INSIDE a healthy envelope
(missing/corrupt sources become null rows) does not flip the pill — only
transport/envelope failure does.

## Live-update mechanism

There is no browser-exposed event stream for ledger state, so the panel uses
the fallback ladder's last rung: bounded polling of the read-only adapter
endpoint every 1.5 s (the task's own guidance: 1–2 s is sufficient for
controller telemetry). Context and running-flag come from live client
projections (no polling). Git is cached 10 s per workspace on the host so the
1.5 s polls never run git.

## Layout integration

- Drawer: registered into the ADDITIVE `shell.overlay` list seat (root
  scope, id `nexus-controller`, order 100) as a right-edge drawer
  (`position:absolute; top:0; right:0; bottom:0` inside the frame's overlay
  layer — the layer is click-through, the drawer surface opts back into
  pointer events, so the app stays usable around it). Width
  `min(340px, calc(100vw - 40px))` — narrow windows clamp instead of
  overflowing. Slide-in animation with a `prefers-reduced-motion` guard.
- Toggle: additive `conversation.session.header.actions` entry (id
  `nexus-controller`, order 90) — the per-session way to open/close the
  drawer. Escape also closes it; the drawer header has a close button.
- Auto-open: once per controller-bound session, when the drawer is not yet
  decided-for that session and the user's stored preference says open. The
  preference lives in `localStorage` (`nexus.controller.panel.open`)
  because upstream layout state is transient by design and no other UI-setting
  persistence exists to reuse. Any user decision (toggle/close/Esc) marks the
  session decided, so the drawer never re-opens on its own afterwards.
- Coherence with native details: a ResizeObserver watches the `details`
  column cell; when the layout opens the native details column while the
  drawer is open, the drawer closes itself (and marks the session decided).
  The two right-side surfaces never overlap, and native tool-call details
  keep working exactly as shipped.
- Session data: the drawer receives only the standard overlay kit
  (`useSessions` + `useWorkspaces`); the current session id, the live
  `running` flag and `projections.values.contextPressure` all come from
  the session summary records (the same source the sidebar badge uses).
- Read-only: no execution-class switching, no routing override, no Codex
  trigger, no task/git mutation. Allowed interactions: collapse/expand, copy
  task id.

## Files

Added: `ui/nexus-controller/package.json`, `lib/status.cjs`,
`lib/detail.cjs` (Task Control Room adapter — routing timeline, attempts,
verification, failures, reviews, git files; fail-closed per subsystem),
`lib/index.js`, `lib/client.js`, `tests/NexusControllerPanel.Tests.cjs`,
`ui/nexus-controller/tools/boot-verify-drawer.mjs` (CDP boot verification
against the live composition), `ui/nexus-controller/tools/cold-restart-verify.mjs`
(cold-restart + post-restart route verification driver).
Changed: `lib/status.cjs` — executor selection prefers the last
non-escalation decision; `lib/client.js` — attempt 0 renders `—`;
`scripts/TaskController.ps1`, `scripts/Route.ps1`,
`scripts/Complete-Objective.ps1` — every state read that carries
user-derived text now uses `Get-Content -Encoding UTF8` (the
UTF-8-no-BOM ledger/manifest/decisions files were being decoded through the
Windows PowerShell 5.1 ANSI codepage, which corrupted any non-ASCII
character on read-modify-write cycles); added
`scripts/Repair-LedgerEncoding.ps1` — idempotent repair driver that
restores corrupted task descriptions from the authoritative clean source
(the task's last non-escalation routing decision), fixed the live
TASK-0001/TASK-0002 ledger + run manifests; `config/home.cordis.patch.yml` (+ `data/cordis.patch.yml`
copy) — `nexus-controller` row (must stay ENABLED — see the repair note);
`scripts/Patch-NexusUi.ps1` — installs @nexus/controller into the profile
module fallback, ensures the composition row AND strips any
`disabled: true` that belongs to the controller row (idempotent,
CRLF/LF-tolerant, fail-closed); `scripts/Doctor.ps1` — 5 Nexus controller
checks (package, files, row, ROW ENABLED, route); `docs/nexus-ui.md` —
this record.

## Tests

`tests/NexusControllerPanel.Tests.cjs` (deterministic, fixture-based, no
Codex, no live state): empty state, active DeepSeek task (fixture
ledger+bindings+routing state+decision+settings → deepseek_normal /
"DeepSeek V4 Flash MAX" / TASK-0042), verification pass/fail/partial, codex
count, display-state derivation, routing-state filename cross-validated
against a real PowerShell-written file, corrupt/missing state degradation,
git parsers + a real fixture repository, host-route registration + endpoint
handler over a fixture request (200, no-store, graceful idle envelope, inert
without webServer), a client-bundle load/registration/SSR smoke test
(asserts the controller registers shell.overlay + header actions only and
never injects into `details`), and — added by the TASK-0002 repair — two
composition regression groups:

1. **Slot-collision regression (mini slot-core).** A faithful port of the
   pinned shell-bundle slot register core (index-ClqxG24t.js, register at
   char ~191268 — same guards, same declaration flow, same sort, same error
   strings). The REAL controller client bundle is applied against a
   mini-core seeded with the STOCK composition (root → details +
   shell.overlay; DetailsPanel → conversation.details.tool; conversation →
   conversation.session.header → header.actions). It must apply cleanly, own
   shell.overlay + header actions, and leave `details` /
   `conversation.details.tool` owned by the native occupants. The NEGATIVE
   case re-registers into `details` at priority 0 and must throw the exact
   live loader error: `single slot "details" already has a registration at
   priority 0 — register at a different priority to shadow it (lowest
   renders)`. This group FAILS if the controller ever goes back to the
   details seat.
2. **Native tool-details reachability.** After the controller integration
   the `details` seat and `conversation.details.tool` remain occupied by
   the native entries (asserted through the mini-core registry), the client
   bundle contains no `details` injection at all, and the native
   DetailsPanel/ToolDetails render path is exercised.
3. **Host route lifecycle injection.** The host plugin activates with NO
   webServer present and must not lose the route to a one-time lookup:
   nothing registers until the service exists; when it appears later the
   injection callback applies and the route registers with unchanged handler
   semantics. One group drives the REAL Cordis runtime from the app closure
   (plugin applied on a bare Context, `webServer` provided afterwards,
   route asserted after the deferred injection resolves); the other asserts
   the contract structurally (inject declares `webServer`, no registration
   before availability, inert forever in profiles that never provide it).
4. **UNAVAILABLE vs IDLE semantics.** Transport failure and envelope errors
   resolve to `unavailable` — never `idle`; a healthy controller with no
   work stays `idle`; healthy states are unchanged; the SSR failure face
   renders the UNAVAILABLE pill and the "Controller state unavailable"
   empty message.

`tests/AihController.Tests.cjs` covers the controller bridge behavior
(unchanged, still PASS).


4. **Executor = primary decision.** Fixture decisions.jsonl with a primary
   record (no `escalatedFrom`) followed by a NEWER review escalation
   (codex_review / sol-local / gpt-5.6-sol) — the snapshot must report the
   PRIMARY executor (provider/model/reasoning from the primary record,
   `escalatedFrom` null). Also covered: escalation-before-primary ordering
   and the all-escalations edge (fail-closed fallback to the newest record).
5. **Attempt 0 → `—`.** SSR of the real ControllerBody: attempt 0 renders
   the em-dash placeholder and never `0 / max` (progress bar suppressed);
   a positive attempt renders `N / max` unchanged.
6. **UTF-8 ledger text.** A fixture ledger carrying a real em-dash plus
   CJK/arrows/accents round-trips through the snapshot and the route
   envelope byte-for-byte with no mojibake.
7. **Control Room (TASK-0003).** Group 18 drives the detail adapter over
   fixtures: root-vs-review routing timeline (the primary decision stays the
   root executor while the newer review lands in history), empty-history
   grace, attempt grouping/status derivation (failed / in-flight started /
   passed only when the ledger is complete) and durations from real
   timestamps only, verification pass/fail/partial/malformed/ledger-fallback,
   failure-signature counts in first-seen order, reviews zero/recorded
   (packet meta and findings severity/location/problem only — never diff or
   file contents), git files over a REAL fixture repo (modified/deleted/
   staged-new with numstat counts, untracked without counts, clean tree,
   non-repo degradation), corruption isolation in both directions, and
   UTF-8 (— → ✓ 中文) round-trip. Group 19 renders the real ControlRoom via
   SSR with the detail hook patched: four tabs, PRIMARY/REVIEW chips in the
   timeline, attempt rows, real verification counts, fail-closed faces, and
   the bound-only expand action. The host group asserts the second route
   registers through the same Cordis injection and serves the detail
   envelope (200, UTF-8, no-store, idle envelope for unknown sessions).

`tests/ControllerRouting.Tests.ps1` gained two deterministic sections:
section 9 (UTF-8 ledger boundary — a fixture task with a real em-dash
survives `New-AihTask` + `Update-AihTaskRecord` read-modify-write with
the ledger byte-compared via `[IO.File]::ReadAllText` UTF-8) and section
10 (repair driver — a corrupted fixture description is restored from the
authoritative routing decision, the run manifest is restored too, and a
second driver run is a byte-exact no-op).

## Known limitations

- The live dsh instance is never restarted during this work (a restart would
  kill the agent session); the composition is applied LIVE through the
  Cordis HMR watcher on `data/cordis.patch.yml` — the served boot graph and
  the served `@nexus/controller` client bundle were re-fetched and
  verified to be the drawer build, and the final acceptance is the CDP boot
  verification below against the real running composition.
- The live instance was cold-restarted as part of the host-route repair
  (the one-time `ctx.get('webServer')` activation check could permanently
  skip the route when the service was late; the route is now bound through
  Cordis lifecycle injection). The restart itself and the post-restart URL
  check are orchestrated by `ui/nexus-controller/tools/cold-restart-verify.mjs`
  (results in `logs/cold-restart-verify.log`).
- Boot verification (headless Edge via CDP against the LIVE server, the real
  plugin loaded from the real composition — no injected markup):
  - the page boots with NO "already has a registration" loader error;
  - the controller toggle renders in the real header action row;
  - the drawer opens (auto-open honors the stored preference) and shows REAL
    controller data for the bound live session (task id, executor model,
    state pill, controller status/pid);
  - the native details column still mounts the native DetailsPanel
    (its empty-state copy is present in the details cell; the controller
    title is NOT) — the controller does not shadow native tool details;
  - coherence: forcing the native details column open closes the drawer;
  - toggle reopen, Escape close, narrow-viewport clamp all work.
- The native details column itself has no reachable UI in the stock app
  (upstream `openDetails` is implemented but never called), so "open tool
  details" in the coherence check is exercised at the layout level (the
  drawer watches the real column width, which is exactly what the layout
  store drives). Tool input/output stays fully visible through the
  conversation's inline tool rows (verified: rows render and expand), and
  the `conversation.details.tool` seat + its native occupant are asserted
  by the regression tests.
- `attempt` is `0` while GUI sessions run (the controller never calls
  begin-attempt for GUI sessions); the panel renders `—` for 0 — never
  `0 / max` — and positive attempts render unchanged.
- The EXECUTOR for the live session is the primary routing decision:
  `flash-high-direct / deepseek-v4-flash / high`; the newer codex_review
  escalation (sol-local / gpt-5.6-sol) is shown under Review, never as the
  Executor. Display names come from settings.yaml, prettified ids are the
  fallback.
- Control Room (Phase 3) fields Nexus does not record, shown only when a
  real record exists: verification durations/timestamps, review timestamps,
  per-attempt completion events (a "passed" attempt is derived: started
  sequence + no failed record + complete ledger). Attempt 0 has no timeline
  row (the GUI never calls begin-attempt — documented limitation, the room
  never fabricates one).
- Control Room files: file paths are displayed and copyable only — nothing
  opens files, and large review-packet diff/file contents are never rendered
  inline (packet meta only).
- Light theme: the drawer uses only `--dsw-alias-*` tokens
  (theme-agnostic by design); the theme preference is store-owned and cannot
  be switched from a headless probe, so the light pass relies on the
  Phase-1 light-theme verification plus the shared token layer.

## Phase 4 recommendations

Phase 3 delivered: the Task Control Room (Overview/Activity/Verification/
Files) with real routing history, attempt records, verification checks,
failure signatures, review outcomes, and git detail; the separate
`/nexus/control-room.json` endpoint; fail-closed per subsystem. The
Phase-2 recommendation list was folded in as follows: polling stays (the
compact 1.5 s + room 4 s paths are both lightweight; an SSE push endpoint
would replace them when the controller grows an event stream) and
begin-attempt is intentionally NOT wired (the GUI never calls
begin-attempt; Attempt stays "—" at 0 — a documented limitation).

1. **Controller event stream/SSE.** The controller writes attempts and
   verification asynchronously; an SSE or a `since=` delta endpoint would
   let the room react without 4 s polling and without re-reading histories.
2. **Verification artifact deep links.** The room shows the evidence
   artifact path (copyable). When a file-serving endpoint exists with
   authorization, link it — never a general file-read endpoint.
3. **Operator WAITING signal.** Surface the review-required gate as an
   explicit operator-wait state once the controller records an operator
   gate event.
4. **Per-attempt verification records.** evidence.json has no timestamps or
   per-attempt breakdown; recording `verificationStartedAtUtc` /
   `verificationFinishedAtUtc` per attempt would let the room show real
   verification durations (currently intentionally omitted).
5. **Review timestamps.** review-packet/result files carry no timestamps;
   recording them would let the Activity timeline interleave review
   outcomes chronologically with attempts.
6. **Per-session panel preference** (room view/width) when a settings
   system exists.

