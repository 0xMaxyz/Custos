import { buildServer } from "./server.js";
import { tryLoadConfig } from "./config.js";
import { buildPipeline, type Pipeline } from "./pipeline.js";
import { Executor } from "./executor/index.js";
import { Scheduler } from "./scheduler.js";
import { assess } from "./risk/engine.js";
import { AnthropicExplainer, buildExplainContext, type ExplainContext } from "./llm/explain.js";
import { AlertNotifier } from "./alerts.js";
import type { Eip3009Signer, PaymentRequirements } from "./payments/x402.js";
import { onChainSettlingVerifier, replayGuardedVerifier, signatureVerifyingVerifier } from "./payments/verifier.js";
import { buildPaidEvidenceFetcher, type PaidEvidenceFetcher } from "./payments/evidence.js";
import { MANTLE_MAINNET_CHAIN_ID } from "@custos/shared";
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
// `getContext` only needs the data pipeline — it grounds both `/ask` (A3.1) and
// `/snapshot` (A2.1). Wire it whenever the pipeline exists, so a vault+allocator
// agent exposes `/snapshot` even without an Anthropic key.
const getContext = pipeline
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

// x402 paid risk-score endpoint (A4.1). Enabled when payTo + asset are configured.
// The verifier recovers the EIP-712 signature (real authorization check). With
// X402_SETTLE_ONCHAIN=true and an ALLOCATOR wallet, it also SETTLES on-chain via
// transferWithAuthorization; otherwise settlement is delegated to a facilitator.
const x402Verify =
  config.x402SettleOnChain && pipeline?.clients.walletClient && config.x402Asset
    ? onChainSettlingVerifier({
        walletClient: pipeline.clients.walletClient,
        publicClient: pipeline.clients.publicClient,
        asset: config.x402Asset as `0x${string}`,
      })
    : // Verify-only mode settles nothing on-chain, so guard against X-PAYMENT replays
      // off-chain (N3); the on-chain path above is single-use via the EIP-3009 nonce.
      replayGuardedVerifier(signatureVerifyingVerifier());
const x402 =
  config.x402PayTo && config.x402Asset
    ? {
        requirements: (resourceUrl: string): PaymentRequirements => ({
          scheme: "exact",
          network: config.x402Network,
          chainId: MANTLE_MAINNET_CHAIN_ID,
          maxAmountRequired: config.x402PriceBaseUnits.toString(),
          resource: resourceUrl,
          description: "Custos RWA risk score",
          mimeType: "application/json",
          payTo: config.x402PayTo as `0x${string}`,
          maxTimeoutSeconds: config.x402TimeoutSeconds,
          asset: config.x402Asset as `0x${string}`,
          extra: { name: config.x402TokenName, version: config.x402TokenVersion },
        }),
        verify: x402Verify,
        riskScore: async (): Promise<Record<string, unknown>> => {
          const ctx = getContext ? await getContext() : null;
          return ctx
            ? {
                riskLevel: ctx.riskLevel,
                forceDeRisk: ctx.forceDeRisk,
                pegDeviationBps: ctx.pegDeviationBps,
                flags: ctx.flags,
                asOf: ctx.asOf,
              }
            : { error: "no snapshot yet" };
        },
      }
    : undefined;

const allowedOrigins = config.corsAllowedOrigins.split(",").map((o) => o.trim()).filter(Boolean);
const app = buildServer({ explainClient, getContext, x402, allowedOrigins });

// Wire the autonomous loop when execution prerequisites are configured.
// Graceful read-only mode: if ALLOCATOR_PRIVATE_KEY or VAULT_ADDRESS are absent,
// the scheduler is skipped and the agent serves data-only routes.
if (config.allocatorPrivateKey && config.vaultAddress && pipeline) {
  // Paid-evidence fetcher (A4.1): when a premium x402 feed is configured, the agent
  // pays for it with the allocator account and pins the receipt into each decision.
  let paidEvidence: PaidEvidenceFetcher | undefined;
  const wc = pipeline.clients.walletClient;
  if (config.x402PremiumFeedUrl && wc?.account) {
    const account = wc.account;
    const signer: Eip3009Signer = (def) =>
      wc.signTypedData({ account, ...def } as unknown as Parameters<typeof wc.signTypedData>[0]);
    paidEvidence = buildPaidEvidenceFetcher({
      url: config.x402PremiumFeedUrl,
      from: account.address,
      signer,
      maxPriceBaseUnits: config.x402MaxPriceBaseUnits,
    });
  }

  const executor = new Executor({
    config,
    clients: pipeline.clients,
    snapshotter: pipeline.snapshotter,
    paidEvidence,
  });
  const scheduler = new Scheduler(executor, {
    onError: (e) => app.log.error({ err: e }, "scheduler cycle error"),
    onCycle: (r) => {
      if (r.submitted) {
        app.log.info({ kind: r.kind, decisionId: r.decisionId?.toString(), txHash: r.txHash }, "decision submitted");
        // Capture the cycle's context BEFORE rememberDecision() invalidates the
        // cache, so the alert carries the real risk flags and asOf timestamp.
        const cycleContext = contextCache?.value;
        if (r.decision) rememberDecision(r.decision);
        if (r.kind === "derisk" && r.decision && alertNotifier.isConfigured) {
          alertNotifier
            .notify({
              riskLevel: r.decision.riskLevel,
              flags: cycleContext?.flags ?? [],
              rationale: r.decision.rationale,
              txHash: r.txHash,
              decisionId: r.decisionId?.toString(),
              asOf: cycleContext?.asOf ?? new Date().toISOString(),
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
    app.log.info(`custos-agent listening on ${address}`);
  })
  .catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
