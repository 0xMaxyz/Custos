import { describe, it, expect, vi } from "vitest";
import { Bucket } from "@custos/shared";
import { buildEvidenceFetcher, CURATED_EVIDENCE_SOURCES } from "./evidence.js";
import { runSignalLayer } from "./signals.js";
import type { LLMClient, RiskVerdict } from "./types.js";
import type { MarketSnapshot, RiskAssessment, WeightsBps } from "../types.js";
import type { AttestationFacts } from "../data/attestations.js";

/** Minimal fetch stub returning a page with the given title + meta description. */
function pageFetch(byUrl: Record<string, { title: string; desc: string }>) {
  return vi.fn(async (url: string) => {
    const page = byUrl[url];
    if (!page) return { ok: false, text: async () => "" };
    const html = `<!doctype html><html><head><title>${page.title}</title>` +
      `<meta name="description" content="${page.desc}"></head><body></body></html>`;
    return { ok: true, text: async () => html };
  });
}

const ONDO_URL = "https://ondo.finance/usdy";
const DEMO_URL = "https://trycustos.xyz/demo/derisk-evidence.html";
const STAGED = {
  title: "Ondo halts USDY redemptions after T-bill custodian freeze; NAV under review",
  desc: "2026-06-14: Ondo paused USDY redemption pending an emergency attestation.",
};

describe("buildEvidenceFetcher — demo de-risk override", () => {
  it("uses the default ondo.finance feed URL when no override is set", async () => {
    const fetchImpl = pageFetch({ [ONDO_URL]: STAGED });
    await buildEvidenceFetcher(fetchImpl)();
    expect(fetchImpl).toHaveBeenCalledWith(ONDO_URL);
    expect(fetchImpl).not.toHaveBeenCalledWith(DEMO_URL);
  });

  it("swaps ONLY the ondo feed URL while keeping id/type/source unchanged", async () => {
    const fetchImpl = pageFetch({ [DEMO_URL]: STAGED });
    const items = await buildEvidenceFetcher(fetchImpl, { demoEvidenceUrl: DEMO_URL })();

    expect(fetchImpl).toHaveBeenCalledWith(DEMO_URL);
    expect(fetchImpl).not.toHaveBeenCalledWith(ONDO_URL);

    const ondo = items.find((i) => i.id === "ondo-usdy-attestation");
    expect(ondo).toBeDefined();
    // Identity preserved so the staged item stays de-risk-eligible (N2).
    expect(ondo!.source).toBe("ondo.finance");
    expect(ondo!.type).toBe("ATTESTATION");
    expect(ondo!.url).toBe(DEMO_URL);
    expect(CURATED_EVIDENCE_SOURCES.has(ondo!.source)).toBe(true);
    expect(ondo!.summary).toContain("halts USDY redemptions");
  });
});

// ── End-to-end: staged evidence unlocks an LLM de-risk through the citation gate ──

function weights(idle: number, aave: number, usdy: number, ausd: number): WeightsBps {
  return { [Bucket.IDLE]: idle, [Bucket.AAVE]: aave, [Bucket.USDY]: usdy, [Bucket.AUSD]: ausd };
}

const NOW = 1_700_000_000;
const SNAPSHOT: MarketSnapshot = {
  asOf: new Date(NOW * 1000).toISOString(),
  usdyOracleNavUsdc: 1_080_000_000_000_000_000n,
  usdyDexSpotUsdc: 1_080_000_000_000_000_000n,
  oracleUpdatedAt: NOW - 3_600,
  oracleRangeEnd: NOW + 30 * 24 * 3_600,
  usdyImpliedApyBps: 452,
  aaveUsdcSupplyApyBps: 380,
  aaveUtilizationBps: 7_400,
  aaveWithdrawableUsdc: 21_000_000_000n,
  totalAssetsUsdc: 30_000_000_000n,
  currentWeightsBps: weights(500, 5_000, 4_500, 0),
  ausdBackingRatioBps: 10_000,
};
const ASSESSMENT: RiskAssessment = {
  riskLevel: "NORMAL",
  candidateWeightsBps: weights(500, 5_000, 4_500, 0),
  flags: ["NONE"],
  maxUsdyWeightBpsAllowed: 6_000,
  forceDeRisk: false,
};

