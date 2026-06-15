import { keccak256, toBytes } from "viem";
import type { AgentConfig } from "../config.js";
import type { RiskSignal, WeightsBps } from "../types.js";
import type { EvidenceItem } from "../llm/types.js";
import type { SettlementReceipt } from "../payments/x402.js";

/**
 * An x402 settlement receipt for a premium feed the agent paid for, bound to the
 * evidence item it bought (`evidenceId`). Pinning these into the decision bundle
 * makes "the agent paid for the evidence it acted on" verifiable (ROADMAP A4.1).
 */
export interface PaidEvidenceReceipt {
  readonly evidenceId: string;
  readonly receipt: SettlementReceipt;
}

/**
 * Rationale bundle assembled before signing a decision. Contains the human-readable
 * rationale + signals (with resolved evidence) that get hashed and pinned to IPFS.
 */
export interface RationaleBundle {
  readonly rationale: string;
  readonly signals: RiskSignal[];
  readonly evidence: EvidenceItem[];
  readonly candidateWeightsBps: WeightsBps;
  readonly riskLevel: string;
  readonly asOf: string;
  /**
   * Model confidence (0–1) for this decision. Pinned so the UI can surface it — it is
   * NOT recorded on-chain (only the rationaleHash + decisionURI are), so the decision
   * bundle is the single source for it. Optional: deterministic/no-LLM decisions omit it.
   */
  readonly confidence?: number;
  /** x402 receipts for any premium evidence the agent paid for (A4.1). Optional. */
  readonly payments?: PaidEvidenceReceipt[];
}

/** Max time to wait on the IPFS pin before aborting (L2). */
const PIN_TIMEOUT_MS = 10_000;

export interface PinResult {
  /** IPFS CID (or a fallback URI when no IPFS backend is configured). */
  readonly uri: string;
  /** keccak256 of the canonical JSON blob. */
  readonly rationaleHash: `0x${string}`;
}

/**
 * Pin a rationale bundle to IPFS. When `IPFS_API_URL` is configured we POST to
 * the HTTP API (Kubo / Pinata compatible). Otherwise we return a `data:` URI so
 * the agent can still call on-chain and record the hash — the content is just not
 * externally resolvable (acceptable for a local fork demo).
 */
export async function pinRationale(
  bundle: RationaleBundle,
  config: AgentConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PinResult> {
  return pinJson(bundle, config, "rationale.json", fetchImpl);
}

/**
 * Resolve the pin endpoint for the configured backend. Pinata's pinning API is
 * not Kubo-RPC compatible (different path + CID field), so route Pinata hosts to
 * `/pinning/pinFileToIPFS` and everything else to the Kubo `/api/v0/add` API.
 */
function pinEndpoint(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, "");
  if (/(^|\.)pinata\.cloud$/i.test(new URL(apiUrl).hostname)) {
    return `${base}/pinning/pinFileToIPFS`;
  }
  return `${base}/api/v0/add?pin=true`;
}

/**
 * Pin an arbitrary JSON object to IPFS, returning the resolvable URI and the
 * keccak256 of its canonical (2-space) serialization. Shared by the rationale
 * bundle and the ERC-8004 agent card. When `IPFS_PINNING_JWT` is set it's sent
 * as a `Bearer` token (required by Pinata; ignored by an open Kubo node).
 * Falls back to a `data:` URI when no IPFS backend is configured so the caller
 * always has a non-empty URI + stable hash.
 */
export async function pinJson(
  value: unknown,
  config: AgentConfig,
  filename: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PinResult> {
  const json = JSON.stringify(value, null, 2);
  const rationaleHash = keccak256(toBytes(json)) as `0x${string}`;

  if (!config.ipfsApiUrl) {
    // Fallback: encode as data URI so the URI is always non-empty.
    const encoded = Buffer.from(json).toString("base64");
    return { uri: `data:application/json;base64,${encoded}`, rationaleHash };
  }

  // Multipart body. Both Kubo `/api/v0/add` and Pinata `pinFileToIPFS` take a `file` field.
  const form = new FormData();
  form.append("file", new Blob([json], { type: "application/json" }), filename);

  // Authenticated pinning services (Pinata) require a bearer JWT; an open Kubo node
  // ignores it. Don't set Content-Type — fetch derives the multipart boundary.
  const headers: Record<string, string> = {};
  if (config.ipfsPinningJwt) {
    headers.Authorization = `Bearer ${config.ipfsPinningJwt}`;
  }

  // Bound the pin so a slow/hung pinning provider can't block the decision cycle (L2).
  // The pin is fail-open in the executor, so an abort surfaces as a thrown error there.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PIN_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof fetchImpl>>;
  try {
    res = await fetchImpl(pinEndpoint(config.ipfsApiUrl), {
      method: "POST",
      body: form,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`IPFS pin failed: HTTP ${res.status}`);

  // Kubo returns `Hash`; Pinata returns `IpfsHash`.
  const data = (await res.json()) as { Hash?: string; IpfsHash?: string };
  const cid = data.Hash ?? data.IpfsHash;
  if (!cid) throw new Error("IPFS response missing CID (Hash/IpfsHash) field");

  return { uri: `ipfs://${cid}`, rationaleHash };
}
