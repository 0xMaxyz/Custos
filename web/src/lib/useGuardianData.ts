// Risk-guardian + identity data seams (ROADMAP 4.6 / 4.8 / 5.1).
//
// When VITE_VAULT_ADDRESS is set, reads live DecisionRecorded events from the
// vault and the agent identity from the ERC-8004 canonical registry.
// Until then returns typed fixtures. Consumers are unchanged.

import { useReadContract, useWatchContractEvent } from "wagmi";
import { useRef, useState }                        from "react";
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
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export interface GuardianFeed {
  decisions: Decision[];
  /** true once the feed comes from chain; false while served from fixtures. */
  isLive: boolean;
}

export function useDecisions(): GuardianFeed {
  // Accumulate live DecisionRecorded events.
  const [liveDecisions, setLiveDecisions] = useState<Decision[]>([]);
  const seenIds = useRef(new Set<number>());

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
          // Minimal shape — outcome + signals resolved lazily via AgentBenchmark (Phase 5b).
          next.unshift({
            ...fixtureDecisions[0]!,
            id: nId,
            kind: kind as 0 | 1,
            rationaleHash: rationaleHash as string,
            decisionURI,
            timestamp: new Date().toISOString(),
          });
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

  // Merge live agentURI into the identity fixture; other fields (trackRecord)
  // come from AgentBenchmark reads wired in Phase 5b addendum.
  return {
    identity: { ...identity, agentURI: tokenUri as string },
    baseline: computeBaseline(baseline),
    isLive: true,
  };
}
