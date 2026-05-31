/* Insights /insights (§5.4) — risk radar. Charts + data-table fallbacks. Exported to window. */
(function () {
  const Icon = window.Icon, f = window.fmt, S = window.SENTINEL;
  const { Card, LineChart } = window;
  const ins = S.insights;

  function PegChart() {
    const series = [
      { key: "nav", label: "Oracle NAV", color: "var(--chart-usdy)", data: ins.pegHistory.map((d) => ({ t: d.t, v: d.nav })) },
      { key: "dex", label: "DEX spot", color: "var(--warning)", data: ins.pegHistory.map((d) => ({ t: d.t, v: d.dex })) },
    ];
    const dipIdx = ins.pegHistory.findIndex((d) => d.t === "06-11");
    return (
      <Card>
        <div className="card-hl">
          <span className="card-title" style={{ margin: 0 }}><Icon name="activity" size={14} />USDY peg — NAV vs DEX price</span>
          <span className="chip role-success" style={{ height: 22 }}>20 bps now</span>
        </div>
        <LineChart series={series} yFmt={(v) => "$" + v.toFixed(4)} markers={[{ i: dipIdx, label: "de-risk" }]} />
        <p style={{ fontSize: "0.8125rem", color: "var(--muted)", margin: "12px 0 0", lineHeight: 1.5 }}>
          On Jun 11 the DEX price fell 122 bps below oracle NAV, tripping the 1.0% de-risk threshold — the agent rotated USDY → AUSD, then re-engaged as the peg recovered.
        </p>
      </Card>
    );
  }

  function OracleCard() {
    const start = new Date(ins.oracleRangeStart), end = new Date(ins.oracleRangeEnd);
    const now = new Date("2026-06-15T00:00:00Z");
    const pct = Math.max(0, Math.min(1, (now - start) / (end - start))) * 100;
    return (
      <Card>
        <span className="card-title"><Icon name="clock-alert" size={14} />Oracle range</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span className="chip role-success"><Icon name="check" size={13} />Valid</span>
          <span style={{ fontSize: "0.875rem", color: "var(--muted)" }}>valid until <span className="mono">{f.dateShort(ins.oracleRangeEnd)}</span></span>
        </div>
        <div style={{ position: "relative", height: 10, borderRadius: 99, background: "var(--base-300)", overflow: "hidden" }}>
          <div style={{ width: pct + "%", height: "100%", background: "var(--primary)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: "0.75rem", color: "var(--faint)" }}>
          <span className="mono">{f.dateShort(ins.oracleRangeStart)}</span>
          <span>range ends in 16 days</span>
          <span className="mono">{f.dateShort(ins.oracleRangeEnd)}</span>
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--faint)", margin: "12px 0 0", lineHeight: 1.5 }}>
          Range-based oracle: it interpolates a daily rate. "Stale" means frozen, paused, or past range end — not a last-updated clock.
        </p>
      </Card>
    );
  }

  function PorCard() {
    return (
      <Card>
        <span className="card-title"><Icon name="file-check" size={14} />AUSD proof-of-reserves</span>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div className="por-ring" style={{ background: `conic-gradient(var(--success) ${Math.min(ins.porRatioPct, 100) * 3.6}deg, var(--base-300) 0)` }}>
            <div className="por-ring-inner">
              <span className="mono" style={{ fontWeight: 700, fontSize: "1.0625rem" }}>{ins.porRatioPct}%</span>
            </div>
          </div>
          <div>
            <span className="chip role-success"><Icon name="shield-check" size={13} />Fully reserved</span>
            <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 8 }}>Reserves cover {ins.porRatioPct}% of circulating AUSD.</div>
            <a className="linklike" style={{ fontSize: "0.8125rem", marginTop: 6 }} href="#" onClick={(e) => e.preventDefault()}>{ins.porSource} <Icon name="external-link" size={13} /></a>
          </div>
        </div>
      </Card>
    );
  }

  function AaveChart() {
    const series = [
      { key: "util", label: "Utilization %", color: "var(--chart-aave)", data: ins.aaveHistory.map((d) => ({ t: d.t, v: d.utilBps / 100 })) },
      { key: "apy", label: "Supply APY %", color: "var(--success)", data: ins.aaveHistory.map((d) => ({ t: d.t, v: d.apyBps / 100 })) },
    ];
    return (
      <Card>
        <div className="card-hl">
          <span className="card-title" style={{ margin: 0 }}><Icon name="droplet" size={14} />Aave USDC — utilization & APY</span>
          <span style={{ fontSize: "0.8125rem", color: "var(--muted)" }} className="mono">{f.usd(ins.aaveWithdrawableUsdc, { cents: false })} withdrawable</span>
        </div>
        <LineChart series={series} yFmt={(v) => v.toFixed(1) + "%"} />
      </Card>
    );
  }

  function InsightsPage({ loading }) {
    if (loading) {
      return <div className="page"><div className="grid ins-cols"><window.Skeleton h={300} r={14} /><window.Skeleton h={300} r={14} /><window.Skeleton h={220} r={14} /><window.Skeleton h={220} r={14} /></div></div>;
    }
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <h1 className="page-title">Insights</h1>
            <p className="page-sub">The risk radar — the signals the agent weighs, over time. Every chart has an accessible data-table view.</p>
          </div>
          <span className="chip role-neutral"><span className="dot dot-pulse" style={{ background: "var(--info)" }} />updated 12s ago</span>
        </div>
        <div className="grid ins-cols">
          <div className="ins-wide"><PegChart /></div>
          <OracleCard />
          <PorCard />
          <div className="ins-wide"><AaveChart /></div>
        </div>
      </div>
    );
  }

  window.InsightsPage = InsightsPage;
})();
