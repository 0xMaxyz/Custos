import { describe, it, expect, vi } from "vitest";
import { PROTOCOLS } from "@custos/shared";

import { makeSwapQuoteHandler } from "./swapQuote.js";
import type { AgentConfig } from "../config.js";
import type { OneDeltaClient } from "./oneDelta.js";
import type { PublicClient } from "viem";

const PINNED = PROTOCOLS.usdyAggregatorRouter as `0x${string}`;

// Minimal config with no vault → adapters resolve from the committed mainnet record.
const config = { vaultAddress: undefined } as unknown as AgentConfig;

function makeOneDelta(over: Partial<Record<"router", `0x${string}`>> = {}) {
  const getSwapQuote = vi.fn(
    async (_tokenIn: string, _tokenOut: string, _amountIn: bigint, _to: string, _slip: number) => ({
      router: over.router ?? PINNED,
      calldata: "0xabcdef" as `0x${string}`,
      amountOut: 999n,
    }),
  );
  const getUsdyDexSpotUsdc = vi.fn(async () => 1_081_000_000_000_000_000n);
  return { client: { getSwapQuote, getUsdyDexSpotUsdc } as unknown as OneDeltaClient, getSwapQuote, getUsdyDexSpotUsdc };
}

// publicClient stub: only getPrice (oracle NAV) is exercised here.
function makePublic(nav = 1_080_000_000_000_000_000n): PublicClient {
  return { readContract: vi.fn(async () => nav) } as unknown as PublicClient;
}

describe("makeSwapQuoteHandler", () => {
  it("returns pinned-router calldata for a USDY deposit (USDC→USDY)", async () => {
    const { client, getSwapQuote, getUsdyDexSpotUsdc } = makeOneDelta();
    const handler = makeSwapQuoteHandler({ config, oneDelta: client, publicClient: makePublic() });

    const res = await handler({ bucket: "USDY", side: "deposit", usdcAmount: 5_000_000n });

    expect(res.bucketIndex).toBe(2);
    expect(res.router.toLowerCase()).toBe(PINNED.toLowerCase());
    expect(res.calldata).toBe("0xabcdef");
    expect(res.usdyDexSpotUsdc).toBe("1081000000000000000");
    // deposit spends the USDC notional as-is (tokenIn = USDC).
    expect(getSwapQuote).toHaveBeenCalledTimes(1);
    const [, , amountIn] = getSwapQuote.mock.calls[0]!;
    expect(amountIn).toBe(5_000_000n);
    expect(getUsdyDexSpotUsdc).toHaveBeenCalled();
  });

  it("sizes a USDY withdraw via the oracle NAV (USDC value → USDY units)", async () => {
    const { client, getSwapQuote } = makeOneDelta();
    const nav = 1_080_000_000_000_000_000n; // 1.08
    const handler = makeSwapQuoteHandler({ config, oneDelta: client, publicClient: makePublic(nav) });

    await handler({ bucket: "USDY", side: "withdraw", usdcAmount: 1_080_000n });

    const [, , amountIn] = getSwapQuote.mock.calls[0]!;
    // usdyIn = usdcValue × 1e30 / nav = 1.08 USDC → 1.0 USDY (1e18).
    expect(amountIn).toBe((1_080_000n * 10n ** 30n) / nav);
  });

  it("routes AUSD to slot 3 with a 1:1 amount and no USDY spot", async () => {
    const { client, getSwapQuote, getUsdyDexSpotUsdc } = makeOneDelta();
    const handler = makeSwapQuoteHandler({ config, oneDelta: client, publicClient: makePublic() });

    const res = await handler({ bucket: "AUSD", side: "withdraw", usdcAmount: 2_500_000n });

    expect(res.bucketIndex).toBe(3);
    expect(res.usdyDexSpotUsdc).toBe("0");
    const [, , amountIn] = getSwapQuote.mock.calls[0]!;
    expect(amountIn).toBe(2_500_000n); // AUSD is 6-dec, 1:1
    expect(getUsdyDexSpotUsdc).not.toHaveBeenCalled();
  });

  it("rejects a quote that targets a non-pinned router (fail-closed)", async () => {
    const { client } = makeOneDelta({ router: "0x000000000000000000000000000000000000dEaD" });
    const handler = makeSwapQuoteHandler({ config, oneDelta: client, publicClient: makePublic() });

    await expect(handler({ bucket: "USDY", side: "deposit", usdcAmount: 1_000_000n })).rejects.toThrow(/router mismatch/i);
  });

  it("rejects a non-positive amount", async () => {
    const { client } = makeOneDelta();
    const handler = makeSwapQuoteHandler({ config, oneDelta: client, publicClient: makePublic() });
    await expect(handler({ bucket: "USDY", side: "deposit", usdcAmount: 0n })).rejects.toThrow(/positive/i);
  });
});
