// Client for the agent's `POST /swap/quote` (allocator UI).
//
// The browser never holds the 1delta key: to build swapData for a USDY/AUSD
// rebalance it asks the agent, which fetches the best-route calldata with its own
// key and returns it (pinned-router asserted server-side). Aave moves need no quote.

const AGENT_API_URL = import.meta.env.VITE_AGENT_API_URL ?? "";

export type SwapBucket = "USDY" | "AUSD";
export type SwapSide = "deposit" | "withdraw";

export interface SwapQuoteResult {
  router: `0x${string}`;
  calldata: `0x${string}`;
  amountOut: string;
  bucketIndex: 2 | 3;
  /** USDY/USDC DEX spot (18-dec) to pass to rebalance; "0" for AUSD. */
  usdyDexSpotUsdc: string;
}

/** Whether the swap-quote endpoint is reachable (agent API configured). */
export const swapQuoteAvailable = AGENT_API_URL.length > 0;

const FETCH_TIMEOUT_MS = 12_000;

/**
 * Fetch swap calldata for a single USDY/AUSD leg. `usdcAmount` is the 6-decimal
 * USDC notional to move, as a base-unit string. Throws on a non-200 or timeout.
 */
export async function fetchSwapQuote(req: {
  bucket: SwapBucket;
  side: SwapSide;
  usdcAmount: string;
}): Promise<SwapQuoteResult> {
  if (!swapQuoteAvailable) throw new Error("Agent API not configured (VITE_AGENT_API_URL)");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${AGENT_API_URL}/swap/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `/swap/quote ${res.status}`);
  }
  return (await res.json()) as SwapQuoteResult;
}
