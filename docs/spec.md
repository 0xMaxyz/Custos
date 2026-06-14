# Custos — Technical Spec

Concrete specifications for Custos. Three parts, in order:

1. Guardrail parameters
2. Contract interfaces
3. Anthropic API prompt + risk-signal schema

> These are the deployed values. **The on-chain `Guardrails` values and the off-chain
> TS validator MUST stay byte-for-byte in agreement** (same constants, single source in
> `packages/shared`). Contract interfaces in §2 reflect the deployed contracts.

---

## 1. Guardrail parameters

### 1.1 Buckets
| Id | Bucket | Role | Instantly liquid? |
|----|--------|------|-------------------|
| 0 | `IDLE` | USDC held in vault | Yes |
| 1 | `AAVE` | USDC supplied to Aave v3 | Yes (pool liquidity permitting) |
| 2 | `USDY` | RWA yield core — **USDY or mUSD** (Ondo; convertible via Ondo Token Converter) | No (DEX unwind) |
| 3 | `AUSD` | reserve-backed safe asset | Partial (DEX) |

### 1.2 Allocation limits (initial defaults)
| Param | Default | Meaning |
|-------|---------|---------|
| `maxWeightBps[USDY]` | `6000` (60%) | Max share in the RWA yield core |
| `maxWeightBps[AAVE]` | `9000` (90%) | Max share in Aave |
| `maxWeightBps[AUSD]` | `10000` (100%) | Safety bucket may absorb all on de-risk |
| `maxUsdyNotionalUsdc` | `$5,000` (0 = off) | Absolute USDY exposure cap; tracks real Mantle aggregator pool depth (~$1.5k total) independent of TVL/`maxWeightBps`. Checked on USDY-weight increase. |
| `minIdleBps` | `200` (2%) | Always-idle USDC for tiny withdrawals |
| `minInstantLiquidityBps` | `1500` (15%) | `IDLE + Aave-withdrawable` ≥ 15% of TVL after any rebalance |
| weights sum | `== 10000` | Target weights must total 100% |

### 1.3 Execution safety (initial defaults)
| Param | Default | Meaning |
|-------|---------|---------|
| `maxSlippageBps` | `50` (0.5%) | Per-swap `minOut` tolerance (enforced on-chain) |
| `maxRebalanceMoveBps` | `5000` (50%) | Max % of TVL a single **rebalance** may move (de-risk is exempt) |
| `minRebalanceInterval` | `3600s` (1h) | Min seconds between **rebalances** (de-risk is exempt) |
| `tvlCap` | `$50,000` | Max vault TVL for the mainnet demo (deposit cap) |
| `perTxDepositCap` | `$10,000` | Max single deposit during demo |
| `addStrategyTimelock` | `172800s` (2d) | Delay before a newly-added strategy is usable; also the queue delay for config/guardrails changes |
| `MIN_TIMELOCK` (constant) | `3600s` (1h) | Hard floor on `addStrategyTimelock` — the delay can never be queued below this (M5) |

### 1.4 USDY risk thresholds (initial defaults)
| Param | Default | Action |
|-------|---------|--------|
| `pegWarnBps` | `30` (0.3%) | \|DEX spot − oracle NAV\| ≥ → surface a CAUTION signal |
| `pegBlockBps` | `50` (0.5%) | ≥ → **block new USDY allocation** |
| `pegDeRiskBps` | `100` (1.0%) | ≥ → **force de-risk** (rotate USDY → USDC) |
| `oracleMaxAge` | `100800s` (~28h)* | Beyond → treat NAV as stale → block + de-risk |
| `oracleRangeEndBuffer` | `86400s` (24h) | If within 24h of `RWADynamicOracle` configured range end → CAUTION |
| `usdyMinCollateralBps` | `9900` (99%) | Daily Ondo/Ankura attestation backing ratio (reserves ÷ token principal) below → **force de-risk** (off-chain ISSUER backstop; routes USDY→0 via rebalance) |

