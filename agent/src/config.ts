import { z } from "zod";

/**
 * Typed, validated runtime configuration for the agent service.
 *
 * `loadConfig()` reads from a provided env record (defaults to `process.env`) so
 * tests can inject values without mutating global state. Secrets are required
 * only for the paths that use them — the loader keeps optional integrations
 * (LLM, 1delta, IPFS, signer) optional so read-only/dev runs don't need them.
 */

/** A 0x-prefixed hex string of arbitrary length (validated shape only). */
const hexString = z.string().regex(/^0x[0-9a-fA-F]+$/, "must be a 0x-prefixed hex string");

/** A 32-byte private key: 0x + 64 hex chars. */
const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key");

const configSchema = z.object({
  // ── Chain / RPC ──
  // One URL, or several comma-separated provider URLs. With more than one, the agent
  // builds a viem `fallback` transport that fails over (and spreads overflow) across
  // them when a provider returns 429 / errors — so a single rate-limited public RPC
  // can't stall the agent. See chain/clients.ts.
  mantleRpcUrl: z
    .string()
    .refine(
      (s) => {
        const urls = s.split(",").map((u) => u.trim()).filter(Boolean);
        return urls.length > 0 && urls.every((u) => z.string().url().safeParse(u).success);
      },
      { message: "must be one or more comma-separated http(s) RPC URLs" },
    ),
  // Optional premium endpoint (e.g. goldsky). When set it is pinned FIRST in the
  // agent's RPC rotation (chain/rpcList.ts) so it serves all traffic while healthy,
  // with the community + static lists as failover. Keeps a single rate-limited
  // public RPC from stalling the agent.
  premiumMantleRpc: z.string().url().optional(),
  // How long to wait for a submitted tx's receipt before treating the cycle as a
  // loud failure (O2). Bounded waiting only — no fee-bump/replacement machinery.
  txReceiptTimeoutMs: z.coerce.number().int().positive().default(120_000),
  // O4: optional path to a tiny JSON tx-journal. When set, the executor persists
  // the last submitted tx (hash + kind + deRiskRequired) BEFORE awaiting its
  // receipt, and clears it on confirmation, so a crash mid-flight can be
  // reconciled at startup. Unset -> journaling is a no-op.
  agentStatePath: z.string().min(1).optional(),

  // ── LLM (optional until PR-3b) ──
  anthropicApiKey: z.string().min(1).optional(),
  anthropicModel: z.string().min(1).default("claude-haiku-4-5-20251001"),
  // Optional override of the Anthropic-compatible API base URL (e.g. to point the
  // SDK at a GLM/other Anthropic-compatible gateway). Unset = the SDK default.
  anthropicBaseUrl: z.string().url().optional(),
  // ── Demo de-risk scenario (optional; for the demo video — see docs/demo.md) ──
  // When set, the evidence fetcher swaps the curated `ondo-usdy-attestation` feed's
  // URL for this staged document (id/type/source kept unchanged, so it stays
  // de-risk-eligible under N2). Lets us stage a concrete, cited USDY threat to
  // demonstrate the LLM-driven de-risk on camera. Unset = zero behaviour change
  // (production untouched). The triggering document is synthetic; the fetch, the AI
  // judgment, the guardrail validation, and the on-chain de-risk are all real.
  demoDeRiskEvidenceUrl: z.string().url().optional(),

  // ── 1delta data (optional; data + swap routing/quoting, output never trusted) ──
  oneDeltaApiKey: z.string().min(1).optional(),
  oneDeltaBaseUrl: z.string().url().default("https://portal.1delta.io"),
  // Timeout (ms) for the 1delta swap-BUILD call (/actions/swap/spot with account set).
  // Building a route through Mantle's thin, split USDY/AUSD pools is far heavier than
  // the cheap data reads, so it gets its own, longer budget; the default 10s aborted
  // legitimate builds (502 on rebalance-to-USDY). Bump if routes are still slow.
  oneDeltaSwapTimeoutMs: z.coerce.number().int().positive().default(30_000),

  // ── Signer (optional until execution path; guardrail-bounded hot key) ──
  allocatorPrivateKey: privateKey.optional(),
  // ALLOCATOR address without the key — lets keyless runs (read-only mode,
  // `card:pin`) still enforce the never-pay-the-allocator guard and supply the
  // agent card's `wallet` field (identity/payee.ts, scripts/pinAgentCard.ts).
  allocatorAddress: hexString.optional(),

  // ── IPFS pinning (optional until execution path) ──
  ipfsApiUrl: z.string().url().optional(),
  ipfsPinningJwt: z.string().min(1).optional(),
  ipfsGatewayUrl: z.string().url().default("https://gateway.pinata.cloud"),

  // ── Contract addresses (resolved at deploy time; optional for read-only dev) ──
  vaultAddress: hexString.optional(),
  guardrailsAddress: hexString.optional(),
  benchmarkAddress: hexString.optional(),
  // ERC-8004 agent token id (printed by RegisterIdentity.s.sol). Token ids are
  // uint256, so parse as bigint. Used to reconcile/derive the x402 sell-side payee
  // from the on-chain agent-NFT owner (identity/payee.ts).
  // ASSUMPTION: the canonical IdentityRegistry mints ids from 1 (0 = "no agent", and
  // ownerOf(0) reverts), so `.positive()` rejects a 0 that could only be a misconfig.
  // If a registry is ever observed to issue id 0, relax this to `.nonnegative()`.
  agentId: z.coerce.bigint().positive().optional(),

  // ── Alerts (optional; A3.2) ──
  telegramBotToken: z.string().min(1).optional(),
  telegramChatId: z.string().min(1).optional(),
  discordWebhookUrl: z.string().url().optional(),

  // ── x402 micropayments (optional; A4.1) ──
  // When `x402PayTo` is set, the agent sells its RWA risk score at `GET /risk-score`
  // for `x402PriceBaseUnits` of `x402Asset` (an EIP-3009/USDC-style token). The
  // token name/version populate the EIP-712 domain used to verify the payment.
  x402PayTo: hexString.optional(),
  x402Asset: hexString.optional(),
  x402PriceBaseUnits: z.coerce.bigint().nonnegative().default(10_000n), // 0.01 USDC (6-dec)
  x402Network: z.string().min(1).default("mantle"),
  x402TokenName: z.string().min(1).default("USD Coin"),
  x402TokenVersion: z.string().min(1).default("2"),
  x402TimeoutSeconds: z.coerce.number().int().positive().default(120),
  // Optional premium feed the agent PAYS for via x402; its settlement receipt is
  // pinned into the decision evidence bundle.
  x402PremiumFeedUrl: z.string().url().optional(),
  // Hard ceiling (base units) on what the agent will pay per premium-feed call.
  // Required whenever X402_PREMIUM_FEED_URL is set so a malicious/compromised feed
  // can never make the agent sign a counterparty-dictated amount above an operator-set
  // limit. Enforced before signing in `createPayment` (N1).
  x402MaxPriceBaseUnits: z.coerce.bigint().nonnegative().optional(),
  // When true (and an ALLOCATOR wallet is present), /risk-score SETTLES inbound
  // payments on-chain via transferWithAuthorization; otherwise it verifies the
  // EIP-712 signature and delegates settlement to a facilitator.
  x402SettleOnChain: z.preprocess(
    (v) => (typeof v === "string" ? v.toLowerCase() === "true" : v),
    z.boolean().default(false),
  ),

  // ── Service ──
  agentPort: z.coerce.number().int().positive().default(8080),
  agentLogLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  // Comma-separated CORS allowlist for the public read-only endpoints. Default "*"
  // keeps local cross-port dev working; set specific origins before exposing any
  // authenticated/mutating endpoint (L5).
  corsAllowedOrigins: z.string().default("*"),
}).superRefine((cfg, ctx) => {
  // The x402 paid endpoint needs an asset (EIP-712 verifyingContract) to settle in.
  if (cfg.x402PayTo && !cfg.x402Asset) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["x402Asset"],
      message: "X402_ASSET is required when X402_PAY_TO is set",
    });
  }
  // A premium feed the agent pays for must carry an operator-set spend ceiling, so a
  // compromised feed URL can't make the agent sign an arbitrary (balance-draining)
  // amount taken straight from the counterparty's 402 response (N1).
  if (cfg.x402PremiumFeedUrl && cfg.x402MaxPriceBaseUnits === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["x402MaxPriceBaseUnits"],
      message: "X402_MAX_PRICE_BASE_UNITS is required when X402_PREMIUM_FEED_URL is set",
    });
  }
});

