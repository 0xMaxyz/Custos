import { describe, it, expect } from "vitest";
import { useVaultData } from "./useVaultData";
import { vault, position, baseline } from "./data";

describe("useVaultData", () => {
  it("returns canonical fixtures while vault is undeployed", () => {
    const data = useVaultData();
    expect(data.isLive).toBe(false);
    expect(data.vault.tvlUsdc).toBe(vault.tvlUsdc);
    expect(data.position.shares).toBe(position.shares);
    expect(data.baseline.sinceDecisionId).toBe(baseline.sinceDecisionId);
  });
});
