import { describe, it, expect } from "vitest";
import {
  deviationBps,
  recommendPegThresholds,
  assertValidPegTriplet,
  parseArgs,
} from "./guardrailPeg.js";

const ONE = 10n ** 18n;

describe("deviationBps", () => {
  it("is 0 when spot equals NAV", () => {
    expect(deviationBps(ONE, ONE)).toBe(0);
  });

  it("computes a symmetric deviation regardless of direction", () => {
    // 1.05 NAV, spot 1.0395 → 1% below
    const nav = (ONE * 105n) / 100n;
    const below = (nav * 99n) / 100n;
    const above = (nav * 101n) / 100n;
    expect(deviationBps(nav, below)).toBe(100);
    expect(deviationBps(nav, above)).toBe(100);
  });

  it("throws when NAV is unavailable", () => {
    expect(() => deviationBps(0n, ONE)).toThrow(/NAV/i);
  });
});

describe("recommendPegThresholds", () => {
  it("sets pegBlock above the measured deviation with the buffer", () => {
    const nav = ONE;
    const spot = (ONE * 1007n) / 1000n; // +0.70% = 70 bps
    const rec = recommendPegThresholds({ navUsdc: nav, spotUsdc: spot, currentWarnBps: 30, bufferBps: 50 });
    expect(rec.deviationBps).toBe(70);
    expect(rec.pegBlockBps).toBe(70 + 1 + 50); // 121
    expect(rec.pegDeRiskBps).toBe(121 + 50); // 171
    expect(rec.pegWarnBps).toBe(30); // min(30, 121)
    // The recommendation must actually unblock the deviation: dev < pegBlock.
    expect(rec.deviationBps).toBeLessThan(rec.pegBlockBps);
    // ...and stay a valid triplet.
    expect(() => assertValidPegTriplet(rec.pegWarnBps, rec.pegBlockBps, rec.pegDeRiskBps)).not.toThrow();
  });

  it("clamps pegWarn down to pegBlock when the deviation is tiny", () => {
    const rec = recommendPegThresholds({ navUsdc: ONE, spotUsdc: ONE, currentWarnBps: 30, bufferBps: 0 });
    // dev 0 → block 1 → warn clamped from 30 to 1.
    expect(rec.pegBlockBps).toBe(1);
    expect(rec.pegWarnBps).toBe(1);
  });
});

describe("assertValidPegTriplet", () => {
  it("accepts warn ≤ block ≤ derisk", () => {
    expect(() => assertValidPegTriplet(30, 50, 100)).not.toThrow();
  });
  it("rejects warn > block", () => {
    expect(() => assertValidPegTriplet(60, 50, 100)).toThrow(/peg-warn/);
  });
  it("rejects block > derisk", () => {
    expect(() => assertValidPegTriplet(30, 150, 100)).toThrow(/peg-block/);
  });
  it("rejects out-of-range bps", () => {
    expect(() => assertValidPegTriplet(0, 0, 70_000)).toThrow(/0\.\.65535/);
  });
});

describe("parseArgs", () => {
  it("defaults to measure with sensible defaults", () => {
    const a = parseArgs([]);
    expect(a.cmd).toBe("measure");
    expect(a.usdyBps).toBe(3_000);
    expect(a.bufferBps).toBe(50);
    expect(a.yes).toBe(false);
  });

  it("parses a queue command with explicit thresholds", () => {
    const a = parseArgs(["queue", "--peg-block", "120", "--peg-derisk", "170", "--peg-warn", "30", "--yes"]);
    expect(a.cmd).toBe("queue");
    expect(a.pegBlock).toBe(120);
    expect(a.pegDeRisk).toBe(170);
    expect(a.pegWarn).toBe(30);
    expect(a.yes).toBe(true);
  });

  it("rejects an unknown command", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(/unknown command/);
  });

  it("rejects a non-integer flag", () => {
    expect(() => parseArgs(["queue", "--peg-block", "abc"])).toThrow(/integer/);
  });
});
