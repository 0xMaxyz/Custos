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
