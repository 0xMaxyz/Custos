import { getAddress, keccak256, toBytes, type WalletClient, type PublicClient } from "viem";
import { Bucket } from "@sentinel/shared";

import type { AgentConfig } from "../config.js";
import type { ChainClients } from "../chain/clients.js";
import { yieldVaultWriteAbi, yieldVaultAbi } from "../chain/abis.js";
import { assess } from "../risk/engine.js";
import { validateProposal, applyVerdict, type ChainContext } from "../risk/validator.js";
import { runSignalLayer } from "../llm/signals.js";
import { AnthropicClient } from "../llm/anthropic.js";
import { buildEvidenceFetcher } from "../llm/evidence.js";
import { pinRationale, type RationaleBundle } from "./ipfs.js";
import type { Snapshotter } from "../data/snapshot.js";
import type { WeightsBps, RiskSignal } from "../types.js";
import type { EvidenceItem } from "../llm/types.js";

export interface ExecutorOptions {
  readonly config: AgentConfig;
  readonly clients: ChainClients;
  readonly snapshotter: Snapshotter;
}

/**
 * Result of one agent execution cycle. When `submitted` is false, the cycle ran
 * but no tx was sent (e.g. no allocation change needed, or validator rejected).
 */
export interface CycleResult {
  readonly submitted: boolean;
  readonly kind?: "rebalance" | "derisk" | undefined;
  readonly decisionId?: bigint | undefined;
  readonly txHash?: `0x${string}` | undefined;
  readonly reason: string;
}

// keccak256("DecisionRecorded(uint256,uint8,bytes32,string)") — topic0 used to
// identify the event in receipts without relying on log position.
const DECISION_RECORDED_TOPIC0 = keccak256(
  toBytes("DecisionRecorded(uint256,uint8,bytes32,string)"),
) as `0x${string}`;

/**
 * Executor — the end-to-end agent cycle:
 *
 *   snapshot → deterministic assess → LLM signal layer → applyVerdict →
 *   validateProposal → IPFS pin → sign + send rebalance/deRisk tx
 *
 * Fails loudly if ALLOCATOR key or vault address are not configured.
 */
export class Executor {
  private readonly config: AgentConfig;
  private readonly wallet: WalletClient;
  private readonly public: PublicClient;
  private readonly vault: `0x${string}`;
  private readonly snapshotter: Snapshotter;

  constructor(opts: ExecutorOptions) {
    if (!opts.clients.walletClient)
      throw new Error("ALLOCATOR_PRIVATE_KEY is required for execution");
    if (!opts.config.vaultAddress)
      throw new Error("VAULT_ADDRESS is required for execution");

    this.config = opts.config;
    this.wallet = opts.clients.walletClient;
    this.public = opts.clients.publicClient;
    this.vault = getAddress(opts.config.vaultAddress);
    this.snapshotter = opts.snapshotter;
  }

  async runCycle(): Promise<CycleResult> {
    // 1. Snapshot.
    const snapshot = await this.snapshotter.snapshot();

    // 2. Deterministic risk assessment.
    const nowSec = Math.floor(Date.now() / 1000);
    const assessment = assess(snapshot, { nowSec });

    // 3. LLM signal layer (tighten-only; null = fallback to deterministic).
    let verdict = null;
    let evidence: EvidenceItem[] = [];
    if (this.config.anthropicApiKey) {
      const llm = new AnthropicClient(this.config);
      const fetcher = buildEvidenceFetcher();
      // Fetch evidence separately so it can be included in the pinned bundle.
      try { evidence = await fetcher(); } catch { evidence = []; }
      verdict = await runSignalLayer(snapshot, assessment, { llm, fetchEvidence: async () => evidence })
        .catch(() => null);
    }

    // 4. Deterministic forceDeRisk always wins; honour LLM deRisk with cited evidence
    //    only when the on-chain `evaluateUsdyRisk` conditions would allow it (i.e. the
    //    depeg/oracle flag fired via the DEX spot we supply). Per SPEC §3.3 the LLM
    //    may only tighten — if it requests deRisk, we treat it as forceDeRisk=true.
    const llmDeRisk = verdict?.deRisk === true;
    if (assessment.forceDeRisk || llmDeRisk) {
      return this._sendDeRisk(snapshot, assessment, verdict, evidence);
    }

    // 5. Merge verdict with deterministic assessment.
    const proposed = applyVerdict(assessment, verdict);

    // 6. Read chain context for the interval check.
    const lastRebalanceAt = await this.public.readContract({
      address: this.vault,
      abi: yieldVaultAbi,
      functionName: "lastRebalanceAt",
    });
    const ctx: ChainContext = { lastRebalanceAt: Number(lastRebalanceAt), nowSec };

    // 7. Validate (with auto-repair if possible).
    let finalWeights = proposed;
    const validation = validateProposal(
      proposed,
      snapshot.currentWeightsBps,
      snapshot,
      assessment.maxUsdyWeightBpsAllowed,
      ctx,
    );

    if (!validation.valid) {
      if (validation.repairedWeightsBps) {
        finalWeights = validation.repairedWeightsBps;
      } else {
        return { submitted: false, reason: `Proposal rejected: ${validation.errors.join(", ")}` };
      }
    }

    // 8. Skip if no change.
    if (weightsEqual(finalWeights, snapshot.currentWeightsBps)) {
      return { submitted: false, reason: "No allocation change needed" };
    }

    return this._sendRebalance(snapshot, assessment, verdict, evidence, finalWeights);
  }

