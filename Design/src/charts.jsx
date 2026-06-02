/* Data-viz (§7). Exported to window. Charts have table fallbacks (§9). Depends on window.fmt, window.CUSTOS. */
(function () {
  const { useState, useId } = React;
  const { BUCKETS, BUCKET_LABEL } = window.CUSTOS;
  const f = window.fmt;
  const Icon = window.Icon;
  const bucketColor = { IDLE: "var(--chart-idle)", AAVE: "var(--chart-aave)", USDY: "var(--chart-usdy)", AUSD: "var(--chart-ausd)" };

  // ---------- AllocationChart (donut) ----------
  function AllocationChart({ weightsBps, size = 168, stroke = 22 }) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, cx = size / 2;
    const total = BUCKETS.reduce((s, b) => s + (weightsBps[b] || 0), 0) || 1;
    let offset = 0;
    const segs = BUCKETS.filter((b) => weightsBps[b] > 0).map((b) => {
      const frac = weightsBps[b] / total, len = frac * c;
      const seg = { b, dash: len, gap: c - len, off: -offset };
      offset += len; return seg;
    });
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Allocation across buckets">
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--base-300)" strokeWidth={stroke} />
        {segs.map((s) => (
          <circle key={s.b} cx={cx} cy={cx} r={r} fill="none" stroke={bucketColor[s.b]} strokeWidth={stroke}
            strokeDasharray={`${s.dash} ${s.gap}`} strokeDashoffset={s.off}
            transform={`rotate(-90 ${cx} ${cx})`} strokeLinecap="butt"
            style={{ transition: "stroke-dasharray 0.5s var(--ease)" }} />
        ))}
      </svg>
    );
  }

  function AllocationLegend({ weightsBps, tvlUsdc }) {
    const tvl = parseFloat(tvlUsdc);
    return (
      <div style={{ display: "grid", gap: 9 }}>
        {BUCKETS.map((b) => {
          const w = weightsBps[b] || 0;
          const usd = (w / 10000) * tvl;
          return (
            <div key={b} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="dot" style={{ background: bucketColor[b], width: 10, height: 10 }} />
              <span style={{ fontSize: "0.875rem", fontWeight: 500, flex: 1 }}>{BUCKET_LABEL[b]}</span>
              <span className="mono" style={{ fontSize: "0.875rem", fontWeight: 600 }}>{f.bpsToWeight(w)}%</span>
              <span className="mono" style={{ fontSize: "0.8125rem", color: "var(--muted)", minWidth: 70, textAlign: "right" }}>{f.usd(usd)}</span>
            </div>
          );
        })}
      </div>
    );
  }

  // ---------- WeightBars: before → after mini stacked bars ----------
  function WeightBars({ pre, post }) {
    const Bar = ({ w, label }) => (
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "0.6875rem", color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
        <div style={{ display: "flex", height: 12, borderRadius: 4, overflow: "hidden", background: "var(--base-300)" }} role="img"
          aria-label={`${label} allocation ${BUCKETS.map((b) => `${b} ${f.bpsToWeight(w[b])}%`).join(", ")}`}>
          {BUCKETS.map((b) => w[b] > 0 ? (
            <span key={b} style={{ width: (w[b] / 100) + "%", background: bucketColor[b], transition: "width 0.4s var(--ease)" }} title={`${BUCKET_LABEL[b]} ${f.bpsToWeight(w[b])}%`} />
          ) : null)}
        </div>
      </div>
    );
    return (
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
        <Bar w={pre} label="Before" />
        <Icon name="arrow-right" size={15} style={{ color: "var(--faint)", marginBottom: 1 }} />
        <Bar w={post} label="After" />
      </div>
    );
  }

  // ---------- Sparkline (two series overlay) ----------
  function Sparkline({ a, b, width = 132, height = 40, colorA = "var(--primary)", colorB = "var(--faint)" }) {
    const all = [...a, ...b], min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
    const pts = (arr) => arr.map((v, i) => {
      const x = (i / (arr.length - 1)) * width;
      const y = height - 4 - ((v - min) / span) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const zeroY = height - 4 - ((0 - min) / span) * (height - 8);
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ overflow: "visible" }}>
        <line x1="0" y1={zeroY} x2={width} y2={zeroY} stroke="var(--border)" strokeWidth="1" strokeDasharray="2 3" />
        <polyline points={pts(b)} fill="none" stroke={colorB} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
        <polyline points={pts(a)} fill="none" stroke={colorA} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // ---------- PegGauge (deviation vs thresholds) ----------
  function PegGauge({ deviationBps, warn = 30, block = 50, derisk = 100 }) {
    const maxScale = 130;
    const pct = Math.min(deviationBps / maxScale, 1) * 100;
    const mark = (v) => Math.min(v / maxScale, 1) * 100;
    const role = deviationBps >= derisk ? "error" : deviationBps >= warn ? "warning" : "success";
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
          <span className="mono" style={{ fontWeight: 600, fontSize: "1rem", color: `var(--${role})` }}>{deviationBps} bps</span>
          <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>below NAV</span>
        </div>
        <div style={{ position: "relative", height: 8, borderRadius: 99, background: "linear-gradient(90deg, var(--success-soft), var(--warning-soft) 45%, var(--error-soft))" }}>
          <div style={{ position: "absolute", inset: 0, borderRadius: 99, overflow: "hidden" }}>
            <div style={{ width: pct + "%", height: "100%", background: `var(--${role})`, opacity: 0.85, transition: "width 0.4s var(--ease)" }} />
          </div>
          {[["warn", warn], ["block", block], ["derisk", derisk]].map(([lab, v]) => (
            <span key={lab} title={`${lab} ${v} bps`} style={{ position: "absolute", left: mark(v) + "%", top: -3, width: 2, height: 14, background: "var(--border-strong)", borderRadius: 2 }} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: "0.6875rem", color: "var(--faint)" }}>
          <span>0</span><span>warn 30</span><span>block 50</span><span>derisk 100</span>
        </div>
      </div>
    );
  }

  // ---------- LiquidityBufferBar ----------
  function LiquidityBufferBar({ pct, floor = 15 }) {
    const ok = pct >= floor;
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
          <span className="mono" style={{ fontWeight: 600, fontSize: "1rem", color: ok ? "var(--success)" : "var(--error)" }}>{pct}%</span>
          <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>instant liquidity</span>
        </div>
        <div style={{ position: "relative", height: 10, borderRadius: 99, background: "var(--base-300)", overflow: "hidden" }}>
          <div style={{ width: Math.min(pct, 100) + "%", height: "100%", background: ok ? "var(--success)" : "var(--error)", transition: "width 0.4s var(--ease)" }} />
        </div>
        <div style={{ position: "relative", height: 14, marginTop: 2 }}>
          <span style={{ position: "absolute", left: floor + "%", transform: "translateX(-50%)", fontSize: "0.6875rem", color: "var(--faint)", whiteSpace: "nowrap" }}>↑ {floor}% floor</span>
        </div>
      </div>
    );
  }

  // ---------- LineChart + ChartDataTable ----------
  function LineChart({ series, height = 180, yFmt = (v) => v, yPad = 0.0008, markers = [] }) {
    // series: [{ key, label, color, data: [{t, v}] }]
    const [showTable, setShowTable] = useState(false);
    const labels = series[0].data.map((d) => d.t);
    const W = 560, H = height, padL = 52, padR = 14, padT = 12, padB = 26;
    const allV = series.flatMap((s) => s.data.map((d) => d.v));
    let min = Math.min(...allV), max = Math.max(...allV);
    const pad = (max - min) * 0.18 + yPad; min -= pad; max += pad;
    const span = max - min || 1, n = labels.length;
    const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
    const y = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);
    const path = (data) => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(d.v).toFixed(1)}`).join(" ");
    const ticks = [min, min + span / 2, max];
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {series.map((s) => (
              <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.8125rem", color: "var(--muted)", fontWeight: 500 }}>
                <span style={{ width: 14, height: 3, borderRadius: 2, background: s.color, display: "inline-block" }} />{s.label}
              </span>
            ))}
          </div>
          <button className="linklike" style={{ fontSize: "0.8125rem", background: "none", border: 0 }} onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
            <Icon name={showTable ? "line-chart" : "scroll-text"} size={13} />{showTable ? "Show chart" : "Show data table"}
          </button>
        </div>
        {!showTable ? (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label={series.map((s) => s.label).join(" vs ")}>
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
                <text x={padL - 8} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--faint)" fontFamily="var(--font-mono)">{yFmt(t)}</text>
              </g>
            ))}
            {markers.map((m, i) => (
              <g key={"m" + i}>
                <line x1={x(m.i)} y1={padT} x2={x(m.i)} y2={H - padB} stroke="var(--error)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
                <text x={x(m.i)} y={padT + 2} textAnchor="middle" fontSize="9" fill="var(--error)" dy="-1">{m.label}</text>
              </g>
            ))}
            {series.map((s) => (
              <path key={s.key} d={path(s.data)} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {labels.map((lab, i) => (i % Math.ceil(n / 6) === 0 || i === n - 1) && (
              <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--faint)" fontFamily="var(--font-mono)">{lab}</text>
            ))}
          </svg>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="dtable">
              <thead><tr><th>Date</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
              <tbody>
                {labels.map((lab, i) => (
                  <tr key={lab}><td className="mono">{lab}</td>{series.map((s) => <td key={s.key} className="mono">{yFmt(s.data[i].v)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  Object.assign(window, { AllocationChart, AllocationLegend, WeightBars, Sparkline, PegGauge, LiquidityBufferBar, LineChart, bucketColor });
})();
