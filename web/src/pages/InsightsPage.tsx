// Insights (§5.4). Matches Design/src/insights.jsx.

import { Icon } from "../components/Icons";
import { Card, Skeleton } from "../components/Components";
import { LineChart } from "../components/Charts";
import * as fmt from "../lib/fmt";
import { insights } from "../lib/data";
import { useInsightsData } from "../lib/useInsightsData";

function PegChart({ pegDeviationBps, live }: { pegDeviationBps: number; live: boolean }) {
  const ins = insights;
  // Splice the live current point onto the end of the fixture history.
  const history = [...ins.pegHistory];
  const lastNav = parseFloat(ins.pegHistory.at(-1)?.nav?.toString() ?? "1.0844");
  if (live) {
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" }).replace("/", "-");
    const spot = lastNav - (pegDeviationBps / 10_000) * lastNav;
    history.push({ t: today, nav: lastNav, dex: Math.round(spot * 10_000) / 10_000 });
  }
  const series = [
    { key: "nav", label: "Oracle NAV", color: "var(--chart-usdy)", data: history.map((d) => ({ t: d.t, v: d.nav })) },
    { key: "dex", label: "DEX spot", color: "var(--warning)", data: history.map((d) => ({ t: d.t, v: d.dex })) },
  ];
  const dipIdx = history.findIndex((d) => d.t === "06-11");
  const chipRole = pegDeviationBps >= 100 ? "role-error" : pegDeviationBps >= 30 ? "role-warn" : "role-success";
  return (
    <Card>
      <div className="card-hl">
        <span className="card-title" style={{ margin: 0 }}><Icon name="activity" size={14} />USDY peg — NAV vs DEX price</span>
        <span className={`chip ${chipRole}`} style={{ height: 22 }}>{pegDeviationBps} bps now</span>
      </div>
      <LineChart series={series} yFmt={(v) => "$" + v.toFixed(4)} markers={dipIdx >= 0 ? [{ i: dipIdx, label: "de-risk" }] : []} />
      <p style={{ fontSize: "0.8125rem", color: "var(--muted)", margin: "12px 0 0", lineHeight: 1.5 }}>
        On Jun 11 the DEX price fell 122 bps below oracle NAV, tripping the 1.0% de-risk threshold — the agent rotated USDY → AUSD, then re-engaged as the peg recovered.
      </p>
    </Card>
  );
}

function OracleCard({ oracleRangeEnd }: { oracleRangeEnd: string | undefined }) {
  const ins = insights;
  const rangeEnd = oracleRangeEnd ?? ins.oracleRangeEnd;
  const rangeStart = ins.oracleRangeStart;
  const start = new Date(rangeStart), end = new Date(rangeEnd);
  const now = new Date();
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
      <p style={{ fontSize: "0.75rem", color: "var(--faint)", margin: "12px 0 0", lineHeight: 1.5 }}>
        Range-based oracle: it interpolates a daily rate. "Stale" means frozen, paused, or past range end — not a last-updated clock.
      </p>
    </Card>
  );
}

function PorCard({ ausdBackingRatioBps }: { ausdBackingRatioBps: number }) {
  const ins = insights;
  const ratioPct = ausdBackingRatioBps > 0 ? ausdBackingRatioBps / 100 : ins.porRatioPct;
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
          <a className="linklike" style={{ fontSize: "0.8125rem", marginTop: 6 }} href="#" onClick={(e) => e.preventDefault()}>{ins.porSource} <Icon name="external-link" size={13} /></a>
        </div>
      </div>
    </Card>
  );
}

function AaveChart({ aaveUtilizationBps, aaveUsdcSupplyApyBps, aaveWithdrawableUsdc, live }: {
  aaveUtilizationBps: number;
  aaveUsdcSupplyApyBps: number;
  aaveWithdrawableUsdc: string;
  live: boolean;
}) {
  const ins = insights;
  const history = [...ins.aaveHistory];
  if (live) {
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" }).replace("/", "-");
    history.push({ t: today, utilBps: aaveUtilizationBps, apyBps: aaveUsdcSupplyApyBps });
  }
  const series = [
    { key: "util", label: "Utilization %", color: "var(--chart-aave)", data: history.map((d) => ({ t: d.t, v: d.utilBps / 100 })) },
    { key: "apy", label: "Supply APY %", color: "var(--success)", data: history.map((d) => ({ t: d.t, v: d.apyBps / 100 })) },
  ];
  return (
    <Card>
      <div className="card-hl">
        <span className="card-title" style={{ margin: 0 }}><Icon name="droplet" size={14} />Aave USDC — utilization &amp; APY</span>
        <span style={{ fontSize: "0.8125rem", color: "var(--muted)" }} className="mono">{fmt.usd(aaveWithdrawableUsdc, { cents: false })} withdrawable</span>
      </div>
      <LineChart series={series} yFmt={(v) => v.toFixed(1) + "%"} />
    </Card>
  );
}

function secondsAgo(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1_000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export function InsightsPage({ loading: pageLoading }: { loading: boolean }) {
  const { snapshot, loading: snapLoading, lastUpdated } = useInsightsData();
  const loading = pageLoading || snapLoading;

  if (loading) {
    return <div className="page"><div className="grid ins-cols"><Skeleton h={300} r={14} /><Skeleton h={300} r={14} /><Skeleton h={220} r={14} /><Skeleton h={220} r={14} /></div></div>;
  }
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Insights</h1>
          <p className="page-sub">The risk radar — the signals the agent weighs, over time. Every chart has an accessible data-table view.</p>
        </div>
        <span className="chip role-neutral">
          <span className="dot dot-pulse" style={{ background: snapshot.live ? "var(--success)" : "var(--info)" }} />
          {snapshot.live && lastUpdated ? `updated ${secondsAgo(lastUpdated)}` : "demo data"}
        </span>
      </div>
      <div className="grid ins-cols">
        <div className="ins-wide"><PegChart pegDeviationBps={snapshot.pegDeviationBps} live={snapshot.live} /></div>
        <OracleCard oracleRangeEnd={snapshot.oracleRangeEnd} />
        <PorCard ausdBackingRatioBps={snapshot.ausdBackingRatioBps} />
        <div className="ins-wide"><AaveChart aaveUtilizationBps={snapshot.aaveUtilizationBps} aaveUsdcSupplyApyBps={snapshot.aaveUsdcSupplyApyBps} aaveWithdrawableUsdc={snapshot.aaveWithdrawableUsdc} live={snapshot.live} /></div>
      </div>
    </div>
  );
}
