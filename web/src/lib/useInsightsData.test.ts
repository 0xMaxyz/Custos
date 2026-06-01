import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSnapshot, fixtureSnapshot } from "./useInsightsData";

const LIVE_CTX = {
  asOf: "2026-06-01T12:00:00.000Z",
  pegDeviationBps: 35,
  usdyOracleNavUsdc: "1.0832",
  usdyDexSpotUsdc: "1.0810",
  usdyImpliedApyBps: 452,
  aaveUsdcSupplyApyBps: 390,
  aaveUtilizationBps: 7_600,
  aaveWithdrawableUsdc: "18000.00",
  oracleRangeEnd: "2026-07-01T00:00:00.000Z",
  ausdBackingRatioBps: 9_950,
};

describe("fixtureSnapshot (demo fallback)", () => {
  it("returns non-live data with sane defaults", () => {
    const snap = fixtureSnapshot();
    expect(snap.live).toBe(false);
    expect(snap.pegDeviationBps).toBeGreaterThanOrEqual(0);
    expect(snap.aaveWithdrawableUsdc).not.toBe("0.00");
    expect(snap.oracleRangeEnd).toBeDefined();
  });
});

describe("fetchSnapshot (live mapping)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps a successful /snapshot response into live metrics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => LIVE_CTX }));
    const snap = await fetchSnapshot();
    expect(snap.live).toBe(true);
    expect(snap.pegDeviationBps).toBe(35);
    expect(snap.aaveWithdrawableUsdc).toBe("18000.00");
    expect(snap.oracleRangeEnd).toBe("2026-07-01T00:00:00.000Z");
    expect(snap.ausdBackingRatioBps).toBe(9_950);
  });

  it("omits oracleRangeEnd when the agent returns an empty string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...LIVE_CTX, oracleRangeEnd: "" }) }),
    );
    const snap = await fetchSnapshot();
    expect(snap.oracleRangeEnd).toBeUndefined();
  });

  it("throws on a non-ok response (error path)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(fetchSnapshot()).rejects.toThrow("/snapshot 503");
  });
});
