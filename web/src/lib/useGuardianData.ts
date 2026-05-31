// Risk-guardian + identity data seams (ROADMAP 4.6 / 4.8 / 5.1).
//
// When VITE_VAULT_ADDRESS is set, backfills historical DecisionRecorded events
// via getLogs from block 0 then watches for new ones via useWatchContractEvent.
// Reads the agent identity from the ERC-8004 canonical registry when VITE_AGENT_ID
// is set. Fixture fallback when undeployed; consumers are unchanged.

import { useReadContract, useWatchContractEvent, usePublicClient } from "wagmi";
import { useRef, useState, useEffect }                              from "react";
import { decisions as fixtureDecisions, identity, baseline, type Decision } from "./data";
import { erc8004 }        from "./data";
import { computeBaseline, type BaselineSummary } from "./baseline";
import { VAULT_ABI }      from "./vaultAbi";

const VAULT_ADDRESS = (import.meta.env.VITE_VAULT_ADDRESS ?? "") as `0x${string}`;
const isDeployed = VAULT_ADDRESS.length > 2;

// ── Canonical ERC-8004 identity registry ABI (read-only subset) ──────────────
const IDENTITY_ABI = [
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export interface GuardianFeed {
  decisions: Decision[];
  /** true once the feed comes from chain; false while served from fixtures. */
  isLive: boolean;
}

function mergeDecision(base: Decision, log: {
  id: bigint; kind: number; rationaleHash: `0x${string}`; decisionURI: string;
}): Decision {
  return {
    ...base,
    id: Number(log.id),
    kind: log.kind as 0 | 1,
    rationaleHash: log.rationaleHash as string,
    decisionURI: log.decisionURI,
    timestamp: new Date().toISOString(),
  };
}

export function useDecisions(): GuardianFeed {
  const [liveDecisions, setLiveDecisions] = useState<Decision[]>([]);
  const seenIds = useRef(new Set<number>());
  const client = usePublicClient();

  // Backfill historical DecisionRecorded events on mount.
  useEffect(() => {
    if (!isDeployed || !client) return;
    client.getLogs({
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
      fromBlock: 0n,
    }).then((logs) => {
      if (logs.length === 0) return;
      setLiveDecisions(() => {
        const next: Decision[] = [];
        for (const log of [...logs].reverse()) {
          const args = log.args as { id: bigint; kind: number; rationaleHash: `0x${string}`; decisionURI: string };
          const nId = Number(args.id);
          if (seenIds.current.has(nId)) continue;
          seenIds.current.add(nId);
          next.push(mergeDecision(fixtureDecisions[0]!, args));
        }
        return next;
      });
    }).catch(() => { /* getLogs unavailable — watch-only fallback */ });
  }, [client]);

  // Watch for new events after mount.
  useWatchContractEvent({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    eventName: "DecisionRecorded",
    enabled: isDeployed,
    onLogs(logs) {
      setLiveDecisions((prev) => {
        const next = [...prev];
        for (const log of logs) {
          const { id, kind, rationaleHash, decisionURI } = log.args as {
            id: bigint; kind: number; rationaleHash: `0x${string}`; decisionURI: string;
          };
          const nId = Number(id);
          if (seenIds.current.has(nId)) continue;
          seenIds.current.add(nId);
          next.unshift(mergeDecision(fixtureDecisions[0]!, { id, kind, rationaleHash, decisionURI }));
        }
        return next;
      });
    },
  });

  if (!isDeployed) return { decisions: fixtureDecisions, isLive: false };
  return {
    decisions: liveDecisions.length > 0 ? liveDecisions : fixtureDecisions,
    isLive: liveDecisions.length > 0,
  };
}

/** Look up a single decision by id (detail view). */
export function useDecision(id: number): Decision | undefined {
  const { decisions } = useDecisions();
  return decisions.find((d) => d.id === id);
}

export interface IdentityData {
  identity: typeof identity;
  /** Derived Sentinel-vs-passive baseline summary for the counter widget. */
  baseline: BaselineSummary;
  isLive: boolean;
}

export function useIdentity(): IdentityData {
  const agentId = import.meta.env.VITE_AGENT_ID
    ? BigInt(import.meta.env.VITE_AGENT_ID as string)
    : undefined;

  const { data: tokenUri } = useReadContract({
    address: erc8004.identity,
    abi: IDENTITY_ABI,
    functionName: "tokenURI",
    args: agentId !== undefined ? [agentId] : [0n],
    query: { enabled: isDeployed && agentId !== undefined },
  });

  if (!isDeployed || !tokenUri) {
    return { identity, baseline: computeBaseline(baseline), isLive: false };
  }

  return {
    identity: { ...identity, agentURI: tokenUri as string },
    baseline: computeBaseline(baseline),
    isLive: true,
  };
}
