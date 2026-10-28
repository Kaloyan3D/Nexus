import { Copy, ExternalLink, Loader2, ScrollText, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { asUiError } from "../../lib/api";
import type { JobView, UiError } from "../../lib/contracts";
import { relativeTime } from "../../lib/format";
import { Alert, Badge, Button } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";
import { jobStateView, jobTitle, useJobs } from "./useJobs";

function Logs({ job }: { job: JobView }) {
  const { api } = useNexus();
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = job.state === "running";
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .jobLogs(job.jobId)
        .then((r) => alive && (setText(r.logs), setErr(null)))
        .catch((e: unknown) => alive && setErr(asUiError(e).message));
    load();
    const h = running ? setInterval(load, 3_000) : undefined;
    return () => {
      alive = false;
      if (h) clearInterval(h);
    };
  }, [api, job.jobId, running]);
  if (err) return <p className="nv-note">The log is not available: {err}</p>;
  if (text === null) return <p className="nv-note">Reading the log…</p>;
  return (
    <>
      <pre className="nv-msg__pre nv-preview__log" aria-label={`Log of ${jobTitle(job)}`}>
        {text.trim() === "" ? "(nothing written yet)" : text}
      </pre>
      <p className="nv-note">The most recent output, with secrets removed. It is what the program printed, not a verified result.{job.logTruncated ? " Older output was dropped to keep the log small." : ""}</p>
    </>
  );
}

function JobRow({ job, onChanged }: { job: JobView; onChanged: () => void }) {
  const { api } = useNexus();
  const v = jobStateView(job);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"open" | "stop" | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const run = async (what: "open" | "stop", f: () => Promise<unknown>) => {
    setBusy(what);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr(asUiError(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  const preview = job.exposed[0];
  return (
    <li className="nv-preview" aria-label={`Background process ${jobTitle(job)}`}>
      <div className="nv-preview__head">
        <Badge tone={v.tone}>{v.label}</Badge>
        <code className="nv-preview__cmd">{jobTitle(job)}</code>
        <span className="nv-note nv-preview__when" title={new Date(job.startedAtMs).toLocaleString()}>
          started {relativeTime(new Date(job.startedAtMs).toISOString())}
        </span>
      </div>
      {v.running && job.exposed.length > 0 && (
        <div className="nv-preview__actions">
          {job.exposed.map((x) => (
            <Button
              key={x.port}
              size="sm"
              variant="primary"
              icon={busy === "open" ? <Loader2 size={13} className="nv-spin" /> : <ExternalLink size={13} />}
              disabled={busy !== null}
              onClick={() => void run("open", async () => setOpened(await api.previewOpen(job.jobId, x.port)))}
              aria-label={`Open preview of ${jobTitle(job)}${job.exposed.length > 1 ? ` on port ${x.port}` : ""}`}
            >
              Open preview{job.exposed.length > 1 ? ` (${x.port})` : ""}
            </Button>
          ))}
          <code className="nv-preview__url" title="Only this computer can reach this address">
            {preview ? `http://127.0.0.1:${preview.hostPort}` : ""}
          </code>
          {preview && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy size={13} />}
              aria-label="Copy the preview address"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(`http://127.0.0.1:${preview.hostPort}`)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
      )}
      {v.running && job.exposed.length === 0 && <p className="nv-note">This process is running but has no preview address.</p>}
      <div className="nv-preview__actions">
        <Button size="sm" variant="ghost" aria-expanded={open} icon={<ScrollText size={13} />} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide log" : "Show log"}
        </Button>
        {v.running && (
          <Button size="sm" icon={busy === "stop" ? <Loader2 size={13} className="nv-spin" /> : <Square size={13} />} disabled={busy !== null} onClick={() => void run("stop", () => api.jobStop(job.jobId))} aria-label={`Stop ${jobTitle(job)}`}>
            Stop
          </Button>
        )}
      </div>
      {opened && <p className="nv-note" role="status">Opened {opened} in your browser.</p>}
      {err && (
        <Alert tone="warning" title={busy === null ? "That did not work" : "Working…"}>
          {err.message}
        </Alert>
      )}
      {open && <Logs job={job} />}
    </li>
  );
}

/**
 * The development servers and other background processes Nexus is running for a project: whether each is
 * running, where to see it, its log, and a Stop that ends it. Shown only when there is something to show.
 */
export function PreviewsPanel({ projectId, heading = "Running on this computer", showEnded = true }: { projectId?: string | null; heading?: string | null; showEnded?: boolean }) {
  const { jobs, error, reload } = useJobs(projectId);
  const [showAll, setShowAll] = useState(false);
  if (error && jobs.length === 0) return null;
  const live = jobs.filter((j) => j.state === "running");
  const ended = jobs.filter((j) => j.state !== "running").sort((a, b) => (b.endedAtMs ?? b.startedAtMs) - (a.endedAtMs ?? a.startedAtMs));
  if (live.length === 0 && (!showEnded || ended.length === 0)) return null;
  return (
    <section aria-label="Running processes" className="nv-previews">
      {heading && <h2 className="nv-subheading">{heading}</h2>}
      <ul className="nv-previews__list">
        {live.map((j) => (
          <JobRow key={j.jobId} job={j} onChanged={reload} />
        ))}
      </ul>
      {showEnded && ended.length > 0 && (
        <>
          <Button size="sm" variant="ghost" aria-expanded={showAll} onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Hide" : "Show"} {ended.length} ended process{ended.length === 1 ? "" : "es"}
          </Button>
          {showAll && (
            <ul className="nv-previews__list">
              {ended.slice(0, 10).map((j) => (
                <JobRow key={j.jobId} job={j} onChanged={reload} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
