import type { Bucket, RiskLevel } from "@custos/shared";

/**
 * Domain types shared across the agent's pipeline:
 *   ingestion → deterministic risk engine → (LLM) → validator → signer.
 *
 * All bps values are integer basis points (1 bps = 0.01%).
 * All USDC amounts are bigint in 6-decimal base units unless a field name says
 * otherwise. Oracle/DEX prices are bigint in 18-decimal fixed point.
 */

// ── Allocation ────────────────────────────────────────────────────────────────

/** Target (or current) allocation weights, one entry per bucket, summing to 10000. */
export type WeightsBps = Record<Bucket, number>;

/** A proposed or realized allocation across the four buckets. */
export interface Allocation {
  /** Per-bucket weights in bps; must sum to 10000. */
  readonly weightsBps: WeightsBps;
}

// ── Risk flags & signals ──────────────────────────────────────────────────────

/**
 * Deterministic risk flags raised by the risk engine. `NONE` is used as the sole
 * entry when nothing is flagged (mirrors SPEC §3.1 `flags`).
 */
export type RiskFlag =
  | "NONE"
  | "PEG_WARN"
  | "PEG_BLOCK"
  | "PEG_DE_RISK"
  | "ORACLE_STALE"
  | "ORACLE_NEAR_RANGE_END"
  | "LOW_LIQUIDITY"
  | "AUSD_POR_WARN";

/** Severity buckets for a risk signal (SPEC §3.2). */
export type Severity = "LOW" | "MEDIUM" | "HIGH";

/** Categories of risk signal the agent can surface. */
export type SignalType = "PEG" | "ORACLE" | "LIQUIDITY" | "YIELD" | "ISSUER" | "REGULATORY";

/**
 * A single risk signal. When derived from unstructured evidence (LLM path),
 * `evidenceId` resolves to an item in the decision's evidence bundle.
 */
export interface RiskSignal {
  readonly type: SignalType;
  readonly severity: Severity;
  readonly summary: string;
  readonly evidenceId?: string;
}

// ── Market snapshot ───────────────────────────────────────────────────────────

/**
 * Fully-assembled market + risk inputs for one decision cycle. Produced by
 * `snapshot()` and consumed by the deterministic risk engine (and, downstream,
 * serialized into the LLM input of SPEC §3.1).
 *
 * Prices are 18-dec fixed point; USDC amounts are 6-dec base units.
 */
export interface MarketSnapshot {
  /** ISO-8601 timestamp the snapshot was assembled. */
  readonly asOf: string;
  /** USDY redemption NAV from the Ondo oracle (USDC per USDY, 18-dec). */
  readonly usdyOracleNavUsdc: bigint;
  /** USDY spot from the DEX (USDC per USDY, 18-dec); 0n if unavailable. */
  readonly usdyDexSpotUsdc: bigint;
  /** Unix seconds the oracle NAV was last updated; 0 if unknown. */
  readonly oracleUpdatedAt: number;
  /** Unix seconds the oracle's current range expires; 0 if unsupported. */
  readonly oracleRangeEnd: number;
  /** USDY-implied APY in bps (annualized NAV growth). */
  readonly usdyImpliedApyBps: number;
  /** Aave v3 USDC supply APY in bps. */
  readonly aaveUsdcSupplyApyBps: number;
  /** Aave v3 USDC reserve utilization in bps. */
  readonly aaveUtilizationBps: number;
  /** USDC instantly withdrawable from Aave (6-dec). */
  readonly aaveWithdrawableUsdc: bigint;
  /** Vault TVL in USDC (6-dec). */
  readonly totalAssetsUsdc: bigint;
  /** Current on-chain allocation weights. */
  readonly currentWeightsBps: WeightsBps;
  /**
   * AUSD proof-of-reserves backing ratio in bps (10000 = fully backed by reserves).
   * 0 means PoR is unavailable this cycle (treated as "unknown", not a breach).
   */
  readonly ausdBackingRatioBps: number;
}

// ── Risk engine output ────────────────────────────────────────────────────────

/**
 * Output of the deterministic risk engine: a candidate allocation plus the flags
 * and the guardrail ceiling that bounds the cycle. This is the floor the LLM may
 * only tighten — never loosen (SPEC §3.3).
 */
export interface RiskAssessment {
  /** Deterministic risk level (may be raised, never lowered, by the LLM). */
  readonly riskLevel: RiskLevel;
  /** Candidate target weights proposed deterministically. */
  readonly candidateWeightsBps: WeightsBps;
  /** Raised flags; `["NONE"]` when nothing is flagged. */
  readonly flags: RiskFlag[];
  /** Max USDY weight allowed this cycle (guardrail ceiling, after risk tightening). */
  readonly maxUsdyWeightBpsAllowed: number;
  /** True when conditions force an immediate de-risk out of USDY. */
  readonly forceDeRisk: boolean;
}

// ── Decision ──────────────────────────────────────────────────────────────────

/** Whether a decision is an ordinary rebalance or an emergency de-risk. */
export type DecisionKind = "REBALANCE" | "DERISK";

/**
 * A finalized decision ready to be hashed, pinned, and submitted on-chain.
 * `rationale` + `signals` (with resolved evidence) are hashed into `rationaleHash`
 * and bundled to IPFS as `decisionURI` before calling rebalance/deRisk.
 */
export interface Decision {
  readonly kind: DecisionKind;
  /** Final target weights (REBALANCE) — undefined for a pure de-risk. */
  readonly weightsBps?: WeightsBps;
  /** DEX spot to pass on-chain so the depeg guard can evaluate (18-dec). */
  readonly usdyDexSpotUsdc: bigint;
  readonly riskLevel: RiskLevel;
  readonly rationale: string;
  readonly signals: RiskSignal[];
}
