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

/**
 * Governance-event ABIs (mainnet launch security control). Signatures verified
 * against contracts/src/Guardrails.sol and contracts/src/YieldVault.sol:
 *
 *   Guardrails: event ConfigQueued(Config newConfig, uint256 unlocksAt)
 *               event ConfigCancelled()
 *               event ConfigUpdated(Config newConfig)   // emitted on activation
 *   YieldVault: event GuardrailsQueued(address indexed newGuardrails, uint256 unlocksAt)
 *               event GuardrailsUpdated(address indexed newGuardrails) // activation
 *
 * NOTE: there is no `ConfigActivated` / `GuardrailsActivated` event in the source —
 * activation surfaces as `ConfigUpdated` / `GuardrailsUpdated` respectively. We
 * decode only the fields we page on (the queued config blob itself is not needed
 * for the alert), so the `Config` tuple is intentionally omitted from the decoded
 * args — getLogs still matches by event topic0.
 */
export const guardrailsEventsAbi = [
  {
    type: "event",
    name: "ConfigQueued",
    inputs: [
      { name: "newConfig", type: "tuple", indexed: false, components: [
        { name: "maxWeightBps", type: "uint16[4]" },
        { name: "minIdleBps", type: "uint16" },
        { name: "minInstantLiquidityBps", type: "uint16" },
        { name: "maxUsdyNotionalUsdc", type: "uint256" },
        { name: "maxSlippageBps", type: "uint16" },
        { name: "maxRebalanceMoveBps", type: "uint16" },
        { name: "minRebalanceInterval", type: "uint32" },
        { name: "tvlCap", type: "uint256" },
        { name: "perTxDepositCap", type: "uint256" },
        { name: "addStrategyTimelock", type: "uint32" },
        { name: "pegWarnBps", type: "uint16" },
        { name: "pegBlockBps", type: "uint16" },
        { name: "pegDeRiskBps", type: "uint16" },
        { name: "oracleMaxAge", type: "uint32" },
        { name: "oracleRangeEndBuffer", type: "uint32" },
      ] },
      { name: "unlocksAt", type: "uint256", indexed: false },
    ],
  },
  { type: "event", name: "ConfigCancelled", inputs: [] },
  {
    type: "event",
    name: "ConfigUpdated",
    inputs: [
      { name: "newConfig", type: "tuple", indexed: false, components: [
        { name: "maxWeightBps", type: "uint16[4]" },
        { name: "minIdleBps", type: "uint16" },
        { name: "minInstantLiquidityBps", type: "uint16" },
        { name: "maxUsdyNotionalUsdc", type: "uint256" },
        { name: "maxSlippageBps", type: "uint16" },
        { name: "maxRebalanceMoveBps", type: "uint16" },
        { name: "minRebalanceInterval", type: "uint32" },
        { name: "tvlCap", type: "uint256" },
        { name: "perTxDepositCap", type: "uint256" },
        { name: "addStrategyTimelock", type: "uint32" },
        { name: "pegWarnBps", type: "uint16" },
        { name: "pegBlockBps", type: "uint16" },
        { name: "pegDeRiskBps", type: "uint16" },
        { name: "oracleMaxAge", type: "uint32" },
        { name: "oracleRangeEndBuffer", type: "uint32" },
      ] },
    ],
  },
] as const;

/** YieldVault governance events: pending-guardrails queue + activation. */
export const yieldVaultGovernanceEventsAbi = [
  {
    type: "event",
    name: "GuardrailsQueued",
    inputs: [
      { name: "newGuardrails", type: "address", indexed: true },
      { name: "unlocksAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GuardrailsUpdated",
    inputs: [{ name: "newGuardrails", type: "address", indexed: true }],
  },
] as const;
