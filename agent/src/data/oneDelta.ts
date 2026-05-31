import { z } from "zod";

import type { AgentConfig } from "../config.js";

/**
 * 1delta client — **data + optional swap routing ONLY**. Never in the custody or
 * execution path (AGENTS.md §2.1). Here it supplies Aave market data (supply APY,
 * utilization) and a USDY/USDC DEX spot quote that feed the deterministic engine.
 *
 * `fetchImpl` is injectable so tests run against a stub without real HTTP.
 */

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

// ── Response schemas (validate the shapes we depend on) ──────────────────────

const aaveMarketSchema = z.object({
  /** USDC supply APY in bps. */
  supplyApyBps: z.number().int().nonnegative(),
  /** Reserve utilization in bps. */
  utilizationBps: z.number().int().min(0).max(10_000),
});

export type AaveUsdcMarket = z.infer<typeof aaveMarketSchema>;

const dexSpotSchema = z.object({
  /** USDC per USDY, 18-dec fixed point, as a decimal string. */
  spotUsdc18: z.string().regex(/^\d+$/),
});

const ausdPorSchema = z.object({
  /** AUSD backing ratio in bps (10000 = fully backed). */
  backingRatioBps: z.number().int().nonnegative(),
});

/**
 * Swap-routing quote. 1delta aggregates multiple DEX aggregators (Odos, Eisen,
 * Nordstern, …) into a single best route, returning the calldata to execute it.
 * The vault's `UsdyAdapter` runs this calldata against the **pinned** aggregator
 * router only, and re-derives `minOut` from the on-chain oracle — the values here
 * are advisory (sizing + the address allow-list check), never trusted for custody.
 */
const swapQuoteSchema = z.object({
  /** Aggregator router the calldata targets. Must equal the adapter's pinned AGGREGATOR. */
  router: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** ABI-encoded swap calldata to run against `router`. */
  calldata: z.string().regex(/^0x[0-9a-fA-F]*$/),
  /** Expected output amount (token-out decimals), as a decimal string. */
  amountOut: z.string().regex(/^\d+$/),
});

export interface SwapQuote {
  readonly router: `0x${string}`;
  readonly calldata: `0x${string}`;
  readonly amountOut: bigint;
}

export interface OneDeltaClientOptions {
  readonly fetchImpl?: FetchLike;
  /** Per-request timeout in ms. */
  readonly timeoutMs?: number;
}

export class OneDeltaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(config: AgentConfig, options: OneDeltaClientOptions = {}) {
    this.baseUrl = config.oneDeltaBaseUrl.replace(/\/$/, "");
    this.apiKey = config.oneDeltaApiKey;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Aave v3 USDC market on Mantle: supply APY + utilization. */
  async getAaveUsdcMarket(): Promise<AaveUsdcMarket> {
    const raw = await this.getJson("/v1/mantle/aave/usdc");
    return aaveMarketSchema.parse(raw);
  }

  /**
   * USDY/USDC DEX spot (Merchant Moe), 18-dec fixed point. Returns 0n when the
   * route is unavailable so callers can treat it as "no spot this cycle".
   */
  async getUsdyDexSpotUsdc(): Promise<bigint> {
    const raw = await this.getJson("/v1/mantle/dex/usdy-usdc/spot");
    const parsed = dexSpotSchema.safeParse(raw);
    if (!parsed.success) return 0n;
    return BigInt(parsed.data.spotUsdc18);
  }

  /**
   * AUSD proof-of-reserves backing ratio (bps), sourced from the Chaos Labs PoR
   * feed via 1delta's data API. Returns 0 when unavailable so callers treat it as
   * "unknown" rather than a breach (the on-chain custody path is the real guard).
   */
  async getAusdBackingRatioBps(): Promise<number> {
    const raw = await this.getJson("/v1/mantle/ausd/por");
    const parsed = ausdPorSchema.safeParse(raw);
    return parsed.success ? parsed.data.backingRatioBps : 0;
  }

  /**
   * Best-route swap calldata for `tokenIn → tokenOut` of `amountIn`, recipient
   * `to`. Used to build `swapData` for UsdyAdapter deposit/withdraw. Returns the
   * pinned-router calldata; the adapter enforces the real minOut on-chain.
   * @param to Recipient the aggregator must pay — MUST be the adapter address so
   *           the adapter's balance-delta check sees the output.
   */
  async getSwapQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    to: string,
    slippageBps: number,
  ): Promise<SwapQuote> {
    const qs =
      `?tokenIn=${tokenIn}&tokenOut=${tokenOut}` +
      `&amountIn=${amountIn.toString()}&to=${to}&slippageBps=${slippageBps}`;
    const raw = await this.getJson(`/v1/mantle/swap/quote${qs}`);
    const parsed = swapQuoteSchema.parse(raw);
    return {
      router: parsed.router as `0x${string}`,
      calldata: parsed.calldata as `0x${string}`,
      amountOut: BigInt(parsed.amountOut),
    };
  }

  private async getJson(path: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey !== undefined) headers.authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`1delta request failed: ${path} → HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
