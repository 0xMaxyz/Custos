// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20}    from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStrategyAdapter}      from "./interfaces/IStrategyAdapter.sol";
import {IAaveV3Pool, ReserveData} from "./interfaces/IAaveV3Pool.sol";

/**
 * @title AaveV3Adapter
 * @notice Supplies and withdraws USDC on Aave v3 on behalf of YieldVault.
 *
 * - `totalAssets()` = aUSDC balance held by the vault (interest-bearing, grows
 *   every block via Aave's liquidity index).
 * - `maxWithdrawable()` = min(our aUSDC balance, available Aave pool liquidity)
 *   so the vault never tries to withdraw more than the pool can serve.
 * - Only the vault (owner) can call deposit/withdraw/emergencyWithdrawAll.
 *
 * Phase 1b: supports Aave USDC supply/withdraw. swapData is ignored (no swap).
 */
contract AaveV3Adapter is IStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyVault();
    error BelowMinOut();
    error ZeroAmount();
    error ZeroAddress();

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice Aave v3 Pool contract.
    IAaveV3Pool public immutable POOL;

    /// @notice USDC token (the deposit asset).
    address public immutable override underlying;

    /// @notice aUSDC token (Aave interest-bearing receipt).
    address public immutable A_USDC;

    /// @notice The YieldVault that owns this adapter.
    address public immutable VAULT;

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param pool   Aave v3 Pool address.
     * @param usdc   USDC token address.
     * @param aUsdc  aUSDC token address (Aave interest-bearing receipt for USDC).
     * @param vault  YieldVault address (the only caller allowed).
     */
    constructor(address pool, address usdc, address aUsdc, address vault) {
        if (pool == address(0) || usdc == address(0) || aUsdc == address(0) || vault == address(0)) {
            revert ZeroAddress();
        }
        POOL       = IAaveV3Pool(pool);
        underlying = usdc;
        A_USDC     = aUsdc;
        VAULT      = vault;
        // Pre-approve pool to spend USDC from this adapter (vault sends USDC here first).
        IERC20(usdc).forceApprove(pool, type(uint256).max);
    }

    // ── IStrategyAdapter ──────────────────────────────────────────────────────

    /// @notice USDC value of the aUSDC balance held by this adapter.
    ///         aUSDC is 1:1 with USDC by Aave's liquidity-index accounting.
    function totalAssets() external view override returns (uint256) {
        return IERC20(A_USDC).balanceOf(address(this));
    }

    /// @notice Minimum of our aUSDC balance and Aave's available pool liquidity.
    /// @dev Returns 0 when the USDC reserve is inactive or paused — a withdraw would
    ///      revert in those states, so reporting liquidity would over-state what the
    ///      vault can actually pull (mirrors the Aave v3 ReserveConfiguration bitmap:
    ///      bit 56 = active, bit 60 = paused; frozen (bit 57) still permits withdrawal).
    function maxWithdrawable() external view override returns (uint256) {
        uint256 cfg = POOL.getReserveData(underlying).configuration;
        bool isActive = (cfg >> 56) & 1 == 1;
        bool isPaused = (cfg >> 60) & 1 == 1;
        if (!isActive || isPaused) return 0;

        uint256 balance = IERC20(A_USDC).balanceOf(address(this));
        uint256 poolLiquidity = IERC20(underlying).balanceOf(A_USDC);
        return balance < poolLiquidity ? balance : poolLiquidity;
    }

    /// @inheritdoc IStrategyAdapter
    function hasAssets() external view override returns (bool) {
        return IERC20(A_USDC).balanceOf(address(this)) > 0;
    }

    /**
     * @notice Transfer USDC from vault into this adapter then supply to Aave.
     * @dev Vault must transfer USDC here before calling (or approve + pull).
     *      For simplicity the vault calls `USDC.transfer(adapter, amount)` first.
     */
    function deposit(uint256 usdcAmount, bytes calldata)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256)
    {
        if (usdcAmount == 0) revert ZeroAmount();
        // Pull USDC from vault (vault approved this adapter).
        IERC20(underlying).safeTransferFrom(VAULT, address(this), usdcAmount);
        // Supply to Aave; referral code 0.
        POOL.supply(underlying, usdcAmount, address(this), 0);
        return usdcAmount;
    }

    /**
     * @notice Withdraw `usdcAmount` USDC from Aave and send to vault.
     * @param usdcAmount  Target USDC to withdraw.
     * @param minOutUsdc  Minimum acceptable USDC received (slippage guard).
     * @param to          Recipient (typically the vault).
     */
    function withdraw(uint256 usdcAmount, uint256 minOutUsdc, address to, bytes calldata)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (usdcAmount == 0) revert ZeroAmount();
        withdrawn = POOL.withdraw(underlying, usdcAmount, to);
        if (withdrawn < minOutUsdc) revert BelowMinOut();
    }

    /**
     * @notice Withdraw all aUSDC from Aave and send to `to`.
     * @param minOutUsdc  Minimum acceptable USDC received.
     * @param to          Recipient (typically the vault for kill/de-risk).
     */
    function emergencyWithdrawAll(uint256 minOutUsdc, address to, bytes calldata)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 withdrawn)
    {
        uint256 balance = IERC20(A_USDC).balanceOf(address(this));
        if (balance == 0) return 0;
        withdrawn = POOL.withdraw(underlying, type(uint256).max, to);
        if (withdrawn < minOutUsdc) revert BelowMinOut();
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }
}
