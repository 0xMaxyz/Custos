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
    const message = formatAlert(alert);
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
