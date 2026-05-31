import type { PublicClient } from "viem";

import { rwaDynamicOracleAbi } from "../chain/abis.js";

/**
 * Low-level on-chain readers. Each takes a viem `PublicClient` and returns typed
 * values, isolating contract-call shapes from the snapshot assembler so they can
 * be mocked individually in tests.
 */

export interface OracleReading {
  /** USDC per USDY, 18-dec. */
  readonly navUsdc: bigint;
  /** Unix seconds the oracle range expires; 0 if currentRange() is unsupported. */
  readonly rangeEnd: number;
}

/**
 * Read the USDY oracle NAV and (best-effort) range end. `currentRange()` reverts
 * on Mantle's Ondo deployment, so it's probed defensively: rangeEnd=0 disables
 * the range-staleness check (the on-chain Guardrails depeg guard backstops).
 */
export async function readUsdyOracle(
  client: PublicClient,
  oracle: `0x${string}`,
): Promise<OracleReading> {
  const navUsdc = await client.readContract({
    address: oracle,
    abi: rwaDynamicOracleAbi,
    functionName: "getPrice",
  });

  let rangeEnd = 0;
  try {
    const [, end] = await client.readContract({
      address: oracle,
      abi: rwaDynamicOracleAbi,
      functionName: "currentRange",
    });
    rangeEnd = end > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(end);
  } catch {
    rangeEnd = 0;
  }

  return { navUsdc, rangeEnd };
}

/**
 * Annualized USDY-implied APY in bps from two NAV samples `dtSec` apart.
 * Pure helper (no chain) so the snapshot can derive APY from cached prior NAVs.
 */
export function impliedApyBps(navOld: bigint, navNew: bigint, dtSec: number): number {
  if (navOld <= 0n || dtSec <= 0) return 0;
  const SECONDS_PER_YEAR = 365 * 24 * 3_600;
  // growthBps over dt, then annualized linearly (NAV drift is ~linear intraday).
  const growthBps = Number(((navNew - navOld) * 10_000n) / navOld);
  return Math.round((growthBps * SECONDS_PER_YEAR) / dtSec);
}
