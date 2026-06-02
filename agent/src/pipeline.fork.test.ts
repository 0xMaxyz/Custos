import { describe, it, expect } from "vitest";

import { loadConfig } from "./config.js";
import { buildPipeline } from "./pipeline.js";
import { makeClients } from "./chain/clients.js";
import { readUsdyOracle } from "./data/readers.js";
import { PROTOCOLS, MANTLE_MAINNET_CHAIN_ID } from "@custos/shared";

/**
 * RPC-gated integration test (ROADMAP §3.2: "one integration test against a local
 * fork"). Runs only when MANTLE_RPC_URL is set (e.g. an anvil --fork of Mantle or
 * a live RPC); otherwise it is skipped, mirroring the Solidity fork suites.
 *
 *   MANTLE_RPC_URL=http://127.0.0.1:8545 pnpm --filter @custos/agent test
 */
const RPC = process.env.MANTLE_RPC_URL;
const describeFork = RPC ? describe : describe.skip;

describeFork("pipeline (fork integration)", () => {
  // Fallback keeps loadConfig from throwing during collection when skipped.
  const config = loadConfig({ MANTLE_RPC_URL: RPC ?? "https://rpc.mantle.xyz" });

  it("connects to Mantle and reports the expected chain id", async () => {
    const { publicClient } = makeClients(config);
    const id = await publicClient.getChainId();
    expect(id).toBe(MANTLE_MAINNET_CHAIN_ID);
  });

  it("reads a plausible USDY NAV from the live Ondo oracle", async () => {
    const { publicClient } = makeClients(config);
    const oracle = PROTOCOLS.usdyRWADynamicOracle;
    expect(oracle).not.toBeNull();
    const { navUsdc } = await readUsdyOracle(publicClient, oracle as `0x${string}`);
    // USDY NAV should sit between $1.00 and $2.00 (18-dec).
    expect(navUsdc).toBeGreaterThanOrEqual(1_000_000_000_000_000_000n);
    expect(navUsdc).toBeLessThanOrEqual(2_000_000_000_000_000_000n);
  });

  it("buildPipeline constructs against resolved shared addresses", () => {
    // No vault configured → read-only wiring; throws only if a required protocol
    // address (the USDY oracle) is unresolved in @custos/shared.
    const pipeline = buildPipeline(config);
    expect(pipeline.snapshotter).toBeDefined();
    expect(pipeline.clients.publicClient).toBeDefined();
  });
});
