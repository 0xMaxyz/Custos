import { getAddress, keccak256, toBytes, type WalletClient, type PublicClient } from "viem";
import { Bucket, MAX_SLIPPAGE_BPS, TOKENS, PROTOCOLS } from "@custos/shared";

import type { AgentConfig } from "../config.js";
import type { ChainClients } from "../chain/clients.js";
import { yieldVaultWriteAbi, yieldVaultAbi } from "../chain/abis.js";
import { assess, isForceDeRiskCondition } from "../risk/engine.js";
import { validateProposal, applyVerdict, type ChainContext } from "../risk/validator.js";
import { runSignalLayer } from "../llm/signals.js";
import { AnthropicClient } from "../llm/anthropic.js";
import { buildEvidenceFetcher, CURATED_EVIDENCE_SOURCES } from "../llm/evidence.js";
import { pinRationale, type RationaleBundle, type PaidEvidenceReceipt } from "./ipfs.js";
import { CycleFailureError } from "./errors.js";
import { writeJournal, clearJournal } from "./txjournal.js";
import type { PaidEvidenceFetcher } from "../payments/evidence.js";
import type { AttestationFacts } from "../data/attestations.js";
import { OneDeltaClient } from "../data/oneDelta.js";
import type { Snapshotter } from "../data/snapshot.js";
import type { WeightsBps, RiskSignal, Decision } from "../types.js";
import type { EvidenceItem } from "../llm/types.js";
import type { MarketSnapshot } from "../types.js";

export interface ExecutorOptions {
  readonly config: AgentConfig;
  readonly clients: ChainClients;
  readonly snapshotter: Snapshotter;
  /**
   * Optional x402 paid-evidence fetcher (A4.1). When set, each cycle pays for the
   * premium feed and pins the settlement receipt into the decision bundle.
   */
  readonly paidEvidence?: PaidEvidenceFetcher | undefined;
  /**
   * Optional provider for the latest parsed Ondo USDY reserve attestation (Dropbox).
   * When set, the LLM's `ondo-usdy-attestation` evidence is built from the report's
   * structured facts instead of a homepage scrape.
   */
  readonly attestationProvider?: (() => Promise<AttestationFacts | null>) | undefined;
  /** Injectable IPFS pin (defaults to {@link pinRationale}); used by tests. */
  readonly pin?: typeof pinRationale | undefined;
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
  /** The submitted decision (rationale + signals), for the explainer / UI. */
  readonly decision?: Decision | undefined;
}