const DERISK_VERDICT: RiskVerdict = {
  riskLevel: "DERISK",
  usdyMaxWeightBps: 0,
  deRisk: true,
  rationale: "Ondo halted USDY redemptions; NAV under review. De-risk to USDC.",
  signals: [
    { type: "ISSUER", severity: "HIGH", summary: "USDY redemption pause", evidenceId: "ondo-usdy-attestation" },
  ],
  confidence: 0.8,
};

// ── Attestation-backed evidence item ─────────────────────────────────────────

const FACTS: AttestationFacts = {
  date: "2026-06-09",
  tokenPrincipalOutstanding: 2_127_768_031.64,
  permittedAssetsMarketValue: 2_139_527_002.7,
  collateralRatioBps: 10_055,
  tbillPct: 99.86,
  wamDays: 164.02,
  estYieldPct: 3.61,
};

describe("buildEvidenceFetcher — attestation provider", () => {
  it("builds the ondo item from parsed facts (no scrape) when a provider is given", async () => {
    const fetchImpl = pageFetch({});
    const items = await buildEvidenceFetcher(fetchImpl, { attestation: async () => FACTS })();
    const ondo = items.find((i) => i.id === "ondo-usdy-attestation");
    expect(ondo).toBeDefined();
    expect(ondo!.source).toBe("ondo.finance"); // trusted → de-risk-eligible
    expect(ondo!.publishedAt).toBe("2026-06-09");
    expect(ondo!.summary).toContain("100.55% backed");
    expect(ondo!.summary).toContain("99.86% US Treasury Bills");
    expect(fetchImpl).not.toHaveBeenCalledWith(ONDO_URL); // facts used, not scrape
  });

  it("demo override takes precedence over the attestation provider", async () => {
    const fetchImpl = pageFetch({ [DEMO_URL]: STAGED });
    const attestation = vi.fn(async () => FACTS);
    const items = await buildEvidenceFetcher(fetchImpl, { demoEvidenceUrl: DEMO_URL, attestation })();
    const ondo = items.find((i) => i.id === "ondo-usdy-attestation");
    expect(ondo!.summary).toContain("halts USDY redemptions"); // staged page, not attestation
    expect(attestation).not.toHaveBeenCalled();
  });

  it("falls back to the scrape when the attestation provider returns null", async () => {
    const fetchImpl = pageFetch({ [ONDO_URL]: STAGED });
    const items = await buildEvidenceFetcher(fetchImpl, { attestation: async () => null })();
    const ondo = items.find((i) => i.id === "ondo-usdy-attestation");
    expect(ondo!.summary).toContain("halts USDY redemptions"); // scraped fallback
    expect(fetchImpl).toHaveBeenCalledWith(ONDO_URL);
  });
});

describe("staged evidence → LLM de-risk (citation gate)", () => {
  it("keeps deRisk=true when the cited staged item resolves to a trusted source", async () => {
    const fetchEvidence = buildEvidenceFetcher(pageFetch({ [DEMO_URL]: STAGED }), {
      demoEvidenceUrl: DEMO_URL,
    });
    const llm: LLMClient = { complete: vi.fn(async () => DERISK_VERDICT) };

    const verdict = await runSignalLayer(SNAPSHOT, ASSESSMENT, {
      llm,
      fetchEvidence,
      trustedEvidenceSources: CURATED_EVIDENCE_SOURCES,
    });

    expect(verdict).not.toBeNull();
    expect(verdict!.deRisk).toBe(true);
    expect(verdict!.riskLevel).toBe("DERISK");
    expect(verdict!.usdyMaxWeightBps).toBe(0);
  });
});
