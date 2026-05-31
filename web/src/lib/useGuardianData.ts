// Risk-guardian + identity data seams (ROADMAP 4.6 / 4.8 / 5.1).
//
// When VITE_VAULT_ADDRESS is set, backfills historical DecisionRecorded events
// via getLogs (from vault deployment block) then watches for new ones.
// Reads the agent identity from the ERC-8004 canonical registry when VITE_AGENT_ID
// is set. Fixture fallback when undeployed; consumers are unchanged.
//
// Deployed but no events yet → isLive:true, decisions:[] (empty live feed,
// not the demo fixture data).

import { useReadContract, useWatchContractEvent, usePublicClient } from "wagmi";
import { useRef, useState, useEffect }                              from "react";
import { decisions as fixtureDecisions, identity, baseline, type Decision } from "./data";
import { erc8004 }        from "./data";
import { computeBaseline, type BaselineSummary } from "./baseline";
import { VAULT_ABI }      from "./vaultAbi";

const VAULT_ADDRESS = (import.meta.env.VITE_VAULT_ADDRESS ?? "") as `0x${string}`;
const isDeployed = VAULT_ADDRESS.length > 2;

// Deployment block hint: scope getLogs to avoid full-chain scan on mainnet.
// Set VITE_VAULT_DEPLOY_BLOCK after deploy (defaults to 0 = from genesis).
const DEPLOY_BLOCK = BigInt(import.meta.env.VITE_VAULT_DEPLOY_BLOCK ?? "0");

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

// Minimal Decision shape built from on-chain data. Fields that require
// off-chain resolution (signals, evidence, outcome, txHash) start as empty
// defaults and can be enriched later when the decisionURI bundle is fetched.
function buildLiveDecision(args: {
  id: bigint; kind: number; rationaleHash: `0x${string}`; decisionURI: string;
}): Decision {
  return {
    id:              Number(args.id),
    kind:            args.kind as 0 | 1,
    timestamp:       new Date().toISOString(),
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
      fromBlock: DEPLOY_BLOCK,
    }).then((logs) => {
      const next: Decision[] = [];
      for (const log of [...logs].reverse()) {
        const args = log.args as { id: bigint; kind: number; rationaleHash: `0x${string}`; decisionURI: string };
        const nId = Number(args.id);
        if (seenIds.current.has(nId)) continue;
        seenIds.current.add(nId);
        next.push(buildLiveDecision(args));
      }
      setLiveDecisions(next);
    }).catch(() => {
      // getLogs unavailable — fall back to empty live feed, watch-only.
      setLiveDecisions([]);
    });
  }, [client]);

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
          next.unshift(buildLiveDecision({ id, kind, rationaleHash, decisionURI }));
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

  // Baseline stays on fixtures until AgentBenchmark reads land (PR-5b/addendum).
  return {
    identity: { ...identity, agentURI: tokenUri as string },
    baseline: computeBaseline(baseline),
    isLive: true,
  };
}
