// SPDX-License-Identifier: MIT
// Custos — AI risk-guardian real-yield account on Mantle.
pragma solidity 0.8.35;

/// @title IStrategyAdapter
/// @notice Interface every strategy adapter (Aave, USDY, AUSD) must implement.
///         All `usdcValue` returns are denominated in 6-decimal USDC.
interface IStrategyAdapter {
    /// @notice Underlying yield token held by this adapter (e.g. aUSDC, USDY, AUSD).
    function underlying() external view returns (address);

    /// @notice Adapter value in USDC terms (oracle/aToken-based; never a DEX mark for accounting).
    function totalAssets() external view returns (uint256 usdcValue);

    /// @notice USDC amount currently withdrawable right now (liquidity-aware).
    function maxWithdrawable() external view returns (uint256 usdcValue);

    /// @notice Whether the adapter still holds any underlying tokens, independent of
    ///         valuation. Used by the vault to gate strategy removal so a position is
    ///         never orphaned by a `totalAssets()` that reads 0 during an oracle outage.
    function hasAssets() external view returns (bool);

    /// @notice Deploy `usdcAmount` of USDC from the vault into the strategy.
    /// @param swapData Optional route hint (e.g. from 1delta); on-chain minOut enforced.
    /// @return deployedUsdcValue Estimated USDC value deployed (oracle-denominated).
    function deposit(uint256 usdcAmount, bytes calldata swapData)
        external
        returns (uint256 deployedUsdcValue);

    /// @notice Withdraw up to `usdcAmount` USDC, sending USDC to `to`.
    /// @param usdcAmount Target USDC amount to withdraw.
    /// @param minOutUsdc On-chain minimum acceptable USDC received (slippage guard).
    /// @param to         Recipient of the withdrawn USDC.
    /// @param swapData   Optional route hint; minOut still enforced on-chain.
    /// @return withdrawnUsdc Actual USDC delivered to `to`.
    function withdraw(uint256 usdcAmount, uint256 minOutUsdc, address to, bytes calldata swapData)
        external
        returns (uint256 withdrawnUsdc);

    /// @notice Unwind all holdings to USDC and send to `to`. Used by kill/de-risk.
    /// @param minOutUsdc Minimum acceptable total USDC received.
    /// @param to         Recipient of the withdrawn USDC.
    /// @param swapData   Optional route hint.
    /// @return withdrawnUsdc Actual USDC delivered to `to`.
    function emergencyWithdrawAll(uint256 minOutUsdc, address to, bytes calldata swapData)
        external
        returns (uint256 withdrawnUsdc);
}
