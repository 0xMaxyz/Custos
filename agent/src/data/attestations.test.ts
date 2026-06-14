import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAttestation, parseAttestationFacts } from "./attestations.js";

const FIXTURE = fileURLToPath(
  new URL("./__fixtures__/ondo-usdy-attestation-260609.pdf", import.meta.url),
);

describe("attestation parser", () => {
  it("extracts structured reserve facts from the real 2026-06-09 ATC report", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const facts = await readAttestation(bytes);

    expect(facts).not.toBeNull();
    expect(facts!.date).toBe("2026-06-09");
    expect(facts!.tokenPrincipalOutstanding).toBeCloseTo(2_127_768_031.64, 1);
    expect(facts!.permittedAssetsMarketValue).toBeCloseTo(2_139_527_002.7, 1);
    // Backing ratio ~100.55% (over-collateralized).
    expect(facts!.collateralRatioBps).toBe(10_055);
    expect(facts!.tbillPct).toBeCloseTo(99.86, 2);
    expect(facts!.wamDays).toBeCloseTo(164.02, 1);
    expect(facts!.estYieldPct).toBeCloseTo(3.61, 2);
  });

  it("returns null on text missing required fields (degrade, don't half-parse)", () => {
    expect(parseAttestationFacts("not an attestation")).toBeNull();
    // Has a date but no reserve totals → still null.
    expect(parseAttestationFacts("Date (end of day) 6/9/2026")).toBeNull();
  });

  it("normalizes the report date to ISO", () => {
    const text =
      "Date (end of day) 6/9/2026 " +
      "Token Principal Outstanding 1,000,000.00 " +
      "Permitted Assets (at market value) 1,005,000.00 " +
      "Weighted Average Maturity of Permitted Assets (Days) 120.00 " +
      "US Treasury Bills 1,000,000.00 120.00 99.50% 3.40%";
    const facts = parseAttestationFacts(text);
    expect(facts?.date).toBe("2026-06-09");
    expect(facts?.collateralRatioBps).toBe(10_050);
  });
});
