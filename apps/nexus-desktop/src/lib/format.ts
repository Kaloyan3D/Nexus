export function parseUtc(iso: string | null | undefined): number | null {
  if (!iso) return null;
  // The Controller writes 7 fractional digits; Date only accepts up to 3.
  const norm = iso.replace(/(\.\d{3})\d+/, "$1");
  const t = Date.parse(norm);
  return Number.isNaN(t) ? null : t;
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parseUtc(iso);
  if (t === null) return "—";
  const s = Math.round((now - t) / 1000);
  if (s < 0) return "in the future";
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export function absoluteTime(iso: string | null | undefined): string {
  const t = parseUtc(iso);
  if (t === null) return "—";
  return new Date(t).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function durationBetween(a: string | null, b: string | null): string | null {
  const s = parseUtc(a);
  const e = parseUtc(b);
  if (s === null || e === null || e < s) return null;
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function shortId(id: string, head = 8): string {
  return id.length <= head + 4 ? id : `${id.slice(0, head)}…${id.slice(-4)}`;
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
}
