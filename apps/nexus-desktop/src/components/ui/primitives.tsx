import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Info,
  Loader2,
  Search,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { isMac } from "../../lib/format";

export type Tone = "neutral" | "purple" | "success" | "warning" | "error";

export function Button({
  variant = "default",
  size = "md",
  icon,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost";
  size?: "md" | "sm";
  icon?: ReactNode;
}) {
  const cls = [
    "nv-btn",
    variant === "primary" && "nv-btn--primary",
    variant === "ghost" && "nv-btn--ghost",
    size === "sm" && "nv-btn--sm",
    !children && "nv-btn--icon",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export function Badge({
  tone = "neutral",
  mono = false,
  icon,
  children,
  title,
}: {
  tone?: Tone;
  mono?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  const cls = ["nv-badge", tone !== "neutral" && `nv-badge--${tone}`, mono && "nv-badge--mono"]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} title={title}>
      {icon}
      {children}
    </span>
  );
}

export function StatusDot({ tone = "neutral", pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={["nv-dot", tone !== "neutral" && `nv-dot--${tone}`, pulse && "nv-dot--pulse"]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="nv-kbd" aria-hidden="true">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  );
}

export function modKeys(key: string): string[] {
  return [isMac() ? "⌘" : "Ctrl", key];
}

export interface TabDef {
  id: string;
  label: string;
  disabled?: boolean;
  hint?: string;
}

export function Tabs({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="nv-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          title={t.hint}
          className="nv-tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function SectionHeading({
  icon: Icon,
  children,
  aside,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="nv-section-heading">
      {Icon && <Icon size={15} aria-hidden="true" />}
      <h3 style={{ font: "inherit" }}>{children}</h3>
      {aside && <span className="nv-section-heading__aside">{aside}</span>}
    </div>
  );
}

export function KeyValue({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode | null | undefined; mono?: boolean }>;
}) {
  return (
    <dl className="nv-kv">
      {rows.map((r) => {
        const missing = r.value === null || r.value === undefined || r.value === "";
        return (
          <div key={r.label} style={{ display: "contents" }}>
            <dt>{r.label}</dt>
            <dd className={[missing && "nv-muted", r.mono && "nv-mono"].filter(Boolean).join(" ")}>
              {missing ? "—" : r.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "error";
  title?: string;
  children?: ReactNode;
}) {
  const Icon = tone === "error" ? XCircle : tone === "warning" ? AlertTriangle : Info;
  return (
    <div className={`nv-alert nv-alert--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={16} aria-hidden="true" />
      <div>
        {title && <div className="nv-alert__title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="nv-empty">
      <Icon size={28} aria-hidden="true" strokeWidth={1.5} />
      <div className="nv-empty__title">{title}</div>
      {children && <div className="nv-empty__body">{children}</div>}
      {action}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="nv-loading" role="status">
      <Loader2 size={15} className="nv-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <label className="nv-search">
      <Search size={15} aria-hidden="true" />
      <span className="nv-sr-only">{label}</span>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function CodeBlock({
  title,
  children,
  wrap = false,
}: {
  title?: string;
  children: string;
  wrap?: boolean;
}) {
  return (
    <div className={`nv-code${wrap ? " nv-code--wrap" : ""}`}>
      {title && <div className="nv-code__head">{title}</div>}
      <pre tabIndex={0}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function CheckRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: "pass" | "fail" | "unknown";
  detail?: string;
}) {
  const Icon = status === "pass" ? CheckCircle2 : status === "fail" ? XCircle : CircleDashed;
  const word = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "NOT RUN";
  return (
    <div className="nv-check" title={detail}>
      <Icon size={15} className={`nv-check__icon nv-check__icon--${status}`} aria-hidden="true" />
      <span className="nv-check__label">{label}</span>
      <span className="nv-check__state">{word}</span>
    </div>
  );
}
