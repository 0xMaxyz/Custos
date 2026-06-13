// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title ForkPhase2d.t.sol — Fork tests for task 2.7 (mUSD converter leg)
 *
 * Run with a live Mantle fork:
 *   forge test --fork-url $MANTLE_RPC_URL --match-contract ForkPhase2dTest -vv
 *
 * Verifies on-chain what the off-chain docs claim (Ondo "Mantle integration
 * guidelines" + addresses page), so the adapter is wired to real, verified state —
 * NOT guessed (ROADMAP 2.7 / Phase 0.3 gate):
 *   - mUSD has code, 18 decimals, and is the wrap/unwrap "Ondo Token Converter".
 *   - mUSD.usdy()   == the USDY we hold (the converter pairs the right tokens).
 *   - mUSD.oracle() == the RWADynamicOracle USDY accounting uses (shared pricing).
 *   - A real USDY → mUSD → USDY round-trip through the adapter is value-neutral
 *     (totalAssets stable; USDY restored), proving wrap/unwrap behave as modeled.
 */

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Roles } from "../src/Roles.sol";
import { Guardrails } from "../src/Guardrails.sol";
import { YieldVault } from "../src/YieldVault.sol";
import { UsdyAdapter } from "../src/UsdyAdapter.sol";
import { IMusd } from "../src/interfaces/IMusd.sol";
import { IRWADynamicOracle } from "../src/interfaces/IRWADynamicOracle.sol";

contract ForkPhase2dTest is Test {
    // ── Mantle mainnet — verified addresses ───────────────────────────────────

    address internal constant USDC = 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9;
    address internal constant USDY = 0x5bE26527e817998A7206475496fDE1E68957c5A6;
    address internal constant MUSD = 0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3;
    address internal constant USDY_ORACLE = 0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f;
    address internal constant ONEDELTA_EXECUTOR = 0x5C019a146758287C614FE654CaEC1ba1CaF05F4E;

    address internal admin = makeAddr("admin");
    address internal allocator = makeAddr("allocator");

    Guardrails internal gr;
    YieldVault internal vault;
    UsdyAdapter internal adapter;

    function setUp() public {
        // mUSD must have code at the documented address before anything else.
        uint256 sz;
        assembly { sz := extcodesize(MUSD) }
        require(sz > 0, "mUSD has no code at documented address");

        gr = new Guardrails(admin);
        vault = new YieldVault(USDC, admin, address(gr));
        adapter =
            new UsdyAdapter(ONEDELTA_EXECUTOR, USDC, USDY, MUSD, USDY_ORACLE, address(vault), 50);

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.addStrategy(2, address(adapter));
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(2);
    }

    // ── mUSD converter wiring (verify, don't guess) ───────────────────────────

    function testForkMusdWiring() public view {
        assertEq(IMusd(MUSD).usdy(), USDY, "mUSD.usdy() must be our USDY");
        assertEq(IMusd(MUSD).oracle(), USDY_ORACLE, "mUSD.oracle() must be the RWADynamicOracle");

        (bool ok, bytes memory data) = MUSD.staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok && data.length == 32, "mUSD.decimals() must return");
        assertEq(abi.decode(data, (uint8)), 18, "mUSD must be 18 decimals");

        console2.log("[2.7] mUSD.usdy()   =", IMusd(MUSD).usdy());
        console2.log("[2.7] mUSD.oracle() =", IMusd(MUSD).oracle());
        console2.log("[2.7] oracle NAV    =", IRWADynamicOracle(USDY_ORACLE).getPrice());
    }

    function testForkAdapterExposesMusd() public view {
        assertEq(adapter.MUSD(), MUSD, "adapter must pin the verified mUSD");
        assertEq(adapter.totalAssets(), 0, "empty adapter values at 0");
    }

    // ── Live wrap/unwrap round-trip is value-neutral ──────────────────────────

    /// @notice Real USDY → mUSD → USDY through the adapter on a Mantle fork. Proves
    ///         the converter behaves as modeled (oracle-priced, value-neutral) and
    ///         that `totalAssets()` is conserved across the conversion.
    function testForkConvertRoundTripIsValueNeutral() public {
        uint256 amount = 100e18; // 100 USDY
        // Fund the adapter with real USDY (StdCheats finds USDY's balance slot).
        deal(USDY, address(adapter), amount, true);
        assertEq(IERC20(USDY).balanceOf(address(adapter)), amount, "USDY funded");

        uint256 taStart = adapter.totalAssets();
        assertGt(taStart, 0, "USDY position should value > 0");

        // USDY -> mUSD
        vm.prank(address(vault));
        uint256 musdOut = adapter.convertToMusd(amount, 0);
        assertGt(musdOut, 0, "received mUSD");
        assertEq(IERC20(USDY).balanceOf(address(adapter)), 0, "USDY fully wrapped");
        assertApproxEqAbs(
            adapter.totalAssets(), taStart, 1e6, "totalAssets stable across wrap (<=$1)"
        );
        console2.log("[2.7] wrapped 100 USDY -> mUSD:", musdOut);

        // mUSD -> USDY
        vm.prank(address(vault));
        uint256 usdyOut = adapter.convertToUsdy(musdOut, 0);
        assertApproxEqRel(usdyOut, amount, 1e15, "USDY restored within 0.1%");
        assertApproxEqAbs(
            adapter.totalAssets(), taStart, 1e6, "totalAssets stable across full round-trip"
        );
        console2.log("[2.7] unwrapped mUSD -> USDY:", usdyOut);
    }
}
