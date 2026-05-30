// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title ForkPhase1b.t.sol — Fork tests for task 1.5 (AaveV3Adapter on Mantle)
 *
 * Run with a live Mantle fork:
 *   forge test --fork-url $MANTLE_RPC_URL --match-contract ForkPhase1bTest -vv
 *
 * Verifies:
 *   - AaveV3Adapter can supply USDC to Aave v3 on Mantle.
 *   - aUSDC balance grows after vm.warp (interest accrual).
 *   - Full withdraw returns >= principal (no loss).
 *   - maxWithdrawable() respects pool liquidity.
 */

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Roles}           from "../src/Roles.sol";
import {Guardrails}      from "../src/Guardrails.sol";
import {YieldVault}      from "../src/YieldVault.sol";
import {AaveV3Adapter}   from "../src/AaveV3Adapter.sol";
import {IPoolAddressesProvider} from "../src/interfaces/IPoolAddressesProvider.sol";
import {IAaveV3Pool, ReserveData} from "../src/interfaces/IAaveV3Pool.sol";

contract ForkPhase1bTest is Test {
    // ── Mantle mainnet addresses ──────────────────────────────────────────────

    address internal constant USDC = 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9;
    address internal constant AAVE_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;

    // ── Actors ────────────────────────────────────────────────────────────────

    address internal admin     = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian  = makeAddr("guardian");
    address internal user      = makeAddr("user");

    // ── Contracts ─────────────────────────────────────────────────────────────

    address internal aavePool;
    address internal aUsdc;
    AaveV3Adapter  internal adapter;
    Guardrails     internal gr;
    YieldVault     internal vault;

    uint256 constant DEPOSIT = 1_000e6; // $1k USDC

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        // Resolve Aave addresses from on-chain provider.
        IPoolAddressesProvider provider = IPoolAddressesProvider(AAVE_ADDRESSES_PROVIDER);
        aavePool = provider.getPool();
        ReserveData memory rd = IAaveV3Pool(aavePool).getReserveData(USDC);
        aUsdc = rd.aTokenAddress;
        console2.log("[1.5] Aave Pool:", aavePool);
        console2.log("[1.5] aUSDC:    ", aUsdc);
        assertTrue(aUsdc != address(0), "aUSDC not resolved");

        // Deploy vault stack.
        gr    = new Guardrails(admin);
        vault = new YieldVault(USDC, admin, address(gr));
        adapter = new AaveV3Adapter(aavePool, USDC, aUsdc, address(vault));

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN,  guardian);

        // Queue + activate Aave adapter (bucket 1) with warp.
        vault.addStrategy(1, address(adapter));
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(1);

        // Give user $1k USDC via deal().
        deal(USDC, user, DEPOSIT);
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    function testForkAaveDepositAndWithdraw() public {
        // 1. Deposit into vault.
        vm.startPrank(user);
        IERC20(USDC).approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        assertEq(vault.totalAssets(), DEPOSIT);

        // 2. Rebalance: 20% idle (minIdle=2%, use 20% for safety), 80% Aave.
        //    Move from 100% idle: delta = 80%, which exceeds maxRebalanceMoveBps=50%.
        //    Use 50% idle -> 50% Aave instead (right at cap).
        uint16[4] memory target; target[0] = 5_000; target[1] = 5_000;
        bytes[] memory sd = new bytes[](4);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://fork-test", bytes32(0));

        uint256 aUsdcBal = IERC20(aUsdc).balanceOf(address(adapter));
        assertApproxEqAbs(aUsdcBal, DEPOSIT / 2, 1e6); // ~$500 in Aave
        console2.log("[1.5] aUSDC balance after supply:", aUsdcBal);

        // 3. Warp 30 days to accrue interest.
        vm.warp(block.timestamp + 30 days);

        uint256 aUsdcAfterWarp = IERC20(aUsdc).balanceOf(address(adapter));
        console2.log("[1.5] aUSDC balance after 30d warp:", aUsdcAfterWarp);
        assertGe(aUsdcAfterWarp, aUsdcBal, "aUSDC should not decrease");

        // 4. Full withdraw via vault redeem.
        uint256 shares = vault.balanceOf(user);
        uint256 balBefore = IERC20(USDC).balanceOf(user);
        vm.startPrank(user);
        vault.redeem(shares, user, user);
        vm.stopPrank();

        uint256 received = IERC20(USDC).balanceOf(user) - balBefore;
        console2.log("[1.5] USDC received on full redeem:", received);
        assertGe(received, DEPOSIT, "received less than principal");
    }

    function testForkMaxWithdrawableRespoolLiquidity() public {
        deal(USDC, user, DEPOSIT);
        vm.startPrank(user);
        IERC20(USDC).approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        uint16[4] memory target; target[0] = 5_000; target[1] = 5_000;
        bytes[] memory sd = new bytes[](4);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://fork-test-2", bytes32(0));

        uint256 mw = adapter.maxWithdrawable();
        uint256 ta = adapter.totalAssets();
        // maxWithdrawable <= totalAssets (can't withdraw more than we hold)
        assertLe(mw, ta);
        // Aave USDC pool is deep; maxWithdrawable should equal totalAssets for small amounts
        assertApproxEqAbs(mw, ta, 1e6);
        console2.log("[1.5] maxWithdrawable:", mw);
        console2.log("[1.5] totalAssets:    ", ta);
    }
}
