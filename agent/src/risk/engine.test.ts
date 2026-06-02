import { describe, it, expect } from "vitest";
import { Bucket } from "@custos/shared";

import {
  assess,
  pegDeviationBps,
  yieldSpreadBps,
  isOracleStale,
  isOracleNearRangeEnd,
  aaveLiquidityBps,
} from "./engine.js";
import type { MarketSnapshot, WeightsBps } from "../types.js";

const NOW = 1_700_000_000; // fixed reference time (sec)

function weights(idle: number, aave: number, usdy: number, ausd: number): WeightsBps {
  return { [Bucket.IDLE]: idle, [Bucket.AAVE]: aave, [Bucket.USDY]: usdy, [Bucket.AUSD]: ausd };
}

/** A healthy baseline snapshot: peg tight, oracle fresh, USDY out-yields Aave. */
function baseSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    asOf: new Date(NOW * 1000).toISOString(),
    usdyOracleNavUsdc: 1_080_000_000_000_000_000n, // 1.08
    usdyDexSpotUsdc: 1_080_000_000_000_000_000n, // 1.08 (0 bps)
    oracleUpdatedAt: NOW - 3_600,
    oracleRangeEnd: NOW + 30 * 24 * 3_600,
    usdyImpliedApyBps: 452,
    aaveUsdcSupplyApyBps: 380,
    aaveUtilizationBps: 7_400,
    aaveWithdrawableUsdc: 21_000_000_000n, // $21k (6-dec)
    totalAssetsUsdc: 30_000_000_000n, // $30k
    currentWeightsBps: weights(300, 4_700, 5_000, 0),
    ausdBackingRatioBps: 10_000, // fully backed
    ...overrides,
  };
}

function sum(w: WeightsBps): number {
  return w[Bucket.IDLE] + w[Bucket.AAVE] + w[Bucket.USDY] + w[Bucket.AUSD];
}

describe("pure metrics", () => {
  it("computes peg deviation in bps (absolute)", () => {
    expect(pegDeviationBps(1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n)).toBe(0);
    // 1% below
    expect(pegDeviationBps(1_000_000_000_000_000_000n, 990_000_000_000_000_000n)).toBe(100);
    // 1% above is the same absolute deviation
    expect(pegDeviationBps(1_000_000_000_000_000_000n, 1_010_000_000_000_000_000n)).toBe(100);
  });

  it("returns 0 deviation when a price is missing", () => {
    expect(pegDeviationBps(0n, 1_000_000_000_000_000_000n)).toBe(0);
    expect(pegDeviationBps(1_000_000_000_000_000_000n, 0n)).toBe(0);
  });

  it("computes yield spread (can be negative)", () => {
    expect(yieldSpreadBps(452, 380)).toBe(72);
    expect(yieldSpreadBps(300, 380)).toBe(-80);
  });

  it("detects oracle staleness past range end", () => {
    expect(isOracleStale(baseSnapshot({ oracleRangeEnd: NOW - 1 }), NOW)).toBe(true);
    expect(isOracleStale(baseSnapshot(), NOW)).toBe(false);
  });

  it("detects oracle staleness from an aged update timestamp", () => {
    expect(
      isOracleStale(baseSnapshot({ oracleUpdatedAt: NOW - 200_000, oracleRangeEnd: 0 }), NOW),
    ).toBe(true);
  });

  it("detects near-range-end within the buffer", () => {
    expect(isOracleNearRangeEnd(baseSnapshot({ oracleRangeEnd: NOW + 3_600 }), NOW)).toBe(true);
    expect(isOracleNearRangeEnd(baseSnapshot(), NOW)).toBe(false);
  });

  it("computes Aave liquidity as a fraction of TVL in bps, capped", () => {
    expect(aaveLiquidityBps(baseSnapshot())).toBe(7_000); // 21k / 30k
    expect(aaveLiquidityBps(baseSnapshot({ totalAssetsUsdc: 0n }))).toBe(0);
  });
});

