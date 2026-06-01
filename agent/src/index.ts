import { buildServer } from "./server.js";
import { tryLoadConfig } from "./config.js";
import { buildPipeline, type Pipeline } from "./pipeline.js";
import { Executor } from "./executor/index.js";
import { Scheduler } from "./scheduler.js";
import { assess } from "./risk/engine.js";
import { AnthropicExplainer, buildExplainContext, type ExplainContext } from "./llm/explain.js";
import { AlertNotifier } from "./alerts.js";
import type { Decision } from "./types.js";

// Validate configuration at startup; fail fast with a readable error.
const result = tryLoadConfig();
if (!result.ok) {
  process.stderr.write(
    `Invalid agent configuration:\n${JSON.stringify(result.error.format(), null, 2)}\n`,
  );
  process.exit(1);
}

const config = result.config;

// The conversational `/ask` endpoint (A3.1) needs a data snapshotter + an LLM
// explainer. Build the explainer when an Anthropic key is present; build the
// pipeline when we need live data for either the scheduler or the explainer.
const explainClient = config.anthropicApiKey ? new AnthropicExplainer(config) : undefined;
const needsPipeline = Boolean((config.allocatorPrivateKey && config.vaultAddress) || explainClient);
const pipeline: Pipeline | undefined = needsPipeline ? buildPipeline(config) : undefined;

// Fresh grounding context on demand: snapshot + deterministic assessment +
// recent decisions. A short TTL cache coalesces bursts of chat messages so a
// chatty session doesn't re-snapshot (RPC + 1delta) on every question.
const CONTEXT_TTL_MS = 10_000;
let contextCache: { at: number; value: ExplainContext } | undefined;

// Most-recent-first ring buffer of submitted decisions, for "what changed?".
// Invalidate the context cache so a just-submitted decision is reflected
// immediately, not after the TTL.
const recentDecisions: Decision[] = [];
const rememberDecision = (d: Decision) => {
  recentDecisions.unshift(d);
  if (recentDecisions.length > 10) recentDecisions.pop();
  contextCache = undefined;
};
const getContext =
  explainClient && pipeline
    ? async (): Promise<ExplainContext | null> => {
        const now = Date.now();
        if (contextCache && now - contextCache.at < CONTEXT_TTL_MS) {
          return contextCache.value;
        }
        const snapshot = await pipeline.snapshotter.snapshot();
        const assessment = assess(snapshot);
        const value = buildExplainContext(snapshot, assessment, recentDecisions);
        contextCache = { at: now, value };
        return value;
      }
    : undefined;

// Alert notifier (A3.2): fires on de-risk events via Telegram and/or Discord.
const alertNotifier = new AlertNotifier({
  telegramBotToken: config.telegramBotToken,
  telegramChatId: config.telegramChatId,
  discordWebhookUrl: config.discordWebhookUrl,
});

const app = buildServer({ explainClient, getContext });

// Wire the autonomous loop when execution prerequisites are configured.
// Graceful read-only mode: if ALLOCATOR_PRIVATE_KEY or VAULT_ADDRESS are absent,
// the scheduler is skipped and the agent serves data-only routes.
if (config.allocatorPrivateKey && config.vaultAddress && pipeline) {
  const executor = new Executor({ config, clients: pipeline.clients, snapshotter: pipeline.snapshotter });
  const scheduler = new Scheduler(executor, {
    onError: (e) => app.log.error({ err: e }, "scheduler cycle error"),
    onCycle: (r) => {
      if (r.submitted) {
        app.log.info({ kind: r.kind, decisionId: r.decisionId?.toString(), txHash: r.txHash }, "decision submitted");
        if (r.decision) rememberDecision(r.decision);
        if (r.kind === "derisk" && r.decision && alertNotifier.isConfigured) {
          const snapshot = contextCache?.value;
          alertNotifier
            .notify({
              riskLevel: r.decision.riskLevel,
              flags: snapshot?.flags ?? [],
              rationale: r.decision.rationale,
              txHash: r.txHash,
              decisionId: r.decisionId?.toString(),
              asOf: snapshot?.asOf ?? new Date().toISOString(),
            })
            .catch((err: unknown) => app.log.warn({ err }, "alert delivery failed"));
        }
      }
    },
  });

  app.addHook("onReady", async () => {
    scheduler.start();
    app.log.info("autonomous scheduler started (periodic=60m, poll=30s)");
  });

  app.addHook("onClose", async () => {
    scheduler.stop();
  });
} else {
  app.log.warn("ALLOCATOR_PRIVATE_KEY or VAULT_ADDRESS not set — running in read-only mode (no scheduler)");
}

app
  .listen({ port: config.agentPort, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`sentinel-agent listening on ${address}`);
  })
  .catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
