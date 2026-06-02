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
  /** USDY oracle NAV (USDC per USDY, 18-dec) + range end (unix sec, 0 if none). */
  readonly oracle: () => Promise<{ navUsdc: bigint; rangeEnd: number; updatedAt: number }>;
  /** USDY-implied APY in bps. */
  readonly usdyImpliedApyBps: () => Promise<number>;
  /** Aave USDC supply APY (bps) + utilization (bps). */
  readonly aaveMarket: () => Promise<{ supplyApyBps: number; utilizationBps: number }>;
  /** USDY/USDC DEX spot (18-dec), 0n if unavailable. */
  readonly usdyDexSpotUsdc: () => Promise<bigint>;
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
  /** Cache TTL in ms for source reads within a cycle. Default 15s. */
  readonly ttlMs?: number;
  /** Clock injection for deterministic tests. */
  readonly now?: () => number;
}

const KEY = {
  oracle: "oracle",
  usdyApy: "usdyApy",
  aave: "aaveMarket",
  dexSpot: "usdyDexSpot",
  ausdPor: "ausdPor",
  vault: "vaultState",
} as const;

export class Snapshotter {
  private readonly sources: SnapshotSources;
  private readonly cache: TtlCache;
  private readonly now: () => number;

  constructor(sources: SnapshotSources, options: SnapshotterOptions = {}) {
    this.sources = sources;
    this.now = options.now ?? Date.now;
    this.cache = new TtlCache({ defaultTtlMs: options.ttlMs ?? 15_000, now: this.now });
  }

  /** Assemble a full {@link MarketSnapshot}, fetching missing parts through the cache. */
  async snapshot(): Promise<MarketSnapshot> {
    const [oracle, usdyImpliedApyBps, aave, dexSpot, ausdBackingRatioBps, vault] =
      await Promise.all([
        this.cache.getOrSet(KEY.oracle, this.sources.oracle),
        this.cache.getOrSet(KEY.usdyApy, this.sources.usdyImpliedApyBps),
        this.cache.getOrSet(KEY.aave, this.sources.aaveMarket),
        this.cache.getOrSet(KEY.dexSpot, this.sources.usdyDexSpotUsdc),
        this.cache.getOrSet(KEY.ausdPor, this.sources.ausdBackingRatioBps),
        this.cache.getOrSet(KEY.vault, this.sources.vaultState),
      ]);

    return {
      asOf: new Date(this.now()).toISOString(),
      usdyOracleNavUsdc: oracle.navUsdc,
      usdyDexSpotUsdc: dexSpot,
      oracleUpdatedAt: oracle.updatedAt,
      oracleRangeEnd: oracle.rangeEnd,
      usdyImpliedApyBps,
      aaveUsdcSupplyApyBps: aave.supplyApyBps,
      aaveUtilizationBps: aave.utilizationBps,
      aaveWithdrawableUsdc: vault.aaveWithdrawableUsdc,
      totalAssetsUsdc: vault.totalAssetsUsdc,
      currentWeightsBps: vault.currentWeightsBps,
      ausdBackingRatioBps,
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
