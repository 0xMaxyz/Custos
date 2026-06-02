import { describe, it, expect } from "vitest";
import { Bucket } from "@custos/shared";

import { buildExplainContext } from "./explain.js";
import type { MarketSnapshot, RiskAssessment, Decision, WeightsBps } from "../types.js";

const NOW = 1_700_000_000;

function weights(idle: number, aave: number, usdy: number, ausd: number): WeightsBps {
  return { [Bucket.IDLE]: idle, [Bucket.AAVE]: aave, [Bucket.USDY]: usdy, [Bucket.AUSD]: ausd };
}

function snap(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    asOf: new Date(NOW * 1000).toISOString(),
    usdyOracleNavUsdc: 1_083_200_000_000_000_000n, // 1.0832
    usdyDexSpotUsdc: 1_081_000_000_000_000_000n, // 1.0810
    oracleUpdatedAt: NOW - 3_600,
    oracleRangeEnd: NOW + 30 * 24 * 3_600,
    usdyImpliedApyBps: 452,
    aaveUsdcSupplyApyBps: 380,
    aaveUtilizationBps: 7_400,
    aaveWithdrawableUsdc: 21_000_000_000n,
    totalAssetsUsdc: 30_000_000_000n, // $30,000.00
    currentWeightsBps: weights(300, 4_700, 5_000, 0),
    ausdBackingRatioBps: 10_000,
    ...overrides,
  };
}

function assessment(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    riskLevel: "NORMAL",
    candidateWeightsBps: weights(200, 4_800, 5_000, 0),
    flags: ["NONE"],
    maxUsdyWeightBpsAllowed: 6_000,
    forceDeRisk: false,
    ...overrides,
  };
}

describe("buildExplainContext", () => {
  it("formats prices, TVL, and weights into human-readable grounding", () => {
    const ctx = buildExplainContext(snap(), assessment());

    expect(ctx.asOf).toBe(new Date(NOW * 1000).toISOString());
    expect(ctx.usdyOracleNavUsdc).toBe("1.0832");
    expect(ctx.usdyDexSpotUsdc).toBe("1.0810");
    expect(ctx.totalAssetsUsdc).toBe("30000.00");
    expect(ctx.riskLevel).toBe("NORMAL");
    expect(ctx.maxUsdyWeightBpsAllowed).toBe(6_000);

    const usdy = ctx.currentWeights.find((w) => w.bucket === "USDY");
    expect(usdy).toEqual({ bucket: "USDY", bps: 5_000, pct: "50.00%" });
  });

  it("exposes aaveWithdrawableUsdc and oracleRangeEnd for the risk radar", () => {
    const ctx = buildExplainContext(snap(), assessment());
    expect(ctx.aaveWithdrawableUsdc).toBe("21000.00");
    expect(ctx.oracleRangeEnd).toBe(new Date((NOW + 30 * 24 * 3_600) * 1000).toISOString());
  });

  it("emits empty oracleRangeEnd when the oracle range is unsupported (0)", () => {
    const ctx = buildExplainContext(snap({ oracleRangeEnd: 0 }), assessment());
    expect(ctx.oracleRangeEnd).toBe("");
  });

  it("computes peg deviation in bps from nav vs spot", () => {
    // |1.0832 - 1.0810| / 1.0832 ≈ 20 bps
    const ctx = buildExplainContext(snap(), assessment());
    expect(ctx.pegDeviationBps).toBe(20);
  });

  it("marks DEX spot unavailable when it is zero", () => {
    const ctx = buildExplainContext(snap({ usdyDexSpotUsdc: 0n }), assessment());
    expect(ctx.usdyDexSpotUsdc).toBe("unavailable");
    expect(ctx.pegDeviationBps).toBe(0);
  });

  it("passes through flags, PoR ratio, and forceDeRisk", () => {
    const ctx = buildExplainContext(
      snap({ ausdBackingRatioBps: 9_800, currentWeightsBps: weights(300, 2_700, 4_000, 3_000) }),
      assessment({ flags: ["AUSD_POR_WARN"], riskLevel: "CAUTION" }),
    );
    expect(ctx.flags).toEqual(["AUSD_POR_WARN"]);
    expect(ctx.ausdBackingRatioBps).toBe(9_800);
    expect(ctx.riskLevel).toBe("CAUTION");
    expect(ctx.forceDeRisk).toBe(false);
  });

  it("includes recent decisions most-recent-first, capped to maxDecisions", () => {
    const mkDecision = (rationale: string): Decision => ({
      kind: "REBALANCE",
      usdyDexSpotUsdc: 0n,
      riskLevel: "NORMAL",
      rationale,
      signals: [{ type: "PEG", severity: "LOW", summary: "20 bps below NAV" }],
    });
    const decisions = [mkDecision("d1"), mkDecision("d2"), mkDecision("d3")];
    const ctx = buildExplainContext(snap(), assessment(), decisions, 2);

    expect(ctx.recentDecisions).toHaveLength(2);
    expect(ctx.recentDecisions[0]?.rationale).toBe("d1");
    expect(ctx.recentDecisions[0]?.signals[0]).toEqual({
      type: "PEG",
      severity: "LOW",
      summary: "20 bps below NAV",
    });
  });

  it("defaults to no recent decisions", () => {
    const ctx = buildExplainContext(snap(), assessment());
    expect(ctx.recentDecisions).toEqual([]);
  });
});
