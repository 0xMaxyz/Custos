// Risk-guardian + identity data seams (ROADMAP 4.6 / 4.8 / 5.1).
//
// The vault is resolved for the active chain via resolveDeployment() (the
// committed @custos/shared address, or a VITE_VAULT_ADDRESS override). When it
// resolves, backfills historical DecisionRecorded events via getLogs (from vault
// deployment block) then watches for new ones. Reads the agent identity from the
// ERC-8004 canonical registry when VITE_AGENT_ID is set. Fixture fallback only
// when no vault is deployed for the chain (or VITE_DEMO_MODE); consumers unchanged.
//
// Deployed but no events yet → isLive:true, decisions:[] (empty live feed,
// not the demo fixture data).

import { useReadContract, useWatchContractEvent, usePublicClient, useChainId } from "wagmi";
import { useRef, useState, useEffect }                              from "react";
import { decisions as fixtureDecisions, identity as fixtureIdentity, baseline as fixtureBaseline, type Decision } from "./data";
import { computeBaseline, type BaselineSummary } from "./baseline";
import { VAULT_ABI }      from "./vaultAbi";
import { resolveDeployment } from "./deployment";

// Deployment block hint: scope getLogs to avoid full-chain scan on mainnet.
// Set VITE_VAULT_DEPLOY_BLOCK after deploy (defaults to 0 = from genesis).
const DEPLOY_BLOCK = BigInt(import.meta.env.VITE_VAULT_DEPLOY_BLOCK ?? "0");

// Mantle RPC providers cap the block span of a single getLogs call, so a lone
// fromBlock→latest query can exceed the per-call limit and fail (N5). Page the range.
const MAX_LOG_RANGE = 10_000n;

/**
 * Fetch logs over `[fromBlock, latest]` in `maxRange`-sized pages, concatenated in
 * order. `getBlockNumber` resolves the head; `getLogsRange` runs one bounded query.
 * Splitting the span keeps each call within provider log-range limits (N5).
 */
export async function getLogsPaged<T>(
  getBlockNumber: () => Promise<bigint>,
  getLogsRange: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<T[]>,
  fromBlock: bigint,
  maxRange: bigint = MAX_LOG_RANGE,
): Promise<T[]> {
  const head = await getBlockNumber();
  const out: T[] = [];
  for (let start = fromBlock; start <= head; start += maxRange) {
    const end = start + maxRange - 1n < head ? start + maxRange - 1n : head;
    out.push(...(await getLogsRange({ fromBlock: start, toBlock: end })));
  }
  return out;
}

// ── Canonical ERC-8004 identity registry ABI (read-only subset) ──────────────
const IDENTITY_ABI = [
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// IPFS gateway for resolving the agent card (ipfs:// → https). Override with
// VITE_IPFS_GATEWAY_URL; defaults to a public Pinata gateway.
const IPFS_GATEWAY = (import.meta.env.VITE_IPFS_GATEWAY_URL ?? "https://gateway.pinata.cloud").replace(/\/+$/, "");

/** Resolve an ipfs:// (or ipfs/<cid>) URI to an HTTPS gateway URL; pass through http(s)/data. */
export function ipfsToGateway(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    const cid = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `${IPFS_GATEWAY}/ipfs/${cid}`;
  }
  return uri;
}

/** The slice of the pinned ERC-8004 agent card the UI surfaces. */
export interface AgentCardLite {
  name?: string;
  sells?: { endpoint: string; payTo: `0x${string}`; asset: `0x${string}`; priceBaseUnits: string };
}

// Minimal Decision shape built from on-chain data. Fields that require
// off-chain resolution (signals, evidence, outcome, txHash) start as empty
// defaults and can be enriched later when the decisionURI bundle is fetched.
// blockTimestamp: pass log.blockNumber * 1 as a stable ordering key; the
// accurate wall-clock time comes from the decisionURI bundle (future work).
function buildLiveDecision(args: {
  id: bigint; kind: number; rationaleHash: `0x${string}`; decisionURI: string;
  blockNumber?: bigint;
}): Decision {
  // Use a stable placeholder — actual timestamp from bundle fetch (Phase 5b).
  const timestamp = new Date().toISOString();
  return {
    id:              Number(args.id),
    kind:            args.kind as 0 | 1,
    timestamp,
    riskLevel:       "NORMAL",
    confidence:      0,
    preWeightsBps:   { IDLE: 0, AAVE: 0, USDY: 0, AUSD: 0 },
    postWeightsBps:  { IDLE: 0, AAVE: 0, USDY: 0, AUSD: 0 },
    flags:           [],
    maxUsdyWeightBpsAllowed: 6000,
    summary:         `Decision #${Number(args.id)} — bundle resolving…`,
    rationale:       "",
    signals:         [],
    evidence:        [],
    rationaleHash:   args.rationaleHash as string,
    decisionURI:     args.decisionURI,
    outcome:         { realizedYieldBps: 0, passiveDeltaBps: 0, drawdownAvoidedUsdc: "0", measuredAt: "" },
    txHash:          "",
  };
}

export interface GuardianFeed {
  decisions: Decision[];
  /** true once the feed comes from chain; false while served from fixtures. */
  isLive: boolean;
}

