// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20}          from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}       from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";
import {AggregatorSwapLib} from "./AggregatorSwapLib.sol";

/**
 * @title AusdAdapter
 * @notice Allocates USDC into AUSD (Agora USD, a fiat-backed $1 stablecoin) via a
 *         single, allow-listed DEX aggregator (Odos on Mantle) — the safety bucket
 *         the vault de-risks into when RWA (USDY) risk appears.
 *
 * Why an aggregator (and why this stays inside the custody boundary, AGENTS.md §2.1):
 * - AUSD liquidity on Mantle is fragmented across thin pools, so no single-pool
 *   USDC/AUSD route is usable at size. An aggregator splits the order across venues.
 * - The "never execute arbitrary calldata" rule is preserved by three constraints
 *   enforced in `AggregatorSwapLib`: (1) the router is a pinned immutable address,
 *   (2) `minOut` is a balance-delta the adapter derives itself (the router's output
 *   is never trusted), (3) output must land on this adapter or the delta is 0 and
 *   the swap reverts (fail-closed).
 *
 * Accounting — why 1:1 and not a DEX/oracle mark:
 * - AUSD is a fiat-backed stablecoin redeemable 1:1 for USD, with off-chain
 *   proof-of-reserves (Chaos Labs) feeding the risk engine separately (task A1.2).
 *   For on-chain vault accounting we value the AUSD balance at face (1:1 with USDC,
 *   both 6 decimals) — never a DEX spot, per AGENTS.md §7 ground-truth reads. A
 *   depeg shows up via the risk engine + Guardrails, not by silently marking the
 *   bucket up or down on a thin-pool quote.
 * - USDC and AUSD are both 6-decimal, so the deposit/withdraw expected output is
 *   ~1:1 before slippage.
 *
 * Only the vault (VAULT immutable) can call fund-moving functions.
 */
contract AusdAdapter is IStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyVault();
    error ZeroAmount();
    error ZeroAddress();

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice Pinned, allow-listed DEX aggregator router (e.g. Odos on Mantle).
    ///         The only address swap calldata may target.
    address public immutable AGGREGATOR;

    /// @notice USDC token (the deposit/withdrawal asset, 6 decimals).
    address public immutable override underlying;

    /// @notice AUSD token (Agora USD, 6 decimals).
    address public immutable AUSD;

    /// @notice The YieldVault that owns this adapter (only caller permitted).
    address public immutable VAULT;

    /// @notice Maximum tolerated swap slippage (bps). Mirrors Guardrails default (50 = 0.5%).
    uint16 public immutable MAX_SLIPPAGE_BPS;

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param aggregator      Pinned, allow-listed DEX aggregator router (e.g. Odos).
     * @param usdc            USDC token address (6 dec).
     * @param ausd            AUSD token address (6 dec).
     * @param vault           YieldVault address (sole permitted caller).
     * @param maxSlippageBps  Max swap slippage (bps; typically 50 = 0.5%).
     */
    constructor(
        address aggregator,
        address usdc,
        address ausd,
        address vault,
        uint16  maxSlippageBps
    ) {
        if (aggregator == address(0) || usdc == address(0) ||
            ausd == address(0) || vault == address(0)) revert ZeroAddress();

        AGGREGATOR       = aggregator;
        underlying       = usdc;
        AUSD             = ausd;
        VAULT            = vault;
        MAX_SLIPPAGE_BPS = maxSlippageBps;

        // Pre-approve the pinned aggregator for both swap directions (max
        // allowance, gas-efficient). Only this one router is ever approved.
        IERC20(usdc).forceApprove(aggregator, type(uint256).max);
        IERC20(ausd).forceApprove(aggregator, type(uint256).max);
    }

    // ── IStrategyAdapter ──────────────────────────────────────────────────────

    /**
     * @notice USDC value of AUSD held by this adapter, valued 1:1 at face.
     *         AUSD and USDC are both 6-decimal, so the balance IS the USDC value.
     *         Depeg risk is handled by the risk engine + Guardrails, not by
     *         marking this bucket against a thin-pool DEX quote.
     */
    function totalAssets() external view override returns (uint256) {
        return IERC20(AUSD).balanceOf(address(this));
    }

    /**
     * @notice Maximum USDC withdrawable via DEX swap. Face value of the AUSD
     *         balance; Phase 2b-style DEX liquidity caps can refine this later.
     */
    function maxWithdrawable() external view override returns (uint256) {
        return IERC20(AUSD).balanceOf(address(this));
    }

    /// @inheritdoc IStrategyAdapter
    function hasAssets() external view override returns (bool) {
        return IERC20(AUSD).balanceOf(address(this)) > 0;
    }

    /**
     * @notice Swap vault's USDC into AUSD via the pinned aggregator.
     * @dev Vault must approve this adapter before calling. `swapData` is the
     *      aggregator router calldata from the off-chain 1delta quote, paying this
     *      adapter as recipient. minAUSD out = usdcAmount × (1 − slippage) (both
     *      6-dec, 1:1 peg), enforced as a balance-delta check.
     * @return deployedUsdcValue USDC value deployed (== usdcAmount; AUSD is 1:1).
     */
    function deposit(uint256 usdcAmount, bytes calldata swapData)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256)
    {
        if (usdcAmount == 0) revert ZeroAmount();

        // Pull USDC from vault.
        IERC20(underlying).safeTransferFrom(VAULT, address(this), usdcAmount);

        // AUSD is 6-dec and ~1:1 with USDC, so expected AUSD == usdcAmount.
        uint256 minAusd = usdcAmount * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;

        // Output lands on this adapter; balance-delta enforces minAusd.
        AggregatorSwapLib.swap(AGGREGATOR, AUSD, minAusd, swapData);

        return usdcAmount;
    }

    /**
     * @notice Sell AUSD to return at least `usdcAmount` USDC to `to`.
     * @dev `swapData` sells AUSD and pays this adapter; realized USDC is forwarded
     *      to `to`. On-chain we enforce minOut = max(minOutUsdc, usdcAmount) via
     *      balance delta, so the caller always receives at least what it asked for.
     * @return withdrawn Actual USDC delivered to `to`.
     */
    function withdraw(uint256 usdcAmount, uint256 minOutUsdc, address to, bytes calldata swapData)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (usdcAmount == 0) revert ZeroAmount();

        uint256 minOut = minOutUsdc > usdcAmount ? minOutUsdc : usdcAmount;
        withdrawn = AggregatorSwapLib.swap(AGGREGATOR, underlying, minOut, swapData);
        IERC20(underlying).safeTransfer(to, withdrawn);
    }

    /**
     * @notice Sell all AUSD and send USDC proceeds to `to`.
     * @param minOutUsdc Minimum acceptable total USDC (slippage guard for the caller).
     * @param swapData   Aggregator calldata selling the full AUSD balance to this adapter.
     * @return withdrawn Actual USDC delivered to `to` (0 if no AUSD held).
     */
    function emergencyWithdrawAll(uint256 minOutUsdc, address to, bytes calldata swapData)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 withdrawn)
    {
        uint256 ausdBal = IERC20(AUSD).balanceOf(address(this));
        if (ausdBal == 0) return 0;

        withdrawn = AggregatorSwapLib.swap(AGGREGATOR, underlying, minOutUsdc, swapData);
        IERC20(underlying).safeTransfer(to, withdrawn);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }
}
