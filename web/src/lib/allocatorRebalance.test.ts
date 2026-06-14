import { describe, it, expect } from "vitest";
import { planRebalance, type PlanInput } from "./allocatorRebalance";
import type { WeightsBps } from "./data";

const TVL = 100_000_000n; // $100 (6-dec)

function base(over: Partial<PlanInput> = {}): PlanInput {
  return {
    current: { IDLE: 10_000, AAVE: 0, USDY: 0, AUSD: 0 },
    // 50% move — exactly the per-tx cap, so the default fixture is valid.
    target: { IDLE: 5_000, AAVE: 5_000, USDY: 0, AUSD: 0 },
    tvlRaw: TVL,
    pegDeviationBps: 0,
    aaveWithdrawableBps: 10_000,
    lastRebalanceAt: 0,
    nowSec: 1_000_000,
    ...over,
  };
}

const w = (IDLE: number, AAVE: number, USDY: number, AUSD: number): WeightsBps => ({ IDLE, AAVE, USDY, AUSD });

describe("planRebalance", () => {
  it("accepts a valid idle→Aave deploy with no swap legs", () => {
    const plan = planRebalance(base());
    expect(plan.valid).toBe(true);
    expect(plan.error).toBe("");
    expect(plan.legs).toHaveLength(0); // Aave needs no swap
  });

  it("rejects weights that do not sum to 100%", () => {
    const plan = planRebalance(base({ target: w(2_000, 7_000, 0, 0) }));
    expect(plan.valid).toBe(false);
    expect(plan.error).toMatch(/total 100%/i);
  });

  it("enforces the per-tx move cap (50%) for non-risk-reducing moves", () => {
    // 80% idle → deploy 60% into Aave: move = 60% > 50%, not risk-reducing.
    const plan = planRebalance(base({ current: w(8_000, 2_000, 0, 0), target: w(2_000, 8_000, 0, 0) }));
    expect(plan.moveBps).toBe(6_000);
    expect(plan.valid).toBe(false);
    expect(plan.error).toMatch(/move too large/i);
  });

  it("exempts a pure USDY de-risk from the move cap", () => {
    // 70% USDY → 0, all into idle: move = 70% > 50% but risk-reducing.
    const plan = planRebalance(base({ current: w(3_000, 0, 7_000, 0), target: w(10_000, 0, 0, 0) }));
    expect(plan.riskReducing).toBe(true);
    expect(plan.valid).toBe(true);
  });

  it("requires the minimum idle buffer", () => {
    // Move stays under the 50% cap and within caps, but idle would drop below 2%.
    const plan = planRebalance(base({ current: w(3_000, 5_000, 2_000, 0), target: w(100, 7_900, 2_000, 0) }));
    expect(plan.valid).toBe(false);
    expect(plan.error).toMatch(/idle must stay/i);
  });

  it("enforces the instant-liquidity floor", () => {
    // Small move into AUSD with no withdrawable Aave: instant = idle only = 10% < 15%.
    const plan = planRebalance(base({ current: w(2_000, 0, 0, 8_000), target: w(1_000, 0, 0, 9_000), aaveWithdrawableBps: 0 }));
    expect(plan.valid).toBe(false);
    expect(plan.error).toMatch(/instant liquidity/i);
  });

  it("blocks new USDY when the peg is off beyond the block threshold", () => {
    const plan = planRebalance(base({ current: w(10_000, 0, 0, 0), target: w(7_000, 0, 3_000, 0), pegDeviationBps: 60 }));
    expect(plan.valid).toBe(false);
    expect(plan.error).toMatch(/peg off/i);
  });

  it("derives deposit/withdraw legs for USDY and AUSD", () => {
    // 50% move (cap), within bucket caps and peg healthy → valid with two deposit legs.
    const plan = planRebalance(base({ current: w(10_000, 0, 0, 0), target: w(5_000, 0, 2_500, 2_500), pegDeviationBps: 10 }));
    expect(plan.valid).toBe(true);
    expect(plan.legs).toEqual([
      { bucket: "USDY", side: "deposit", usdcAmount: (2_500n * TVL) / 10_000n },
      { bucket: "AUSD", side: "deposit", usdcAmount: (2_500n * TVL) / 10_000n },
    ]);
  });

  it("blocks rebalances inside the 1-hour interval", () => {
    const plan = planRebalance(base({ lastRebalanceAt: 1_000_000 - 600, nowSec: 1_000_000 }));
    expect(plan.valid).toBe(false);
    expect(plan.error).toMatch(/next rebalance in/i);
  });
});
