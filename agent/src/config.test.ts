import { describe, it, expect } from "vitest";

import { loadConfig, tryLoadConfig, type EnvRecord } from "./config.js";

const minimalEnv: EnvRecord = {
  MANTLE_RPC_URL: "https://rpc.mantle.xyz",
};

describe("loadConfig", () => {
  it("loads with only the required RPC url and applies defaults", () => {
    const cfg = loadConfig(minimalEnv);
    expect(cfg.mantleRpcUrl).toBe("https://rpc.mantle.xyz");
    expect(cfg.anthropicModel).toBe("claude-haiku-4-5-20251001");
    expect(cfg.oneDeltaBaseUrl).toBe("https://api.1delta.io");
    expect(cfg.agentPort).toBe(8080);
    expect(cfg.agentLogLevel).toBe("info");
    expect(cfg.allocatorPrivateKey).toBeUndefined();
  });

  it("throws when the required RPC url is missing", () => {
    expect(() => loadConfig({})).toThrow();
  });

  it("rejects an invalid RPC url", () => {
    expect(() => loadConfig({ MANTLE_RPC_URL: "not-a-url" })).toThrow();
  });

  it("treats empty strings as unset (optional fields stay undefined)", () => {
    const cfg = loadConfig({ ...minimalEnv, ANTHROPIC_API_KEY: "", ALLOCATOR_PRIVATE_KEY: "" });
    expect(cfg.anthropicApiKey).toBeUndefined();
    expect(cfg.allocatorPrivateKey).toBeUndefined();
  });

  it("coerces numeric env values", () => {
    const cfg = loadConfig({ ...minimalEnv, AGENT_PORT: "9090" });
    expect(cfg.agentPort).toBe(9090);
  });

  it("defaults TX_RECEIPT_TIMEOUT_MS to 120000 and coerces overrides", () => {
    expect(loadConfig(minimalEnv).txReceiptTimeoutMs).toBe(120_000);
    expect(loadConfig({ ...minimalEnv, TX_RECEIPT_TIMEOUT_MS: "60000" }).txReceiptTimeoutMs).toBe(60_000);
  });

  it("accepts a well-formed allocator private key", () => {
    const key = `0x${"ab".repeat(32)}`;
    const cfg = loadConfig({ ...minimalEnv, ALLOCATOR_PRIVATE_KEY: key });
    expect(cfg.allocatorPrivateKey).toBe(key);
  });

  it("rejects a malformed private key", () => {
    expect(() => loadConfig({ ...minimalEnv, ALLOCATOR_PRIVATE_KEY: "0xdead" })).toThrow();
  });

  it("rejects an out-of-range log level", () => {
    expect(() => loadConfig({ ...minimalEnv, AGENT_LOG_LEVEL: "verbose" })).toThrow();
  });

  it("parses X402_SETTLE_ONCHAIN as a strict boolean (default false; only 'true' is true)", () => {
    expect(loadConfig(minimalEnv).x402SettleOnChain).toBe(false); // default
    expect(loadConfig({ ...minimalEnv, X402_SETTLE_ONCHAIN: "true" }).x402SettleOnChain).toBe(true);
    expect(loadConfig({ ...minimalEnv, X402_SETTLE_ONCHAIN: "TRUE" }).x402SettleOnChain).toBe(true);
    // Any non-"true" string is false — never accidentally enables on-chain settlement.
    expect(loadConfig({ ...minimalEnv, X402_SETTLE_ONCHAIN: "false" }).x402SettleOnChain).toBe(false);
    expect(loadConfig({ ...minimalEnv, X402_SETTLE_ONCHAIN: "1" }).x402SettleOnChain).toBe(false);
  });

  it("requires X402_ASSET when X402_PAY_TO is set", () => {
    const payTo = `0x${"be".repeat(20)}`;
    expect(() => loadConfig({ ...minimalEnv, X402_PAY_TO: payTo })).toThrow();
    expect(
      loadConfig({ ...minimalEnv, X402_PAY_TO: payTo, X402_ASSET: `0x${"a0".repeat(20)}` }).x402PayTo,
    ).toBe(payTo);
  });

  it("requires X402_MAX_PRICE_BASE_UNITS when X402_PREMIUM_FEED_URL is set (N1)", () => {
    const feedEnv = { ...minimalEnv, X402_PREMIUM_FEED_URL: "https://feed.example/premium" };
    // Fail-closed: a paid feed with no spend ceiling is rejected at startup.
    expect(() => loadConfig(feedEnv)).toThrow();
    const cfg = loadConfig({ ...feedEnv, X402_MAX_PRICE_BASE_UNITS: "50000" });
    expect(cfg.x402MaxPriceBaseUnits).toBe(50_000n);
  });

  it("leaves X402_MAX_PRICE_BASE_UNITS optional when no premium feed is set", () => {
    expect(loadConfig(minimalEnv).x402MaxPriceBaseUnits).toBeUndefined();
  });
});

describe("tryLoadConfig", () => {
  it("returns ok with config on success", () => {
    const result = tryLoadConfig(minimalEnv);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.mantleRpcUrl).toBe("https://rpc.mantle.xyz");
  });

  it("returns a ZodError on failure instead of throwing", () => {
    const result = tryLoadConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.length).toBeGreaterThan(0);
  });
});
