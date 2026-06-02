// Shared atoms (§7). Matches Design/src/components.jsx.

import { useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icons";
import * as fmt from "../lib/fmt";
import { SIGNAL_TYPES, SEVERITY, FLAGS, RISK, JOB_STATUS, explorer, type SignalTypeKey, type SeverityKey, type RiskLevelKey, type FlagKey, type Evidence, type Outcome, type PaidReceipt, type JobStatusKey } from "../lib/data";

// ---------- Card ----------
export function Card({ children, className = "", pad = true, style }: { children: ReactNode; className?: string; pad?: boolean; style?: CSSProperties }) {
  return <div className={"card " + (pad ? "card-pad " : "") + className} style={style}>{children}</div>;
}

// ---------- StatCard ----------
export function StatCard({ label, value, sub, mono = true, accent, icon, role }: { label: string; value: ReactNode; sub?: string; mono?: boolean; accent?: string; icon?: string; role?: string }) {
  return (
    <div>
      <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {icon && <Icon name={icon} size={14} />}{label}
      </div>
      <div className={"stat-value " + (mono ? "mono " : "")} style={{ marginTop: 6, color: accent ?? (role ? `var(--${role})` : undefined) }}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ---------- CopyButton ----------
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    try { void navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <button className="iconbtn-sm" onClick={copy} aria-label={label ?? "Copy"} title={done ? "Copied" : "Copy"}>
      <Icon name={done ? "check" : "copy"} size={13} />
    </button>
  );
}

// ---------- AddressChip ----------
export function AddressChip({ address, label, kind = "address" }: { address: string; label?: string; kind?: "address" | "tx" }) {
  const url = explorer + "/" + (kind === "tx" ? "tx" : "address") + "/" + address;
  const shown = kind === "tx" ? fmt.shortHash(address) : fmt.shortAddr(address);
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
export function StatusDot({ role = "neutral", pulse = false }: { role?: string; pulse?: boolean }) {
  return <span className={"dot " + (pulse ? "dot-pulse" : "")} style={{ background: `var(--${role})` }} />;
}

// ---------- RiskLevelChip ----------
export function RiskLevelChip({ level, size = "md", showLabel = true }: { level: RiskLevelKey; size?: "md" | "lg"; showLabel?: boolean }) {
  const r = RISK[level];
  return (
    <span className={"chip role-" + r.role + (size === "lg" ? " chip-lg" : "")}>
      <span className="dot" style={{ background: `var(--${r.role})` }} />
      {showLabel ? r.status : level}
    </span>
  );
}

// ---------- ConfidenceMeter ----------
export function ConfidenceMeter({ value, compact = false }: { value: number; compact?: boolean }) {
  const pct = Math.round(value * 100);
  const bars = 5, filled = Math.round(value * bars);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }} title={`Agent confidence ${pct}%`}>
      <span style={{ display: "inline-flex", gap: 2 }} aria-hidden="true">
        {Array.from({ length: bars }).map((_, i) => (
          <span key={i} style={{ width: 4, height: 13, borderRadius: 1.5, background: i < filled ? "var(--primary)" : "var(--border-strong)" }} />
        ))}
      </span>
      {!compact && <span className="mono" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>{value.toFixed(2)}</span>}
      {!compact && <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>confidence</span>}
    </span>
  );
}

// ---------- SignalBadge ----------
export function SignalBadge({ type, severity, withLabel = true }: { type: SignalTypeKey; severity: SeverityKey; withLabel?: boolean }) {
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

// ---------- FlagChip ----------
export function FlagChip({ flag }: { flag: FlagKey }) {
  const ff = FLAGS[flag];
  const role = flag === "NONE" ? "neutral" : flag === "LOW_LIQUIDITY" ? "error" : "warning";
  return (
    <span className={"chip role-" + role} title={"Deterministic flag · " + ff.desc}
      style={{ fontFamily: flag === "NONE" ? "inherit" : "var(--font-mono)" }}>
      {flag !== "NONE" && <Icon name="alert-triangle" size={12} />}
      {ff.label}
    </span>
  );
}

// ---------- EvidenceChip ----------
export function EvidenceChip({ ev }: { ev: Evidence }) {
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

// ---------- GuardrailsMark ----------
export function GuardrailsMark({ small = false }: { small?: boolean }) {
  return (
    <span className="chip role-success" title="This action stayed within the immutable on-chain limits." style={small ? { height: 22, fontSize: "0.7rem" } : {}}>
      <Icon name="shield-check" size={13} />
      Guardrails enforced
    </span>
  );
}

// ---------- OutcomeStrip ----------
export function OutcomeStrip({ outcome, compact = false }: { outcome: Outcome | null | undefined; compact?: boolean }) {
  if (!outcome?.measuredAt) {
    return (
      <span className="chip role-info">
        <span className="dot dot-pulse" style={{ background: "var(--info)" }} />measuring…
      </span>
    );
  }
  const dd = parseFloat(outcome.drawdownAvoidedUsdc);
  const Item = ({ label, val, role }: { label: string; val: string; role?: string }) => (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 1 }}>
      <span className="mono" style={{ fontWeight: 600, fontSize: compact ? "0.8125rem" : "0.9375rem", color: role ? `var(--${role})` : undefined }}>{val}</span>
      <span style={{ fontSize: "0.6875rem", color: "var(--muted)" }}>{label}</span>
    </span>
  );
  return (
    <div style={{ display: "flex", gap: compact ? 18 : 28, alignItems: "center", flexWrap: "wrap" }}>
      <Item label="realized" val={fmt.bpsSigned(outcome.realizedYieldBps)} role={outcome.realizedYieldBps >= 0 ? "success" : "error"} />
      <Item label="vs passive" val={fmt.bpsSigned(outcome.passiveDeltaBps)} role={outcome.passiveDeltaBps >= 0 ? "success" : "error"} />
      {dd > 0 ? <Item label="drawdown avoided" val={"−" + fmt.usd(dd)} role="success" /> : <Item label="drawdown avoided" val="$0.00" />}
    </div>
  );
}

