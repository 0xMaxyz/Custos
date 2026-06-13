// SPDX-License-Identifier: MIT
// Custos — AI risk-guardian real-yield account on Mantle.
pragma solidity 0.8.28;

/// @notice Ondo USDY on-chain price oracle — returns NAV per token scaled to 18 dec.
interface IRWADynamicOracle {
    /// @return price USDY NAV in USD, 18-decimal fixed-point.
    function getPrice() external view returns (uint256 price);

    /// @return rangeStartTime Unix timestamp when the current price range begins.
    /// @return rangeEndTime   Unix timestamp when the current price range expires.
    function currentRange() external view returns (uint256 rangeStartTime, uint256 rangeEndTime);
}
