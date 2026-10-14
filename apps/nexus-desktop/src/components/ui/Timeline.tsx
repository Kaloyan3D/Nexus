import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type TimelineTone = "neutral" | "purple" | "success" | "warning" | "error";

export interface TimelineItem {
  key: string;
  icon: LucideIcon;
  tone?: TimelineTone;
  title: ReactNode;
  time?: string | null;
  body?: ReactNode;
  badge?: ReactNode;
}

export function Timeline({ items, label }: { items: TimelineItem[]; label: string }) {
  return (
    <ol className="nv-timeline" aria-label={label}>
      {items.map((it) => (
        <li key={it.key} className="nv-timeline__item">
          <span className={`nv-timeline__node nv-timeline__node--${it.tone ?? "neutral"}`}>
            <it.icon size={15} aria-hidden="true" />
          </span>
          <div className="nv-timeline__content">
            <div className="nv-timeline__head">
              <span className="nv-timeline__title">{it.title}</span>
              {it.badge}
              {it.time && <span className="nv-timeline__time">{it.time}</span>}
            </div>
            {it.body && <div className="nv-timeline__body">{it.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
