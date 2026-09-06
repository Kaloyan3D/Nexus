# Fidelity Review Checklist (companion to SKILL.md)

Use per screen at each representative state: populated, empty, loading,
error/failure (where the design specifies one).

## Before comparing

1. Render the real screen — simulator, device, or browser at the design's
   breakpoint. Capture a screenshot.
2. Put the design beside it at matched zoom/viewport width.
3. Note the state each artifact shows; comparing populated app vs empty
   design (or vice versa) is the most common false deviation.

## Per-dimension notes template

- Composition: pass / deviation (what differs, where)
- Hierarchy: pass / deviation
- Density: pass / deviation
- Spacing: pass / deviation
- Proportions: pass / deviation
- Typography: pass / deviation
- Visual emphasis: pass / deviation
- Empty-state weight: pass / deviation / N-A (state absent in design)
- Interaction ergonomics: pass / deviation (targets, focus, reachability)

## Deviation handling

A deviation is either:

- **fixed** — change the code, re-screenshot, re-compare; or
- **accepted** — the requester explicitly accepts it in writing (task
  comment, review approval). Record where the acceptance lives.

Silence is not acceptance. Unresolved deviations keep the task in
implemented-not-accepted state.