The `usdyMinCollateralBps` guard is an **off-chain** deterministic backstop in the
agent (not an on-chain `Guardrails` param): the agent parses the latest USDY reserve
attestation PDF (Dropbox) into structured facts and, if the backing ratio is under the
floor, forces USDY→0 regardless of the LLM (tighten-only). It complements the on-chain
peg/oracle guards, which remain the authoritative custody backstop.

\* USDY's `RWADynamicOracle` accrues by configured daily-rate ranges (it interpolates
rather than going "stale" like a Chainlink feed). "Stale" here means: now is **past
the configured range end** (no valid rate) or the contract is paused. `oracleMaxAge`
is a secondary guard against a frozen oracle; tune against real cadence.

### 1.5 Roles & switches
| Role / switch | Capability |
|---------------|-----------|
| `ADMIN` (multisig in prod) | set guardrail config, add/remove strategies (timelocked), grant roles |
| `ALLOCATOR` (agent hot key) | `rebalance`, `deRisk` — **only within guardrails** |
| `GUARDIAN` | `pause`, `deRisk`, `kill` (no allocation power) |
| `pause()` | blocks deposits + rebalance; withdrawals still allowed |
| `kill()` | irreversible-ish emergency: withdraw-only, no allocation, USDY/AUSD unwound to USDC |

### 1.6 Whitelists
- **Tokens:** `USDC`, `USDY`, `mUSD`, `AUSD`, `aUSDC` only. USDY and mUSD are the
  two on-chain forms of the RWA core (convertible via the Ondo Token Converter).
- **Venues:** the specific Aave v3 `Pool` + the specific DEX router(s) + the
  **Ondo Token Converter** (USDY↔mUSD), all verified on-chain; nothing else may
  be called by adapters. **Verified:** the "Ondo Token Converter" is the **mUSD token
  contract itself** (`0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3` on Mantle, 18 dec) —
  it hosts `wrap(uint256)` (USDY→mUSD) and `unwrap(uint256)` (mUSD→USDY); there is no
  separate converter. `UsdyAdapter` pins it as an immutable and only ever calls
  `wrap`/`unwrap` on it (never arbitrary calldata). See `ForkPhase2d.t.sol`.

---

## 2. Contract interfaces (proposed sketch)

> Foundry/Solidity ^0.8.24, OpenZeppelin where possible. Custom errors, NatSpec,
> reentrancy guards on fund-moving funcs. `assets`/amounts are USDC-denominated
> unless noted. Weights are bps (`uint16`, sum 10000).

### 2.1 `IStrategyAdapter`
```solidity
interface IStrategyAdapter {
    /// @notice Underlying yield token held by this adapter (e.g. aUSDC, USDY, AUSD).
    function underlying() external view returns (address);

    /// @notice Adapter value in USDC terms (oracle/aToken-based, never a DEX mark for accounting).
    function totalAssets() external view returns (uint256 usdcValue);

    /// @notice USDC amount currently withdrawable right now (liquidity-aware).
    function maxWithdrawable() external view returns (uint256 usdcValue);

    /// @notice Deploy `usdcAmount` from the vault into the strategy.
    /// @param swapData route data — for `UsdyAdapter` this is the calldata for the pinned
    ///        aggregator router (from 1delta's routing quote); minOut is re-derived from the
    ///        oracle and enforced on-chain via a balance-delta check. Empty for direct adapters.
    function deposit(uint256 usdcAmount, bytes calldata swapData) external returns (uint256 deployedUsdcValue);

    /// @notice Withdraw approximately `usdcAmount`, sending USDC to `to`, enforcing `minOut`.
    function withdraw(uint256 usdcAmount, uint256 minOutUsdc, address to, bytes calldata swapData)
        external
        returns (uint256 withdrawnUsdc);

    /// @notice Unwind everything to USDC to `to` (used by kill/de-risk).
    function emergencyWithdrawAll(uint256 minOutUsdc, address to, bytes calldata swapData)
        external
        returns (uint256 withdrawnUsdc);
}
```

