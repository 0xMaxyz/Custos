// Merge the agent's live /snapshot metrics into the dashboard's vault view.
//
// TVL, share price, allocation, position and kill-switch are read on-chain
// (useVaultData). APY, peg deviation, USDY NAV/spot and the oracle range end are
// agent-computed (off-chain) and arrive via useInsightsData()'s /snapshot. When a
// live snapshot is present we overlay those fields; otherwise the vault view is
// returned unchanged (callers surface an "agent offline" state for a live vault).

import type { VaultState, WeightsBps } from "./data";
import type { InsightsSnapshot } from "./useInsightsData";

/**
 * Blended APY (bps) = the bucket APYs weighted by the live allocation. Only USDY
 * and Aave earn; IDLE and AUSD are treated as 0%. Weights are bps (sum 10_000).
 */
export function blendedApyBps(weights: WeightsBps, usdyApyBps: number, aaveApyBps: number): number {
  const weighted = weights.USDY * usdyApyBps + weights.AAVE * aaveApyBps;
  return Math.round(weighted / 10_000);
}

/**
 * Overlay live agent metrics onto a vault view. No-op when the snapshot isn't
 * live, so a fresh/offline agent never injects stale numbers — the caller decides
 * whether to show the vault's own (fixture/demo) values or an "unavailable" state.
 */
export function mergeSnapshotIntoVault(vault: VaultState, snap: InsightsSnapshot): VaultState {
  if (!snap.live) return vault;
  return {
    ...vault,
    blendedApyBps: blendedApyBps(vault.weightsBps, snap.usdyImpliedApyBps, snap.aaveUsdcSupplyApyBps),
    usdyImpliedApyBps: snap.usdyImpliedApyBps,
    aaveUsdcSupplyApyBps: snap.aaveUsdcSupplyApyBps,
    usdyOracleNavUsdc: snap.usdyOracleNavUsdc,
    usdyDexSpotUsdc: snap.usdyDexSpotUsdc,
    pegDeviationBps: snap.pegDeviationBps,
    ...(snap.oracleRangeEnd ? { oracleRangeEnd: snap.oracleRangeEnd } : {}),
  };
}
