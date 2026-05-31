// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20}        from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}     from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IUsdyAdapter}       from "./interfaces/IUsdyAdapter.sol";
import {IRWADynamicOracle}  from "./interfaces/IRWADynamicOracle.sol";
import {SwapLib}            from "./SwapLib.sol";

/**
 * @title UsdyAdapter
 * @notice Allocates USDC into tokenized-Treasury yield (USDY) via Merchant Moe
 *         DEX swaps, and values holdings through the Ondo RWADynamicOracle.
 *
 * Design:
 * - `totalAssets()` = USDY balance × oracle NAV (never a DEX mark for accounting).
 * - `maxWithdrawable()` = totalAssets(). Phase 2b will add a per-rebalance DEX
 *   liquidity cap.
 * - Slippage is enforced on-chain: minOut derived from oracle NAV ± maxSlippageBps.
 * - `swapData` (per IStrategyAdapter) overrides the default Merchant Moe path
 *   as abi.encode(uint256[] pairBinSteps, uint8[] versions). Empty = use defaults.
 * - Only the vault (VAULT immutable) can call fund-moving functions.
 */
contract UsdyAdapter is IUsdyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyVault();
    error BelowMinOut();
    error ZeroAmount();
    error ZeroAddress();
    error OracleStale();

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice Merchant Moe LB Router.
    address public immutable ROUTER;

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

    // ── Default path ──────────────────────────────────────────────────────────

    // Merchant Moe LBPair bin step and version for the direct USDC/USDY pool.
    // Defaults: bin step 1 (0.01% fee), version 2 (LBPair v2.1).
    // Override per-call via swapData = abi.encode(pairBinSteps, versions).
    uint256[] private _defaultBinSteps;
    uint8[]   private _defaultVersions;

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param router          Merchant Moe LB Router address.
     * @param usdc            USDC token address (6 dec).
     * @param usdy            USDY token address (18 dec).
     * @param oracle          Ondo RWADynamicOracle address.
     * @param vault           YieldVault address (sole permitted caller).
     * @param maxSlippageBps  Max swap slippage (bps; typically 50 = 0.5%).
     * @param defaultBinStep  Default Merchant Moe LBPair bin step (e.g. 1).
     * @param defaultVersion  Default router version (e.g. 2 = LBPair v2.1).
     */
    constructor(
        address router,
        address usdc,
        address usdy,
        address oracle,
        address vault,
        uint16  maxSlippageBps,
        uint256 defaultBinStep,
        uint8   defaultVersion
    ) {
        if (router == address(0) || usdc == address(0) || usdy == address(0) ||
            oracle == address(0) || vault == address(0)) revert ZeroAddress();

        ROUTER          = router;
        underlying      = usdc;
        USDY            = usdy;
        ORACLE          = IRWADynamicOracle(oracle);
        VAULT           = vault;
        MAX_SLIPPAGE_BPS = maxSlippageBps;

        _defaultBinSteps = new uint256[](1);
        _defaultVersions = new uint8[](1);
        _defaultBinSteps[0] = defaultBinStep;
        _defaultVersions[0] = defaultVersion;

        // Pre-approve router for both swap directions (max allowance, gas-efficient).
        IERC20(usdc).forceApprove(router, type(uint256).max);
        IERC20(usdy).forceApprove(router, type(uint256).max);
    }

    // ── IUsdyAdapter ──────────────────────────────────────────────────────────

    /// @inheritdoc IUsdyAdapter
    function oracleData() external view override returns (uint256 nav, uint64 rangeEnd) {
        nav = ORACLE.getPrice();
        (, uint256 end) = ORACLE.currentRange();
        rangeEnd = uint64(end);
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
     * @notice Swap vault's USDC into USDY via Merchant Moe.
     * @dev Vault must approve this adapter before calling.
     *      minUSDY out = usdcAmount × (1e30 / oracleNav) × (1 − slippage).
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

        (uint256[] memory binSteps, uint8[] memory versions) = _decodePath(swapData);
        SwapLib.exactIn(ROUTER, underlying, USDY, usdcAmount, minUsdy, address(this), binSteps, versions);

        return usdcAmount;
    }

    /**
     * @notice Sell enough USDY to return `usdcAmount` USDC to `to`.
     * @dev Sells usdcAmount × (1 + slippage) worth of USDY (at oracle NAV) to
     *      ensure the requested USDC is covered despite DEX price impact.
     *      minOut = max(minOutUsdc, usdcAmount) — caller always gets at least what
     *      they asked for (guaranteed by the over-sell buffer).
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

        uint256 usdyToSell = _usdyToSell(usdcAmount);
        uint256 minOut = minOutUsdc > usdcAmount ? minOutUsdc : usdcAmount;

        (uint256[] memory binSteps, uint8[] memory versions) = _decodePath(swapData);
        withdrawn = SwapLib.exactIn(ROUTER, USDY, underlying, usdyToSell, minOut, to, binSteps, versions);
    }

    /// @dev Compute USDY amount (18-dec) to sell to obtain `usdcAmount` USDC, including slippage buffer.
    function _usdyToSell(uint256 usdcAmount) internal view returns (uint256) {
        uint256 nav = ORACLE.getPrice();
        uint256 needed = (usdcAmount * 1e30) / nav;
        uint256 withBuffer = needed * (10_000 + MAX_SLIPPAGE_BPS) / 10_000;
        uint256 bal = IERC20(USDY).balanceOf(address(this));
        return withBuffer > bal ? bal : withBuffer;
    }

    /**
     * @notice Sell all USDY and send USDC proceeds to `to`.
     * @param minOutUsdc Minimum acceptable total USDC (slippage guard for the caller).
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

        (uint256[] memory binSteps, uint8[] memory versions) = _decodePath(swapData);
        withdrawn = SwapLib.exactIn(ROUTER, USDY, underlying, usdyBal, minOutUsdc, to, binSteps, versions);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// @dev Reverts if the oracle price range has expired (NAV is stale).
    function _requireOracleFresh() internal view {
        (, uint256 rangeEnd) = ORACLE.currentRange();
        if (rangeEnd > 0 && block.timestamp > rangeEnd) revert OracleStale();
    }

    /// @dev Decode swapData into path params, falling back to stored defaults.
    function _decodePath(bytes calldata swapData)
        internal
        view
        returns (uint256[] memory binSteps, uint8[] memory versions)
    {
        if (swapData.length > 0) {
            (binSteps, versions) = abi.decode(swapData, (uint256[], uint8[]));
        } else {
            binSteps = _defaultBinSteps;
            versions = _defaultVersions;
        }
    }
}
