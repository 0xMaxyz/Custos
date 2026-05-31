import { describe, it, expect, vi } from "vitest";
import { Bucket } from "@sentinel/shared";
import type { LLMClient, RiskVerdict } from "./types.js";
import { runSignalLayer, type EvidenceFetcher } from "./signals.js";
import type { MarketSnapshot, RiskAssessment, WeightsBps } from "../types.js";

const NOW = 1_700_000_000;

function weights(idle: number, aave: number, usdy: number, ausd: number): WeightsBps {
  return { [Bucket.IDLE]: idle, [Bucket.AAVE]: aave, [Bucket.USDY]: usdy, [Bucket.AUSD]: ausd };
}

const BASE_SNAPSHOT: MarketSnapshot = {
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
  currentWeightsBps: weights(300, 4_700, 5_000, 0),
  ausdBackingRatioBps: 10_000,
};

const BASE_ASSESSMENT: RiskAssessment = {
  riskLevel: "NORMAL",
  candidateWeightsBps: weights(200, 4_800, 5_000, 0),
  flags: ["NONE"],
  maxUsdyWeightBpsAllowed: 6_000,
  forceDeRisk: false,
};

function mockLLM(verdict: RiskVerdict): LLMClient {
  return { complete: vi.fn(async () => verdict) };
}

function errorLLM(): LLMClient {
  return { complete: vi.fn(async () => { throw new Error("API timeout"); }) };
}

const CLEAN_VERDICT: RiskVerdict = {
  riskLevel: "NORMAL",
  usdyMaxWeightBps: 5_000,
  deRisk: false,
  rationale: "Peg tight; USDY out-yields Aave; attestation clean.",
  signals: [],
  confidence: 0.9,
};

describe("runSignalLayer — contract tests", () => {
  it("returns verdict from the LLM when output is valid", async () => {
    const result = await runSignalLayer(BASE_SNAPSHOT, BASE_ASSESSMENT, {
      llm: mockLLM(CLEAN_VERDICT),
    });
    expect(result).not.toBeNull();
    expect(result!.riskLevel).toBe("NORMAL");
    expect(result!.usdyMaxWeightBps).toBeLessThanOrEqual(6_000);
  });

  it("falls back to null on API error", async () => {
    const result = await runSignalLayer(BASE_SNAPSHOT, BASE_ASSESSMENT, {
      llm: errorLLM(),
    });
    expect(result).toBeNull();
  });

  it("clamps usdyMaxWeightBps to deterministic ceiling", async () => {
    const verdict: RiskVerdict = { ...CLEAN_VERDICT, usdyMaxWeightBps: 9_000 }; // exceeds 6000 cap
    const result = await runSignalLayer(BASE_SNAPSHOT, BASE_ASSESSMENT, {
      llm: mockLLM(verdict),
    });
    expect(result!.usdyMaxWeightBps).toBeLessThanOrEqual(6_000);
  });

  it("clears deRisk=true when no cited evidence signals are present", async () => {
    const verdict: RiskVerdict = {
      ...CLEAN_VERDICT,
      deRisk: true,
      signals: [{ type: "ISSUER", severity: "HIGH", summary: "Regulatory shock" }], // no evidenceId
    };
    const result = await runSignalLayer(BASE_SNAPSHOT, BASE_ASSESSMENT, {
      llm: mockLLM(verdict),
    });
    expect(result!.deRisk).toBe(false);
  });

  it("preserves deRisk=true when at least one cited signal resolves in evidence[]", async () => {
    const verdict: RiskVerdict = {
      ...CLEAN_VERDICT,
      deRisk: true,
      signals: [{ type: "ISSUER", severity: "HIGH", summary: "Downgrade", evidenceId: "e1" }],
    };
    const fetchEvidence: EvidenceFetcher = async () => [
      { id: "e1", type: "NEWS", source: "test", url: "https://example.com", publishedAt: "2026-06-01", summary: "Downgrade." },
    ];
    const result = await runSignalLayer(BASE_SNAPSHOT, BASE_ASSESSMENT, {
      llm: mockLLM(verdict),
      fetchEvidence,
    });
    expect(result!.deRisk).toBe(true);
  });

  it("an injected headline tightens the verdict vs deterministic baseline", async () => {
    // Deterministic says NORMAL / 5000 USDY. LLM sees a downgrade headline and
    // lowers USDY to 2000 with CAUTION — clamped output must reflect the tightening.
    const tightenedVerdict: RiskVerdict = {
      riskLevel: "CAUTION",
      usdyMaxWeightBps: 2_000,
      deRisk: false,
      rationale: "Issuer downgrade headline raises caution.",
      signals: [{ type: "ISSUER", severity: "MEDIUM", summary: "Rating cut", evidenceId: "n1" }],
      confidence: 0.75,
    };
    const fetchEvidence: EvidenceFetcher = async () => [
      {
        id: "n1",
        type: "NEWS",
        source: "reuters.com",
        url: "https://reuters.com/example",
        publishedAt: "2026-06-10",
        summary: "Ondo Finance issuer rating downgraded.",
      },
    ];
    const result = await runSignalLayer(BASE_SNAPSHOT, BASE_ASSESSMENT, {
      llm: mockLLM(tightenedVerdict),
      fetchEvidence,
    });
    expect(result!.usdyMaxWeightBps).toBe(2_000); // tighter than deterministic 5000
    expect(result!.riskLevel).toBe("CAUTION");    // escalated from NORMAL
  });

  it("LLM cannot lower riskLevel below the deterministic baseline", async () => {
    const cautionAssessment: RiskAssessment = { ...BASE_ASSESSMENT, riskLevel: "CAUTION" };
    const verdict: RiskVerdict = { ...CLEAN_VERDICT, riskLevel: "NORMAL" }; // tries to lower
    const result = await runSignalLayer(BASE_SNAPSHOT, cautionAssessment, {
      llm: mockLLM(verdict),
    });
    expect(result!.riskLevel).toBe("CAUTION"); // escalated back to baseline
  });

  it("evidence fetcher failure is gracefully swallowed", async () => {
    const fetchEvidence: EvidenceFetcher = async () => { throw new Error("fetch failed"); };
    const result = await runSignalLayer(BASE_SNAPSHOT, BASE_ASSESSMENT, {
      llm: mockLLM(CLEAN_VERDICT),
      fetchEvidence,
    });
    // LLM call still succeeds (evidence was empty due to fetch failure).
    expect(result).not.toBeNull();
  });
});
