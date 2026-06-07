import { payAndFetch, type Eip3009Signer, type FetchLike } from "./x402.js";
import type { EvidenceItem } from "../llm/types.js";
import type { PaidEvidenceReceipt } from "../executor/ipfs.js";

/**
 * Fetches premium evidence the agent PAYS for via x402 (A4.1) and returns both the
 * evidence item(s) and the x402 settlement receipt(s) to pin into the decision
 * bundle — making "the agent paid for the evidence it acted on" verifiable.
 */
export type PaidEvidenceFetcher = () => Promise<{
  evidence: EvidenceItem[];
  payments: PaidEvidenceReceipt[];
}>;

export interface PaidEvidenceConfig {
  /** The premium (x402-gated) feed URL. */
  readonly url: string;
  /** Payer address (the EIP-3009 `from`). */
  readonly from: `0x${string}`;
  /** Signs the EIP-3009 authorization (viem account in prod; stub in tests). */
  readonly signer: Eip3009Signer;
  readonly evidenceId?: string;
  readonly type?: EvidenceItem["type"];
  readonly source?: string;
  /**
   * Hard ceiling (base units) on what the agent will pay this feed. Over-cap prices
   * are rejected before signing (N1); the rejection degrades to empty evidence below.
   */
  readonly maxPriceBaseUnits?: bigint | undefined;
  /** Injected transport (defaults to global fetch). */
  readonly fetchImpl?: FetchLike;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Build a {@link PaidEvidenceFetcher} that pays the configured feed and maps the
 * response into one evidence item bound to its settlement receipt. Failures (no
 * route, payment declined, network) degrade to empty arrays — paid evidence is
 * additive, never required for a cycle to proceed.
 */
export function buildPaidEvidenceFetcher(cfg: PaidEvidenceConfig): PaidEvidenceFetcher {
  const fetchImpl: FetchLike = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const id = cfg.evidenceId ?? "x402-premium";
  return async () => {
    try {
      const res = await payAndFetch<Record<string, unknown>>({
        url: cfg.url,
        from: cfg.from,
        signer: cfg.signer,
        fetchImpl,
        maxAmountBaseUnits: cfg.maxPriceBaseUnits,
      });
      const summary =
        typeof res.data?.summary === "string"
          ? res.data.summary
          : JSON.stringify(res.data).slice(0, 280);
      const evidence: EvidenceItem[] = [
        {
          id,
          type: cfg.type ?? "ATTESTATION",
          source: cfg.source ?? hostOf(cfg.url),
          url: cfg.url,
          publishedAt: new Date().toISOString().slice(0, 10),
          summary,
        },
      ];
      const payments: PaidEvidenceReceipt[] = res.receipt
        ? [{ evidenceId: id, receipt: res.receipt }]
        : [];
      return { evidence, payments };
    } catch {
      return { evidence: [], payments: [] };
    }
  };
}
