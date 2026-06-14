import { describe, it, expect } from "vitest";
import { computeBaseline, formatDeltaPct, hasBaselineData } from "./baseline";

const ZEROED = {
  custosSeries: [] as number[],
  passiveSeries: [] as number[],
  realizedYieldBps: 0,
  passiveDeltaBps: 0,
  drawdownAvoidedUsdc: "0.00",
};

describe("computeBaseline", () => {
  it("derives the delta from the last aligned point and the per-point spread", () => {
    const r = computeBaseline({
      custosSeries: [0, 10, 45],
      passiveSeries: [0, 5, -3],
      passiveDeltaBps: 999, // should be ignored when series are present
    });
    expect(r.spreadSeries).toEqual([0, 5, 48]);
    expect(r.deltaBps).toBe(48);
    expect(r.custosAhead).toBe(true);
    expect(r.peakSpreadBps).toBe(48);
  });

  it("flags when Custos is behind", () => {
    const r = computeBaseline({
      custosSeries: [0, -20],
      passiveSeries: [0, 10],
      passiveDeltaBps: 0,
    });
    expect(r.deltaBps).toBe(-30);
    expect(r.custosAhead).toBe(false);
  });

  it("tracks the peak favourable spread even if it later narrows", () => {
    const r = computeBaseline({
      custosSeries: [0, 60, 45],
      passiveSeries: [0, 0, 0],
      passiveDeltaBps: 0,
    });
    expect(r.peakSpreadBps).toBe(60);
    expect(r.deltaBps).toBe(45);
  });

  it("uses only the aligned prefix when series lengths differ", () => {
    const r = computeBaseline({
      custosSeries: [0, 10, 20, 30],
      passiveSeries: [0, 5],
      passiveDeltaBps: 0,
    });
    expect(r.spreadSeries).toEqual([0, 5]);
    expect(r.deltaBps).toBe(5);
  });

  it("falls back to passiveDeltaBps when series are empty", () => {
    const r = computeBaseline({ custosSeries: [], passiveSeries: [], passiveDeltaBps: 180 });
    expect(r.deltaBps).toBe(180);
    expect(r.spreadSeries).toEqual([]);
    expect(r.custosAhead).toBe(true);
    expect(r.peakSpreadBps).toBe(180);
  });

  it("matches the canonical fixture's headline delta", () => {
    // From data.ts baseline: custos last 45, passive last -3 → 48 bps.
    const r = computeBaseline({
      custosSeries: [0, 6, 11, 9, 14, 22, 19, 31, 38, 44, 41, 45],
      passiveSeries: [0, 5, 9, 12, 8, 14, 11, 6, -18, -52, -30, -3],
      passiveDeltaBps: 180,
    });
    expect(r.deltaBps).toBe(48);
    expect(r.custosAhead).toBe(true);
  });
});

describe("hasBaselineData", () => {
  it("is false for a fresh/live zeroed baseline (no measured outcome)", () => {
    expect(hasBaselineData(ZEROED)).toBe(false);
  });

  it("is true when the demo series are present", () => {
    expect(hasBaselineData({ ...ZEROED, custosSeries: [0, 10], passiveSeries: [0, 5] })).toBe(true);
  });

  it("is true once any headline metric is non-zero", () => {
    expect(hasBaselineData({ ...ZEROED, passiveDeltaBps: 180 })).toBe(true);
    expect(hasBaselineData({ ...ZEROED, realizedYieldBps: 45 })).toBe(true);
    expect(hasBaselineData({ ...ZEROED, drawdownAvoidedUsdc: "610.00" })).toBe(true);
  });

  it("treats a zero drawdown string as no data", () => {
    expect(hasBaselineData({ ...ZEROED, drawdownAvoidedUsdc: "0" })).toBe(false);
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
