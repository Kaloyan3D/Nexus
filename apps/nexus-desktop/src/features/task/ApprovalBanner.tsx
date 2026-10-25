import { Check, ChevronDown, ChevronRight, PauseCircle } from "lucide-react";
import { useState } from "react";
import type { PendingApproval } from "../../lib/contracts";
import { useNow } from "../../lib/useViewport";
import { Badge, Button } from "../../components/ui/primitives";
import { CopyButton } from "../conversation/ConversationPanel";
import { useNexus } from "../../state/NexusContext";

const short = (h?: string | null) => (h ? h.slice(0, 10) : "—");

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A model-proposed edit or command waiting for an INDEPENDENT approval. Compact by
 * default (one short row); expandable for the proposal, restrictions and digest.
 * Display only: Desktop holds no approver credential and has no approve or deny
 * control. The reviewer uses the separate `nexus-approver review` terminal, which
 * shows the daemon-derived exact request.
 */
export function ApprovalBanner({ approval }: { approval: PendingApproval }) {
  const now = useNow(1000);
  const { runtimeState } = useNexus();
  // this installation's real approver command (paths only - never the credential), when it knows it
  const approverCommand = runtimeState?.approverCommand ? `${runtimeState.approverCommand}${approval.approvalId}` : null;
  const [open, setOpen] = useState(false);
  const expired = approval.expiresAtMs != null && now >= approval.expiresAtMs;
  const left = approval.expiresAtMs != null ? Math.max(0, Math.round((approval.expiresAtMs - now) / 1000)) : null;
  const isCommand = approval.operation === "command";
  const what = isCommand ? "Run command" : approval.operation === "write" ? "Write file" : "Edit file";
  return (
    <section className={`nv-approval${expired ? " nv-approval--expired" : ""}`} role="region" aria-label="Pending approval" data-expired={expired ? "true" : "false"}>
      <div className="nv-approval__row">
        <PauseCircle size={16} aria-hidden="true" />
        <strong>{expired ? "Approval expired — nothing ran" : "Approval needed — nothing has run"}</strong>
        <Badge tone="purple">{what}</Badge>
        <Badge mono>{approval.target ?? approval.tool}</Badge>
        <Badge tone={expired ? "error" : "warning"}>{expired ? "expired" : left != null ? `expires in ${clock(left)}` : "pending"}</Badge>
        <span className="nv-approval__spacer" />
        <CopyButton text={approval.approvalId} label="Copy approval id" />
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)} icon={open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}>
          Details
        </Button>
      </div>
      <p className="nv-note nv-approval__how">
        Approve or deny in the separate approver: <span className="nv-mono">nexus-approver … review {short(approval.approvalId)}…</span>. Nexus Desktop cannot approve or deny.
      </p>
      {open && (
        <div className="nv-approval__more">
          <p className="nv-note" role="note">
            <strong>Model proposal — not the authoritative request.</strong> Nexus shows what the model asked for, as the broker understood it. The exact request that would
            run is derived by the daemon and is shown only to the approver. Inspect that actual request in <span className="nv-mono">nexus-approver review</span> before
            approving anything.
          </p>
          {approval.proposal ? (
            <pre className="nv-msg__pre" aria-label="Proposed operation (model proposal, unverified)">{approval.proposal}</pre>
          ) : (
            <p className="nv-note">{approval.summary}</p>
          )}
          {(approval.restrictions?.length ?? 0) > 0 && (
            <ul className="nv-list" aria-label="Restrictions">
              {approval.restrictions!.map((r) => (
                <li key={r}>
                  <Check size={11} aria-hidden="true" /> {r}
                </li>
              ))}
            </ul>
          )}
          <p className="nv-note">
            The approver sees the exact {isCommand ? "argument vector and sandbox policy" : "diff"} (request digest <span className="nv-mono">{short(approval.requestDigest)}</span>).
          </p>
          <pre className="nv-msg__pre" aria-label="Approver command">{approverCommand ?? `nexus-approver --socket <daemon socket> --cap-file <approver credential file> review ${approval.approvalId}`}</pre>
          {approverCommand && <CopyButton text={approverCommand} label="Copy approver command" />}
        </div>
      )}
    </section>
  );
}
