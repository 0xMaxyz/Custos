import Anthropic from "@anthropic-ai/sdk";
import { Bucket } from "@sentinel/shared";
import type { AgentConfig } from "../config.js";
import type { MarketSnapshot, RiskAssessment, Decision } from "../types.js";

/**
 * Conversational explainer (ROADMAP task A3.1).
 *
 * Answers user questions ("why am I in AUSD?", "what changed?") in natural
 * language, grounded ONLY in the agent's current state — the latest market
 * snapshot, the deterministic risk assessment, and recent decisions. The model
 * controls no funds and may not invent data; this is a transparency layer over
 * the same inputs that drive the (separate) risk verdict.
 */

const SYSTEM_PROMPT = `You are Sentinel's transparency assistant for an AI risk-guardian yield vault on Mantle.
The vault holds USDC and earns tokenized-Treasury (USDY) yield with an Aave USDC liquidity floor,
and autonomously de-risks into AUSD/USDC when RWA risk appears (depeg, oracle staleness, issuer/regulatory shock).

You answer the user's question about the vault's CURRENT state and RECENT decisions in plain language.
Rules:
- You DO NOT control funds and cannot change anything. You only explain.
- Ground every statement in the provided context JSON. NEVER invent numbers, sources, or events.
- If the context does not contain the answer, say so plainly (e.g. "I don't have that data right now").
- Be concise (2-4 sentences). Use percentages/USD where helpful. No JSON, no markdown headers.
- Buckets: IDLE = uninvested USDC, AAVE = USDC lent on Aave, USDY = tokenized Treasuries, AUSD = safety stablecoin.`;

// ── Context the explainer is grounded on ──────────────────────────────────────

/** A weight entry rendered for the model (bucket name + bps + percent). */
export interface WeightView {
  readonly bucket: string;
  readonly bps: number;
  readonly pct: string;
}

/** A compact, serializable decision summary for grounding. */
export interface DecisionView {
  readonly kind: string;
  readonly riskLevel: string;
  readonly rationale: string;
  readonly signals: { type: string; severity: string; summary: string }[];
}

/**
 * Compact, JSON-friendly grounding context. Bigints are pre-formatted to human
 * strings so the model never sees raw 18-dec fixed point.
 */
export interface ExplainContext {
  readonly asOf: string;
  readonly riskLevel: string;
  readonly flags: string[];
  readonly forceDeRisk: boolean;
  readonly usdyOracleNavUsdc: string;
  readonly usdyDexSpotUsdc: string;
  readonly pegDeviationBps: number;
  readonly usdyImpliedApyBps: number;
  readonly aaveUsdcSupplyApyBps: number;
  readonly aaveUtilizationBps: number;
  readonly aaveWithdrawableUsdc: string;
  readonly oracleRangeEnd: string;
  readonly totalAssetsUsdc: string;
  readonly ausdBackingRatioBps: number;
  readonly currentWeights: WeightView[];
  readonly maxUsdyWeightBpsAllowed: number;
  readonly recentDecisions: DecisionView[];
}

export interface ExplainClient {
  explain(question: string, context: ExplainContext): Promise<string>;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const BUCKET_NAME: Record<number, string> = {
  [Bucket.IDLE]: "IDLE",
  [Bucket.AAVE]: "AAVE",
  [Bucket.USDY]: "USDY",
  [Bucket.AUSD]: "AUSD",
};

/** 18-dec fixed-point bigint → USDC string with 4 decimals (e.g. "1.0832"). */
function fmt18(v: bigint): string {
  const whole = v / 1_000_000_000_000_000_000n;
  const frac = (v % 1_000_000_000_000_000_000n) / 100_000_000_000_000n; // 4 dp
  return `${whole.toString()}.${frac.toString().padStart(4, "0")}`;
}

/** 6-dec USDC bigint → string with 2 decimals (e.g. "30000.00"). */
function fmt6(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n) / 10_000n; // 2 dp
  return `${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

function weightViews(weightsBps: Record<number, number>): WeightView[] {
  return Object.entries(weightsBps).map(([bucket, bps]) => ({
    bucket: BUCKET_NAME[Number(bucket)] ?? `BUCKET_${bucket}`,
    bps,
    pct: `${(bps / 100).toFixed(2)}%`,
  }));
}

/**
 * Build the grounding context from the agent's current state. Pure function so
 * it is fully unit-testable. `decisions` should be most-recent-first; only the
 * first few are included to keep the prompt compact.
 */
export function buildExplainContext(
  snapshot: MarketSnapshot,
  assessment: RiskAssessment,
  decisions: readonly Decision[] = [],
  maxDecisions = 5,
): ExplainContext {
  const nav = snapshot.usdyOracleNavUsdc;
  const spot = snapshot.usdyDexSpotUsdc;
  // Peg deviation in bps = |nav - spot| / nav, when both are present.
  let pegDeviationBps = 0;
  if (nav > 0n && spot > 0n) {
    const diff = nav > spot ? nav - spot : spot - nav;
    pegDeviationBps = Number((diff * 10_000n) / nav);
  }

  return {
    asOf: snapshot.asOf,
    riskLevel: assessment.riskLevel,
    flags: assessment.flags,
    forceDeRisk: assessment.forceDeRisk,
    usdyOracleNavUsdc: fmt18(nav),
    usdyDexSpotUsdc: spot > 0n ? fmt18(spot) : "unavailable",
    pegDeviationBps,
    usdyImpliedApyBps: snapshot.usdyImpliedApyBps,
    aaveUsdcSupplyApyBps: snapshot.aaveUsdcSupplyApyBps,
    aaveUtilizationBps: snapshot.aaveUtilizationBps,
    aaveWithdrawableUsdc: fmt6(snapshot.aaveWithdrawableUsdc),
    // Oracle range end as ISO-8601; 0 (unsupported) → empty string.
    oracleRangeEnd: snapshot.oracleRangeEnd > 0 ? new Date(snapshot.oracleRangeEnd * 1000).toISOString() : "",
    totalAssetsUsdc: fmt6(snapshot.totalAssetsUsdc),
    ausdBackingRatioBps: snapshot.ausdBackingRatioBps,
    currentWeights: weightViews(snapshot.currentWeightsBps),
    maxUsdyWeightBpsAllowed: assessment.maxUsdyWeightBpsAllowed,
    recentDecisions: decisions.slice(0, maxDecisions).map((d) => ({
      kind: d.kind,
      riskLevel: d.riskLevel,
      rationale: d.rationale,
      signals: d.signals.map((s) => ({ type: s.type, severity: s.severity, summary: s.summary })),
    })),
  };
}

// ── Anthropic implementation ──────────────────────────────────────────────────

export class AnthropicExplainer implements ExplainClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: AgentConfig) {
    if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required for the explainer");
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.model = config.anthropicModel ?? "claude-haiku-4-5-20251001";
  }

  async explain(question: string, context: ExplainContext): Promise<string> {
    const userMessage = [
      "Context (the vault's current state, authoritative — answer only from this):",
      JSON.stringify(context, null, 2),
      "",
      `Question: ${question}`,
    ].join("\n");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 400,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    return text.length > 0 ? text : "I don't have an answer for that right now.";
  }
}
