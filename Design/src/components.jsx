/* Shared atoms (§7). Exported to window. Depends on window.Icon, window.fmt, window.CUSTOS. */
(function () {
  const { useState, useEffect, useRef } = React;
  const { SIGNAL_TYPES, SEVERITY, FLAGS, RISK, explorer } = window.CUSTOS;
  const f = window.fmt;
  const Icon = window.Icon;

  // ---------- Card ----------
  function Card({ children, className = "", pad = true, style }) {
    return <div className={"card " + (pad ? "card-pad " : "") + className} style={style}>{children}</div>;
  }

  // ---------- StatCard ----------
  function StatCard({ label, value, sub, mono = true, accent, icon, role }) {
    return (
      <div>
        <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {icon && <Icon name={icon} size={14} />}{label}
        </div>
        <div className={"stat-value " + (mono ? "mono " : "")} style={{ marginTop: 6, color: accent || (role ? `var(--${role})` : undefined) }}>{value}</div>
        {sub && <div className="stat-sub">{sub}</div>}
      </div>
    );
  }

  // ---------- MoneyValue ----------
  function MoneyValue({ amount, size = "1rem", sub, sign = false, role, weight = 600 }) {
    return (
      <span className="mono" style={{ fontSize: size, fontWeight: weight, color: role ? `var(--${role})` : undefined }}>
        {f.usd(amount, { sign })}{sub && <span style={{ color: "var(--faint)", fontWeight: 500, fontSize: "0.78em", marginLeft: 4 }}>{sub}</span>}
      </span>
    );
  }

  // ---------- CopyButton ----------
  function CopyButton({ text, label }) {
    const [done, setDone] = useState(false);
    const copy = (e) => {
      e.stopPropagation();
      try { navigator.clipboard.writeText(text); } catch (_) {}
      setDone(true); setTimeout(() => setDone(false), 1200);
    };
    return (
      <button className="iconbtn-sm" onClick={copy} aria-label={label || "Copy"} title={done ? "Copied" : "Copy"}>
        <Icon name={done ? "check" : "copy"} size={13} />
      </button>
    );
  }

  // ---------- AddressChip ----------
  function AddressChip({ address, label, kind = "address" }) {
    const url = explorer + "/" + (kind === "tx" ? "tx" : "address") + "/" + address;
    const shown = kind === "tx" ? f.shortHash(address) : f.shortAddr(address);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
        {label && <span style={{ color: "var(--muted)", fontSize: "0.8125rem", marginRight: 4 }}>{label}</span>}
        <span className="mono" style={{ fontSize: "0.8125rem" }}>{shown}</span>
        <CopyButton text={address} label="Copy address" />
        <a className="iconbtn-sm" href={url} target="_blank" rel="noreferrer" aria-label="View on Mantlescan" title="View on Mantlescan" onClick={(e) => e.stopPropagation()}>
          <Icon name="external-link" size={13} />
        </a>
      </span>
    );
  }

  // ---------- StatusDot ----------
  function StatusDot({ role = "neutral", pulse = false }) {
    return <span className={"dot " + (pulse ? "dot-pulse" : "")} style={{ background: `var(--${role})` }} />;
  }

  // ---------- RiskLevelChip ----------
  function RiskLevelChip({ level, size = "md", showLabel = true }) {
    const r = RISK[level];
    return (
      <span className={"chip role-" + r.role + (size === "lg" ? " chip-lg" : "")}>
        <span className="dot" style={{ background: `var(--${r.role})` }} />
        {showLabel ? r.status : level}
      </span>
    );
  }

  // ---------- ConfidenceMeter ----------
  function ConfidenceMeter({ value, compact = false }) {
    const pct = Math.round(value * 100);
    const bars = 5, filled = Math.round(value * bars);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }} title={`Agent confidence ${pct}%`}>
        <span style={{ display: "inline-flex", gap: 2 }} aria-hidden="true">
          {Array.from({ length: bars }).map((_, i) => (
            <span key={i} style={{ width: 4, height: 13, borderRadius: 1.5, background: i < filled ? "var(--primary)" : "var(--border-strong)" }} />
          ))}
        </span>
        {!compact && <span className="mono" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>{(value).toFixed(2)}</span>}
        {!compact && <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>confidence</span>}
      </span>
    );
  }

  // ---------- SignalBadge (typed + severity) ----------
  function SignalBadge({ type, severity, withLabel = true }) {
    const t = SIGNAL_TYPES[type], sev = SEVERITY[severity];
    return (
      <span className={"chip role-" + sev.role} title={`${t.label} signal · ${sev.label} severity`}>
        <Icon name={t.icon} size={13} />
        {withLabel && <span>{t.label}</span>}
        <span style={{ opacity: 0.55 }}>·</span>
        <span>{sev.label}</span>
      </span>
    );
  }

  // ---------- FlagChip (deterministic, pre-LLM) ----------
  function FlagChip({ flag }) {
    const ff = FLAGS[flag];
    const role = flag === "NONE" ? "neutral" : flag === "LOW_LIQUIDITY" ? "error" : "warning";
    return (
      <span className={"chip role-" + role} title={"Deterministic flag · " + ff.desc} style={{ fontFamily: flag === "NONE" ? "inherit" : "var(--font-mono)" }}>
        {flag !== "NONE" && <Icon name="alert-triangle" size={12} />}
        {ff.label}
      </span>
    );
  }

  // ---------- EvidenceChip ----------
  function EvidenceChip({ ev }) {
    const t = SIGNAL_TYPES[ev.type];
    return (
      <a className="chip role-neutral" href={ev.url} target="_blank" rel="noreferrer"
        title={ev.summary} style={{ textDecoration: "none", maxWidth: "100%" }} onClick={(e) => e.stopPropagation()}>
        <Icon name={t.icon} size={13} />
        <span style={{ fontWeight: 600 }}>{ev.source}</span>
        <span style={{ color: "var(--faint)", fontWeight: 500 }}>· {ev.publishedAt}</span>
        <Icon name="external-link" size={11} />
      </a>
    );
  }

  // ---------- GuardrailsEnforced mark ----------
  function GuardrailsMark({ small = false }) {
    return (
      <span className="chip role-success" title="This action stayed within the immutable on-chain limits." style={small ? { height: 22, fontSize: "0.7rem" } : {}}>
        <Icon name="shield-check" size={13} />
        Guardrails enforced
      </span>
    );
  }

  // ---------- OutcomeStrip ----------
  function OutcomeStrip({ outcome, compact = false }) {
    if (!outcome || !outcome.measuredAt || outcome.measuredAt === 0) {
      return (
        <span className="chip role-info">
          <span className="dot dot-pulse" style={{ background: "var(--info)" }} />measuring…
        </span>
      );
    }
    const dd = parseFloat(outcome.drawdownAvoidedUsdc);
    const Item = ({ label, val, role }) => (
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 1 }}>
        <span className="mono" style={{ fontWeight: 600, fontSize: compact ? "0.8125rem" : "0.9375rem", color: role ? `var(--${role})` : undefined }}>{val}</span>
        <span style={{ fontSize: "0.6875rem", color: "var(--muted)" }}>{label}</span>
      </span>
    );
    return (
      <div style={{ display: "flex", gap: compact ? 18 : 28, alignItems: "center", flexWrap: "wrap" }}>
        <Item label="realized" val={f.bpsSigned(outcome.realizedYieldBps)} role={outcome.realizedYieldBps >= 0 ? "success" : "error"} />
        <Item label="vs passive" val={f.bpsSigned(outcome.passiveDeltaBps)} role={outcome.passiveDeltaBps >= 0 ? "success" : "error"} />
        <Item label="drawdown avoided" val={dd > 0 ? "−" + f.usd(dd) : "$0.00"} role={dd > 0 ? "success" : undefined} />
      </div>
    );
  }

  // ---------- Skeleton ----------
  function Skeleton({ w = "100%", h = 16, r = 6, style }) {
    return <span className="skeleton" style={{ display: "block", width: w, height: h, borderRadius: r, ...style }} />;
  }

  // ---------- EmptyState ----------
  function EmptyState({ icon = "circle-dot", title, body, action }) {
    return (
      <div className="empty">
        <div className="empty-icon"><Icon name={icon} size={22} /></div>
        <div style={{ fontWeight: 600, color: "var(--base-content)", fontSize: "1rem" }}>{title}</div>
        {body && <div style={{ marginTop: 6, maxWidth: "44ch", marginInline: "auto" }}>{body}</div>}
        {action && <div style={{ marginTop: 16 }}>{action}</div>}
      </div>
    );
  }

  // ---------- ErrorState ----------
  function ErrorState({ title = "Something went wrong", body, onRetry }) {
    return (
      <div className="empty">
        <div className="empty-icon" style={{ color: "var(--error)", background: "var(--error-soft)" }}><Icon name="alert-triangle" size={22} /></div>
        <div style={{ fontWeight: 600, color: "var(--base-content)", fontSize: "1rem" }}>{title}</div>
        {body && <div style={{ marginTop: 6 }}>{body}</div>}
        {onRetry && <div style={{ marginTop: 16 }}><button className="btn btn-ghost btn-sm" onClick={onRetry}><Icon name="refresh-cw" size={14} />Retry</button></div>}
      </div>
    );
  }

  // ---------- Tooltip (lightweight) ----------
  function InfoTip({ text }) {
    return <span tabIndex={0} className="iconbtn-sm" title={text} style={{ color: "var(--faint)", cursor: "help" }} aria-label={text}><Icon name="info" size={13} /></span>;
  }

  // ---------- Spinner ----------
  function Spinner({ size = 16 }) {
    return <Icon name="loader-2" size={size} style={{ animation: "spin 0.8s linear infinite" }} />;
  }

  Object.assign(window, {
    Card, StatCard, MoneyValue, CopyButton, AddressChip, StatusDot, RiskLevelChip,
    ConfidenceMeter, SignalBadge, FlagChip, EvidenceChip, GuardrailsMark, OutcomeStrip,
    Skeleton, EmptyState, ErrorState, InfoTip, Spinner,
  });
})();
