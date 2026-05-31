import { keccak256, toBytes } from "viem";
import type { AgentConfig } from "../config.js";
import type { RiskSignal, WeightsBps } from "../types.js";
import type { EvidenceItem } from "../llm/types.js";

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
}

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
 * Pin an arbitrary JSON object to IPFS, returning the resolvable URI and the
 * keccak256 of its canonical (2-space) serialization. Shared by the rationale
 * bundle and the ERC-8004 agent card. Falls back to a `data:` URI when no IPFS
 * backend is configured so the caller always has a non-empty URI + stable hash.
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

  // POST to IPFS HTTP API (Kubo-compatible: /api/v0/add).
  const form = new FormData();
  form.append("file", new Blob([json], { type: "application/json" }), filename);

  const res = await fetchImpl(`${config.ipfsApiUrl}/api/v0/add?pin=true`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) throw new Error(`IPFS pin failed: HTTP ${res.status}`);

  const data = (await res.json()) as { Hash?: string };
  if (!data.Hash) throw new Error("IPFS response missing Hash field");

  return { uri: `ipfs://${data.Hash}`, rationaleHash };
}
