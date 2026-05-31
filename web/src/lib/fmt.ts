// Formatting helpers (§2.3 money rules). Matches Design/src/util.js exactly.

export function usd(v: string | number, opts: { sign?: boolean; cents?: boolean } = {}): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  const { sign = false, cents = true } = opts;
  const s = n.toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
  const pre = sign && n > 0 ? "+" : "";
  return pre + "$" + s;
}

export function num(v: string | number, dp = 2): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function bpsToPct(bps: number, dp = 2): string {
  return (bps / 100).toFixed(dp) + "%";
}

export function pctSigned(bps: number, dp = 2): string {
  return (bps > 0 ? "+" : "") + (bps / 100).toFixed(dp) + "%";
}

export function bpsSigned(bps: number): string {
  return (bps > 0 ? "+" : "") + bps + " bps";
}

export function bpsToWeight(bps: number): number {
  return Math.round(bps / 100);
}

export function price(v: string | number, dp = 4): string {
  return "$" + num(v, dp);
}

export function shortAddr(a: string, head = 6, tail = 4): string {
  return a && a.length > head + tail ? a.slice(0, head) + "…" + a.slice(-tail) : a;
}

export function shortHash(h: string, head = 6, tail = 4): string {
  return h && h.length > head + tail ? h.slice(0, head) + "…" + h.slice(-tail) : h;
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(1, Math.floor((now - then) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

export function dateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function dateTime(iso: string): string {
  return (
    new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " UTC"
  );
}
