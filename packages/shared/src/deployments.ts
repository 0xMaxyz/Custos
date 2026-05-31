/**
 * Sentinel deployed contract addresses.
 *
 * Populated by `forge script script/Deploy.s.sol` output.
 * The web app reads VITE_VAULT_ADDRESS (env) to enable live reads; these
 * constants provide the full address set for the agent + tests.
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
