import { describe, it, expect } from "vitest";
import { computeWeightsBps, resolveDeployment, DEMO_MODE } from "./deployment";

describe("computeWeightsBps", () => {
  it("returns all-zero weights for an empty vault", () => {
    expect(computeWeightsBps({ idle: 0n, aave: 0n, usdy: 0n, ausd: 0n })).toEqual({
      IDLE: 0, AAVE: 0, USDY: 0, AUSD: 0,
    });
  });

  it("computes proportional bps that sum to exactly 10_000", () => {
    // 30 / 470 / 500 / 0 (USDC 6-dec) -> 300 / 4700 / 5000 / 0
    const w = computeWeightsBps({ idle: 30_000000n, aave: 470_000000n, usdy: 500_000000n, ausd: 0n });
    expect(w).toEqual({ IDLE: 300, AAVE: 4700, USDY: 5000, AUSD: 0 });
    expect(w.IDLE + w.AAVE + w.USDY + w.AUSD).toBe(10_000);
  });

  it("distributes rounding remainder so thirds still sum to 10_000", () => {
    const w = computeWeightsBps({ idle: 1n, aave: 1n, usdy: 1n, ausd: 0n });
    expect(w.IDLE + w.AAVE + w.USDY + w.AUSD).toBe(10_000);
    // 10000/3 -> 3334 / 3333 / 3333 in some order
    expect([w.IDLE, w.AAVE, w.USDY].sort((a, b) => a - b)).toEqual([3333, 3333, 3334]);
    expect(w.AUSD).toBe(0);
  });

  it("is decimal-agnostic (ratios cancel)", () => {
    const small = computeWeightsBps({ idle: 1n, aave: 1n, usdy: 2n, ausd: 0n });
    const large = computeWeightsBps({ idle: 1_000000n, aave: 1_000000n, usdy: 2_000000n, ausd: 0n });
    expect(small).toEqual(large);
  });
});

describe("resolveDeployment", () => {
  it("uses the committed testnet (5003) deployment with no env override", () => {
    // Skip when the test run forces demo mode (VITE_DEMO_MODE=true).
    if (DEMO_MODE) return;
    const d = resolveDeployment(5003);
    expect(d.vault).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(d.usdyAdapter).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("resolves the deployed mainnet (5000) vault", () => {
    // Skip when the test run forces demo mode (VITE_DEMO_MODE=true).
    if (DEMO_MODE) return;
    const d = resolveDeployment(5000);
    expect(d.vault).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(d.aaveAdapter).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(d.usdyAdapter).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(d.ausdAdapter).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("returns empty for an unknown chain or undefined", () => {
    expect(resolveDeployment(1).vault).toBe("");
    expect(resolveDeployment(undefined).vault).toBe("");
  });
});
