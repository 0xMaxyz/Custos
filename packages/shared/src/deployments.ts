/**
 * Sentinel deployed contract addresses.
 *
 * Canonical source of truth after each broadcast:
 *   1. Forge prints a JSON summary — copy into deployments/<chainId>.json.
 *   2. Paste vault/guardrails/benchmark addresses into MAINNET_DEPLOYMENT /
 *      TESTNET_DEPLOYMENT below (or run the post-deploy populate script).
 *   3. Set the matching VITE_* / agent env vars.
 *
 * Runtime authority:
 *   - **Web app**: reads VITE_VAULT_ADDRESS + VITE_AGENT_ID (env at build time).
 *   - **Agent**: reads VAULT_ADDRESS + BENCHMARK_ADDRESS (process.env).
 *   - **This file**: typed constants consumed by tests and the agent SDK; they
 *     mirror the JSON files and must be kept in sync after each deploy.
 *
 * Until a deploy happens the values are empty strings — callers must guard
 * against address(0) / empty.
 */

export interface DeploymentAddresses {
  guardrails: string;
  vault: string;
  benchmark: string;
  aaveAdapter: string;
  usdyAdapter: string;
  /** ERC-8004 agent token id, or null before registration. */
  agentId: number | null;
}

const empty: DeploymentAddresses = {
  guardrails: "",
  vault: "",
  benchmark: "",
  aaveAdapter: "",
  usdyAdapter: "",
  agentId: null,
};

/** Mainnet (chainId 5000) deployed addresses. Populate after deploy. */
export const MAINNET_DEPLOYMENT: DeploymentAddresses = { ...empty };

/** Testnet (chainId 5003) deployed addresses. Populate after testnet deploy. */
export const TESTNET_DEPLOYMENT: DeploymentAddresses = { ...empty };

/** Return the deployment record for a given chainId, or the empty record. */
export function getDeployment(chainId: number): DeploymentAddresses {
  if (chainId === 5000) return MAINNET_DEPLOYMENT;
  if (chainId === 5003) return TESTNET_DEPLOYMENT;
  return empty;
}
