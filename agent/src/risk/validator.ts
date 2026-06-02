import {
  Bucket,
  MAX_WEIGHT_BPS,
  MAX_REBALANCE_MOVE_BPS,
  MAX_USDY_NOTIONAL_USDC,
  MIN_IDLE_BPS,
  MIN_INSTANT_LIQUIDITY_BPS,
  MIN_REBALANCE_INTERVAL,
  PEG_BLOCK_BPS,
} from "@custos/shared";
import { aaveLiquidityBps, pegDeviationBps } from "./engine.js";
import type { MarketSnapshot, RiskAssessment, WeightsBps } from "../types.js";
import type { RiskVerdict } from "../llm/types.js";

/**
 * Validation errors produced by the TS guardrail validator. Each maps 1-to-1 to
 * a check in `Guardrails.validateRebalance` so a passing result means the tx
 * should not revert (modulo TVL-cap and strategy-timelock checks which are
 * executor-side concerns in PR-3c).
 */
export type ValidationError =
  | "WEIGHTS_DONT_SUM"
  | "BUCKET_EXCEEDS_CAP"
  | "IDLE_BELOW_MIN"
  | "INSTANT_LIQUIDITY_BELOW_FLOOR"
  | "REBALANCE_TOO_SOON"
  | "MOVE_EXCEEDS_MAX"
  | "USDY_EXCEEDS_GUARDRAIL"
  | "USDY_NOTIONAL_EXCEEDS_CAP"
  | "USDY_SPOT_REQUIRED"
  | "USDY_PEG_BLOCKED";

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: ValidationError[];
  /**
   * Repaired weights — defined only when `valid` is false **and** auto-repair
   * produced a proposal that itself passes all checks. Errors that cannot be fixed
   * by weight adjustment (REBALANCE_TOO_SOON, MOVE_EXCEEDS_MAX, USDY_SPOT_REQUIRED,
   * USDY_PEG_BLOCKED) suppress the repaired field.
   */
  readonly repairedWeightsBps?: WeightsBps;
}

/** Extra chain-state inputs needed to mirror the full on-chain guardrail set. */
export interface ChainContext {
  /** Unix timestamp (seconds) of the last successful rebalance; 0 if never. */
  readonly lastRebalanceAt: number;
  /** Current unix timestamp in seconds. */
  readonly nowSec: number;
}

// Errors that cannot be fixed by clamping weights — caller must wait or supply
// different inputs.
const UNFIXABLE = new Set<ValidationError>([
  "REBALANCE_TOO_SOON",
  "MOVE_EXCEEDS_MAX",
  "USDY_SPOT_REQUIRED",
  "USDY_PEG_BLOCKED",
]);

/**
 * Pure check: runs all guardrail checks and returns the list of violated rules.
 * Shared by {@link validateProposal} and the repair re-check to avoid recursion.
 */
function checkErrors(
  proposed: WeightsBps,
  current: WeightsBps,
  snapshot: MarketSnapshot,
  maxUsdyWeightBpsAllowed: number,
  ctx: ChainContext,
): ValidationError[] {
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

  // 5. Rebalance frequency cap (mirrors Guardrails check 5).
  if (ctx.lastRebalanceAt > 0 && ctx.nowSec - ctx.lastRebalanceAt < MIN_REBALANCE_INTERVAL) {
    errors.push("REBALANCE_TOO_SOON");
  }

  // 6. Per-rebalance move cap (sum of absolute changes / 2).
  const totalMove =
    (Math.abs(proposed[Bucket.IDLE] - current[Bucket.IDLE]) +
      Math.abs(proposed[Bucket.AAVE] - current[Bucket.AAVE]) +
      Math.abs(proposed[Bucket.USDY] - current[Bucket.USDY]) +
      Math.abs(proposed[Bucket.AUSD] - current[Bucket.AUSD])) /
    2;
  if (totalMove > MAX_REBALANCE_MOVE_BPS) errors.push("MOVE_EXCEEDS_MAX");

  // 7a. USDY guardrail ceiling.
  if (proposed[Bucket.USDY] > maxUsdyWeightBpsAllowed) errors.push("USDY_EXCEEDS_GUARDRAIL");

  // 7b. Absolute USDY notional cap — only when weight is increasing (mirrors
  //     Guardrails check 7 notional gate). 0 = disabled.
  if (proposed[Bucket.USDY] > current[Bucket.USDY] && MAX_USDY_NOTIONAL_USDC > 0) {
    const postUsdyNotional = (BigInt(proposed[Bucket.USDY]) * snapshot.totalAssetsUsdc) / 10_000n;
    if (postUsdyNotional > BigInt(MAX_USDY_NOTIONAL_USDC)) {
      errors.push("USDY_NOTIONAL_EXCEEDS_CAP");
    }
  }

  // 7c–7d. USDY depeg guard — only when weight is increasing (mirrors Guardrails check 7).
  if (proposed[Bucket.USDY] > current[Bucket.USDY]) {
    if (snapshot.usdyOracleNavUsdc > 0n && snapshot.usdyDexSpotUsdc === 0n) {
      // Fail-closed: oracle live but no DEX spot → revert on-chain as UsdySpotRequired.
      errors.push("USDY_SPOT_REQUIRED");
    } else if (snapshot.usdyOracleNavUsdc > 0n && snapshot.usdyDexSpotUsdc > 0n) {
      const dev = pegDeviationBps(snapshot.usdyOracleNavUsdc, snapshot.usdyDexSpotUsdc);
      if (dev >= PEG_BLOCK_BPS) errors.push("USDY_PEG_BLOCKED");
    }
  }

  return errors;
}

