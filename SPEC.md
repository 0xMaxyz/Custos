# Sentinel — Technical Spec

Concrete specifications referenced by `PLAN.md` (strategy) and `ROADMAP.md`
(execution). Three parts, in order:

1. Guardrail parameters
2. Contract interfaces
3. Anthropic API prompt + risk-signal schema

> All numeric values are **initial defaults for the demo** — conservative on
> purpose — to be tuned during Phase 0 (after the liquidity/oracle gate) and
> Phase 5 (mainnet config). **The on-chain `Guardrails` values and the off-chain TS
> validator MUST stay byte-for-byte in agreement** (same constants, single source in
> `packages/shared`). Solidity below is a **proposed interface sketch**, not final.

---

## 1. Guardrail parameters

### 1.1 Buckets
| Id | Bucket | Role | Instantly liquid? |
|----|--------|------|-------------------|
| 0 | `IDLE` | USDC held in vault | Yes |
| 1 | `AAVE` | USDC supplied to Aave v3 | Yes (pool liquidity permitting) |
| 2 | `USDY` | tokenized Treasuries (yield core) | No (DEX unwind) |
| 3 | `AUSD` | reserve-backed safe asset | Partial (DEX) |

### 1.2 Allocation limits (initial defaults)
| Param | Default | Meaning |
|-------|---------|---------|
| `maxWeightBps[USDY]` | `6000` (60%) | Max share in the RWA yield core |
| `maxWeightBps[AAVE]` | `9000` (90%) | Max share in Aave |
| `maxWeightBps[AUSD]` | `10000` (100%) | Safety bucket may absorb all on de-risk |
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
| `addStrategyTimelock` | `172800s` (2d) | Delay before a newly-added strategy is usable |

### 1.4 USDY risk thresholds (initial defaults)
| Param | Default | Action |
|-------|---------|--------|
| `pegWarnBps` | `30` (0.3%) | \|DEX spot − oracle NAV\| ≥ → surface a CAUTION signal |
| `pegBlockBps` | `50` (0.5%) | ≥ → **block new USDY allocation** |
| `pegDeRiskBps` | `100` (1.0%) | ≥ → **force de-risk** (rotate USDY → AUSD/USDC) |
| `oracleMaxAge` | `100800s` (~28h)* | Beyond → treat NAV as stale → block + de-risk |
| `oracleRangeEndBuffer` | `86400s` (24h) | If within 24h of `RWADynamicOracle` configured range end → CAUTION |

\* USDY's `RWADynamicOracle` accrues by configured daily-rate ranges (it interpolates
rather than going "stale" like a Chainlink feed). "Stale" here means: now is **past
the configured range end** (no valid rate) or the contract is paused. `oracleMaxAge`
is a secondary guard against a frozen oracle; tune against real cadence in Phase 0.

### 1.5 Roles & switches
| Role / switch | Capability |
|---------------|-----------|
| `ADMIN` (multisig in prod) | set guardrail config, add/remove strategies (timelocked), grant roles |
| `ALLOCATOR` (agent hot key) | `rebalance`, `deRisk` — **only within guardrails** |
| `GUARDIAN` | `pause`, `deRisk`, `kill` (no allocation power) |
| `pause()` | blocks deposits + rebalance; withdrawals still allowed |
| `kill()` | irreversible-ish emergency: withdraw-only, no allocation, USDY/AUSD unwound to USDC |

### 1.6 Whitelists
- **Tokens:** `USDC`, `USDY`, `AUSD`, `aUSDC` only.
- **Venues:** the specific Aave v3 `Pool` + the specific DEX router(s) verified in
  Phase 0; nothing else may be called by adapters.

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
    /// @param swapData optional route hint (e.g. 1delta), validated against minOut on-chain.
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

    function setGuardrails(address) external;          // ADMIN
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
        uint256 usdyDexSpot;     // USDC per USDY, DEX TWAP/quote
        uint64  oracleUpdatedAt;
        uint64  oracleRangeEnd;
        uint256 aaveWithdrawable;
        uint256 totalAssets;
        uint64  lastRebalanceAt;
    }

    function config() external view returns (Config memory);

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

### 2.4 `AgentBenchmark`
```solidity
interface IAgentBenchmark {
    struct Outcome {
        int256  realizedYieldBps;     // since prior decision
        uint256 drawdownAvoidedUsdc;  // est. on de-risk events
        uint64  measuredAt;
    }

    function recordDecision(uint256 decisionId, bytes32 rationaleHash, string calldata decisionURI) external; // VAULT
    function updateOutcome(uint256 decisionId, Outcome calldata o) external;  // ALLOCATOR/keeper

    function decisionCount() external view returns (uint256);
    function outcomeOf(uint256 decisionId) external view returns (Outcome memory);

    event OutcomeUpdated(uint256 indexed decisionId, int256 realizedYieldBps, uint256 drawdownAvoidedUsdc);
}
```

### 2.5 ERC-8004 integration (subset we use)
```solidity
// If 0x8004 singletons exist on Mantle we call them; else we deploy minimal equivalents.
interface IIdentityRegistry /* ERC-721 + URIStorage */ {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata agentURI) external;
    function tokenURI(uint256 agentId) external view returns (string memory);
}

interface IReputationRegistry {
    /// Append a structured, immutable feedback/outcome signal for an agent.
    function appendFeedback(uint256 agentId, bytes32 tag, int256 score, string calldata uri) external;
}
```
- **Agent card** (`agentURI` → IPFS JSON): `{ name, description, endpoints, wallet, supportedTrust, vault, benchmark }`.

---

## 3. LLM prompt + risk-signal schema

**LLM provider:** Anthropic API (Claude) via the official `@anthropic-ai/sdk`,
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
- If `deRisk == true`, require ≥1 `signals[*]` with a resolvable `evidenceId`; else ignore the de-risk request.
- The model may only **tighten**: final USDY weight = `min(deterministic.candidate.USDY, model.usdyMaxWeightBps)`. It can never increase USDY or any bucket above the deterministic candidate.
- `rationale` + `signals` (with resolved evidence URLs) are hashed (`rationaleHash`) and bundled to IPFS (`decisionURI`) before calling `rebalance`/`deRisk`.

### 3.4 Prompt template (sketch)
**System:**
```
You are Sentinel's risk-guardian analyst for a tokenized-Treasury (USDY) yield vault on Mantle.
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
