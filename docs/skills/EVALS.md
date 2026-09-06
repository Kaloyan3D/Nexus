# Skill Evals

The eval harness answers one question: **do the skills improve behavior?**
Foundation v1 ships the deterministic half of that answer; model-judged and
live model selection are protocol extensions, not requirements of this
phase.

## The deterministic harness

`scripts/Invoke-SkillEvals.ps1` runs `tests/fixtures/skill-evals/cases.json`:

1. Each case is a real task (bug report, design implementation, migration,
   release, git anomaly).
2. Each case names the skills a useful responder should select.
3. For every expected skill, the harness asserts that the **catalog surface**
   (the description the model sees before loading) and the **body** carry the
   concepts the selection decision depends on — as case-insensitive regular
   expressions.

If the routing text is missing or wrong, the model cannot be expected to
select the skill. This makes the evals a permanent regression gate on the
selection surface itself, with no LLM in the loop.

Run it:

    powershell -File scripts/Invoke-SkillEvals.ps1          # human-readable
    powershell -File scripts/Invoke-SkillEvals.ps1 -Json    # machine-readable

By default the harness reads the canonical source pack (`skills/core`);
pass `-TargetRoot <dir>` to evaluate an installed location instead.

## Cases (v1)

| Case | Task | Expected skills |
| --- | --- | --- |
| A | React Native + Expo app; SQLite write succeeds but the list screen stays stale until restart; someone suggests syncing the DB into Redux | `local-first-sqlite`, `react-native-expo`, `test-driven-hardening` |
| B | Implement the approved mobile mockup | `frontend-design-fidelity` |
| C | Schema migration adding a payments table with a non-negative invariant, shipped without breaking the current app | `database-engineering`, `test-driven-hardening` |
| D | Release readiness status before a phase close | `ci-release-readiness` |
| E | Git author unexpectedly changed on the last commit | `git-safety` |

Each case also pins the concepts that matter, e.g. case A requires the
catalog to signal SQLite/canonical/invalidation and the body to contain the
explicit no-restart-workaround and no-whole-DB-into-Redux rules.

## Model selection (extension protocol)

The deterministic harness proves the selection surface exists; it does not
prove a model picks the right skill. When model selection is evaluated, a run
must record, per case:

- `model`, `provider`, `providerVersion` — the exact model identity.
- The catalog snapshot presented (names + descriptions, verbatim).
- The selection the model made (and whether it loaded the expected skill
  first).
- The prompt template verbatim, so results are reproducible and comparable
  across models and skill-pack revisions.

The harness JSON reserves the `modelSelection` field for this and reports
`not-run` until such a run exists. Do not fold model-judged results back
into the deterministic gate: the deterministic gate must stay green without
network, credentials, or nondeterminism.

## Live model-selection tool

`scripts/skills/Invoke-SkillModelEval.mjs` is the optional manual runner for
the protocol above. It presents the real installed catalog (names +
descriptions exactly as native discovery reports them) to the configured
model, temperature 0, and scores the selection per case:

    node scripts/skills/Invoke-SkillModelEval.mjs
    node scripts/skills/Invoke-SkillModelEval.mjs --model <model-id>

It requires the DeepSeek credential (`bin/aih-key.cmd`) and network access;
it is deliberately not registered in the test harness. It is itself a
consumer of the selection surface and must stay honest: it reports misses as
misses.

Reference result at foundation time (v1 pack, catalog of 11 installed +
pre-existing skills): `deepseek-v4-flash`, temperature 0, scored 5/5 on
cases A-E.

## Adding a case

1. Add the case to `tests/fixtures/skill-evals/cases.json` with concrete
   expected skills.
2. Write catalog/body patterns that pin the routing signal — if a pattern is
   missing from the skill, that is a skill defect, not a test defect.
3. Run the harness; update the table above.
