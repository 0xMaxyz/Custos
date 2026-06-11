/**
 * Agent-card builder + pin tests (task 4.2). No network — IPFS pin is mocked.
 */
import { describe, it, expect, vi } from "vitest";
import { getAddress } from "viem";

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

const baseOpts = { wallet: WALLET, apiUrl: "https://agent.custos.example" };

describe("buildAgentCard", () => {
  it("builds a schema-valid card from config + opts", () => {
    const card = buildAgentCard(configWith(), baseOpts);
    expect(() => agentCardSchema.parse(card)).not.toThrow();
    expect(card.schemaVersion).toBe(1);
    expect(card.name).toBe("Custos");
    expect(card.vault).toBe(VAULT);
    expect(card.benchmark).toBe(BENCHMARK);
    expect(card.wallet).toBe(WALLET);
    expect(card.endpoints.api).toBe("https://agent.custos.example");
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
      dashboardUrl: "https://app.custos.example",
    });
    expect(card.endpoints.dashboard).toBe("https://app.custos.example");
  });

  it("omits the dashboard endpoint when not provided", () => {
    const card = buildAgentCard(configWith(), baseOpts);
    expect(card.endpoints.dashboard).toBeUndefined();
  });

  it("allows overriding name + description", () => {
    const card = buildAgentCard(configWith(), {
      ...baseOpts,
      name: "Custos (testnet)",
      description: "Test deployment.",
    });
    expect(card.name).toBe("Custos (testnet)");
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

  describe("sells (x402 offer)", () => {
    const PAY_TO = "0x4444444444444444444444444444444444444444";
    const ASSET = `0x${"a0".repeat(20)}`;
    const x402Env = { X402_PAY_TO: PAY_TO.toLowerCase(), X402_ASSET: ASSET };

    it("publishes the x402 offer when payTo + asset are configured", () => {
      const card = buildAgentCard(configWith(x402Env), baseOpts);
      expect(() => agentCardSchema.parse(card)).not.toThrow();
      expect(card.sells).toEqual({
        endpoint: "/risk-score",
        payTo: getAddress(PAY_TO), // EIP-55 checksummed
        asset: getAddress(ASSET),
        priceBaseUnits: "10000", // config default, bigint → decimal string
      });
    });

    it("prefers the resolved payee (opts.x402PayTo) over raw config", () => {
      const owner = "0x5555555555555555555555555555555555555555";
      const card = buildAgentCard(configWith(x402Env), { ...baseOpts, x402PayTo: owner });
      expect(card.sells?.payTo).toBe(owner);
    });

    it("carries a configured price as base units", () => {
      const card = buildAgentCard(configWith({ ...x402Env, X402_PRICE_BASE_UNITS: "250000" }), baseOpts);
      expect(card.sells?.priceBaseUnits).toBe("250000");
    });

    it("omits sells when x402 is not configured (schemaVersion stays 1)", () => {
      const card = buildAgentCard(configWith(), baseOpts);
      expect(card.sells).toBeUndefined();
      expect(card.schemaVersion).toBe(1);
      expect(() => agentCardSchema.parse(card)).not.toThrow();
    });

    it("omits sells when only the asset is set (no payee resolved)", () => {
      const card = buildAgentCard(configWith({ X402_ASSET: ASSET }), baseOpts);
      expect(card.sells).toBeUndefined();
    });
  });
});

describe("pinAgentCard", () => {
  it("returns a data: URI + hash when no IPFS backend is configured", async () => {
    const result = await pinAgentCard(configWith(), baseOpts);
    expect(result.uri).toMatch(/^data:application\/json;base64,/);
    expect(result.rationaleHash).toMatch(/^0x[0-9a-f]{64}$/);

    // The data URI should decode back to a schema-valid card (mirrors ROADMAP §4.2:
    // "fetched tokenURI JSON validates against the expected schema" — full parse,
    // not just spot fields).
    const decoded = Buffer.from(result.uri.split(",")[1]!, "base64").toString("utf-8");
    const parsed = agentCardSchema.parse(JSON.parse(decoded));
    expect(parsed.vault).toBe(VAULT);
    expect(parsed.name).toBe("Custos");
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
