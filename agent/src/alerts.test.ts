import { describe, it, expect, vi } from "vitest";
import { AlertNotifier, formatAlert, type DeRiskAlert } from "./alerts.js";

const ALERT: DeRiskAlert = {
  riskLevel: "DERISK",
  flags: ["PEG_DE_RISK"],
  rationale: "USDY DEX spot fell 122 bps below oracle NAV.",
  txHash: "0xdeadbeef",
  decisionId: "7",
  asOf: "2026-06-01T12:00:00.000Z",
};

describe("formatAlert", () => {
  it("includes key fields in the message", () => {
    const msg = formatAlert(ALERT);
    expect(msg).toContain("de-risk triggered");
    expect(msg).toContain("DERISK");
    expect(msg).toContain("PEG_DE_RISK");
    expect(msg).toContain(ALERT.rationale);
    expect(msg).toContain("0xdeadbeef");
    expect(msg).toContain("2026-06-01");
  });

  it("omits NONE from flags string", () => {
    const msg = formatAlert({ ...ALERT, flags: ["NONE"] });
    expect(msg).toContain("Flags: none");
    expect(msg).not.toContain("NONE");
  });

  it("omits txHash and decisionId when absent", () => {
    const msg = formatAlert({ ...ALERT, txHash: undefined, decisionId: undefined });
    expect(msg).not.toContain("Tx:");
    expect(msg).not.toContain("Decision ID:");
  });
});

describe("AlertNotifier", () => {
  function makeNotifier(overrides: { telegram?: boolean; discord?: boolean } = {}) {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    const config = {
      telegramBotToken: overrides.telegram !== false ? "bot-token" : undefined,
      telegramChatId: overrides.telegram !== false ? "123456" : undefined,
      discordWebhookUrl: overrides.discord !== false ? "https://discord.com/api/webhooks/test" : undefined,
    };
    return { notifier: new AlertNotifier(config, mockFetch), mockFetch };
  }

  it("reports isConfigured when both channels are set", () => {
    const { notifier } = makeNotifier();
    expect(notifier.isConfigured).toBe(true);
  });

  it("reports isConfigured=false when neither channel is set", () => {
    const notifier = new AlertNotifier({});
    expect(notifier.isConfigured).toBe(false);
  });

  it("sends to both Telegram and Discord", async () => {
    const { notifier, mockFetch } = makeNotifier();
    await notifier.notify(ALERT);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const urls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("api.telegram.org"))).toBe(true);
    expect(urls.some((u) => u.includes("discord.com"))).toBe(true);
  });

  it("sends only to Telegram when Discord is absent", async () => {
    const { notifier, mockFetch } = makeNotifier({ discord: false });
    await notifier.notify(ALERT);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0]![0] as string)).toContain("api.telegram.org");
  });

  it("sends only to Discord when Telegram is absent", async () => {
    const { notifier, mockFetch } = makeNotifier({ telegram: false });
    await notifier.notify(ALERT);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0]![0] as string)).toContain("discord.com");
  });

  it("does not throw when both channels fail", async () => {
    const failFetch = vi.fn().mockResolvedValue({ ok: false, text: async () => "internal error" });
    const notifier = new AlertNotifier(
      { telegramBotToken: "t", telegramChatId: "c", discordWebhookUrl: "https://discord.com/api/webhooks/x" },
      failFetch,
    );
    await expect(notifier.notify(ALERT)).resolves.toBeUndefined();
  });

  it("sends Telegram body with chat_id and text", async () => {
    const { notifier, mockFetch } = makeNotifier({ discord: false });
    await notifier.notify(ALERT);
    const [, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.chat_id).toBe("123456");
    expect(body.text).toContain("de-risk triggered");
  });

  it("sends Discord body with content field", async () => {
    const { notifier, mockFetch } = makeNotifier({ telegram: false });
    await notifier.notify(ALERT);
    const [, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.content).toContain("de-risk triggered");
  });
});
