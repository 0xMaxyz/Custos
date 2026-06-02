import {
  Bucket,
  MAX_WEIGHT_BPS,
  MIN_IDLE_BPS,
  MIN_INSTANT_LIQUIDITY_BPS,
  PEG_WARN_BPS,
  PEG_BLOCK_BPS,
  PEG_DE_RISK_BPS,
  ORACLE_RANGE_END_BUFFER,
  ORACLE_MAX_AGE,
  type RiskLevel,
} from "@custos/shared";

import type { MarketSnapshot, RiskAssessment, RiskFlag, WeightsBps } from "../types.js";

/**
 * Deterministic risk engine — pure functions, no network, no clock except an
 * injectable `now`. Turns a {@link MarketSnapshot} into a candidate allocation,
 * risk flags, and the guardrail ceiling for the cycle.
 *
 * This is the floor the LLM may only TIGHTEN (SPEC §3.3). All hard limits live
 * here and in the on-chain Guardrails — the model is never the last line.
 */

const BPS = 10_000;

/**
 * AUSD is under-backed if its PoR ratio drops below this floor (bps). A value of
 * 0 means PoR is unavailable this cycle and is treated as "unknown" (no flag).
 * Conservative: anything below 99.5% backing while we hold AUSD raises caution.
 */
const AUSD_POR_MIN_BPS = 9_950;

// ── Pure metric functions ─────────────────────────────────────────────────────

/**
 * Absolute peg deviation between DEX spot and oracle NAV, in bps. Returns 0 when
 * either price is missing (guard treated as inactive that cycle).
 */
export function pegDeviationBps(oracleNavUsdc: bigint, dexSpotUsdc: bigint): number {
  if (oracleNavUsdc <= 0n || dexSpotUsdc <= 0n) return 0;
  const diff =
    oracleNavUsdc > dexSpotUsdc ? oracleNavUsdc - dexSpotUsdc : dexSpotUsdc - oracleNavUsdc;
  return Number((diff * BigInt(BPS)) / oracleNavUsdc);
}

/** Yield spread (USDY-implied APY − Aave supply APY) in bps; may be negative. */
export function yieldSpreadBps(usdyImpliedApyBps: number, aaveSupplyApyBps: number): number {
  return usdyImpliedApyBps - aaveSupplyApyBps;
}

/**
 * Whether the oracle NAV is stale: past its range end, or (if a timestamp is
 * known) older than ORACLE_MAX_AGE.
 */
export function isOracleStale(snapshot: MarketSnapshot, nowSec: number): boolean {
  const pastRangeEnd = snapshot.oracleRangeEnd > 0 && nowSec > snapshot.oracleRangeEnd;
  const aged = snapshot.oracleUpdatedAt > 0 && nowSec - snapshot.oracleUpdatedAt > ORACLE_MAX_AGE;
  return pastRangeEnd || aged;
}

/** Whether the oracle is within ORACLE_RANGE_END_BUFFER of its range end. */
export function isOracleNearRangeEnd(snapshot: MarketSnapshot, nowSec: number): boolean {
  return (
    snapshot.oracleRangeEnd > 0 &&
    snapshot.oracleRangeEnd > nowSec &&
    snapshot.oracleRangeEnd - nowSec < ORACLE_RANGE_END_BUFFER
  );
}

/**
 * Aave-withdrawable expressed as a fraction of TVL, in bps (capped at 10000).
 * Used for the instant-liquidity floor check.
 */
export function aaveLiquidityBps(snapshot: MarketSnapshot): number {
  if (snapshot.totalAssetsUsdc <= 0n) return 0;
  const bps = Number((snapshot.aaveWithdrawableUsdc * BigInt(BPS)) / snapshot.totalAssetsUsdc);
  return bps > BPS ? BPS : bps;
}

// ── Weights helpers ───────────────────────────────────────────────────────────

function sumWeights(w: WeightsBps): number {
  return w[Bucket.IDLE] + w[Bucket.AAVE] + w[Bucket.USDY] + w[Bucket.AUSD];
}

