import { describe, it, expect, vi, afterEach } from "vitest";
import { swapQuoteAvailable, fetchSwapQuote } from "./swapQuote";

// VITE_AGENT_API_URL is unset in the test env, so the endpoint is unavailable.
describe("swapQuote (unavailable path)", () => {
  it("reports unavailable without VITE_AGENT_API_URL", () => {
    expect(swapQuoteAvailable).toBe(false);
  });

  it("throws a clear error when the agent API is not configured", async () => {
    await expect(fetchSwapQuote({ bucket: "USDY", side: "deposit", usdcAmount: "1000000" })).rejects.toThrow(/not configured/i);
  });
});

describe("swapQuote (live path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts to /swap/quote and returns the parsed quote", async () => {
    vi.stubEnv("VITE_AGENT_API_URL", "http://agent.test");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        router: "0x5C019a146758287C614FE654CaEC1ba1CaF05F4E",
        calldata: "0xabcdef",
        amountOut: "990000",
        bucketIndex: 2,
        usdyDexSpotUsdc: "1081000000000000000",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { fetchSwapQuote: liveFetch } = await import("./swapQuote.js");

    const res = await liveFetch({ bucket: "USDY", side: "deposit", usdcAmount: "5000000" });
    expect(res.bucketIndex).toBe(2);
    expect(res.calldata).toBe("0xabcdef");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://agent.test/swap/quote");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ bucket: "USDY", side: "deposit", usdcAmount: "5000000" });
  });

  it("surfaces the server error message on a non-200", async () => {
    vi.stubEnv("VITE_AGENT_API_URL", "http://agent.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: "Could not fetch a swap route right now — try again shortly." }),
    }));
    vi.resetModules();
    const { fetchSwapQuote: liveFetch } = await import("./swapQuote.js");

    await expect(liveFetch({ bucket: "AUSD", side: "withdraw", usdcAmount: "1000000" })).rejects.toThrow(/swap route/i);
  });
});
