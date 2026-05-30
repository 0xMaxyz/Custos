// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal interface for Merchant Moe (Trader Joe v2.1 fork) LB Router on Mantle.
interface IMerchantMoeLBRouter {
    struct Path {
        uint256[] pairBinSteps;
        uint8[] versions;
        address[] tokenPath;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Path memory path,
        address to,
        uint256 deadline
    ) external returns (uint256 amountOut);

    function getSwapOut(address pair, uint128 amountIn, bool swapForY)
        external
        view
        returns (uint128 amountInLeft, uint128 amountOut, uint128 fee);
}