// keccak256("DecisionRecorded(uint256,uint8,bytes32,string)") — topic0 used to
// identify the event in receipts without relying on log position.
export const DECISION_RECORDED_TOPIC0 = keccak256(
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
  private readonly paidEvidence: PaidEvidenceFetcher | undefined;
  private readonly attestationProvider: (() => Promise<AttestationFacts | null>) | undefined;
  private readonly pin: typeof pinRationale;

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
    this.paidEvidence = opts.paidEvidence;
    this.attestationProvider = opts.attestationProvider;
    this.pin = opts.pin ?? pinRationale;
  }

  /**
   * Run one cycle.
   *
   * `full` (default true) runs the complete pipeline — snapshot → assess → LLM →
   * rebalance/deRisk — and is what the periodic (yield-optimisation) loop uses.
   *
   * `full: false` is the cheap 30s breach poll (#3): it reads ONLY the peg/oracle
   * inputs and short-circuits unless they already force a de-risk, so a quiet poll
   * costs a single oracle read instead of the full vault-state snapshot. On a real
   * breach it escalates to the full pipeline below (with fresh vault state).
   */
  async runCycle(opts: { full?: boolean } = {}): Promise<CycleResult> {
    const full = opts.full ?? true;
    const nowSec = Math.floor(Date.now() / 1000);

    if (!full) {
      const peg = await this.snapshotter.pegInputs();
      if (!isForceDeRiskCondition(peg, nowSec)) {
        return { submitted: false, reason: "No breach detected (poll)" };
      }
      // Breach suspected → fall through to the full pipeline, which re-snapshots
      // with fresh vault state before sizing/executing the de-risk.
    }

    // 1. Snapshot.
    const snapshot = await this.snapshotter.snapshot();

    // 2. Deterministic risk assessment.
    const assessment = assess(snapshot, { nowSec });

    // 3. LLM signal layer (tighten-only; null = fallback to deterministic).
    let verdict = null;
    let evidence: EvidenceItem[] = [];
    if (this.config.anthropicApiKey) {
      const llm = new AnthropicClient(this.config);
      const fetcher = buildEvidenceFetcher(undefined, {
        demoEvidenceUrl: this.config.demoDeRiskEvidenceUrl,
        attestation: this.attestationProvider,
      });
      try { evidence = await fetcher(); } catch { evidence = []; }
      verdict = await runSignalLayer(snapshot, assessment, {
        llm,
        fetchEvidence: async () => evidence,
        // Only vetted RWA sources can satisfy the de-risk citation gate (N2).
        trustedEvidenceSources: CURATED_EVIDENCE_SOURCES,
      }).catch(() => null);
    }

    // 3b. Paid evidence (A4.1): pay for a premium feed via x402 and pin its receipt
    //     into the decision bundle. Additive + fail-open — never blocks the cycle.
    let payments: PaidEvidenceReceipt[] = [];
    if (this.paidEvidence) {
      const paid = await this.paidEvidence().catch(() => ({ evidence: [], payments: [] }));
      if (paid.evidence.length > 0) evidence = [...evidence, ...paid.evidence];
      payments = paid.payments;
    }

    // 4. Route to deRisk or rebalance.
    //
    //    ALLOCATOR path: `deRisk()` on-chain requires `evaluateUsdyRisk` → `forceDeRisk`
    //    (checked in YieldVault); calling it without that guard fires `DeRiskConditionNotMet`.
    //    So we only call `_sendDeRisk()` when the deterministic engine raised `forceDeRisk`.
    //
    //    LLM-only deRisk (news/attestation hero path, ROADMAP 3.8):
    //    When `verdict.deRisk === true` but `assessment.forceDeRisk` is false, the LLM
    //    has detected a threat but on-chain conditions haven't tripped yet.  We honour
    //    the tightening by routing through `rebalance()` with USDY clamped to 0 — this
    //    achieves the same USDY→0 outcome through the regular rebalance path (which has
    //    no guard precondition for ALLOCATOR).
    if (assessment.forceDeRisk) {
      return this._sendDeRisk(snapshot, assessment, verdict, evidence, payments);
    }

    // 5. Merge verdict with deterministic assessment.
    // If LLM requested deRisk (news path), force maxUsdy=0 so applyVerdict zeros USDY.
    const llmDeRisk = verdict?.deRisk === true;
    const effectiveVerdict = llmDeRisk && verdict
      ? { ...verdict, usdyMaxWeightBps: 0 }
      : verdict;

    const proposed = applyVerdict(assessment, effectiveVerdict);

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

    // An LLM `deRisk` verdict routed through rebalance is still a REQUIRED de-risk:
    // a failure here must page the operator (O1), not log quietly.
    return this._sendRebalance(
      snapshot, assessment, effectiveVerdict, evidence, finalWeights, payments, llmDeRisk,
    );
  }

  private async _sendRebalance(
    snapshot: MarketSnapshot,
    assessment: ReturnType<typeof assess>,
    verdict: Awaited<ReturnType<typeof runSignalLayer>>,
    evidence: EvidenceItem[],
    weights: WeightsBps,
    payments: PaidEvidenceReceipt[] = [],
    deRiskRequired = false,
  ): Promise<CycleResult> {
    const bundle: RationaleBundle = {
      rationale: verdict?.rationale ?? buildDeterministicRationale(assessment),
      signals: (verdict?.signals ?? []) as RiskSignal[],
      evidence,
      candidateWeightsBps: weights,
      riskLevel: assessment.riskLevel,
      asOf: snapshot.asOf,
      ...(payments.length > 0 ? { payments } : {}),
    };

    const { uri, rationaleHash } = await this.pin(bundle, this.config);
    const weightsArray = toWeightsArray(weights);
    const swapData = await this._buildSwapData(snapshot, weights);

    const receipt = await this._submitAndAwait(
      {
        address: this.vault,
        abi: yieldVaultWriteAbi,
        functionName: "rebalance",
        args: [weightsArray, swapData, uri, rationaleHash, snapshot.usdyDexSpotUsdc],
      },
      { kind: "rebalance", deRiskRequired },
    );
    // The trade changed on-chain weights/TVL — drop the cache so the next cycle
    // (and any /snapshot reader) sees fresh state rather than the pre-trade values.
    this.snapshotter.invalidate();
    const hash = receipt.transactionHash;
    const decisionId = extractDecisionId(receipt);

    const decision: Decision = {
      kind: "REBALANCE",
      weightsBps: weights,
      usdyDexSpotUsdc: snapshot.usdyDexSpotUsdc,
      riskLevel: assessment.riskLevel,
      rationale: bundle.rationale,
      signals: bundle.signals,
    };
    return { submitted: true, kind: "rebalance", decisionId, txHash: hash, reason: "Cycle complete", decision };
  }

  private async _sendDeRisk(
    snapshot: MarketSnapshot,
    assessment: ReturnType<typeof assess>,
    verdict: Awaited<ReturnType<typeof runSignalLayer>>,
    evidence: EvidenceItem[],
    payments: PaidEvidenceReceipt[] = [],
  ): Promise<CycleResult> {
    const flags = assessment.flags.join(", ");
    const bundle: RationaleBundle = {
      rationale: verdict?.rationale ?? `Emergency de-risk: ${flags}`,
      signals: (verdict?.signals ?? []) as RiskSignal[],
      evidence,
      candidateWeightsBps: assessment.candidateWeightsBps,
      riskLevel: "DERISK",
      asOf: snapshot.asOf,
      ...(payments.length > 0 ? { payments } : {}),
    };

    // Pin the evidence bundle and use the URI as the on-chain reason/decisionURI field.
    const { uri, rationaleHash } = await this.pin(bundle, this.config);

    // For a full de-risk we sell all USDY. Build swapData with USDY→USDC calldata.
    const zeroWeights: WeightsBps = {
      [Bucket.IDLE]: 0,
      [Bucket.AAVE]: snapshot.currentWeightsBps[Bucket.AAVE],
      [Bucket.USDY]: 0,
      [Bucket.AUSD]: snapshot.currentWeightsBps[Bucket.AUSD],
    };
    const swapData = await this._buildSwapData(snapshot, zeroWeights);

    const receipt = await this._submitAndAwait(
      {
        address: this.vault,
        abi: yieldVaultWriteAbi,
        functionName: "deRisk",
        args: [0, swapData, uri, rationaleHash, snapshot.usdyDexSpotUsdc],
      },
      { kind: "derisk", deRiskRequired: true },
    );
    // Post-trade on-chain weights/TVL changed — invalidate so the next snapshot is fresh.
    this.snapshotter.invalidate();
    const hash = receipt.transactionHash;
    const decisionId = extractDecisionId(receipt);

    const decision: Decision = {
      kind: "DERISK",
      usdyDexSpotUsdc: snapshot.usdyDexSpotUsdc,
      riskLevel: "DERISK",
      rationale: bundle.rationale,
      signals: bundle.signals,
    };
    return { submitted: true, kind: "derisk", decisionId, txHash: hash, reason: "De-risk executed", decision };
  }

  /**
   * Submit a vault write and await its receipt under tx-lifecycle bounds (O2):
   *   - `writeContract` failure → typed `CycleFailureError` at the `submit` stage.
   *   - receipt wait is bounded by `config.txReceiptTimeoutMs` with a retry; on
   *     timeout/failure → typed `CycleFailureError` at the `receipt` stage,
   *     carrying the broadcast tx hash so the operator can investigate.
   *
   * The `deRiskRequired` flag rides on the thrown error so the scheduler's failure
   * path (O1) can fire a CRITICAL alert when a *required* de-risk does not confirm.
   * Full fee-bump/replacement is out of scope — this is bounded waiting + loud failure.
   */
  private async _submitAndAwait(
    call: {
      address: `0x${string}`;
      abi: typeof yieldVaultWriteAbi;
      functionName: "rebalance" | "deRisk";
      args: readonly unknown[];
    },
    meta: { kind: "derisk" | "rebalance"; deRiskRequired: boolean },
  ) {
    let hash: `0x${string}`;
    try {
      hash = await this.wallet.writeContract({
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        chain: this.wallet.chain,
        account: this.wallet.account!,
      } as Parameters<WalletClient["writeContract"]>[0]);
    } catch (cause) {
      // Never broadcast — no tx hash to report.
      throw new CycleFailureError({ ...meta, stage: "submit", cause });
    }

    // O4: persist the in-flight tx BEFORE awaiting the receipt, so a crash here
    // leaves a crash-recovery hint to reconcile at startup. No-op when unconfigured.
    writeJournal(this.config.agentStatePath, {
      txHash: hash,
      kind: meta.kind,
      deRiskRequired: meta.deRiskRequired,
      sentAt: new Date().toISOString(),
    });

    let receipt;
    try {
      receipt = await this.public.waitForTransactionReceipt({
        hash,
        timeout: this.config.txReceiptTimeoutMs,
        retryCount: 3,
      });
    } catch (cause) {
      // Tx was broadcast but the receipt never confirmed within the bound.
      // Surface the hash so the failure can be traced.
      throw new CycleFailureError({ ...meta, stage: "receipt", cause, txHash: hash });
    }
    // viem RESOLVES on a mined-but-reverted tx (status flags it) — without this
    // check a reverted required de-risk would be reported as a success.
    if (receipt.status === "reverted") {
      throw new CycleFailureError({
        ...meta,
        stage: "receipt",
        cause: new Error("transaction reverted on-chain"),
        txHash: hash,
      });
    }
    // O4: tx confirmed (succeeded) — drop the crash-recovery hint.
    clearJournal(this.config.agentStatePath);
    return receipt;
  }

  /**
   * Build swapData for the vault's rebalance/deRisk call. Only swapData[2] (USDY
   * adapter) is ever populated — IDLE and Aave need no swap calldata, AUSD has its
   * own adapter that handles its own routing. If the USDY weight is unchanged, or
   * the quote fails, we fall back to empty bytes for that slot (which the adapter
   * will revert on if it actually tries to execute a swap).
   */
  private async _buildSwapData(
    snapshot: MarketSnapshot,
    finalWeights: WeightsBps,
  ): Promise<readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`]> {
    const emptySlot = "0x" as const;
    const swapData: [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`] = [
      emptySlot, emptySlot, emptySlot, emptySlot,
    ];

    const currentUsdy = snapshot.currentWeightsBps[Bucket.USDY];
    const finalUsdy = finalWeights[Bucket.USDY];

    if (currentUsdy === finalUsdy) return swapData;

    // Read the USDY adapter address from the vault (adapters[2] = USDY bucket).
    const adapterAddress = await this.public.readContract({
      address: this.vault,
      abi: yieldVaultAbi,
      functionName: "adapters",
      args: [2n],
    }) as `0x${string}`;

    const oneDelta = new OneDeltaClient(this.config);

    // Pinned 1delta swap executor address — must match what UsdyAdapter.AGGREGATOR
    // was deployed with. Reject any quote targeting a different router before signing.
    const pinnedRouter = (PROTOCOLS.usdyAggregatorRouter as string).toLowerCase();

    try {
      let quote;
      if (finalUsdy > currentUsdy) {
        // Deposit path: USDC → USDY. Amount = weight-delta × TVL.
        const deltaWeightBps = BigInt(finalUsdy - currentUsdy);
        const usdcIn = (deltaWeightBps * snapshot.totalAssetsUsdc) / 10_000n;
        quote = await oneDelta.getSwapQuote(
          TOKENS.USDC.address,
          TOKENS.USDY.address,
          usdcIn,
          adapterAddress,
          MAX_SLIPPAGE_BPS,
        );
      } else {
        // Withdraw path: USDY → USDC. Convert USDC value to USDY units via oracle NAV.
        const deltaWeightBps = BigInt(currentUsdy - finalUsdy);
        const usdcValue = (deltaWeightBps * snapshot.totalAssetsUsdc) / 10_000n;
        // usdyOracleNavUsdc is 18-dec (price of 1 USDY in USDC × 1e18).
        // usdyIn (18-dec) = usdcValue (6-dec) × 1e30 / nav (18-dec) — mirrors the on-chain
        // UsdyAdapter.deposit math (expectedUsdy = usdcAmount × 1e30 / nav). The 1e30 carries
        // both the 6→18 decimal scale (1e12) and the price inversion (1e18).
        const usdyIn = (usdcValue * 10n ** 30n) / snapshot.usdyOracleNavUsdc;
        quote = await oneDelta.getSwapQuote(
          TOKENS.USDY.address,
          TOKENS.USDC.address,
          usdyIn,
          adapterAddress,
          MAX_SLIPPAGE_BPS,
        );
      }

      // Fail-closed: reject quotes that target any router other than the pinned one.
      // The adapter enforces this on-chain too, but we catch it here before signing.
      if (quote.router.toLowerCase() !== pinnedRouter) {
        throw new Error(
          `Quote router mismatch: got ${quote.router}, expected ${pinnedRouter}`,
        );
      }

      swapData[2] = quote.calldata;
    } catch {
      // Quote failed (network error, no route, wrong router, API down). Leave swapData[2] empty.
      // If the vault tries to execute a USDY swap with empty calldata it will revert
      // with EmptySwapData — a safe fail-closed outcome.
    }

    return swapData;
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
 * Filters by topic0 (event signature hash) and vault address to avoid mis-identifying
 * other indexed events from unrelated contracts.
 */
export function extractDecisionId(
  receipt: { logs: { address?: string; topics: readonly `0x${string}`[] }[] },
): bigint | undefined {
  for (const log of receipt.logs) {
    const idTopic = log.topics[1];
    // Require a well-formed 32-byte topic before BigInt() — a malformed/short topic
    // would otherwise throw and abort receipt parsing (L3).
    if (log.topics[0] === DECISION_RECORDED_TOPIC0 && idTopic && /^0x[0-9a-fA-F]{64}$/.test(idTopic)) {
      return BigInt(idTopic);
    }
  }
  return undefined;
}
