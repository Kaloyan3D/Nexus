import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNexus, type Page } from "../../state/NexusContext";
import { shortId } from "../../lib/format";

interface Item {
  id: string;
  group: "Destinations" | "Tasks";
  label: string;
  hint: string;
  run: () => void;
}

const DESTINATIONS: Array<{ id: Page; label: string }> = [
  { id: "workspace", label: "Workspace" },
  { id: "projects", label: "Projects" },
  { id: "history", label: "History" },
  { id: "models", label: "Models" },
  { id: "sentry", label: "Sentry" },
  { id: "settings", label: "Settings" },
  { id: "tasks", label: "Advanced: Controller ledger" },
  { id: "control-room", label: "Advanced: Control Room" },
  { id: "mock", label: "Advanced: Mock runs" },
];

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { tasks, setPage, select } = useNexus();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const dest: Item[] = DESTINATIONS.filter((d) => d.label.toLowerCase().includes(needle)).map(
      (d) => ({
        id: `dest-${d.id}`,
        group: "Destinations",
        label: d.label,
        hint: "Go to",
        run: () => setPage(d.id),
      }),
    );
    const list = tasks.data?.available ? tasks.data.tasks : [];
    const found: Item[] = needle
      ? list
          .filter(
            (t) =>
              t.taskId.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle),
          )
          .slice(0, 8)
          .map((t) => ({
            id: `task-${t.taskId}`,
            group: "Tasks" as const,
            label: t.title,
            hint: t.taskId,
            run: () => {
              setPage("mock");
              select({ kind: "task", id: t.taskId });
            },
          }))
      : [];
    return [...dest, ...found];
  }, [q, tasks.data, setPage, select]);

  const choose = (i: Item | undefined) => {
    if (!i) return;
    i.run();
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active]);
    }
  };

  let lastGroup = "";
  return (
    <>
      <div className="nv-overlay" onMouseDown={onClose} aria-hidden="true" />
      <div className="nv-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <div className="nv-palette__input">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            placeholder="Search tasks and destinations…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="nv-palette-list"
            aria-activedescendant={items[active] ? `pal-${items[active]!.id}` : undefined}
          />
        </div>
        <div className="nv-palette__list" id="nv-palette-list" role="listbox">
          {items.length === 0 && (
            <div className="nv-empty" style={{ padding: 16 }}>
              {tasks.data?.available
                ? "No matching destinations or tasks."
                : "No matching destinations. Task search is unavailable until the Controller ledger loads."}
            </div>
          )}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="nv-palette__group">{header}</div>}
                <button
                  type="button"
                  id={`pal-${it.id}`}
                  role="option"
                  aria-selected={i === active}
                  className="nv-palette__item"
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(it)}
                >
                  <span>{it.label}</span>
                  <span className="nv-muted nv-mono">
                    {it.group === "Tasks" ? shortId(it.hint, 12) : i === active ? <CornerDownLeft size={12} /> : it.hint}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
