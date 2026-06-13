// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Test } from "forge-std/Test.sol";
import { Guardrails } from "../src/Guardrails.sol";

/**
 * @title MoveCapExemption.t.sol — M2
 * @notice A pure risk-reduction (USDY weight strictly down, every other bucket
 *         non-decreasing) is exempt from the per-rebalance move-size cap, so an
 *         LLM-news de-risk of a >50% USDY position can fully exit. Risk-neutral/
 *         increasing reshuffles past the cap still revert.
 *
 * Uses a default-config Guardrails (maxRebalanceMoveBps = 5000 / 50%).
 */
contract MoveCapExemptionTest is Test {
    Guardrails internal gr;
    address internal admin = makeAddr("admin");

    function setUp() public {
        vm.warp(1_000_000);
        gr = new Guardrails(admin);
    }

    /// totalAssets + full Aave liquidity so the instant-liquidity floor never blocks;
    /// nav/spot are 0 (the USDY-not-increasing paths here skip the depeg guard).
    function _state() internal pure returns (Guardrails.MarketState memory s) {
        s.totalAssets = 100_000e6;
        s.aaveWithdrawable = 100_000e6;
    }

    function test_RiskReducingUsdyExitExemptFromMoveCap() public view {
        // USDY 60% -> 0 into IDLE. Move = 60% > 50% cap, but risk-reducing → ok.
        uint16[4] memory pre = [uint16(4_000), uint16(0), uint16(6_000), uint16(0)];
        uint16[4] memory post = [uint16(10_000), uint16(0), uint16(0), uint16(0)];
        (bool ok, bytes4 reason) = gr.validateRebalance(pre, post, _state());
        assertTrue(ok);
        assertEq(reason, bytes4(0));
    }

    function test_RiskNeutralReshuffleStillCapped() public view {
        // AAVE 90% -> 30%, AUSD 0 -> 60%, USDY flat. Move = 60% > 50%, NOT risk-reducing.
        uint16[4] memory pre = [uint16(1_000), uint16(9_000), uint16(0), uint16(0)];
        uint16[4] memory post = [uint16(1_000), uint16(3_000), uint16(0), uint16(6_000)];
        (bool ok, bytes4 reason) = gr.validateRebalance(pre, post, _state());
        assertFalse(ok);
        assertEq(reason, Guardrails.RebalanceMoveTooLarge.selector);
    }

    function test_UsdyDownButAaveAlsoDown_NotExempt() public view {
        // USDY 20% -> 0 AND AAVE 60% -> 20%, freed into AUSD. USDY is down but AAVE is also
        // selling off (not "only reducing USDY into safe buckets"), so still capped. Keeps
        // IDLE+AAVE above the instant-liquidity floor so the move check is the one that fires.
        uint16[4] memory pre = [uint16(2_000), uint16(6_000), uint16(2_000), uint16(0)];
        uint16[4] memory post = [uint16(2_000), uint16(2_000), uint16(0), uint16(6_000)];
        (bool ok, bytes4 reason) = gr.validateRebalance(pre, post, _state());
        assertFalse(ok);
        assertEq(reason, Guardrails.RebalanceMoveTooLarge.selector);
    }

    function test_SmallUsdyReductionWithinCapStillOk() public view {
        // Sanity: a within-cap USDY trim still passes (exemption didn't break normal path).
        uint16[4] memory pre = [uint16(5_000), uint16(0), uint16(5_000), uint16(0)];
        uint16[4] memory post = [uint16(7_000), uint16(0), uint16(3_000), uint16(0)];
        (bool ok,) = gr.validateRebalance(pre, post, _state());
        assertTrue(ok);
    }
}
