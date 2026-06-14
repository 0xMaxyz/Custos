import { describe, it, expect, vi } from "vitest";

import { resolveDexSpot } from "./pipeline.js";
import { OneDeltaClient, type FetchLike } from "./data/oneDelta.js";
import { loadConfig } from "./config.js";

const config = loadConfig({
  MANTLE_RPC_URL: "https://rpc.mantle.xyz",
  ONEDELTA_BASE_URL: "https://portal.1delta.io",
  ONEDELTA_API_KEY: "test-key",
});

const USDY = "0x5be26527e817998a7206475496fde1e68957c5a6";
const USDC = "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** Route by endpoint: token/prices (cheap) vs actions/swap/spot (precise quote). */
function makeFetch(opts: { usdy?: number; usdc?: number; spotOut?: number }) {
  return vi.fn(async (url: string) => {
    if (url.includes("/v1/data/token/prices")) {
      const items: Record<string, number> = {};
      if (opts.usdy !== undefined) items[USDY] = opts.usdy;
      if (opts.usdc !== undefined) items[USDC] = opts.usdc;
      return jsonResponse({ success: true, data: { items } });
    }
    // swap/spot quote-only
    return jsonResponse({
      success: true,
      data: { currencyOut: { decimals: 6 }, quotes: [{ tradeOutput: opts.spotOut ?? 1.08 }] },
      actions: null,
    });
  }) as unknown as FetchLike;
}

const NAV = 1_100_000_000_000_000_000n; // 1.10 USDC per USDY (18-dec)

describe("resolveDexSpot (two-tier peg price)", () => {
  it("calm market: uses the cheap token/prices price, never calls swap/spot", async () => {
    const fetchImpl = makeFetch({ usdy: 1.1, usdc: 1.0, spotOut: 999 });
    const client = new OneDeltaClient(config, { fetchImpl });
    const price = await resolveDexSpot(client, NAV);

    // ~1.10 (cheap price, ~0bps deviation); range avoids JS float-to-fixed noise.
    expect(price).toBeGreaterThan(1_099_900_000_000_000_000n);
    expect(price).toBeLessThan(1_100_100_000_000_000_000n);
    const calledSpot = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes("/v1/actions/swap/spot"),
    );
    expect(calledSpot).toBe(false); // no expensive RPC-on-1delta quote in calm markets
  });

  it("near depeg: escalates to the precise swap/spot quote", async () => {
    // Cheap price 1.085 vs NAV 1.10 → ~136bps deviation, well past PEG_WARN_BPS (30).
    const fetchImpl = makeFetch({ usdy: 1.085, usdc: 1.0, spotOut: 1.08 });
    const client = new OneDeltaClient(config, { fetchImpl });
    const price = await resolveDexSpot(client, NAV);

    expect(price).toBe(1_080_000_000_000_000_000n); // authoritative precise quote
    const calledSpot = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).includes("/v1/actions/swap/spot"),
    );
    expect(calledSpot).toBe(true);
  });

  it("cheap price unavailable: falls back to the precise quote", async () => {
    const fetchImpl = makeFetch({ spotOut: 1.079 }); // token/prices returns no items
    const client = new OneDeltaClient(config, { fetchImpl });
    const price = await resolveDexSpot(client, NAV);
    expect(price).toBe(1_079_000_000_000_000_000n);
  });
});
