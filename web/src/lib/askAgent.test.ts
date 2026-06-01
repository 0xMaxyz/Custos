import { describe, it, expect, vi, afterEach } from "vitest";
import { askAgent, isAgentLive } from "./askAgent";

// VITE_AGENT_API_URL is unset in the test env, so the helper runs the fixture path.
describe("askAgent (demo/fixture path)", () => {
  it("is not live without VITE_AGENT_API_URL", () => {
    expect(isAgentLive).toBe(false);
  });

  it("returns a fixture answer for a known question", async () => {
    const res = await askAgent("Why am I in AUSD right now?");
    expect(res.live).toBe(false);
    expect(res.answer.length).toBeGreaterThan(0);
  });

  it("returns a generic fallback for an unknown question", async () => {
    const res = await askAgent("what is the meaning of life?");
    expect(res.live).toBe(false);
    expect(res.answer).toContain("decision history");
    expect(res.asOf).toBeUndefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe("askAgent (live path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("threads asOf from a successful /ask response", async () => {
    vi.stubEnv("VITE_AGENT_API_URL", "http://agent.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          answer: "You are in AUSD because of elevated RWA risk.",
          asOf: "2026-06-01T12:00:00.000Z",
        }),
      }),
    );
    vi.resetModules();
    const { askAgent: liveAsk } = await import("./askAgent.js");
    const res = await liveAsk("Why am I in AUSD?");
    expect(res.live).toBe(true);
    expect(res.asOf).toBe("2026-06-01T12:00:00.000Z");
    expect(res.answer).toContain("AUSD");
  });
});
