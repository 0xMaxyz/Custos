// SPDX-License-Identifier: MIT
// Custos — AI risk-guardian real-yield account on Mantle.
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IUsdyAdapter } from "./interfaces/IUsdyAdapter.sol";
import { IRWADynamicOracle } from "./interfaces/IRWADynamicOracle.sol";
import { IMusd } from "./interfaces/IMusd.sol";
import { AggregatorSwapLib } from "./AggregatorSwapLib.sol";

/**
 * @title UsdyAdapter
 * @notice Allocates USDC into the Ondo tokenized-Treasury RWA core (held as USDY
 *         and/or its rebasing $1 form **mUSD**) via a single, allow-listed DEX
 *         aggregator (e.g. Odos on Mantle), and values holdings through the Ondo
 *         RWADynamicOracle. USDY and mUSD are the two on-chain forms of the SAME
 *         bucket (bucket 2) — no separate bucket; the adapter converts between them
 *         on-chain via the Ondo mUSD `wrap`/`unwrap` converter (see IMusd).
 *
 * Why an aggregator instead of a direct single-pool router: USDY liquidity on
 * Mantle is fragmented across thin pools (Agni USDY/USDT ~$0.97k, iZiSwap
 * USDY/USDC ~$0.40k, Butter USDY/USDC ~$0.23k). No single DEX has a usable direct
 * USDC/USDY route, so a single-pool swap reverts at any meaningful size. An
 * aggregator splits the order across all venues. It stays inside the custody
 * boundary via a pinned router + an oracle-derived balance-delta minOut.
 *
 * Why also hold mUSD (the Ondo Token Converter leg): mUSD is the
 * rebasing, $1-pegged form of USDY and frequently trades against deeper DEX
 * liquidity on Mantle than raw USDY. Holding either form interchangeably lets the
 * agent enter/exit through whichever leg is deeper, while the USDY ↔ mUSD
 * conversion itself is liquidity-free and oracle-priced (no DEX, no slippage beyond
 * rounding) via the pinned mUSD contract's `wrap`/`unwrap`.
 *
 * Design:
 * - `totalAssets()` = USDY balance × oracle NAV + mUSD balance at $1 face (mUSD is a
 *   $1-pegged token; valued at face exactly as AusdAdapter values AUSD, never a DEX
 *   mark). The two are value-equivalent across a `wrap`/`unwrap`, so `totalAssets()`
 *   is conserved by a conversion.
 * - `maxWithdrawable()` = totalAssets().
 * - Slippage is enforced on-chain by a **balance-delta** check: minOut is derived
 *   from oracle NAV ± maxSlippageBps and measured against the actual tokenOut this
 *   adapter receives — the aggregator's (and converter's) reported output is never
 *   trusted.
 * - `swapData` (per IStrategyAdapter) carries the aggregator router calldata from
 *   the off-chain 1delta quote. It MUST be non-empty (no on-chain default route
 *   exists for an aggregator) and MUST pay this adapter as the recipient. Exit
 *   (`withdraw`/`emergencyWithdrawAll`) measures the USDC delta, so the same path
 *   unwinds whichever RWA form the adapter holds (USDY or mUSD → USDC).
 * - USDY ↔ mUSD conversion (`convertToMusd`/`convertToUsdy`) targets ONLY the pinned
 *   immutable `MUSD` contract — not arbitrary calldata — and enforces an
 *   oracle-derived balance-delta minOut, so it stays inside the custody boundary.
 * - Only the vault (VAULT immutable) can call fund-moving functions.
 * - **Blocklist**: USDY (and mUSD) enforce a transfer blocklist. The vault and this
 *   adapter must NOT be on the blocklist at deploy time, or swaps/conversions will
 *   revert. Verify with `USDY.isBlocked(adapter)` before activating.
 */
