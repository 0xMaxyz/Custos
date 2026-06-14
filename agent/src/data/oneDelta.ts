import { z } from "zod";

import { TOKENS } from "@custos/shared";

import type { AgentConfig } from "../config.js";

/**
 * 1delta client — **data + swap routing/quoting**; its output is never trusted for
 * custody. Supplies Aave market data, a USDY/USDC DEX spot, and best-route swap
 * calldata. The swap calldata is executed by `UsdyAdapter`/`AusdAdapter` against the
 * single pinned 1delta swap executor only, under an oracle-derived on-chain
 * balance-delta `minOut` — so the values here are advisory (sizing + the router
 * allow-list check), never authoritative.
 *
 * Endpoints match the documented v1 API (https://portal.1delta.io/v1/openapi.json):
 *   - GET /v1/actions/swap/spot         meta-aggregator swap (quote + build)
 *   - GET /v1/data/lending/pools        lending pool stats (Aave v3 USDC)
 *
 * `fetchImpl` is injectable so tests run against a stub without real HTTP.
 */

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Mantle mainnet — the only chain Custos serves (CLAUDE.md #4). */
const CHAIN_ID = "5000";

/**
 * 1delta matches token/account addresses case-sensitively and expects them
 * lowercase; a checksummed (mixed-case) address can miss a route or be rejected.
 * Normalize EVERY address before it goes into a 1delta request URL. (The token-prices
 * response is also keyed by lowercase address — see {@link OneDeltaClient.getUsdyMarketPriceUsdc}.)
 */
const lc = (address: string): string => address.toLowerCase();

// ── Response schemas (validate only the fields we depend on) ─────────────────

export interface AaveUsdcMarket {
  /** USDC supply APY in bps. */
  readonly supplyApyBps: number;
  /** Reserve utilization in bps. */
  readonly utilizationBps: number;
}

/** GET /v1/data/token/prices → { success, data: { items: { <addr>: usdPrice } } }. */
const tokenPricesSchema = z.object({
  success: z.boolean(),
  data: z.object({ items: z.record(z.string(), z.coerce.number()) }),
});

/** GET /v1/data/lending/pools → { data: { items: [pool] } }. */
const lendingPoolsSchema = z.object({
  success: z.boolean(),
  data: z.object({
    items: z
      .array(
        z.object({
          // depositRate is a PERCENT (e.g. 2.48 = 2.48% APY); utilization is 0..1.
          depositRate: z.coerce.number(),
          utilization: z.coerce.number(),
        }),
      )
      .min(1),
  }),
});

/** A swap/approval tx in an ActionSet (to/data/value, optional description). */
const txRequestSchema = z.object({
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  value: z.string(),
  description: z.string().optional(),
});

/** The informational `data` block of a swap/spot response (quotes + currencies). */
const spotDataSchema = z
  .object({
    currencyOut: z.object({ decimals: z.number().int().nonnegative() }).partial().optional(),
    quotes: z
      .array(z.object({ aggregator: z.string().optional(), tradeOutput: z.number() }))
      .optional(),
  })
  .nullish();

/** GET /v1/actions/swap/spot → { success, data, actions }. */
const spotSwapSchema = z.object({
  success: z.boolean(),
  data: spotDataSchema,
  actions: z
    .object({
      // Pre-trade setup the adapter cannot run; must be empty for a plain spot swap.
      transactions: z.array(txRequestSchema),
      // Aggregator swap txns, sorted best-output first. Pick [0].
      alternatives: z.array(txRequestSchema).default([]),
      // Approvals to the executor — ignored here (the adapter pre-approves it).
      permissions: z.array(txRequestSchema).nullish(),
    })
    .nullable(),
});

export interface SwapQuote {
  /** Router the calldata targets — the caller asserts it equals the pinned AGGREGATOR. */
  readonly router: `0x${string}`;
  /** ABI-encoded swap calldata to run against `router`. */
  readonly calldata: `0x${string}`;
  /** Advisory expected output (token-out base units); on-chain minOut is authoritative. */
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

  /**
   * Aave v3 USDC market on Mantle: supply APY (bps) + utilization (bps), from the
   * lending-pools data endpoint. `depositRate` is returned as a percent and
   * `utilization` as a 0..1 fraction; both are converted to bps here.
   */
  async getAaveUsdcMarket(): Promise<AaveUsdcMarket> {
    const qs =
      `?chainId=${CHAIN_ID}&lender=AAVE_V3&underlyings=${lc(TOKENS.USDC.address)}` +
      // Widen the default util/TVL filters so the USDC pool is never filtered out.
      `&minUtil=0&maxUtil=1&minTvlUsd=0`;
    const raw = await this.getJson(`/v1/data/lending/pools${qs}`);
    const pool = lendingPoolsSchema.parse(raw).data.items[0]!;
    return {
      supplyApyBps: clampNonNeg(Math.round(pool.depositRate * 100)),
      utilizationBps: clampBps(Math.round(pool.utilization * 10_000)),
    };
  }

  /**
   * USDY/USDC DEX spot (USDC per 1 USDY), 18-dec fixed point, via a quote-only
   * swap/spot (no `account` → no tx build). Returns 0n when the route is unavailable
   * so callers can treat it as "no spot this cycle".
   */
  async getUsdyDexSpotUsdc(): Promise<bigint> {
    const oneUsdy = (10n ** BigInt(TOKENS.USDY.decimals)).toString();
    const qs =
      `?chainId=${CHAIN_ID}&tokenIn=${lc(TOKENS.USDY.address)}&tokenOut=${lc(TOKENS.USDC.address)}` +
      `&amount=${oneUsdy}&slippage=50&tradeType=0`;
    let raw: unknown;
    try {
      raw = await this.getJson(`/v1/actions/swap/spot${qs}`);
    } catch {
      return 0n;
    }
    const parsed = spotSwapSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.success) return 0n;
    const quote = parsed.data.data?.quotes?.[0];
    if (quote === undefined) return 0n;
    const decimals = parsed.data.data?.currencyOut?.decimals ?? TOKENS.USDC.decimals;
    // tradeOutput = USDC per 1 USDY. Express as 18-dec fixed point (USDC-per-USDY):
    // value in tokenOut base units, then scale tokenOut decimals → 18.
    const out = floatToBaseUnits(quote.tradeOutput, decimals);
    return out * 10n ** BigInt(18 - decimals);
  }

  /**
   * Cheap USDY DEX-market price proxy (USDC per 1 USDY, 18-dec fixed point) from the
   * indexed, **RPC-free** token-prices feed (1delta aggregates oracle + DEX +
   * CoinGecko + DefiLlama). Used for routine peg monitoring so the agent only pays
   * for the precise, RPC-on-1delta `swap/spot` quote when the peg approaches the warn
   * band. Returns 0n when unavailable so callers fall back to the precise quote.
   *
   * MVP-grade: a production integration would screen the DEX pools / oracles directly
   * rather than lean on an aggregated price.
   */
  async getUsdyMarketPriceUsdc(): Promise<bigint> {
    const qs = `?chainId=${CHAIN_ID}&assets=${lc(TOKENS.USDY.address)},${lc(TOKENS.USDC.address)}`;
    let raw: unknown;
    try {
      raw = await this.getJson(`/v1/data/token/prices${qs}`);
    } catch {
      return 0n;
    }
    const parsed = tokenPricesSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.success) return 0n;
    const items = parsed.data.data.items;
    const usdy = items[TOKENS.USDY.address.toLowerCase()] ?? 0;
    const usdc = items[TOKENS.USDC.address.toLowerCase()] ?? 0;
    if (!(usdy > 0) || !(usdc > 0)) return 0n;
    // USDC per USDY = USDY_usd / USDC_usd, expressed as 18-dec fixed point.
    return floatToBaseUnits(usdy / usdc, 18);
  }

  /**
   * AUSD proof-of-reserves backing ratio (bps). 1delta exposes no PoR feed — AUSD
   * PoR is a Chaos Labs source not wired here — so this returns 0 ("unknown"), which
   * the engine treats as no-signal rather than a breach. The on-chain custody path
   * (Guardrails + face-value accounting) is the real AUSD guard.
   */
  getAusdBackingRatioBps(): Promise<number> {
    return Promise.resolve(0);
  }

  /**
   * Best-route swap calldata for `tokenIn → tokenOut` of `amountIn` base units,
   * recipient `to`. Used to build `swapData` for UsdyAdapter/AusdAdapter
   * deposit/withdraw; the adapter enforces the real minOut on-chain.
   *
   * 1delta's `/actions/swap/spot` routes execution through the single pinned swap
   * executor: with `account`+`receiver` set to the adapter it returns ready-to-run
   * swap txns in `actions.alternatives` (best-output first) all targeting that
   * executor. We return the best alternative's `to`/`data`; the caller asserts `to`
   * equals the adapter's pinned AGGREGATOR before signing.
   *
   * @param to MUST be the adapter address — the executor pulls `tokenIn` from it
   *           (standing approval) and pays `tokenOut` back to it, so the adapter's
   *           balance-delta check sees the output.
   */
  async getSwapQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    to: string,
    slippageBps: number,
  ): Promise<SwapQuote> {
    const qs =
      `?chainId=${CHAIN_ID}&tokenIn=${lc(tokenIn)}&tokenOut=${lc(tokenOut)}` +
      `&amount=${amountIn.toString()}&slippage=${slippageBps}&tradeType=0` +
      // account builds the tx (pulls tokenIn from `to`); receiver lands tokenOut on `to`.
      `&account=${lc(to)}&receiver=${lc(to)}`;
    const parsed = spotSwapSchema.parse(await this.getJson(`/v1/actions/swap/spot${qs}`));

    if (!parsed.success || parsed.actions === null) {
      throw new Error("1delta swap: no actions returned (quote-only or failure)");
    }
    if (parsed.actions.transactions.length > 0) {
      // The adapter runs exactly one swap calldata; it cannot perform pre-trade setup.
      throw new Error("1delta swap: unexpected pre-trade setup transactions");
    }
    const best = parsed.actions.alternatives[0];
    if (best === undefined) throw new Error("1delta swap: no route (empty alternatives)");
    if (best.value !== "0") {
      // The adapter forwards no msg.value; a native-value swap would under-fund.
      throw new Error(`1delta swap: non-zero tx value ${best.value} unsupported`);
    }

    const decimals = parsed.data?.currencyOut?.decimals ?? 0;
    const tradeOutput = parsed.data?.quotes?.[0]?.tradeOutput;
    const amountOut =
      tradeOutput !== undefined && decimals > 0 ? floatToBaseUnits(tradeOutput, decimals) : 0n;

    return {
      router: best.to as `0x${string}`,
      calldata: best.data as `0x${string}`,
      amountOut,
    };
  }

  private async getJson(path: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    // 1delta authenticates via the `x-api-key` header (lifts the unauthenticated
    // 10-req/15-min rate limit); endpoints are otherwise public.
    if (this.apiKey !== undefined) headers["x-api-key"] = this.apiKey;

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
        // Include a truncated response body for debuggability (L4). The API key rides
        // the request header, not the response, so this is safe to surface.
        const body = await readBodySafe(res);
        throw new Error(
          `1delta request failed: ${path} → HTTP ${res.status}${body ? ` — ${body}` : ""}`,
        );
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Convert a non-negative JS number to integer base units at `decimals` precision. */
function floatToBaseUnits(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) return 0n;
  const [whole, frac = ""] = value.toFixed(decimals).split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}

const clampNonNeg = (n: number): number => (n < 0 ? 0 : n);
const clampBps = (n: number): number => (n < 0 ? 0 : n > 10_000 ? 10_000 : n);

/**
 * Best-effort read of a (JSON) error body for diagnostics, truncated to 200 chars.
 * Never throws — returns "" if the body is absent or unparseable (L4).
 */
async function readBodySafe(res: { json: () => Promise<unknown> }): Promise<string> {
  try {
    const body = await res.json();
    const str = typeof body === "string" ? body : JSON.stringify(body);
    return str.length > 200 ? `${str.slice(0, 200)}…` : str;
  } catch {
    return "";
  }
}
