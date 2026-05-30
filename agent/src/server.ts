import Fastify, { type FastifyInstance } from "fastify";

/**
 * Builds the agent's Fastify app. Kept separate from `index.ts` so tests can
 * exercise routes via `app.inject` without binding a port.
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.AGENT_LOG_LEVEL ?? "info" },
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "sentinel-agent",
  }));

  return app;
}
