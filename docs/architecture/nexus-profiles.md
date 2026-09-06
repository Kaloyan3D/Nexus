# Nexus profiles and agent engines

Status: Phase M1 — profile/engine foundation.

## Decision

`Engineering` remains the user-facing Nexus mode. A **Profile** selects the agent architecture used inside that mode. The selected profile resolves to an internal **agent engine**.

```text
Engineering Mode
      |
      v
Nexus Profile
      |
      +-- GLM + Codex --------> Dual engine
      +-- DeepSeek + Codex ---> Dual engine
      `-- Muse Spark 1.3 -----> Muse engine
```

This deliberately separates three concepts:

- **Mode** — what Nexus is doing (`Engineering`).
- **Profile** — the operator-facing engineering configuration (`GLM + Codex`, `Muse Spark 1.3`, ...).
- **Engine / agent plane** — the internal orchestration philosophy (`dual`, `muse`).

A model id is not an engine and an engine is not an execution class.

## One control plane, multiple agent planes

All engines continue to use the same deterministic Nexus control plane for task identity, requirements, evidence, attempts, verification, failures, telemetry, gates, and completion.

```text
                         NEXUS CONTROL PLANE
        task / requirements / evidence / verification / completion
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
               DUAL ENGINE                  MUSE ENGINE
            role-based existing          Muse-native policy
               orchestration               (later phases)
```

The controller remains authoritative. An agent engine may decide how model work is coordinated; it never gains authority to invent verification or completion truth.

## Dual engine compatibility

The existing `config/engineering-profiles.json` and `config/Engineering-Profiles.cjs` remain the authoritative configuration/resolution layer for the Dual engine. Their role contract is unchanged:

```text
primaryEngineer
 deepEngineer
 reviewer
 solver
 fallback
```

Phase M1 must not change the runtime behavior of `deepseek-codex`, `glm-codex`, or operator `custom` profiles.

## Muse engine isolation

Muse does **not** implement the Dual role schema. Its engine-specific configuration lives in `config/muse-profiles.json` and is resolved only when a top-level Nexus profile selects `engine: muse`.

Muse-specific concepts such as same-model specialists, context compaction, reasoning escalation, and Contributor protection are introduced inside the Muse agent plane in later phases. They must not alter Dual routing semantics.

## Top-level catalog

`config/nexus-profiles.json` is the user-facing profile catalog. Each entry declares:

- stable profile id;
- display name;
- engine (`dual` or `muse`);
- engine-specific source registry and profile id;
- whether the profile is currently selectable/runnable.

`config/Nexus-Profiles.cjs` validates and resolves this catalog. Dual entries delegate their actual role configuration to the existing Engineering Profile resolver; Muse entries delegate to `muse-profiles.json`.

The operator-defined `custom` Engineering Profile is dynamically exposed as a `dual` Nexus profile rather than copied into the immutable catalog.

## Active-profile precedence

The top-level resolver preserves the existing profile selection precedence:

1. `DSH_AIH_PROFILE`
2. `AIH_ACTIVE_PROFILE`
3. `engineering-profile:` in `data/settings.yaml`
4. preset profile binding
5. routing-policy `defaultProfile`

A preset with `profileOverrideAllowed: false` remains locked. Unknown profile ids fail closed; they never silently select a different engine.

## Phase M1 safety gate

Muse Spark 1.3 exists in the catalog during M1 as architecture metadata only:

```text
selectable = false
runnable   = false
availability = foundation
```

This prevents a partially implemented Muse profile from reaching the production agent/request path. Phase M2 adds Meta provider/model transport. Phase M3 installs the first runnable Muse Agent Plane.

## Compatibility invariant

The key M1 invariant is:

> Adding the profile/engine abstraction must be additive. Existing Dual execution continues through the existing controller, role resolution, Engineering Isolation, review, and verification paths unchanged.
