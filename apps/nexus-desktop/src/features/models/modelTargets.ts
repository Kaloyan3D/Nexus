import type { ModelSelection, RegistryTarget, ThreadTarget } from "../../lib/contracts";

/** Machine catalog reason -> plain words. Unknown reasons shown verbatim. */
export function reasonWords(reason: string | null | undefined): string {
  if (!reason) return "Not available.";
  const r = reason.trim();
  const map: Record<string, string> = {
    "connection-not-connected": "Its connection is not connected.",
    "route-not-verified": "Its route is not verified.",
    "protocol-unsupported": "Its protocol is not supported.",
    "no-billing-tier": "It has no billing tier.",
    "no-credential-ref": "It has no credential configured.",
    "model-disabled": "The model is disabled.",
    "context-unknown": "Its context limit is unknown.",
    "output-unknown": "Its output limit is unknown.",
    "no-data-use": "Its data-use terms are not declared.",
    "provider-disabled": "Its provider is disabled.",
    "connection-auth-required": "Its connection needs to be signed in.",
    "route-unavailable": "Its route is unavailable.",
    "route-model-identity-mismatch": "Its route does not match the model it names.",
    "route-provider-mismatch": "Its route does not match the provider it names.",
    "unknown-route": "The Registry does not know this route.",
    "unknown-model": "The Registry does not know this model.",
    "unknown-provider": "The Registry does not know this provider.",
    "unknown-reference": "It refers to something the Registry does not know.",
    "unknown-target": "The Registry does not know this target.",
  };
  return map[r] ?? r;
}

export function targetLabel(t: RegistryTarget): string {
  const route = t.routeId ? ` · ${t.routeId}` : "";
  return `${t.providerId} / ${t.remoteModelId}${route}`;
}

export function boundLabel(t: ThreadTarget | null | undefined): string | null {
  if (!t) return null;
  const route = t.routeId ? ` · route ${t.routeId}` : "";
  return `${t.providerId} / ${t.remoteModelId}${route}`;
}

/** Identities-only selection for one catalog target. */
export function selectionOf(t: RegistryTarget): ModelSelection {
  return {
    providerId: t.providerId,
    remoteModelId: t.remoteModelId,
    logicalModelId: t.logicalModelId ?? null,
    routeId: t.routeId ?? null,
  };
}

/** Broker refusal code -> clear message including the reason. */
export function refusalMessage(code: string, message: string): string {
  const m = (message || "").trim();
  switch (code) {
    case "model-not-available":
      return m ? `That model is not available: ${m}` : "That model is not available.";
    case "ambiguous-target":
      return m ? `That choice matches more than one target: ${m}` : "That choice matches more than one target.";
    case "model-not-allowed":
      return m ? `That model is not allowed: ${m}` : "That model is not allowed.";
    default:
      return m || `The broker refused the request (${code}).`;
  }
}

/**
 * A run that ended "failed before submission" with
 * registry-selection-not-issuable: the Registry changed inside the broker's
 * 30 s catalog cache. Word it honestly; no retry loop.
 */
export function failedBeforeSubmissionMessage(errorCode: string | null, errorMessage: string | null): string | null {
  if (errorCode !== "registry-selection-not-issuable") return null;
  void errorMessage;
  return "The Registry changed after the model list was read, so this choice is no longer usable. Pick the model again from the current list.";
}

/** True when a secret-looking key slipped into a view model (test guard). */
export function hasSecretField(o: unknown): boolean {
  if (!o || typeof o !== "object") return false;
  const bad = ["credential", "secret", "token", "password", "apiKey", "api_key", "path", "connectionRef", "credentialRef"];
  const seen: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.length > 50) return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const kl = k.toLowerCase();
      if (bad.some((b) => kl.includes(b.toLowerCase()) && kl !== "outputlimittokens" && kl !== "contextlimittokens")) {
        // `*tokens` limits are numbers, not secrets; `path` never allowed.
        if (kl.includes("token") && typeof val === "number") continue;
        seen.push(k);
      }
      if (val && typeof val === "object") walk(val);
    }
  };
  walk(o);
  return seen.length > 0;
}
