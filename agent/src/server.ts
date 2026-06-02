import Fastify, { type FastifyInstance } from "fastify";
import type { ExplainClient, ExplainContext } from "./llm/explain.js";
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  X402_VERSION,
  decodePaymentHeader,
  encodeSettlement,
  type PaymentRequirements,
  type PaymentVerifier,
} from "./payments/x402.js";

/**
 * x402-paid endpoint config (ROADMAP A4.1). When provided, `GET /risk-score`
 * becomes a 402-gated resource: callers must present a valid `X-PAYMENT` header.
 * `requirements(url)` builds the per-request payment terms; `verify` validates the
 * inbound payment. The running agent wires a signature-verifying verifier (recovers
 * the EIP-712 signer), optionally settling on-chain (`X402_SETTLE_ONCHAIN`); the
 * shape-only verifier is for tests only.
 */
export interface X402Options {
  readonly requirements: (resourceUrl: string) => PaymentRequirements;
  readonly verify: PaymentVerifier;
  /** Current RWA risk score payload to sell (the resource body). */
  readonly riskScore: () => Promise<Record<string, unknown>>;
}

/**
 * Optional server dependencies. When `explainClient` and `getContext` are
 * provided, the conversational `/ask` endpoint (ROADMAP A3.1) is enabled. They
 * are injected (not imported) so tests can stub the LLM + state without an API
 * key or a running agent loop.
 */
export interface ServerOptions {
  readonly explainClient?: ExplainClient | undefined;
  /**
   * Resolves the latest grounding context, or null when the agent has no state
   * yet. Async because building it may require a fresh on-chain/data snapshot.
   * Exposed via `GET /snapshot` (A2.1) and `POST /ask` (A3.1).
   */
  readonly getContext?: (() => Promise<ExplainContext | null>) | undefined;
  /**
   * Max `/ask` requests allowed per `askRateWindowMs`, across all callers. Each
   * request costs an Anthropic call + a snapshot, so this caps API-cost abuse on
   * the unauthenticated public endpoint. Default 30 / minute. Set 0 to disable.
   */
  readonly askRateLimit?: number | undefined;
  readonly askRateWindowMs?: number | undefined;
  /**
   * When set, exposes Custos's RWA risk score as an x402-paid endpoint
   * (`GET /risk-score`) other agents can call (ROADMAP A4.1 revenue surface).
   */
  readonly x402?: X402Options | undefined;
}

/** Minimal fixed-window throttle (dependency-free). Global, not per-IP — the goal
 *  is API-cost protection on a public endpoint, not fair-share scheduling. */
function makeRateLimiter(limit: number, windowMs: number): () => boolean {
  let windowStart = 0;
  let count = 0;
  return () => {
    if (limit <= 0) return true; // disabled
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    if (count >= limit) return false;
    count += 1;
    return true;
  };
}

interface AskBody {
  question?: unknown;
}

/**
 * Builds the agent's Fastify app. Kept separate from `index.ts` so tests can
 * exercise routes via `app.inject` without binding a port.
 */
export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.AGENT_LOG_LEVEL ?? "info" },
  });

  // Permissive CORS for the read-only public endpoints: the agent controls no
  // funds via HTTP and only surfaces already-public market data. In production
  // the web app and agent sit behind the same Caddy reverse proxy (same-origin);
  // this header keeps local cross-port dev working without a new dependency.
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("access-control-allow-origin", "*");
    // `x-payment` lets cross-origin agents pay the /risk-score endpoint (A4.1);
    // `x-payment-response` is exposed so they can read the settlement receipt.
    reply.header("access-control-allow-headers", "content-type, x-payment");
    reply.header("access-control-expose-headers", "x-payment-response");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    return payload;
  });
  app.options("/*", async (_req, reply) => reply.code(204).send());

  app.get("/health", async () => ({
    status: "ok",
    service: "custos-agent",
  }));

  // ── Live snapshot endpoint (A2.1) ─────────────────────────────────────────
  // Returns the current ExplainContext so the web risk-radar panel can display
  // live metrics (peg deviation, oracle freshness, AUSD PoR, Aave utilization).
  const { explainClient, getContext } = options;
  if (getContext) {
    app.get("/snapshot", async (req, reply) => {
      let context: ExplainContext | null;
      try {
        context = await getContext();
      } catch (err) {
        req.log.error({ err }, "context build failed for /snapshot");
        return reply.code(503).send({ error: "Snapshot unavailable — try again shortly." });
      }
      if (!context) {
        return reply.code(503).send({ error: "No snapshot yet — agent hasn't run a cycle." });
      }
      return context;
    });
  }

  // ── Conversational transparency endpoint (A3.1) ────────────────────────────
  if (explainClient && getContext) {
    const allowRequest = makeRateLimiter(options.askRateLimit ?? 30, options.askRateWindowMs ?? 60_000);

    app.post<{ Body: AskBody }>("/ask", async (req, reply) => {
      if (!allowRequest()) {
        return reply.code(429).send({ error: "Too many questions — please slow down and try again shortly." });
      }

      const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
      if (question.length === 0) {
        return reply.code(400).send({ error: "Missing 'question' (non-empty string)." });
      }
      if (question.length > 500) {
        return reply.code(400).send({ error: "Question too long (max 500 characters)." });
      }

      let context: ExplainContext | null;
      try {
        context = await getContext();
      } catch (err) {
        req.log.error({ err }, "context build failed");
        return reply.code(503).send({ error: "Agent state is unavailable right now — try again shortly." });
      }
      if (!context) {
        return reply.code(503).send({ error: "Agent has no state yet — try again after the first cycle." });
      }

      try {
        const answer = await explainClient.explain(question, context);
        return { answer, asOf: context.asOf };
      } catch (err) {
        req.log.error({ err }, "explain failed");
        return reply.code(502).send({ error: "The assistant could not answer right now." });
      }
    });
  }

  // ── x402-paid risk-score endpoint (A4.1) ───────────────────────────────────
  // Custos sells its RWA risk score per-call: 402 until a valid X-PAYMENT is
  // presented, then 200 + the score and an X-PAYMENT-RESPONSE settlement receipt.
  const { x402 } = options;
  if (x402) {
    app.get("/risk-score", async (req, reply) => {
      const resourceUrl = `${req.protocol}://${req.headers.host ?? "agent"}${req.url}`;
      const requirements = x402.requirements(resourceUrl);

      const raw = req.headers[PAYMENT_HEADER];
      const header = Array.isArray(raw) ? raw[0] : raw;
      const require402 = (error: string): unknown =>
        reply.code(402).send({ x402Version: X402_VERSION, accepts: [requirements], error });

      if (!header) return require402("payment required");

      let receipt = null;
      try {
        receipt = await x402.verify(decodePaymentHeader(header), requirements);
      } catch (err) {
        req.log.error({ err }, "x402 verify failed");
      }
      if (!receipt) return require402("invalid or insufficient payment");

      reply.header(PAYMENT_RESPONSE_HEADER, encodeSettlement(receipt));
      return x402.riskScore();
    });
  }

  return app;
}
