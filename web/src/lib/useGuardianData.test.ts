import { describe, it, expect } from "vitest";
import { useDecisions, useDecision, useIdentity } from "./useGuardianData";
import { decisions } from "./data";

// These hooks are pure fixture seams (no React state) until contracts deploy, so
// they can be called directly in a unit test.

describe("useDecisions", () => {
  it("returns the fixture feed flagged not-live", () => {
    const r = useDecisions();
    expect(r.isLive).toBe(false);
    expect(r.decisions).toBe(decisions);
    expect(r.decisions.length).toBeGreaterThan(0);
  });
});

describe("useDecision", () => {
  it("looks up a decision by id", () => {
    const d = useDecision(14);
    expect(d?.id).toBe(14);
    expect(d?.kind).toBe(1); // de-risk
  });

  it("returns undefined for an unknown id", () => {
    expect(useDecision(9999)).toBeUndefined();
  });
});

describe("useIdentity", () => {
  it("returns identity + a derived baseline summary, not-live", () => {
    const r = useIdentity();
    expect(r.isLive).toBe(false);
    expect(r.identity.agentId).toBe(7);
    // Derived from the canonical baseline fixture (custos 45 − passive -3 = 48).
    expect(r.baseline.deltaBps).toBe(48);
    expect(r.baseline.custosAhead).toBe(true);
  });
});
