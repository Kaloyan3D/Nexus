import type { ModelSelection, RegistryTarget, ThreadTarget } from "../../lib/contracts";
import { reasonWords, selectionOf, targetLabel } from "./modelTargets";

export const DEFAULT_OPTION = "default";

/** Value carried by the picker's <select>: default or one route id. */
export function valueOfSelection(targets: RegistryTarget[], model: ModelSelection | null | undefined): string {
  if (!model) return DEFAULT_OPTION;
  const hit = targets.find(
    (t) =>
      t.providerId === model.providerId &&
      t.remoteModelId === model.remoteModelId &&
      (model.routeId == null || t.routeId === model.routeId),
  );
  return hit ? hit.routeId : DEFAULT_OPTION;
}

export function selectionOfValue(targets: RegistryTarget[], value: string): ModelSelection | null {
  if (value === DEFAULT_OPTION) return null;
  const hit = targets.find((t) => t.routeId === value);
  return hit ? selectionOf(hit) : null;
}

/**
 * Keyboard-operable model picker. Default = "Use the default (as configured)"
 * which sends NO selection. Issuable targets are choices; non-issuable ones
 * are disabled entries showing the plain-words reason.
 */
export function ModelPicker({
  targets,
  value,
  bound,
  disabled,
  onChange,
}: {
  targets: RegistryTarget[] | null;
  value: ModelSelection | null;
  /** The conversation's bound target (existing conversations show it). */
  bound?: ThreadTarget | null;
  disabled?: boolean;
  onChange: (m: ModelSelection | null) => void;
}) {
  const list = targets ?? [];
  const v = valueOfSelection(list, value);
  const picked = selectionOfValue(list, v);
  const switching =
    bound != null &&
    picked != null &&
    (picked.providerId !== bound.providerId ||
      picked.remoteModelId !== bound.remoteModelId ||
      (picked.routeId ?? null) !== (bound.routeId ?? null));
  return (
    <div className="nv-modelpicker">
      <label className="nv-modelpicker__label" htmlFor="nv-model-picker">
        Model
      </label>
      <select
        id="nv-model-picker"
        className="nv-modelpicker__select"
        aria-label="Model"
        value={v}
        disabled={disabled || targets == null}
        onChange={(e) => onChange(selectionOfValue(list, e.target.value))}
      >
        <option value={DEFAULT_OPTION}>Use the default (as configured)</option>
        {list.map((t) => {
          const ok = t.issuable !== false;
          return (
            <option key={t.routeId || `${t.providerId}/${t.remoteModelId}`} value={t.routeId} disabled={!ok}>
              {targetLabel(t)}
              {ok ? "" : ` — unavailable: ${reasonWords(t.reason)}`}
            </option>
          );
        })}
      </select>
      {bound && (
        <p className="nv-note" aria-live="polite">
          This conversation runs on {bound.providerId} / {bound.remoteModelId}
          {bound.routeId ? ` · route ${bound.routeId}` : ""}.
        </p>
      )}
      {switching && picked && (
        <p className="nv-note" role="status">
          This conversation will continue on {picked.providerId} / {picked.remoteModelId}
          {picked.routeId ? ` · route ${picked.routeId}` : ""}; Nexus records the change.
        </p>
      )}
      {targets == null && <p className="nv-note">Model list unavailable.</p>}
    </div>
  );
}