/** Clamp a USDY target into [0, ceiling] and rebalance the remainder to IDLE/AAVE. */
function withUsdyWeight(current: WeightsBps, usdyBps: number): WeightsBps {
  const clampedUsdy = Math.max(0, Math.min(usdyBps, MAX_WEIGHT_BPS[Bucket.USDY]));
  const freed = current[Bucket.USDY] - clampedUsdy;
  // Move the delta to AAVE (instant-liquid) without exceeding its cap; spill to IDLE.
  const aaveRoom = MAX_WEIGHT_BPS[Bucket.AAVE] - current[Bucket.AAVE];
  const toAave = freed > 0 ? Math.min(freed, aaveRoom) : freed; // negative freed pulls from AAVE
  const next: WeightsBps = {
    [Bucket.IDLE]: current[Bucket.IDLE] + (freed - toAave),
    [Bucket.AAVE]: current[Bucket.AAVE] + toAave,
    [Bucket.USDY]: clampedUsdy,
    [Bucket.AUSD]: current[Bucket.AUSD],
  };
  return normalizeToIdle(next);
}

/** Force any rounding/residual remainder into IDLE so weights sum to exactly 10000. */
function normalizeToIdle(w: WeightsBps): WeightsBps {
  const drift = BPS - sumWeights(w);
  return { ...w, [Bucket.IDLE]: w[Bucket.IDLE] + drift };
}

/** Rotate the entire USDY weight into IDLE (the de-risk safe sink). */
function deRiskWeights(current: WeightsBps): WeightsBps {
  return normalizeToIdle({
    [Bucket.IDLE]: current[Bucket.IDLE] + current[Bucket.USDY],
    [Bucket.AAVE]: current[Bucket.AAVE],
    [Bucket.USDY]: 0,
    [Bucket.AUSD]: current[Bucket.AUSD],
  });
}

// ── Main assessment ───────────────────────────────────────────────────────────

export interface AssessOptions {
  /** Current unix time in seconds; injectable for deterministic tests. */
  readonly nowSec?: number;
}

/**
 * Assess a snapshot deterministically. Produces the candidate allocation, the
 * raised flags, the guardrail ceiling for USDY this cycle, and whether to force a
 * de-risk. The result is the safe floor for the downstream LLM/validator.
 */
