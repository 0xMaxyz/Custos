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
}

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
    "🚨 Sentinel de-risk triggered",
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

  constructor(config: AlertConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
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
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`Telegram ${res.status}: ${body}`);
    }
  }

  private async _sendDiscord(text: string): Promise<void> {
    const { discordWebhookUrl } = this.config;
    if (!discordWebhookUrl) return;
    const res = await this.fetchFn(discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`Discord ${res.status}: ${body}`);
    }
  }
}
