import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import type { ExplainClient, ExplainContext } from "./llm/explain.js";

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
    expect(res.json()).toEqual({ status: "ok", service: "sentinel-agent" });
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
  }): FastifyInstance {
    const explainClient: ExplainClient = {
      explain: opts.explain ?? (async () => "Because USDY out-yields Aave and the peg is healthy."),
    };
    return buildServer({
      explainClient,
      getContext: opts.context ?? (async () => sampleContext),
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

  it("sets permissive CORS headers", async () => {
    const app = buildWith({});
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ask", payload: { question: "hi" } });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    await app.close();
  });
});
