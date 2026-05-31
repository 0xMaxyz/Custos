import { describe, it, expect } from "vitest";
import { vault, position, BUCKETS, decisions, guardrails, identity } from "./data";

describe("vault fixture (dashboard reads)", () => {
  it("allocation weights sum to 100% (10000 bps)", () => {
    const total = BUCKETS.reduce((s, b) => s + vault.weightsBps[b], 0);
    expect(total).toBe(10000);
  });

  it("TVL does not exceed the cap", () => {
    expect(parseFloat(vault.tvlUsdc)).toBeLessThanOrEqual(parseFloat(vault.tvlCapUsdc));
  });

  it("instant-withdrawable buffer is at least the 15% floor", () => {
    const pct = (parseFloat(vault.instantWithdrawableUsdc) / parseFloat(vault.tvlUsdc)) * 100;
    expect(pct).toBeGreaterThanOrEqual(15);
  });

  it("peg deviation is non-negative bps", () => {
    expect(vault.pegDeviationBps).toBeGreaterThanOrEqual(0);
  });
});

describe("position fixture", () => {
  it("value ≈ shares × share price (within rounding)", () => {
    const implied = parseFloat(position.shares) * parseFloat(position.sharePrice);
    const value = parseFloat(position.valueUsdc);
    // sharePrice is displayed at 4dp, so allow sub-0.1% drift from rounding.
    expect(Math.abs(implied - value) / value).toBeLessThan(0.001);
  });
});

describe("decisions fixture (risk-guardian feed)", () => {
  it("is sorted newest-first by id", () => {
    for (let i = 1; i < decisions.length; i++) {
      expect(decisions[i - 1]!.id).toBeGreaterThan(decisions[i]!.id);
    }
  });

  it("every decision keeps post-weights within 100%", () => {
    for (const d of decisions) {
      const total = BUCKETS.reduce((s, b) => s + d.postWeightsBps[b], 0);
      expect(total).toBe(10000);
    }
  });

  it("de-risk decisions (kind 1) zero out or reduce USDY exposure", () => {
    for (const d of decisions.filter((x) => x.kind === 1)) {
      expect(d.postWeightsBps.USDY).toBeLessThanOrEqual(d.preWeightsBps.USDY);
    }
  });
});

describe("guardrails fixture", () => {
  it("exposes the required immutable limits", () => {
    const keys = guardrails.map((g) => g.key);
    for (const required of ["maxUsdy", "minInstant", "maxSlippage", "tvlCap", "perTxCap"]) {
      expect(keys).toContain(required);
    }
  });
});

describe("identity fixture (ERC-8004)", () => {
  it("has an agent id and registry address", () => {
    expect(identity.agentId).toBeTruthy();
    expect(identity.identityRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
