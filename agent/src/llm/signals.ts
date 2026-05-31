import { Bucket } from "@sentinel/shared";
import { pegDeviationBps } from "../risk/engine.js";
import type { MarketSnapshot, RiskAssessment } from "../types.js";
import type { EvidenceItem, LLMClient, LLMInput, RiskVerdict } from "./types.js";
import { RiskVerdictSchema } from "./types.js";

/**
 * Fetch unstructured evidence items (attestations, news). In production these come
 * from real feeds; in tests, an injectable `fetchEvidence` can return canned items.
 */
export type EvidenceFetcher = () => Promise<EvidenceItem[]>;

/** No-op evidence fetcher — returns empty list (safe default when no feeds are wired). */
export const noopEvidence: EvidenceFetcher = async () => [];

export interface SignalLayerOptions {
  readonly llm: LLMClient;
  readonly fetchEvidence?: EvidenceFetcher;
}

/**
 * The LLM signal layer: assembles the SPEC §3.1 input, calls the model, and
 * returns a validated + clamped {@link RiskVerdict}.
 *
 * On any error (API failure, schema mismatch, retry exhausted) returns `null` so
 * the caller falls back to the deterministic allocation (SPEC §3.5).
 */
export async function runSignalLayer(
  snapshot: MarketSnapshot,
  assessment: RiskAssessment,
  options: SignalLayerOptions,
): Promise<RiskVerdict | null> {
  const { llm, fetchEvidence = noopEvidence } = options;

  let evidence: EvidenceItem[];
  try {
    evidence = await fetchEvidence();
  } catch {
    evidence = [];
  }

  const input = buildLLMInput(snapshot, assessment, evidence);

  // One retry on invalid output, then deterministic fallback (SPEC §3.5).
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: RiskVerdict;
    try {
      raw = await llm.complete(input);
    } catch {
      return null;
    }

    const clamped = clampVerdict(raw, assessment);
    if (clamped !== null) return clamped;
    // clamped === null means schema/sanity rejection → retry once
  }

  return null;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function buildLLMInput(
  snapshot: MarketSnapshot,
  assessment: RiskAssessment,
  evidence: EvidenceItem[],
): LLMInput {
  const nav18 = snapshot.usdyOracleNavUsdc;
  const spot18 = snapshot.usdyDexSpotUsdc;
  const e18 = 10n ** 18n;
  const e6 = 10n ** 6n;

  const fmt18 = (v: bigint): string => (Number(v) / 1e18).toFixed(6);
  const fmt6 = (v: bigint): string => (Number(v) / 1e6).toFixed(2);

  return {
    asOf: snapshot.asOf,
    marketState: {
      usdyOracleNavUsdc: fmt18(nav18),
      usdyDexSpotUsdc: spot18 > 0n ? fmt18(spot18) : "unavailable",
      pegDeviationBps: pegDeviationBps(nav18, spot18),
      oracleUpdatedAt:
        snapshot.oracleUpdatedAt > 0
          ? new Date(snapshot.oracleUpdatedAt * 1000).toISOString()
          : "unknown",
      oracleRangeEnd:
        snapshot.oracleRangeEnd > 0
          ? new Date(snapshot.oracleRangeEnd * 1000).toISOString()
          : "unsupported",
      usdyImpliedApyBps: snapshot.usdyImpliedApyBps,
      aaveUsdcSupplyApyBps: snapshot.aaveUsdcSupplyApyBps,
      aaveUtilizationBps: snapshot.aaveUtilizationBps,
      aaveWithdrawableUsdc: fmt6(snapshot.aaveWithdrawableUsdc),
      totalAssetsUsdc: fmt6(snapshot.totalAssetsUsdc),
      currentWeightsBps: {
        IDLE: snapshot.currentWeightsBps[Bucket.IDLE],
        AAVE: snapshot.currentWeightsBps[Bucket.AAVE],
        USDY: snapshot.currentWeightsBps[Bucket.USDY],
        AUSD: snapshot.currentWeightsBps[Bucket.AUSD],
      },
    },
    deterministic: {
      candidateWeightsBps: {
        IDLE: assessment.candidateWeightsBps[Bucket.IDLE],
        AAVE: assessment.candidateWeightsBps[Bucket.AAVE],
        USDY: assessment.candidateWeightsBps[Bucket.USDY],
        AUSD: assessment.candidateWeightsBps[Bucket.AUSD],
      },
      flags: assessment.flags,
      maxUsdyWeightBpsAllowed: assessment.maxUsdyWeightBpsAllowed,
    },
    evidence,
  };
}

/**
 * Validate and clamp a raw verdict from the model (SPEC §3.3).
 * Returns null if the verdict is structurally unsalvageable.
 */
function clampVerdict(raw: RiskVerdict, assessment: RiskAssessment): RiskVerdict | null {
  // Hard schema re-check (belt-and-suspenders — AnthropicClient already parsed).
  const parsed = RiskVerdictSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;

  // LLM may only tighten: USDY weight clamped to deterministic ceiling.
  const usdyMaxWeightBps = Math.min(v.usdyMaxWeightBps, assessment.maxUsdyWeightBpsAllowed);

  // deRisk=true requires at least one signal with an evidenceId citation.
  const deRisk = v.deRisk && v.signals.some((s) => s.evidenceId !== undefined) ? true : false;

  // riskLevel may only match or escalate the deterministic level.
  const riskLevel = escalate(assessment.riskLevel, v.riskLevel);

  return { ...v, usdyMaxWeightBps, deRisk, riskLevel };
}

const RISK_ORDER = { NORMAL: 0, CAUTION: 1, DERISK: 2 } as const;

function escalate(
  base: "NORMAL" | "CAUTION" | "DERISK",
  proposed: "NORMAL" | "CAUTION" | "DERISK",
): "NORMAL" | "CAUTION" | "DERISK" {
  return RISK_ORDER[proposed] >= RISK_ORDER[base] ? proposed : base;
}
