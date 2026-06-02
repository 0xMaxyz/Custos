/**
 * Custos deployed contract addresses.
 *
 * Canonical source of truth after each broadcast:
 *   1. Forge prints a JSON summary — copy into deployments/<chainId>.json.
 *   2. Paste vault/guardrails/benchmark addresses into MAINNET_DEPLOYMENT /
 *      TESTNET_DEPLOYMENT below (or run the post-deploy populate script).
 *   3. Set the matching VITE_* / agent env vars.
 *
 * Runtime authority:
 *   - **Web app**: resolves the vault for the active chain from this file by
 *     default (web/src/lib/deployment.ts); VITE_VAULT_ADDRESS overrides and
 *     VITE_DEMO_MODE=true forces fixtures. VITE_AGENT_ID gates the identity read.
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
  ausdAdapter: string;
  /** ERC-8004 agent token id, or null before registration. */
  agentId: number | null;
}

const empty: DeploymentAddresses = {
  guardrails: "",
  vault: "",
  benchmark: "",
  aaveAdapter: "",
  usdyAdapter: "",
  ausdAdapter: "",
  agentId: null,
};

/** Mainnet (chainId 5000) deployed addresses. Populate after deploy. */
export const MAINNET_DEPLOYMENT: DeploymentAddresses = { ...empty };

/** Testnet (chainId 5003) deployed addresses. Populate after testnet deploy. */
export const TESTNET_DEPLOYMENT: DeploymentAddresses = {
  guardrails: "0xc3D287D35DCb6945d93c246dbE610C9AF5106E9c",
  vault:      "0xC2009De9C72EfAfAeeD8Ceac2960A9B6eFEeAc85",
  benchmark:  "0xCd3EcF4d092eE73Ac4882c61b5f114588B6B122a",
  aaveAdapter: "",
  usdyAdapter: "0xd420Bdf2a7eab8F86DE12f06728342b7243101C9",
  ausdAdapter: "",
  agentId: null,
};

/** Return the deployment record for a given chainId, or the empty record. */
export function getDeployment(chainId: number): DeploymentAddresses {
  if (chainId === 5000) return MAINNET_DEPLOYMENT;
  if (chainId === 5003) return TESTNET_DEPLOYMENT;
  return empty;
}
