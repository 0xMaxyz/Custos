// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20}    from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @notice Mock DEX aggregator router for unit tests. Stands in for the pinned
 *         Odos-style router the UsdyAdapter executes calldata against.
 *
 * Tests build `swapData` as `abi.encodeCall(MockAggregatorRouter.swap, (...))` and
 * pass it through the adapter. The adapter pre-approves this router, so `swap`
 * pulls `tokenIn` from the caller (the adapter) and pays `tokenOut` to `to`.
 *
 * Exchange rate via (numerator, denominator): amountOut = amountIn * num / denom,
 * matching the 12-decimal USDC↔USDY gap. Must be pre-funded with `tokenOut`.
 */
contract MockAggregatorRouter {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256)) public numerator;
    mapping(address => mapping(address => uint256)) public denominator;

    /// When true, the swap underpays (returns half) to exercise the minOut revert.
    bool public shouldUnderpay;

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 denom) external {
        numerator[tokenIn][tokenOut]   = num;
        denominator[tokenIn][tokenOut] = denom;
    }

    function setShouldUnderpay(bool v) external { shouldUnderpay = v; }

    /**
     * @param tokenIn   Token pulled from the caller.
     * @param tokenOut  Token paid to `to`.
     * @param amountIn  Exact tokenIn to pull.
     * @param to        Recipient of tokenOut (the adapter, for balance-delta checks).
     */
    function swap(address tokenIn, address tokenOut, uint256 amountIn, address to)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 num   = numerator[tokenIn][tokenOut];
        uint256 denom = denominator[tokenIn][tokenOut];
        if (num == 0)   num = 1;
        if (denom == 0) denom = 1;

        amountOut = (amountIn * num) / denom;
        if (shouldUnderpay) amountOut /= 2;

        IERC20(tokenOut).safeTransfer(to, amountOut);
    }
}
