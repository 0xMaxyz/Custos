import { z } from "zod";
import { getAddress } from "viem";

import type { AgentConfig } from "../config.js";
import { pinJson, type PinResult } from "../executor/ipfs.js";

/**
 * ERC-8004 agent card (task 4.2). The IdentityRegistry token's `tokenURI` resolves
 * to this JSON. It describes the Sentinel agent — who it is, where to reach it, and
 * the on-chain contracts that make its behaviour verifiable (vault + benchmark).
 *
 * SPEC.md §2.5 fixes the shape: { name, description, endpoints, wallet,
 * supportedTrust, vault, benchmark }.
 */

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte 0x address");

export const agentCardSchema = z.object({
  /** Schema/registration version so consumers can evolve safely. */
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Service endpoints (e.g. the agent's HTTP API + dashboard). */
  endpoints: z.object({
    api: z.string().url(),
    dashboard: z.string().url().optional(),
  }),
  /** The ALLOCATOR hot key (the wallet that signs decisions on-chain). */
  wallet: addressSchema,
  /** Trust models the agent supports surfacing (ERC-8004 `supportedTrust`). */
  supportedTrust: z.array(z.string()).min(1),
  /** Sentinel YieldVault — the custody contract the agent allocates. */
  vault: addressSchema,
  /** AgentBenchmark ledger — the verifiable decision/outcome track record. */
  benchmark: addressSchema,
});

export type AgentCard = z.infer<typeof agentCardSchema>;

export interface BuildAgentCardOptions {
  /** ALLOCATOR wallet address (defaults to deriving nothing; must be supplied). */
  readonly wallet: string;
  /** Public API base URL the agent serves from. */
  readonly apiUrl: string;
  /** Optional public dashboard URL. */
  readonly dashboardUrl?: string;
  readonly name?: string;
  readonly description?: string;
}

const DEFAULT_NAME = "Sentinel";
const DEFAULT_DESCRIPTION =
  "AI risk-guardian real-yield account on Mantle. Earns tokenized-Treasury (USDY) " +
  "yield with an Aave v3 USDC liquidity floor and autonomously de-risks on-chain " +
  "into AUSD/USDC on RWA danger — every decision recorded under an ERC-8004 identity.";

/**
 * Build a schema-valid agent card from config + deployed contract addresses.
 * Throws (via zod) if any required field is missing or malformed, so we never pin
 * a card that won't resolve correctly.
 */
export function buildAgentCard(config: AgentConfig, opts: BuildAgentCardOptions): AgentCard {
  if (!config.vaultAddress) throw new Error("VAULT_ADDRESS is required to build the agent card");
  if (!config.benchmarkAddress) {
    throw new Error("BENCHMARK_ADDRESS is required to build the agent card");
  }

  const card: AgentCard = {
    schemaVersion: 1,
    name: opts.name ?? DEFAULT_NAME,
    description: opts.description ?? DEFAULT_DESCRIPTION,
    endpoints: {
      api: opts.apiUrl,
      ...(opts.dashboardUrl ? { dashboard: opts.dashboardUrl } : {}),
    },
    // Checksum the addresses so the pinned card is canonical.
    wallet: getAddress(opts.wallet),
    supportedTrust: ["reputation", "crypto-economic"],
    vault: getAddress(config.vaultAddress),
    benchmark: getAddress(config.benchmarkAddress),
  };

  // Validate before returning — fail loudly on a malformed card.
  return agentCardSchema.parse(card);
}

/**
 * Build + pin the agent card to IPFS (or a data: URI fallback). The returned `uri`
 * is what gets passed to `IdentityRegistry.register` / `setAgentURI`.
 */
export async function pinAgentCard(
  config: AgentConfig,
  opts: BuildAgentCardOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<PinResult & { card: AgentCard }> {
  const card = buildAgentCard(config, opts);
  const pin = await pinJson(card, config, "agent-card.json", fetchImpl);
  return { ...pin, card };
}
