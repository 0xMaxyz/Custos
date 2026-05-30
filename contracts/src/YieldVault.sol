// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC4626}       from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20}         from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20}        from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}     from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable}      from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Roles}           from "./Roles.sol";
import {Guardrails}      from "./Guardrails.sol";
import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";

/**
 * @title YieldVault
 * @notice ERC-4626 vault that allocates USDC across idle, Aave, USDY, and AUSD
 *         buckets under strict on-chain guardrails. An AI agent (the ALLOCATOR)
 *         proposes target weights; the Guardrails contract validates every move
 *         before execution.
 *
 * Phase 1 scope (PR-1a): idle-only vault with roles, pause, kill switch, and
 * strategy adapter registry. Phase 1b adds AaveV3Adapter + rebalance/withdraw.
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

    // ── Events ────────────────────────────────────────────────────────────────

    event VaultKilled(address indexed by);
    event StrategyQueued(uint8 indexed bucket, address adapter, uint256 unlocksAt);
    event StrategyActivated(uint8 indexed bucket, address adapter);
    event StrategyRemoved(uint8 indexed bucket);
    event GuardrailsUpdated(address indexed newGuardrails);
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
    /// @dev Serves withdrawal from idle first; does not touch adapters (Phase 1b adds that).
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle < assets) revert InsufficientLiquidity();
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
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle < assets_) revert InsufficientLiquidity();
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
        require(adapter.totalAssets() == 0, "YieldVault: adapter still holds assets");
        delete adapters[bucket];
        emit StrategyRemoved(bucket);
    }

    /// @notice Point the vault at a new Guardrails contract. Only ADMIN.
    function setGuardrails(address _guardrails) external onlyRole(Roles.ADMIN) {
        guardrails = Guardrails(_guardrails);
        emit GuardrailsUpdated(_guardrails);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _requireNotKilled() internal view {
        if (isKilled) revert Killed();
    }

    function _checkDepositCaps(uint256 assets) internal view {
        Guardrails.Config memory c = guardrails.config();
        if (assets > c.perTxDepositCap) revert DepositCapExceeded();
        if (totalAssets() + assets > c.tvlCap) revert TvlCapExceeded();
    }
}
