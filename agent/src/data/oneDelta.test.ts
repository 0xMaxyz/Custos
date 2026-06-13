import { describe, it, expect, vi } from "vitest";

import { OneDeltaClient, type FetchLike } from "./oneDelta.js";
import { loadConfig } from "../config.js";

const config = loadConfig({
  MANTLE_RPC_URL: "https://rpc.mantle.xyz",
  ONEDELTA_BASE_URL: "https://portal.1delta.io",
  ONEDELTA_API_KEY: "test-key",
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

// ── Fixtures mirroring the live v1 API shapes ────────────────────────────────

/** GET /v1/data/lending/pools — depositRate is a percent, utilization is 0..1. */
function lendingPools(depositRate: number, utilization: number) {
  return { success: true, data: { items: [{ depositRate, utilization }] } };
}

/** GET /v1/actions/swap/spot — built (account set): actions.alternatives present. */
function spotBuild(opts: {
  to: string;
  data?: string;
  value?: string;
  transactions?: unknown[];
  tradeOutput?: number;
  decimals?: number;
}) {
  return {
    success: true,
    data: {
      currencyOut: { decimals: opts.decimals ?? 6 },
      quotes: [{ aggregator: "Nordstern", tradeOutput: opts.tradeOutput ?? 12.21 }],
    },
    actions: {
      transactions: opts.transactions ?? [],
      alternatives: [{ to: opts.to, data: opts.data ?? "0xabcd", value: opts.value ?? "0" }],
      permissions: [],
    },
  };
}

describe("OneDeltaClient", () => {
  // ── Aave market (/v1/data/lending/pools) ──────────────────────────────────

  it("derives Aave USDC supply APY + utilization bps from a pool", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(lendingPools(2.4813987, 0.7925354384275803)),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    expect(await client.getAaveUsdcMarket()).toEqual({ supplyApyBps: 248, utilizationBps: 7925 });
  });

  it("queries the lending-pools endpoint with the x-api-key header", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(lendingPools(2.5, 0.8)));
    const client = new OneDeltaClient(config, { fetchImpl });
    await client.getAaveUsdcMarket();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/v1/data/lending/pools");
    expect(url).toContain("lender=AAVE_V3");
    expect(init?.headers?.["x-api-key"]).toBe("test-key");
  });

  it("rejects a lending response with no pools", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, data: { items: [] } }),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    await expect(client.getAaveUsdcMarket()).rejects.toThrow();
  });

  it("throws on a non-ok HTTP response (with body, L4)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "rate limited" }, false, 429),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    await expect(client.getAaveUsdcMarket()).rejects.toThrow(/HTTP 429.*rate limited/);
  });

  // ── DEX spot (quote-only /v1/actions/swap/spot) ───────────────────────────

  it("derives an 18-dec USDY/USDC spot from a quote-only swap", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: { currencyOut: { decimals: 6 }, quotes: [{ tradeOutput: 1.081 }] },
        actions: null,
      }),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    expect(await client.getUsdyDexSpotUsdc()).toBe(1_081_000_000_000_000_000n);
  });

  it("returns 0n when the quote-only spot shape is invalid", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ notSpot: true })) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    expect(await client.getUsdyDexSpotUsdc()).toBe(0n);
  });

  // ── AUSD PoR — 1delta has no feed, always "unknown" (0) ───────────────────

  it("returns 0 (unknown) for AUSD backing — no 1delta PoR feed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    expect(await client.getAusdBackingRatioBps()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled(); // no HTTP — there is no endpoint
  });

  // ── Swap quote (/v1/actions/swap/spot, account set) ───────────────────────

  it("returns the best alternative's router + calldata", async () => {
    const router = "0x5c019a146758287c614fe654caec1ba1caf05f4e";
    const fetchImpl = vi.fn(async () =>
      jsonResponse(spotBuild({ to: router, data: "0xdeadbeef", tradeOutput: 12.21, decimals: 6 })),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    const q = await client.getSwapQuote("0xIN", "0xOUT", 11_000_000n, "0xADAPTER", 50);
    expect(q.router).toBe(router);
    expect(q.calldata).toBe("0xdeadbeef");
    expect(q.amountOut).toBe(12_210_000n); // 12.21 × 10^6
  });

  it("sends account+receiver=to and tradeType=0 for the swap build", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse(spotBuild({ to: "0x5c019a146758287c614fe654caec1ba1caf05f4e" })),
    );
    const client = new OneDeltaClient(config, { fetchImpl });
    await client.getSwapQuote("0xIN", "0xOUT", 11n, "0xADAPTER", 50);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/v1/actions/swap/spot");
    expect(url).toContain("account=0xADAPTER");
    expect(url).toContain("receiver=0xADAPTER");
    expect(url).toContain("tradeType=0");
  });

  it("throws when the swap returns pre-trade setup transactions", async () => {
    const setup = { to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0" };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        spotBuild({ to: "0x5c019a146758287c614fe654caec1ba1caf05f4e", transactions: [setup] }),
      ),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    await expect(client.getSwapQuote("0xIN", "0xOUT", 1n, "0xA", 50)).rejects.toThrow(
      /pre-trade setup/,
    );
  });

  it("throws on a quote-only (account-less) swap response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, data: { quotes: [] }, actions: null }),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    await expect(client.getSwapQuote("0xIN", "0xOUT", 1n, "0xA", 50)).rejects.toThrow(/no actions/);
  });

  it("throws on a non-zero native tx value (adapter forwards none)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(spotBuild({ to: "0x5c019a146758287c614fe654caec1ba1caf05f4e", value: "1000" })),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    await expect(client.getSwapQuote("0xIN", "0xOUT", 1n, "0xA", 50)).rejects.toThrow(/tx value/);
  });

  // ── Auth header ───────────────────────────────────────────────────────────

  it("omits the auth header when no api key is set", async () => {
    const noKey = loadConfig({ MANTLE_RPC_URL: "https://rpc.mantle.xyz" });
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(lendingPools(2.5, 0.8)));
    const client = new OneDeltaClient(noKey, { fetchImpl });
    await client.getAaveUsdcMarket();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.headers?.["x-api-key"]).toBeUndefined();
  });
});
