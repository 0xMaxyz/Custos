import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import type { ExplainClient, ExplainContext } from "./llm/explain.js";
import { encodePaymentHeader, type PaymentPayload } from "./payments/x402.js";

const sampleContext: ExplainContext = {
  asOf: "2026-06-01T00:00:00.000Z",
  riskLevel: "NORMAL",
  flags: ["NONE"],
  forceDeRisk: false,
  usdyOracleNavUsdc: "1.0832",
  usdyDexSpotUsdc: "1.0810",
  pegDeviationBps: 20,
  usdyImpliedApyBps: 452,
  aaveUsdcSupplyApyBps: 380,
  aaveUtilizationBps: 7_400,
  aaveWithdrawableUsdc: "21000.00",
  oracleRangeEnd: "2026-07-01T00:00:00.000Z",
  totalAssetsUsdc: "30000.00",
  ausdBackingRatioBps: 10_000,
  currentWeights: [{ bucket: "USDY", bps: 5_000, pct: "50.00%" }],
  maxUsdyWeightBpsAllowed: 6_000,
  recentDecisions: [],
};

describe("agent server — /health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("responds ok on /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "custos-agent" });
  });

  it("does not register /ask when no explainer is wired", async () => {
    const res = await app.inject({ method: "POST", url: "/ask", payload: { question: "hi" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("agent server — /ask (A3.1)", () => {
  function buildWith(opts: {
    explain?: ExplainClient["explain"];
    context?: () => Promise<ExplainContext | null>;
    askRateLimit?: number;
    askRateWindowMs?: number;
  }): FastifyInstance {
    const explainClient: ExplainClient = {
      explain: opts.explain ?? (async () => "Because USDY out-yields Aave and the peg is healthy."),
    };
    return buildServer({
      explainClient,
      getContext: opts.context ?? (async () => sampleContext),
      ...(opts.askRateLimit !== undefined ? { askRateLimit: opts.askRateLimit } : {}),
      ...(opts.askRateWindowMs !== undefined ? { askRateWindowMs: opts.askRateWindowMs } : {}),
    });
  }

  it("answers a grounded question", async () => {
    const app = buildWith({});
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/ask",
      payload: { question: "Why am I in USDY?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      answer: "Because USDY out-yields Aave and the peg is healthy.",
      asOf: sampleContext.asOf,
    });
    await app.close();
  });

  it("passes the question and context to the explainer", async () => {
    let seenQuestion = "";
    let seenContext: ExplainContext | null = null;
    const app = buildWith({
      explain: async (q, ctx) => {
        seenQuestion = q;
        seenContext = ctx;
        return "ok";
      },
    });
    await app.ready();
    await app.inject({ method: "POST", url: "/ask", payload: { question: "  what changed?  " } });
    expect(seenQuestion).toBe("what changed?"); // trimmed
    expect(seenContext).toEqual(sampleContext);
    await app.close();
  });

  it("rejects a missing or empty question with 400", async () => {
    const app = buildWith({});
    await app.ready();
    expect((await app.inject({ method: "POST", url: "/ask", payload: {} })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/ask", payload: { question: "   " } })).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("rejects an over-long question with 400", async () => {
    const app = buildWith({});
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/ask",
      payload: { question: "x".repeat(501) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 503 when the agent has no state yet", async () => {
    const app = buildWith({ context: async () => null });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ask", payload: { question: "hi" } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns 503 when building the context throws", async () => {
    const app = buildWith({
      context: async () => {
        throw new Error("RPC down");
      },
    });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ask", payload: { question: "hi" } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns 502 when the explainer throws", async () => {
    const app = buildWith({
      explain: async () => {
        throw new Error("LLM down");
      },
    });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ask", payload: { question: "hi" } });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("rate-limits once the per-window quota is exhausted", async () => {
    const app = buildWith({ askRateLimit: 2, askRateWindowMs: 60_000 });
    await app.ready();
    const ask = () => app.inject({ method: "POST", url: "/ask", payload: { question: "hi" } });
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(429); // third request in the window
    await app.close();
  });

  it("sets permissive CORS headers", async () => {
    const app = buildWith({});
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ask", payload: { question: "hi" } });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    await app.close();
  });
});

describe("agent server — /snapshot (A2.1)", () => {
  it("returns 404 when no getContext is wired", async () => {
    const app = buildServer();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/snapshot" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns the context JSON when getContext resolves", async () => {
    const app = buildServer({ getContext: async () => sampleContext });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/snapshot" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as typeof sampleContext;
    expect(body.asOf).toBe(sampleContext.asOf);
    expect(body.pegDeviationBps).toBe(20);
    expect(body.riskLevel).toBe("NORMAL");
    await app.close();
  });

  it("returns 503 when context is null", async () => {
    const app = buildServer({ getContext: async () => null });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/snapshot" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns 503 when getContext throws", async () => {
    const app = buildServer({ getContext: async () => { throw new Error("RPC down"); } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/snapshot" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("sets CORS headers on /snapshot", async () => {
    const app = buildServer({ getContext: async () => sampleContext });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/snapshot" });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    await app.close();
  });
});

describe("agent server — x402-paid /risk-score (A4.1)", () => {
  const requirements = (resourceUrl: string) => ({
    scheme: "exact" as const,
    network: "mantle",
    chainId: 5000,
    maxAmountRequired: "10000",
    resource: resourceUrl,
    description: "Custos RWA risk score",
    mimeType: "application/json",
    payTo: "0x000000000000000000000000000000000000bEEF" as `0x${string}`,
    maxTimeoutSeconds: 120,
    asset: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9" as `0x${string}`,
    extra: { name: "USD Coin", version: "2" },
  });

  it("is not registered when x402 is not configured", async () => {
    const app = buildServer();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/risk-score" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 402 with payment requirements when no X-PAYMENT is presented", async () => {
    const app = buildServer({
      x402: {
        requirements,
        verify: async () => null,
        riskScore: async () => ({ riskScore: 41 }),
      },
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/risk-score" });
    expect(res.statusCode).toBe(402);
    const body = res.json() as { accepts: Array<{ scheme: string; payTo: string }> };
    expect(body.accepts[0]?.scheme).toBe("exact");
    expect(body.accepts[0]?.payTo).toBe("0x000000000000000000000000000000000000bEEF");
    await app.close();
  });

  it("returns 200 + score + settlement receipt once a valid X-PAYMENT settles", async () => {
    const receipt = {
      success: true,
      transaction: `0x${"cd".repeat(32)}`,
      network: "mantle",
      payer: "0x000000000000000000000000000000000000A11c" as `0x${string}`,
      amount: "10000",
      resource: "https://x",
    };
    const app = buildServer({
      x402: {
        requirements,
        verify: async () => receipt, // stub a successful settlement
        riskScore: async () => ({ riskScore: 41, asOf: "2026-06-01T00:00:00Z" }),
      },
    });
    await app.ready();
    const payment: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "mantle",
      payload: {
        signature: `0x${"ab".repeat(65)}`,
        authorization: {
          from: "0x000000000000000000000000000000000000A11c",
          to: "0x000000000000000000000000000000000000bEEF",
          value: "10000",
          validAfter: "0",
          validBefore: "99999999999",
          nonce: `0x${"11".repeat(32)}`,
        },
      },
    };
    const res = await app.inject({
      method: "GET",
      url: "/risk-score",
      headers: { "x-payment": encodePaymentHeader(payment) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ riskScore: 41 });
    expect(res.headers["x-payment-response"]).toBeTruthy();
    await app.close();
  });
});
