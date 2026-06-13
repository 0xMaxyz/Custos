// SPDX-License-Identifier: MIT
// Custos — AI risk-guardian real-yield account on Mantle.
pragma solidity 0.8.28;

import { IStrategyAdapter } from "./IStrategyAdapter.sol";

/**
 * @title IUsdyAdapter
 * @notice Extends IStrategyAdapter with oracle data access (so YieldVault can
 *         populate Guardrails.MarketState without holding a direct oracle reference)
 *         and the USDY ↔ mUSD converter leg. USDY and mUSD are the two
 *         on-chain forms of the same RWA bucket; conversion is value-neutral and
 *         oracle-priced via the Ondo mUSD `wrap`/`unwrap` (see IMusd).
 */
interface IUsdyAdapter is IStrategyAdapter {
    /**
     * @notice Current USDY oracle values.
     * @return nav      Oracle NAV — 18-decimal USDC per USDY (e.g. 1.0832e18).
     * @return rangeEnd Unix timestamp when the current oracle price range expires.
     *                  Past this timestamp the NAV is considered stale.
     */
    function oracleData() external view returns (uint256 nav, uint64 rangeEnd);

    /// @notice Ondo mUSD converter/token address, or `address(0)` if the mUSD leg is
    ///         disabled (USDY-only adapter).
    function MUSD() external view returns (address);

    /// @notice Raw held RWA token balances, oracle-independent. Lets the vault
    ///         compute a DEX-spot-derived de-risk floor when the oracle is down (so the
    ///         NAV-based valuation reads 0 yet the position is real).
    /// @return usdyBal Held USDY (18-dec).
    /// @return musdBal Held mUSD (18-dec); 0 when the mUSD leg is disabled.
    function heldRwaBalances() external view returns (uint256 usdyBal, uint256 musdBal);

    /// @notice Convert `usdyAmount` of held USDY into mUSD. Value-neutral; enforces an
    ///         oracle-derived balance-delta minOut (stricter of `minMusdOut`/floor).
    /// @return musdOut mUSD (18-dec) received by the adapter.
    function convertToMusd(uint256 usdyAmount, uint256 minMusdOut)
        external
        returns (uint256 musdOut);

    /// @notice Convert `musdAmount` of held mUSD back into USDY. Value-neutral;
    ///         enforces an oracle-derived balance-delta minOut.
    /// @return usdyOut USDY (18-dec) received by the adapter.
    function convertToUsdy(uint256 musdAmount, uint256 minUsdyOut)
        external
        returns (uint256 usdyOut);
}
