import { Bucket } from "./types.js";

/**
 * Guardrail constants — single source of truth shared between the on-chain
 * Guardrails.sol and the off-chain TS validator.
 *
 * All bps values are integer basis points (1 bps = 0.01%).
 * All time values are seconds.
 * All USDC amounts are in units of 6-decimal USDC (i.e. 1 USDC = 1_000_000).
 *
 * SPEC.md §1 defines what each param means.
 */

// ── Allocation limits ─────────────────────────────────────────────────────────

/** Maximum weight per bucket in bps. Index = Bucket enum value. */
export const MAX_WEIGHT_BPS: Record<Bucket, number> = {
  [Bucket.IDLE]: 10_000, // idle has no upper cap
  [Bucket.AAVE]: 9_000,  // 90%
  [Bucket.USDY]: 6_000,  // 60%
  [Bucket.AUSD]: 10_000, // 100% (absorbs all on de-risk)
} as const;

/**
 * Absolute cap on USDY exposure (6-decimal USDC; 0 = disabled). Mantle USDY pools
 * total ~$1.5k across Agni/iZiSwap/Butter, so a deterministic notional ceiling that
 * tracks real aggregator depth — independent of TVL or the % weight cap — keeps the
 * vault from sizing a swap larger than the market can fill. Mirrors
 * Guardrails.Config.maxUsdyNotionalUsdc.
 */
export const MAX_USDY_NOTIONAL_USDC = 5_000 * 1_000_000; // $5,000

/** Minimum idle buffer that must remain after any rebalance (bps of TVL). */
export const MIN_IDLE_BPS = 200; // 2%

/**
 * Minimum instant-liquidity floor (idle + Aave-withdrawable) after any rebalance.
 * Must be >= MIN_IDLE_BPS.
 */
export const MIN_INSTANT_LIQUIDITY_BPS = 1_500; // 15%

// ── Execution safety ──────────────────────────────────────────────────────────

/** Maximum per-swap slippage tolerance in bps. */
export const MAX_SLIPPAGE_BPS = 50; // 0.5%

/** Maximum fraction of TVL a single rebalance may move (bps). De-risk is exempt. */
export const MAX_REBALANCE_MOVE_BPS = 5_000; // 50%

/** Minimum seconds between ordinary rebalances. De-risk is exempt. */
export const MIN_REBALANCE_INTERVAL = 3_600; // 1 hour

/** Maximum vault TVL for the mainnet demo (6-decimal USDC). */
export const TVL_CAP_USDC = 50_000 * 1_000_000; // $50,000

/** Maximum single deposit during demo (6-decimal USDC). */
export const PER_TX_DEPOSIT_CAP_USDC = 10_000 * 1_000_000; // $10,000

/** Delay (seconds) before a newly-added strategy adapter becomes usable. */
export const ADD_STRATEGY_TIMELOCK = 2 * 24 * 3_600; // 48 hours

/**
 * Hard floor (seconds) for Config.addStrategyTimelock (M5). Mirrors Guardrails.MIN_TIMELOCK.
 * The add-strategy timelock doubles as the delay for every timelocked governance action
 * (config changes, guardrail swaps), so a queued config could otherwise ratchet the delay
 * to zero and neuter the timelock -- this floor (enforced in _requireValidConfig) prevents that.
 */
export const MIN_TIMELOCK = 3_600; // 1 hour

// ── USDY risk thresholds ──────────────────────────────────────────────────────

/** |DEX spot - oracle NAV| in bps => surface CAUTION signal. */
export const PEG_WARN_BPS = 30; // 0.3%

/** |DEX spot - oracle NAV| in bps => block new USDY allocation. */
export const PEG_BLOCK_BPS = 50; // 0.5%

/** |DEX spot - oracle NAV| in bps => force de-risk. */
export const PEG_DE_RISK_BPS = 100; // 1.0%

/**
 * Max age in seconds for the oracle range end before NAV is treated as stale.
 * If now > rangeEnd, the oracle has no valid rate.
 */
export const ORACLE_MAX_AGE = 100_800; // ~28 hours

/**
 * USDY reserve backing ratio (permitted assets / token principal, from the daily
 * Ondo/Ankura attestation), in bps, below which the issuer is treated as
 * under-collateralized => force de-risk (USDY -> 0). Normal is ~10_055 (100.55%);
 * this 9_900 (99%) floor leaves a 1% buffer against measurement/timing noise so only
 * a genuine reserve shortfall trips it. Deterministic backstop — independent of, and
 * un-loosenable by, the LLM.
 */
export const USDY_MIN_COLLATERAL_BPS = 9_900; // 99%

/** Warn when within this many seconds of the oracle's configured range end. */
export const ORACLE_RANGE_END_BUFFER = 86_400; // 24 hours
