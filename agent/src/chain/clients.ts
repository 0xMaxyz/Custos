import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type PublicClient,
  type Transport,
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
  // Multicall3 (canonical CREATE2 address, deployed on Mantle). Lets viem aggregate
  // independent `readContract` calls into a single `eth_call`, slashing the per-cycle
  // RPC request count so the public RPC stops returning 429 (rate-limited).
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
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
/**
 * Build the RPC transport from `MANTLE_RPC_URL`. A single URL → a plain HTTP
 * transport; several comma-separated URLs → a viem `fallback` that fails over (and
 * spreads overflow) across providers when one returns 429 / errors. This lets the
 * operator rotate between providers to dodge the public RPC's rate limit.
 */
export function makeTransport(rpcUrl: string): Transport {
  const urls = rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length <= 1) return http(urls[0]);
  // Multiple providers → fail over across them. `retryCount: 1` per transport so a
  // rate-limited (429) endpoint is abandoned for the next one quickly instead of
  // being hammered with the default 3 retries — the whole point of the rotation is
  // to spread load, not to retry one throttled provider. Order is significant: the
  // premium endpoint is placed first (see chain/rpcList.ts), the public pool after.
  return fallback(urls.map((u) => http(u, { retryCount: 1 })));
}

export function makeClients(config: AgentConfig): ChainClients {
  const transport = makeTransport(config.mantleRpcUrl);

  const publicClient = createPublicClient({
    chain: mantle,
    transport,
    // Aggregate concurrent contract reads through Multicall3 (one `eth_call` instead
    // of N). The snapshot's vault reads use `client.multicall` explicitly; this also
    // batches any other reads that happen to be in flight together.
    batch: { multicall: true },
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
