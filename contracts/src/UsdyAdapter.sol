// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20}        from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}     from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IUsdyAdapter}       from "./interfaces/IUsdyAdapter.sol";
import {IRWADynamicOracle}  from "./interfaces/IRWADynamicOracle.sol";
import {AggregatorSwapLib}  from "./AggregatorSwapLib.sol";

/**
 * @title UsdyAdapter
 * @notice Allocates USDC into tokenized-Treasury yield (USDY) via a single,
 *         allow-listed DEX aggregator (e.g. Odos on Mantle), and values holdings
 *         through the Ondo RWADynamicOracle.
 *
 * Why an aggregator instead of a direct single-pool router: USDY liquidity on
 * Mantle is fragmented across thin pools (Agni USDY/USDT ~$0.97k, iZiSwap
 * USDY/USDC ~$0.40k, Butter USDY/USDC ~$0.23k). No single DEX has a usable direct
 * USDC/USDY route, so a single-pool swap reverts at any meaningful size. An
 * aggregator splits the order across all venues. See AGENTS.md §2.1 for why this
 * stays inside the custody boundary (pinned router + balance-delta minOut).
 *
 * Design:
 * - `totalAssets()` = USDY balance × oracle NAV (never a DEX mark for accounting).
 * - `maxWithdrawable()` = totalAssets(). Phase 2b will add a per-rebalance DEX
 *   liquidity cap.
 * - Slippage is enforced on-chain by a **balance-delta** check: minOut is derived
 *   from oracle NAV ± maxSlippageBps and measured against the actual tokenOut this
 *   adapter receives — the aggregator's reported output is never trusted.
 * - `swapData` (per IStrategyAdapter) carries the aggregator router calldata from
 *   the off-chain 1delta quote. It MUST be non-empty (no on-chain default route
 *   exists for an aggregator) and MUST pay this adapter as the recipient.
 * - Only the vault (VAULT immutable) can call fund-moving functions.
 * - **Blocklist**: USDY enforces a transfer blocklist. The vault and this adapter
 *   must NOT be on the USDY blocklist at deploy time, or swaps will revert.
 *   Verify with `USDY.isBlocked(adapter)` before activating (Phase 0.5 gate).
 *   Phase 2b will add an on-chain pre-swap blocklist check.
 */
