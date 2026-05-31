import { describe, it, expect } from "vitest";
import { Bucket } from "@sentinel/shared";
import { validateProposal, applyVerdict } from "./validator.js";
import type { MarketSnapshot, RiskAssessment, WeightsBps } from "../types.js";
import type { RiskVerdict } from "../llm/types.js";

const NOW = 1_700_000_000;

function weights(idle: number, aave: number, usdy: number, ausd: number): WeightsBps {
  return { [Bucket.IDLE]: idle, [Bucket.AAVE]: aave, [Bucket.USDY]: usdy, [Bucket.AUSD]: ausd };
}

const BASE_SNAPSHOT: MarketSnapshot = {
  asOf: new Date(NOW * 1000).toISOString(),
  usdyOracleNavUsdc: 1_080_000_000_000_000_000n,
  usdyDexSpotUsdc: 1_080_000_000_000_000_000n,
  oracleUpdatedAt: NOW - 3_600,
  oracleRangeEnd: NOW + 30 * 24 * 3_600,
  usdyImpliedApyBps: 452,
  aaveUsdcSupplyApyBps: 380,
  aaveUtilizationBps: 7_400,
  aaveWithdrawableUsdc: 21_000_000_000n, // $21k of $30k = 7000 bps
  totalAssetsUsdc: 30_000_000_000n,
  currentWeightsBps: weights(300, 4_700, 5_000, 0),
  ausdBackingRatioBps: 10_000,
};

const CURRENT = weights(300, 4_700, 5_000, 0);
const MAX_USDY = 6_000;

describe("validateProposal", () => {
  it("accepts a valid proposal", () => {
    const r = validateProposal(weights(200, 4_800, 5_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects weights that don't sum to 10000", () => {
    const r = validateProposal(weights(200, 4_800, 4_999, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY);
    expect(r.errors).toContain("WEIGHTS_DONT_SUM");
    expect(r.valid).toBe(false);
  });

  it("rejects USDY above the per-bucket cap (6000)", () => {
    const r = validateProposal(weights(200, 800, 9_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY);
    expect(r.errors).toContain("BUCKET_EXCEEDS_CAP");
  });

  it("rejects USDY above the cycle guardrail ceiling", () => {
    const r = validateProposal(weights(200, 3_500, 6_300, 0), CURRENT, BASE_SNAPSHOT, 6_000);
    expect(r.errors).toContain("USDY_EXCEEDS_GUARDRAIL");
  });

  it("rejects IDLE below the 2% minimum", () => {
    const r = validateProposal(weights(100, 4_900, 5_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY);
    expect(r.errors).toContain("IDLE_BELOW_MIN");
  });

  it("rejects when instant liquidity is below the 15% floor", () => {
    // 0 Aave-withdrawable → only IDLE counts; IDLE=200 < 1500.
    const zeroAave: MarketSnapshot = { ...BASE_SNAPSHOT, aaveWithdrawableUsdc: 0n };
    const r = validateProposal(weights(200, 0, 5_000, 4_800), CURRENT, zeroAave, MAX_USDY);
    expect(r.errors).toContain("INSTANT_LIQUIDITY_BELOW_FLOOR");
  });

  it("rejects a move exceeding the 50% cap", () => {
    // IDLE 300→5301 (+5001), AAVE 4700→4699 (−1), USDY 5000→0 (−5000) → totalMove = 5001 > 5000 cap.
    const r = validateProposal(
      { [Bucket.IDLE]: 5_301, [Bucket.AAVE]: 4_699, [Bucket.USDY]: 0, [Bucket.AUSD]: 0 },
      CURRENT,
      BASE_SNAPSHOT,
      MAX_USDY,
    );
    expect(r.errors).toContain("MOVE_EXCEEDS_MAX");
  });

  it("provides repaired weights when validation fails", () => {
    // Only slightly wrong — IDLE 100 too low.
    const r = validateProposal(weights(100, 4_900, 5_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY);
    expect(r.valid).toBe(false);
    expect(r.repairedWeightsBps).toBeDefined();
    // Repaired IDLE must be at least MIN_IDLE_BPS.
    expect(r.repairedWeightsBps![Bucket.IDLE]).toBeGreaterThanOrEqual(200);
    const repSum =
      r.repairedWeightsBps![Bucket.IDLE] +
      r.repairedWeightsBps![Bucket.AAVE] +
      r.repairedWeightsBps![Bucket.USDY] +
      r.repairedWeightsBps![Bucket.AUSD];
    expect(repSum).toBe(10_000);
  });
});

describe("applyVerdict", () => {
  const BASE_ASSESSMENT: RiskAssessment = {
    riskLevel: "NORMAL",
    candidateWeightsBps: weights(200, 4_800, 5_000, 0),
    flags: ["NONE"],
    maxUsdyWeightBpsAllowed: 6_000,
    forceDeRisk: false,
  };

  it("returns deterministic candidate when verdict is null", () => {
    const w = applyVerdict(BASE_ASSESSMENT, null);
    expect(w).toEqual(BASE_ASSESSMENT.candidateWeightsBps);
  });

  it("returns deterministic candidate on forceDeRisk regardless of verdict", () => {
    const deRiskAssessment: RiskAssessment = {
      ...BASE_ASSESSMENT,
      forceDeRisk: true,
      candidateWeightsBps: weights(5_200, 4_800, 0, 0),
    };
    const verdict: RiskVerdict = {
      riskLevel: "NORMAL",
      usdyMaxWeightBps: 5_000,
      deRisk: false,
      rationale: "Try to restore USDY",
      signals: [],
      confidence: 0.5,
    };
    const w = applyVerdict(deRiskAssessment, verdict);
    expect(w[Bucket.USDY]).toBe(0);
  });

  it("LLM verdict tightens USDY when below deterministic", () => {
    const verdict: RiskVerdict = {
      riskLevel: "CAUTION",
      usdyMaxWeightBps: 2_000,
      deRisk: false,
      rationale: "Issuer caution.",
      signals: [],
      confidence: 0.8,
    };
    const w = applyVerdict(BASE_ASSESSMENT, verdict);
    expect(w[Bucket.USDY]).toBe(2_000);
    // Freed weight goes to IDLE.
    expect(w[Bucket.IDLE]).toBe(200 + (5_000 - 2_000)); // 3200
    const sum = w[Bucket.IDLE] + w[Bucket.AAVE] + w[Bucket.USDY] + w[Bucket.AUSD];
    expect(sum).toBe(10_000);
  });

  it("LLM verdict has no effect if it tries to raise USDY above deterministic", () => {
    const verdict: RiskVerdict = {
      riskLevel: "NORMAL",
      usdyMaxWeightBps: 9_000, // too high
      deRisk: false,
      rationale: "All good",
      signals: [],
      confidence: 0.95,
    };
    const w = applyVerdict(BASE_ASSESSMENT, verdict);
    // deterministic candidate had USDY=5000; LLM can't raise it
    expect(w[Bucket.USDY]).toBe(5_000);
  });
});
