/**
 * Demo pre-flight (docs/demo.md, Step 4).
 *
 * Dry-runs the LLM signal layer against the STAGED de-risk evidence and prints
 * whether the model returns a clamped `deRisk: true` verdict citing a trusted
 * source — WITHOUT touching the chain or submitting any tx. Run this until the
 * verdict is reliable, then film the live cycle.
 *
 *   ANTHROPIC_API_KEY=... DEMO_DERISK_EVIDENCE_URL=https://trycustos.xyz/demo/derisk-evidence.html \
 *     pnpm -C agent demo:derisk-dryrun
 *
 * Exits 0 if the staged scenario produces a de-risk, 1 otherwise.
 */
import { Bucket } from "@custos/shared";
import { loadConfig } from "../config.js";
import { AnthropicClient } from "../llm/anthropic.js";
import { buildEvidenceFetcher, CURATED_EVIDENCE_SOURCES } from "../llm/evidence.js";
import { buildLLMInput } from "../llm/signals.js";
import type { MarketSnapshot, RiskAssessment, WeightsBps } from "../types.js";

// This pre-flight defaults to z.ai's Anthropic-compatible GLM endpoint (what we use
// for the demo); ANTHROPIC_BASE_URL / ANTHROPIC_MODEL in the env still override.
const DEMO_BASE_URL = "https://api.z.ai/api/anthropic";
const DEMO_MODEL = "GLM-4.6V";

function weights(idle: number, aave: number, usdy: number, ausd: number): WeightsBps {
  return { [Bucket.IDLE]: idle, [Bucket.AAVE]: aave, [Bucket.USDY]: usdy, [Bucket.AUSD]: ausd };
}

// A calm, at-peg market with a healthy ~45% USDY position — the realistic pre-film
// state. The ONLY abnormal input is the staged evidence document, so a de-risk here
// is attributable to the LLM's reading of that evidence (not the deterministic path).
const NOW = Math.floor(Date.now() / 1000);
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

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.anthropicApiKey) {
    console.error("ANTHROPIC_API_KEY is required for the dry-run.");
    process.exit(1);
  }
  if (!config.demoDeRiskEvidenceUrl) {
    console.error("DEMO_DERISK_EVIDENCE_URL is required — point it at the staged evidence page.");
    process.exit(1);
  }

  const fetchEvidence = buildEvidenceFetcher(undefined, {
    demoEvidenceUrl: config.demoDeRiskEvidenceUrl,
  });

  const evidence = await fetchEvidence();
  console.log(`\nFetched ${evidence.length} evidence item(s):`);
  for (const e of evidence) {
    console.log(`  • [${e.id}] (${e.source}) ${e.summary}`);
  }

  // Guard: the staged page must actually be served. If the URL falls back to the
  // SPA shell (Caddy try_files → index.html when the static file isn't deployed),
  // the summary is the site tagline, not a threat — bail BEFORE spending a (rate-
  // limited) LLM call on evidence that can never justify a de-risk.
  const THREAT_KEYWORDS = ["usdy", "redemption", "depeg", "nav", "attestation", "reserve", "custodian"];
  const staged = evidence.find((e) => e.id === "ondo-usdy-attestation");
  if (!staged || !THREAT_KEYWORDS.some((k) => staged.summary.toLowerCase().includes(k))) {
    console.error(
      "\n⚠️  Staged evidence missing or looks like the SPA fallback (no threat keywords).",
    );
    console.error(
      "    The page at DEMO_DERISK_EVIDENCE_URL probably isn't deployed — rebuild/redeploy",
    );
    console.error("    web, or point the var at a locally-served copy of web/public/demo/derisk-evidence.html.");
    process.exit(3);
  }

  // Env wins; otherwise fall back to the z.ai GLM demo defaults.
  const llmConfig = {
    ...config,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? DEMO_BASE_URL,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? DEMO_MODEL,
  };
  console.log(`\nLLM: model=${llmConfig.anthropicModel} baseUrl=${llmConfig.anthropicBaseUrl}`);

  // Fail fast in the interactive pre-flight: 1 retry instead of the production 5, so a
  // sustained z.ai overload surfaces in seconds rather than minutes of backoff.
  const llm = new AnthropicClient(llmConfig, { maxRetries: 1 });

  // Call the model directly (NOT via runSignalLayer, which swallows API errors into
  // a null fallback) so a transient gateway error — e.g. z.ai 529 overloaded_error —
  // is reported as an infra problem, distinct from the model genuinely holding.
  const input = buildLLMInput(SNAPSHOT, ASSESSMENT, evidence);
  let raw;
  try {
    raw = await llm.complete(input);
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error(`\n⚠️  LLM API call FAILED${status ? ` (HTTP ${status})` : ""} — NOT a wording issue.`);
    console.error(String(err instanceof Error ? err.message : err));
    console.error("Retry (transient overload), check the key/base URL/model, then re-run.");
    process.exit(2);
  }

  console.log("\nRaw verdict:");
  console.log(JSON.stringify(raw, null, 2));

  // Mirror clampVerdict's de-risk gate (signals.ts): deRisk holds only if a cited
  // signal resolves to evidence from a trusted source.
  const citedTrusted = raw.signals.some(
    (s) =>
      s.evidenceId !== undefined &&
      evidence.some((e) => e.id === s.evidenceId && CURATED_EVIDENCE_SOURCES.has(e.source)),
  );
  // The executor de-risks whenever deRisk===true (it forces USDY→0 and routes through
  // rebalance), gated only by a trusted citation (N2). riskLevel=DERISK is preferred
  // but not required for the de-risk to execute.
  const ok = raw.deRisk === true && citedTrusted;

  if (ok) {
    console.log("\n✅ PASS — model de-risks with a trusted, cited signal. Safe to film the live cycle.");
    if (raw.riskLevel !== "DERISK") {
      console.log(`   (note: riskLevel=${raw.riskLevel}, not DERISK — the de-risk still executes on the deRisk flag.)`);
    }
  } else if (raw.deRisk && !citedTrusted) {
    console.log("\n❌ FAIL — model said deRisk but cited no trusted evidenceId; the gate would reject it.");
  } else {
    console.log("\n❌ FAIL — model held (no de-risk). Strengthen the staged document title/description and retry.");
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("dry-run failed:", err);
  process.exit(1);
});
