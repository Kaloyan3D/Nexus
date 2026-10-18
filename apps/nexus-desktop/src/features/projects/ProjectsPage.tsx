import { FolderGit2 } from "lucide-react";
import { useNexus } from "../../state/NexusContext";
import { Badge, EmptyState } from "../../components/ui/primitives";

/**
 * Read-only: the projects the operator has authorized. Registering a project (a path, a
 * commit pin, a write scope, a credential) is an operator action on the broker, never
 * something the Desktop can do or request.
 */
export function ProjectsPage() {
  const { intentCodeSources, intentWorkspaces, intentCodeLimits } = useNexus();
  const code = intentCodeSources ?? [];
  const inspect = intentWorkspaces ?? [];
  const ids = Array.from(new Set([...code.map((c) => c.sourceId), ...inspect.map((w) => w.workspaceId)]));
  return (
    <div className="nv-page nv-narrow">
      <h1 className="nv-pagetitle">Projects</h1>
      <p className="nv-note">
        Projects are registered by the operator on the Nexus broker, outside this app. Desktop shows what you are allowed to use and the restrictions that apply; it cannot add a project,
        type a path or change a restriction.
      </p>
      {ids.length === 0 ? (
        <EmptyState icon={FolderGit2} title="No project authorized">
          Ask the operator to register a project with <span className="nv-mono">nexus-broker --workspace ID=PATH</span> (Inspect) or <span className="nv-mono">--code-source ID=PATH</span> (Code in copy).
        </EmptyState>
      ) : (
        <table className="nv-table" aria-label="Authorized projects">
          <thead>
            <tr>
              <th>Project</th>
              <th>Modes</th>
              <th>Pinned commit</th>
              <th>Writes limited to</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const c = code.find((x) => x.sourceId === id);
              const i = inspect.some((w) => w.workspaceId === id);
              return (
                <tr key={id}>
                  <td className="nv-mono">{id}</td>
                  <td>
                    {i && <Badge tone="neutral">Inspect</Badge>} {c && <Badge tone="purple">Code in copy</Badge>}
                  </td>
                  <td className="nv-mono">{c ? (c.pinnedCommit ? c.pinnedCommit.slice(0, 12) : "not pinned") : "—"}</td>
                  <td className="nv-mono">{c ? (c.writeAllow && c.writeAllow.length > 0 ? c.writeAllow.join(", ") : "whole project (minus protected files)") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <h2 className="nv-subheading">What applies to every coding task</h2>
      <ul className="nv-list" aria-label="Execution restrictions">
        <li>Work happens in an isolated copy of the project at one commit; your repository is never modified, and nothing is committed, pushed or merged.</li>
        <li>Every edit and every command needs its own independent approval in the separate approver; Desktop cannot approve.</li>
        <li>Commands are limited to a short allowlist (cargo check/test/build/fmt, npm test/run build, tsc --noEmit) and run in a sandbox with the network off.</li>
        <li>Protected files (lock files, build scripts, hidden and credential-shaped paths, version-control internals) cannot be written.</li>
        <li>
          {intentCodeLimits
            ? `Run limits: ${intentCodeLimits.maxTurns} model turns · ${intentCodeLimits.maxToolCalls} tool calls · ${intentCodeLimits.maxEdits} edits · ${intentCodeLimits.maxTests} commands · ${intentCodeLimits.maxOutputTokens} output tokens per call · ${Math.round(intentCodeLimits.maxToolResultBytes / 1024)} KiB of tool results · ${Math.round(intentCodeLimits.maxRuntimeSecs / 60)} min.`
            : "Run limits: not reported by the backend."}
        </li>
        <li>Selected source text and command output are sent to the model provider; each model turn is a billable request.</li>
      </ul>
    </div>
  );
}