**USDY ↔ mUSD converter leg (RWA core).** The RWA bucket (2) is held as USDY
and/or its rebasing $1 form **mUSD**. `UsdyAdapter` extends `IStrategyAdapter` with
`IUsdyAdapter` and pins the mUSD contract as an immutable `MUSD` (`address(0)` = USDY-
only). Conversion is **oracle-priced and value-neutral** (no DEX, no slippage beyond
rounding), so `totalAssets()` values USDY at oracle NAV + mUSD at $1 face and is
conserved across a conversion. Verified on-chain (`ForkPhase2d.t.sol`).

```solidity
// The "Ondo Token Converter" is the mUSD token itself (wrap/unwrap host).
interface IMusd {
    function wrap(uint256 usdyAmount) external;   // USDY -> mUSD (caller approves USDY to mUSD)
    function unwrap(uint256 musdAmount) external;  // mUSD -> USDY (burns caller's mUSD)
    function usdy() external view returns (address);
    function oracle() external view returns (address);
}

interface IUsdyAdapter /* is IStrategyAdapter */ {
    function oracleData() external view returns (uint256 nav, uint64 rangeEnd);
    function MUSD() external view returns (address);
    // Vault-only. Enforce oracle-derived balance-delta minOut; target only the pinned MUSD.
    function convertToMusd(uint256 usdyAmount, uint256 minMusdOut) external returns (uint256 musdOut);
    function convertToUsdy(uint256 musdAmount, uint256 minUsdyOut) external returns (uint256 usdyOut);
}
```

`YieldVault.convertRwaLeg(bool toMusd, uint256 amountIn, uint256 minOut)` (ALLOCATOR,
`whenNotPaused`, not killed) is the production passthrough. It changes only the *form*
the RWA bucket is held in, not its USDC value or weight, so it intentionally does NOT
go through `Guardrails.validateRebalance` — entry/exit that changes exposure still goes
through `rebalance`/`deRisk`.

### 2.2 `YieldVault` (ERC-4626)
```solidity
interface IYieldVault /* is IERC4626 */ {
    // --- ERC-4626 core: asset()/totalAssets()/deposit/mint/withdraw/redeem/convertTo* ---

    struct Decision {
        uint256 id;
        uint64  timestamp;
        uint16[4] preWeightsBps;   // [IDLE, AAVE, USDY, AUSD]
        uint16[4] postWeightsBps;
        uint8   kind;              // 0 = REBALANCE, 1 = DERISK
        bytes32 rationaleHash;     // keccak256 of the rationale text
        string  decisionURI;       // ipfs:// rationale + evidence bundle
    }

    /// @notice Agent-driven on-chain function. Moves funds toward target weights.
    /// @dev onlyRole(ALLOCATOR); reverts if Guardrails.validate fails.
    function rebalance(
        uint16[4] calldata targetWeightsBps,
        bytes[] calldata swapData,     // per-adapter route hints
        string  calldata decisionURI,
        bytes32 rationaleHash
    ) external returns (uint256 decisionId);

    /// @notice Emergency rotation out of USDY into a safe bucket. Exempt from freq/move caps.
    /// @dev onlyRole(ALLOCATOR | GUARDIAN); requires depeg/oracle guard condition OR guardian.
    function deRisk(
        uint8 toBucket,                // 0 IDLE or 3 AUSD
        bytes[] calldata swapData,
        string  calldata reason,
        bytes32 evidenceHash
    ) external returns (uint256 decisionId);

    function pause() external;         // GUARDIAN
    function unpause() external;       // GUARDIAN
    function kill() external;          // GUARDIAN

    // Swapping the guardrail brain is the most sensitive admin action → timelocked (H3).
    function queueGuardrails(address) external;         // ADMIN, queue
    function activateGuardrails() external;             // ADMIN, after addStrategyTimelock
    function addStrategy(uint8 bucket, address adapter) external;   // ADMIN, timelocked
    function setTargetCaps(uint16[4] calldata maxWeightsBps) external; // ADMIN

    event DecisionRecorded(uint256 indexed id, uint8 kind, bytes32 rationaleHash, string decisionURI);
    event Rebalanced(uint256 indexed id, uint16[4] postWeightsBps);
    event DeRisked(uint256 indexed id, uint8 toBucket, bytes32 evidenceHash);
}
```

