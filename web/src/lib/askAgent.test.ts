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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