contract UsdyAdapter is IUsdyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyVault();
    error ZeroAmount();
    error ZeroAddress();
    error OracleStale();

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice Pinned, allow-listed DEX aggregator router (e.g. Odos on Mantle).
    ///         The only address swap calldata may target.
    address public immutable AGGREGATOR;

    /// @notice USDC token (the deposit/withdrawal asset, 6 decimals).
    address public immutable override underlying;

    /// @notice USDY token (Ondo tokenized Treasuries, 18 decimals).
    address public immutable USDY;

    /// @notice Ondo RWADynamicOracle — returns NAV as 18-dec USDC-per-USDY.
    IRWADynamicOracle public immutable ORACLE;

    /// @notice The YieldVault that owns this adapter (only caller permitted).
    address public immutable VAULT;

    /// @notice Maximum tolerated swap slippage (bps). Mirrors Guardrails default (50 = 0.5%).
    uint16 public immutable MAX_SLIPPAGE_BPS;

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param aggregator      Pinned, allow-listed DEX aggregator router (e.g. Odos).
     * @param usdc            USDC token address (6 dec).
     * @param usdy            USDY token address (18 dec).
     * @param oracle          Ondo RWADynamicOracle address.
     * @param vault           YieldVault address (sole permitted caller).
     * @param maxSlippageBps  Max swap slippage (bps; typically 50 = 0.5%).
     */
    constructor(
        address aggregator,
        address usdc,
        address usdy,
        address oracle,
        address vault,
        uint16  maxSlippageBps
    ) {
        if (aggregator == address(0) || usdc == address(0) || usdy == address(0) ||
            oracle == address(0) || vault == address(0)) revert ZeroAddress();

        AGGREGATOR      = aggregator;
        underlying      = usdc;
        USDY            = usdy;
        ORACLE          = IRWADynamicOracle(oracle);
        VAULT           = vault;
        MAX_SLIPPAGE_BPS = maxSlippageBps;

        // Pre-approve the pinned aggregator for both swap directions (max
        // allowance, gas-efficient). Only this one router is ever approved.
        IERC20(usdc).forceApprove(aggregator, type(uint256).max);
        IERC20(usdy).forceApprove(aggregator, type(uint256).max);
    }

    // ── IUsdyAdapter ──────────────────────────────────────────────────────────

    /// @inheritdoc IUsdyAdapter
    /// @dev Ondo's deployed Mantle oracle exposes getPrice() but not currentRange();
    ///      the range call is wrapped in try/catch so rangeEnd=0 (range-staleness
    ///      check disabled) rather than reverting on the production ABI.
    function oracleData() external view override returns (uint256 nav, uint64 rangeEnd) {
        nav = ORACLE.getPrice();
        try ORACLE.currentRange() returns (uint256, uint256 end) {
            rangeEnd = end > type(uint64).max ? type(uint64).max : uint64(end);
        } catch {
            // currentRange() absent on Mantle's Ondo oracle → rangeEnd=0 disables
            // the adapter-level range-staleness check. The Guardrails depeg guard
            // (evaluateUsdyRisk) remains the deterministic backstop.
            // TODO(2b): when Guardrails gets a live DEX spot feed, verify oracleRangeEnd=0
            // doesn't silently suppress the allocator de-risk condition path.
            rangeEnd = 0;
        }
    }

    // ── IStrategyAdapter ──────────────────────────────────────────────────────

    /**
     * @notice USDC value of USDY held by this adapter, priced at oracle NAV.
     *         Returns 0 if the adapter holds no USDY or oracle returns 0.
     *         Uses try/catch so a reverted oracle never breaks vault accounting.
     */
    function totalAssets() external view override returns (uint256) {
        uint256 usdyBal = IERC20(USDY).balanceOf(address(this));
        if (usdyBal == 0) return 0;
        try ORACLE.getPrice() returns (uint256 nav) {
            if (nav == 0) return 0;
            // usdyBal (18-dec) × nav (18-dec) / 1e30 = USDC (6-dec)
            return (usdyBal * nav) / 1e30;
        } catch {
            return 0; // oracle down: conservative valuation, forces deRisk check
        }
    }

    /**
     * @notice Maximum USDC withdrawable via DEX swap at current oracle price.
     *         Phase 2a: equal to totalAssets(). Phase 2b will cap by DEX liquidity.
     */
    function maxWithdrawable() external view override returns (uint256) {
        return this.totalAssets();
    }

    /**
     * @notice Swap vault's USDC into USDY via the pinned aggregator.
     * @dev Vault must approve this adapter before calling. `swapData` is the
     *      aggregator router calldata from the off-chain 1delta quote, paying this
     *      adapter as recipient. minUSDY out = usdcAmount × (1e30 / nav) × (1 − slippage),
     *      enforced as a balance-delta check (the aggregator's output is never trusted).
     */
    function deposit(uint256 usdcAmount, bytes calldata swapData)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256)
    {
        if (usdcAmount == 0) revert ZeroAmount();
        _requireOracleFresh();

        // Pull USDC from vault.
        IERC20(underlying).safeTransferFrom(VAULT, address(this), usdcAmount);

        uint256 nav = ORACLE.getPrice();
        // Expected USDY (18-dec): usdcAmount (6-dec) × 1e30 / nav (18-dec)
        uint256 expectedUsdy = (usdcAmount * 1e30) / nav;
        uint256 minUsdy = expectedUsdy * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;

        // Output lands on this adapter; balance-delta enforces minUsdy.
        AggregatorSwapLib.swap(AGGREGATOR, USDY, minUsdy, swapData);

        return usdcAmount;
    }

    /**
     * @notice Sell USDY to return at least `usdcAmount` USDC to `to`.
     * @dev `swapData` (aggregator calldata) sells USDY and pays this adapter; the
     *      realized USDC is then forwarded to `to`. The over-sell buffer is chosen
     *      off-chain when building `swapData`; on-chain we enforce
     *      minOut = max(minOutUsdc, usdcAmount) via balance delta, so the caller
     *      always receives at least what it asked for.
     */
    function withdraw(uint256 usdcAmount, uint256 minOutUsdc, address to, bytes calldata swapData)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (usdcAmount == 0) revert ZeroAmount();
        _requireOracleFresh();

        uint256 minOut = minOutUsdc > usdcAmount ? minOutUsdc : usdcAmount;
        withdrawn = AggregatorSwapLib.swap(AGGREGATOR, underlying, minOut, swapData);
        IERC20(underlying).safeTransfer(to, withdrawn);
    }

    /**
     * @notice Sell all USDY and send USDC proceeds to `to`.
     * @param minOutUsdc Minimum acceptable total USDC (slippage guard for the caller).
     * @param swapData   Aggregator calldata selling the full USDY balance to this adapter.
     */
    function emergencyWithdrawAll(uint256 minOutUsdc, address to, bytes calldata swapData)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 withdrawn)
    {
        uint256 usdyBal = IERC20(USDY).balanceOf(address(this));
        if (usdyBal == 0) return 0;

        withdrawn = AggregatorSwapLib.swap(AGGREGATOR, underlying, minOutUsdc, swapData);
        IERC20(underlying).safeTransfer(to, withdrawn);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// @dev Reverts if the oracle price range has expired (NAV is stale).
    ///      currentRange() is optional on the deployed Mantle ABI — if it reverts,
    ///      we skip the range check and rely on getPrice() (which is called by the
    ///      swap math and reverts on a dead oracle). The on-chain Guardrails depeg
    ///      guard is the deterministic backstop regardless.
    function _requireOracleFresh() internal view {
        try ORACLE.currentRange() returns (uint256, uint256 rangeEnd) {
            if (rangeEnd > 0 && block.timestamp > rangeEnd) revert OracleStale();
        } catch {
            // Range not exposed; getPrice() (used downstream) still guards a dead oracle.
        }
    }
}