### 2.3 `Guardrails`
```solidity
interface IGuardrails {
    struct Config {
        uint16[4] maxWeightBps;          // per bucket
        uint16 minIdleBps;
        uint16 minInstantLiquidityBps;
        uint256 maxUsdyNotionalUsdc;     // absolute USDY exposure cap (6-dec USDC; 0 = disabled)
        uint16 maxSlippageBps;
        uint16 maxRebalanceMoveBps;
        uint32 minRebalanceInterval;
        uint16 pegWarnBps;
        uint16 pegBlockBps;
        uint16 pegDeRiskBps;
        uint32 oracleMaxAge;
        uint256 tvlCap;
        uint256 perTxDepositCap;
        uint32 addStrategyTimelock;
    }

    struct MarketState {
        uint256 usdyOracleNav;   // USDC per USDY, oracle
        uint256 usdyDexSpot;     // USDC per USDY — TRUSTED allocator-supplied input (H2)
        uint64  oracleUpdatedAt; // INERT on Mantle: no on-chain updatedAt source (H1)
        uint64  oracleRangeEnd;  // INERT on Mantle: currentRange() reverts → 0 (H1)
        uint256 aaveWithdrawable;
        uint256 totalAssets;
        uint64  lastRebalanceAt;
        bool    oracleDown;      // set by the vault when oracleData() reverts while RWA
                                 // exposure > 0 → forces de-risk so the autonomous
                                 // defense still works during an oracle outage (M4)
    }

    function config() external view returns (Config memory);

    // Config governance (H3): setConfig is a one-shot bootstrap at deploy (applies
    // instantly, then seals); every later change — tighten OR loosen — is timelocked.
    function setConfig(Config calldata newConfig) external;   // ADMIN, one-shot bootstrap
    function queueConfig(Config calldata newConfig) external; // ADMIN, queue (delay >= MIN_TIMELOCK floor)
    function activateConfig() external;                       // ADMIN, after addStrategyTimelock
    function cancelConfig() external;                         // ADMIN, abort a pending config (M5)

    /// @return ok / reason selector. Pure check of a proposed allocation vs config + state.
    function validateRebalance(
        uint16[4] calldata preWeightsBps,
        uint16[4] calldata postWeightsBps,
        MarketState calldata s
    ) external view returns (bool ok, bytes4 reason);

    /// @notice Depeg/oracle evaluation used to gate USDY and trigger de-risk.
    function evaluateUsdyRisk(MarketState calldata s)
        external
        view
        returns (bool blockNewUsdy, bool forceDeRisk, uint8 riskLevel); // 0 NORMAL,1 CAUTION,2 DERISK
}
```

**Oracle-staleness trust model on Mantle (H1).** `_evaluateUsdyRisk` has two staleness
checks — `oracleStale` (via `oracleRangeEnd`) and `oracleAged` (via `oracleUpdatedAt`).
Both are **inert on Mantle**: the deployed Ondo oracle exposes only `getPrice()` +
`currentRange()` (no round/`updatedAt` accessor), and `currentRange()` reverts so the
adapter returns `oracleRangeEnd = 0`. The real staleness guards are therefore
`UsdyAdapter._requireOracleFresh`/`getPrice()` reverting on a dead oracle (which blocks
deposit/withdraw/convert) plus the off-chain engine's `oracleUpdatedAt` check. The
on-chain peg-deviation branch (NAV vs DEX spot) remains the active de-risk trigger.

