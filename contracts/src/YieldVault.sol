// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC4626}       from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20}         from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20}        from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}     from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable}      from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Roles}            from "./Roles.sol";
import {Guardrails}       from "./Guardrails.sol";
import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";
import {IUsdyAdapter}     from "./interfaces/IUsdyAdapter.sol";
import {IAgentBenchmark}  from "./interfaces/IAgentBenchmark.sol";

/**
 * @title YieldVault
 * @notice ERC-4626 vault that allocates USDC across idle, Aave, USDY, and AUSD
 *         buckets under strict on-chain guardrails. An AI agent (the ALLOCATOR)
 *         proposes target weights; the Guardrails contract validates every move
 *         before execution.
 *
 * Phase 1b: adds rebalance(), deRisk(), and a multi-source withdraw queue that
 * drains idle first then registered adapters in bucket order.
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

    // ── Events ────────────────────────────────────────────────────────────────

    event VaultKilled(address indexed by);
    event StrategyQueued(uint8 indexed bucket, address adapter, uint256 unlocksAt);
    event StrategyActivated(uint8 indexed bucket, address adapter);
    event StrategyRemoved(uint8 indexed bucket);
    event GuardrailsUpdated(address indexed newGuardrails);
    event BenchmarkUpdated(address indexed newBenchmark);
    event DecisionRecorded(uint256 indexed id, uint8 kind, bytes32 rationaleHash, string decisionURI);
    event Rebalanced(uint256 indexed id, uint16[4] postWeightsBps);
    event DeRisked(uint256 indexed id, uint8 toBucket, bytes32 evidenceHash);

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
        ERC20("Sentinel Yield Vault", "svUSDC")
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
        pendingAdapters[bucket] = PendingStrategy({adapter: adapter, unlocksAt: unlocks});
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
        // Require that the adapter holds nothing before removal.
        if (adapter.totalAssets() != 0) revert AdapterStillHasAssets();
        delete adapters[bucket];
        emit StrategyRemoved(bucket);
    }

    /// @notice Point the vault at a new Guardrails contract. Only ADMIN.
    function setGuardrails(address _guardrails) external onlyRole(Roles.ADMIN) {
        guardrails = Guardrails(_guardrails);
        emit GuardrailsUpdated(_guardrails);
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
     *                          Pass 0 to disable the DEX-spot deviation guard.
     * @return decisionId       Monotonic id for this decision.
     */
    function rebalance(
        uint16[4] calldata targetWeightsBps,
        bytes[]   calldata swapData,
        string    calldata decisionURI,
        bytes32            rationaleHash,
        uint256            usdyDexSpotUsdc
    )
        external
        onlyRole(Roles.ALLOCATOR)
        whenNotPaused
        nonReentrant
        returns (uint256 decisionId)
    {
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
        uint16[4] memory   preWeights,
        uint16[4] calldata targetWeights,
        uint256            tvl,
        bytes[]   calldata swapData,
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
        uint8     toBucket,
        bytes[]   calldata swapData,
        string    calldata reason,
        bytes32            evidenceHash,
        uint256            usdyDexSpotUsdc
    )
        external
        nonReentrant
        returns (uint256 decisionId)
    {
        bool isAllocator = hasRole(Roles.ALLOCATOR, msg.sender);
        bool isGuardian  = hasRole(Roles.GUARDIAN,  msg.sender);
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

        // Unwind the USDY bucket entirely.
        IStrategyAdapter usdyAdapter = adapters[BUCKET_USDY];
        if (address(usdyAdapter) != address(0) && usdyAdapter.totalAssets() > 0) {
            bytes memory sd = swapData.length > BUCKET_USDY ? swapData[BUCKET_USDY] : bytes("");
            usdyAdapter.emergencyWithdrawAll(0, address(this), sd);
            // If target is AUSD and there's an AUSD adapter, route there (Phase 2).
            // Phase 1b: AUSD adapter not yet deployed, funds land in idle (USDC).
        }

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

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _requireNotKilled() internal view {
        if (isKilled) revert Killed();
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
        // Drain adapters in bucket order: AAVE first (instant liquidity), then others.
        for (uint8 i = 1; i < NUM_BUCKETS && remaining > 0; i++) {
            IStrategyAdapter adapter = adapters[i];
            if (address(adapter) == address(0)) continue;

            uint256 available = adapter.maxWithdrawable();
            if (available == 0) continue;

            uint256 toWithdraw = available < remaining ? available : remaining;
            // minOut=0 is safe: Aave is 1:1 and UsdyAdapter.withdraw internally sets
            // minOut = max(minOutUsdc, usdcAmount) so it always returns ≥ toWithdraw USDC.
            // TODO(2b): for any future adapter that does NOT self-enforce minOut, derive
            // a vault-side floor here: toWithdraw * (10_000 - guardrails.config().maxSlippageBps) / 10_000.
            adapter.withdraw(toWithdraw, 0, address(this), "");
            remaining = remaining > toWithdraw ? remaining - toWithdraw : 0;
        }

        if (IERC20(asset()).balanceOf(address(this)) < needed) revert InsufficientLiquidity();
    }

    /// @notice Current allocation weights in bps given `tvl`. Rounds down; remainder to IDLE.
    function _currentWeightsBps(uint256 tvl) internal view returns (uint16[4] memory w) {
        if (tvl == 0) { w[BUCKET_IDLE] = 10_000; return w; }
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
        s.aaveWithdrawable = address(aaveAdapter) != address(0)
            ? aaveAdapter.maxWithdrawable()
            : 0;
        s.totalAssets     = tvl;
        s.lastRebalanceAt = lastRebalanceAt;

        // USDY oracle values: populated when the USDY adapter (bucket 2) is registered.
        IStrategyAdapter usdyAdapter = adapters[BUCKET_USDY];
        if (address(usdyAdapter) != address(0)) {
            try IUsdyAdapter(address(usdyAdapter)).oracleData() returns (uint256 nav, uint64 rangeEnd) {
                s.usdyOracleNav  = nav;
                s.oracleRangeEnd = rangeEnd;
            } catch { /* oracle down: leave as 0, guard stays inactive this cycle */ }
        }
        // Use agent-supplied DEX spot; guard only fires when both nav and spot are non-zero.
        s.usdyDexSpot = usdyDexSpotUsdc;
    }

    /**
     * @notice Execute the allocation delta implied by pre → target weights.
     *         For each bucket: if target > pre, deposit; if target < pre, withdraw.
     *         IDLE bucket is the source/sink (no adapter call needed).
     */
    function _executeRebalance(
        uint16[4] memory  preWeights,
        uint16[4] calldata targetWeights,
        uint256            tvl,
        bytes[]   calldata swapData
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
