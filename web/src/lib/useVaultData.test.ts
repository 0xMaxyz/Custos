import { describe, it, expect } from "vitest";
import { useVaultData, sharePriceFromProbe } from "./useVaultData";
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

describe("sharePriceFromProbe", () => {
  // The deployed vault is 12-dec (asset 6 + _decimalsOffset 6). A convertToAssets(1e18)
  // probe of 1e12 is $1.00/share — NOT $1,000,000 as the old hardcoded-1e18 path read.
  it("rescales a 12-dec genesis probe to $1.00 per whole share", () => {
    // From mainnet: convertToAssets(1e18) === 1e12 raw USDC for the live vault.
    expect(sharePriceFromProbe(10n ** 12n, 12)).toBe("1");
  });

  it("does not over-state the price 1e6x for 12-dec shares", () => {
    // Regression guard: treating 1e18 raw as one whole share gave formatUnits(1e12,6).
    const buggy = (1_000_000_000_000n / 1n).toString(); // what the old path implied
    expect(sharePriceFromProbe(10n ** 12n, 12)).not.toBe(buggy);
  });

  it("reflects accrued yield above par (probe > 1e12 → price > $1)", () => {
    // convertToAssets(1e18) === 1.05e12 → 1 whole share backs 1.05 USDC.
    expect(sharePriceFromProbe(1_050_000_000_000n, 12)).toBe("1.05");
  });

  it("matches the trivial identity when shares are 18-dec (no rescale)", () => {
    // If shares were 18-dec, 1e18 raw IS one whole share, so the probe passes through.
    expect(sharePriceFromProbe(1_000_000n, 18)).toBe("1");
  });

  it("respects a non-default asset-decimals argument", () => {
    // 18-dec asset, 18-dec shares: probe of 1e18 → "1.0" formatted at 18 decimals.
    expect(sharePriceFromProbe(10n ** 18n, 18, 18)).toBe("1");
  });
});