**Peg-input trust model (H2).** `MarketState.usdyDexSpot` is supplied by the ALLOCATOR
on `rebalance`/`deRisk`, so the depeg guard that gates new USDY is fed by the same hot
key it constrains. Exposure is bounded by the $5k USDY notional and 60% weight caps; a
compromised allocator passing `spot == nav` only *clears* the gate (it cannot raise the
caps). An on-chain DEX TWAP cross-check is deferred to Phase 2b.

### 2.4 `AgentBenchmark`
```solidity
interface IAgentBenchmark {
    struct Outcome {
        int256  realizedYieldBps;     // agent yield vs prior decision (bps)
        uint256 drawdownAvoidedUsdc;  // estimated loss avoided on de-risk events (6-dec USDC)
        int256  passiveDeltaBps;      // Custos outperformance vs 100%-USDY passive holder (bps)
        uint64  measuredAt;           // unix timestamp of outcome measurement
    }

    // Called by YieldVault only. Snaps usdyNavAtDecision as the passive-baseline reference.
    function recordDecision(
        uint256 decisionId,
        bytes32 rationaleHash,
        string  calldata decisionURI,
        uint256 usdyNavAtDecision
    ) external;

    // Written by ALLOCATOR/keeper post-facto. Immutable once measuredAt != 0.
    function updateOutcome(uint256 decisionId, Outcome calldata o) external;

    function decisionCount() external view returns (uint256);
    function outcomeOf(uint256 decisionId) external view returns (Outcome memory);
    function navAtDecision(uint256 decisionId) external view returns (uint256);

    event DecisionRecorded(
        uint256 indexed decisionId,
        bytes32 rationaleHash,
        string  decisionURI,
        uint256 usdyNavAtDecision
    );
    event OutcomeUpdated(
        uint256 indexed decisionId,
        int256  realizedYieldBps,
        uint256 drawdownAvoidedUsdc,
        int256  passiveDeltaBps
    );
}
```
**Passive-baseline design:** `navAtDecision` stores the oracle NAV at each decision. The off-chain agent computes `passiveDeltaBps` — how many bps Custos outperformed a 100%-USDY passive holder — and writes it via `updateOutcome`. On-chain storage keeps the full audit trail; computation stays off-chain per "AI only where it beats an algorithm" (see [agents.md §2](./agents.md)).

### 2.5 ERC-8004 integration

The canonical 0x8004 singletons **are deployed on Mantle** (confirmed via `extcodesize > 0`),
so the **production path calls them**. Their real ABIs are declared in
`contracts/src/interfaces/IERC8004Canonical.sol` and proven on a fork in `ForkPhase4a.t.sol`.
The `Custos*` registries (implementing the simplified `IERC8004.sol` below) are the
**fallback** for chains where the singletons are absent.

**Identity (canonical & fallback are compatible for the subset we use):**
```solidity
interface IIdentityRegistry /* ERC-721 + URIStorage */ {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata agentURI) external;
    function tokenURI(uint256 agentId) external view returns (string memory);
}
```
> An EOA `register` via read-only `cast call` reverts `ERC721InvalidReceiver` only
> because `eth_call` has `msg.sender == address(0)`; a real transaction works.

**Reputation:** the **canonical** registry is a permissionless, client-keyed ledger,
*not* a single append. Production outcome writes use:
```solidity
// canonical (ICanonicalReputationRegistry) — what we call in production
function giveFeedback(
    uint256 agentId, int128 value, uint8 valueDecimals,
    string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash
) external;
function readFeedback(uint256 agentId, address client, uint64 index)
    external view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked);
function getSummary(uint256 agentId, address[] clients, string tag1, string tag2)
    external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
```
The simplified fallback `IReputationRegistry { appendFeedback(agentId, tag, score, uri) }`
(role-gated, `CustosReputationRegistry`) is used only when the canonical singleton
is absent. Custos publishes each decision outcome (e.g. passive-baseline delta) as
`giveFeedback` with `tag1 = decision kind`, `tag2 = metric`, `value/valueDecimals` the
signed score, and `feedbackURI/feedbackHash` binding the IPFS evidence.

