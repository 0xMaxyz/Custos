import { buildServer } from "./server.js";
import { tryLoadConfig } from "./config.js";
import { buildPipeline, type Pipeline } from "./pipeline.js";
import { Executor } from "./executor/index.js";
import { Scheduler } from "./scheduler.js";
import { AnthropicExplainer, type ExplainContext } from "./llm/explain.js";
import { computeFreshContext } from "./context.js";
import { AlertNotifier } from "./alerts.js";
import { assertChainId, makeClients } from "./chain/clients.js";
import { resolveMantleRpcUrls } from "./chain/rpcList.js";
import { GovernanceWatcher } from "./governanceWatch.js";
import { isCycleFailure } from "./executor/errors.js";
import { reconcileJournal } from "./executor/txjournal.js";
import type { Eip3009Signer, PaymentRequirements } from "./payments/x402.js";
import { onChainSettlingVerifier, replayGuardedVerifier, signatureVerifyingVerifier } from "./payments/verifier.js";
import { buildPaidEvidenceFetcher, type PaidEvidenceFetcher } from "./payments/evidence.js";
import { makeIdentityOwnerReader, resolveX402PayTo, PayeeConfigError, type ResolvedPayee } from "./identity/payee.js";
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

// Resolve the agent's RPC rotation ONCE at startup, before any client is built:
// PREMIUM_MANTLE_RPC first, then the live community list + the static MANTLE_RPC_URL(s),
// composed into a comma-separated value that makeTransport turns into a viem `fallback`
// (chain/rpcList.ts). A GitHub/network failure here can't stop boot — the resolver
// falls back to a pinned list, then to the static config.
const baseConfig = result.config;
const rpcUrls = await resolveMantleRpcUrls(baseConfig);
const config = { ...baseConfig, mantleRpcUrl: rpcUrls.join(",") };
process.stderr.write(`Mantle RPC rotation: ${rpcUrls.length} endpoint(s) configured\n`);

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
// O7: the PAID /risk-score path can't tolerate the full 10s context staleness —
// during a fast depeg a 10s-old "all clear" sold for money is unacceptable. It
// asks for a much tighter freshness bound (re-snapshotting otherwise). The
// payment itself bounds abuse of the extra RPC load.
const RISK_SCORE_MAX_AGE_MS = 2_000;
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
// `getFreshContext` only needs the data pipeline — it grounds `/ask` (A3.1),
// `/snapshot` (A2.1), and the paid `/risk-score` (A4.1). Wire it whenever the
// pipeline exists, so a vault+allocator agent exposes `/snapshot` even without
// an Anthropic key. `maxAgeMs` bounds the staleness each caller will accept
// (default CONTEXT_TTL_MS; the paid path passes a tighter bound). See context.ts.
const getFreshContext = pipeline
  ? async (maxAgeMs: number = CONTEXT_TTL_MS): Promise<ExplainContext | null> => {
      const out = await computeFreshContext(
        pipeline.snapshotter,
        recentDecisions,
        contextCache,
        maxAgeMs,
        Date.now(),
      );
      contextCache = out.cache;
      return out.value;
    }
  : undefined;
// `/ask` + `/snapshot` use the default 10s TTL; the paid path passes a tighter bound.
const getContext = getFreshContext;

// Alert notifier (A3.2): fires on de-risk events via Telegram and/or Discord.
const alertNotifier = new AlertNotifier({
  telegramBotToken: config.telegramBotToken,
  telegramChatId: config.telegramChatId,
  discordWebhookUrl: config.discordWebhookUrl,
});

