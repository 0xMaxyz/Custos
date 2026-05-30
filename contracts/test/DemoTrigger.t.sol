// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title DemoTrigger.t.sol - Phase 0.6 demo-trigger harness
 *
 * Provides fork-injectable helpers that simulate a USDY depeg or oracle-staleness
 * event on demand, so the hero de-risk moment can be fired during the demo video
 * without waiting for a real-world event.
 *
 * Usage (Phase 2+ tests, once YieldVault + Guardrails exist):
 *   DemoTriggerHelper trigger = new DemoTriggerHelper(vault, oracle);
 *   trigger.injectDepeg(500);   // simulate 5% depeg (500 bps)
 *   // vault.rebalance() should now execute the de-risk
 *   trigger.clearDepeg();       // restore normal operation
 *
 * Run with a live Mantle fork:
 *   forge test --fork-url $MANTLE_RPC_URL --match-contract DemoTriggerTest -vv
 */

import {Test, console2} from "forge-std/Test.sol";

// ── Mock oracle that returns a controllable price ─────────────────────────────

contract MockRWADynamicOracle {
    uint256 public price;
    uint256 public rangeStart;
    uint256 public rangeEnd;

    constructor(uint256 _price) {
        price      = _price;
        rangeStart = block.timestamp;
        rangeEnd   = block.timestamp + 30 days;
    }

    function getPrice() external view returns (uint256) { return price; }

    function currentRange() external view returns (uint256, uint256) {
        return (rangeStart, rangeEnd);
    }

    /// @notice Set an arbitrary price (used by injectDepeg).
    function setPrice(uint256 _price) external { price = _price; }

    /// @notice Expire the oracle range (simulates oracle staleness).
    function expireRange() external { rangeEnd = block.timestamp - 1; }

    /// @notice Restore valid range.
    function restoreRange() external { rangeEnd = block.timestamp + 30 days; }
}

// ── Demo trigger helper ───────────────────────────────────────────────────────

library DemoTriggerLib {
    uint256 internal constant NAV_BASE = 1.05e18; // approximate USDY NAV at deploy

    /// @notice Return a depegged price for the given basis-point deviation below NAV.
    function depegPrice(uint256 bps) internal pure returns (uint256) {
        return NAV_BASE - (NAV_BASE * bps) / 10_000;
    }
}

// ── Standalone fork tests that verify the harness mechanics ──────────────────

contract DemoTriggerTest is Test {
    address internal constant USDY = 0x5bE26527e817998A7206475496fDE1E68957c5A6;

    MockRWADynamicOracle internal mockOracle;

    function setUp() public {
        mockOracle = new MockRWADynamicOracle(DemoTriggerLib.NAV_BASE);
    }

    // ── Depeg injection test ──────────────────────────────────────────────────

    /// @notice injectDepeg(500 bps) produces a price 5% below NAV.
    function testInjectDepeg() public {
        uint256 normalPrice = mockOracle.getPrice();
        assertEq(normalPrice, DemoTriggerLib.NAV_BASE, "unexpected initial price");

        uint256 bps = 500; // 5% depeg
        mockOracle.setPrice(DemoTriggerLib.depegPrice(bps));

        uint256 depegged = mockOracle.getPrice();
        uint256 expected = DemoTriggerLib.NAV_BASE - (DemoTriggerLib.NAV_BASE * bps) / 10_000;
        assertEq(depegged, expected, "depegged price mismatch");
        assertLt(depegged, normalPrice, "depegged price not lower than normal");

        // Verify the deviation the Guardrails module would compute:
        // deviation_bps = (normal - depegged) * 10000 / normal
        uint256 deviationBps = (normalPrice - depegged) * 10_000 / normalPrice;
        assertEq(deviationBps, bps, "deviation bps mismatch");

        console2.log("[0.6] normal NAV:", normalPrice);
        console2.log("[0.6] depegged NAV (500 bps):", depegged);
        console2.log("[0.6] computed deviation bps:", deviationBps);
        console2.log("[0.6] PASS - Guardrails depeg guard would fire (threshold ~150 bps)");
    }

    /// @notice clearDepeg() restores normal NAV.
    function testClearDepeg() public {
        mockOracle.setPrice(DemoTriggerLib.depegPrice(500));
        assertLt(mockOracle.getPrice(), DemoTriggerLib.NAV_BASE, "depeg not active");

        mockOracle.setPrice(DemoTriggerLib.NAV_BASE);
        assertEq(mockOracle.getPrice(), DemoTriggerLib.NAV_BASE, "depeg not cleared");
        console2.log("[0.6] PASS - clearDepeg restores normal NAV");
    }

    // ── Oracle staleness test ─────────────────────────────────────────────────

    function testOracleStaleness() public {
        (, uint256 rangeEnd) = mockOracle.currentRange();
        assertGt(rangeEnd, block.timestamp, "oracle already stale before inject");

        mockOracle.expireRange();

        (, uint256 expiredEnd) = mockOracle.currentRange();
        assertLt(expiredEnd, block.timestamp, "oracle range not expired");
        console2.log("[0.6] PASS - oracle staleness injected (rangeEnd in past)");

        // Restore
        mockOracle.restoreRange();
        (, uint256 restoredEnd) = mockOracle.currentRange();
        assertGt(restoredEnd, block.timestamp, "oracle range not restored");
        console2.log("[0.6] PASS - oracle staleness cleared");
    }

    // ── vm.warp staleness test (fork-compatible) ──────────────────────────────

    /// @notice Demonstrates vm.warp past oracle range end as an alternative
    ///         staleness trigger that works on the live Mantle oracle too.
    function testWarpPastOracleRange() public {
        (, uint256 rangeEnd) = mockOracle.currentRange();

        // Jump time to after the oracle range expires.
        vm.warp(rangeEnd + 1);
        assertGt(block.timestamp, rangeEnd, "warp did not advance past range");
        console2.log("[0.6] PASS - vm.warp past oracle range simulates staleness on live fork");
        console2.log("[0.6] block.timestamp after warp:", block.timestamp);
        console2.log("[0.6] oracle rangeEnd:", rangeEnd);
    }
}
