import { describe, it, expect } from "vitest";
import { vault, position, BUCKETS, decisions, guardrails, identity, rwaCore, agentEconomics, tokens, JOB_STATUS } from "./data";

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

describe("RWA core form split (mUSD leg, task 2.7)", () => {
  it("USDY + mUSD value equals the USDY bucket's USD value (conserved across conversion)", () => {
    const split = parseFloat(rwaCore.usdyUsdc) + parseFloat(rwaCore.musdUsdc);
    const bucketUsd = (vault.weightsBps.USDY / 10000) * parseFloat(vault.tvlUsdc);
    expect(split).toBeCloseTo(bucketUsd, 2);
  });

  it("pins the verified mUSD converter address", () => {
    expect(rwaCore.converter.toLowerCase()).toBe(tokens.MUSD.address.toLowerCase());
  });
});

describe("A4 surfaces — x402 receipts + ERC-8183 jobs", () => {
  it("the de-risk decision links a paid receipt for a cited evidence item", () => {
    const derisk = decisions.find((d) => d.kind === 1)!;
    expect(derisk.payments?.length).toBeGreaterThan(0);
    for (const p of derisk.payments ?? []) {
      expect(p.transaction).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(parseFloat(p.amountUsdc)).toBeGreaterThan(0);
      // evidenceId must reference a real evidence item on the decision.
      expect(derisk.evidence.some((e) => e.id === p.evidenceId)).toBe(true);
    }
  });

  it("the de-risk decision carries a Completed ERC-8183 job with reputation", () => {
    const derisk = decisions.find((d) => d.kind === 1)!;
    expect(derisk.job).toBeDefined();
    expect(derisk.job!.status).toBe("Completed");
    expect(derisk.job!.reputation?.score).toBeGreaterThan(0);
  });

  it("agentEconomics jobs all use valid ERC-8183 statuses", () => {
    for (const j of agentEconomics.jobs) {
      expect(Object.keys(JOB_STATUS)).toContain(j.status);
    }
    // a rejected job records no reputation (only justified de-risks do).
    const rejected = agentEconomics.jobs.find((j) => j.status === "Rejected");
    expect(rejected?.reputationScore).toBeNull();
  });
});
