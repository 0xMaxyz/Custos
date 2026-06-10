import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

import { MANTLE_MAINNET_CHAIN_ID } from "@custos/shared";
import type { AgentConfig } from "../config.js";

/**
 * viem clients for Mantle. The backend/agent uses **viem only** (no ethers) per
 * the stack contract. A read-only `PublicClient` is always available; the
 * write-capable `WalletClient` (ALLOCATOR hot key) is created only when a private
 * key is configured, keeping read-only/dev runs key-free.
 */

/** Mantle mainnet chain definition (chainId 5000). */
export const mantle = defineChain({
  id: MANTLE_MAINNET_CHAIN_ID,
  name: "Mantle",
  nativeCurrency: { name: "Mantle", symbol: "MNT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mantle.xyz"] } },
});

export interface ChainClients {
  /** Read-only client for all on-chain reads. */
  readonly publicClient: PublicClient;
  /** Write client bound to the ALLOCATOR account; undefined if no key configured. */
  readonly walletClient?: WalletClient;
  /** The ALLOCATOR address, if a signer is configured. */
  readonly allocatorAddress?: `0x${string}`;
}

/**
 * Build read (+ optional write) clients from config. The RPC transport points at
 * `config.mantleRpcUrl` so a local anvil `--fork` URL can be supplied for dev.
 */
export function makeClients(config: AgentConfig): ChainClients {
  const transport = http(config.mantleRpcUrl);

  const publicClient = createPublicClient({
    chain: mantle,
    transport,
  });

  if (config.allocatorPrivateKey === undefined) {
    return { publicClient };
  }

  const account = privateKeyToAccount(config.allocatorPrivateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: mantle,
    transport,
  });

  return {
    publicClient,
    walletClient,
    allocatorAddress: account.address,
  };
}

/**
 * Startup safety check (O6): verify the configured RPC actually serves Mantle
 * mainnet (chainId 5000) before any scheduler / execution path can sign a tx.
 *
 * The chain object is hardcoded to 5000, but nothing forces the RPC URL to match —
 * a stale `.env` pointing at a fork, testnet, or unrelated node would otherwise let
 * the agent sign real-money txs against the wrong network silently. Fail fast.
 */
export async function assertChainId(publicClient: PublicClient): Promise<void> {
  const id = await publicClient.getChainId();
  if (id !== MANTLE_MAINNET_CHAIN_ID) {
    throw new Error(
      `RPC chain-id mismatch: expected Mantle mainnet (${MANTLE_MAINNET_CHAIN_ID}), got ${id}. ` +
        `Check MANTLE_RPC_URL points at the right network.`,
    );
  }
}
