import { describe, it, expect, vi } from "vitest";

import { OneDeltaClient, type FetchLike } from "./oneDelta.js";
import { loadConfig } from "../config.js";

const config = loadConfig({
  MANTLE_RPC_URL: "https://rpc.mantle.xyz",
  ONEDELTA_BASE_URL: "https://api.1delta.io",
  ONEDELTA_API_KEY: "test-key",
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe("OneDeltaClient", () => {
  it("parses a valid Aave USDC market", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ supplyApyBps: 380, utilizationBps: 7400 }),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    const market = await client.getAaveUsdcMarket();
    expect(market).toEqual({ supplyApyBps: 380, utilizationBps: 7400 });
  });

  it("sends the bearer token when an api key is configured", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ supplyApyBps: 380, utilizationBps: 7400 }),
    );
    const client = new OneDeltaClient(config, { fetchImpl });
    await client.getAaveUsdcMarket();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.headers?.authorization).toBe("Bearer test-key");
  });

  it("rejects a malformed Aave market shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ supplyApyBps: -5 })) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    await expect(client.getAaveUsdcMarket()).rejects.toThrow();
  });

  it("throws on a non-ok HTTP response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 503)) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    await expect(client.getAaveUsdcMarket()).rejects.toThrow(/HTTP 503/);
  });

  it("parses a valid DEX spot into a bigint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ spotUsdc18: "1081000000000000000" }),
    ) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    expect(await client.getUsdyDexSpotUsdc()).toBe(1_081_000_000_000_000_000n);
  });

  it("returns 0n when the DEX spot shape is invalid", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ notSpot: true })) as unknown as FetchLike;
    const client = new OneDeltaClient(config, { fetchImpl });
    expect(await client.getUsdyDexSpotUsdc()).toBe(0n);
  });

  it("omits the auth header when no api key is set", async () => {
    const noKey = loadConfig({ MANTLE_RPC_URL: "https://rpc.mantle.xyz" });
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ supplyApyBps: 380, utilizationBps: 7400 }),
    );
    const client = new OneDeltaClient(noKey, { fetchImpl });
    await client.getAaveUsdcMarket();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.headers?.authorization).toBeUndefined();
  });
});
