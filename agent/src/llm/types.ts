import { z } from "zod";
import type { RiskLevel } from "@sentinel/shared";
import type { Severity, SignalType } from "../types.js";

// ── LLM output schema (SPEC §3.2) ─────────────────────────────────────────────

export const RiskSignalSchema = z.object({
  type: z.enum(["PEG", "ORACLE", "LIQUIDITY", "YIELD", "ISSUER", "REGULATORY"] as const),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"] as const),
  summary: z.string().min(1),
  evidenceId: z.string().optional(),
});

export const RiskVerdictSchema = z.object({
  riskLevel: z.enum(["NORMAL", "CAUTION", "DERISK"] as const),
  usdyMaxWeightBps: z.number().int().min(0).max(10_000),
  deRisk: z.boolean(),
  rationale: z.string().min(1),
  signals: z.array(RiskSignalSchema),
  confidence: z.number().min(0).max(1),
});

export type RiskVerdict = z.infer<typeof RiskVerdictSchema>;

// ── Evidence items passed to the LLM (SPEC §3.1) ──────────────────────────────

export type EvidenceType = "ATTESTATION" | "NEWS" | "REGULATORY";

export interface EvidenceItem {
  readonly id: string;
  readonly type: EvidenceType;
  readonly source: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly summary: string;
}

// ── Prompt input (SPEC §3.1) ───────────────────────────────────────────────────

export interface LLMInput {
  readonly asOf: string;
  readonly marketState: {
    readonly usdyOracleNavUsdc: string;
    readonly usdyDexSpotUsdc: string;
    readonly pegDeviationBps: number;
    readonly oracleUpdatedAt: string;
    readonly oracleRangeEnd: string;
    readonly usdyImpliedApyBps: number;
    readonly aaveUsdcSupplyApyBps: number;
    readonly aaveUtilizationBps: number;
    readonly aaveWithdrawableUsdc: string;
    readonly totalAssetsUsdc: string;
    readonly currentWeightsBps: Record<string, number>;
  };
  readonly deterministic: {
    readonly candidateWeightsBps: Record<string, number>;
    readonly flags: string[];
    readonly maxUsdyWeightBpsAllowed: number;
  };
  readonly evidence: EvidenceItem[];
}

// ── Client interface ───────────────────────────────────────────────────────────

/**
 * Thin interface so tests can inject a mock without touching the Anthropic SDK.
 * The real implementation is {@link AnthropicClient}.
 */
export interface LLMClient {
  complete(input: LLMInput): Promise<RiskVerdict>;
}
