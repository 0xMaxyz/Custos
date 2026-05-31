// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20}    from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMerchantMoeLBRouter} from "./interfaces/IMerchantMoeRouter.sol";

/**
 * @title SwapLib
 * @notice Minimal exactIn swap wrapper for the Merchant Moe LB Router on Mantle.
 *
 * Callers must approve `router` to spend `tokenIn` before calling exactIn.
 * `swapData` = abi.encode(uint256[] pairBinSteps, uint8[] versions). Empty = use
 * the caller-supplied defaults.
 *
 * Phase 2a: single-path exactIn only. Multi-hop paths encoded via pairBinSteps
 * length > 1 and a matching tokenPath built by the caller.
 */
library SwapLib {
    using SafeERC20 for IERC20;

    /// @dev 5-minute deadline buffer; long enough for normal block times on Mantle.
    uint256 private constant DEADLINE_BUFFER = 300;

    /**
     * @notice Execute an exactIn swap on Merchant Moe.
     * @param router       Merchant Moe LB Router address.
     * @param tokenIn      Token to sell.
     * @param tokenOut     Token to buy.
     * @param amountIn     Exact amount of tokenIn to sell.
     * @param minAmountOut Minimum tokenOut to receive (reverts on shortfall).
     * @param to           Recipient of tokenOut.
     * @param pairBinSteps Bin step(s) for each hop (e.g. [1] for a single 0.01% pool).
     * @param versions     Router version(s) for each hop (2 = LBPair v2.1).
     * @return amountOut   Actual tokenOut received.
     */
    function exactIn(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256[] memory pairBinSteps,
        uint8[]   memory versions
    ) internal returns (uint256 amountOut) {
        address[] memory tokenPath = new address[](pairBinSteps.length + 1);
        tokenPath[0] = tokenIn;
        tokenPath[pairBinSteps.length] = tokenOut;
        // For multi-hop paths the caller must supply intermediate tokens via a
        // custom swapData decoder; the 2-token path here covers the 1-hop case.

        IMerchantMoeLBRouter.Path memory path = IMerchantMoeLBRouter.Path({
            pairBinSteps: pairBinSteps,
            versions:     versions,
            tokenPath:    tokenPath
        });

        amountOut = IMerchantMoeLBRouter(router).swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            path,
            to,
            block.timestamp + DEADLINE_BUFFER
        );
    }
}
