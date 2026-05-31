// Risk-guardian + identity data seams (ROADMAP 4.6 / 4.8).
//
// DEFERRED (like useVaultData): live data needs a deployed vault + AgentBenchmark
// + ERC-8004 registration, none of which exist on testnet yet. Until then these
// hooks return the canonical typed fixtures so the Activity/Agent pages render an
// accurate shape behind a stable seam. When the contracts ship:
//   - useDecisions → index DecisionRecorded/OutcomeUpdated events (or a subgraph)
//     keyed off VITE_VAULT_ADDRESS, resolving each decisionURI via lib/decisionUri.
//   - useIdentity  → read tokenURI/getAgentWallet on the canonical IdentityRegistry
//     and the agent's track record from AgentBenchmark.
// Consumer components do not change.

import { decisions, identity, baseline, type Decision } from "./data";
import { computeBaseline, type BaselineSummary } from "./baseline";

export interface GuardianFeed {
  decisions: Decision[];
  /** true once the feed comes from chain/indexer; false while served from fixtures. */
  isLive: boolean;
}

export function useDecisions(): GuardianFeed {
  // TODO(phase-1-deploy): replace with event indexing keyed off VITE_VAULT_ADDRESS.
  return { decisions, isLive: false };
}

/** Look up a single decision by id (detail view). */
export function useDecision(id: number): Decision | undefined {
  return decisions.find((d) => d.id === id);
}

export interface IdentityData {
  identity: typeof identity;
  /** Derived Sentinel-vs-passive baseline summary for the counter widget. */
  baseline: BaselineSummary;
  isLive: boolean;
}

export function useIdentity(): IdentityData {
  // TODO(phase-1-deploy): read canonical IdentityRegistry + AgentBenchmark.
  return { identity, baseline: computeBaseline(baseline), isLive: false };
}