// x402 sell-side payee, bound to the agent's ERC-8004 identity (spec §2.7):
// X402_PAY_TO when set (warning if it differs from ownerOf(AGENT_ID)), else derived
// from the on-chain agent-NFT owner. X402_ASSET is the opt-in — without it nothing
// is sold and no RPC read happens here. Two failure modes, handled differently:
//  - a misconfigured payee (== ALLOCATOR hot key) is an operator error → fail fast;
//  - a transient owner-read failure (derive mode) must NOT kill the agent — selling
//    is an addon, autonomous de-risking is the mission — so disable /risk-score for
//    this run and warn loudly (a restart retries once the RPC recovers).
const x402Payee = await resolveX402PayTo({
  config,
  readOwner:
    config.agentId !== undefined && config.x402Asset
      ? makeIdentityOwnerReader(pipeline?.clients.publicClient ?? makeClients(config).publicClient)
      : undefined,
  warn: (msg) => process.stderr.write(`x402 payee: ${msg}\n`),
}).catch((err: unknown): ResolvedPayee => {
  if (err instanceof PayeeConfigError) {
    process.stderr.write(`Invalid x402 payee: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `x402 payee unresolved (${err instanceof Error ? err.message : String(err)}); ` +
      `/risk-score selling disabled this run — restart once the owner read recovers.\n`,
  );
  return { source: "none" };
});

// x402 paid risk-score endpoint (A4.1). Enabled when a payee resolves + an asset is
// configured. The verifier recovers the EIP-712 signature (real authorization check). With
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
  x402Payee.payTo && config.x402Asset
    ? {
        requirements: (resourceUrl: string): PaymentRequirements => ({
          scheme: "exact",
          network: config.x402Network,
          chainId: MANTLE_MAINNET_CHAIN_ID,
          maxAmountRequired: config.x402PriceBaseUnits.toString(),
          resource: resourceUrl,
          description: "Custos RWA risk score",
          mimeType: "application/json",
          payTo: x402Payee.payTo as `0x${string}`,
          maxTimeoutSeconds: config.x402TimeoutSeconds,
          asset: config.x402Asset as `0x${string}`,
          extra: { name: config.x402TokenName, version: config.x402TokenVersion },
        }),
        verify: x402Verify,
        riskScore: async (): Promise<Record<string, unknown>> => {
          // Paid signal: tolerate at most ~2s of cache age (re-snapshot otherwise).
          const ctx = getFreshContext ? await getFreshContext(RISK_SCORE_MAX_AGE_MS) : null;
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

// Governance-event watcher (security control for the short 6h launch timelock):
// page the operator whenever someone queues/cancels/activates a guardrail change.
// Wired whenever GUARDRAILS_ADDRESS is set, in BOTH read-only and execution modes.
// It only needs a read client, so it reuses the pipeline's publicClient when one
// exists, else spins up a standalone read client. start() snapshots the current
// head (no historical backfill); stop() clears the timer on app close.
let governanceWatcher: GovernanceWatcher | undefined;
const buildGovernanceWatcher = (): GovernanceWatcher | undefined => {
  if (!config.guardrailsAddress) return undefined;
  const publicClient = pipeline?.clients.publicClient ?? makeClients(config).publicClient;
  return new GovernanceWatcher({
    publicClient,
    guardrailsAddress: config.guardrailsAddress as `0x${string}`,
    vaultAddress: config.vaultAddress as `0x${string}` | undefined,
    alertNotifier,
    onError: (err) => app.log.warn({ err }, "governance watcher error"),
    onDebug: (msg) => app.log.debug(msg),
  });
};

const allowedOrigins = config.corsAllowedOrigins.split(",").map((o) => o.trim()).filter(Boolean);
const app = buildServer({ explainClient, getContext, x402, allowedOrigins });

if (x402) {
  app.log.info(
    { payTo: x402Payee.payTo, source: x402Payee.source },
    "x402 paid /risk-score enabled (payee bound to ERC-8004 identity)",
  );
} else if (config.x402Asset) {
  app.log.warn(
    "X402_ASSET is set but /risk-score is not selling — no payee resolved " +
      "(set X402_PAY_TO or AGENT_ID; if owner derivation failed, see the payee warning above)",
  );
}

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
    onDebug: (msg) => app.log.debug(msg),
    onError: (e) => {
      app.log.error({ err: e }, "scheduler cycle error");
      // O1: a REQUIRED de-risk that did not confirm on-chain is a CRITICAL event —
      // page the operator, distinct from the success notification. Other errors
      // (routine RPC blips, rejected proposals) only log. Alert delivery must never
      // throw, so swallow any rejection here too.
      if (isCycleFailure(e) && e.deRiskRequired && alertNotifier.isConfigured) {
        alertNotifier
          .notifyFailure({
            stage: e.stage,
            cause: e.cause instanceof Error ? e.cause.message : String(e.cause),
            txHash: e.txHash,
            asOf: new Date().toISOString(),
          })
          .catch((err: unknown) => app.log.warn({ err }, "critical alert delivery failed"));
      }
    },
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
    // O6: never start the autonomous loop against the wrong network. Verify the RPC
    // serves Mantle mainnet (chainId 5000) before the scheduler can sign any tx.
    await assertChainId(pipeline.clients.publicClient);
    // O4: reconcile any tx left in-flight by a crash BEFORE the scheduler can sign
    // a new one — log the outcome, and page (notifyFailure) if a REQUIRED de-risk
    // never confirmed. No-op when AGENT_STATE_PATH is unset. Never throws.
    await reconcileJournal(config.agentStatePath, pipeline.clients.publicClient, {
      timeoutMs: config.txReceiptTimeoutMs,
      log: (msg) => app.log.info(msg),
      alertFailure: (entry, detail) => {
        if (!alertNotifier.isConfigured) return;
        return alertNotifier
          .notifyFailure({
            stage: "startup-recovery",
            cause: `Unconfirmed required de-risk recovered at startup: ${detail}`,
            txHash: entry.txHash,
            asOf: new Date().toISOString(),
          })
          .catch((err: unknown) => app.log.warn({ err }, "startup-recovery alert delivery failed"));
      },
    });
    scheduler.start();
    app.log.info("autonomous scheduler started (periodic=60m, poll=30s)");
    governanceWatcher = buildGovernanceWatcher();
    if (governanceWatcher) {
      await governanceWatcher.start();
      app.log.info("governance watcher started (poll=60s)");
    }
  });

  app.addHook("onClose", async () => {
    scheduler.stop();
    governanceWatcher?.stop();
  });
} else {
  app.log.warn("ALLOCATOR_PRIVATE_KEY or VAULT_ADDRESS not set — running in read-only mode (no scheduler)");
  // Read-only mode still talks to the RPC (snapshots / explainer). Verify the
  // chain-id once at startup when a pipeline (and thus an RPC client) exists, so a
  // misconfigured RPC is caught early rather than surfacing as confusing read data.
  if (pipeline) {
    app.addHook("onReady", async () => {
      await assertChainId(pipeline.clients.publicClient);
    });
  }
  // The governance watcher needs no allocator/vault — wire it in read-only mode too
  // whenever GUARDRAILS_ADDRESS is set, so queued config changes are still paged.
  if (config.guardrailsAddress) {
    app.addHook("onReady", async () => {
      governanceWatcher = buildGovernanceWatcher();
      if (governanceWatcher) {
        await governanceWatcher.start();
        app.log.info("governance watcher started (poll=60s, read-only mode)");
      }
    });
    app.addHook("onClose", async () => {
      governanceWatcher?.stop();
    });
  }
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
