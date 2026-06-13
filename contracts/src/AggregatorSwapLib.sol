// SPDX-License-Identifier: MIT
// Custos — AI risk-guardian real-yield account on Mantle.
pragma solidity 0.8.35;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title AggregatorSwapLib
 * @notice Executes a swap through a SINGLE pinned, allow-listed router (the 1delta
 *         swap executor on Mantle) and enforces slippage with an on-chain
 *         **balance-delta** check the caller computed itself.
 *
 * Why route through an aggregator at all (and why this is still safe):
 * - USDY liquidity on Mantle is fragmented across thin pools (Agni USDY/USDT,
 *   iZiSwap USDY/USDC, Butter USDY/USDC — together ~$1.5k). No single router has
 *   a usable direct USDC/USDY route. 1delta's executor splits across them.
 * - The "never execute arbitrary third-party calldata" rule is preserved by
 *   three constraints, all enforced here / by the adapter:
 *     1. **Pinned router** — `router` is an immutable, allow-listed address set
 *        at deploy time. Calldata can only ever target that one venue.
 *     2. **Balance-delta minOut** — we never trust the router's return value or
 *        the `minOut` embedded in its calldata. We measure the actual `tokenOut`
 *        received by `address(this)` and revert if it is below the `minOut` the
 *        adapter derived from the Ondo oracle NAV.
 *     3. **Self-custody recipient** — output must land on the adapter
 *        (`address(this)`). If the calldata pays anyone else, the measured delta
 *        is 0 and the swap reverts (fail-closed).
 *
 * The off-chain agent obtains `routerData` from 1delta's `/actions/swap` endpoint
 * (which itself aggregates Odos/Eisen/Nordstern/…). That is "data + optional swap
 * routing" — the permitted lane. The `to` address it targets must equal the pinned
 * `router` (the 1delta executor) or the call reverts, and the quote must be built
 * with `account = address(this)` so the executor pays this adapter.
 */
library AggregatorSwapLib {
    using SafeERC20 for IERC20;

    error EmptySwapData();
    error AggregatorCallReverted();
    error InsufficientOutput(uint256 received, uint256 minOut);

    /**
     * @notice Run `routerData` against `router` and verify the realized output.
     * @param router    Pinned, allow-listed aggregator router (immutable in adapter).
     * @param tokenOut  Token whose received balance is measured on `address(this)`.
     * @param minOut    Minimum acceptable `tokenOut` received (adapter-derived, oracle-based).
     * @param routerData Aggregator swap calldata from the off-chain quote (1delta).
     * @return received Actual `tokenOut` gained by `address(this)`.
     */
    function swap(address router, address tokenOut, uint256 minOut, bytes calldata routerData)
        internal
        returns (uint256 received)
    {
        if (routerData.length == 0) revert EmptySwapData();

        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));

        // Single pinned router; output verified by balance delta below — the
        // router's own return data is intentionally ignored.
        (bool ok,) = router.call(routerData);
        if (!ok) revert AggregatorCallReverted();

        uint256 balAfter = IERC20(tokenOut).balanceOf(address(this));
        received = balAfter - balBefore;
        if (received < minOut) revert InsufficientOutput(received, minOut);
    }
}
