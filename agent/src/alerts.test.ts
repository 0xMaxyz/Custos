import { describe, it, expect, vi } from "vitest";
import { AlertNotifier, formatAlert, formatFailureAlert, type DeRiskAlert, type FailureAlert } from "./alerts.js";

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

  it("passes an AbortSignal on each webhook request (N4)", async () => {
    const { notifier, mockFetch } = makeNotifier();
    await notifier.notify(ALERT);
    for (const call of mockFetch.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("aborts a hung webhook after the timeout instead of stalling the scheduler (N4)", async () => {
    vi.useFakeTimers();
    try {
      // Never resolves on its own; only the abort signal can settle it.
      const hangingFetch = vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      );
      const notifier = new AlertNotifier(
        { telegramBotToken: "t", telegramChatId: "c", timeoutMs: 5_000 },
        hangingFetch as unknown as typeof fetch,
      );
      const pending = notifier.notify(ALERT);
      await vi.advanceTimersByTimeAsync(5_000); // trip the timeout → abort → reject → swallowed
      await expect(pending).resolves.toBeUndefined();
      expect(hangingFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  // ── O1: CRITICAL failure alert (required de-risk did not confirm) ─────────────

  it("notifyFailure() sends a CRITICAL message distinct from the success alert (O1)", async () => {
    const { notifier, mockFetch } = makeNotifier();
    const failure: FailureAlert = {
      stage: "receipt",
      cause: "timeout waiting for receipt",
      txHash: "0xfeedface",
      asOf: "2026-06-01T12:00:00.000Z",
    };
    await notifier.notifyFailure(failure);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as Record<string, string>;
    const text = body.text ?? body.content;
    expect(text).toContain("CRITICAL");
    expect(text).toContain("FAILED");
    expect(text).toContain("receipt");
    expect(text).toContain("0xfeedface");
    expect(text).not.toContain("de-risk triggered"); // not the success message
  });

  it("notifyFailure() never throws when delivery fails", async () => {
    const failFetch = vi.fn().mockResolvedValue({ ok: false, text: async () => "boom" });
    const notifier = new AlertNotifier(
      { telegramBotToken: "t", telegramChatId: "c", discordWebhookUrl: "https://discord.com/api/webhooks/x" },
      failFetch,
    );
    await expect(
      notifier.notifyFailure({ stage: "submit", cause: "revert", asOf: "2026-06-01T12:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });
});

describe("formatFailureAlert", () => {
  it("renders a CRITICAL message with stage, cause and tx", () => {
    const msg = formatFailureAlert({
      stage: "receipt",
      cause: "tx never confirmed",
      txHash: "0xabc",
      asOf: "2026-06-01T12:00:00.000Z",
    });
    expect(msg).toContain("CRITICAL");
    expect(msg).toContain("Stage: receipt");
    expect(msg).toContain("Cause: tx never confirmed");
    expect(msg).toContain("Tx: 0xabc");
  });

  it("omits the Tx line when no hash is present", () => {
    const msg = formatFailureAlert({ stage: "submit", cause: "reverted", asOf: "2026-06-01T12:00:00.000Z" });
    expect(msg).not.toContain("Tx:");
  });
});