- **Agent card** (`agentURI` → IPFS JSON): `{ schemaVersion, name, description, endpoints, wallet, supportedTrust, vault, benchmark, sells? }` (Custos-specific shape; canonical explorer interop via `services[]`/`registrations[]` is mapped at deploy time). The optional `sells: { endpoint, payTo, asset, priceBaseUnits }` block publishes the x402 sell-side offer (§2.7) so a payer can verify the live 402 challenge's `payTo` against the agent's pinned identity. Built + pinned via `pnpm card:pin` (agent), which prints the `AGENT_CARD_URI` consumed by `RegisterIdentity.s.sol`; the card is immutable once pinned, so a payee/price change requires re-pinning + `setAgentURI`.

### 2.6 ERC-8183 verifiable de-risk jobs

Each de-risk is modelled as an ERC-8183 escrowed **Job** so the agent accrues a
verifiable risk-call record. The **Evaluator is the deterministic guardrail check** —
a Job settles to the provider only if `Guardrails.evaluateUsdyRisk` confirms the
de-risk was forced; otherwise it is rejected and the client refunded. This is a
record/reputation layer **outside the vault custody path** (it escrows a per-job
bounty, never user deposits; the on-chain `Guardrails` remain the sole authority over
vault funds). Job outcomes feed the ERC-8004 ReputationRegistry.

```solidity
// IERC8183 (subset): Open → Funded → Submitted → Completed | Rejected | Expired
enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }
function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) external returns (uint256 jobId);
function fund(uint256 jobId, bytes optParams) external;        // client escrows budget
function submit(uint256 jobId, bytes32 deliverable, bytes optParams) external; // provider
function complete(uint256 jobId, bytes32 reason, bytes optParams) external;    // evaluator → pay provider
function reject(uint256 jobId, bytes32 reason, bytes optParams) external;       // evaluator/client → refund
function claimRefund(uint256 jobId) external;                  // anyone, after expiry → refund client

// CustosDeRiskEvaluator (the guardrail-gated Evaluator). NAV + range read on-chain
// from the pinned UsdyAdapter; the keeper supplies only the DEX spot (as vault.deRisk does).
function evaluate(IERC8183 escrow, uint256 jobId, uint256 usdyDexSpotUsdc, int256 outcomeScore, string feedbackUri, bytes32 reason)
    external returns (bool completed); // KEEPER-only; complete+appendFeedback iff forceDeRisk, else reject
```

### 2.7 x402 micropayments

