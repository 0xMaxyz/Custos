import { describe, it, expect } from "vitest";
import {
  previewDeposit,
  depositStepIndex,
  isDepositBusy,
  nextDepositPhase,
  failDeposit,
  previewWithdraw,
  isWithdrawBusy,
  PER_TX_DEPOSIT_CAP,
  type DepositPhase,
} from "./txMachine";

// ── Deposit preview ─────────────────────────────────────────────────────────

describe("previewDeposit", () => {
  const base = { walletBalance: 12_500, tvl: 30_000, tvlCap: 50_000, sharePrice: 1.0047 };

  it("computes shares out at the current share price", () => {
    const p = previewDeposit({ ...base, amount: "1000" });
    expect(p.sharesOut).toBeCloseTo(1000 / 1.0047, 6);
    expect(p.valid).toBe(true);
    expect(p.error).toBeNull();
  });

  it("blank/zero amount is not valid (no error shown)", () => {
    const p = previewDeposit({ ...base, amount: "" });
    expect(p.amount).toBe(0);
    expect(p.valid).toBe(false);
    expect(p.error).toBeNull();
  });

  it("rejects amounts over the wallet balance", () => {
    const p = previewDeposit({ ...base, amount: "13000" });
    expect(p.error).toBe("Exceeds wallet balance");
    expect(p.valid).toBe(false);
  });

  it("rejects amounts over the per-tx cap before the capacity check", () => {
    // balance high enough to pass the balance check, amount over the 10k cap.
    const p = previewDeposit({ ...base, walletBalance: 20_000, amount: "10001" });
    expect(p.error).toBe(`Over per-tx cap of $${PER_TX_DEPOSIT_CAP.toLocaleString("en-US")}`);
  });

  it("rejects amounts over remaining vault capacity", () => {
    // capacity = 50k - 48k = 2k; amount 3k is within balance + cap but over capacity.
    const p = previewDeposit({ ...base, tvl: 48_000, amount: "3000" });
    expect(p.error).toBe("Only $2,000 of vault capacity left");
  });

  it("maxDepositable is the min of balance, per-tx cap and capacity", () => {
    expect(previewDeposit({ ...base, amount: "" }).maxDepositable).toBe(10_000); // capped by per-tx
    expect(previewDeposit({ ...base, walletBalance: 500, amount: "" }).maxDepositable).toBe(500);
    expect(
      previewDeposit({ ...base, tvl: 49_200, amount: "" }).maxDepositable,
    ).toBe(800); // capped by capacity
  });

  it("clamps remaining capacity at zero when the vault is full", () => {
    const p = previewDeposit({ ...base, tvl: 51_000, amount: "" });
    expect(p.remainingCapacity).toBe(0);
    expect(p.maxDepositable).toBe(0);
  });
});

// ── Deposit phase machine ──────────────────────────────────────────────────────

describe("deposit phase machine", () => {
  it("advances form → approving → approved → depositing → done", () => {
    let phase: DepositPhase = "form";
    const seen: DepositPhase[] = [phase];
    for (let i = 0; i < 4; i++) {
      phase = nextDepositPhase(phase);
      seen.push(phase);
    }
    expect(seen).toEqual(["form", "approving", "approved", "depositing", "done"]);
  });

  it("done is terminal", () => {
    expect(nextDepositPhase("done")).toBe("done");
  });

  it("maps phases onto stepper indices", () => {
    expect(depositStepIndex("form")).toBe(0);
    expect(depositStepIndex("approving")).toBe(0);
    expect(depositStepIndex("approved")).toBe(1);
    expect(depositStepIndex("depositing")).toBe(1);
    expect(depositStepIndex("done")).toBe(1);
  });

  it("reports busy only while a tx is in flight", () => {
    expect(isDepositBusy("approving")).toBe(true);
    expect(isDepositBusy("depositing")).toBe(true);
    expect(isDepositBusy("form")).toBe(false);
    expect(isDepositBusy("approved")).toBe(false);
    expect(isDepositBusy("done")).toBe(false);
  });

  it("failDeposit short-circuits to failed", () => {
    expect(failDeposit()).toBe("failed");
  });
});

// ── Withdraw preview ───────────────────────────────────────────────────────────

describe("previewWithdraw", () => {
  const base = {
    positionUsdc: 30_142.5,
    positionShares: 30_000,
    instantUsdc: 15_000,
    sharePrice: 1.0047,
  };

  it("USDC unit: derives shares burned", () => {
    const p = previewWithdraw({ ...base, unit: "USDC", amount: "1000" });
    expect(p.usdcOut).toBe(1000);
    expect(p.sharesIn).toBeCloseTo(1000 / 1.0047, 6);
    expect(p.valid).toBe(true);
  });

  it("shares unit: derives USDC out", () => {
    const p = previewWithdraw({ ...base, unit: "shares", amount: "1000" });
    expect(p.sharesIn).toBe(1000);
    expect(p.usdcOut).toBeCloseTo(1000 * 1.0047, 6);
  });

  it("flags withdrawals exceeding instant liquidity", () => {
    const small = previewWithdraw({ ...base, unit: "USDC", amount: "5000" });
    expect(small.exceedsInstant).toBe(false);
    const large = previewWithdraw({ ...base, unit: "USDC", amount: "20000" });
    expect(large.exceedsInstant).toBe(true);
  });

  it("rejects amounts beyond the position (with epsilon tolerance at the max)", () => {
    const over = previewWithdraw({ ...base, unit: "shares", amount: "30001" });
    expect(over.error).toBe("Exceeds your position");
    expect(over.valid).toBe(false);

    const atMax = previewWithdraw({ ...base, unit: "shares", amount: "30000" });
    expect(atMax.valid).toBe(true);
  });

  it("max reflects the selected unit", () => {
    expect(previewWithdraw({ ...base, unit: "USDC", amount: "" }).max).toBe(30_142.5);
    expect(previewWithdraw({ ...base, unit: "shares", amount: "" }).max).toBe(30_000);
  });

  it("reports busy only while withdrawing", () => {
    expect(isWithdrawBusy("withdrawing")).toBe(true);
    expect(isWithdrawBusy("form")).toBe(false);
    expect(isWithdrawBusy("done")).toBe(false);
  });
});
