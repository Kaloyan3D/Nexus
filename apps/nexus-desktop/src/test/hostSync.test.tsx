import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HostSyncNote, ProjectSyncLine } from "../features/sync/HostSyncNote";
import type { HostSync, ProjectView } from "../lib/contracts";

const hs = (over: Partial<HostSync>): HostSync => ({ state: "running", label: "Nexus is working", changed: [], conflicts: [], ...over });

describe("macOS synchronization status", () => {
  it("separates 'task finished' from 'applied to your Mac folder'", () => {
    render(<HostSyncNote taskDone hs={hs({ state: "exporting", label: "Collecting the result" })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/task has finished; its changes are not on your Mac yet/);
  });

  it("shows applied changes and when", () => {
    render(<HostSyncNote hs={hs({ state: "applied", label: "Applied to your Mac folder", appliedMs: Date.now(), changed: [{ path: "src/a.ts", kind: "modify" }] })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Applied to your Mac folder/);
    expect(screen.getByRole("status")).toHaveTextContent("src/a.ts");
  });

  it("states a conflict plainly and says nothing was overwritten", () => {
    render(<HostSyncNote hs={hs({ state: "conflict", label: "Not applied", conflicts: [{ path: "app.js", reason: "edited on your Mac" }], savedResult: "/saved" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Not applied: your Mac folder changed too/);
    expect(screen.getByRole("alert")).toHaveTextContent(/app\.js/);
    expect(screen.getByRole("alert")).toHaveTextContent(/Nothing on your Mac was overwritten/);
  });

  it("an unverified run says the Mac folder was not changed", () => {
    render(<HostSyncNote hs={hs({ state: "not-applied", label: "Not applied to your Mac folder (not verified)" })} />);
    expect(screen.getByRole("note")).toHaveTextContent(/Your Mac folder was not changed/);
  });

  it("shows the Mac path, never an engine path", () => {
    const p = { projectId: "g", label: "proj", macPath: "/Users/me/proj", sync: { state: "synced", generation: 2, consent: true, files: 12, skippedTotal: 3, conflicts: [], lastSyncMs: Date.now() } } as unknown as ProjectView;
    render(<ProjectSyncLine p={p} />);
    expect(screen.getByText("/Users/me/proj")).toBeInTheDocument();
    expect(screen.getByText(/In sync with your Mac folder/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NexusMac|\.nexus-interactive-dev/);
  });

  it("explains why nothing was applied and how to change it for a project without tests", () => {
    render(<HostSyncNote hs={hs({ state: "not-applied", label: "Not applied to your Mac folder: no test was run, so it could not be verified" })} />);
    expect(screen.getByRole("note")).toHaveTextContent(/choose the folder again and allow/);
  });

  it("states which results a project applies", () => {
    const base = { projectId: "g", label: "p", macPath: "/Users/me/p" };
    const sync = { state: "synced", generation: 1, consent: true, files: 1, skippedTotal: 0, conflicts: [] };
    const { rerender } = render(<ProjectSyncLine p={{ ...base, sync: { ...sync, applyUnverified: true } } as unknown as ProjectView} />);
    expect(screen.getByText(/also after a task that could not be checked/)).toBeInTheDocument();
    rerender(<ProjectSyncLine p={{ ...base, sync } as unknown as ProjectView} />);
    expect(screen.getByText(/only after a task whose checks passed/)).toBeInTheDocument();
  });
});
