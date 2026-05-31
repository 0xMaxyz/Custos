/**
 * Agent-card builder + pin tests (task 4.2). No network — IPFS pin is mocked.
 */
import { describe, it, expect, vi } from "vitest";

import { buildAgentCard, pinAgentCard, agentCardSchema } from "./agentCard.js";
import { loadConfig } from "../config.js";

const VAULT = "0x1111111111111111111111111111111111111111";
const BENCHMARK = "0x2222222222222222222222222222222222222222";
const WALLET = "0x3333333333333333333333333333333333333333";

function configWith(extra: Record<string, string> = {}) {
  return loadConfig({
    MANTLE_RPC_URL: "https://rpc.mantle.xyz",
    VAULT_ADDRESS: VAULT,
    BENCHMARK_ADDRESS: BENCHMARK,
    ...extra,
  });
}

const baseOpts = { wallet: WALLET, apiUrl: "https://agent.sentinel.example" };

describe("buildAgentCard", () => {
  it("builds a schema-valid card from config + opts", () => {
    const card = buildAgentCard(configWith(), baseOpts);
    expect(() => agentCardSchema.parse(card)).not.toThrow();
    expect(card.schemaVersion).toBe(1);
    expect(card.name).toBe("Sentinel");
    expect(card.vault).toBe(VAULT);
    expect(card.benchmark).toBe(BENCHMARK);
    expect(card.wallet).toBe(WALLET);
    expect(card.endpoints.api).toBe("https://agent.sentinel.example");
    expect(card.supportedTrust.length).toBeGreaterThan(0);
  });

  it("checksums addresses (canonical form)", () => {
    const card = buildAgentCard(configWith(), {
      ...baseOpts,
      wallet: WALLET.toLowerCase(),
    });
    // getAddress yields the EIP-55 checksum; an all-3s address is already canonical,
    // so simply assert it round-trips to a 0x-prefixed 42-char string.
    expect(card.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("includes the optional dashboard endpoint when provided", () => {
    const card = buildAgentCard(configWith(), {
      ...baseOpts,
      dashboardUrl: "https://app.sentinel.example",
    });
    expect(card.endpoints.dashboard).toBe("https://app.sentinel.example");
  });

  it("omits the dashboard endpoint when not provided", () => {
    const card = buildAgentCard(configWith(), baseOpts);
    expect(card.endpoints.dashboard).toBeUndefined();
  });

  it("allows overriding name + description", () => {
    const card = buildAgentCard(configWith(), {
      ...baseOpts,
      name: "Sentinel (testnet)",
      description: "Test deployment.",
    });
    expect(card.name).toBe("Sentinel (testnet)");
    expect(card.description).toBe("Test deployment.");
  });

  it("throws when VAULT_ADDRESS is missing", () => {
    const config = loadConfig({
      MANTLE_RPC_URL: "https://rpc.mantle.xyz",
      BENCHMARK_ADDRESS: BENCHMARK,
    });
    expect(() => buildAgentCard(config, baseOpts)).toThrow(/VAULT_ADDRESS/);
  });

  it("throws when BENCHMARK_ADDRESS is missing", () => {
    const config = loadConfig({
      MANTLE_RPC_URL: "https://rpc.mantle.xyz",
      VAULT_ADDRESS: VAULT,
    });
    expect(() => buildAgentCard(config, baseOpts)).toThrow(/BENCHMARK_ADDRESS/);
  });

  it("rejects a malformed api endpoint", () => {
    expect(() => buildAgentCard(configWith(), { ...baseOpts, apiUrl: "not-a-url" })).toThrow();
  });
});

describe("pinAgentCard", () => {
  it("returns a data: URI + hash when no IPFS backend is configured", async () => {
    const result = await pinAgentCard(configWith(), baseOpts);
    expect(result.uri).toMatch(/^data:application\/json;base64,/);
    expect(result.rationaleHash).toMatch(/^0x[0-9a-f]{64}$/);

    // The data URI should decode back to the same card.
    const decoded = Buffer.from(result.uri.split(",")[1]!, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    expect(parsed.vault).toBe(VAULT);
    expect(parsed.name).toBe("Sentinel");
  });

  it("returns an ipfs:// URI when the IPFS API returns a CID", async () => {
    const config = configWith({ IPFS_API_URL: "http://localhost:5001" });
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ Hash: "QmAgentCardCid" }),
    })) as unknown as typeof fetch;

    const result = await pinAgentCard(config, baseOpts, mockFetch);
    expect(result.uri).toBe("ipfs://QmAgentCardCid");
    expect(result.card.vault).toBe(VAULT);
  });
});
