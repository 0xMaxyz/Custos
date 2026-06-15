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
import { useState, useEffect }                              from "react";
import { decisions as fixtureDecisions, identity as fixtureIdentity, baseline as fixtureBaseline, type Decision } from "./data";
import { computeBaseline, type BaselineSummary } from "./baseline";
import { VAULT_ABI }      from "./vaultAbi";
import { resolveDeployment } from "./deployment";

// Mantle RPC providers cap the block span of a single getLogs call, so a lone
// fromBlock→latest query can exceed the per-call limit and fail (N5). Page the range.
const MAX_LOG_RANGE = 10_000n;

// Agent API base. When set, the decision feed is fetched from the agent's cached
// /decisions endpoint (built server-side once) instead of scanned in the browser.
const AGENT_API_URL = (import.meta.env.VITE_AGENT_API_URL ?? "").replace(/\/+$/, "");

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

type W = { IDLE: number; AAVE: number; USDY: number; AUSD: number };

// On-chain event ABIs used to enrich the decision feed (signatures verified against
// contracts/src/YieldVault.sol). Rebalanced carries the resulting weights; DeRisked
// carries the destination bucket.
const REBALANCED_EVENT = {
  type: "event", name: "Rebalanced",
  inputs: [
    { name: "id", type: "uint256", indexed: true },
    { name: "postWeightsBps", type: "uint16[4]", indexed: false },
  ],
} as const;
const DERISKED_EVENT = {
  type: "event", name: "DeRisked",
  inputs: [
    { name: "id", type: "uint256", indexed: true },
    { name: "toBucket", type: "uint8", indexed: false },
    { name: "evidenceHash", type: "bytes32", indexed: false },
  ],
} as const;
const DECISION_RECORDED_EVENT = {
  type: "event", name: "DecisionRecorded",
  inputs: [
    { name: "id", type: "uint256", indexed: true },
    { name: "kind", type: "uint8", indexed: false },
    { name: "rationaleHash", type: "bytes32", indexed: false },
    { name: "decisionURI", type: "string", indexed: false },
  ],
} as const;

/** A short "30% Idle / 70% Aave" description of the largest target buckets. */
function describeWeights(w: W): string {
  const parts = ([["Idle", w.IDLE], ["Aave", w.AAVE], ["USDY", w.USDY], ["AUSD", w.AUSD]] as [string, number][])
    .filter(([, b]) => b > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, b]) => `${Math.round(b / 100)}% ${k}`);
  return parts.join(" / ") || "—";
}

/** Best-effort post-weights for a de-risk (USDY → 0 into the destination bucket). */
function deriveDeRiskPost(pre: W, toBucket: number | undefined): W {
  const moved = pre.USDY;
  if (moved === 0) return pre;
  return toBucket === 3
    ? { ...pre, USDY: 0, AUSD: pre.AUSD + moved }
    : { ...pre, USDY: 0, IDLE: pre.IDLE + moved };
}

// Build a Decision from on-chain data. Manual ALLOCATOR actions (decisionURI prefixed
// "manual:") have no LLM bundle, so confidence/benchmark-outcome are flagged off and a
// plain-language summary is derived from the resulting weights.
function buildLiveDecision(args: {
  id: number; kind: number; rationaleHash: `0x${string}`; decisionURI: string;
  txHash: string; timestamp: string; pre: W; post: W; toBucket?: number;
}): Decision {
  const isManual = args.decisionURI.startsWith("manual:");
  const kindLabel = args.kind === 1 ? "de-risk" : "rebalance";
  const summary = isManual
    ? `Manual ${kindLabel} → ${describeWeights(args.post)}`
    : `Agent ${kindLabel} → ${describeWeights(args.post)}`;
  return {
    id:              args.id,
    kind:            args.kind as 0 | 1,
    timestamp:       args.timestamp,
    riskLevel:       args.kind === 1 ? "DERISK" : "NORMAL",
    confidence:      0,
    ...(args.toBucket !== undefined ? { toBucket: args.toBucket } : {}),
    preWeightsBps:   args.pre,
    postWeightsBps:  args.post,
    flags:           [],
    maxUsdyWeightBpsAllowed: 6000,
    summary,
    rationale:       isManual
      ? "Manual ALLOCATOR action, submitted on-chain within the guardrails. No model rationale — this was an operator decision."
      : "Recorded on-chain; the full model rationale lives in the decision bundle.",
    signals:         [],
    evidence:        [],
    rationaleHash:   args.rationaleHash as string,
    decisionURI:     args.decisionURI,
    outcome:         { realizedYieldBps: 0, passiveDeltaBps: 0, drawdownAvoidedUsdc: "0", measuredAt: "" },
    txHash:          args.txHash,
    isManual,
  };
}

const IDLE_ONLY: W = { IDLE: 10_000, AAVE: 0, USDY: 0, AUSD: 0 };
const toW = (a: readonly number[]): W => ({ IDLE: a[0] ?? 0, AAVE: a[1] ?? 0, USDY: a[2] ?? 0, AUSD: a[3] ?? 0 });

export interface GuardianFeed {
  decisions: Decision[];
  /** true once the feed comes from chain; false while served from fixtures. */
  isLive: boolean;
  /** true while the on-chain backfill is still in flight (deployed vault, no data yet). */
  loading: boolean;
  /** true when the log fetch failed outright. */
  error: boolean;
}