export type AgentConfig = z.infer<typeof configSchema>;

/** Raw env shape consumed by {@link loadConfig}. */
export type EnvRecord = Record<string, string | undefined>;

/**
 * Map raw process env (SCREAMING_SNAKE_CASE) onto the schema's camelCase keys.
 * Empty strings are treated as "unset" so a populated-but-blank `.env` line
 * doesn't fail an `.optional()` field.
 */
function toSchemaShape(env: EnvRecord): Record<string, unknown> {
  const pick = (key: string): string | undefined => {
    const v = env[key];
    return v === undefined || v === "" ? undefined : v;
  };
  return {
    mantleRpcUrl: pick("MANTLE_RPC_URL"),
    premiumMantleRpc: pick("PREMIUM_MANTLE_RPC"),
    txReceiptTimeoutMs: pick("TX_RECEIPT_TIMEOUT_MS"),
    agentStatePath: pick("AGENT_STATE_PATH"),
    anthropicApiKey: pick("ANTHROPIC_API_KEY"),
    anthropicModel: pick("ANTHROPIC_MODEL"),
    anthropicBaseUrl: pick("ANTHROPIC_BASE_URL"),
    demoDeRiskEvidenceUrl: pick("DEMO_DERISK_EVIDENCE_URL"),
    oneDeltaApiKey: pick("ONEDELTA_API_KEY"),
    oneDeltaBaseUrl: pick("ONEDELTA_BASE_URL"),
    oneDeltaSwapTimeoutMs: pick("ONEDELTA_SWAP_TIMEOUT_MS"),
    allocatorPrivateKey: pick("ALLOCATOR_PRIVATE_KEY"),
    allocatorAddress: pick("ALLOCATOR_ADDRESS"),
    ipfsApiUrl: pick("IPFS_API_URL"),
    ipfsPinningJwt: pick("IPFS_PINNING_JWT"),
    ipfsGatewayUrl: pick("IPFS_GATEWAY_URL"),
    vaultAddress: pick("VAULT_ADDRESS"),
    guardrailsAddress: pick("GUARDRAILS_ADDRESS"),
    benchmarkAddress: pick("BENCHMARK_ADDRESS"),
    agentId: pick("AGENT_ID"),
    telegramBotToken: pick("TELEGRAM_BOT_TOKEN"),
    telegramChatId: pick("TELEGRAM_CHAT_ID"),
    discordWebhookUrl: pick("DISCORD_WEBHOOK_URL"),
    x402PayTo: pick("X402_PAY_TO"),
    x402Asset: pick("X402_ASSET"),
    x402PriceBaseUnits: pick("X402_PRICE_BASE_UNITS"),
    x402Network: pick("X402_NETWORK"),
    x402TokenName: pick("X402_TOKEN_NAME"),
    x402TokenVersion: pick("X402_TOKEN_VERSION"),
    x402TimeoutSeconds: pick("X402_TIMEOUT_SECONDS"),
    x402PremiumFeedUrl: pick("X402_PREMIUM_FEED_URL"),
    x402MaxPriceBaseUnits: pick("X402_MAX_PRICE_BASE_UNITS"),
    x402SettleOnChain: pick("X402_SETTLE_ONCHAIN"),
    agentPort: pick("AGENT_PORT"),
    agentLogLevel: pick("AGENT_LOG_LEVEL"),
    corsAllowedOrigins: pick("CORS_ALLOWED_ORIGINS"),
  };
}

/**
 * Parse + validate config from env. Throws a {@link z.ZodError} on invalid or
 * missing required values.
 */
export function loadConfig(env: EnvRecord = process.env): AgentConfig {
  return configSchema.parse(toSchemaShape(env));
}

/**
 * Like {@link loadConfig} but returns a discriminated result instead of throwing,
 * so callers can surface a friendly aggregated error at startup.
 */
export function tryLoadConfig(
  env: EnvRecord = process.env,
): { ok: true; config: AgentConfig } | { ok: false; error: z.ZodError } {
  const parsed = configSchema.safeParse(toSchemaShape(env));
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, error: parsed.error };
}
