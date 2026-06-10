// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Roles } from "../src/Roles.sol";
import { Guardrails } from "../src/Guardrails.sol";
import { YieldVault } from "../src/YieldVault.sol";
import { UsdyAdapter } from "../src/UsdyAdapter.sol";
import { AgentBenchmark } from "../src/AgentBenchmark.sol";

import { ERC20Mock } from "./Phase2a.t.sol";
import { MockRWADynamicOracle } from "./mocks/MockRWADynamicOracle.sol";
import { MockAggregatorRouter } from "./mocks/MockAggregatorRouter.sol";

/**
 * @title SecurityFixes.t.sol
 * @notice Focused regression tests for three review findings:
 *   M5 — timelock floor (MIN_TIMELOCK) + cancelConfig.
 *   M4 — allocator can de-risk during an oracle outage.
 *   H4 — admin handoff: deployer hands off DEFAULT_ADMIN_ROLE + ADMIN then renounces.
 */
contract SecurityFixesTest is Test {
    // ── Actors ──────────────────────────────────────────────────────────────
    address internal admin = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian = makeAddr("guardian");
    address internal user = makeAddr("user");
    address internal newAdmin = makeAddr("newAdmin");

    // ── Contracts ───────────────────────────────────────────────────────────
    ERC20Mock internal usdc;
    ERC20Mock internal usdy;
    MockRWADynamicOracle internal oracle;
    MockAggregatorRouter internal router;
    Guardrails internal gr;
    YieldVault internal vault;
    UsdyAdapter internal adapter;
    AgentBenchmark internal benchmark;

    // ── Constants ───────────────────────────────────────────────────────────
    uint256 constant NAV = 1e18; // 1:1 oracle price
    uint256 constant ORACLE_END = type(uint32).max; // never stale in tests
    uint256 constant DEPOSIT = 1_000e6; // $1k USDC
    uint256 constant USDY_EQUIV = 1_000e18;

    function setUp() public {
        vm.warp(100_000);

        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        usdy = new ERC20Mock("USDY", "USDY", 18);
        oracle = new MockRWADynamicOracle(NAV, ORACLE_END);
        router = new MockAggregatorRouter();
        router.setRate(address(usdc), address(usdy), 1e12, 1);
        router.setRate(address(usdy), address(usdc), 1, 1e12);

        gr = new Guardrails(admin);
        vault = new YieldVault(address(usdc), admin, address(gr));
        benchmark = new AgentBenchmark(address(vault), admin);

        adapter = new UsdyAdapter(
            address(router),
            address(usdc),
            address(usdy),
            address(0), // USDY-only (no mUSD leg)
            address(oracle),
            address(vault),
            50
        );

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN, guardian);
        vault.addStrategy(2, address(adapter));
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(2);

        usdc.mint(address(router), 100_000e6);
        usdy.mint(address(router), 100_000e18);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _buyUsdy(uint256 usdcIn) internal view returns (bytes memory) {
        return abi.encodeCall(
            MockAggregatorRouter.swap, (address(usdc), address(usdy), usdcIn, address(adapter))
        );
    }

    function _sellUsdy(uint256 usdyIn) internal view returns (bytes memory) {
        return abi.encodeCall(
            MockAggregatorRouter.swap, (address(usdy), address(usdc), usdyIn, address(adapter))
        );
    }

    /// Deposit + rebalance 50% into USDY so the bucket holds a real position.
    function _seedUsdyBucket() internal returns (uint256 usdyHeld) {
        usdc.mint(user, DEPOSIT);
        vm.startPrank(user);
        usdc.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 hours);
        uint16[4] memory target;
        target[0] = 5_000;
        target[2] = 5_000;
        bytes[] memory sd = new bytes[](4);
        sd[2] = _buyUsdy(DEPOSIT / 2);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://seed", bytes32(0), NAV);

        usdyHeld = usdy.balanceOf(address(adapter));
        assertGt(usdyHeld, 0);
    }

    // ── M5 — timelock floor + cancelConfig ──────────────────────────────────

    function test_M5_QueueConfigRevertsBelowMinTimelock() public {
        // Seal the bootstrap config first.
        Guardrails.Config memory sealCfg = gr.config();
        vm.prank(admin);
        gr.setConfig(sealCfg);

        // Queue a config whose timelock is below the floor → revert.
        Guardrails.Config memory bad = gr.config();
        bad.addStrategyTimelock = uint32(gr.MIN_TIMELOCK()) - 1;
        vm.prank(admin);
        vm.expectRevert(Guardrails.TimelockBelowMinimum.selector);
        gr.queueConfig(bad);
    }

    function test_M5_SetConfigRevertsBelowMinTimelock() public {
        // The one-shot bootstrap is validated too: cannot bootstrap below the floor.
        Guardrails.Config memory bad = gr.config();
        bad.addStrategyTimelock = 0;
        vm.prank(admin);
        vm.expectRevert(Guardrails.TimelockBelowMinimum.selector);
        gr.setConfig(bad);
    }

    function test_M5_QueueConfigAtMinTimelockSucceeds() public {
        Guardrails.Config memory sealCfg = gr.config();
        vm.prank(admin);
        gr.setConfig(sealCfg);

        Guardrails.Config memory ok = gr.config();
        ok.addStrategyTimelock = uint32(gr.MIN_TIMELOCK()); // exactly at the floor
        vm.prank(admin);
        gr.queueConfig(ok);
        (, bool exists,) = gr.pendingConfig();
        assertTrue(exists);
    }

    function test_M5_CancelConfigClearsPending() public {
        Guardrails.Config memory sealCfg = gr.config();
        vm.prank(admin);
        gr.setConfig(sealCfg);

        Guardrails.Config memory next = gr.config();
        next.maxSlippageBps = 90;
        vm.prank(admin);
        gr.queueConfig(next);
        (, bool exists, uint256 unlocksAt) = gr.pendingConfig();
        assertTrue(exists);
        assertGt(unlocksAt, 0);

        // Cancel.
        vm.prank(admin);
        gr.cancelConfig();
        (, bool existsAfter, uint256 unlocksAfter) = gr.pendingConfig();
        assertFalse(existsAfter);
        assertEq(unlocksAfter, 0);

        // Activation now reverts (nothing pending).
        vm.warp(block.timestamp + 3 days);
        vm.prank(admin);
        vm.expectRevert(Guardrails.NoPendingChange.selector);
        gr.activateConfig();
    }

    function test_M5_CancelConfigRevertsWithoutPending() public {
        vm.prank(admin);
        vm.expectRevert(Guardrails.NoPendingChange.selector);
        gr.cancelConfig();
    }

    function test_M5_CancelConfigIsAdminOnly() public {
        Guardrails.Config memory sealCfg = gr.config();
        vm.prank(admin);
        gr.setConfig(sealCfg);
        Guardrails.Config memory next = gr.config();
        next.maxSlippageBps = 90;
        vm.prank(admin);
        gr.queueConfig(next);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        gr.cancelConfig();
    }

    // ── M4 — oracle outage forces de-risk ────────────────────────────────────

    function test_M4_OracleDownForcesDeRiskWhenUsdyExposed() public {
        _seedUsdyBucket();

        // Oracle dies: oracleData() (getPrice) reverts.
        oracle.setShouldRevert(true);

        // evaluateUsdyRisk must now force de-risk (the on-chain path the vault uses).
        Guardrails.MarketState memory s;
        s.oracleDown = true; // mirrors what YieldVault._buildMarketState sets
        (bool blockNew, bool forceDeRisk, uint8 level) = gr.evaluateUsdyRisk(s);
        assertTrue(blockNew);
        assertTrue(forceDeRisk);
        assertEq(level, 2);
    }

    function test_M4_OracleDownNoExposureDoesNotForceDeRisk() public view {
        // No oracleDown flag (vault only sets it when the bucket holds assets) → NORMAL.
        Guardrails.MarketState memory s;
        (, bool forceDeRisk, uint8 level) = gr.evaluateUsdyRisk(s);
        assertFalse(forceDeRisk);
        assertEq(level, 0);
    }

    function test_M4_AllocatorDeRiskSucceedsDuringOracleOutage() public {
        uint256 usdyHeld = _seedUsdyBucket();

        // Oracle dies.
        oracle.setShouldRevert(true);

        // Pre-fix: allocator deRisk reverted DeRiskConditionNotMet (forceDeRisk=false).
        // Now the oracleDown branch forces de-risk, so the allocator can exit. The
        // allocator supplies the DEX spot so the M4 spot-derived floor sizes the minOut.
        bytes[] memory exit = new bytes[](4);
        exit[2] = _sellUsdy(usdyHeld);
        vm.prank(allocator);
        vault.deRisk(0, exit, "oracle-down", bytes32("evidence"), NAV);

        assertEq(usdy.balanceOf(address(adapter)), 0);
        assertGt(usdc.balanceOf(address(vault)), 0);
    }

    function test_M4_AllocatorDeRiskBlockedWhenOracleDownButNoUsdy() public {
        // No USDY position; oracle down. oracleDown is NOT set (no exposure), so the
        // allocator de-risk condition is not met — nothing to protect.
        oracle.setShouldRevert(true);
        bytes[] memory exit = new bytes[](4);
        vm.prank(allocator);
        vm.expectRevert(YieldVault.DeRiskConditionNotMet.selector);
        vault.deRisk(0, exit, "no-exposure", bytes32(0), NAV);
    }

    function test_M4_DeRiskDuringOutageEnforcesSpotFloor() public {
        uint256 usdyHeld = _seedUsdyBucket();
        oracle.setShouldRevert(true);

        // Router underpays badly (half), so realized USDC < spot-derived floor → revert.
        // Floor = usdyHeld(500e18) * spot(1e18) / 1e30 * 99.5% ≈ 497.5e6; realized ≈ 250e6.
        router.setShouldUnderpay(true);
        bytes[] memory exit = new bytes[](4);
        exit[2] = _sellUsdy(usdyHeld);
        vm.prank(allocator);
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput
        vault.deRisk(0, exit, "underpay", bytes32("evidence"), NAV);
    }

    // ── H4 — admin handoff semantics ─────────────────────────────────────────
    // Scripts aren't unit-tested in this repo; this exercises the exact role
    // transfer the Deploy script performs (grant new admin, renounce deployer),
    // proving the resulting authority set is correct.

    function test_H4_AdminHandoffTransfersAndRenounces() public {
        bytes32 defaultAdmin = vault.DEFAULT_ADMIN_ROLE();

        // The deployer here is `admin` (constructor admin). Hand off to newAdmin.
        vm.startPrank(admin);
        vault.grantRole(defaultAdmin, newAdmin);
        vault.grantRole(Roles.ADMIN, newAdmin);
        vault.renounceRole(Roles.ADMIN, admin);
        vault.renounceRole(defaultAdmin, admin);
        vm.stopPrank();

        // New admin holds both roles; old deployer holds neither.
        assertTrue(vault.hasRole(defaultAdmin, newAdmin));
        assertTrue(vault.hasRole(Roles.ADMIN, newAdmin));
        assertFalse(vault.hasRole(defaultAdmin, admin));
        assertFalse(vault.hasRole(Roles.ADMIN, admin));

        // Old deployer can no longer perform an ADMIN action.
        vm.prank(admin);
        vm.expectRevert();
        vault.setBenchmark(address(benchmark));

        // New admin can.
        vm.prank(newAdmin);
        vault.setBenchmark(address(benchmark));
        assertEq(address(vault.benchmark()), address(benchmark));
    }

    function test_H4_HandoffAcrossAllThreeContracts() public {
        bytes32 da = gr.DEFAULT_ADMIN_ROLE();

        vm.startPrank(admin);
        // Guardrails
        gr.grantRole(da, newAdmin);
        gr.grantRole(Roles.ADMIN, newAdmin);
        gr.renounceRole(Roles.ADMIN, admin);
        gr.renounceRole(da, admin);
        // Vault
        vault.grantRole(da, newAdmin);
        vault.grantRole(Roles.ADMIN, newAdmin);
        vault.renounceRole(Roles.ADMIN, admin);
        vault.renounceRole(da, admin);
        // Benchmark
        benchmark.grantRole(da, newAdmin);
        benchmark.grantRole(Roles.ADMIN, newAdmin);
        benchmark.renounceRole(Roles.ADMIN, admin);
        benchmark.renounceRole(da, admin);
        vm.stopPrank();

        for (uint256 i = 0; i < 3; i++) {
            address c = i == 0 ? address(gr) : i == 1 ? address(vault) : address(benchmark);
            assertTrue(_hasRole(c, da, newAdmin));
            assertTrue(_hasRole(c, Roles.ADMIN, newAdmin));
            assertFalse(_hasRole(c, da, admin));
            assertFalse(_hasRole(c, Roles.ADMIN, admin));
        }
    }

    function _hasRole(address c, bytes32 role, address account) internal view returns (bool) {
        (bool ok, bytes memory data) =
            c.staticcall(abi.encodeWithSignature("hasRole(bytes32,address)", role, account));
        require(ok, "hasRole call failed");
        return abi.decode(data, (bool));
    }
}
