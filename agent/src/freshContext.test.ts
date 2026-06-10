/**
 * O7 — paid /risk-score freshness.
 *
 * The paid `/risk-score` path can't serve up-to-10s-stale cached risk data: during
 * a fast depeg, a stale "all clear" sold for money is unacceptable. `computeFreshContext`
 * re-snapshots when the cached context is older than the caller's `maxAgeMs`, and —
 * because the snapshotter has its OWN longer (~15s) source-read cache — calls
 * `invalidate()` first so the re-snapshot is genuinely fresh. The default-TTL callers
 * (`/ask`, `/snapshot`) keep the 10s behaviour.
 */
import { describe, it, expect, vi } from "vitest";
import { Bucket } from "@custos/shared";
import { computeFreshContext } from "./context.js";
import type { MarketSnapshot } from "./types.js";
import type { ExplainContext } from "./llm/explain.js";

const NOW = Math.floor(Date.now() / 1000);

function snap(): MarketSnapshot {
  return {
    asOf: new Date(NOW * 1000).toISOString(),
    usdyOracleNavUsdc: 1_080_000_000_000_000_000n,
    usdyDexSpotUsdc: 1_080_000_000_000_000_000n,
    oracleUpdatedAt: NOW - 3_600,
    oracleRangeEnd: NOW + 30 * 24 * 3_600,
    usdyImpliedApyBps: 452,
    aaveUsdcSupplyApyBps: 380,
    aaveUtilizationBps: 7_400,
    aaveWithdrawableUsdc: 21_000_000_000n,
    totalAssetsUsdc: 30_000_000_000n,
    currentWeightsBps: { [Bucket.IDLE]: 300, [Bucket.AAVE]: 4_700, [Bucket.USDY]: 5_000, [Bucket.AUSD]: 0 },
    ausdBackingRatioBps: 10_000,
  };
}

function makeSnapshotter() {
  const snapshot = vi.fn(async () => snap());
  const invalidate = vi.fn();
  return { snapshotter: { snapshot, invalidate }, snapshot, invalidate };
}

function fakeCache(at: number): { at: number; value: ExplainContext } {
  return { at, value: { riskLevel: "NORMAL", asOf: "cached" } as unknown as ExplainContext };
}

const RISK_SCORE_MAX_AGE_MS = 2_000;
const CONTEXT_TTL_MS = 10_000;

describe("computeFreshContext (O7)", () => {
  it("paid path: a 5s-stale cache is re-snapshotted (cache > 2s tolerance)", async () => {
    const { snapshotter, snapshot, invalidate } = makeSnapshotter();
    const now = 1_000_000;
    const out = await computeFreshContext(snapshotter, [], fakeCache(now - 5_000), RISK_SCORE_MAX_AGE_MS, now);

    // Re-snapshotted: snapshotter.invalidate() called first, then snapshot().
    expect(invalidate).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledOnce();
    // Returns a freshly-built context (not the cached placeholder), stamped at `now`.
    expect(out.value.asOf).not.toBe("cached");
    expect(out.cache.at).toBe(now);
  });

  it("paid path: a 1s-fresh cache is served as-is (within 2s tolerance, no re-snapshot)", async () => {
    const { snapshotter, snapshot, invalidate } = makeSnapshotter();
    const now = 1_000_000;
    const cache = fakeCache(now - 1_000);
    const out = await computeFreshContext(snapshotter, [], cache, RISK_SCORE_MAX_AGE_MS, now);

    expect(invalidate).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(out.value.asOf).toBe("cached");
    expect(out.cache).toBe(cache);
  });

  it("/snapshot path: a 5s-stale cache is STILL served under the 10s TTL (no re-snapshot)", async () => {
    const { snapshotter, snapshot, invalidate } = makeSnapshotter();
    const now = 1_000_000;
    const cache = fakeCache(now - 5_000);
    const out = await computeFreshContext(snapshotter, [], cache, CONTEXT_TTL_MS, now);

    // 5s < 10s TTL → the snapshot endpoint keeps coalescing.
    expect(invalidate).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(out.value.asOf).toBe("cached");
  });

  it("no cache: always re-snapshots and invalidates source cache first", async () => {
    const { snapshotter, snapshot, invalidate } = makeSnapshotter();
    const now = 1_000_000;
    const out = await computeFreshContext(snapshotter, [], undefined, RISK_SCORE_MAX_AGE_MS, now);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(out.cache.at).toBe(now);
  });
});
