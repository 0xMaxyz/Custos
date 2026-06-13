// Insights (§5.4) — the risk radar. On the LIVE agent the charts plot real samples
// accumulated this session; the typed fixtures are used only in demo/offline mode.

import type { ReactNode } from "react";
import { Icon } from "../components/Icons";
import { Card, Skeleton } from "../components/Components";
import { LineChart } from "../components/Charts";
import * as fmt from "../lib/fmt";
import { insights } from "../lib/data";
import { useInsightsData, type InsightsSnapshot } from "../lib/useInsightsData";

const timeLabel = (asOf: string): string =>
  new Date(asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Collecting({ label }: { label: string }) {
  return (
    <div style={{ display: "grid", placeItems: "center", height: 180, color: "var(--muted)", textAlign: "center", gap: 6 }}>
      <Icon name="activity" size={22} style={{ opacity: 0.5 }} />
      <div style={{ fontSize: "0.8125rem" }}>{label}</div>
      <div style={{ fontSize: "0.6875rem", color: "var(--faint)" }}>Live samples build up as the agent polls (every 15s).</div>
    </div>
  );
}

function PegChart({ history, live, pegDeviationBps }: { history: InsightsSnapshot[]; live: boolean; pegDeviationBps: number }) {
  const chipRole = pegDeviationBps >= 100 ? "role-error" : pegDeviationBps >= 30 ? "role-warn" : "role-success";

  let body: ReactNode;
  if (live) {
    const nav = history.map((s) => ({ t: timeLabel(s.asOf), v: parseFloat(s.usdyOracleNavUsdc) })).filter((d) => Number.isFinite(d.v));
    const dex = history.map((s) => ({ t: timeLabel(s.asOf), v: parseFloat(s.usdyDexSpotUsdc) })).filter((d) => Number.isFinite(d.v));
    if (nav.length < 2) {
      body = <Collecting label="Collecting live USDY peg samples…" />;
    } else {
      const series = [
        { key: "nav", label: "Oracle NAV", color: "var(--chart-usdy)", data: nav },
        ...(dex.length >= 2 ? [{ key: "dex", label: "DEX spot", color: "var(--warning)", data: dex }] : []),
      ];
      body = <LineChart series={series} yFmt={(v) => "$" + v.toFixed(4)} />;
    }
  } else {
    const h = insights.pegHistory;
    const series = [
      { key: "nav", label: "Oracle NAV", color: "var(--chart-usdy)", data: h.map((d) => ({ t: d.t, v: d.nav })) },
      { key: "dex", label: "DEX spot", color: "var(--warning)", data: h.map((d) => ({ t: d.t, v: d.dex })) },
    ];
    body = <LineChart series={series} yFmt={(v) => "$" + v.toFixed(4)} />;
  }

  return (
    <Card>
      <div className="card-hl">
        <span className="card-title" style={{ margin: 0 }}><Icon name="activity" size={14} />USDY peg — NAV vs DEX price</span>
        <span className={`chip ${chipRole}`} style={{ height: 22 }}>{pegDeviationBps} bps now</span>
      </div>
      {body}
      <p style={{ fontSize: "0.8125rem", color: "var(--muted)", margin: "12px 0 0", lineHeight: 1.5 }}>
        When the DEX price deviates from oracle NAV past the de-risk threshold (1.0%), the agent rotates USDY → AUSD/USDC and re-engages once the peg recovers.
      </p>
    </Card>
  );
}

function OracleCard({ oracleRangeEnd, navUsdc, live }: { oracleRangeEnd: string | undefined; navUsdc: string; live: boolean }) {
  // Mantle's Ondo oracle exposes no fixed range window, so live reads usually have no
  // rangeEnd — show the current NAV + a note instead of a fabricated countdown.
  if (live && !oracleRangeEnd) {
    return (
      <Card>
        <span className="card-title"><Icon name="clock-alert" size={14} />Oracle</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span className="chip role-success"><Icon name="check" size={13} />Live</span>
          <span style={{ fontSize: "0.875rem", color: "var(--muted)" }}>NAV <span className="mono">{navUsdc === "unavailable" ? "—" : `$${navUsdc}`}</span> / USDY</span>
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--faint)", margin: 0, lineHeight: 1.5 }}>
          Mantle's Ondo `RWADynamicOracle` has no fixed range window — staleness is guarded on-chain by the depeg/oracle guard (a reverting oracle while USDY is held forces a de-risk), not a last-updated clock.
        </p>
      </Card>
    );
  }
  // Range-based path (fixture/demo, or any chain whose oracle exposes a range).
  const rangeEnd = oracleRangeEnd ?? insights.oracleRangeEnd;
  const rangeStart = insights.oracleRangeStart;
  const start = new Date(rangeStart), end = new Date(rangeEnd), now = new Date();
  const pct = Math.max(0, Math.min(1, (now.getTime() - start.getTime()) / (end.getTime() - start.getTime()))) * 100;
  const daysLeft = Math.max(0, Math.round((end.getTime() - now.getTime()) / 86_400_000));
  const isNear = daysLeft <= 3;
  return (
    <Card>
      <span className="card-title"><Icon name="clock-alert" size={14} />Oracle range</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span className={`chip ${isNear ? "role-warn" : "role-success"}`}><Icon name={isNear ? "alert-triangle" : "check"} size={13} />{isNear ? "Near end" : "Valid"}</span>
        <span style={{ fontSize: "0.875rem", color: "var(--muted)" }}>valid until <span className="mono">{fmt.dateShort(rangeEnd)}</span></span>
      </div>
      <div style={{ position: "relative", height: 10, borderRadius: 99, background: "var(--base-300)", overflow: "hidden" }}>
        <div style={{ width: pct + "%", height: "100%", background: "var(--primary)" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: "0.75rem", color: "var(--faint)" }}>
        <span className="mono">{fmt.dateShort(rangeStart)}</span>
        <span>range ends in {daysLeft} day{daysLeft !== 1 ? "s" : ""}</span>
        <span className="mono">{fmt.dateShort(rangeEnd)}</span>
      </div>
    </Card>
  );
}

