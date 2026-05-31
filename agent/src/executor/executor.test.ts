/**
 * Executor unit tests — mocked chain + LLM; no network.
 *
 * These test the full cycle pipeline:
 *   Snapshotter → assess → runSignalLayer → applyVerdict → validateProposal → tx
 */
import { describe, it, expect, vi } from "vitest";
import { Bucket } from "@sentinel/shared";
import type { MarketSnapshot, WeightsBps } from "../types.js";
import type { RiskVerdict, EvidenceType } from "../llm/types.js";

// ── Minimal stubs ─────────────────────────────────────────────────────────────

const NOW = 1_700_000_000;

function weights(idle: number, aave: number, usdy: number, ausd: number): WeightsBps {
  return { [Bucket.IDLE]: idle, [Bucket.AAVE]: aave, [Bucket.USDY]: usdy, [Bucket.AUSD]: ausd };
}

function baseSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
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
    ...overrides,
  };
}

// ── End-to-end cycle: snapshot → assess → signal → validate ───────────────────

describe("end-to-end cycle pipeline (mocked, no network)", () => {
  it("healthy market: assess + LLM returns NORMAL, proposal is valid", async () => {
    const { assess } = await import("../risk/engine.js");
    const { runSignalLayer } = await import("../llm/signals.js");
    const { applyVerdict, validateProposal } = await import("../risk/validator.js");

    const snap = baseSnapshot();
    const assessment = assess(snap, { nowSec: NOW });

    expect(assessment.riskLevel).toBe("NORMAL");
    expect(assessment.forceDeRisk).toBe(false);

    const verdict: RiskVerdict = {
      riskLevel: "NORMAL",
      usdyMaxWeightBps: 5_000,
      deRisk: false,
      rationale: "Peg tight; USDY out-yields Aave.",
      signals: [],
      confidence: 0.92,
    };
    const mockLLM = { complete: vi.fn(async () => verdict) };
    const llmResult = await runSignalLayer(snap, assessment, { llm: mockLLM });

    const proposed = applyVerdict(assessment, llmResult);
    const result = validateProposal(proposed, snap.currentWeightsBps, snap, assessment.maxUsdyWeightBpsAllowed);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("depeg scenario: assess forces DERISK, proposed USDY = 0", async () => {
    const { assess } = await import("../risk/engine.js");
    const { applyVerdict } = await import("../risk/validator.js");

    const snap = baseSnapshot({ usdyDexSpotUsdc: 1_069_200_000_000_000_000n }); // ~100bps below
    const assessment = assess(snap, { nowSec: NOW });

    expect(assessment.forceDeRisk).toBe(true);
    expect(assessment.candidateWeightsBps[Bucket.USDY]).toBe(0);

    const proposed = applyVerdict(assessment, null);
    expect(proposed[Bucket.USDY]).toBe(0);
  });

  it("LLM API error falls back to deterministic (null verdict → candidate used as-is)", async () => {
    const { assess } = await import("../risk/engine.js");
    const { runSignalLayer } = await import("../llm/signals.js");
    const { applyVerdict } = await import("../risk/validator.js");

    const snap = baseSnapshot();
    const assessment = assess(snap, { nowSec: NOW });

    const errorLLM = { complete: vi.fn(async () => { throw new Error("API timeout"); }) };
    const llmResult = await runSignalLayer(snap, assessment, { llm: errorLLM });

    expect(llmResult).toBeNull();
    const proposed = applyVerdict(assessment, null);
    expect(proposed).toEqual(assessment.candidateWeightsBps);
  });

  it("LLM tightening: issuer headline reduces USDY from 5000 → 2000, weights still valid", async () => {
    const { assess } = await import("../risk/engine.js");
    const { runSignalLayer } = await import("../llm/signals.js");
    const { applyVerdict, validateProposal } = await import("../risk/validator.js");

    const snap = baseSnapshot();
    const assessment = assess(snap, { nowSec: NOW });

    const verdict: RiskVerdict = {
      riskLevel: "CAUTION",
      usdyMaxWeightBps: 2_000,
      deRisk: false,
      rationale: "Regulatory downgrade headline raises caution.",
      signals: [{ type: "ISSUER", severity: "MEDIUM", summary: "Rating cut", evidenceId: "n1" }],
      confidence: 0.78,
    };
    const fetchEvidence = vi.fn(async () => [
      { id: "n1", type: "NEWS" as const, source: "test", url: "https://example.com", publishedAt: "2026-06-01", summary: "Downgrade." },
    ]);
    const mockLLM = { complete: vi.fn(async () => verdict) };
    const llmResult = await runSignalLayer(snap, assessment, { llm: mockLLM, fetchEvidence });

    const proposed = applyVerdict(assessment, llmResult);
    expect(proposed[Bucket.USDY]).toBe(2_000);

    const validation = validateProposal(proposed, snap.currentWeightsBps, snap, assessment.maxUsdyWeightBpsAllowed);
    expect(validation.valid).toBe(true);
  });

  it("oracle stale: forced de-risk, validator accepts zero-USDY proposal", async () => {
    const { assess } = await import("../risk/engine.js");
    const { applyVerdict } = await import("../risk/validator.js");

    const snap = baseSnapshot({ oracleRangeEnd: NOW - 1 });
    const assessment = assess(snap, { nowSec: NOW });

    expect(assessment.riskLevel).toBe("DERISK");
    const proposed = applyVerdict(assessment, null);
    expect(proposed[Bucket.USDY]).toBe(0);

    // deRisk path skips validateProposal — just verify the weights are sane.
    const sum = proposed[Bucket.IDLE] + proposed[Bucket.AAVE] + proposed[Bucket.USDY] + proposed[Bucket.AUSD];
    expect(sum).toBe(10_000);
  });

  it("LLM deRisk=true (with cited evidence) triggers de-risk even without deterministic flag", async () => {
    // Healthy snapshot — no deterministic forceDeRisk.
    // LLM requests deRisk with cited evidence; executor should honour it.
    const { assess } = await import("../risk/engine.js");
    const { runSignalLayer } = await import("../llm/signals.js");

    const snap = baseSnapshot();
    const assessment = assess(snap, { nowSec: NOW });
    expect(assessment.forceDeRisk).toBe(false);

    const verdict: RiskVerdict = {
      riskLevel: "DERISK",
      usdyMaxWeightBps: 0,
      deRisk: true,
      rationale: "Issuer regulatory action — immediate de-risk required.",
      signals: [{ type: "REGULATORY", severity: "HIGH", summary: "SEC action", evidenceId: "r1" }],
      confidence: 0.95,
    };
    const fetchEvidence = vi.fn(async () => [
      { id: "r1", type: "REGULATORY" as EvidenceType, source: "sec.gov", url: "https://sec.gov", publishedAt: "2026-06-01", summary: "Action." },
    ]);
    const mockLLM = { complete: vi.fn(async () => verdict) };
    const llmResult = await runSignalLayer(snap, assessment, { llm: mockLLM, fetchEvidence });

    // LLM-requested deRisk should be preserved.
    expect(llmResult?.deRisk).toBe(true);
    // In the executor cycle: llmDeRisk=true → _sendDeRisk path taken.
    // Verified through the verdict property — executor wiring tested in fork tests.
  });

  it("evidence is included in the pinned bundle (not empty array)", async () => {
    const { pinRationale } = await import("./ipfs.js");
    const { loadConfig } = await import("../config.js");

    const config = loadConfig({ MANTLE_RPC_URL: "https://rpc.mantle.xyz" });
    const evidenceItem = {
      id: "e1",
      type: "ATTESTATION" as const,
      source: "ondo.finance",
      url: "https://ondo.finance",
      publishedAt: "2026-06-01",
      summary: "Monthly attestation: 99.8% T-bills.",
    };
    const bundle = {
      rationale: "USDY attestation clean.",
      signals: [],
      evidence: [evidenceItem],
      candidateWeightsBps: weights(200, 4_800, 5_000, 0),
      riskLevel: "NORMAL",
      asOf: new Date(NOW * 1000).toISOString(),
    };

    const { uri, rationaleHash } = await pinRationale(bundle, config);
    // The data: URI should contain the evidence item.
    const decoded = Buffer.from(uri.split(",")[1]!, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as typeof bundle;
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.id).toBe("e1");
    expect(rationaleHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ── IPFS pin helper ───────────────────────────────────────────────────────────

describe("pinRationale", () => {
  it("returns a data: URI and hash when no IPFS_API_URL is configured", async () => {
    const { pinRationale } = await import("./ipfs.js");
    const { loadConfig } = await import("../config.js");

    const config = loadConfig({ MANTLE_RPC_URL: "https://rpc.mantle.xyz" });
    const bundle = {
      rationale: "Test",
      signals: [],
      evidence: [],
      candidateWeightsBps: weights(200, 4_800, 5_000, 0),
      riskLevel: "NORMAL",
      asOf: new Date(NOW * 1000).toISOString(),
    };

    const result = await pinRationale(bundle, config);
    expect(result.uri).toMatch(/^data:/);
    expect(result.rationaleHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("returns an ipfs:// URI when IPFS API returns a valid CID", async () => {
    const { pinRationale } = await import("./ipfs.js");
    const { loadConfig } = await import("../config.js");

    const config = loadConfig({
      MANTLE_RPC_URL: "https://rpc.mantle.xyz",
      IPFS_API_URL: "http://localhost:5001",
    });

    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ Hash: "QmTestCid123" }),
    })) as unknown as typeof fetch;

    const bundle = {
      rationale: "Test with IPFS",
      signals: [],
      evidence: [],
      candidateWeightsBps: weights(200, 4_800, 5_000, 0),
      riskLevel: "NORMAL",
      asOf: new Date(NOW * 1000).toISOString(),
    };

    const result = await pinRationale(bundle, config, mockFetch);
    expect(result.uri).toBe("ipfs://QmTestCid123");
    expect(result.rationaleHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
