// Pure guardrail mirror for the allocator multi-bucket rebalance (Allocator page).
//
// This is the browser-side twin of agent/src/risk/validator.ts: it validates a target
// allocation against the same on-chain Guardrails constants (from @custos/shared) BEFORE
// a tx is built, so an ALLOCATOR gets a precise error instead of an on-chain revert. It
// also derives the swap legs (which swap-bearing buckets changed, and by how much) the
// page must fetch calldata for. Kept dependency-free + pure so it is unit-testable.

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
import type { WeightsBps } from "./data";

export type SwapBucketKey = "USDY" | "AUSD";

export interface SwapLeg {
  bucket: SwapBucketKey;
  side: "deposit" | "withdraw";
  /** USDC notional of the leg, in 6-decimal base units. */
  usdcAmount: bigint;
}

export interface PlanInput {
  current: WeightsBps;
  target: WeightsBps;
  /** Vault TVL in 6-decimal USDC base units. */
  tvlRaw: bigint;
  /** Live |spot − NAV| peg deviation (bps) from /snapshot; 0 when unknown. */
  pegDeviationBps: number;
  /** Aave-withdrawable as bps of TVL (min(10000, withdrawable/TVL)); 10000 when unknown. */
  aaveWithdrawableBps: number;
  /** Unix seconds of the last rebalance (0 = never). */
  lastRebalanceAt: number;
  /** Current unix seconds. */
  nowSec: number;
}

export interface RebalancePlan {
  valid: boolean;
  /** First failing guardrail, human-readable; "" when valid. */
  error: string;
  /** Swap-bearing legs that changed and need /swap/quote calldata. */
  legs: SwapLeg[];
  /** Total move size in bps (Σ|Δ|/2). */
  moveBps: number;
  /** Instant-liquidity (idle + min(aave, withdrawable)) of the target, bps. */
  instantBps: number;
  /** True when the move only reduces USDY into safe buckets (move-cap exempt). */
  riskReducing: boolean;
}

const KEYS = ["IDLE", "AAVE", "USDY", "AUSD"] as const;

function sum(w: WeightsBps): number {
  return w.IDLE + w.AAVE + w.USDY + w.AUSD;
}

/** Mirror of validator.ts isRiskReducing: USDY strictly down, every other bucket non-decreasing. */
function isRiskReducing(pre: WeightsBps, post: WeightsBps): boolean {
  return (
    post.USDY < pre.USDY &&
    post.IDLE >= pre.IDLE &&
    post.AAVE >= pre.AAVE &&
    post.AUSD >= pre.AUSD
  );
}

/**
 * Validate a target allocation and derive its swap legs. Mirrors the on-chain
 * Guardrails.validateRebalance checks (and the TS validator) in the same order so a
 * `valid: true` plan should not revert on the guardrail path.
 */
export function planRebalance(input: PlanInput): RebalancePlan {
  const { current, target, tvlRaw, pegDeviationBps, aaveWithdrawableBps, lastRebalanceAt, nowSec } = input;

  const moveBps =
    (Math.abs(target.IDLE - current.IDLE) +
      Math.abs(target.AAVE - current.AAVE) +
      Math.abs(target.USDY - current.USDY) +
      Math.abs(target.AUSD - current.AUSD)) /
    2;
  const riskReducing = isRiskReducing(current, target);
  const instantBps = target.IDLE + Math.min(target.AAVE, aaveWithdrawableBps);

  // Swap legs: USDY (slot 2) and AUSD (slot 3) deltas, sized off TVL.
  const legs: SwapLeg[] = [];
  for (const bucket of ["USDY", "AUSD"] as const) {
    const delta = target[bucket] - current[bucket];
    if (delta === 0) continue;
    const usdcAmount = (BigInt(Math.abs(delta)) * tvlRaw) / 10_000n;
    if (usdcAmount > 0n) legs.push({ bucket, side: delta > 0 ? "deposit" : "withdraw", usdcAmount });
  }

  const err = firstError();
  return { valid: err === "", error: err, legs, moveBps, instantBps, riskReducing };

  function firstError(): string {
    if (tvlRaw <= 0n) return "Vault is empty — deposit USDC first";
    if (sum(target) !== 10_000) return "Weights must total 100%";

    for (const k of ["AAVE", "USDY", "AUSD"] as const) {
      const cap = MAX_WEIGHT_BPS[Bucket[k]];
      if (target[k] > cap) return `${k} is capped at ${(cap / 100).toFixed(0)}%`;
      if (target[k] < 0) return `${k} cannot be negative`;
    }

    if (target.IDLE < MIN_IDLE_BPS) return `Idle must stay at least ${(MIN_IDLE_BPS / 100).toFixed(0)}%`;
    if (instantBps < MIN_INSTANT_LIQUIDITY_BPS) return `Instant liquidity must stay above ${(MIN_INSTANT_LIQUIDITY_BPS / 100).toFixed(0)}%`;

    if (lastRebalanceAt > 0 && nowSec - lastRebalanceAt < MIN_REBALANCE_INTERVAL) {
      const mins = Math.ceil((MIN_REBALANCE_INTERVAL - (nowSec - lastRebalanceAt)) / 60);
      return `Next rebalance in ${mins} min (1-hour guardrail)`;
    }

    if (moveBps > MAX_REBALANCE_MOVE_BPS && !riskReducing) {
      return `Move too large — at most ${(MAX_REBALANCE_MOVE_BPS / 100).toFixed(0)}% of TVL per rebalance`;
    }

    // USDY-increase guards (notional cap + peg block), mirroring validator checks 7b–7c.
    if (target.USDY > current.USDY) {
      if (MAX_USDY_NOTIONAL_USDC > 0) {
        const postNotional = (BigInt(target.USDY) * tvlRaw) / 10_000n;
        if (postNotional > BigInt(MAX_USDY_NOTIONAL_USDC)) {
          return `USDY notional capped at $${(MAX_USDY_NOTIONAL_USDC / 1e6).toLocaleString()}`;
        }
      }
      if (pegDeviationBps >= PEG_BLOCK_BPS) {
        return `USDY peg off ${(pegDeviationBps / 100).toFixed(2)}% — new USDY blocked above ${(PEG_BLOCK_BPS / 100).toFixed(2)}%`;
      }
    }

    return "";
  }
}

