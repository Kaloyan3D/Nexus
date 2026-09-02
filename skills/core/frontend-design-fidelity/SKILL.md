---
name: frontend-design-fidelity
description: >
  Use when implementing or reviewing an approved design or mockup. Token
  compliance is not design fidelity: composition, hierarchy, density,
  spacing, proportions, typography, and real rendered screenshots are the
  acceptance surface, and human screenshot review is a legitimate gate.
---

# Frontend Design Fidelity

## When to use

Use when a design, mockup, or spec image exists and code must match it —
during implementation and again before declaring the work done.

## Core rule

    TOKEN COMPLIANCE != DESIGN FIDELITY

Colors matching the palette, tokens existing in the theme, and component
tests passing do NOT mean the screen looks like the design. Fidelity is a
property of the rendered result.

## Review checklist

Compare the rendered screen against the design, dimension by dimension:

- **Composition** — same regions in the same places; header, body, footer
  layout matches the design's structure, not just its parts.
- **Hierarchy** — the most important element is the most visually dominant.
  Primary actions read as primary; secondary as secondary.
- **Density** — items per viewport, row heights, and padding match the
  design's compactness or airiness.
- **Spacing** — gaps between groups follow the design's rhythm; related
  things are closer than unrelated things.
- **Proportions** — element sizes relative to each other and to the viewport
  (cards, images, buttons) match.
- **Typography** — sizes, weights, and line heights create the same reading
  order and emphasis as the design.
- **Visual emphasis** — color and weight direct attention where the design
  directs it.
- **Empty-state weight** — empty and loading states match the design's
  intent (calm placeholder vs prominent call to action), not a blank box.
- **Interaction ergonomics** — touch targets, hover/focus states, and
  reachable controls match the design's intended use.
- **Real screenshots** — the comparison happens on actual rendered output
  (screenshots, device frames), not on imagination or token lists.

## Forbidden claims

Declaring design work complete only because:

- colors match the palette,
- the tokens exist in the theme file,
- component tests pass, or
- it "looks approximately right" without a rendered screenshot comparison.

## Acceptance

Human screenshot review is a legitimate acceptance gate. Report fidelity as
**verified against rendered screenshots** (state what was compared), or as
**unverified** with the screenshot comparison named as the missing gate.
Self-declared fidelity without rendered evidence is never "verified".

## Verify completion

- Rendered screenshots at representative states (populated, empty, loading)
  were produced and compared against the design.
- Each checklist dimension above has an explicit pass/deviation note.
- Deviations are either fixed or explicitly accepted by the requester.
