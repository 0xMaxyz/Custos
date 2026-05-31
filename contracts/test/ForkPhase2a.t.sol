// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title ForkPhase2a.t.sol — Fork tests for tasks 2.1–2.3 (USDY adapter)
 *
 * Run with a live Mantle fork:
 *   forge test --fork-url $MANTLE_RPC_URL --match-contract ForkPhase2aTest -vv
 *
 * Verifies:
 *   2.1  SwapLib — USDC→USDY exactIn swap respects minOut on Merchant Moe.
 *   2.2  RWADynamicOracle — getPrice() returns plausible NAV; range is fresh.
 *   2.3  UsdyAdapter — deposit (USDC→USDY) + totalAssets oracle value;
 *         withdraw (USDY→USDC) returns ≥ minOut; full rebalance round-trip.
 */

import {Test, console2} from "forge-std/Test.sol";
import {IERC20}         from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Roles}              from "../src/Roles.sol";
import {Guardrails}         from "../src/Guardrails.sol";
import {YieldVault}         from "../src/YieldVault.sol";
import {UsdyAdapter}        from "../src/UsdyAdapter.sol";
import {IUsdyAdapter}       from "../src/interfaces/IUsdyAdapter.sol";
import {IRWADynamicOracle}  from "../src/interfaces/IRWADynamicOracle.sol";
import {IPoolAddressesProvider} from "../src/interfaces/IPoolAddressesProvider.sol";
import {IAaveV3Pool, ReserveData} from "../src/interfaces/IAaveV3Pool.sol";

