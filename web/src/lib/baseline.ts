// Baseline counter math (ROADMAP 4.7) — "Custos vs passive USDY holder".
//
// The headline transparency widget: how many bps Custos has outperformed a
// 100%-USDY passive holder since the last de-risk, plus the per-point spread for
// the comparison chart. Pure functions over the AgentBenchmark-derived series so
// the widget renders a tested computation, not ad-hoc inline math.

export interface BaselineInput {
  /** Cumulative Custos return series (bps), index-aligned with passiveSeries. */
  custosSeries: number[];
  /** Cumulative passive 100%-USDY return series (bps). */
  passiveSeries: number[];
  /** Headline delta (bps) as measured on-chain; used as a fallback/cross-check. */
  passiveDeltaBps: number;
}

export interface BaselineSummary {
  /** Latest Custos − passive spread (bps). Positive = Custos ahead. */
  deltaBps: number;
  /** Per-point spread series (custos[i] − passive[i]). */
  spreadSeries: number[];
  /** True when Custos is currently ahead of the passive holder. */
  custosAhead: boolean;
  /** Largest favourable spread reached over the window (bps). */
  peakSpreadBps: number;
}

/**
 * Compute the Custos-vs-passive summary. The delta is taken from the last
 * aligned point of the two series; when the series are empty or mismatched we
 * fall back to the on-chain `passiveDeltaBps` so the widget still shows a number.
 */
export function computeBaseline(input: BaselineInput): BaselineSummary {
  const { custosSeries: s, passiveSeries: p } = input;
  const n = Math.min(s.length, p.length);

  if (n === 0) {
    const d = input.passiveDeltaBps;
    return { deltaBps: d, spreadSeries: [], custosAhead: d >= 0, peakSpreadBps: Math.max(0, d) };
  }

  const spreadSeries: number[] = [];
  for (let i = 0; i < n; i++) spreadSeries.push(s[i]! - p[i]!);

  const deltaBps = spreadSeries[n - 1]!;
  const peakSpreadBps = spreadSeries.reduce((max, v) => (v > max ? v : max), spreadSeries[0]!);

  return { deltaBps, spreadSeries, custosAhead: deltaBps >= 0, peakSpreadBps };
}

/**
 * Whether the benchmark has any real data to show yet. A fresh/live vault with no
 * measured AgentBenchmark outcome is fully zeroed (empty series, zero headline
 * metrics) — in that state the "Custos vs passive" widget has nothing meaningful to
 * say, so the dashboard hides it and only shows it once a real (non-zero) on-chain
 * outcome exists (e.g. after a de-risk is measured). NOTE: `measuredAt` is NOT a
 * reliable signal — the live zeroed baseline inherits the fixture's timestamp — so
 * gate on actual content (series + headline numbers).
 */
export function hasBaselineData(b: {
  custosSeries: number[];
  passiveSeries: number[];
  realizedYieldBps: number;
  passiveDeltaBps: number;
  drawdownAvoidedUsdc: string;
}): boolean {
  return (
    b.custosSeries.length > 0 ||
    b.passiveSeries.length > 0 ||
    b.realizedYieldBps !== 0 ||
    b.passiveDeltaBps !== 0 ||
    Number(b.drawdownAvoidedUsdc) > 0
  );
}

/**
 * Format a signed bps delta for display, e.g. 180 → "+1.80%", -52 → "-0.52%".
 * `bps` is basis points (1% = 100 bps).
 */
export function formatDeltaPct(bps: number): string {
  const sign = bps >= 0 ? "+" : "-";
  return `${sign}${(Math.abs(bps) / 100).toFixed(2)}%`;
}
