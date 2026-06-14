// Custos canonical mock data (§15 taxonomy, §16 dictionary, §17 fixtures).
// Mirrors Design/src/data.js with TypeScript types.

export const chains = {
  mainnet: { id: 5000, label: "Mantle", short: "Mantle" },
  testnet: { id: 5003, label: "Mantle Sepolia", short: "Sepolia" },
} as const;

export type ChainKey = keyof typeof chains;

export const explorer = "https://mantlescan.xyz";

export const tokens = {
  USDC: { decimals: 6, address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9" as `0x${string}` },
  USDY: { decimals: 18, address: "0x5bE26527e817998A7206475496fDE1E68957c5A6" as `0x${string}` },
  MUSD: { decimals: 18, address: "0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3" as `0x${string}` },
  AUSD: { decimals: 6, address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as `0x${string}` },
};

// RWA core (bucket 2) form split — held as USDY and/or its rebasing $1 form mUSD,
// converted 1:1-by-NAV via the Ondo wrap/unwrap converter (ROADMAP 2.7). totalAssets
// is conserved across a conversion; usdyUsdc + musdUsdc = the USDY-bucket value.
export const rwaCore = {
  usdyUsdc: "6000.00", // USDY balance × oracle NAV
  musdUsdc: "9000.00", // mUSD balance × $1 face
  converter: "0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3" as `0x${string}`, // UsdyAdapter.MUSD()
};

export const erc8004 = {
  identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as `0x${string}`,
  reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as `0x${string}`,
};

export type SignalTypeKey = "PEG" | "ORACLE" | "LIQUIDITY" | "ATTESTATION" | "NEWS";
export type SeverityKey = "LOW" | "MEDIUM" | "HIGH";
export type RiskLevelKey = "NORMAL" | "CAUTION" | "DERISK";
export type FlagKey = "NONE" | "PEG_WARN" | "ORACLE_NEAR_RANGE_END" | "LOW_LIQUIDITY";
export type BucketKey = "IDLE" | "AAVE" | "USDY" | "AUSD";

export const SIGNAL_TYPES: Record<SignalTypeKey, { label: string; icon: string; desc: string }> = {
  PEG:         { label: "Peg",         icon: "activity",    desc: "USDY DEX spot deviates from oracle NAV" },
  ORACLE:      { label: "Oracle",      icon: "clock-alert", desc: "Oracle near range end / frozen / paused" },
  LIQUIDITY:   { label: "Liquidity",   icon: "droplet",     desc: "Aave or DEX liquidity / buffer pressure" },
  ATTESTATION: { label: "Attestation", icon: "file-check",  desc: "Ondo/USDY reserve attestation finding" },
  NEWS:        { label: "News",        icon: "newspaper",   desc: "Regulatory / issuer / market headline" },
};

export const SEVERITY: Record<SeverityKey, { label: string; role: string }> = {
  LOW:    { label: "Low",  role: "info" },
  MEDIUM: { label: "Med",  role: "warning" },
  HIGH:   { label: "High", role: "error" },
};

export const FLAGS: Record<FlagKey, { label: string; desc: string }> = {
  NONE:                  { label: "No flags",              desc: "No deterministic flag fired" },
  PEG_WARN:              { label: "PEG_WARN",              desc: "Peg ≥ 0.3%" },
  ORACLE_NEAR_RANGE_END: { label: "ORACLE_NEAR_RANGE_END", desc: "Within 24h of oracle range end" },
  LOW_LIQUIDITY:         { label: "LOW_LIQUIDITY",         desc: "Instant buffer < 15%" },
};

export const RISK: Record<RiskLevelKey, { n: number; role: string; status: string; means: string }> = {
  NORMAL:  { n: 0, role: "success", status: "Active · Monitoring", means: "Within tolerance; earning" },
  CAUTION: { n: 1, role: "warning", status: "Caution",             means: "A signal is elevated; exposure may be tightened" },
  DERISK:  { n: 2, role: "error",   status: "De-risking",          means: "Rotating USDY → AUSD/USDC; defense in progress" },
};

export const BUCKETS: BucketKey[] = ["IDLE", "AAVE", "USDY", "AUSD"];
export const BUCKET_LABEL: Record<BucketKey, string> = {
  IDLE: "Idle USDC", AAVE: "Aave USDC", USDY: "Ondo USDY", AUSD: "Agora AUSD",
};

export type WeightsBps = Record<BucketKey, number>;

export const guardrails = [
  { key: "maxUsdy",       label: "Max USDY weight",            value: "60%",    field: "maxWeightBps[USDY]" },
  { key: "maxAave",       label: "Max Aave weight",            value: "90%",    field: "maxWeightBps[AAVE]" },
  { key: "minIdle",       label: "Min idle",                   value: "2%",     field: "minIdleBps" },
  { key: "minInstant",    label: "Min instant-liquidity",      value: "15%",    field: "minInstantLiquidityBps" },
  { key: "maxSlippage",   label: "Max slippage",               value: "0.5%",   field: "maxSlippageBps" },
  { key: "maxMove",       label: "Max rebalance move",         value: "50%",    field: "maxRebalanceMoveBps" },
  { key: "minInterval",   label: "Min rebalance interval",     value: "1h",     field: "minRebalanceInterval" },
  { key: "pegThresholds", label: "Peg warn / block / de-risk", value: "0.3 / 0.5 / 1.0%", field: "pegWarn/Block/DeRiskBps" },
  { key: "tvlCap",        label: "TVL cap",                    value: "$50,000",field: "tvlCap" },
  { key: "perTxCap",      label: "Per-tx deposit cap",         value: "$10,000",field: "perTxDepositCap" },
  { key: "addTimelock",   label: "Add-strategy timelock",      value: "48h",    field: "addStrategyTimelock" },
];

export const vault = {
  tvlUsdc: "30000.00", tvlCapUsdc: "50000.00",
  blendedApyBps: 418, usdyImpliedApyBps: 452, aaveUsdcSupplyApyBps: 380,
  weightsBps: { IDLE: 300, AAVE: 4700, USDY: 5000, AUSD: 0 } as WeightsBps,
  instantWithdrawableUsdc: "15000.00",
  usdyOracleNavUsdc: "1.0832", usdyDexSpotUsdc: "1.0810", pegDeviationBps: 20,
  oracleRangeEnd: "2026-07-01T00:00:00Z",
  paused: false, killed: false,
  sharePrice: "1.0047",
};

export const position = {
  shares: "30000.00", valueUsdc: "30142.50", sharePrice: "1.0047",
  allTimeYieldUsdc: "142.50", depositedUsdc: "30000.00",
  // Vault share-token decimals (12 = asset 6 + _decimalsOffset 6). Used to convert the
  // human share amount back to raw share-wei for redeem(). Fixture default 12.
  shareDecimals: 12,
};

export type VaultState = typeof vault;
export type PositionState = typeof position;

export const walletUsdcBalance = "12500.00";

export const baseline = {
  passiveDeltaBps: 180, drawdownAvoidedUsdc: "610.00", realizedYieldBps: 45,
  sinceDecisionId: 12, measuredAt: "2026-06-10T12:00:00Z",
  custosSeries: [0, 6, 11, 9, 14, 22, 19, 31, 38, 44, 41, 45],
  passiveSeries:  [0, 5, 9, 12, 8, 14, 11, 6, -18, -52, -30, -3],
};

export interface Signal {
  type: SignalTypeKey;
  severity: SeverityKey;
  summary: string;
  evidenceId?: string;
}

export interface Evidence {
  id: string;
  type: SignalTypeKey;
  source: string;
  url: string;
  publishedAt: string;
  summary: string;
}

export interface Outcome {
  realizedYieldBps: number;
  passiveDeltaBps: number;
  drawdownAvoidedUsdc: string;
  measuredAt: string;
}

// x402 settlement receipt for premium evidence the agent PAID for (ROADMAP A4.1),
// bound to the evidence item it bought via `evidenceId`.
export interface PaidReceipt {
  evidenceId: string;
  amountUsdc: string; // formatted, e.g. "0.01"
  asset: string;      // e.g. "USDC"
  transaction: string;
  network: string;
  payer: `0x${string}`;
  resource: string;
}

// ERC-8183 verifiable-job status (ROADMAP A4.2). Color by terminal outcome.
export type JobStatusKey = "Open" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired";
export const JOB_STATUS: Record<JobStatusKey, { label: string; role: string; means: string }> = {
  Open:      { label: "Open",      role: "neutral", means: "created; budget not yet escrowed" },
  Funded:    { label: "Funded",    role: "info",    means: "budget escrowed; awaiting provider" },
  Submitted: { label: "Submitted", role: "info",    means: "provider submitted the de-risk deliverable" },
  Completed: { label: "Completed", role: "success", means: "guardrail Evaluator released it → provider paid + reputation written" },
  Rejected:  { label: "Rejected",  role: "warning", means: "de-risk not guardrail-justified → client refunded" },
  Expired:   { label: "Expired",   role: "neutral", means: "unsettled past expiry → client refunded" },
};

// A de-risk modelled as an ERC-8183 escrowed Job whose Evaluator is the deterministic
// guardrail check. Outside the vault custody path (a per-job bounty, never deposits).
export interface Job {
  jobId: number;
  status: JobStatusKey;
  budgetUsdc: string;
  evaluator: `0x${string}`;
  deliverable: string;
  reputation?: { tag: string; score: number; uri: string };
}

export interface Decision {
  id: number;
  kind: 0 | 1;
  timestamp: string;
  riskLevel: RiskLevelKey;
  confidence: number;
  toBucket?: number;
  preWeightsBps: WeightsBps;
  postWeightsBps: WeightsBps;
  flags: FlagKey[];
  maxUsdyWeightBpsAllowed: number;
  summary: string;
  rationale: string;
  signals: Signal[];
  evidence: Evidence[];
  rationaleHash: string;
  evidenceHash?: string;
  decisionURI: string;
  outcome: Outcome;
  txHash: string;
  /** True when submitted by an ALLOCATOR via the manual rebalance UI/script (no LLM
   *  bundle): confidence + benchmark outcome don't apply, so the UI suppresses them. */
  isManual?: boolean;
  /** x402 receipts for premium evidence the agent paid for (A4.1). */
  payments?: PaidReceipt[];
  /** The ERC-8183 verifiable Job this de-risk settled as (A4.2). */
  job?: Job;
}

export const decisions: Decision[] = [
  {
    id: 14, kind: 1, timestamp: "2026-06-11T09:30:00Z",
    riskLevel: "DERISK", confidence: 0.91, toBucket: 3,
    preWeightsBps:  { IDLE: 300, AAVE: 4700, USDY: 5000, AUSD: 0 },
    postWeightsBps: { IDLE: 500, AAVE: 4500, USDY: 0,    AUSD: 5000 },
    flags: ["PEG_WARN"], maxUsdyWeightBpsAllowed: 6000,
    summary: "Rotated all USDY → AUSD: DEX price 1.22% below NAV + issuer headline.",
    rationale: "USDY traded 122 bps below its Treasury NAV on DEX and an issuer headline flagged a redemption pause review; rotated all USDY to AUSD to protect principal.",
    signals: [
      { type: "PEG",  severity: "HIGH",   summary: "USDY 122 bps below NAV — past the 1.0% de-risk threshold.", evidenceId: "e1" },
      { type: "NEWS", severity: "MEDIUM", summary: "Issuer redemption-pause review reported.", evidenceId: "e2" },
    ],
    evidence: [
      { id: "e1", type: "ORACLE", source: "RWADynamicOracle", url: "https://mantlescan.xyz/address/0xA96a", publishedAt: "2026-06-11", summary: "Oracle NAV 1.0832 vs DEX spot 1.0700." },
      { id: "e2", type: "NEWS",   source: "reuters.com",      url: "https://reuters.com", publishedAt: "2026-06-11", summary: "Report: issuer reviewing temporary redemption pause." },
    ],
    rationaleHash: "0x4ad1c0e9b73f2a16d8c4e5f1a9b2c7d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9", evidenceHash: "0x77be",
    decisionURI: "ipfs://bafybeiderisk0a1b2c3d4e5f6g7h8i9rationalebundle",
    outcome: { realizedYieldBps: 45, passiveDeltaBps: 180, drawdownAvoidedUsdc: "610.00", measuredAt: "2026-06-11T18:00:00Z" },
    txHash: "0xdef1a2b3c4d5e6f7890123456789abcdef0123456789abcdef0123456789abcd",
    payments: [
      { evidenceId: "e2", amountUsdc: "0.01", asset: "USDC", network: "mantle",
        payer: "0xA11c3b9D7e2F4a8c6B0d1E5f9A3c7B2d4E6f8A0E",
        transaction: "0xab12c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f901",
        resource: "https://feeds.example/issuer-wire" },
    ],
    job: {
      jobId: 3, status: "Completed", budgetUsdc: "100.00",
      evaluator: "0xEva1000000000000000000000000000000000001",
      deliverable: "0x4ad1c0e9b73f2a16d8c4e5f1a9b2c7d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9",
      reputation: { tag: "DERISK", score: 610, uri: "ipfs://bafybeideriskevidence" },
    },
  },
  {
    id: 13, kind: 0, timestamp: "2026-06-10T12:00:00Z",
    riskLevel: "NORMAL", confidence: 0.86,
    preWeightsBps:  { IDLE: 300, AAVE: 4700, USDY: 5000, AUSD: 0 },
    postWeightsBps: { IDLE: 200, AAVE: 4800, USDY: 5000, AUSD: 0 },
    flags: ["NONE"], maxUsdyWeightBpsAllowed: 6000,
    summary: "Trimmed idle → Aave: peg within tolerance, USDY APY beats Aave.",
    rationale: "Peg deviation 20 bps within tolerance; USDY APY 4.52% exceeds Aave 3.80%; reserves attestation clean. Hold ~50% USDY.",
    signals: [
      { type: "PEG", severity: "LOW", summary: "USDY 20 bps below NAV on DEX.", evidenceId: "e1" },
    ],
    evidence: [
      { id: "e1", type: "ATTESTATION", source: "ondo.finance", url: "https://ondo.finance/usdy/attestations", publishedAt: "2026-06-01", summary: "Monthly USDY reserve attestation: 99.4% short T-bills." },
    ],
    rationaleHash: "0x9f2c5a8b1d3e6f4a7c9b2d5e8f1a4c7b3d6e9f2a5c8b1d4e7f0a3c6b9d2e5f8a",
    decisionURI: "ipfs://bafybei13a1b2c3rationale",
    outcome: { realizedYieldBps: 12, passiveDeltaBps: 8, drawdownAvoidedUsdc: "0.00", measuredAt: "2026-06-10T13:00:00Z" },
    txHash: "0xabc9876543210fedcba9876543210fedcba9876543210fedcba98765432100abc",
  },
  {
    id: 12, kind: 0, timestamp: "2026-06-09T11:00:00Z",
    riskLevel: "NORMAL", confidence: 0.83,
    preWeightsBps:  { IDLE: 400, AAVE: 4600, USDY: 5000, AUSD: 0 },
    postWeightsBps: { IDLE: 300, AAVE: 4700, USDY: 5000, AUSD: 0 },
    flags: ["NONE"], maxUsdyWeightBpsAllowed: 6000,
    summary: "Minor rebalance: deployed idle USDC into Aave for supply yield.",
    rationale: "All signals nominal; Aave utilization 71% healthy. Deployed surplus idle USDC to Aave to lift blended APY while holding USDY at target.",
    signals: [
      { type: "LIQUIDITY", severity: "LOW", summary: "Aave utilization 71%, withdrawable ample.", evidenceId: "e1" },
    ],
    evidence: [
      { id: "e1", type: "LIQUIDITY", source: "aave.com", url: "https://app.aave.com", publishedAt: "2026-06-09", summary: "Aave USDC market: 71% utilization, $21k withdrawable." },
    ],
    rationaleHash: "0x2d7e9a1c4b6f8e0a3c5d7f9b1e4a6c8d0f2b4e6a8c0d2f4b6e8a0c2d4f6b8e0a",
    decisionURI: "ipfs://bafybei12a1b2c3rationale",
    outcome: { realizedYieldBps: 9, passiveDeltaBps: 4, drawdownAvoidedUsdc: "0.00", measuredAt: "2026-06-09T12:00:00Z" },
    txHash: "0x111222333444555666777888999aaabbbcccdddeeefff000111222333444555a",
  },
];

export const watchlist = [
  { label: "USDY peg",            value: "20 bps below NAV",        threshold: "warn 30 / block 50 / derisk 100", status: "NORMAL" as RiskLevelKey, signal: "PEG" as SignalTypeKey },
  { label: "Oracle",              value: "valid until 2026-07-01",  threshold: "range-end buffer 24h",            status: "NORMAL" as RiskLevelKey, signal: "ORACLE" as SignalTypeKey },
  { label: "Aave utilization",    value: "74%",                     threshold: "—",                               status: "NORMAL" as RiskLevelKey, signal: "LIQUIDITY" as SignalTypeKey },
  { label: "Instant-liquidity",   value: "50% of TVL",              threshold: "min 15%",                         status: "NORMAL" as RiskLevelKey, signal: "LIQUIDITY" as SignalTypeKey },
  { label: "AUSD reserves (PoR)", value: "fully reserved",          threshold: "—",                               status: "NORMAL" as RiskLevelKey, signal: "ATTESTATION" as SignalTypeKey },
];

export const identity = {
  agentId: 7, name: "Custos Risk-Guardian",
  agentURI: "ipfs://bafybeiagentcard0a1b2c3d4e5f6g7h8i9",
  owner: "0xA11c3b9D7e2F4a8c6B0d1E5f9A3c7B2d4E6f8A0E" as `0x${string}`,
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as `0x${string}`,
  trackRecord: { decisions: 14, deRiskEvents: 2, realizedVsPassivePct: 1.8, drawdownAvoidedUsdc: "610.00" },
};

// Agent economics (ROADMAP A4) — the agent as a verifiable economic actor, always
// OUTSIDE the vault custody path: it buys its evidence (x402) and sells its judgment,
// and models each de-risk as an ERC-8183 verifiable Job that feeds ERC-8004 reputation.
export const agentEconomics = {
  sells: {
    endpoint: "/risk-score",
    priceUsdc: "0.01",
    asset: "USDC",
    payTo: "0x000000000000000000000000000000000000bEEF" as `0x${string}`,
    callsServed: 128,
  },
  paidEvidence: [
    { source: "issuer-wire", amountUsdc: "0.01", asset: "USDC", forDecision: 14,
      transaction: "0xab12c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f901" },
  ],
  jobs: [
    { jobId: 3, status: "Completed" as JobStatusKey, budgetUsdc: "100.00", forDecision: 14 as number | null, reputationScore: 610 as number | null },
    { jobId: 2, status: "Rejected" as JobStatusKey, budgetUsdc: "100.00", forDecision: null as number | null, reputationScore: null as number | null },
  ],
};

export const insights = {
  pegHistory: [
    { t: "06-04", nav: 1.0790, dex: 1.0788 }, { t: "06-05", nav: 1.0801, dex: 1.0799 },
    { t: "06-06", nav: 1.0812, dex: 1.0808 }, { t: "06-07", nav: 1.0820, dex: 1.0815 },
    { t: "06-08", nav: 1.0826, dex: 1.0822 }, { t: "06-09", nav: 1.0829, dex: 1.0820 },
    { t: "06-10", nav: 1.0830, dex: 1.0810 }, { t: "06-11", nav: 1.0832, dex: 1.0700 },
    { t: "06-12", nav: 1.0834, dex: 1.0815 }, { t: "06-13", nav: 1.0838, dex: 1.0833 },
    { t: "06-14", nav: 1.0841, dex: 1.0838 }, { t: "06-15", nav: 1.0844, dex: 1.0841 },
  ],
  oracleRangeEnd: "2026-07-01T00:00:00Z", oracleRangeStart: "2026-06-01T00:00:00Z",
  porReserved: true, porRatioPct: 100.6, porSource: "agora.finance",
  aaveUtilizationBps: 7400, aaveSupplyApyBps: 380, aaveWithdrawableUsdc: "21000.00",
  aaveHistory: [
    { t: "06-04", utilBps: 6800, apyBps: 360 }, { t: "06-06", utilBps: 6900, apyBps: 368 },
    { t: "06-08", utilBps: 7100, apyBps: 372 }, { t: "06-10", utilBps: 7200, apyBps: 376 },
    { t: "06-12", utilBps: 7300, apyBps: 378 }, { t: "06-14", utilBps: 7400, apyBps: 380 },
  ],
};

export const askSuggestions = [
  "Why am I in AUSD right now?",
  "What changed today?",
  "How are you beating passive USDY?",
  "What are you watching most closely?",
];

export const askAnswers: Record<string, string> = {
  "Why am I in AUSD right now?":
    "On Jun 11, USDY traded 122 bps below its Treasury NAV on DEX (past the 1.0% de-risk threshold) and an issuer headline flagged a redemption-pause review. I rotated all USDY → AUSD to protect principal. AUSD is fully reserved, so the position is parked safely until the peg recovers. — Decision #14",
  "What changed today?":
    "No new decision today. Current stance is Active · Monitoring. USDY peg is back within tolerance at 20 bps below NAV, oracle is valid until 2026-07-01, and instant liquidity sits at 50% of TVL — comfortably above the 15% floor.",
  "How are you beating passive USDY?":
    "Since decision #12 I'm +180 bps versus a 100% passive USDY holder, and I avoided $610 of drawdown by exiting USDY before the Jun 11 depeg. Realized yield is +45 bps. The edge comes from de-risking ahead of peg breaks while still capturing USDY's APY spread over Aave in calm periods.",
  "What are you watching most closely?":
    "USDY peg (DEX spot vs oracle NAV, currently 20 bps / warn at 30), the oracle range end (2026-07-01, buffer 24h), Aave utilization (74%) and withdrawable liquidity, and the instant-liquidity buffer (50% of TVL vs the 15% floor). AUSD proof-of-reserves is also tracked.",
};
