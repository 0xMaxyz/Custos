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
  /**
   * Block the vault was deployed at. Used to scope `getLogs` (decisions, cost-basis)
   * so the web app never scans from genesis — a full-chain scan on Mantle is thousands
   * of paged RPC calls and triggers public-RPC 429s. 0 = unknown (falls back to genesis).
   */
  vaultDeployBlock: number;
}

const empty: DeploymentAddresses = {
  guardrails: "",
  vault: "",
  benchmark: "",
  aaveAdapter: "",
  usdyAdapter: "",
  ausdAdapter: "",
  agentId: null,
  vaultDeployBlock: 0,
};

/** Mainnet (chainId 5000) deployed addresses. */
export const MAINNET_DEPLOYMENT: DeploymentAddresses = {
  guardrails:  "0x90C52C8Bd9df235b012e1920E5E8bb43B4B16e55",
  vault:       "0xc4dc4Bc6e7bF61300747b017C08Ae86b63F08d3F",
  benchmark:   "0xf1feCfc87fe4613AbCcd6B591884Ce12f272cb87",
  aaveAdapter: "0x158FDE048f7ecEDE51580B1e990dcaCB3125C0b6",
  usdyAdapter: "0xFe58aaB3C14BB2Af5555c6753b2971d0ADfBfd9f",
  ausdAdapter: "0x0E695Cdb8010Ca7D75F90860eCc63a569888484e",
  agentId: 128,
  vaultDeployBlock: 96604858,
};

/** Testnet (chainId 5003) deployed addresses. Populate after testnet deploy. */
export const TESTNET_DEPLOYMENT: DeploymentAddresses = {
  guardrails: "0xc3D287D35DCb6945d93c246dbE610C9AF5106E9c",
  vault:      "0xC2009De9C72EfAfAeeD8Ceac2960A9B6eFEeAc85",
  benchmark:  "0xCd3EcF4d092eE73Ac4882c61b5f114588B6B122a",
  aaveAdapter: "",
  usdyAdapter: "0xd420Bdf2a7eab8F86DE12f06728342b7243101C9",
  ausdAdapter: "",
  agentId: null,
  vaultDeployBlock: 0,
};

/** Return the deployment record for a given chainId, or the empty record. */
export function getDeployment(chainId: number): DeploymentAddresses {
  if (chainId === 5000) return MAINNET_DEPLOYMENT;
  if (chainId === 5003) return TESTNET_DEPLOYMENT;
  return empty;
}