The agent uses the x402 "exact" EVM scheme (EIP-3009 `transferWithAuthorization`,
EIP-712-signed) for paid data: it **pays** per-call for premium risk feeds and pins
the settlement receipt into the decision evidence bundle ("paid for the evidence it
acted on"), and **charges** for its own RWA risk score at a 402-gated endpoint.
Signing + settlement are injectable so the protocol is testable offline.

```jsonc
// 402 body: { "x402Version": 1, "accepts": [PaymentRequirements], "error": "payment required" }
// PaymentRequirements: { scheme:"exact", network, chainId, maxAmountRequired, resource,
//                        description, mimeType, payTo, maxTimeoutSeconds, asset, extra:{name,version} }
// X-PAYMENT header (base64 JSON): { x402Version, scheme, network,
//   payload: { signature, authorization:{ from,to,value,validAfter,validBefore,nonce } } }
// X-PAYMENT-RESPONSE (base64 JSON): { success, transaction, network, payer, amount, resource }
```
The receipt is bound to the evidence it bought via `resource`; the decision bundle
carries `payments: [{ evidenceId, receipt }]` (hashed into `rationaleHash`, pinned to IPFS).

**Outbound spend cap** (N1): `maxAmountRequired` is supplied by the counterparty's 402
response, so the agent **never** signs it blindly. `createPayment` rejects any required
amount above `X402_MAX_PRICE_BASE_UNITS` *before* signing, and that env var is **required**
whenever `X402_PREMIUM_FEED_URL` is set (config `superRefine`) — a compromised feed URL
therefore can't drain the payer up to its balance. An over-cap price degrades to empty
paid-evidence (additive, never blocks a cycle).

**Inbound payment verification** (`payments/verifier.ts`): `/risk-score` verifies the
inbound `X-PAYMENT` by **recovering the EIP-712 signer** (`recoverTypedDataAddress`) and
confirming it equals `authorization.from` (plus recipient/amount/validity bounds) — never
just structure. With `X402_SETTLE_ONCHAIN=true` + an ALLOCATOR wallet it then **settles
on-chain** by submitting `transferWithAuthorization` (returning the real tx hash);
otherwise it verifies the signature and delegates settlement to a facilitator. In that
verify-only mode nothing consumes the EIP-3009 nonce on-chain, so `replayGuardedVerifier`
tracks spent `(from, nonce)` pairs in memory until `validBefore` and rejects replays (N3);
the on-chain path needs no guard since the consumed nonce makes settlement single-use. The
dev-only `shapeOnlyVerifier` is retained for tests, never wired into the running agent.

**Sell-side payee binding** (`identity/payee.ts`): the address collecting `/risk-score`
revenue is bound to the agent's ERC-8004 identity, not a free-form env var. `X402_ASSET`
is the explicit opt-in for selling; the payee then resolves as `X402_PAY_TO` when set
(reconciled against `ownerOf(AGENT_ID)` with a warning on mismatch — owners may route
revenue to a separate treasury), else derived directly from the on-chain agent-NFT owner.
The resolved payee feeds BOTH the live 402 challenge and the pinned agent card's `sells`
block (§2.5), so payers can verify them against each other. The payee must **never** be
the ALLOCATOR hot key (a guardrail-bounded, minimal-balance gas key) — the agent (and
`card:pin`) hard-reject that at startup (a typed `PayeeConfigError`). The inbound verifier
already enforces `authorization.to == payTo`, so binding the challenge binds the settled
funds. Two operational caveats: (1) failure handling differs by cause — a payee equal to
the ALLOCATOR fails the process fast (operator error), whereas a transient `ownerOf` read
failure when deriving only disables `/risk-score` for that run (selling is an addon; the
de-risk mission must still boot). (2) An owner-derived payee tracks NFT ownership: a
transfer of the agent NFT silently moves the runtime payee on the next restart, while the
pinned card's `sells.payTo` stays stale until re-pinned — re-run `card:pin` + `setAgentURI`
after any transfer.

---

## 3. LLM prompt + risk-signal schema

**LLM provider:** Anthropic Claude via the official `@anthropic-ai/sdk`,
wrapped in a thin `LLMClient` interface in `agent/src/llm/` so it can be mocked in
tests. The prompt, schema, and validation below define that single contract.

**Role of the LLM:** turn structured market state + fetched unstructured items
(attestation PDFs, regulatory/issuer news) into (a) a human-readable rationale and
(b) a **bounded risk verdict that may only *tighten* risk** (lower the USDY weight /
raise the risk level) — it can never loosen guardrails or raise exposure. Reading
unstructured documents is the task the LLM owns; the oracle-deviation trigger is
deterministic and does not go through the LLM. The deterministic engine + on-chain
guardrails own all hard limits.

### 3.1 Agent input (assembled deterministically, passed to the model)
```jsonc
{
  "asOf": "2026-06-10T12:00:00Z",
  "marketState": {
    "usdyOracleNavUsdc": "1.0832",
    "usdyDexSpotUsdc": "1.0810",
    "pegDeviationBps": 20,
    "oracleUpdatedAt": "2026-06-10T00:00:00Z",
    "oracleRangeEnd": "2026-07-01T00:00:00Z",
    "usdyImpliedApyBps": 452,
    "aaveUsdcSupplyApyBps": 380,
    "aaveUtilizationBps": 7400,
    "aaveWithdrawableUsdc": "21000.00",
    "totalAssetsUsdc": "30000.00",
    "currentWeightsBps": { "IDLE": 300, "AAVE": 4700, "USDY": 5000, "AUSD": 0 }
  },
  "deterministic": {
    "candidateWeightsBps": { "IDLE": 200, "AAVE": 4800, "USDY": 5000, "AUSD": 0 },
    "flags": ["NONE"],                       // e.g. PEG_WARN, ORACLE_NEAR_RANGE_END, LOW_LIQUIDITY
    "maxUsdyWeightBpsAllowed": 6000          // guardrail ceiling for this cycle
  },
  "evidence": [
    { "id": "e1", "type": "ATTESTATION", "source": "ondo.finance",
      "url": "https://...", "publishedAt": "2026-06-01", "summary": "Monthly USDY reserve attestation: 99.x% short T-bills." },
    { "id": "e2", "type": "NEWS", "source": "...", "url": "https://...",
      "publishedAt": "2026-06-09", "summary": "..." }
  ]
}
```

### 3.2 Required model output (strict JSON; validated with zod)
```jsonc
{
  "riskLevel": "NORMAL",                 // "NORMAL" | "CAUTION" | "DERISK"
  "usdyMaxWeightBps": 5000,              // MUST be <= deterministic.maxUsdyWeightBpsAllowed
  "deRisk": false,                       // true only with a cited reason in `signals`
  "rationale": "Peg deviation 20bps within tolerance; USDY APY (4.52%) exceeds Aave (3.80%); reserves attestation clean. Hold ~50% USDY.",
  "signals": [
    { "type": "PEG", "severity": "LOW", "summary": "USDY 20bps below NAV on DEX.", "evidenceId": "e1" }
  ],
  "confidence": 0.86
}
```

### 3.3 Validation & clamping (TS, before anything is signed)
- Reject if JSON fails the zod schema → **fall back to the deterministic allocation**.
- `usdyMaxWeightBps = min(model.usdyMaxWeightBps, deterministic.maxUsdyWeightBpsAllowed)`.
- If `deRisk == true`, require ≥1 `signals[*]` with a resolvable `evidenceId` **whose evidence `source` is on the trusted allow-list** (`CURATED_EVIDENCE_SOURCES`, the vetted first-party RWA feeds); else ignore the de-risk request. Un-vetted/scraped sources can inform the model as context but cannot, on their own, unlock a de-risk (N2).
- The model may only **tighten**: final USDY weight = `min(deterministic.candidate.USDY, model.usdyMaxWeightBps)`. It can never increase USDY or any bucket above the deterministic candidate.
- `rationale` + `signals` (with resolved evidence URLs) are hashed (`rationaleHash`) and bundled to IPFS (`decisionURI`) before calling `rebalance`/`deRisk`.

### 3.4 Prompt template (sketch)
**System:**
```
You are Custos's risk-guardian analyst for a tokenized-Treasury (USDY) yield vault on Mantle.
You DO NOT control funds. You output strict JSON matching the provided schema only.
You may only TIGHTEN risk (reduce USDY weight or raise riskLevel); you may NEVER increase
exposure or exceed deterministic.maxUsdyWeightBpsAllowed. Base every claim on the provided
marketState and evidence; never invent data or sources. If evidence is insufficient, prefer caution.
Recommend deRisk=true only for a concrete, cited threat (depeg, oracle issue, issuer/regulatory event).
```
**User:** the JSON from §3.1.
**Decoding:** `temperature 0–0.2`, JSON enforced via a tool/`response_format`-style schema, hard `max_tokens`, single retry on invalid JSON, then deterministic fallback. On API timeout/error, deterministic-only path.

### 3.5 Failure & safety modes
| Condition | Behavior |
|-----------|----------|
| Anthropic API down / timeout | Deterministic allocation only; `riskLevel` from deterministic flags. |
| Invalid/unparseable output | Reject, retry once, then deterministic fallback. |
| Model requests higher exposure | Ignored (clamped); logged. |
| `deRisk` without cited evidence | Ignored; logged. |
| On-chain guard already says block/de-risk | On-chain wins regardless of model. |
