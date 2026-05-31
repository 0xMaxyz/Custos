import { describe, it, expect } from "vitest";
import { computeBaseline, formatDeltaPct } from "./baseline";

describe("computeBaseline", () => {
  it("derives the delta from the last aligned point and the per-point spread", () => {
    const r = computeBaseline({
      sentinelSeries: [0, 10, 45],
      passiveSeries: [0, 5, -3],
      passiveDeltaBps: 999, // should be ignored when series are present
    });
    expect(r.spreadSeries).toEqual([0, 5, 48]);
    expect(r.deltaBps).toBe(48);
    expect(r.sentinelAhead).toBe(true);
    expect(r.peakSpreadBps).toBe(48);
  });

  it("flags when Sentinel is behind", () => {
    const r = computeBaseline({
      sentinelSeries: [0, -20],
      passiveSeries: [0, 10],
      passiveDeltaBps: 0,
    });
    expect(r.deltaBps).toBe(-30);
    expect(r.sentinelAhead).toBe(false);
  });

  it("tracks the peak favourable spread even if it later narrows", () => {
    const r = computeBaseline({
      sentinelSeries: [0, 60, 45],
      passiveSeries: [0, 0, 0],
      passiveDeltaBps: 0,
    });
    expect(r.peakSpreadBps).toBe(60);
    expect(r.deltaBps).toBe(45);
  });

  it("uses only the aligned prefix when series lengths differ", () => {
    const r = computeBaseline({
      sentinelSeries: [0, 10, 20, 30],
      passiveSeries: [0, 5],
      passiveDeltaBps: 0,
    });
    expect(r.spreadSeries).toEqual([0, 5]);
    expect(r.deltaBps).toBe(5);
  });

  it("falls back to passiveDeltaBps when series are empty", () => {
    const r = computeBaseline({ sentinelSeries: [], passiveSeries: [], passiveDeltaBps: 180 });
    expect(r.deltaBps).toBe(180);
    expect(r.spreadSeries).toEqual([]);
    expect(r.sentinelAhead).toBe(true);
    expect(r.peakSpreadBps).toBe(180);
  });

  it("matches the canonical fixture's headline delta", () => {
    // From data.ts baseline: sentinel last 45, passive last -3 → 48 bps.
    const r = computeBaseline({
      sentinelSeries: [0, 6, 11, 9, 14, 22, 19, 31, 38, 44, 41, 45],
      passiveSeries: [0, 5, 9, 12, 8, 14, 11, 6, -18, -52, -30, -3],
      passiveDeltaBps: 180,
    });
    expect(r.deltaBps).toBe(48);
    expect(r.sentinelAhead).toBe(true);
  });
});

describe("formatDeltaPct", () => {
  it("formats positive and negative bps with sign and two decimals", () => {
    expect(formatDeltaPct(180)).toBe("+1.80%");
    expect(formatDeltaPct(-52)).toBe("-0.52%");
    expect(formatDeltaPct(0)).toBe("+0.00%");
    expect(formatDeltaPct(5)).toBe("+0.05%");
  });
});
