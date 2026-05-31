/* Formatting helpers (§2.3 money rules). Exposed on window.fmt. */
(function () {
  const usd = (v, opts = {}) => {
    const n = typeof v === "string" ? parseFloat(v) : v;
    const { sign = false, cents = true } = opts;
    const s = n.toLocaleString("en-US", {
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    });
    const pre = sign && n > 0 ? "+" : "";
    return pre + "$" + s;
  };
  const num = (v, dp = 2) => {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  };
  // bps → percent string, e.g. 418 -> "4.18%"
  const bpsToPct = (bps, dp = 2) => (bps / 100).toFixed(dp) + "%";
  const pctSigned = (bps, dp = 2) => (bps > 0 ? "+" : "") + (bps / 100).toFixed(dp) + "%";
  const bpsSigned = (bps) => (bps > 0 ? "+" : "") + bps + " bps";
  const bpsToWeight = (bps) => Math.round(bps / 100); // 4700 -> 47 (%)
  const price = (v, dp = 4) => "$" + num(v, dp); // share/peg prices, e.g. $1.0047
  const shortAddr = (a, head = 6, tail = 4) =>
    a && a.length > head + tail ? a.slice(0, head) + "…" + a.slice(-tail) : a;
  const shortHash = (h, head = 6, tail = 4) =>
    h && h.length > head + tail ? h.slice(0, head) + "…" + h.slice(-tail) : h;

  const timeAgo = (iso) => {
    const then = new Date(iso).getTime();
    const now = new Date("2026-06-11T19:00:00Z").getTime(); // fixture "now"
    const s = Math.max(1, Math.floor((now - then) / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    const d = Math.floor(h / 24);
    return d + "d ago";
  };
  const dateShort = (iso) =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const dateTime = (iso) =>
    new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";

  window.fmt = { usd, num, bpsToPct, pctSigned, bpsSigned, bpsToWeight, price, shortAddr, shortHash, timeAgo, dateShort, dateTime };
})();
