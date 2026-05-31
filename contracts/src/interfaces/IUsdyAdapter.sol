// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IStrategyAdapter} from "./IStrategyAdapter.sol";

/**
 * @title IUsdyAdapter
 * @notice Extends IStrategyAdapter with oracle data access so YieldVault can
 *         populate Guardrails.MarketState without holding a direct oracle reference.
 */
interface IUsdyAdapter is IStrategyAdapter {
    /**
     * @notice Current USDY oracle values.
     * @return nav      Oracle NAV — 18-decimal USDC per USDY (e.g. 1.0832e18).
     * @return rangeEnd Unix timestamp when the current oracle price range expires.
     *                  Past this timestamp the NAV is considered stale.
     */
    function oracleData() external view returns (uint256 nav, uint64 rangeEnd);
}
