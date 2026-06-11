import { getAddress, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ERC8004 } from "@custos/shared";
import type { AgentConfig } from "../config.js";

/**
 * Sell-side x402 payee resolution — binds the address that collects /risk-score
 * payments to the agent's ERC-8004 identity (spec §2.7).
 *
 * Rules:
 *  - `X402_ASSET` is the explicit opt-in for the paid endpoint. Without it the
 *    payee is `none` and nothing is sold (so a deployed agent that merely has an
 *    AGENT_ID never auto-enables selling).
 *  - `X402_PAY_TO` set → use it; if AGENT_ID is also set, warn when it differs
 *    from `ownerOf(agentId)` (owners may legitimately route revenue to a
 *    separate treasury — the binding guarantee is the published agent card).
 *  - `X402_PAY_TO` unset + AGENT_ID set → derive the payee from the on-chain
 *    agent-NFT owner. A failed read here is fatal (no payee to fall back to).
 *  - The resolved payee must NEVER be the ALLOCATOR hot key: it is a
 *    guardrail-bounded, minimal-balance gas key — the worst place for revenue
 *    to accrue. Hard-reject at startup.
 *
 * The `ownerOf` reader is injectable so the resolver is testable offline
 * (same pattern as the payment verifiers / Eip3009Signer).
 */

/** Minimal ERC-721 `ownerOf` ABI for the ERC-8004 IdentityRegistry. */
const ownerOfAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/** Reads the agent-NFT owner for a token id. Injectable for tests. */
export type OwnerReader = (agentId: bigint) => Promise<`0x${string}`>;

/**
 * Production {@link OwnerReader} against the ERC-8004 IdentityRegistry singleton
 * on Mantle mainnet (the only execution chain — see CLAUDE.md non-negotiable 4).
 */
export function makeIdentityOwnerReader(publicClient: PublicClient): OwnerReader {
  const registry = ERC8004.mainnet.identityRegistry.address as `0x${string}`;
  return (agentId) =>
    publicClient.readContract({
      address: registry,
      abi: ownerOfAbi,
      functionName: "ownerOf",
      args: [agentId],
    });
}

export interface ResolvedPayee {
  /** Checksummed payee for the 402 challenge + agent card; unset when disabled. */
  readonly payTo?: `0x${string}`;
  /** Where the payee came from: explicit config, the agent-NFT owner, or nowhere. */
  readonly source: "config" | "owner" | "none";
}

export interface ResolvePayeeOptions {
  readonly config: AgentConfig;
  /** Required to consult `ownerOf(agentId)`; omit to skip the on-chain read. */
  readonly readOwner?: OwnerReader | undefined;
  /** Non-fatal findings (owner mismatch, failed reconcile read). */
  readonly warn?: ((message: string) => void) | undefined;
}

/**
 * Resolve the effective x402 sell-side payee. Throws when the payee would be the
 * ALLOCATOR hot key, or when payee derivation from the agent owner fails.
 */
export async function resolveX402PayTo(opts: ResolvePayeeOptions): Promise<ResolvedPayee> {
  const { config, readOwner } = opts;
  const warn = opts.warn ?? (() => {});

  // X402_ASSET is the opt-in: no asset → endpoint disabled, nothing to resolve.
  if (!config.x402Asset) return { source: "none" };

  // Enforce the guard from whichever allocator identity is available: the signer
  // key (running agent) and/or the plain ALLOCATOR_ADDRESS env, so keyless runs
  // (`card:pin`) can't publish a card paying the hot key either. No-op only when
  // neither is configured.
  const allocators = new Set<string>();
  if (config.allocatorPrivateKey) {
    allocators.add(privateKeyToAccount(config.allocatorPrivateKey as `0x${string}`).address);
  }
  if (config.allocatorAddress) allocators.add(getAddress(config.allocatorAddress));
  const rejectAllocator = (payTo: `0x${string}`): void => {
    if (allocators.has(payTo)) {
      throw new Error(
        `x402 payee ${payTo} is the ALLOCATOR hot key — revenue must never accrue ` +
          `on the guardrail-bounded gas key. Point X402_PAY_TO at the agent owner ` +
          `or treasury (or unset it with AGENT_ID set to derive from ownerOf).`,
      );
    }
  };

  if (config.x402PayTo) {
    const payTo = getAddress(config.x402PayTo);
    rejectAllocator(payTo);
    // Reconcile against the on-chain identity when we can; a failed read here is
    // only a warning — the operator-configured payee still stands.
    if (config.agentId !== undefined && readOwner) {
      try {
        const owner = getAddress(await readOwner(config.agentId));
        if (owner !== payTo) {
          warn(
            `X402_PAY_TO ${payTo} differs from ownerOf(${config.agentId}) = ${owner}; ` +
              `payers verify the payee via the pinned agent card — re-pin (card:pin) ` +
              `and setAgentURI if this is unintentional.`,
          );
        }
      } catch (err) {
        warn(
          `could not reconcile X402_PAY_TO with ownerOf(${config.agentId}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { payTo, source: "config" };
  }

  if (config.agentId !== undefined && readOwner) {
    // Deriving the payee from identity: a failed read is fatal (fail fast rather
    // than silently selling to nowhere / not selling).
    const payTo = getAddress(await readOwner(config.agentId));
    rejectAllocator(payTo);
    return { payTo, source: "owner" };
  }

  return { source: "none" };
}
