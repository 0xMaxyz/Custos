import { describe, it, expect } from "vitest";
import { mantleMainnet, mantleTestnet, supportedChains, DEFAULT_CHAIN } from "./chains";
import { MANTLE_MAINNET_CHAIN_ID, MANTLE_TESTNET_CHAIN_ID } from "@custos/shared";

describe("Mantle chain config", () => {
  it("uses the canonical Mantle chain ids", () => {
    expect(mantleMainnet.id).toBe(MANTLE_MAINNET_CHAIN_ID);
    expect(mantleMainnet.id).toBe(5000);
    expect(mantleTestnet.id).toBe(MANTLE_TESTNET_CHAIN_ID);
    expect(mantleTestnet.id).toBe(5003);
  });

  it("is Mantle-only — exactly two supported chains", () => {
    expect(supportedChains).toHaveLength(2);
    expect(supportedChains.map((c) => c.id).sort()).toEqual([5000, 5003]);
  });

  it("configures an http RPC endpoint for each chain", () => {
    expect(mantleMainnet.rpcUrls.default.http[0]).toMatch(/^https?:\/\//);
    expect(mantleTestnet.rpcUrls.default.http[0]).toMatch(/^https?:\/\//);
  });

  it("defaults to mainnet now that MAINNET_DEPLOYMENT is populated", () => {
    // Mainnet (5000) has a committed deployment, so DEFAULT_CHAIN is mantleMainnet.
    // The test will need updating if the mainnet deployment is ever cleared/reset.
    expect(DEFAULT_CHAIN.id).toBe(5000);
  });
});
