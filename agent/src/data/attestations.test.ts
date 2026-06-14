import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAttestation, parseAttestationFacts, fetchLatestAttestation } from "./attestations.js";
import type { DropboxReader, DropboxEntry } from "./dropbox.js";

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

// ── Dropbox traversal (fetchLatestAttestation) ───────────────────────────────

const folder = (name: string): DropboxEntry => ({ tag: "folder", name });
const file = (name: string): DropboxEntry => ({ tag: "file", name });

describe("fetchLatestAttestation", () => {
  it("walks to the newest year/month/file, downloads it, and parses", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const download = vi.fn(async () => bytes);
    const reader: DropboxReader = {
      listSharedFolder: vi.fn(async (_url: string, path: string) => {
        if (path === "") return [folder("2024"), folder("2026"), folder("2025")];
        if (path === "/2026") return [folder("05 May"), folder("06 June"), folder("04 April")];
        if (path === "/2026/06 June") {
          return [
            file("Ondo USDY LLC_ATCAttest_260605.pdf"),
            file("Ondo USDY LLC_ATCAttest_260609.pdf"),
            file("Ondo USDY LLC_ATCAttest_260608.pdf"),
            file("README.txt"),
          ];
        }
        return [];
      }),
      downloadSharedFile: download,
    };

    const facts = await fetchLatestAttestation(reader, "https://dropbox/folder");
    expect(facts?.date).toBe("2026-06-09");
    // Picked the newest at every level.
    expect(download).toHaveBeenCalledWith("https://dropbox/folder", "/2026/06 June/Ondo USDY LLC_ATCAttest_260609.pdf");
  });

  it("returns null (degrades) when the folder has no year folders", async () => {
    const reader: DropboxReader = {
      listSharedFolder: vi.fn(async () => []),
      downloadSharedFile: vi.fn(async () => new Uint8Array()),
    };
    expect(await fetchLatestAttestation(reader, "url")).toBeNull();
  });

  it("returns null when listing throws (no leak)", async () => {
    const reader: DropboxReader = {
      listSharedFolder: vi.fn(async () => { throw new Error("network"); }),
      downloadSharedFile: vi.fn(async () => new Uint8Array()),
    };
    expect(await fetchLatestAttestation(reader, "url")).toBeNull();
  });
});
