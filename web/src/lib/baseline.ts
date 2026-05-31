// Baseline counter math (ROADMAP 4.7) — "Sentinel vs passive USDY holder".
//
// The headline transparency widget: how many bps Sentinel has outperformed a
// 100%-USDY passive holder since the last de-risk, plus the per-point spread for
// the comparison chart. Pure functions over the AgentBenchmark-derived series so
// the widget renders a tested computation, not ad-hoc inline math.

export interface BaselineInput {
  /** Cumulative Sentinel return series (bps), index-aligned with passiveSeries. */
  sentinelSeries: number[];
  /** Cumulative passive 100%-USDY return series (bps). */
  passiveSeries: number[];
  /** Headline delta (bps) as measured on-chain; used as a fallback/cross-check. */
  passiveDeltaBps: number;
}

export interface BaselineSummary {
  /** Latest Sentinel − passive spread (bps). Positive = Sentinel ahead. */
  deltaBps: number;
  /** Per-point spread series (sentinel[i] − passive[i]). */
  spreadSeries: number[];
  /** True when Sentinel is currently ahead of the passive holder. */
  sentinelAhead: boolean;
  /** Largest favourable spread reached over the window (bps). */
  peakSpreadBps: number;
}

/**
 * Compute the Sentinel-vs-passive summary. The delta is taken from the last
 * aligned point of the two series; when the series are empty or mismatched we
 * fall back to the on-chain `passiveDeltaBps` so the widget still shows a number.
 */
export function computeBaseline(input: BaselineInput): BaselineSummary {
  const { sentinelSeries: s, passiveSeries: p } = input;
  const n = Math.min(s.length, p.length);

  if (n === 0) {
    const d = input.passiveDeltaBps;
    return { deltaBps: d, spreadSeries: [], sentinelAhead: d >= 0, peakSpreadBps: Math.max(0, d) };
  }

  const spreadSeries: number[] = [];
  for (let i = 0; i < n; i++) spreadSeries.push(s[i]! - p[i]!);

  const deltaBps = spreadSeries[n - 1]!;
  const peakSpreadBps = spreadSeries.reduce((max, v) => (v > max ? v : max), spreadSeries[0]!);

  return { deltaBps, spreadSeries, sentinelAhead: deltaBps >= 0, peakSpreadBps };
}

/**
 * Format a signed bps delta for display, e.g. 180 → "+1.80%", -52 → "-0.52%".
 * `bps` is basis points (1% = 100 bps).
 */
export function formatDeltaPct(bps: number): string {
  const sign = bps >= 0 ? "+" : "-";
  return `${sign}${(Math.abs(bps) / 100).toFixed(2)}%`;
}