export function useDecisions(): GuardianFeed {
  const chainId = useChainId();
  const dep = resolveDeployment(chainId);
  const VAULT_ADDRESS = dep.vault as `0x${string}`;
  const isDeployed = VAULT_ADDRESS.length > 2;
  const deployBlock = dep.vaultDeployBlock;
  // null = loading (deployed, fetch in progress); [] = loaded but empty
  const [liveDecisions, setLiveDecisions] = useState<Decision[] | null>(isDeployed ? null : []);
  const [error, setError] = useState(false);
  // Bump to re-run the loader (used by the live watch when a new event arrives).
  const [reloadKey, setReloadKey] = useState(0);
  const client = usePublicClient();

  // Load the full feed: DecisionRecorded (the spine) joined with Rebalanced (post
  // weights) + DeRisked (destination) + block timestamps. Scoped to the vault deploy
  // block so we never scan from genesis (a full-chain Mantle scan is thousands of paged
  // getLogs calls — the public-RPC 429 storm). Rebuilds the whole feed (not append-only)
  // so derived pre-weights stay consistent.
  useEffect(() => {
    if (!isDeployed || !client) {
      setLiveDecisions([]);
      return;
    }
    let cancelled = false;
    setError(false); // initial liveDecisions is already null (loading); refetches keep the
    // current list visible and swap it in when ready — no skeleton flash on live updates.

    // Fast path: the agent serves a cached, server-built feed at /decisions, so the
    // browser skips the expensive multi-page getLogs backfill entirely. A reload (new
    // on-chain decision via the watch below) forces a server resync with ?refresh=1.
    // Falls back to the direct on-chain scan when the agent API is unset or unreachable.
    const fromEndpoint = async (): Promise<boolean> => {
      if (!AGENT_API_URL) return false;
      try {
        const res = await fetch(`${AGENT_API_URL}/decisions${reloadKey > 0 ? "?refresh=1" : ""}`);
        if (!res.ok) return false;
        const data = (await res.json()) as { decisions?: Decision[] };
        if (!Array.isArray(data.decisions)) return false;
        if (!cancelled) setLiveDecisions(data.decisions);
        return true;
      } catch {
        return false;
      }
    };

    const head = () => client.getBlockNumber();
    const range = (event: typeof DECISION_RECORDED_EVENT | typeof REBALANCED_EVENT | typeof DERISKED_EVENT) =>
      getLogsPaged(head, ({ fromBlock, toBlock }) => client.getLogs({ address: VAULT_ADDRESS, event, fromBlock, toBlock }), deployBlock);

    const fromChain = () => Promise.all([range(DECISION_RECORDED_EVENT), range(REBALANCED_EVENT), range(DERISKED_EVENT)])
      .then(async ([decLogs, rebLogs, derLogs]) => {
        // id → resulting weights / destination bucket.
        const postById = new Map<number, W>();
        for (const l of rebLogs) {
          const a = l.args as { id: bigint; postWeightsBps: readonly number[] };
          postById.set(Number(a.id), toW(a.postWeightsBps));
        }
        const toBucketById = new Map<number, number>();
        for (const l of derLogs) {
          const a = l.args as { id: bigint; toBucket: number };
          toBucketById.set(Number(a.id), Number(a.toBucket));
        }

        // Fetch a timestamp per unique block the decisions landed in (deduped).
        const blocks = [...new Set(decLogs.map((l) => l.blockNumber).filter((b): b is bigint => b != null))];
        const tsByBlock = new Map<bigint, number>();
        await Promise.all(
          blocks.map((b) => client.getBlock({ blockNumber: b }).then((blk) => tsByBlock.set(b, Number(blk.timestamp))).catch(() => {})),
        );
        if (cancelled) return;

        // Build ascending by id so pre-weights chain from the previous decision's post.
        const ascending = [...decLogs].sort((x, y) => {
          const xi = Number((x.args as { id: bigint }).id), yi = Number((y.args as { id: bigint }).id);
          return xi - yi;
        });
        let prev: W = IDLE_ONLY;
        const built: Decision[] = [];
        for (const log of ascending) {
          const a = log.args as { id: bigint; kind: number; rationaleHash: `0x${string}`; decisionURI: string };
          const id = Number(a.id);
          const kind = Number(a.kind);
          const toBucket = toBucketById.get(id);
          const post = kind === 1 ? deriveDeRiskPost(prev, toBucket) : postById.get(id) ?? prev;
          const ts = log.blockNumber != null ? tsByBlock.get(log.blockNumber) : undefined;
          built.push(buildLiveDecision({
            id, kind, rationaleHash: a.rationaleHash, decisionURI: a.decisionURI,
            txHash: log.transactionHash ?? "",
            timestamp: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
            pre: prev, post,
            ...(toBucket !== undefined ? { toBucket } : {}),
          }));
          prev = post;
        }
        built.reverse(); // most-recent first
        if (!cancelled) setLiveDecisions(built);
      });

    // Try the cached endpoint first; on miss/failure, scan the chain directly.
    fromEndpoint()
      .then((ok) => (ok ? undefined : fromChain()))
      .catch(() => { if (!cancelled) { setLiveDecisions([]); setError(true); } });

    return () => { cancelled = true; };
  }, [client, VAULT_ADDRESS, isDeployed, deployBlock, reloadKey]);

  // A new on-chain decision → trigger a full reload (keeps pre/post chaining correct).
  useWatchContractEvent({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    eventName: "DecisionRecorded",
    enabled: isDeployed,
    onLogs() {
      setReloadKey((k) => k + 1);
    },
  });

  if (!isDeployed) return { decisions: fixtureDecisions, isLive: false, loading: false, error: false };
  // liveDecisions === null means getLogs still in flight. Return empty live feed
  // (not demo fixtures) so a deployed vault never shows fictional de-risk history.
  return { decisions: liveDecisions ?? [], isLive: true, loading: liveDecisions === null, error };
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