/**
 * Merge the LLM verdict with the deterministic assessment to produce a final
 * candidate that is safe to sign. The LLM may only tighten; if the verdict is null
 * (API error / fallback), the deterministic candidate is used as-is.
 *
 * NOTE: `verdict.deRisk` (LLM-requested de-risk with cited evidence) and
 * `verdict.riskLevel` influence the executor's decision in PR-3c but do not
 * directly change weights here — `forceDeRisk` from the deterministic engine always
 * wins, and LLM de-risk execution is wired in the PR-3c executor/scheduler.
 *
 * Returns the final {@link WeightsBps} to propose on-chain.
 */
export function applyVerdict(
  assessment: RiskAssessment,
  verdict: RiskVerdict | null,
): WeightsBps {
  if (verdict === null || assessment.forceDeRisk) return assessment.candidateWeightsBps;

  // The LLM may only reduce USDY (tighten). Clamp to both the guardrail ceiling
  // and the deterministic candidate.
  const maxUsdy = Math.min(
    verdict.usdyMaxWeightBps,
    assessment.maxUsdyWeightBpsAllowed,
    assessment.candidateWeightsBps[Bucket.USDY],
  );

  if (maxUsdy >= assessment.candidateWeightsBps[Bucket.USDY]) {
    return assessment.candidateWeightsBps;
  }

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
 * Validate a proposed {@link WeightsBps} against the full TS mirror of
 * `Guardrails.validateRebalance`. A `valid: true` result means the tx should not
 * revert on-chain (modulo TVL-cap and strategy-timelock checks, which are
 * executor-side concerns in PR-3c).
 *
 * Mirrors on-chain checks in order:
 *   1. Weights sum to 10000
 *   2. Per-bucket caps
 *   3. Min idle buffer (2%)
 *   4. Instant-liquidity floor (15%)
 *   5. Rebalance interval (1 h)
 *   6. Max single-rebalance move (50%)
 *   7a. USDY guardrail ceiling
 *   7b. USDY spot required when weight is increasing and oracle NAV is live
 *   7c. USDY peg-blocked when deviation >= PEG_BLOCK_BPS
 */
export function validateProposal(
  proposed: WeightsBps,
  current: WeightsBps,
  snapshot: MarketSnapshot,
  maxUsdyWeightBpsAllowed: number,
  ctx: ChainContext = { lastRebalanceAt: 0, nowSec: Math.floor(Date.now() / 1000) },
): ValidationResult {
  const errors = checkErrors(proposed, current, snapshot, maxUsdyWeightBpsAllowed, ctx);
  if (errors.length === 0) return { valid: true, errors: [] };

  // Auto-repair: only for errors that can be fixed by clamping weights.
  if (errors.some((e) => UNFIXABLE.has(e))) {
    return { valid: false, errors };
  }

  // Fold the absolute USDY notional cap into the weight ceiling repair clamps to,
  // so an over-cap USDY proposal is auto-repaired down to a fillable size.
  const notionalCeilBps =
    snapshot.totalAssetsUsdc > 0n && MAX_USDY_NOTIONAL_USDC > 0
      ? Number((BigInt(MAX_USDY_NOTIONAL_USDC) * 10_000n) / snapshot.totalAssetsUsdc)
      : 10_000;
  const repaired = repair(proposed, Math.min(maxUsdyWeightBpsAllowed, notionalCeilBps));

  // Re-check the repaired weights without recursion.
  const recheckErrors = checkErrors(repaired, current, snapshot, maxUsdyWeightBpsAllowed, ctx);
  return recheckErrors.length === 0
    ? { valid: false, errors, repairedWeightsBps: repaired }
    : { valid: false, errors };
}

// ── Auto-repair ───────────────────────────────────────────────────────────────

function repair(proposed: WeightsBps, maxUsdy: number): WeightsBps {
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
  const s = w[Bucket.IDLE] + w[Bucket.AAVE] + w[Bucket.USDY] + w[Bucket.AUSD];
  return { ...w, [Bucket.IDLE]: w[Bucket.IDLE] + (10_000 - s) };
}
