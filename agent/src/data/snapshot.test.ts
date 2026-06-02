import { describe, it, expect, vi } from "vitest";
import { Bucket } from "@custos/shared";

import { Snapshotter, emptyWeights, type SnapshotSources } from "./snapshot.js";
import { impliedApyBps } from "./readers.js";

function makeSources(overrides: Partial<SnapshotSources> = {}): SnapshotSources {
  return {
    oracle: async () => ({
      navUsdc: 1_080_000_000_000_000_000n,
      rangeEnd: 1_900_000_000,
      updatedAt: 1_700_000_000,
    }),
    usdyImpliedApyBps: async () => 452,
    aaveMarket: async () => ({ supplyApyBps: 380, utilizationBps: 7_400 }),
    usdyDexSpotUsdc: async () => 1_079_000_000_000_000_000n,
    ausdBackingRatioBps: async () => 10_000,
    vaultState: async () => ({
      totalAssetsUsdc: 30_000_000_000n,
      aaveWithdrawableUsdc: 21_000_000_000n,
      currentWeightsBps: {
        [Bucket.IDLE]: 300,
        [Bucket.AAVE]: 4_700,
        [Bucket.USDY]: 5_000,
        [Bucket.AUSD]: 0,
      },
    }),
    ...overrides,
  };
}

describe("Snapshotter", () => {
  it("assembles a full snapshot from its sources", async () => {
    const snapshotter = new Snapshotter(makeSources(), { now: () => 1_700_000_000_000 });
    const snap = await snapshotter.snapshot();
    expect(snap.usdyOracleNavUsdc).toBe(1_080_000_000_000_000_000n);
    expect(snap.usdyDexSpotUsdc).toBe(1_079_000_000_000_000_000n);
    expect(snap.aaveUsdcSupplyApyBps).toBe(380);
    expect(snap.usdyImpliedApyBps).toBe(452);
    expect(snap.totalAssetsUsdc).toBe(30_000_000_000n);
    expect(snap.currentWeightsBps[Bucket.USDY]).toBe(5_000);
    expect(snap.ausdBackingRatioBps).toBe(10_000);
    expect(snap.asOf).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("caches source reads within the ttl window", async () => {
    const oracle = vi.fn(async () => ({ navUsdc: 1n, rangeEnd: 0, updatedAt: 0 }));
    const snapshotter = new Snapshotter(makeSources({ oracle }), {
      ttlMs: 10_000,
      now: () => 1_000,
    });
    await snapshotter.snapshot();
    await snapshotter.snapshot();
    expect(oracle).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after invalidate()", async () => {
    const oracle = vi.fn(async () => ({ navUsdc: 1n, rangeEnd: 0, updatedAt: 0 }));
    const snapshotter = new Snapshotter(makeSources({ oracle }), { now: () => 1_000 });
    await snapshotter.snapshot();
    snapshotter.invalidate();
    await snapshotter.snapshot();
    expect(oracle).toHaveBeenCalledTimes(2);
  });
});

describe("emptyWeights", () => {
  it("is all idle and sums to 10000", () => {
    const w = emptyWeights();
    expect(w[Bucket.IDLE]).toBe(10_000);
    expect(w[Bucket.AAVE] + w[Bucket.USDY] + w[Bucket.AUSD]).toBe(0);
  });
});

describe("impliedApyBps", () => {
  it("annualizes NAV growth between two samples", () => {
    // 0.01% growth over 1 day → ~3.65% annualized = 365 bps
    const navOld = 1_000_000_000_000_000_000n;
    const navNew = 1_000_100_000_000_000_000n; // +0.01%
    const oneDay = 24 * 3_600;
    expect(impliedApyBps(navOld, navNew, oneDay)).toBe(365);
  });

  it("returns 0 for non-positive inputs", () => {
    expect(impliedApyBps(0n, 1n, 100)).toBe(0);
    expect(impliedApyBps(1n, 1n, 0)).toBe(0);
  });
});
