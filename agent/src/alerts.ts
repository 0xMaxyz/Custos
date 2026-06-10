/**
 * A3.2 — Alert notifier.
 *
 * Fires on de-risk events via Telegram and/or Discord webhook. Both channels
 * are optional; the notifier is a no-op when neither is configured. Never
 * throws — alert delivery failures are logged but must not crash the agent.
 */

export interface AlertConfig {
  telegramBotToken?: string | undefined;
  telegramChatId?: string | undefined;
  discordWebhookUrl?: string | undefined;
  /**
   * Per-request webhook timeout (ms). A hung Telegram/Discord endpoint must not
   * stall the scheduler's `onCycle` callback and delay the next cycle (N4).
   */
  timeoutMs?: number | undefined;
}

/** Default webhook delivery timeout — short enough not to delay the next cycle. */
export const DEFAULT_ALERT_TIMEOUT_MS = 5_000;

export interface DeRiskAlert {
  riskLevel: string;
  flags: string[];
  rationale: string;
  txHash?: string | undefined;
  decisionId?: string | undefined;
  asOf: string;
}

/**
 * A failure alert (O1): a de-risk that was REQUIRED (deterministic force or LLM
 * verdict) did not confirm on-chain. Distinct from {@link DeRiskAlert} (success)
 * so operators can page on it differently.
 */
export interface FailureAlert {
  /** Where the cycle failed (e.g. "submit", "receipt"). */
  stage: string;
  /** Human-readable cause (error message). */
  cause: string;
  /** Broadcast tx hash, if the failure happened after the tx was sent. */
  txHash?: string | undefined;
  asOf: string;
}

/** Returns the CRITICAL plain-text message for a failed required de-risk. */
export function formatFailureAlert(alert: FailureAlert): string {
  const lines = [
    "🔴 CRITICAL: Custos de-risk FAILED to confirm",
    "A required de-risk did NOT execute on-chain — the vault may still be exposed.",
    `Stage: ${alert.stage}`,
    `Cause: ${alert.cause}`,
  ];
  if (alert.txHash) lines.push(`Tx: ${alert.txHash}`);
  lines.push(`At: ${alert.asOf}`);
  return lines.join("\n");
}

/** Returns the plain-text message sent to both channels. */
export function formatAlert(alert: DeRiskAlert): string {
  const flagStr = alert.flags.filter((f) => f !== "NONE").join(", ") || "none";
  const lines = [
    "🚨 Custos de-risk triggered",
    `Risk level: ${alert.riskLevel}`,
    `Flags: ${flagStr}`,
    `Rationale: ${alert.rationale}`,
  ];
  if (alert.decisionId) lines.push(`Decision ID: ${alert.decisionId}`);
  if (alert.txHash) lines.push(`Tx: ${alert.txHash}`);
  lines.push(`At: ${alert.asOf}`);
  return lines.join("\n");
}

export class AlertNotifier {
  private readonly config: AlertConfig;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: AlertConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS;
  }

  /**
   * POST JSON with a bounded timeout. A hung webhook is aborted after `timeoutMs`
   * (the rejection is swallowed by the caller's `Promise.allSettled`), so a slow
   * endpoint can never stall the scheduler.
   */
  private async _postJson(url: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  get isConfigured(): boolean {
    const { telegramBotToken, telegramChatId, discordWebhookUrl } = this.config;
    return !!(discordWebhookUrl || (telegramBotToken && telegramChatId));
  }

  async notify(alert: DeRiskAlert): Promise<void> {
    await this._send(formatAlert(alert));
  }

  /**
   * Fire a CRITICAL failure alert (O1) for a required de-risk that did not confirm.
   * Like {@link notify}, never throws — delivery failures are swallowed so the
   * scheduler's failure path can't crash on a hung webhook.
   */
  async notifyFailure(alert: FailureAlert): Promise<void> {
    await this._send(formatFailureAlert(alert));
  }

  private async _send(message: string): Promise<void> {
    await Promise.allSettled([
      this._sendTelegram(message),
      this._sendDiscord(message),
    ]);
  }

  private async _sendTelegram(text: string): Promise<void> {
    const { telegramBotToken, telegramChatId } = this.config;
    if (!telegramBotToken || !telegramChatId) return;
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    // Plain-text body: no parse_mode, so special chars in rationale (& < >)
    // never trip Telegram's HTML/Markdown parser.
    const res = await this._postJson(url, { chat_id: telegramChatId, text });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`Telegram ${res.status}: ${body}`);
    }
  }

  private async _sendDiscord(text: string): Promise<void> {
    const { discordWebhookUrl } = this.config;
    if (!discordWebhookUrl) return;
    const res = await this._postJson(discordWebhookUrl, { content: text });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`Discord ${res.status}: ${body}`);
    }
  }
}
