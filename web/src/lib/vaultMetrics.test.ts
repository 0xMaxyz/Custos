import { describe, it, expect } from "vitest";
import { blendedApyBps, mergeSnapshotIntoVault } from "./vaultMetrics";
import { vault as vaultFixture } from "./data";
import { fixtureSnapshot, type InsightsSnapshot } from "./useInsightsData";

const liveSnap: InsightsSnapshot = {
  ...fixtureSnapshot(),
  live: true,
  pegDeviationBps: 35,
  usdyOracleNavUsdc: "1.0900",
  usdyDexSpotUsdc: "1.0862",
  usdyImpliedApyBps: 500,
  aaveUsdcSupplyApyBps: 300,
  oracleRangeEnd: "2026-09-01T00:00:00Z",
};

describe("blendedApyBps", () => {
  it("weights only USDY and Aave by allocation", () => {
    // 50% USDY @5% + 47% Aave @3% + 3% idle = 0.5*500 + 0.47*300 = 250 + 141 = 391
    const w = { IDLE: 300, AAVE: 4700, USDY: 5000, AUSD: 0 };
    expect(blendedApyBps(w, 500, 300)).toBe(391);
  });

  it("is 0 for an empty allocation", () => {
    expect(blendedApyBps({ IDLE: 0, AAVE: 0, USDY: 0, AUSD: 0 }, 500, 300)).toBe(0);
  });

  it("ignores IDLE and AUSD (they earn 0%)", () => {
    expect(blendedApyBps({ IDLE: 5000, AAVE: 0, USDY: 0, AUSD: 5000 }, 500, 300)).toBe(0);
  });
});

describe("mergeSnapshotIntoVault", () => {
  it("overlays APY/peg/oracle from a live snapshot and recomputes blended APY", () => {
    const v = { ...vaultFixture, weightsBps: { IDLE: 0, AAVE: 5000, USDY: 5000, AUSD: 0 } };
    const merged = mergeSnapshotIntoVault(v, liveSnap);
    expect(merged.usdyImpliedApyBps).toBe(500);
    expect(merged.aaveUsdcSupplyApyBps).toBe(300);
    expect(merged.pegDeviationBps).toBe(35);
    expect(merged.usdyOracleNavUsdc).toBe("1.0900");
    expect(merged.oracleRangeEnd).toBe("2026-09-01T00:00:00Z");
    expect(merged.blendedApyBps).toBe(400); // 0.5*500 + 0.5*300
    // on-chain fields are untouched
    expect(merged.tvlUsdc).toBe(v.tvlUsdc);
    expect(merged.weightsBps).toEqual(v.weightsBps);
  });

  it("is a no-op when the snapshot is not live", () => {
    const offline = { ...fixtureSnapshot(), live: false };
    expect(mergeSnapshotIntoVault(vaultFixture, offline)).toEqual(vaultFixture);
  });
});