export function useDecisions(): GuardianFeed {
  const chainId = useChainId();
  const VAULT_ADDRESS = resolveDeployment(chainId).vault as `0x${string}`;
  const isDeployed = VAULT_ADDRESS.length > 2;
  // null = loading (deployed, fetch in progress); [] = loaded but empty
  const [liveDecisions, setLiveDecisions] = useState<Decision[] | null>(isDeployed ? null : []);
  const seenIds = useRef(new Set<number>());
  const client = usePublicClient();

  // Backfill historical DecisionRecorded events on mount.
  useEffect(() => {
    if (!isDeployed || !client) {
      setLiveDecisions([]);
      return;
    }
    getLogsPaged(
      () => client.getBlockNumber(),
      ({ fromBlock, toBlock }) => client.getLogs({
        address: VAULT_ADDRESS,
        event: {
          type: "event",
          name: "DecisionRecorded",
          inputs: [
            { name: "id",            type: "uint256", indexed: true  },
            { name: "kind",          type: "uint8",   indexed: false },
            { name: "rationaleHash", type: "bytes32", indexed: false },
            { name: "decisionURI",   type: "string",  indexed: false },
          ],
        },
        fromBlock,
        toBlock,
      }),
      DEPLOY_BLOCK,
    ).then((logs) => {
      const next: Decision[] = [];
      for (const log of [...logs].reverse()) {
        const args = log.args as { id: bigint; kind: number; rationaleHash: `0x${string}`; decisionURI: string };
        const nId = Number(args.id);
        if (seenIds.current.has(nId)) continue;
        seenIds.current.add(nId);
        next.push(buildLiveDecision({ ...args, blockNumber: log.blockNumber ?? undefined }));
      }
      setLiveDecisions(next);
    }).catch(() => {
      // getLogs unavailable — fall back to empty live feed, watch-only.
      setLiveDecisions([]);
    });
  }, [client, VAULT_ADDRESS, isDeployed]);

  // Watch for new events after mount.
  useWatchContractEvent({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    eventName: "DecisionRecorded",
    enabled: isDeployed,
    onLogs(logs) {
      setLiveDecisions((prev) => {
        const next = [...(prev ?? [])];
        for (const log of logs) {
          const { id, kind, rationaleHash, decisionURI } = log.args as {
            id: bigint; kind: number; rationaleHash: `0x${string}`; decisionURI: string;
          };
          const nId = Number(id);
          if (seenIds.current.has(nId)) continue;
          seenIds.current.add(nId);
          next.unshift(buildLiveDecision({ id, kind, rationaleHash, decisionURI, blockNumber: log.blockNumber ?? undefined }));
        }
        return next;
      });
    },
  });

  if (!isDeployed) return { decisions: fixtureDecisions, isLive: false };
  // liveDecisions === null means getLogs still in flight. Return empty live feed
  // (not demo fixtures) so a deployed vault never shows fictional de-risk history.
  return { decisions: liveDecisions ?? [], isLive: true };
}

/** Look up a single decision by id (detail view). */
export function useDecision(id: number): Decision | undefined {
  const { decisions } = useDecisions();
  return decisions.find((d) => d.id === id);
}

const AGENT_ID_RAW = import.meta.env.VITE_AGENT_ID ?? "";
const agentIdBigInt = AGENT_ID_RAW ? BigInt(AGENT_ID_RAW) : undefined;

const IDENTITY_REGISTRY =
  (import.meta.env.VITE_IDENTITY_REGISTRY ?? "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432") as `0x${string}`;

export type IdentityRecord = typeof fixtureIdentity;

export interface IdentityData {
  identity: IdentityRecord;
  baseline: BaselineSummary;
  /** Pinned agent card resolved from tokenURI via the IPFS gateway (or undefined). */
  card: AgentCardLite | undefined;
  /** HTTPS gateway URL for the agent card (clickable), or "". */
  cardUrl: string;
  isLive: boolean;
}

export function useIdentity(): IdentityData {
  const enabled = agentIdBigInt !== undefined;
  const { data: rawURI } = useReadContract({
    address: IDENTITY_REGISTRY,
    abi: IDENTITY_ABI,
    functionName: "tokenURI",
    args: agentIdBigInt !== undefined ? [agentIdBigInt] : undefined,
    query: { enabled },
  });
  const { data: rawOwner } = useReadContract({
    address: IDENTITY_REGISTRY,
    abi: IDENTITY_ABI,
    functionName: "ownerOf",
    args: agentIdBigInt !== undefined ? [agentIdBigInt] : undefined,
    query: { enabled },
  });
  // isLive only when tokenURI has actually resolved from chain, not just when
  // VITE_AGENT_ID is set.
  const tokenURI = rawURI as string | undefined;
  const owner = rawOwner as `0x${string}` | undefined;
  const isLive = tokenURI !== undefined && tokenURI.length > 0;
  const cardUrl = tokenURI ? ipfsToGateway(tokenURI) : "";

  // Resolve the pinned agent card JSON through the gateway (name + x402 sells offer).
  const [card, setCard] = useState<AgentCardLite | undefined>(undefined);
  useEffect(() => {
    if (!cardUrl) {
      setCard(undefined);
      return;
    }
    let cancelled = false;
    fetch(cardUrl)
      .then((r) => (r.ok ? (r.json() as Promise<AgentCardLite>) : undefined))
      .then((j) => { if (!cancelled && j) setCard(j); })
      .catch(() => { /* gateway miss — leave card undefined, UI falls back */ });
    return () => { cancelled = true; };
  }, [cardUrl]);

  const identity: IdentityRecord = {
    ...fixtureIdentity,
    agentId: AGENT_ID_RAW ? Number(AGENT_ID_RAW) : fixtureIdentity.agentId,
    name: card?.name ?? fixtureIdentity.name,
    agentURI: tokenURI ?? fixtureIdentity.agentURI,
    owner: owner ?? fixtureIdentity.owner,
    identityRegistry: IDENTITY_REGISTRY,
  };
  return {
    identity,
    baseline: computeBaseline(fixtureBaseline),
    card,
    cardUrl,
    isLive,
  };
}
