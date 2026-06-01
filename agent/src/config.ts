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
  mantleRpcUrl: z.string().url(),
  forkBlockNumber: z.coerce.bigint().optional(),

  // ── LLM (optional until PR-3b) ──
  anthropicApiKey: z.string().min(1).optional(),
  anthropicModel: z.string().min(1).default("claude-haiku-4-5-20251001"),

  // ── 1delta data (optional; data + optional swap routing ONLY) ──
  oneDeltaApiKey: z.string().min(1).optional(),
  oneDeltaBaseUrl: z.string().url().default("https://api.1delta.io"),

  // ── Signer (optional until execution path; guardrail-bounded hot key) ──
  allocatorPrivateKey: privateKey.optional(),

  // ── IPFS pinning (optional until execution path) ──
  ipfsApiUrl: z.string().url().optional(),
  ipfsPinningJwt: z.string().min(1).optional(),
  ipfsGatewayUrl: z.string().url().default("https://gateway.pinata.cloud"),

  // ── Contract addresses (resolved at deploy time; optional for read-only dev) ──
  vaultAddress: hexString.optional(),
  guardrailsAddress: hexString.optional(),
  benchmarkAddress: hexString.optional(),

  // ── Alerts (optional; A3.2) ──
  telegramBotToken: z.string().min(1).optional(),
  telegramChatId: z.string().min(1).optional(),
  discordWebhookUrl: z.string().url().optional(),

  // ── Service ──
  agentPort: z.coerce.number().int().positive().default(8080),
  agentLogLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
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
    forkBlockNumber: pick("FORK_BLOCK_NUMBER"),
    anthropicApiKey: pick("ANTHROPIC_API_KEY"),
    anthropicModel: pick("ANTHROPIC_MODEL"),
    oneDeltaApiKey: pick("ONEDELTA_API_KEY"),
    oneDeltaBaseUrl: pick("ONEDELTA_BASE_URL"),
    allocatorPrivateKey: pick("ALLOCATOR_PRIVATE_KEY"),
    ipfsApiUrl: pick("IPFS_API_URL"),
    ipfsPinningJwt: pick("IPFS_PINNING_JWT"),
    ipfsGatewayUrl: pick("IPFS_GATEWAY_URL"),
    vaultAddress: pick("VAULT_ADDRESS"),
    guardrailsAddress: pick("GUARDRAILS_ADDRESS"),
    benchmarkAddress: pick("BENCHMARK_ADDRESS"),
    telegramBotToken: pick("TELEGRAM_BOT_TOKEN"),
    telegramChatId: pick("TELEGRAM_CHAT_ID"),
    discordWebhookUrl: pick("DISCORD_WEBHOOK_URL"),
    agentPort: pick("AGENT_PORT"),
    agentLogLevel: pick("AGENT_LOG_LEVEL"),
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
