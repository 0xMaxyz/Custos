import { getAddress, type PublicClient } from "viem";
import {
  MANTLE_MAINNET_CHAIN_ID,
  MAX_SLIPPAGE_BPS,
  PROTOCOLS,
  TOKENS,
  getDeployment,
} from "@custos/shared";

import type { AgentConfig } from "../config.js";
import { yieldVaultAbi } from "../chain/abis.js";
import { readUsdyOracle } from "./readers.js";
import type { OneDeltaClient } from "./oneDelta.js";

/**
 * Server-side wrapper around 1delta's swap routing for the swap-bearing buckets
 * (USDY / AUSD), exposed to the web allocator UI via `POST /swap/quote`.
 *
 * Why this exists: the UI must build `swapData[bucket]` for a manual rebalance into
 * USDY/AUSD, but it must NOT hold the agent's 1delta API key. So the agent fetches the
 * best-route calldata with its own key and returns it. The custody boundary is preserved
 * exactly as for the autonomous path — the calldata only ever runs against the pinned,
 * immutable router, the adapter enforces an oracle-derived balance-delta `minOut`, and the
 * caller (the vault, ALLOCATOR-only) is the only one that can execute it. This handler adds
 * one more guard: it re-asserts the quote targets the pinned router before returning, so a
 * compromised upstream can never hand the UI calldata for a different router.
 */

export type SwapBucket = "USDY" | "AUSD";
export type SwapSide = "deposit" | "withdraw";

export interface SwapQuoteRequest {
  /** Which swap-bearing bucket to route for. */
  readonly bucket: SwapBucket;
  /** deposit = USDC → bucket token; withdraw = bucket token → USDC. */
  readonly side: SwapSide;
  /** USDC notional to move, in 6-decimal base units. */
  readonly usdcAmount: bigint;
}

export interface SwapQuoteResult {
  /** The pinned router the calldata targets (asserted == PROTOCOLS.usdyAggregatorRouter). */
  readonly router: `0x${string}`;
  /** ABI-encoded swap calldata for `swapData[bucketIndex]`. */
  readonly calldata: `0x${string}`;
  /** Advisory expected output (token-out base units); on-chain minOut is authoritative. */
  readonly amountOut: string;
  /** Vault swapData slot index for this bucket (USDY = 2, AUSD = 3). */
  readonly bucketIndex: 2 | 3;
  /**
   * USDY/USDC DEX spot (18-dec) for the rebalance's `usdyDexSpotUsdc` arg — populated
   * only for the USDY bucket, where the on-chain depeg guard needs it when weight
   * increases. "0" for AUSD (irrelevant to that leg).
   */
  readonly usdyDexSpotUsdc: string;
}

export type SwapQuoteHandler = (req: SwapQuoteRequest) => Promise<SwapQuoteResult>;

export interface SwapQuoteDeps {
  readonly config: AgentConfig;
  readonly oneDelta: OneDeltaClient;
  readonly publicClient: PublicClient;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Build the swap-quote handler. Adapter addresses are resolved (and cached) from the
 * configured vault's `adapters(i)` so the calldata's `account`/`receiver` always match
 * the live adapter; falls back to the committed @custos/shared mainnet record when no
 * vault is configured (read-only data agents).
 */
export function makeSwapQuoteHandler(deps: SwapQuoteDeps): SwapQuoteHandler {
  const { config, oneDelta, publicClient } = deps;
  const oracle = getAddress(PROTOCOLS.usdyRWADynamicOracle as string);
  const pinnedRouter = (PROTOCOLS.usdyAggregatorRouter as string).toLowerCase();

  let adaptersCache: { usdy: `0x${string}`; ausd: `0x${string}` } | undefined;

  async function resolveAdapters(): Promise<{ usdy: `0x${string}`; ausd: `0x${string}` }> {
    if (adaptersCache) return adaptersCache;

    if (config.vaultAddress) {
      const vault = getAddress(config.vaultAddress);
      const [usdy, ausd] = await publicClient.multicall({
        allowFailure: false,
        contracts: [
          { address: vault, abi: yieldVaultAbi, functionName: "adapters", args: [2n] },
          { address: vault, abi: yieldVaultAbi, functionName: "adapters", args: [3n] },
        ] as const,
      });
      if (usdy !== ZERO_ADDRESS && ausd !== ZERO_ADDRESS) {
        adaptersCache = { usdy: getAddress(usdy), ausd: getAddress(ausd) };
        return adaptersCache;
      }
    }

    // Fall back to the committed mainnet deployment record.
    const dep = getDeployment(MANTLE_MAINNET_CHAIN_ID);
    if (!dep.usdyAdapter || !dep.ausdAdapter) {
      throw new Error("swap-quote: USDY/AUSD adapter addresses unresolved (no vault and no deployment record)");
    }
    adaptersCache = { usdy: getAddress(dep.usdyAdapter), ausd: getAddress(dep.ausdAdapter) };
    return adaptersCache;
  }

  return async function swapQuote(req: SwapQuoteRequest): Promise<SwapQuoteResult> {
    if (req.usdcAmount <= 0n) throw new Error("swap-quote: usdcAmount must be positive");

    const adapters = await resolveAdapters();
    const isUsdy = req.bucket === "USDY";
    const adapter = isUsdy ? adapters.usdy : adapters.ausd;
    const bucketIndex = isUsdy ? (2 as const) : (3 as const);
    const token = isUsdy ? TOKENS.USDY.address : TOKENS.AUSD.address;

    // Resolve the input token + amount for the requested leg.
    let tokenIn: string;
    let tokenOut: string;
    let amountIn: bigint;
    if (req.side === "deposit") {
      // USDC → bucket token: spend exactly the USDC notional.
      tokenIn = TOKENS.USDC.address;
      tokenOut = token;
      amountIn = req.usdcAmount;
    } else {
      // bucket token → USDC: convert the USDC notional into token base units.
      tokenIn = token;
      tokenOut = TOKENS.USDC.address;
      if (isUsdy) {
        // usdyIn (18-dec) = usdcValue (6-dec) × 1e30 / nav (18-dec) — mirrors the
        // on-chain UsdyAdapter math. Needs a live oracle NAV.
        const { navUsdc } = await readUsdyOracle(publicClient, oracle);
        if (navUsdc <= 0n) throw new Error("swap-quote: USDY oracle NAV unavailable");
        amountIn = (req.usdcAmount * 10n ** 30n) / navUsdc;
      } else {
        // AUSD is a 6-dec $1 stablecoin valued 1:1 with USDC.
        amountIn = req.usdcAmount;
      }
    }

    const quote = await oneDelta.getSwapQuote(tokenIn, tokenOut, amountIn, adapter, MAX_SLIPPAGE_BPS);

    // Fail-closed: the calldata must target the one pinned router. The adapter enforces
    // this on-chain too, but rejecting it here keeps bad calldata from ever reaching the UI.
    if (quote.router.toLowerCase() !== pinnedRouter) {
      throw new Error(`swap-quote: router mismatch (got ${quote.router}, expected pinned ${pinnedRouter})`);
    }

    // USDY weight increases need the DEX spot for the on-chain depeg guard; AUSD doesn't.
    let usdyDexSpotUsdc = "0";
    if (isUsdy) {
      const spot = await oneDelta.getUsdyDexSpotUsdc().catch(() => 0n);
      usdyDexSpotUsdc = spot.toString();
    }

    return {
      router: quote.router,
      calldata: quote.calldata,
      amountOut: quote.amountOut.toString(),
      bucketIndex,
      usdyDexSpotUsdc,
    };
  };
}
