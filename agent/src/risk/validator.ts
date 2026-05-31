import {
  Bucket,
  MAX_WEIGHT_BPS,
  MAX_REBALANCE_MOVE_BPS,
  MIN_IDLE_BPS,
  MIN_INSTANT_LIQUIDITY_BPS,
} from "@sentinel/shared";
import { aaveLiquidityBps } from "./engine.js";
import type { MarketSnapshot, RiskAssessment, WeightsBps } from "../types.js";
import type { RiskVerdict } from "../llm/types.js";

/**
 * Validation errors produced by the TS guardrail validator. Each maps to one
 * check that the on-chain `Guardrails.validateRebalance` also performs, so a
 * passing TS validation means the tx should not revert.
 */
export type ValidationError =
  | "WEIGHTS_DONT_SUM"
  | "BUCKET_EXCEEDS_CAP"
  | "IDLE_BELOW_MIN"
  | "INSTANT_LIQUIDITY_BELOW_FLOOR"
  | "MOVE_EXCEEDS_MAX"
  | "USDY_EXCEEDS_GUARDRAIL";

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: ValidationError[];
  /** Repaired weights; defined only when `valid` is false and auto-repair succeeded. */
  readonly repairedWeightsBps?: WeightsBps;
}

/**
 * Merge the LLM verdict with the deterministic assessment to produce a final
 * candidate that is safe to sign. The LLM may only tighten; if the verdict is null
 * (API error / fallback), the deterministic candidate is used as-is.
 *
 * Returns the final {@link WeightsBps} to propose on-chain.
 */
export function applyVerdict(
  assessment: RiskAssessment,
  verdict: RiskVerdict | null,
): WeightsBps {
  // verdict.deRisk (LLM-requested de-risk with cited evidence) is acknowledged here
  // but weight execution is owned by the executor/scheduler in PR-3c. forceDeRisk
  // (deterministic) always wins regardless.
  if (verdict === null || assessment.forceDeRisk) return assessment.candidateWeightsBps;

  // The LLM may only reduce USDY (tighten). Clamp to both the guardrail ceiling
  // and the deterministic candidate.
  const maxUsdy = Math.min(
    verdict.usdyMaxWeightBps,
    assessment.maxUsdyWeightBpsAllowed,
    assessment.candidateWeightsBps[Bucket.USDY],
  );

  if (maxUsdy >= assessment.candidateWeightsBps[Bucket.USDY]) {
    // No tightening — use deterministic candidate verbatim.
    return assessment.candidateWeightsBps;
  }

  // Reduce USDY; move the freed weight to IDLE (safe sink).
  const freed = assessment.candidateWeightsBps[Bucket.USDY] - maxUsdy;
  const candidate = assessment.candidateWeightsBps;
  return {
    [Bucket.IDLE]: candidate[Bucket.IDLE] + freed,
    [Bucket.AAVE]: candidate[Bucket.AAVE],
    [Bucket.USDY]: maxUsdy,
    [Bucket.AUSD]: candidate[Bucket.AUSD],
  };
}

/**
 * Validate a proposed {@link WeightsBps} against the TS mirrors of on-chain
 * guardrails. Returns a {@link ValidationResult} with any errors and, if
 * validation fails, auto-repaired weights where possible.
 */
export function validateProposal(
  proposed: WeightsBps,
  current: WeightsBps,
  snapshot: MarketSnapshot,
  maxUsdyWeightBpsAllowed: number,
): ValidationResult {
  const errors: ValidationError[] = [];

  // 1. Weights must sum to 10000.
  const sum =
    proposed[Bucket.IDLE] +
    proposed[Bucket.AAVE] +
    proposed[Bucket.USDY] +
    proposed[Bucket.AUSD];
  if (sum !== 10_000) errors.push("WEIGHTS_DONT_SUM");

  // 2. Per-bucket caps.
  for (const b of [Bucket.AAVE, Bucket.USDY, Bucket.AUSD] as const) {
    if (proposed[b] > MAX_WEIGHT_BPS[b]) errors.push("BUCKET_EXCEEDS_CAP");
  }

  // 3. Minimum idle buffer.
  if (proposed[Bucket.IDLE] < MIN_IDLE_BPS) errors.push("IDLE_BELOW_MIN");

  // 4. Instant-liquidity floor.
  const aaveCap = aaveLiquidityBps(snapshot);
  const instant = proposed[Bucket.IDLE] + Math.min(proposed[Bucket.AAVE], aaveCap);
  if (instant < MIN_INSTANT_LIQUIDITY_BPS) errors.push("INSTANT_LIQUIDITY_BELOW_FLOOR");

  // 5. Per-rebalance move cap (sum of absolute changes across all buckets / 2).
  const totalMove =
    (Math.abs(proposed[Bucket.IDLE] - current[Bucket.IDLE]) +
      Math.abs(proposed[Bucket.AAVE] - current[Bucket.AAVE]) +
      Math.abs(proposed[Bucket.USDY] - current[Bucket.USDY]) +
      Math.abs(proposed[Bucket.AUSD] - current[Bucket.AUSD])) /
    2;
  if (totalMove > MAX_REBALANCE_MOVE_BPS) errors.push("MOVE_EXCEEDS_MAX");

  // 6. USDY guardrail ceiling from this cycle's risk assessment.
  if (proposed[Bucket.USDY] > maxUsdyWeightBpsAllowed) errors.push("USDY_EXCEEDS_GUARDRAIL");

  if (errors.length === 0) return { valid: true, errors: [] };

  // Auto-repair: clamp each bucket to its cap, enforce min-idle, normalise to IDLE.
  const repaired = repair(proposed, current, snapshot, maxUsdyWeightBpsAllowed);
  return { valid: false, errors, repairedWeightsBps: repaired };
}

// ── Auto-repair ───────────────────────────────────────────────────────────────

function repair(
  proposed: WeightsBps,
  current: WeightsBps,
  snapshot: MarketSnapshot,
  maxUsdy: number,
): WeightsBps {
  let w: WeightsBps = {
    [Bucket.IDLE]: proposed[Bucket.IDLE],
    [Bucket.AAVE]: Math.min(proposed[Bucket.AAVE], MAX_WEIGHT_BPS[Bucket.AAVE]),
    [Bucket.USDY]: Math.min(proposed[Bucket.USDY], MAX_WEIGHT_BPS[Bucket.USDY], maxUsdy),
    [Bucket.AUSD]: Math.min(proposed[Bucket.AUSD], MAX_WEIGHT_BPS[Bucket.AUSD]),
  };

  // Enforce IDLE floor: pull from AAVE → USDY → AUSD.
  if (w[Bucket.IDLE] < MIN_IDLE_BPS) {
    let needed = MIN_IDLE_BPS - w[Bucket.IDLE];
    for (const b of [Bucket.AAVE, Bucket.USDY, Bucket.AUSD] as const) {
      if (needed <= 0) break;
      const take = Math.min(w[b], needed);
      w = { ...w, [b]: w[b] - take, [Bucket.IDLE]: w[Bucket.IDLE] + take };
      needed -= take;
    }
  }

  // Normalise sum to 10000 via IDLE.
  const sum =
    w[Bucket.IDLE] + w[Bucket.AAVE] + w[Bucket.USDY] + w[Bucket.AUSD];
  return { ...w, [Bucket.IDLE]: w[Bucket.IDLE] + (10_000 - sum) };
}
