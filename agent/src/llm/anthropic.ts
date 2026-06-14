import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../config.js";
import { RiskVerdictSchema, type LLMClient, type LLMInput, type RiskVerdict } from "./types.js";

const SYSTEM_PROMPT = `You are Custos's risk-guardian analyst for a tokenized-Treasury (USDY) yield vault on Mantle.
You DO NOT control funds. You output strict JSON matching the provided schema only.
You may only TIGHTEN risk (reduce USDY weight or raise riskLevel); you may NEVER increase
exposure or exceed deterministic.maxUsdyWeightBpsAllowed. Base every claim on the provided
marketState and evidence; never invent data or sources. If evidence is insufficient, prefer caution.
Recommend deRisk=true only for a concrete, cited threat (depeg, oracle issue, issuer/regulatory event).
CITATIONS ARE MANDATORY: every signal you derive from an evidence item MUST set "evidenceId" to
that item's "id". A deRisk=true verdict is ONLY honored if at least one signal cites a real
evidenceId from the provided evidence — an uncited deRisk is silently discarded. When you set
deRisk=true, also set riskLevel="DERISK" and usdyMaxWeightBps=0.`;

const OUTPUT_SCHEMA = {
  name: "risk_verdict",
  description: "Structured risk verdict for the current cycle",
  input_schema: {
    type: "object" as const,
    properties: {
      riskLevel: {
        type: "string",
        enum: ["NORMAL", "CAUTION", "DERISK"],
        description: "Risk level; may only match or raise the deterministic level",
      },
      usdyMaxWeightBps: {
        type: "number",
        description: "Max USDY weight in bps; must be <= deterministic.maxUsdyWeightBpsAllowed",
      },
      deRisk: {
        type: "boolean",
        description: "True only with a concrete cited threat in signals",
      },
      rationale: {
        type: "string",
        description: "Human-readable rationale (1–3 sentences)",
      },
      signals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["PEG", "ORACLE", "LIQUIDITY", "YIELD", "ISSUER", "REGULATORY"] },
            severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
            summary: { type: "string" },
            evidenceId: {
              type: "string",
              description:
                "REQUIRED when this signal is based on a provided evidence item: set it to that item's id (e.g. 'ondo-usdy-attestation'). A deRisk verdict needs at least one signal with a real evidenceId.",
            },
          },
          required: ["type", "severity", "summary"],
        },
      },
      confidence: {
        type: "number",
        description: "Model confidence [0,1]",
      },
    },
    required: ["riskLevel", "usdyMaxWeightBps", "deRisk", "rationale", "signals", "confidence"],
  },
};

export class AnthropicClient implements LLMClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: AgentConfig, opts: { maxRetries?: number } = {}) {
    if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required for LLM calls");
    this.client = new Anthropic({
      apiKey: config.anthropicApiKey,
      baseURL: config.anthropicBaseUrl,
      // Anthropic-compatible gateways (e.g. z.ai/GLM) return transient 429/529 under
      // load. The SDK retries 429/5xx with backoff (honoring retry-after); bump the
      // default (2) so a brief overload doesn't collapse a whole risk cycle to the
      // deterministic fallback. Callers that prefer to fail fast (e.g. the interactive
      // dry-run) can lower this.
      maxRetries: opts.maxRetries ?? 5,
    });
    this.model = config.anthropicModel ?? "claude-haiku-4-5-20251001";
  }

  async complete(input: LLMInput): Promise<RiskVerdict> {
    const userMessage = JSON.stringify(input, null, 2);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      temperature: 0.1,
      system: SYSTEM_PROMPT,
      tools: [OUTPUT_SCHEMA],
      tool_choice: { type: "tool", name: "risk_verdict" },
      messages: [{ role: "user", content: userMessage }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Model did not call the risk_verdict tool");
    }

    return RiskVerdictSchema.parse(toolUse.input);
  }
}
