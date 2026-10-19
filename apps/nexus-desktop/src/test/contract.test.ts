import { describe, expect, it } from "vitest";
import registryTargets from "./contract/registry-targets.json";
import threadTarget from "./contract/thread-target.json";
import type { RegistryTarget, ThreadTarget } from "../lib/contracts";
import { REGISTRY_TARGETS } from "./fakeApi";

/**
 * The golden wire shapes the Rust side is tested against byte for byte
 * (nexus-client/tests/registry_target.rs and the broker's threads.rs tests).
 * Typing them here makes a drift in EITHER direction a failure: the Rust test fails when Rust
 * serializes something else, `tsc` fails when these files stop satisfying the TypeScript contract.
 */
const targets: RegistryTarget[] = registryTargets;
const bound: ThreadTarget = threadTarget;

describe("Rust <-> TypeScript contract (R-NATIVE-3)", () => {
  it("a serialized RegistryTarget satisfies the TypeScript contract, optional fields omitted rather than null", () => {
    expect(targets).toHaveLength(2);
    const ok = targets[0]!;
    const blocked = targets[1]!;
    expect(ok.issuable).toBe(true);
    expect("reason" in ok).toBe(false);
    expect(blocked.issuable).toBe(false);
    expect(blocked.reason).toBe("connection-not-connected");
    expect("connectionId" in blocked).toBe(false);
    for (const t of targets) {
      expect(Object.keys(t).every((k) => /^[a-z][A-Za-z]*$/.test(k))).toBe(true);
      expect(typeof t.contextLimitTokens).toBe("number");
      expect(typeof t.outputLimitTokens).toBe("number");
    }
  });

  it("a bound conversation target is exactly four identity fields", () => {
    expect(Object.keys(bound).sort()).toEqual(["logicalModelId", "providerId", "remoteModelId", "routeId"]);
  });

  it("the fake API serves the same shape the broker serializes", () => {
    const keys = (t: RegistryTarget) => Object.keys(t).filter((k) => !["connectionId", "dataUse", "reason"].includes(k)).sort();
    for (const t of REGISTRY_TARGETS) expect(keys(t)).toEqual(keys(targets[0]!));
  });
});
