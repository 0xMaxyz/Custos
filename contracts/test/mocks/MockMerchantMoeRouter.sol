// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20}    from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMerchantMoeLBRouter} from "../../src/interfaces/IMerchantMoeRouter.sol";

/**
 * @notice Mock Merchant Moe LB Router for unit tests.
 *
 * Supports arbitrary-precision exchange rates via (numerator, denominator):
 *   amountOut = amountIn * numerator / denominator
 *
 * This handles the 12-decimal gap between 6-dec USDC and 18-dec USDY cleanly:
 *   USDC(6dec)→USDY(18dec): numerator=1e12, denominator=1
 *   USDY(18dec)→USDC(6dec): numerator=1,    denominator=1e12
 *
 * The router must be pre-funded with sufficient tokenOut before each swap.
 */
contract MockMerchantMoeRouter {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256)) public numerator;
    mapping(address => mapping(address => uint256)) public denominator;

    /// When true, swap always returns 0 output (tests minOut enforcement).
    bool public shouldReturnZero;

    constructor() {}

    /**
     * @param tokenIn   Input token.
     * @param tokenOut  Output token.
     * @param num       Numerator of the exchange rate.
     * @param denom     Denominator of the exchange rate.
     *                  amountOut = amountIn * num / denom.
     */
    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 denom) external {
        numerator[tokenIn][tokenOut]   = num;
        denominator[tokenIn][tokenOut] = denom;
    }

    function setShouldReturnZero(bool v) external { shouldReturnZero = v; }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        IMerchantMoeLBRouter.Path memory path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256 amountOut) {
        address tokenIn  = path.tokenPath[0];
        address tokenOut = path.tokenPath[path.tokenPath.length - 1];

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 num  = numerator[tokenIn][tokenOut];
        uint256 denom = denominator[tokenIn][tokenOut];
        if (num == 0)  num  = 1;
        if (denom == 0) denom = 1;

        amountOut = shouldReturnZero ? 0 : (amountIn * num) / denom;
        require(amountOut >= amountOutMin, "MockRouter: amountOut < amountOutMin");

        // Router must be pre-funded with tokenOut by the test.
        IERC20(tokenOut).safeTransfer(to, amountOut);
    }

    /// Not used in unit tests; present to satisfy the interface.
    function getSwapOut(address, uint128, bool) external pure returns (uint128, uint128, uint128) {
        return (0, 0, 0);
    }
}