export function assess(snapshot: MarketSnapshot, options: AssessOptions = {}): RiskAssessment {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const flags: RiskFlag[] = [];

  const deviation = pegDeviationBps(snapshot.usdyOracleNavUsdc, snapshot.usdyDexSpotUsdc);
  const stale = isOracleStale(snapshot, nowSec);
  const nearEnd = isOracleNearRangeEnd(snapshot, nowSec);
  const liquidityBps = snapshot.currentWeightsBps[Bucket.IDLE] + aaveLiquidityBps(snapshot);

  // Determine USDY ceiling + risk level from peg / oracle conditions.
  let riskLevel: RiskLevel = "NORMAL";
  let usdyCeiling = MAX_WEIGHT_BPS[Bucket.USDY];
  let forceDeRisk = false;

  if (stale) {
    flags.push("ORACLE_STALE");
    riskLevel = "DERISK";
    usdyCeiling = 0;
    forceDeRisk = true;
  }

  if (deviation >= PEG_DE_RISK_BPS) {
    flags.push("PEG_DE_RISK");
    riskLevel = "DERISK";
    usdyCeiling = 0;
    forceDeRisk = true;
  } else if (deviation >= PEG_BLOCK_BPS) {
    flags.push("PEG_BLOCK");
    if (riskLevel === "NORMAL") riskLevel = "CAUTION";
    // Block new USDY: ceiling no higher than current weight.
    usdyCeiling = Math.min(usdyCeiling, snapshot.currentWeightsBps[Bucket.USDY]);
  } else if (deviation >= PEG_WARN_BPS) {
    flags.push("PEG_WARN");
    if (riskLevel === "NORMAL") riskLevel = "CAUTION";
  }

  if (nearEnd) {
    flags.push("ORACLE_NEAR_RANGE_END");
    if (riskLevel === "NORMAL") riskLevel = "CAUTION";
  }

  if (liquidityBps < MIN_INSTANT_LIQUIDITY_BPS) {
    flags.push("LOW_LIQUIDITY");
    if (riskLevel === "NORMAL") riskLevel = "CAUTION";
  }

  // AUSD proof-of-reserves: if we hold AUSD and its backing is known-and-thin,
  // surface a caution. ratio=0 means "unknown" (PoR unavailable) → no flag.
  if (
    snapshot.currentWeightsBps[Bucket.AUSD] > 0 &&
    snapshot.ausdBackingRatioBps > 0 &&
    snapshot.ausdBackingRatioBps < AUSD_POR_MIN_BPS
  ) {
    flags.push("AUSD_POR_WARN");
    if (riskLevel === "NORMAL") riskLevel = "CAUTION";
  }

  if (flags.length === 0) flags.push("NONE");

  // Propose candidate weights.
  let candidate: WeightsBps;
  if (forceDeRisk) {
    candidate = deRiskWeights(snapshot.currentWeightsBps);
  } else {
    // Target USDY = current, bounded by ceiling and by the yield signal: only hold
    // USDY while it out-yields Aave; otherwise prefer the instant-liquid bucket.
    const spread = yieldSpreadBps(snapshot.usdyImpliedApyBps, snapshot.aaveUsdcSupplyApyBps);
    const desiredUsdy = spread > 0 ? snapshot.currentWeightsBps[Bucket.USDY] : 0;
    candidate = withUsdyWeight(snapshot.currentWeightsBps, Math.min(desiredUsdy, usdyCeiling));
  }

  // Enforce the minimum idle buffer, then the instant-liquidity floor, on the
  // candidate — so the deterministic engine is a true guardrail floor (the same
  // bounds the on-chain Guardrails.validateRebalance enforces) before the LLM /
  // TS validator ever sees it.
  candidate = enforceMinIdle(candidate);
  candidate = enforceInstantLiquidity(candidate, snapshot);

  return {
    riskLevel,
    candidateWeightsBps: candidate,
    flags,
    maxUsdyWeightBpsAllowed: usdyCeiling,
    forceDeRisk,
  };
}

/** Ensure IDLE >= MIN_IDLE_BPS by pulling from non-idle buckets (AAVE → USDY → AUSD). */
function enforceMinIdle(w: WeightsBps): WeightsBps {
  if (w[Bucket.IDLE] >= MIN_IDLE_BPS) return w;
  const next: WeightsBps = { ...w };
  let needed = MIN_IDLE_BPS - next[Bucket.IDLE];
  for (const b of [Bucket.AAVE, Bucket.USDY, Bucket.AUSD] as const) {
    if (needed <= 0) break;
    const take = Math.min(next[b], needed);
    next[b] -= take;
    next[Bucket.IDLE] += take;
    needed -= take;
  }
  return normalizeToIdle(next);
}

/**
 * Instant liquidity = IDLE + min(AAVE weight, Aave-withdrawable fraction of TVL).
 * If the candidate falls below MIN_INSTANT_LIQUIDITY_BPS, shift weight out of the
 * illiquid buckets (USDY → AUSD) into IDLE until the floor is met. Mirrors the
 * on-chain check so the candidate never proposes a move that would revert.
 */
function enforceInstantLiquidity(w: WeightsBps, snapshot: MarketSnapshot): WeightsBps {
  const aaveCap = aaveLiquidityBps(snapshot); // Aave-withdrawable as bps of TVL
  const instant = (x: WeightsBps): number => x[Bucket.IDLE] + Math.min(x[Bucket.AAVE], aaveCap);
  if (instant(w) >= MIN_INSTANT_LIQUIDITY_BPS) return w;

  const next: WeightsBps = { ...w };
  let needed = MIN_INSTANT_LIQUIDITY_BPS - instant(next);
  // Pull from the illiquid buckets into IDLE (which counts fully toward instant).
  for (const b of [Bucket.USDY, Bucket.AUSD] as const) {
    if (needed <= 0) break;
    const take = Math.min(next[b], needed);
    next[b] -= take;
    next[Bucket.IDLE] += take;
    needed -= take;
  }
  return normalizeToIdle(next);
}