function PorCard({ ausdBackingRatioBps, live }: { ausdBackingRatioBps: number; live: boolean }) {
  // The agent has no wired proof-of-reserves feed (1delta exposes none), so a live read
  // is "unavailable" rather than a made-up ratio. AUSD is guarded by face-value accounting.
  if (live && ausdBackingRatioBps <= 0) {
    return (
      <Card>
        <span className="card-title"><Icon name="file-check" size={14} />AUSD proof-of-reserves</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
          <span className="chip role-neutral"><Icon name="info" size={13} />Unavailable</span>
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--faint)", margin: "10px 0 0", lineHeight: 1.5 }}>
          No proof-of-reserves feed is wired to this agent. AUSD is valued 1:1 at face on-chain; a depeg surfaces through the risk engine + Guardrails, not a PoR ratio here.
        </p>
      </Card>
    );
  }
  const ratioPct = ausdBackingRatioBps > 0 ? ausdBackingRatioBps / 100 : insights.porRatioPct;
  const fullyReserved = ratioPct >= 100;
  return (
    <Card>
      <span className="card-title"><Icon name="file-check" size={14} />AUSD proof-of-reserves</span>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div className="por-ring" style={{ background: `conic-gradient(var(--success) ${Math.min(ratioPct, 100) * 3.6}deg, var(--base-300) 0)` }}>
          <div className="por-ring-inner">
            <span className="mono" style={{ fontWeight: 700, fontSize: "1.0625rem" }}>{ratioPct.toFixed(1)}%</span>
          </div>
        </div>
        <div>
          <span className={`chip ${fullyReserved ? "role-success" : "role-warn"}`}><Icon name={fullyReserved ? "shield-check" : "alert-triangle"} size={13} />{fullyReserved ? "Fully reserved" : "Under-reserved"}</span>
          <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 8 }}>Reserves cover {ratioPct.toFixed(1)}% of circulating AUSD.</div>
        </div>
      </div>
    </Card>
  );
}

