import { describe, it, expect } from "vitest";
import { ERC8004, MANTLE_MAINNET_CHAIN_ID } from "./addresses.js";
import { TOKENS } from "./tokens.js";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

describe("shared constants", () => {
  it("uses Mantle mainnet chain id 5000", () => {
    expect(MANTLE_MAINNET_CHAIN_ID).toBe(5000);
  });

  it("has well-formed ERC-8004 registry addresses", () => {
    for (const net of [ERC8004.mainnet, ERC8004.testnet]) {
      expect(net.identityRegistry.address).toMatch(ADDR_RE);
      expect(net.reputationRegistry.address).toMatch(ADDR_RE);
    }
  });

  it("has correct stablecoin decimals for the buckets", () => {
    expect(TOKENS.USDC.decimals).toBe(6);
    expect(TOKENS.AUSD.decimals).toBe(6);
    expect(TOKENS.USDY.decimals).toBe(18);
    for (const t of Object.values(TOKENS)) {
      expect(t.address).toMatch(ADDR_RE);
    }
  });
});
