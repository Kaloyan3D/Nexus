# Nexus desktop design system

Product: **Nexus** (native desktop app). **Nexus Nova** is the AI orchestration layer the app talks to; the
app itself is branded "Nexus". Standalone: no DSH, Cordis or DSH-prefixed CSS variables. Tokens live in
`src/styles/tokens.css` (`--nv-*` namespace).

## Tokens

| Group | Token | Value |
|---|---|---|
| Surface | `--nv-bg` / `--nv-bg-sidebar` / `--nv-surface` / `--nv-surface-elevated` / `--nv-surface-popover` | `#09090B` / `#0D0D10` / `#111116` / `#17171D` / `#1F1F26` |
| Border | `--nv-border` (subtle: `--nv-border-subtle`) | `#27272F` (`#1C1C22`) |
| Text | primary / secondary / muted | `#F5F5F7` / `#A1A1AA` / `#71717A` |
| Brand | `--nv-purple` / `--nv-purple-hover` | `#7C5CFF` / `#9177FF` |
| Semantic | success / warning / error | `#32D583` / `#F5A524` / `#F04438` |

Purple is reserved for: selected navigation/rows (12% tint + 2px left accent), focus rings, the primary
action, active tabs, in-progress status, and the streaming caret.

## Typography

Inter Variable (UI), JetBrains Mono Variable (IDs, digests, paths, timestamps, diagnostics), both bundled
locally (no network fonts). Scale: 11 / 12 / 13 (base) / 14 / 16 / 20 / 28 px. Page and task headings are
28px / 600 / -0.02em.

## Spacing, shape, motion

4px grid (`--nv-s-1..8`). Radii 4/6/8px, pills only for badges. No gradients, no glass, shadows only on
overlays. Motion is 120-180ms ease for colour/border changes; `prefers-reduced-motion` zeroes durations.

## Layout

| Layout | Width | Sidebar | Inspector |
|---|---|---|---|
| wide | >= 1440 | 244px | 372px inline |
| medium | 1000-1439 | 212px | 332px inline, toggleable |
| compact | < 1000 | drawer | overlay dialog (Esc closes) |

Top bar 58px. Activity/Recent split collapses to a stacked layout below 700px container width.

## Components (`src/components/ui`)

Button (default/primary/ghost, md/sm, icon-only), Badge (neutral/purple/success/warning/error, mono),
StatusDot (pulse), Kbd, Tabs, SectionHeading, KeyValue, Alert (info/warning/error), EmptyState, Loading,
SearchInput, CodeBlock, CheckRow (PASS / FAIL / NOT RUN), Timeline.
Shell: Sidebar, TopBar, CommandPalette, Inspector.

## Truthfulness rules (design-level)

- A control that has no backend capability is rendered disabled/unavailable with the reason, never active.
- Missing values render as an em dash, never a placeholder number.
- Mock output is always badged **MOCK** and listed apart from Controller ledger tasks.
- Nothing is labelled "Live" while the Kernel forbids dispatch.
