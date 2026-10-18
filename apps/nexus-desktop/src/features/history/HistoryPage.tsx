import { RunList } from "./RunList";

export function HistoryPage() {
  return (
    <div className="nv-page nv-narrow">
      <h1 className="nv-pagetitle">History</h1>
      <p className="nv-note">Every run recorded by the broker. Opening one reopens its result, evidence and transcript from durable records, including after a restart.</p>
      <RunList filters />
    </div>
  );
}