// ---------- Skeleton ----------
export function Skeleton({ w = "100%", h = 16, r = 6, style }: { w?: string | number; h?: number; r?: number; style?: CSSProperties }) {
  return <span className="skeleton" style={{ display: "block", width: w, height: h, borderRadius: r, ...style }} />;
}

// ---------- EmptyState ----------
export function EmptyState({ icon = "circle-dot", title, body, action }: { icon?: string; title: string; body?: string; action?: ReactNode }) {
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
export function ErrorState({ title = "Something went wrong", body, onRetry }: { title?: string; body?: string; onRetry?: () => void }) {
  return (
    <div className="empty">
      <div className="empty-icon" style={{ color: "var(--error)", background: "var(--error-soft)" }}><Icon name="alert-triangle" size={22} /></div>
      <div style={{ fontWeight: 600, color: "var(--base-content)", fontSize: "1rem" }}>{title}</div>
      {body && <div style={{ marginTop: 6 }}>{body}</div>}
      {onRetry && <div style={{ marginTop: 16 }}><button className="btn btn-ghost btn-sm" onClick={onRetry}><Icon name="refresh-cw" size={14} />Retry</button></div>}
    </div>
  );
}

// ---------- InfoTip ----------
export function InfoTip({ text }: { text: string }) {
  return <span tabIndex={0} className="iconbtn-sm" title={text} style={{ color: "var(--faint)", cursor: "help" }} aria-label={text}><Icon name="info" size={13} /></span>;
}

// ---------- Spinner ----------
export function Spinner({ size = 16 }: { size?: number }) {
  return <Icon name="loader-2" size={size} style={{ animation: "spin 0.8s linear infinite" }} />;
}

// ---------- PaidEvidenceBadge (x402, A4.1) ----------
// "The agent paid for the evidence it acted on." Links the settlement receipt.
export function PaidEvidenceBadge({ receipt }: { receipt: PaidReceipt }) {
  return (
    <a className="chip role-success" href={explorer + "/tx/" + receipt.transaction} target="_blank" rel="noreferrer"
      title={`The agent paid ${receipt.amountUsdc} ${receipt.asset} for this evidence (x402 · ${receipt.network})`}
      style={{ textDecoration: "none" }} onClick={(e) => e.stopPropagation()}>
      <Icon name="coins" size={13} />
      Paid {receipt.amountUsdc} {receipt.asset}
      <Icon name="external-link" size={11} />
    </a>
  );
}

// ---------- JobStatusChip (ERC-8183, A4.2) ----------
// A de-risk's verifiable-Job status; settled by the deterministic guardrail Evaluator.
export function JobStatusChip({ status }: { status: JobStatusKey }) {
  const s = JOB_STATUS[status];
  return (
    <span className={"chip role-" + s.role} title={`ERC-8183 verifiable Job · ${s.label} — ${s.means}`}>
      <Icon name="shield-check" size={12} />Job {s.label}
    </span>
  );
}

// ---------- RwaFormSplit (RWA core USDY/mUSD, task 2.7) ----------
// Sublabel on the allocation USDY slice: held as USDY and/or its rebasing $1 form mUSD.
export function RwaFormSplit({ usdyUsdc, musdUsdc }: { usdyUsdc: string; musdUsdc: string }) {
  const usdy = parseFloat(usdyUsdc), musd = parseFloat(musdUsdc), total = usdy + musd;
  if (!(total > 0)) return null;
  const usdyPct = Math.round((usdy / total) * 100);
  const musdPct = 100 - usdyPct;
  return (
    <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: "0.75rem", color: "var(--muted)" }}
      title="The RWA core (bucket 2) is held as USDY and/or its rebasing $1 form mUSD — convertible 1:1 by NAV via the Ondo wrap/unwrap converter. totalAssets is conserved across a conversion.">
      <span style={{ fontWeight: 600, color: "var(--base-content)" }}>RWA core form</span>
      <span style={{ display: "inline-flex", height: 6, width: 110, borderRadius: 99, overflow: "hidden", background: "var(--base-300)" }} aria-hidden="true">
        <span style={{ width: usdyPct + "%", background: "var(--primary)" }} />
        <span style={{ width: musdPct + "%", background: "color-mix(in srgb, var(--primary) 42%, var(--base-300))" }} />
      </span>
      <span className="mono">USDY {usdyPct}%</span>
      <span style={{ color: "var(--faint)", fontWeight: 500 }}>{fmt.usd(usdy, { cents: false })}</span>
      <span style={{ color: "var(--faint)" }}>·</span>
      <span className="mono">mUSD {musdPct}%</span>
      <span style={{ color: "var(--faint)", fontWeight: 500 }}>{fmt.usd(musd, { cents: false })}</span>
    </div>
  );
}
