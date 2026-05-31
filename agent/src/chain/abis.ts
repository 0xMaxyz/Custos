/**
 * Minimal ABI fragments for the on-chain reads the agent needs. Kept narrow on
 * purpose — only the functions actually called by the readers — so the surface
 * stays auditable and viem's type inference stays sharp.
 */

/** Ondo RWADynamicOracle — getPrice() (18-dec NAV). currentRange() may revert on Mantle. */
export const rwaDynamicOracleAbi = [
  {
    type: "function",
    name: "getPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentRange",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
  },
] as const;

/** ERC-4626 subset: TVL read. */
export const erc4626Abi = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** YieldVault subset for snapshot reads (current allocation + Aave liquidity). */
export const yieldVaultAbi = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "adapters",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "lastRebalanceAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

/** YieldVault write ABI: rebalance + deRisk (ALLOCATOR). */
export const yieldVaultWriteAbi = [
  {
    type: "function",
    name: "rebalance",
    stateMutability: "nonpayable",
    inputs: [
      { name: "targetWeightsBps", type: "uint16[4]" },
      { name: "swapData",         type: "bytes[]" },
      { name: "decisionURI",      type: "string" },
      { name: "rationaleHash",    type: "bytes32" },
      { name: "usdyDexSpotUsdc",  type: "uint256" },
    ],
    outputs: [{ name: "decisionId", type: "uint256" }],
  },
  {
    type: "function",
    name: "deRisk",
    stateMutability: "nonpayable",
    inputs: [
      { name: "toBucket",        type: "uint8" },
      { name: "swapData",        type: "bytes[]" },
      { name: "reason",          type: "string" },
      { name: "evidenceHash",    type: "bytes32" },
      { name: "usdyDexSpotUsdc", type: "uint256" },
    ],
    outputs: [{ name: "decisionId", type: "uint256" }],
  },
] as const;

/** IStrategyAdapter subset: per-bucket value + instant liquidity. */
export const strategyAdapterAbi = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxWithdrawable",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** ERC-20 subset: balanceOf (vault idle USDC). */
export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