/** The unchanged keys helper, exported for the page's input wiring. */
export const WEIGHT_KEYS = KEYS;

// ── On-chain guardrail reason decoding ──────────────────────────────────────
//
// YieldVault.rebalance reverts `GuardrailsRejected(bytes4 reason)` where `reason`
// is the 4-byte selector of the failing Guardrails check. viem decodes the outer
// error (vaultAbi.ts) to the raw selector; this map turns that selector into the
// same human-readable text the pre-flight mirror uses. Selectors are the first 4
// bytes of keccak256(errorSignature) — keep in sync with contracts/src/Guardrails.sol.
export const GUARDRAIL_REASON_TEXT: Record<string, string> = {
  "0xa3d27378": "Weights must total 100%",
  "0xcaaf06dc": "A bucket exceeds its weight cap",
  "0x513f07ad": `Idle must stay at least ${(MIN_IDLE_BPS / 100).toFixed(0)}%`,
  "0xe448d791": `Instant liquidity must stay above ${(MIN_INSTANT_LIQUIDITY_BPS / 100).toFixed(0)}%`,
  "0xfe1af477": "Rebalance interval not elapsed (1-hour guardrail)",
  "0x8b257661": `Move too large — at most ${(MAX_REBALANCE_MOVE_BPS / 100).toFixed(0)}% of TVL per rebalance`,
  "0x96b5021b": `USDY is off-peg by ≥ ${(PEG_BLOCK_BPS / 100).toFixed(2)}% — adding USDY is blocked. Mantle's thin USDY pools mean a buy of this size moves the price past the peg guard; try a smaller USDY increase or wait for deeper liquidity.`,
  "0x33b95123": "A live USDY DEX spot is required to add USDY (none was supplied)",
  "0x0781eae1": `USDY notional capped at $${(MAX_USDY_NOTIONAL_USDC / 1e6).toLocaleString()}`,
};

/** Map a `GuardrailsRejected` inner reason selector to friendly text (or the raw selector). */
export function describeGuardrailReason(reason: string): string {
  return GUARDRAIL_REASON_TEXT[reason.toLowerCase()] ?? `Guardrails rejected the rebalance (${reason})`;
}

/**
 * Mirror of the on-chain `UsdySpotRequired` check (Guardrails.sol §7): when USDY
 * weight increases, the vault fails closed unless a non-zero DEX spot is supplied.
 * The pure `planRebalance` mirror runs BEFORE the swap quote is fetched, so it cannot
 * see the spot; the page calls this once the leg quote has resolved `usdyDexSpot`.
 * Returns an error string when the on-chain guard would revert, else "".
 */
export function checkUsdySpot(current: WeightsBps, target: WeightsBps, usdyDexSpot: bigint): string {
  if (target.USDY > current.USDY && usdyDexSpot <= 0n) {
    return "Could not fetch a USDY DEX spot price — required to add USDY. Retry, or check the agent's /swap/quote.";
  }
  return "";
}
