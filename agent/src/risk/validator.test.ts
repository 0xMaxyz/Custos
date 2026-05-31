import { describe, it, expect } from "vitest";
import { Bucket } from "@sentinel/shared";
import { validateProposal, applyVerdict, type ChainContext } from "./validator.js";
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
const CTX: ChainContext = { lastRebalanceAt: 0, nowSec: NOW };

describe("validateProposal — individual guardrail checks", () => {
  it("accepts a valid proposal", () => {
    const r = validateProposal(weights(200, 4_800, 5_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY, CTX);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects weights that don't sum to 10000", () => {
    const r = validateProposal(weights(200, 4_800, 4_999, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY, CTX);
    expect(r.errors).toContain("WEIGHTS_DONT_SUM");
    expect(r.valid).toBe(false);
  });

  it("rejects USDY above the per-bucket cap (6000)", () => {
    const r = validateProposal(weights(200, 800, 9_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY, CTX);
    expect(r.errors).toContain("BUCKET_EXCEEDS_CAP");
  });

  it("rejects USDY above the cycle guardrail ceiling", () => {
    const r = validateProposal(weights(200, 3_500, 6_300, 0), CURRENT, BASE_SNAPSHOT, 6_000, CTX);
    expect(r.errors).toContain("USDY_EXCEEDS_GUARDRAIL");
  });

  it("rejects IDLE below the 2% minimum", () => {
    const r = validateProposal(weights(100, 4_900, 5_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY, CTX);
    expect(r.errors).toContain("IDLE_BELOW_MIN");
  });

  it("rejects when instant liquidity is below the 15% floor", () => {
    const zeroAave: MarketSnapshot = { ...BASE_SNAPSHOT, aaveWithdrawableUsdc: 0n };
    const r = validateProposal(weights(200, 0, 5_000, 4_800), CURRENT, zeroAave, MAX_USDY, CTX);
    expect(r.errors).toContain("INSTANT_LIQUIDITY_BELOW_FLOOR");
  });

  it("rejects a move exceeding the 50% cap", () => {
    // IDLE 300→5301 (+5001), AAVE 4700→4699 (−1), USDY 5000→0 (−5000) → totalMove = 5001 > 5000 cap.
    const r = validateProposal(
      { [Bucket.IDLE]: 5_301, [Bucket.AAVE]: 4_699, [Bucket.USDY]: 0, [Bucket.AUSD]: 0 },
      CURRENT,
      BASE_SNAPSHOT,
      MAX_USDY,
      CTX,
    );
    expect(r.errors).toContain("MOVE_EXCEEDS_MAX");
  });

  it("rejects when rebalance interval has not elapsed", () => {
    const recentCtx: ChainContext = { lastRebalanceAt: NOW - 1_000, nowSec: NOW }; // only 1000s ago
    const r = validateProposal(weights(200, 4_800, 5_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY, recentCtx);
    expect(r.errors).toContain("REBALANCE_TOO_SOON");
  });

  it("accepts when exactly one interval has elapsed since last rebalance", () => {
    const okCtx: ChainContext = { lastRebalanceAt: NOW - 3_600, nowSec: NOW };
    const r = validateProposal(weights(200, 4_800, 5_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY, okCtx);
    expect(r.errors).not.toContain("REBALANCE_TOO_SOON");
  });

  it("rejects USDY increase when oracle live but DEX spot is missing (fail-closed)", () => {
    const noSpot: MarketSnapshot = { ...BASE_SNAPSHOT, usdyDexSpotUsdc: 0n };
    // Propose increasing USDY from 5000 → 5500.
    const r = validateProposal(weights(200, 4_300, 5_500, 0), CURRENT, noSpot, MAX_USDY, CTX);
    expect(r.errors).toContain("USDY_SPOT_REQUIRED");
  });

  it("allows USDY decrease even when spot is missing", () => {
    const noSpot: MarketSnapshot = { ...BASE_SNAPSHOT, usdyDexSpotUsdc: 0n };
    // Decrease USDY from 5000 → 4000 — spot guard only applies when increasing.
    const r = validateProposal(weights(1_200, 4_800, 4_000, 0), CURRENT, noSpot, MAX_USDY, CTX);
    expect(r.errors).not.toContain("USDY_SPOT_REQUIRED");
  });

  it("rejects USDY increase when peg deviation >= 50bps (PEG_BLOCK)", () => {
    // 1.08 NAV, spot ~1.0746 → ~50bps deviation.
    const depegSnap: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      usdyDexSpotUsdc: 1_074_600_000_000_000_000n,
    };
    const r = validateProposal(weights(200, 4_300, 5_500, 0), CURRENT, depegSnap, MAX_USDY, CTX);
    expect(r.errors).toContain("USDY_PEG_BLOCKED");
  });

  it("provides repaired weights when validation fails on fixable errors", () => {
    const r = validateProposal(weights(100, 4_900, 5_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY, CTX);
    expect(r.valid).toBe(false);
    expect(r.repairedWeightsBps).toBeDefined();
    expect(r.repairedWeightsBps![Bucket.IDLE]).toBeGreaterThanOrEqual(200);
    const repSum =
      r.repairedWeightsBps![Bucket.IDLE] +
      r.repairedWeightsBps![Bucket.AAVE] +
      r.repairedWeightsBps![Bucket.USDY] +
      r.repairedWeightsBps![Bucket.AUSD];
    expect(repSum).toBe(10_000);
  });

  it("does not provide repaired weights when move-cap is violated (not fixable by weight adjustment)", () => {
    const r = validateProposal(
      { [Bucket.IDLE]: 5_301, [Bucket.AAVE]: 4_699, [Bucket.USDY]: 0, [Bucket.AUSD]: 0 },
      CURRENT,
      BASE_SNAPSHOT,
      MAX_USDY,
      CTX,
    );
    expect(r.errors).toContain("MOVE_EXCEEDS_MAX");
    expect(r.repairedWeightsBps).toBeUndefined();
  });

  it("does not provide repaired weights when rebalance interval not elapsed", () => {
    const recentCtx: ChainContext = { lastRebalanceAt: NOW - 100, nowSec: NOW };
    const r = validateProposal(weights(200, 4_800, 5_000, 0), CURRENT, BASE_SNAPSHOT, MAX_USDY, recentCtx);
    expect(r.errors).toContain("REBALANCE_TOO_SOON");
    expect(r.repairedWeightsBps).toBeUndefined();
  });
});

describe("validateProposal — property tests (random invalid weights hit expected error classes)", () => {
  // Generate pseudorandom weights that violate at least one constraint.
  function randomInvalidWeights(seed: number): WeightsBps {
    const a = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    const b = (a * 1_103_515_245 + 12_345) & 0x7fffffff;
    const c = (b * 1_103_515_245 + 12_345) & 0x7fffffff;
    const d = (c * 1_103_515_245 + 12_345) & 0x7fffffff;
    // All four buckets in 0–7000; rarely sums to exactly 10000, often violates caps.
    return {
      [Bucket.IDLE]: a % 7_000,
      [Bucket.AAVE]: b % 7_000,
      [Bucket.USDY]: c % 7_000,
      [Bucket.AUSD]: d % 3_000,
    };
  }

  it("random invalid weight sets always fail validation (20 seeds)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const w = randomInvalidWeights(seed);
      const sum = w[Bucket.IDLE] + w[Bucket.AAVE] + w[Bucket.USDY] + w[Bucket.AUSD];
      if (sum === 10_000 && w[Bucket.IDLE] >= 200 && w[Bucket.AAVE] <= 9_000 && w[Bucket.USDY] <= 6_000) {
        continue; // skip the rare case that happens to be valid
      }
      const r = validateProposal(w, CURRENT, BASE_SNAPSHOT, MAX_USDY, CTX);
      expect(r.valid, `seed=${seed} unexpectedly valid: ${JSON.stringify(w)}`).toBe(false);
    }
  });

  it("repaired weights always sum to 10000 (20 seeds)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const w = randomInvalidWeights(seed);
      const r = validateProposal(w, CURRENT, BASE_SNAPSHOT, MAX_USDY, CTX);
      if (!r.repairedWeightsBps) continue;
      const repSum =
        r.repairedWeightsBps[Bucket.IDLE] +
        r.repairedWeightsBps[Bucket.AAVE] +
        r.repairedWeightsBps[Bucket.USDY] +
        r.repairedWeightsBps[Bucket.AUSD];
      expect(repSum, `seed=${seed} repaired sum wrong`).toBe(10_000);
      expect(r.repairedWeightsBps[Bucket.IDLE], `seed=${seed} repaired idle below min`).toBeGreaterThanOrEqual(200);
    }
  });

  it("repaired weights always pass a second validateProposal (repair is idempotent) (20 seeds)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const w = randomInvalidWeights(seed);
      const r = validateProposal(w, CURRENT, BASE_SNAPSHOT, MAX_USDY, CTX);
      if (!r.repairedWeightsBps) continue;
      const recheck = validateProposal(r.repairedWeightsBps, CURRENT, BASE_SNAPSHOT, MAX_USDY, CTX);
      expect(recheck.valid, `seed=${seed} repaired weights still fail: ${JSON.stringify(recheck.errors)}`).toBe(true);
    }
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
    expect(w[Bucket.IDLE]).toBe(200 + (5_000 - 2_000));
    const sum = w[Bucket.IDLE] + w[Bucket.AAVE] + w[Bucket.USDY] + w[Bucket.AUSD];
    expect(sum).toBe(10_000);
  });

  it("LLM verdict has no effect if it tries to raise USDY above deterministic", () => {
    const verdict: RiskVerdict = {
      riskLevel: "NORMAL",
      usdyMaxWeightBps: 9_000,
      deRisk: false,
      rationale: "All good",
      signals: [],
      confidence: 0.95,
    };
    const w = applyVerdict(BASE_ASSESSMENT, verdict);
    expect(w[Bucket.USDY]).toBe(5_000);
  });
});