function AaveChart({ history, live, aaveWithdrawableUsdc }: {
  history: InsightsSnapshot[];
  live: boolean;
  aaveWithdrawableUsdc: string;
}) {
  let body: ReactNode;
  if (live) {
    const util = history.map((s) => ({ t: timeLabel(s.asOf), v: s.aaveUtilizationBps / 100 }));
    const apy = history.map((s) => ({ t: timeLabel(s.asOf), v: s.aaveUsdcSupplyApyBps / 100 }));
    body = util.length < 2
      ? <Collecting label="Collecting live Aave utilization & APY samples…" />
      : <LineChart series={[
          { key: "util", label: "Utilization %", color: "var(--chart-aave)", data: util },
          { key: "apy", label: "Supply APY %", color: "var(--success)", data: apy },
        ]} yFmt={(v) => v.toFixed(1) + "%"} />;
  } else {
    const h = insights.aaveHistory;
    body = <LineChart series={[
      { key: "util", label: "Utilization %", color: "var(--chart-aave)", data: h.map((d) => ({ t: d.t, v: d.utilBps / 100 })) },
      { key: "apy", label: "Supply APY %", color: "var(--success)", data: h.map((d) => ({ t: d.t, v: d.apyBps / 100 })) },
    ]} yFmt={(v) => v.toFixed(1) + "%"} />;
  }
  return (
    <Card>
      <div className="card-hl">
        <span className="card-title" style={{ margin: 0 }}><Icon name="droplet" size={14} />Aave USDC — utilization &amp; APY</span>
        <span style={{ fontSize: "0.8125rem", color: "var(--muted)" }} className="mono">{fmt.usd(aaveWithdrawableUsdc, { cents: false })} withdrawable</span>
      </div>
      {body}
    </Card>
  );
}

function secondsAgo(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1_000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export function InsightsPage({ loading: pageLoading }: { loading: boolean }) {
  const { snapshot, loading: snapLoading, lastUpdated, stale, history } = useInsightsData();
  const loading = pageLoading || snapLoading;

  if (loading) {
    return <div className="page"><div className="grid ins-cols"><Skeleton h={300} r={14} /><Skeleton h={300} r={14} /><Skeleton h={220} r={14} /><Skeleton h={220} r={14} /></div></div>;
  }
  const live = snapshot.live;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Insights</h1>
          <p className="page-sub">The risk radar — the signals the agent weighs, sampled live as it polls.</p>
        </div>
        <span className={`chip ${stale ? "role-warn" : "role-neutral"}`}>
          <span className="dot dot-pulse" style={{ background: stale ? "var(--warning)" : live ? "var(--success)" : "var(--info)" }} />
          {stale
            ? lastUpdated
              ? `stale — last updated ${secondsAgo(lastUpdated)}`
              : "agent unreachable — showing demo data"
            : live && lastUpdated
              ? `updated ${secondsAgo(lastUpdated)}`
              : "demo data"}
        </span>
      </div>
      <div className="grid ins-cols">
        <div className="ins-wide"><PegChart history={history} live={live} pegDeviationBps={snapshot.pegDeviationBps} /></div>
        <OracleCard oracleRangeEnd={snapshot.oracleRangeEnd} navUsdc={snapshot.usdyOracleNavUsdc} live={live} />
        <PorCard ausdBackingRatioBps={snapshot.ausdBackingRatioBps} live={live} />
        <div className="ins-wide"><AaveChart history={history} live={live} aaveWithdrawableUsdc={snapshot.aaveWithdrawableUsdc} /></div>
      </div>
    </div>
  );
}
