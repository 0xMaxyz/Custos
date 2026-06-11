import { z } from "zod";
import { getAddress } from "viem";

import type { AgentConfig } from "../config.js";
import { pinJson, type PinResult } from "../executor/ipfs.js";

/**
 * ERC-8004 agent card (task 4.2). The IdentityRegistry token's `tokenURI` resolves
 * to this JSON. It describes the Custos agent — who it is, where to reach it, and
 * the on-chain contracts that make its behaviour verifiable (vault + benchmark).
 *
 * SPEC.md §2.5 fixes the shape: { name, description, endpoints, wallet,
 * supportedTrust, vault, benchmark }.
 *
 * NOTE (canonical interop): this is the **Custos-specific** card shape that our
 * own UI + registries consume. It is intentionally NOT the canonical erc-8004
 * best-practices registration file (which keys on `type` / `services[]` /
 * `registrations[]` and is what 8004scan-style explorers index). If/when Custos
 * registers its `tokenURI` against the canonical 0x8004 IdentityRegistry, emit (or
 * additionally pin) the canonical shape by mapping `endpoints` → `services[]`.
 * Tracked with the deploy wiring (PR-5a).
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
  /** Custos YieldVault — the custody contract the agent allocates. */
  vault: addressSchema,
  /** AgentBenchmark ledger — the verifiable decision/outcome track record. */
  benchmark: addressSchema,
  /**
   * x402 sell-side offer (spec §2.7): publishes the payee under the agent's
   * identity so a payer can verify the live 402 challenge's `payTo` against the
   * pinned card. Additive + optional, so schemaVersion stays 1. NOTE: the card is
   * immutable once pinned — changing the payee requires re-running `card:pin` and
   * `setAgentURI`, or the published card lies.
   */
  sells: z
    .object({
      /** Path of the paid endpoint, relative to `endpoints.api`. */
      endpoint: z.string().min(1),
      /** Payment recipient — the agent owner/treasury, NEVER the ALLOCATOR. */
      payTo: addressSchema,
      /** EIP-3009 token payments settle in. */
      asset: addressSchema,
      /** Price in token base units, as a decimal string (bigint, JSON-safe). */
      priceBaseUnits: z.string().regex(/^\d+$/, "must be a base-10 integer string"),
    })
    .optional(),
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
  /**
   * Resolved x402 payee (identity/payee.ts) — overrides `config.x402PayTo` so the
   * pinned card carries the SAME payee the live 402 challenge will use (e.g. one
   * derived from `ownerOf(agentId)`).
   */
  readonly x402PayTo?: string;
}

const DEFAULT_NAME = "Custos";
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

  // Publish the x402 offer under the same gate that enables the paid endpoint
  // (a payee + an asset), so the card never advertises an endpoint that won't
  // answer. The resolved payee (opts) wins over raw config.
  const sellsPayTo = opts.x402PayTo ?? config.x402PayTo;
  if (sellsPayTo && config.x402Asset) {
    card.sells = {
      endpoint: "/risk-score",
      payTo: getAddress(sellsPayTo),
      asset: getAddress(config.x402Asset),
      priceBaseUnits: config.x402PriceBaseUnits.toString(),
    };
  }

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
