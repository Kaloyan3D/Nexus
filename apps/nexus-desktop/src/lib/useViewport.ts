import { useEffect, useState } from "react";

export type Layout = "wide" | "medium" | "compact";

function layoutFor(width: number): Layout {
  if (width >= 1440) return "wide";
  if (width >= 1000) return "medium";
  return "compact";
}

export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(() => layoutFor(window.innerWidth));
  useEffect(() => {
    const onResize = () => setLayout(layoutFor(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return layout;
}

/** Auto-scroll that yields to the user: only follows while pinned near the bottom. */
export function stickToBottom(el: HTMLElement | null, threshold = 48): boolean {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/** Wall-clock tick for staleness displays (keeps render pure). */
export function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