contract ForkPhase2aTest is Test {
    // ── Mantle mainnet — verified addresses ───────────────────────────────────

    // USDC: verified via Phase 0.3 gate (Fork.t.sol::testAddressesHaveCode)
    address internal constant USDC = 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9;

    // USDY: Ondo Finance — verified via 1delta curated list + Fork.t.sol
    address internal constant USDY = 0x5bE26527e817998A7206475496fDE1E68957c5A6;

    // Merchant Moe LB Router v2: docs.merchantmoe.com / contract-addresses
    address internal constant MM_LB_ROUTER = 0xeaEE7EE68874218c3558b40063c42B82D3E7232a;

    // USDY oracle: resolved dynamically from USDY.oracle() in setUp.
    address internal usdyOracle;

    // ── Test params ───────────────────────────────────────────────────────────

    // Merchant Moe USDC/USDY LBPair: bin step 1, version 2 (LBPair v2.1).
    // Confirmed in Phase 0.4 gate (Fork.t.sol::testLiquidityGateUsdy).
    uint256 constant DEFAULT_BIN_STEP = 1;
    uint8   constant DEFAULT_VERSION  = 2;

    // ── Actors ────────────────────────────────────────────────────────────────

    address internal admin     = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian  = makeAddr("guardian");
    address internal user      = makeAddr("user");

    // ── Contracts ─────────────────────────────────────────────────────────────

    Guardrails    internal gr;
    YieldVault    internal vault;
    UsdyAdapter   internal adapter;

    uint256 constant DEPOSIT = 1_000e6; // $1k USDC

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        // Resolve USDY oracle via USDY.oracle() (Ondo stores oracle as public var).
        (bool ok, bytes memory data) = USDY.staticcall(abi.encodeWithSignature("oracle()"));
        if (ok && data.length == 32) {
            usdyOracle = abi.decode(data, (address));
        }
        require(usdyOracle != address(0), "USDY oracle not resolvable");
        console2.log("[2a] USDY oracle:", usdyOracle);

        gr    = new Guardrails(admin);
        vault = new YieldVault(USDC, admin, address(gr));

        adapter = new UsdyAdapter(
            MM_LB_ROUTER,
            USDC,
            USDY,
            usdyOracle,
            address(vault),
            50,               // maxSlippageBps
            DEFAULT_BIN_STEP,
            DEFAULT_VERSION
        );

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN,  guardian);
        vault.addStrategy(2, address(adapter)); // bucket 2 = USDY
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(2);

        deal(USDC, user, DEPOSIT);
    }

    // ── Task 2.2 — Oracle valuation ───────────────────────────────────────────

    function testForkUsdyOraclePlausibleNav() public view {
        uint256 nav = IRWADynamicOracle(usdyOracle).getPrice();
        // USDY NAV should be between $1.00 and $2.00 (18-dec).
        assertGe(nav, 1e18, "USDY NAV below $1.00");
        assertLe(nav, 2e18, "USDY NAV above $2.00 - unexpected");
        console2.log("[2.2] USDY oracle NAV (18-dec):", nav);

        (uint256 rangeStart, uint256 rangeEnd) = IRWADynamicOracle(usdyOracle).currentRange();
        assertGt(rangeEnd, block.timestamp, "oracle range already expired");
        console2.log("[2.2] oracle rangeStart:", rangeStart);
        console2.log("[2.2] oracle rangeEnd:  ", rangeEnd);
    }

    function testForkAdapterOracleData() public view {
        (uint256 nav, uint64 rangeEnd) = IUsdyAdapter(address(adapter)).oracleData();
        assertGe(nav, 1e18, "nav below $1");
        assertGt(rangeEnd, uint64(block.timestamp), "oracle range expired");
        console2.log("[2.2] adapter.oracleData() nav:", nav);
        console2.log("[2.2] adapter.oracleData() rangeEnd:", rangeEnd);
    }

    // ── Task 2.3 — Deposit (USDC → USDY via Merchant Moe) ────────────────────

    function testForkDepositSwapsUsdcToUsdy() public {
        vm.startPrank(user);
        IERC20(USDC).approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        assertEq(vault.totalAssets(), DEPOSIT);

        // Rebalance: 50% idle, 50% USDY.
        uint16[4] memory target; target[0] = 5_000; target[2] = 5_000;
        bytes[] memory sd = new bytes[](4);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://fork-phase2a-deposit", bytes32(0));

        uint256 usdyBal = IERC20(USDY).balanceOf(address(adapter));
        assertGt(usdyBal, 0, "adapter should hold USDY after rebalance");
        console2.log("[2.3] USDY in adapter after deposit rebalance:", usdyBal);

        // totalAssets via oracle should be close to DEPOSIT/2 (half was swapped).
        uint256 adapterValue = adapter.totalAssets();
        assertApproxEqAbs(adapterValue, DEPOSIT / 2, DEPOSIT / 50); // ±2%
        console2.log("[2.3] adapter.totalAssets():", adapterValue);
    }

    // ── Task 2.3 — Withdraw (USDY → USDC) ────────────────────────────────────

    function testForkDepositAndFullWithdraw() public {
        vm.startPrank(user);
        IERC20(USDC).approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        // Rebalance into USDY.
        uint16[4] memory target; target[0] = 5_000; target[2] = 5_000;
        bytes[] memory sd = new bytes[](4);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://fork-phase2a-wd-1", bytes32(0));

        // Warp 30 days to simulate USDY NAV growth.
        vm.warp(block.timestamp + 30 days);

        uint256 adapterAfterWarp = adapter.totalAssets();
        console2.log("[2.3] adapter.totalAssets() after 30d warp:", adapterAfterWarp);

        // Full redeem.
        uint256 shares = vault.balanceOf(user);
        uint256 balBefore = IERC20(USDC).balanceOf(user);
        vm.startPrank(user);
        vault.redeem(shares, user, user);
        vm.stopPrank();

        uint256 received = IERC20(USDC).balanceOf(user) - balBefore;
        console2.log("[2.3] USDC received on full redeem:", received);
        // Allow 1% slippage from DEPOSIT.
        assertGe(received, DEPOSIT * 99 / 100, "received less than 99% of principal");
    }

    // ── Task 2.3 — maxWithdrawable ────────────────────────────────────────────

    function testForkMaxWithdrawableLeToTotalAssets() public {
        vm.startPrank(user);
        IERC20(USDC).approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        uint16[4] memory target; target[0] = 5_000; target[2] = 5_000;
        bytes[] memory sd = new bytes[](4);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://fork-phase2a-mw", bytes32(0));

        uint256 mw = adapter.maxWithdrawable();
        uint256 ta = adapter.totalAssets();
        assertEq(mw, ta, "maxWithdrawable should equal totalAssets in Phase 2a");
        console2.log("[2.3] maxWithdrawable:", mw, "totalAssets:", ta);
    }
}