describe("assess — table-driven", () => {
  it("NORMAL: healthy market keeps USDY, weights sum to 10000", () => {
    const r = assess(baseSnapshot(), { nowSec: NOW });
    expect(r.riskLevel).toBe("NORMAL");
    expect(r.flags).toEqual(["NONE"]);
    expect(r.forceDeRisk).toBe(false);
    expect(r.maxUsdyWeightBpsAllowed).toBe(6_000);
    expect(sum(r.candidateWeightsBps)).toBe(10_000);
    expect(r.candidateWeightsBps[Bucket.USDY]).toBe(5_000);
  });

  it("PEG_WARN: 30bps deviation raises CAUTION without blocking", () => {
    const snap = baseSnapshot({ usdyDexSpotUsdc: 1_076_760_000_000_000_000n }); // ~30 bps below
    const r = assess(snap, { nowSec: NOW });
    expect(r.riskLevel).toBe("CAUTION");
    expect(r.flags).toContain("PEG_WARN");
    expect(r.forceDeRisk).toBe(false);
  });

  it("PEG_BLOCK: 50bps deviation caps USDY at current weight", () => {
    const snap = baseSnapshot({ usdyDexSpotUsdc: 1_074_600_000_000_000_000n }); // ~50 bps below
    const r = assess(snap, { nowSec: NOW });
    expect(r.flags).toContain("PEG_BLOCK");
    expect(r.maxUsdyWeightBpsAllowed).toBeLessThanOrEqual(snap.currentWeightsBps[Bucket.USDY]);
    expect(r.forceDeRisk).toBe(false);
  });

  it("PEG_DE_RISK: 100bps deviation forces de-risk to 0 USDY", () => {
    const snap = baseSnapshot({ usdyDexSpotUsdc: 1_069_200_000_000_000_000n }); // ~100 bps below
    const r = assess(snap, { nowSec: NOW });
    expect(r.riskLevel).toBe("DERISK");
    expect(r.flags).toContain("PEG_DE_RISK");
    expect(r.forceDeRisk).toBe(true);
    expect(r.maxUsdyWeightBpsAllowed).toBe(0);
    expect(r.candidateWeightsBps[Bucket.USDY]).toBe(0);
    expect(sum(r.candidateWeightsBps)).toBe(10_000);
  });

  it("ORACLE_STALE: past range end forces de-risk", () => {
    const r = assess(baseSnapshot({ oracleRangeEnd: NOW - 1 }), { nowSec: NOW });
    expect(r.riskLevel).toBe("DERISK");
    expect(r.flags).toContain("ORACLE_STALE");
    expect(r.forceDeRisk).toBe(true);
    expect(r.candidateWeightsBps[Bucket.USDY]).toBe(0);
  });

  it("LOW_LIQUIDITY: thin instant liquidity raises CAUTION", () => {
    const snap = baseSnapshot({
      currentWeightsBps: weights(200, 0, 5_000, 4_800),
      aaveWithdrawableUsdc: 0n,
    });
    const r = assess(snap, { nowSec: NOW });
    expect(r.flags).toContain("LOW_LIQUIDITY");
    expect(r.riskLevel).toBe("CAUTION");
  });

  it("yield inversion: when USDY no longer out-yields Aave, candidate trims USDY", () => {
    const snap = baseSnapshot({ usdyImpliedApyBps: 300, aaveUsdcSupplyApyBps: 380 });
    const r = assess(snap, { nowSec: NOW });
    expect(r.candidateWeightsBps[Bucket.USDY]).toBe(0);
    expect(sum(r.candidateWeightsBps)).toBe(10_000);
    expect(r.candidateWeightsBps[Bucket.IDLE]).toBeGreaterThanOrEqual(200);
  });

  it("always keeps at least the minimum idle buffer", () => {
    const snap = baseSnapshot({ currentWeightsBps: weights(0, 5_000, 5_000, 0) });
    const r = assess(snap, { nowSec: NOW });
    expect(r.candidateWeightsBps[Bucket.IDLE]).toBeGreaterThanOrEqual(200);
    expect(sum(r.candidateWeightsBps)).toBe(10_000);
  });

  it("never proposes USDY above the guardrail cap", () => {
    const snap = baseSnapshot({ currentWeightsBps: weights(200, 1_800, 8_000, 0) });
    const r = assess(snap, { nowSec: NOW });
    expect(r.candidateWeightsBps[Bucket.USDY]).toBeLessThanOrEqual(6_000);
  });

  it("buffer requirement: tightens an illiquid candidate to meet the instant-liquidity floor", () => {
    // All in USDY/AUSD, no Aave liquidity → candidate must shift toward IDLE so
    // IDLE + min(AAVE, aaveWithdrawable) >= 1500 bps.
    const snap = baseSnapshot({
      currentWeightsBps: weights(200, 0, 5_000, 4_800),
      aaveWithdrawableUsdc: 0n,
      // keep peg healthy so the only driver is the liquidity floor
      usdyImpliedApyBps: 452,
      aaveUsdcSupplyApyBps: 380,
    });
    const r = assess(snap, { nowSec: NOW });
    const aaveCap = 0; // no withdrawable
    const instant =
      r.candidateWeightsBps[Bucket.IDLE] + Math.min(r.candidateWeightsBps[Bucket.AAVE], aaveCap);
    expect(instant).toBeGreaterThanOrEqual(1_500);
    expect(sum(r.candidateWeightsBps)).toBe(10_000);
  });

  it("buffer requirement: counts Aave-withdrawable toward the floor (no over-tightening)", () => {
    // Plenty of Aave liquidity already satisfies the floor → USDY can stay.
    const snap = baseSnapshot({
      currentWeightsBps: weights(300, 4_700, 5_000, 0),
      aaveWithdrawableUsdc: 21_000_000_000n, // 70% of TVL withdrawable
    });
    const r = assess(snap, { nowSec: NOW });
    expect(r.candidateWeightsBps[Bucket.USDY]).toBe(5_000);
  });

  it("AUSD_POR_WARN: thin backing while holding AUSD raises caution", () => {
    const snap = baseSnapshot({
      currentWeightsBps: weights(300, 2_700, 4_000, 3_000),
      ausdBackingRatioBps: 9_800, // below the 9950 floor
    });
    const r = assess(snap, { nowSec: NOW });
    expect(r.flags).toContain("AUSD_POR_WARN");
    expect(r.riskLevel).toBe("CAUTION");
  });

  it("AUSD PoR unknown (0) does not raise a flag", () => {
    const snap = baseSnapshot({
      currentWeightsBps: weights(300, 2_700, 4_000, 3_000),
      ausdBackingRatioBps: 0, // unavailable
    });
    const r = assess(snap, { nowSec: NOW });
    expect(r.flags).not.toContain("AUSD_POR_WARN");
  });

  it("AUSD PoR thin but no AUSD held does not raise a flag", () => {
    const snap = baseSnapshot({
      currentWeightsBps: weights(300, 4_700, 5_000, 0),
      ausdBackingRatioBps: 9_000,
    });
    const r = assess(snap, { nowSec: NOW });
    expect(r.flags).not.toContain("AUSD_POR_WARN");
  });
});
