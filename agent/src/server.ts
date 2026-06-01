import Fastify, { type FastifyInstance } from "fastify";
import type { ExplainClient, ExplainContext } from "./llm/explain.js";

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
   */
  readonly getContext?: (() => Promise<ExplainContext | null>) | undefined;
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
    reply.header("access-control-allow-headers", "content-type");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    return payload;
  });
  app.options("/*", async (_req, reply) => reply.code(204).send());

  app.get("/health", async () => ({
    status: "ok",
    service: "sentinel-agent",
  }));

  // ── Conversational transparency endpoint (A3.1) ────────────────────────────
  const { explainClient, getContext } = options;
  if (explainClient && getContext) {
    app.post<{ Body: AskBody }>("/ask", async (req, reply) => {
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

  return app;
}
