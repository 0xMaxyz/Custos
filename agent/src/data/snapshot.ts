import { Bucket } from "@custos/shared";

import type { MarketSnapshot, WeightsBps } from "../types.js";
import { TtlCache } from "./cache.js";

/**
 * Snapshot assembly. `Snapshotter` orchestrates the individual data sources
 * (oracle, 1delta market data, vault state) behind a TTL cache and returns the
 * `MarketSnapshot` the deterministic risk engine consumes.
 *
 * Sources are injected via {@link SnapshotSources} so the orchestration is fully
 * unit-testable with stubs. The real wiring is exercised by the RPC-gated
 * integration test in `pipeline.fork.test.ts` (skipped when MANTLE_RPC_URL is unset).
 */

export interface SnapshotSources {
  /**
   * USDY oracle NAV (USDC per USDY, 18-dec) + range end (unix sec, 0 if none) +
   * the USDY-implied APY (bps) derived from successive NAV samples. NAV is read
   * once here and feeds both the peg and APY fields (no second oracle read).
   */
  readonly oracle: () => Promise<{ navUsdc: bigint; rangeEnd: number; updatedAt: number; impliedApyBps: number }>;
  /** Aave USDC supply APY (bps) + utilization (bps). */
  readonly aaveMarket: () => Promise<{ supplyApyBps: number; utilizationBps: number }>;
  /**
   * USDY/USDC DEX spot (USDC per USDY, 18-dec), 0n if unavailable. Receives the
   * oracle NAV so the resolver can run the cheap (RPC-free) price feed routinely and
   * only escalate to the precise (RPC-on-1delta) swap/spot quote near the peg warn
   * band — see the two-tier resolver in pipeline.ts.
   */
  readonly usdyDexSpotUsdc: (oracleNavUsdc: bigint) => Promise<bigint>;
  /** AUSD proof-of-reserves backing ratio (bps); 0 if unavailable. */
  readonly ausdBackingRatioBps: () => Promise<number>;
  /** Vault state: TVL, Aave-withdrawable, and current weights. */
  readonly vaultState: () => Promise<{
    totalAssetsUsdc: bigint;
    aaveWithdrawableUsdc: bigint;
    currentWeightsBps: WeightsBps;
  }>;
}

export interface SnapshotterOptions {
  /** Default cache TTL in ms (oracle/vault/ausd). Default 15s. */
  readonly ttlMs?: number;
  /** TTL for the USDY DEX spot. Default 30s — fewer 1delta peg quotes (#2). */
  readonly dexSpotTtlMs?: number;
  /** TTL for the (slow-moving, RPC-free) Aave market data. Default 5min (#3). */
  readonly marketTtlMs?: number;
  /** Clock injection for deterministic tests. */
  readonly now?: () => number;
}

const KEY = {
  oracle: "oracle",
  aave: "aaveMarket",
  dexSpot: "usdyDexSpot",
  ausdPor: "ausdPor",
  vault: "vaultState",
} as const;

export class Snapshotter {
  private readonly sources: SnapshotSources;
  private readonly cache: TtlCache;
  private readonly now: () => number;
  private readonly dexSpotTtlMs: number;
  private readonly marketTtlMs: number;

  constructor(sources: SnapshotSources, options: SnapshotterOptions = {}) {
    this.sources = sources;
    this.now = options.now ?? Date.now;
    this.cache = new TtlCache({ defaultTtlMs: options.ttlMs ?? 15_000, now: this.now });
    this.dexSpotTtlMs = options.dexSpotTtlMs ?? 30_000;
    this.marketTtlMs = options.marketTtlMs ?? 300_000;
  }

  // The DEX spot resolver needs the oracle NAV (to decide cheap vs precise), so the
  // oracle is fetched first; both go through the cache so repeated calls coalesce.
  private dexSpot(oracleNavUsdc: bigint): Promise<bigint> {
    return this.cache.getOrSet(KEY.dexSpot, () => this.sources.usdyDexSpotUsdc(oracleNavUsdc), this.dexSpotTtlMs);
  }

  /** Assemble a full {@link MarketSnapshot}, fetching missing parts through the cache. */
  async snapshot(): Promise<MarketSnapshot> {
    const oracle = await this.cache.getOrSet(KEY.oracle, this.sources.oracle);
    const [aave, dexSpot, ausdBackingRatioBps, vault] = await Promise.all([
      this.cache.getOrSet(KEY.aave, this.sources.aaveMarket, this.marketTtlMs),
      this.dexSpot(oracle.navUsdc),
      this.cache.getOrSet(KEY.ausdPor, this.sources.ausdBackingRatioBps),
      this.cache.getOrSet(KEY.vault, this.sources.vaultState),
    ]);

    return {
      asOf: new Date(this.now()).toISOString(),
      usdyOracleNavUsdc: oracle.navUsdc,
      usdyDexSpotUsdc: dexSpot,
      oracleUpdatedAt: oracle.updatedAt,
      oracleRangeEnd: oracle.rangeEnd,
      usdyImpliedApyBps: oracle.impliedApyBps,
      aaveUsdcSupplyApyBps: aave.supplyApyBps,
      aaveUtilizationBps: aave.utilizationBps,
      aaveWithdrawableUsdc: vault.aaveWithdrawableUsdc,
      totalAssetsUsdc: vault.totalAssetsUsdc,
      currentWeightsBps: vault.currentWeightsBps,
      ausdBackingRatioBps,
    };
  }

  /**
   * Cheap peg/oracle inputs for the breach-detection poll (#3) — only the oracle
   * NAV/range and the DEX spot, NOT the vault state. These are exactly the inputs
   * to `forceDeRisk` (peg deviation + oracle staleness), so the 30s poll can detect
   * a breach without the full ~vault-read snapshot. Reads go through the same cache,
   * so a follow-up full `snapshot()` reuses them rather than re-fetching.
   */
  async pegInputs(): Promise<{
    usdyOracleNavUsdc: bigint;
    usdyDexSpotUsdc: bigint;
    oracleRangeEnd: number;
    oracleUpdatedAt: number;
  }> {
    const oracle = await this.cache.getOrSet(KEY.oracle, this.sources.oracle);
    const dexSpot = await this.dexSpot(oracle.navUsdc);
    return {
      usdyOracleNavUsdc: oracle.navUsdc,
      usdyDexSpotUsdc: dexSpot,
      oracleRangeEnd: oracle.rangeEnd,
      oracleUpdatedAt: oracle.updatedAt,
    };
  }

  /** Force the next snapshot to re-fetch every source. */
  invalidate(): void {
    this.cache.clear();
  }
}

/** Convenience: an all-IDLE weights record (e.g. empty vault). */
export function emptyWeights(): WeightsBps {
  return {
    [Bucket.IDLE]: 10_000,
    [Bucket.AAVE]: 0,
    [Bucket.USDY]: 0,
    [Bucket.AUSD]: 0,
  };
}
