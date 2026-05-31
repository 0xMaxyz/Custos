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

  it("coerces numeric and bigint env values", () => {
    const cfg = loadConfig({ ...minimalEnv, AGENT_PORT: "9090", FORK_BLOCK_NUMBER: "12345678" });
    expect(cfg.agentPort).toBe(9090);
    expect(cfg.forkBlockNumber).toBe(12345678n);
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