contract UsdyAdapter is IUsdyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyVault();
    error ZeroAmount();
    error ZeroAddress();
    error OracleStale();
    error MusdNotConfigured();
    error InsufficientConverterOutput(uint256 received, uint256 minOut);

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice Pinned, allow-listed DEX aggregator router (e.g. Odos on Mantle).
    ///         The only address swap calldata may target.
    address public immutable AGGREGATOR;

    /// @notice USDC token (the deposit/withdrawal asset, 6 decimals).
    address public immutable override underlying;

    /// @notice USDY token (Ondo tokenized Treasuries, 18 decimals).
    address public immutable USDY;

    /// @notice Ondo mUSD converter/token — the rebasing $1 form of USDY, also the
    ///         contract hosting `wrap`/`unwrap` (the "Ondo Token Converter"). 18
    ///         decimals. `address(0)` disables the mUSD leg (USDY-only adapter).
    address public immutable override MUSD;

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
     * @param musd            Ondo mUSD converter/token (18 dec). Pass `address(0)`
     *                        to deploy a USDY-only adapter (mUSD leg disabled).
     * @param oracle          Ondo RWADynamicOracle address.
     * @param vault           YieldVault address (sole permitted caller).
     * @param maxSlippageBps  Max swap slippage (bps; typically 50 = 0.5%).
     */
    constructor(
        address aggregator,
        address usdc,
        address usdy,
        address musd,
        address oracle,
        address vault,
        uint16 maxSlippageBps
    ) {
        if (
            aggregator == address(0) || usdc == address(0) || usdy == address(0)
                || oracle == address(0) || vault == address(0)
        ) revert ZeroAddress();

        AGGREGATOR = aggregator;
        underlying = usdc;
        USDY = usdy;
        MUSD = musd;
        ORACLE = IRWADynamicOracle(oracle);
        VAULT = vault;
        MAX_SLIPPAGE_BPS = maxSlippageBps;

        // Pre-approve the pinned aggregator for both swap directions (max
        // allowance, gas-efficient). Only this one router is ever approved.
        IERC20(usdc).forceApprove(aggregator, type(uint256).max);
        IERC20(usdy).forceApprove(aggregator, type(uint256).max);

        // mUSD leg (optional): approve the pinned mUSD contract to pull USDY for
        // `wrap`, and approve the aggregator to sell mUSD on exit. `unwrap` burns
        // the adapter's own mUSD and needs no allowance.
        if (musd != address(0)) {
            IERC20(usdy).forceApprove(musd, type(uint256).max);
            IERC20(musd).forceApprove(aggregator, type(uint256).max);
        }
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
            rangeEnd = 0;
        }
    }

    // ── IStrategyAdapter ──────────────────────────────────────────────────────

    /**
     * @notice USDC value of the RWA core held by this adapter: USDY priced at oracle
     *         NAV plus mUSD valued at $1 face. mUSD is a $1-pegged rebasing token, so
     *         it is valued at face (as AusdAdapter values AUSD) — never a DEX mark;
     *         a depeg surfaces via the risk engine + Guardrails. The USDY leg uses
     *         try/catch so a reverted oracle never breaks vault accounting (USDY then
     *         values at 0, forcing a de-risk check) while the oracle-independent mUSD
     *         leg keeps its face value.
     */
    function totalAssets() external view override returns (uint256) {
        return _totalAssets();
    }

    /// @dev Internal total-assets so callers (e.g. {maxWithdrawable}) avoid an external
    ///      `this.totalAssets()` self-call.
    function _totalAssets() internal view returns (uint256) {
        return _usdyValue() + _musdValue();
    }

    /// @notice Whether the adapter holds USDY or mUSD. Balance-based and
    ///         oracle-independent, so the vault never removes this adapter and orphans
    ///         funds when the oracle is down (totalAssets() would read 0).
    function hasAssets() external view override returns (bool) {
        if (IERC20(USDY).balanceOf(address(this)) > 0) return true;
        return MUSD != address(0) && IERC20(MUSD).balanceOf(address(this)) > 0;
    }

    /// @inheritdoc IUsdyAdapter
    function heldRwaBalances() external view override returns (uint256 usdyBal, uint256 musdBal) {
        usdyBal = IERC20(USDY).balanceOf(address(this));
        musdBal = MUSD == address(0) ? 0 : IERC20(MUSD).balanceOf(address(this));
    }

    /// @dev USDC (6-dec) value of held USDY at oracle NAV; 0 if none or oracle down.
    function _usdyValue() internal view returns (uint256) {
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

    /// @dev USDC (6-dec) face value of held mUSD ($1/token, 18-dec → /1e12). 0 if
    ///      the mUSD leg is disabled.
    function _musdValue() internal view returns (uint256) {
        if (MUSD == address(0)) return 0;
        uint256 musdBal = IERC20(MUSD).balanceOf(address(this));
        if (musdBal == 0) return 0;
        // musdBal (18-dec) at $1 face → USDC (6-dec): /1e12
        return musdBal / 1e12;
    }

    /**
     * @notice Maximum USDC withdrawable via DEX swap at current oracle price.
     *         Equal to totalAssets().
     */
    function maxWithdrawable() external view override returns (uint256) {
        return _totalAssets();
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
     * @notice Sell the entire RWA position (USDY and/or mUSD) and send USDC proceeds
     *         to `to`. Used by the vault's de-risk and kill paths.
     * @param minOutUsdc Minimum acceptable total USDC (slippage guard for the caller).
     * @param swapData   Aggregator calldata selling the held RWA balance to this
     *                   adapter. May sell USDY, mUSD, or both in one route — the
     *                   minOut is checked on the realized USDC delta, so the path is
     *                   agnostic to which form the adapter holds.
     */
    function emergencyWithdrawAll(uint256 minOutUsdc, address to, bytes calldata swapData)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 withdrawn)
    {
        uint256 usdyBal = IERC20(USDY).balanceOf(address(this));
        uint256 musdBal = MUSD == address(0) ? 0 : IERC20(MUSD).balanceOf(address(this));
        if (usdyBal == 0 && musdBal == 0) return 0;

        withdrawn = AggregatorSwapLib.swap(AGGREGATOR, underlying, minOutUsdc, swapData);
        IERC20(underlying).safeTransfer(to, withdrawn);
    }

    // ── mUSD converter leg (USDY ↔ mUSD via the Ondo mUSD wrap/unwrap) ──────────

    /**
     * @notice Convert held USDY into mUSD (the rebasing $1 form) via `mUSD.wrap`.
     * @dev Vault-only. Value-neutral: `totalAssets()` is unchanged across the
     *      conversion (USDY at NAV ≡ mUSD at $1 face). minOut is enforced on the
     *      realized mUSD balance delta (the converter's reported output is never
     *      trusted) using the stricter of the caller's `minMusdOut` and an
     *      oracle-derived floor. Targets only the pinned `MUSD` contract.
     * @param usdyAmount  USDY (18-dec) to wrap. Must be ≤ the adapter's USDY balance.
     * @param minMusdOut  Caller's minimum acceptable mUSD (18-dec); 0 to rely solely
     *                    on the oracle-derived floor.
     * @return musdOut    mUSD (18-dec) actually received by this adapter.
     */
    function convertToMusd(uint256 usdyAmount, uint256 minMusdOut)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 musdOut)
    {
        if (MUSD == address(0)) revert MusdNotConfigured();
        if (usdyAmount == 0) revert ZeroAmount();
        _requireOracleFresh();

        uint256 nav = ORACLE.getPrice();
        // Expected mUSD (18-dec): usdyAmount (18-dec) × nav (18-dec) / 1e18.
        uint256 expectedMusd = (usdyAmount * nav) / 1e18;
        uint256 floor = expectedMusd * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;
        uint256 minOut = minMusdOut > floor ? minMusdOut : floor;

        uint256 balBefore = IERC20(MUSD).balanceOf(address(this));
        IMusd(MUSD).wrap(usdyAmount);
        musdOut = IERC20(MUSD).balanceOf(address(this)) - balBefore;
        if (musdOut < minOut) revert InsufficientConverterOutput(musdOut, minOut);
    }

    /**
     * @notice Convert held mUSD back into USDY via `mUSD.unwrap`.
     * @dev Vault-only. Value-neutral (see `convertToMusd`). minOut is enforced on the
     *      realized USDY balance delta using the stricter of `minUsdyOut` and an
     *      oracle-derived floor. Targets only the pinned `MUSD` contract.
     * @param musdAmount  mUSD (18-dec) to unwrap. Must be ≤ the adapter's mUSD balance.
     * @param minUsdyOut  Caller's minimum acceptable USDY (18-dec); 0 to rely solely
     *                    on the oracle-derived floor.
     * @return usdyOut     USDY (18-dec) actually received by this adapter.
     */
    function convertToUsdy(uint256 musdAmount, uint256 minUsdyOut)
        external
        override
        onlyVault
        nonReentrant
        returns (uint256 usdyOut)
    {
        if (MUSD == address(0)) revert MusdNotConfigured();
        if (musdAmount == 0) revert ZeroAmount();
        _requireOracleFresh();

        uint256 nav = ORACLE.getPrice();
        // Expected USDY (18-dec): musdAmount (18-dec) × 1e18 / nav (18-dec).
        uint256 expectedUsdy = (musdAmount * 1e18) / nav;
        uint256 floor = expectedUsdy * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;
        uint256 minOut = minUsdyOut > floor ? minUsdyOut : floor;

        uint256 balBefore = IERC20(USDY).balanceOf(address(this));
        IMusd(MUSD).unwrap(musdAmount);
        usdyOut = IERC20(USDY).balanceOf(address(this)) - balBefore;
        if (usdyOut < minOut) revert InsufficientConverterOutput(usdyOut, minOut);
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
