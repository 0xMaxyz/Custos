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

const NOW = Math.floor(Date.now() / 1000);

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

  it("LLM deRisk=true (with cited evidence) preserves verdict when peg is healthy", async () => {
    // Healthy snapshot — no deterministic forceDeRisk.
    // Signal layer must keep deRisk=true; executor honours via rebalance (see mocked suite).
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

    expect(llmResult?.deRisk).toBe(true);
    // In the executor cycle: llmDeRisk=true + healthy peg → rebalance with USDY=0.
    // Verified through the mocked runCycle routing tests below.
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

// ── Mocked Executor.runCycle() ────────────────────────────────────────────────
// Tests the full cycle routing without a fork: writeContract is mocked so we
// assert which on-chain function is called (rebalance vs deRisk) for each path.

describe("Executor.runCycle() routing (mocked writeContract)", () => {
  function makeMockClients(writeResult = "0xabc123" as `0x${string}`) {
    const writeContract = vi.fn(async () => writeResult);
    const readContract = vi.fn(async (opts: { functionName: string }) => {
      if (opts.functionName === "lastRebalanceAt") return 0n;
      return 0n;
    });
    const waitForTransactionReceipt = vi.fn(async () => ({ logs: [] }));
    const publicClient = { readContract, waitForTransactionReceipt } as never;
    const walletClient = {
      writeContract,
      chain: { id: 5000 },
      account: { address: "0x1234" as `0x${string}` },
    } as never;
    return { publicClient, walletClient, writeContract };
  }

  function makeSnapshotter(snap: MarketSnapshot) {
    return { snapshot: vi.fn(async () => snap), invalidate: vi.fn() } as never;
  }

  async function makeExecutor(
    snap: MarketSnapshot,
    env: Record<string, string> = {},
  ) {
    const { Executor } = await import("./index.js");
    const { loadConfig } = await import("../config.js");
    const { publicClient, walletClient, writeContract } = makeMockClients();
    const config = loadConfig({
      MANTLE_RPC_URL: "https://rpc.mantle.xyz",
      VAULT_ADDRESS: "0x1111111111111111111111111111111111111111",
      ALLOCATOR_PRIVATE_KEY: "0x" + "a".repeat(64),
      ...env,
    });
    const clients = { publicClient, walletClient } as never;
    const executor = new Executor({ config, clients, snapshotter: makeSnapshotter(snap) });
    return { executor, writeContract };
  }

  it("deterministic depeg: calls deRisk (not rebalance)", async () => {
    const snap = baseSnapshot({ usdyDexSpotUsdc: 1_069_200_000_000_000_000n }); // ~100bps below
    const { executor, writeContract } = await makeExecutor(snap);

    const result = await executor.runCycle();

    expect(result.submitted).toBe(true);
    expect(result.kind).toBe("derisk");
    expect(writeContract).toHaveBeenCalledOnce();
    const call = (writeContract.mock.calls[0] as unknown as [{ functionName: string }])[0];
    expect(call.functionName).toBe("deRisk");
  });

  it("LLM-only deRisk (healthy peg): routes through rebalance with USDY=0, not deRisk", async () => {
    // Healthy snapshot — assessment.forceDeRisk=false. The LLM returns deRisk:true
    // (news/attestation hero path). The executor must NOT call _sendDeRisk (which
    // would revert with DeRiskConditionNotMet for ALLOCATOR); instead it clamps
    // usdyMaxWeightBps=0 and routes through rebalance() with USDY weight = 0.
    const signalsMod = await import("../llm/signals.js");
    const evidenceMod = await import("../llm/evidence.js");
    const runSignalLayerSpy = vi.spyOn(signalsMod, "runSignalLayer").mockResolvedValue({
      riskLevel: "DERISK",
      usdyMaxWeightBps: 5_000,
      deRisk: true,
      rationale: "Issuer regulatory action — route USDY to zero via rebalance.",
      signals: [{ type: "REGULATORY", severity: "HIGH", summary: "SEC action", evidenceId: "r1" }],
      confidence: 0.95,
    });
    const buildEvidenceFetcherSpy = vi.spyOn(evidenceMod, "buildEvidenceFetcher").mockReturnValue(
      async () => [{ id: "r1", type: "REGULATORY" as EvidenceType, source: "sec.gov", url: "https://sec.gov", publishedAt: "2026-06-01", summary: "Action." }],
    );

    const snap = baseSnapshot();
    const { executor, writeContract } = await makeExecutor(snap, { ANTHROPIC_API_KEY: "sk-test" });

    const result = await executor.runCycle();
    runSignalLayerSpy.mockRestore();
    buildEvidenceFetcherSpy.mockRestore();

    expect(result.submitted).toBe(true);
    expect(result.kind).toBe("rebalance");
    expect(writeContract).toHaveBeenCalledOnce();
    const call = (writeContract.mock.calls[0] as unknown as [{ functionName: string; args: unknown[] }])[0];
    expect(call.functionName).toBe("rebalance");
    const weightsArr = call.args[0] as readonly number[];
    expect(weightsArr[Bucket.USDY]).toBe(0);
  });

  it("oracle stale: calls deRisk via deterministic forceDeRisk", async () => {
    const snap = baseSnapshot({ oracleRangeEnd: 1 }); // 1 second past range end relative to nowSec
    const { executor, writeContract } = await makeExecutor(snap);

    const result = await executor.runCycle();

    expect(result.submitted).toBe(true);
    expect(result.kind).toBe("derisk");
    const call = (writeContract.mock.calls[0] as unknown as [{ functionName: string }])[0];
    expect(call.functionName).toBe("deRisk");
  });

  it("deRisk passes pinned URI (not plain text) as the on-chain reason", async () => {
    const snap = baseSnapshot({ usdyDexSpotUsdc: 1_069_200_000_000_000_000n });
    const { executor, writeContract } = await makeExecutor(snap);

    await executor.runCycle();

    const call = (writeContract.mock.calls[0] as unknown as [{ args: unknown[] }])[0];
    // deRisk args: [toBucket, swapData, reason, rationaleHash, usdyDexSpotUsdc]
    const reason = call.args[2] as string;
    // Pinned URI should be a data: or ipfs:// URI, not a plain sentence.
    expect(reason).toMatch(/^(data:|ipfs:\/\/)/);
  });

  it("rebalance: swapData[2] populated from getSwapQuote when USDY weight changes", async () => {
    // Start with 5000bps USDY; LLM verdict tightens to 2000bps (withdraw path).
    // The engine holds current USDY, but applyVerdict tightens to 2000 → allocation
    // change triggers rebalance, and the withdraw calldata should land in swapData[2].
    const snap = baseSnapshot(); // currentWeightsBps includes 5000bps USDY

    const MOCK_CALLDATA = "0xdeadbeef" as const;
    const ADAPTER_ADDR = "0xaabbccddaabbccddaabbccddaabbccddaabbccdd" as `0x${string}`;

    const signalsMod = await import("../llm/signals.js");
    const oneDeltaMod = await import("../data/oneDelta.js");
    const evidenceMod = await import("../llm/evidence.js");

    // LLM verdict tightens USDY ceiling to 2000bps (below current 5000bps).
    const runSignalLayerSpy = vi.spyOn(signalsMod, "runSignalLayer").mockResolvedValue({
      riskLevel: "CAUTION",
      usdyMaxWeightBps: 2_000,
      deRisk: false,
      rationale: "Regulatory concern; reduce USDY exposure.",
      signals: [],
      confidence: 0.85,
    });
    const buildEvidenceFetcherSpy = vi.spyOn(evidenceMod, "buildEvidenceFetcher").mockReturnValue(
      async () => [],
    );
    // Mock 1delta getSwapQuote on the prototype so the executor's new instance picks it up.
    const getSwapQuoteSpy = vi.spyOn(oneDeltaMod.OneDeltaClient.prototype, "getSwapQuote")
      .mockResolvedValue({
        router: "0xD9F4e85489aDCD0bAF0Cd63b4231c6af58c26745" as `0x${string}`,
        calldata: MOCK_CALLDATA,
        amountOut: 4_600n * 10n ** 18n,
      });

    const { Executor } = await import("./index.js");
    const { loadConfig } = await import("../config.js");

    const writeContract = vi.fn(async () => "0xabc123" as `0x${string}`);
    const readContract = vi.fn(async (opts: { functionName: string }) => {
      if (opts.functionName === "lastRebalanceAt") return 0n;
      if (opts.functionName === "adapters") return ADAPTER_ADDR;
      return 0n;
    });
    const publicClient = { readContract, waitForTransactionReceipt: vi.fn(async () => ({ logs: [] })) } as never;
    const walletClient = {
      writeContract,
      chain: { id: 5000 },
      account: { address: "0x1234" as `0x${string}` },
    } as never;

    const config = loadConfig({
      MANTLE_RPC_URL: "https://rpc.mantle.xyz",
      VAULT_ADDRESS: "0x1111111111111111111111111111111111111111",
      ALLOCATOR_PRIVATE_KEY: "0x" + "a".repeat(64),
      ANTHROPIC_API_KEY: "sk-test",
    });

    const executor = new Executor({
      config,
      clients: { publicClient, walletClient } as never,
      snapshotter: makeSnapshotter(snap),
    });

    await executor.runCycle();

    runSignalLayerSpy.mockRestore();
    buildEvidenceFetcherSpy.mockRestore();
    getSwapQuoteSpy.mockRestore();

    expect(writeContract).toHaveBeenCalledOnce();
    const call = (writeContract.mock.calls[0] as unknown as [{ functionName: string; args: unknown[] }])[0];
    expect(call.functionName).toBe("rebalance");
    const swapData = call.args[1] as string[];
    // swapData[2] should carry the quote calldata.
    expect(swapData[2]).toBe(MOCK_CALLDATA);
    // Other slots remain empty.
    expect(swapData[0]).toBe("0x");
    expect(swapData[1]).toBe("0x");
    expect(swapData[3]).toBe("0x");
  });

  it("rebalance: swapData[2] falls back to 0x when getSwapQuote fails (network error)", async () => {
    // Same scenario but getSwapQuote throws — swapData[2] must be "0x" (fail-closed).
    const snap = baseSnapshot(); // currentWeightsBps has 5000bps USDY

    const signalsMod = await import("../llm/signals.js");
    const oneDeltaMod = await import("../data/oneDelta.js");
    const evidenceMod = await import("../llm/evidence.js");

    const runSignalLayerSpy = vi.spyOn(signalsMod, "runSignalLayer").mockResolvedValue({
      riskLevel: "CAUTION",
      usdyMaxWeightBps: 2_000,
      deRisk: false,
      rationale: "Regulatory concern; reduce USDY exposure.",
      signals: [],
      confidence: 0.85,
    });
    const buildEvidenceFetcherSpy = vi.spyOn(evidenceMod, "buildEvidenceFetcher").mockReturnValue(
      async () => [],
    );
    const getSwapQuoteSpy = vi.spyOn(oneDeltaMod.OneDeltaClient.prototype, "getSwapQuote")
      .mockRejectedValue(new Error("network error"));

    const { Executor } = await import("./index.js");
    const { loadConfig } = await import("../config.js");

    const writeContract = vi.fn(async () => "0xabc123" as `0x${string}`);
    const readContract = vi.fn(async (opts: { functionName: string }) => {
      if (opts.functionName === "lastRebalanceAt") return 0n;
      if (opts.functionName === "adapters") return "0xaabbccddaabbccddaabbccddaabbccddaabbccdd";
      return 0n;
    });
    const publicClient = { readContract, waitForTransactionReceipt: vi.fn(async () => ({ logs: [] })) } as never;
    const walletClient = {
      writeContract,
      chain: { id: 5000 },
      account: { address: "0x1234" as `0x${string}` },
    } as never;

    const config = loadConfig({
      MANTLE_RPC_URL: "https://rpc.mantle.xyz",
      VAULT_ADDRESS: "0x1111111111111111111111111111111111111111",
      ALLOCATOR_PRIVATE_KEY: "0x" + "a".repeat(64),
      ANTHROPIC_API_KEY: "sk-test",
    });

    const executor = new Executor({
      config,
      clients: { publicClient, walletClient } as never,
      snapshotter: makeSnapshotter(snap),
    });

    await executor.runCycle();

    runSignalLayerSpy.mockRestore();
    buildEvidenceFetcherSpy.mockRestore();
    getSwapQuoteSpy.mockRestore();

    expect(writeContract).toHaveBeenCalledOnce();
    const call = (writeContract.mock.calls[0] as unknown as [{ args: unknown[] }])[0];
    const swapData = (call.args as unknown[][])[1] as string[];
    expect(swapData[2]).toBe("0x");
  });

  it("rebalance: swapData[2] stays 0x when quote.router != pinned Odos address (wrong-router rejection)", async () => {
    // Quote returns a DIFFERENT router than the pinned Odos address.
    // The executor must reject it and leave swapData[2] = "0x" (fail-closed at quote time).
    const snap = baseSnapshot();

    const signalsMod = await import("../llm/signals.js");
    const oneDeltaMod = await import("../data/oneDelta.js");
    const evidenceMod = await import("../llm/evidence.js");

    const runSignalLayerSpy = vi.spyOn(signalsMod, "runSignalLayer").mockResolvedValue({
      riskLevel: "CAUTION",
      usdyMaxWeightBps: 2_000,
      deRisk: false,
      rationale: "Reduce exposure.",
      signals: [],
      confidence: 0.85,
    });
    const buildEvidenceFetcherSpy = vi.spyOn(evidenceMod, "buildEvidenceFetcher").mockReturnValue(
      async () => [],
    );
    // Quote returns a WRONG router address (not the pinned Odos one).
    const getSwapQuoteSpy = vi.spyOn(oneDeltaMod.OneDeltaClient.prototype, "getSwapQuote")
      .mockResolvedValue({
        router: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        calldata: "0xcafebabe" as `0x${string}`,
        amountOut: 4_600n * 10n ** 18n,
      });

    const { Executor } = await import("./index.js");
    const { loadConfig } = await import("../config.js");

    const writeContract = vi.fn(async () => "0xabc123" as `0x${string}`);
    const readContract = vi.fn(async (opts: { functionName: string }) => {
      if (opts.functionName === "lastRebalanceAt") return 0n;
      if (opts.functionName === "adapters") return "0xaabbccddaabbccddaabbccddaabbccddaabbccdd";
      return 0n;
    });
    const publicClient = { readContract, waitForTransactionReceipt: vi.fn(async () => ({ logs: [] })) } as never;
    const walletClient = {
      writeContract,
      chain: { id: 5000 },
      account: { address: "0x1234" as `0x${string}` },
    } as never;

    const config = loadConfig({
      MANTLE_RPC_URL: "https://rpc.mantle.xyz",
      VAULT_ADDRESS: "0x1111111111111111111111111111111111111111",
      ALLOCATOR_PRIVATE_KEY: "0x" + "a".repeat(64),
      ANTHROPIC_API_KEY: "sk-test",
    });

    const executor = new Executor({
      config,
      clients: { publicClient, walletClient } as never,
      snapshotter: makeSnapshotter(snap),
    });

    await executor.runCycle();

    runSignalLayerSpy.mockRestore();
    buildEvidenceFetcherSpy.mockRestore();
    getSwapQuoteSpy.mockRestore();

    expect(writeContract).toHaveBeenCalledOnce();
    const call = (writeContract.mock.calls[0] as unknown as [{ args: unknown[] }])[0];
    const swapData = (call.args as unknown[][])[1] as string[];
    // Wrong router → rejected → swapData[2] must be empty, never "0xcafebabe".
    expect(swapData[2]).toBe("0x");
  });
});