  private async _sendRebalance(
    snapshot: ReturnType<Snapshotter["snapshot"]> extends Promise<infer T> ? T : never,
    assessment: ReturnType<typeof assess>,
    verdict: Awaited<ReturnType<typeof runSignalLayer>>,
    evidence: EvidenceItem[],
    weights: WeightsBps,
  ): Promise<CycleResult> {
    const bundle: RationaleBundle = {
      rationale: verdict?.rationale ?? buildDeterministicRationale(assessment),
      signals: (verdict?.signals ?? []) as RiskSignal[],
      evidence,
      candidateWeightsBps: weights,
      riskLevel: assessment.riskLevel,
      asOf: snapshot.asOf,
    };

    const { uri, rationaleHash } = await pinRationale(bundle, this.config);
    const weightsArray = toWeightsArray(weights);
    const emptySwap = ["0x", "0x", "0x", "0x"] as const;

    const hash = await this.wallet.writeContract({
      address: this.vault,
      abi: yieldVaultWriteAbi,
      functionName: "rebalance",
      args: [weightsArray, emptySwap, uri, rationaleHash, snapshot.usdyDexSpotUsdc],
      chain: this.wallet.chain,
      account: this.wallet.account!,
    });

    const receipt = await this.public.waitForTransactionReceipt({ hash });
    const decisionId = extractDecisionId(receipt);

    return { submitted: true, kind: "rebalance", decisionId, txHash: hash, reason: "Cycle complete" };
  }

  private async _sendDeRisk(
    snapshot: ReturnType<Snapshotter["snapshot"]> extends Promise<infer T> ? T : never,
    assessment: ReturnType<typeof assess>,
    verdict: Awaited<ReturnType<typeof runSignalLayer>>,
    evidence: EvidenceItem[],
  ): Promise<CycleResult> {
    const flags = assessment.flags.join(", ");
    const reason = verdict?.rationale ?? `Emergency de-risk: ${flags}`;
    const bundle: RationaleBundle = {
      rationale: reason,
      signals: (verdict?.signals ?? []) as RiskSignal[],
      evidence,
      candidateWeightsBps: assessment.candidateWeightsBps,
      riskLevel: "DERISK",
      asOf: snapshot.asOf,
    };

    const { rationaleHash } = await pinRationale(bundle, this.config);
    const emptySwap = ["0x", "0x", "0x", "0x"] as const;

    const hash = await this.wallet.writeContract({
      address: this.vault,
      abi: yieldVaultWriteAbi,
      functionName: "deRisk",
      args: [0, emptySwap, reason, rationaleHash, snapshot.usdyDexSpotUsdc],
      chain: this.wallet.chain,
      account: this.wallet.account!,
    });

    const receipt = await this.public.waitForTransactionReceipt({ hash });
    const decisionId = extractDecisionId(receipt);

    return { submitted: true, kind: "derisk", decisionId, txHash: hash, reason: "De-risk executed" };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function weightsEqual(a: WeightsBps, b: WeightsBps): boolean {
  return (
    a[Bucket.IDLE] === b[Bucket.IDLE] &&
    a[Bucket.AAVE] === b[Bucket.AAVE] &&
    a[Bucket.USDY] === b[Bucket.USDY] &&
    a[Bucket.AUSD] === b[Bucket.AUSD]
  );
}

function toWeightsArray(w: WeightsBps): readonly [number, number, number, number] {
  return [w[Bucket.IDLE], w[Bucket.AAVE], w[Bucket.USDY], w[Bucket.AUSD]] as const;
}

function buildDeterministicRationale(assessment: ReturnType<typeof assess>): string {
  if (assessment.flags[0] === "NONE") {
    return "Deterministic engine: no flags raised; maintaining current allocation.";
  }
  return `Deterministic engine raised: ${assessment.flags.join(", ")}. Risk level: ${assessment.riskLevel}.`;
}

/**
 * Extract decisionId from a `DecisionRecorded(uint256 indexed decisionId, ...)` event.
 * Filters by topic0 (event signature hash) to avoid mis-identifying other indexed events.
 */
function extractDecisionId(
  receipt: { logs: { address?: string; topics: readonly `0x${string}`[] }[] },
): bigint | undefined {
  for (const log of receipt.logs) {
    if (log.topics[0] === DECISION_RECORDED_TOPIC0 && log.topics[1]) {
      return BigInt(log.topics[1]);
    }
  }
  return undefined;
}
