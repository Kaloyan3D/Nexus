import { ShieldCheck } from "lucide-react";
import { EmptyState } from "../../components/ui/primitives";

export function SentryPage() {
  return (
    <div className="nv-page">
      <h1 className="nv-page__title">Sentry</h1>
      <p className="nv-page__sub">Security review and findings.</p>
      <EmptyState icon={ShieldCheck} title="Sentry integration unavailable">
        The native runtime does not expose a Sentry API yet, so Nexus shows no findings, scores or scan
        history here. This page will light up when a real Sentry data source exists.
      </EmptyState>
    </div>
  );
}
