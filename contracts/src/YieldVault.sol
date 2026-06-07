// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { Roles } from "./Roles.sol";
import { Guardrails } from "./Guardrails.sol";
import { IStrategyAdapter } from "./interfaces/IStrategyAdapter.sol";
import { IUsdyAdapter } from "./interfaces/IUsdyAdapter.sol";
import { IAgentBenchmark } from "./interfaces/IAgentBenchmark.sol";

/**
 * @title YieldVault
 * @notice ERC-4626 vault that allocates USDC across idle, Aave, USDY, and AUSD
 *         buckets under strict on-chain guardrails. An AI agent (the ALLOCATOR)
 *         proposes target weights; the Guardrails contract validates every move
 *         before execution.
 */
contract YieldVault is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Errors ────────────────────────────────────────────────────────────────

    error Killed();
    error DepositCapExceeded();
    error TvlCapExceeded();
    error GuardrailsNotSet();
    error AdapterAlreadyRegistered(uint8 bucket);
    error TimelockNotElapsed(uint8 bucket);
    error NothingToWithdraw();
    error InsufficientLiquidity();
    error InvalidBucket();
    error NotKilled();
    error GuardrailsRejected(bytes4 reason);
    error DeRiskConditionNotMet();
    error InvalidToBucket();
    error NotAllocatorOrGuardian();
    error AdapterStillHasAssets();
    error RwaAdapterNotSet();
    error NoPendingGuardrails();
    error GuardrailsTimelockNotElapsed();

    // ── Events ────────────────────────────────────────────────────────────────

    event VaultKilled(address indexed by);
    event StrategyQueued(uint8 indexed bucket, address adapter, uint256 unlocksAt);
    event StrategyActivated(uint8 indexed bucket, address adapter);
    event StrategyRemoved(uint8 indexed bucket);
    event GuardrailsUpdated(address indexed newGuardrails);
    event GuardrailsQueued(address indexed newGuardrails, uint256 unlocksAt);
    event BenchmarkUpdated(address indexed newBenchmark);
    event DecisionRecorded(
        uint256 indexed id, uint8 kind, bytes32 rationaleHash, string decisionURI
    );
    event Rebalanced(uint256 indexed id, uint16[4] postWeightsBps);
    event DeRisked(uint256 indexed id, uint8 toBucket, bytes32 evidenceHash);
    event RwaLegConverted(bool indexed toMusd, uint256 amountIn, uint256 amountOut);

    // ── Types ─────────────────────────────────────────────────────────────────

    struct PendingStrategy {
        address adapter;
        uint256 unlocksAt; // block.timestamp after which it can be activated
    }

    // ── Constants ─────────────────────────────────────────────────────────────

    uint8 private constant BUCKET_IDLE = 0;
    uint8 private constant BUCKET_AAVE = 1;
    uint8 private constant BUCKET_USDY = 2;
    uint8 private constant BUCKET_AUSD = 3;
    uint8 private constant NUM_BUCKETS = 4;

    // ── State ─────────────────────────────────────────────────────────────────

    Guardrails public guardrails;

    /// Pending timelocked Guardrails swap (H3). address(0) = none queued.
    address public pendingGuardrails;
    uint256 public guardrailsUnlocksAt;

    /// Optional benchmark ledger (may be address(0) before Phase 2b is configured).
    IAgentBenchmark public benchmark;

    /// Strategy adapter for each bucket (address(0) = no adapter = idle-in-vault).
    IStrategyAdapter[NUM_BUCKETS] public adapters;

    /// Pending strategy registrations awaiting timelock.
    PendingStrategy[NUM_BUCKETS] public pendingAdapters;

    /// Whether the kill switch has been thrown.
    bool public isKilled;

    /// Monotonic decision counter.
    uint256 public decisionCount;

    /// Timestamp of the last ordinary rebalance (used by guardrails frequency check).
    uint64 public lastRebalanceAt;

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param usdc     USDC token address (the ERC-4626 asset).
     * @param admin    Address granted ADMIN + DEFAULT_ADMIN_ROLE.
     * @param _guardrails Initial Guardrails contract (may be updated by ADMIN).
     */
    constructor(address usdc, address admin, address _guardrails)
        ERC4626(IERC20(usdc))
        ERC20("Custos Yield Vault", "cvUSDC")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN, admin);
        guardrails = Guardrails(_guardrails);
    }

    // ── ERC-4626 overrides ────────────────────────────────────────────────────

    /**
     * @notice Total USDC value controlled by this vault.
     *         idle (in vault) + sum of adapter totalAssets().
     */
    function totalAssets() public view override returns (uint256 total) {
        total = IERC20(asset()).balanceOf(address(this)); // idle
        for (uint8 i = 0; i < NUM_BUCKETS; i++) {
            if (address(adapters[i]) != address(0)) {
                total += adapters[i].totalAssets();
            }
        }
    }

    /// @inheritdoc ERC4626
    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        _requireNotKilled();
        _checkDepositCaps(assets);
        return super.deposit(assets, receiver);
    }

    /// @inheritdoc ERC4626
    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 assets)
    {
        _requireNotKilled();
        uint256 assets_ = previewMint(shares);
        _checkDepositCaps(assets_);
        return super.mint(shares, receiver);
    }

    /// @inheritdoc ERC4626
    /// @dev Serves withdrawal from idle first, then adapters in bucket order.
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        _ensureLiquidity(assets);
        return super.withdraw(assets, receiver, owner_);
    }

    /// @inheritdoc ERC4626
    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        uint256 assets_ = previewRedeem(shares);
        _ensureLiquidity(assets_);
        return super.redeem(shares, receiver, owner_);
    }

    // ── Guardian actions ──────────────────────────────────────────────────────

    /// @notice Pause deposits and rebalances. Withdrawals remain open.
    function pause() external onlyRole(Roles.GUARDIAN) {
        _pause();
    }

    /// @notice Unpause.
    function unpause() external onlyRole(Roles.GUARDIAN) {
        _unpause();
    }

    /**
     * @notice Activate the kill switch. Irreversible. Puts vault into
     *         withdraw-only mode; all adapters should be unwound via emergencyExit.
     */
    function kill() external onlyRole(Roles.GUARDIAN) {
        isKilled = true;
        emit VaultKilled(msg.sender);
    }

    /**
     * @notice Emergency exit: drains a specific adapter to idle USDC.
     *         Only callable after kill(). No guardrail checks.
     */
    function emergencyExit(uint8 bucket, uint256 minOutUsdc, bytes calldata swapData)
        external
        onlyRole(Roles.GUARDIAN)
    {
        if (!isKilled) revert NotKilled();
        if (bucket >= NUM_BUCKETS) revert InvalidBucket();
        IStrategyAdapter adapter = adapters[bucket];
        if (address(adapter) == address(0)) revert NothingToWithdraw();
        adapter.emergencyWithdrawAll(minOutUsdc, address(this), swapData);
    }

    // ── Admin: strategy registry ──────────────────────────────────────────────

    /**
     * @notice Queue a new strategy adapter for `bucket`. Activatable after timelock.
     */
    function addStrategy(uint8 bucket, address adapter) external onlyRole(Roles.ADMIN) {
        _requireNotKilled();
        if (bucket >= NUM_BUCKETS) revert InvalidBucket();
        if (address(adapters[bucket]) != address(0)) revert AdapterAlreadyRegistered(bucket);

        uint256 unlocks = block.timestamp + guardrails.config().addStrategyTimelock;
        pendingAdapters[bucket] = PendingStrategy({ adapter: adapter, unlocksAt: unlocks });
        emit StrategyQueued(bucket, adapter, unlocks);
    }

    /**
     * @notice Activate a queued strategy once its timelock has elapsed.
     */
    function activateStrategy(uint8 bucket) external onlyRole(Roles.ADMIN) {
        if (bucket >= NUM_BUCKETS) revert InvalidBucket();
        PendingStrategy memory pending = pendingAdapters[bucket];
        if (pending.adapter == address(0)) revert NothingToWithdraw();
        if (block.timestamp < pending.unlocksAt) revert TimelockNotElapsed(bucket);

        adapters[bucket] = IStrategyAdapter(pending.adapter);
        delete pendingAdapters[bucket];
        emit StrategyActivated(bucket, pending.adapter);
    }

    /// @notice Remove a strategy adapter from a bucket (bucket must hold no funds).
    function removeStrategy(uint8 bucket) external onlyRole(Roles.ADMIN) {
        if (bucket >= NUM_BUCKETS) revert InvalidBucket();
        IStrategyAdapter adapter = adapters[bucket];
        if (address(adapter) == address(0)) revert NothingToWithdraw();
        // Require that the adapter holds no underlying tokens before removal. Uses a
        // balance-based check (not totalAssets value) so a USDY position is never
        // orphaned by an oracle outage that makes totalAssets() read 0 (M1).
        if (adapter.hasAssets()) revert AdapterStillHasAssets();
        delete adapters[bucket];
        emit StrategyRemoved(bucket);
    }

    /// @notice Queue a new Guardrails contract behind the addStrategyTimelock. Swapping
    ///         the guardrail brain is the single most sensitive admin action, so it is
    ///         timelocked rather than instant (H3). Only ADMIN.
    function queueGuardrails(address _guardrails) external onlyRole(Roles.ADMIN) {
        pendingGuardrails = _guardrails;
        guardrailsUnlocksAt = block.timestamp + guardrails.config().addStrategyTimelock;
        emit GuardrailsQueued(_guardrails, guardrailsUnlocksAt);
    }

    /// @notice Activate the queued Guardrails once its timelock has elapsed. Only ADMIN.
    function activateGuardrails() external onlyRole(Roles.ADMIN) {
        if (pendingGuardrails == address(0)) revert NoPendingGuardrails();
        if (block.timestamp < guardrailsUnlocksAt) revert GuardrailsTimelockNotElapsed();
        guardrails = Guardrails(pendingGuardrails);
        emit GuardrailsUpdated(pendingGuardrails);
        pendingGuardrails = address(0);
        guardrailsUnlocksAt = 0;
    }

    /// @notice Set (or clear) the AgentBenchmark ledger. Only ADMIN.
    function setBenchmark(address _benchmark) external onlyRole(Roles.ADMIN) {
        benchmark = IAgentBenchmark(_benchmark);
        emit BenchmarkUpdated(_benchmark);
    }

    // ── Allocator actions ─────────────────────────────────────────────────────

    /**
     * @notice Move funds toward `targetWeightsBps` within guardrail limits.
     * @dev    Only ALLOCATOR. Blocked when paused or killed.
     *         The guardrails contract validates the proposed move before any funds
     *         are transferred. Each adapter receives `swapData[bucket]` as an
     *         optional routing hint; on-chain minOut is enforced by the adapter.
     *
     * @param targetWeightsBps  Desired [IDLE, AAVE, USDY, AUSD] weights (sum 10000).
     * @param swapData          Per-bucket routing hint passed to adapters.
     * @param decisionURI       IPFS URI for the rationale + evidence bundle.
     * @param rationaleHash     keccak256 of the rationale text (on-chain anchor).
     * @param usdyDexSpotUsdc   Current USDY/USDC DEX spot price (18-dec, agent-supplied).
     *                          Required when increasing USDY weight (Guardrails will revert
     *                          UsdySpotRequired if oracle NAV is live but spot is 0). Safe to
     *                          pass 0 only when USDY weight is flat or decreasing.
     * @return decisionId       Monotonic id for this decision.
     */
    function rebalance(
        uint16[4] calldata targetWeightsBps,
        bytes[] calldata swapData,
        string calldata decisionURI,
        bytes32 rationaleHash,
        uint256 usdyDexSpotUsdc
    ) external onlyRole(Roles.ALLOCATOR) whenNotPaused nonReentrant returns (uint256 decisionId) {
        _requireNotKilled();

        uint256 tvl = totalAssets();
        uint16[4] memory preWeights = _currentWeightsBps(tvl);
        Guardrails.MarketState memory s = _buildMarketState(tvl, usdyDexSpotUsdc);

        _checkAndExecuteRebalance(preWeights, targetWeightsBps, tvl, swapData, s);

        decisionId = ++decisionCount;
        lastRebalanceAt = uint64(block.timestamp);

        emit DecisionRecorded(decisionId, 0, rationaleHash, decisionURI);
        emit Rebalanced(decisionId, _currentWeightsBps(totalAssets()));

        IAgentBenchmark bm = benchmark;
        if (address(bm) != address(0)) {
            bm.recordDecision(decisionId, rationaleHash, decisionURI, s.usdyOracleNav);
        }
    }

    function _checkAndExecuteRebalance(
        uint16[4] memory preWeights,
        uint16[4] calldata targetWeights,
        uint256 tvl,
        bytes[] calldata swapData,
        Guardrails.MarketState memory s
    ) internal {
        (bool ok, bytes4 reason) = guardrails.validateRebalance(preWeights, targetWeights, s);
        if (!ok) revert GuardrailsRejected(reason);
        _executeRebalance(preWeights, targetWeights, tvl, swapData);
    }

    /**
     * @notice Emergency rotation out of USDY into a safe bucket.
     *         Exempt from frequency and move-size caps.
     *         Callable by ALLOCATOR or GUARDIAN.
     *         Requires the depeg/oracle guard to be tripped, OR caller is GUARDIAN.
     *
     * @param toBucket          Target bucket: 0 (IDLE) or 3 (AUSD).
     * @param swapData          Per-bucket routing hint for the USDY adapter.
     * @param reason            Human-readable reason string.
     * @param evidenceHash      keccak256 of evidence (attestation, oracle reading, etc.).
     * @param usdyDexSpotUsdc   Current USDY/USDC DEX spot (18-dec). Required for allocator
     *                          de-risk so the oracle/depeg guard can evaluate peg health on
     *                          Mantle where `currentRange()` is absent. GUARDIAN may pass 0.
     * @return decisionId       Monotonic id for this decision.
     */
    function deRisk(
        uint8 toBucket,
        bytes[] calldata swapData,
        string calldata reason,
        bytes32 evidenceHash,
        uint256 usdyDexSpotUsdc
    ) external nonReentrant returns (uint256 decisionId) {
        bool isAllocator = hasRole(Roles.ALLOCATOR, msg.sender);
        bool isGuardian = hasRole(Roles.GUARDIAN, msg.sender);
        if (!isAllocator && !isGuardian) revert NotAllocatorOrGuardian();
        _requireNotKilled();

        if (toBucket != BUCKET_IDLE && toBucket != BUCKET_AUSD) revert InvalidToBucket();

        // Allocator de-risk requires the oracle/depeg guard to have fired.
        // Pass usdyDexSpotUsdc so the guard can evaluate peg deviation on Mantle
        // (where currentRange() is absent and rangeEnd=0 alone won't fire forceDeRisk).
        if (isAllocator && !isGuardian) {
            uint256 tvl = totalAssets();
            Guardrails.MarketState memory s = _buildMarketState(tvl, usdyDexSpotUsdc);
            (, bool forceDeRisk,) = guardrails.evaluateUsdyRisk(s);
            if (!forceDeRisk) revert DeRiskConditionNotMet();
        }

        // Derive an oracle/spot-based USDC floor so the value-sensitive de-risk
        // liquidation is NOT executed with minOut=0 (the router's own minOut is never
        // trusted — see AggregatorSwapLib). Computed from current on-chain state, so a
        // compromised allocator cannot relax it beyond the supplied spot.
        uint256 minOut = _deRiskMinOut(usdyDexSpotUsdc);

        // Unwind the USDY bucket entirely, then (if target is AUSD) route the
        // freed USDC into the AUSD safety bucket. Extracted to a helper to keep
        // deRisk's stack within limits.
        _unwindUsdyToAusd(toBucket, swapData, minOut);

        decisionId = ++decisionCount;
        emit DecisionRecorded(decisionId, 1, evidenceHash, reason);
        emit DeRisked(decisionId, toBucket, evidenceHash);

        // Anchor de-risk decision in the benchmark ledger if configured.
        IAgentBenchmark bm = benchmark;
        if (address(bm) != address(0)) {
            uint256 tvl = totalAssets();
            Guardrails.MarketState memory s = _buildMarketState(tvl, usdyDexSpotUsdc);
            bm.recordDecision(decisionId, evidenceHash, reason, s.usdyOracleNav);
        }
    }

    /**
     * @notice Convert the RWA core (bucket 2) between its two on-chain forms,
     *         USDY ↔ mUSD, via the Ondo mUSD converter on the USDY adapter.
     * @dev Only ALLOCATOR. Blocked when paused or killed. This is **exposure-neutral**
     *      — it changes only the *form* the RWA bucket is held in, not its USDC value
     *      or weight (USDY at oracle NAV ≡ mUSD at $1 face), so it intentionally does
     *      NOT go through `Guardrails.validateRebalance`: there is no weight/notional
     *      change to validate. The adapter enforces an oracle-derived balance-delta
     *      minOut and only ever calls the pinned mUSD contract. Use this to hold the
     *      RWA core in whichever form trades against deeper DEX liquidity; entry/exit
     *      that changes exposure still goes through `rebalance`/`deRisk`.
     *
     * @param toMusd    true: wrap USDY → mUSD; false: unwrap mUSD → USDY.
     * @param amountIn  Source-token amount (18-dec USDY or mUSD) to convert.
     * @param minOut    Minimum acceptable output (18-dec); the adapter enforces the
     *                  stricter of this and its own oracle-derived floor.
     * @return amountOut Output-token amount (18-dec) received by the adapter.
     */
    function convertRwaLeg(bool toMusd, uint256 amountIn, uint256 minOut)
        external
        onlyRole(Roles.ALLOCATOR)
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        _requireNotKilled();

        IUsdyAdapter rwa = IUsdyAdapter(address(adapters[BUCKET_USDY]));
        if (address(rwa) == address(0)) revert RwaAdapterNotSet();

        amountOut =
            toMusd ? rwa.convertToMusd(amountIn, minOut) : rwa.convertToUsdy(amountIn, minOut);

        emit RwaLegConverted(toMusd, amountIn, amountOut);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _requireNotKilled() internal view {
        if (isKilled) revert Killed();
    }

    /**
     * @notice Unwind the USDY bucket to USDC, then route the freed USDC into the
     *         AUSD safety bucket when `toBucket == BUCKET_AUSD`. Pre-existing idle
     *         USDC is left liquid; only the amount freed from USDY is routed.
     * @dev Without an AUSD adapter or `swapData[BUCKET_AUSD]`, the freed USDC
     *      stays idle — still a safe state, just USDC instead of AUSD.
     * @param minOutUsdc Oracle/spot-derived USDC floor for the USDY liquidation,
     *      enforced by the adapter's balance-delta check (see {_deRiskMinOut}).
     */
    function _unwindUsdyToAusd(uint8 toBucket, bytes[] calldata swapData, uint256 minOutUsdc)
        internal
    {
        uint256 idleBefore = IERC20(asset()).balanceOf(address(this));

        IStrategyAdapter usdyAdapter = adapters[BUCKET_USDY];
        if (address(usdyAdapter) != address(0) && usdyAdapter.totalAssets() > 0) {
            bytes memory sd = swapData.length > BUCKET_USDY ? swapData[BUCKET_USDY] : bytes("");
            usdyAdapter.emergencyWithdrawAll(minOutUsdc, address(this), sd);
        }

        if (toBucket != BUCKET_AUSD) return;

        uint256 freed = IERC20(asset()).balanceOf(address(this)) - idleBefore;
        if (freed == 0) return;

        IStrategyAdapter ausdAdapter = adapters[BUCKET_AUSD];
        bytes memory ausdSd = swapData.length > BUCKET_AUSD ? swapData[BUCKET_AUSD] : bytes("");
        if (address(ausdAdapter) != address(0) && ausdSd.length > 0) {
            IERC20(asset()).forceApprove(address(ausdAdapter), freed);
            ausdAdapter.deposit(freed, ausdSd);
        }
    }

    /**
     * @notice Oracle/spot-derived USDC floor for a full USDY-bucket de-risk exit.
     * @dev Basis = min(oracle NAV, agent-supplied DEX spot), so the floor still clears
     *      during a real depeg (the scenario de-risk exists for) while still blocking
     *      gross MEV/slippage — a NAV-only floor would wrongly revert the exit exactly
     *      when spot < NAV. Falls back to the NAV-based value when the spot is 0
     *      (GUARDIAN path) or when the oracle read reverts. Returns 0 only when the
     *      bucket is empty or unpriced (the swap then realizes 0 and reverts on its own
     *      EmptySwapData / zero-delta path). The floor is enforced by the adapter's
     *      balance-delta check; the router's reported output is never trusted.
     * @param usdyDexSpotUsdc Agent-supplied USDY/USDC DEX spot (18-dec). 0 = use NAV.
     * @return minOut USDC (6-dec) the de-risk liquidation must realize.
     */
    function _deRiskMinOut(uint256 usdyDexSpotUsdc) internal view returns (uint256 minOut) {
        IStrategyAdapter usdyAdapter = adapters[BUCKET_USDY];
        if (address(usdyAdapter) == address(0)) return 0;

        uint256 valueAtNav = usdyAdapter.totalAssets(); // 6-dec USDC, NAV-based
        if (valueAtNav == 0) return 0;

        // Discount the bucket value to the real exit price when a DEX spot below NAV
        // is supplied. nav and usdyDexSpotUsdc are both 18-dec USDC-per-USDY, so the
        // ratio is dimensionless and `basis` stays 6-dec USDC.
        uint256 basis = valueAtNav;
        try IUsdyAdapter(address(usdyAdapter)).oracleData() returns (uint256 nav, uint64) {
            if (nav > 0 && usdyDexSpotUsdc > 0 && usdyDexSpotUsdc < nav) {
                basis = (valueAtNav * usdyDexSpotUsdc) / nav;
            }
        } catch {
            // Oracle down: keep the NAV-based value as the best available basis.
        }
        uint16 slippageBps = guardrails.config().maxSlippageBps;
        minOut = (basis * (10_000 - slippageBps)) / 10_000;
    }

    /**
     * @notice Pull liquidity from adapters (lowest bucket first) until the vault
     *         holds at least `needed` idle USDC. Reverts if total liquidity is
     *         insufficient.
     */
    function _ensureLiquidity(uint256 needed) internal {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle >= needed) return;

        uint256 remaining = needed - idle;
        // Synchronous redemptions are served only from INSTANT liquidity: idle USDC
        // + the Aave adapter. USDY/AUSD are sourced via a DEX aggregator and can only
        // be unwound with off-chain swap calldata (no empty-route default exists), so
        // they are never drained on the user-redemption path — that is precisely what
        // the `minInstantLiquidityBps` (15% = IDLE + Aave) guardrail guarantees. A
        // redemption exceeding instant liquidity reverts; the agent must rebalance
        // (supplying aggregator calldata) before it can be served.
        IStrategyAdapter aave = adapters[BUCKET_AAVE];
        if (address(aave) != address(0)) {
            uint256 available = aave.maxWithdrawable();
            if (available > 0) {
                uint256 toWithdraw = available < remaining ? available : remaining;
                // minOut=0 is safe: Aave is 1:1 USDC and self-enforces its floor.
                aave.withdraw(toWithdraw, 0, address(this), "");
            }
        }

        if (IERC20(asset()).balanceOf(address(this)) < needed) revert InsufficientLiquidity();
    }

    /// @notice Current allocation weights in bps given `tvl`. Rounds down; remainder to IDLE.
    function _currentWeightsBps(uint256 tvl) internal view returns (uint16[4] memory w) {
        if (tvl == 0) {
            w[BUCKET_IDLE] = 10_000;
            return w;
        }
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        w[BUCKET_IDLE] = uint16((idle * 10_000) / tvl);
        uint256 sum = w[BUCKET_IDLE];
        for (uint8 i = 1; i < NUM_BUCKETS; i++) {
            if (address(adapters[i]) == address(0)) continue;
            uint256 bps = (adapters[i].totalAssets() * 10_000) / tvl;
            w[i] = uint16(bps);
            sum += bps;
        }
        // Round remainder into IDLE to keep sum == 10000.
        if (sum < 10_000) w[BUCKET_IDLE] += uint16(10_000 - sum);
    }

    /// @notice Build a Guardrails.MarketState snapshot from current on-chain state.
    /// @param usdyDexSpotUsdc Agent-supplied DEX spot price for USDY (18-dec). 0 = inactive.
    function _buildMarketState(uint256 tvl, uint256 usdyDexSpotUsdc)
        internal
        view
        returns (Guardrails.MarketState memory s)
    {
        IStrategyAdapter aaveAdapter = adapters[BUCKET_AAVE];
        s.aaveWithdrawable = address(aaveAdapter) != address(0) ? aaveAdapter.maxWithdrawable() : 0;
        s.totalAssets = tvl;
        s.lastRebalanceAt = lastRebalanceAt;

        // USDY oracle values: populated when the USDY adapter (bucket 2) is registered.
        // H1: s.oracleUpdatedAt is intentionally left 0 — Mantle's Ondo oracle exposes no
        // on-chain updatedAt, and oracleData() returns rangeEnd=0 (currentRange() reverts),
        // so the Guardrails staleness checks are inert here by design (see Guardrails §H1).
        IStrategyAdapter usdyAdapter = adapters[BUCKET_USDY];
        if (address(usdyAdapter) != address(0)) {
            try IUsdyAdapter(address(usdyAdapter)).oracleData() returns (
                uint256 nav, uint64 rangeEnd
            ) {
                s.usdyOracleNav = nav;
                s.oracleRangeEnd = rangeEnd;
            } catch {
                /* oracle down: leave as 0, guard stays inactive this cycle */
            }
        }
        // H2: usdyDexSpot is a TRUSTED allocator-supplied input (the same hot key the depeg
        // guard constrains). The $5k notional / 60% weight caps bound the exposure; an
        // on-chain TWAP cross-check is deferred to Phase 2b. The guard only fires when both
        // nav and spot are non-zero.
        s.usdyDexSpot = usdyDexSpotUsdc;
    }

    /**
     * @notice Execute the allocation delta implied by pre → target weights.
     *         For each bucket: if target > pre, deposit; if target < pre, withdraw.
     *         IDLE bucket is the source/sink (no adapter call needed).
     */
    function _executeRebalance(
        uint16[4] memory preWeights,
        uint16[4] calldata targetWeights,
        uint256 tvl,
        bytes[] calldata swapData
    ) internal {
        // First pass: withdraw from over-allocated buckets (free up idle USDC).
        for (uint8 i = 1; i < NUM_BUCKETS; i++) {
            if (targetWeights[i] >= preWeights[i]) continue;
            IStrategyAdapter adapter = adapters[i];
            if (address(adapter) == address(0)) continue;

            uint256 delta = ((uint256(preWeights[i]) - targetWeights[i]) * tvl) / 10_000;
            if (delta == 0) continue;
            bytes memory sd = swapData.length > i ? swapData[i] : bytes("");
            // minOut=0 safe: Aave is 1:1 and UsdyAdapter.withdraw self-enforces
            // minOut = max(minOutUsdc, usdcAmount) using its own MAX_SLIPPAGE_BPS.
            adapter.withdraw(delta, 0, address(this), sd);
        }

        // Second pass: deposit into under-allocated buckets.
        for (uint8 i = 1; i < NUM_BUCKETS; i++) {
            if (targetWeights[i] <= preWeights[i]) continue;
            IStrategyAdapter adapter = adapters[i];
            if (address(adapter) == address(0)) continue;

            uint256 delta = ((uint256(targetWeights[i]) - preWeights[i]) * tvl) / 10_000;
            if (delta == 0) continue;
            // Approve adapter to pull from vault then call deposit.
            IERC20(asset()).forceApprove(address(adapter), delta);
            bytes memory sd = swapData.length > i ? swapData[i] : bytes("");
            adapter.deposit(delta, sd);
        }
    }

    function _checkDepositCaps(uint256 assets) internal view {
        Guardrails.Config memory c = guardrails.config();
        if (assets > c.perTxDepositCap) revert DepositCapExceeded();
        if (totalAssets() + assets > c.tvlCap) revert TvlCapExceeded();
    }
}
