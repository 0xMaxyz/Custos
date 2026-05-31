// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {YieldVault}      from "../src/YieldVault.sol";
import {Guardrails}      from "../src/Guardrails.sol";
import {AgentBenchmark}   from "../src/AgentBenchmark.sol";
import {IAgentBenchmark}  from "../src/interfaces/IAgentBenchmark.sol";
import {Roles}           from "../src/Roles.sol";

import {ERC20Mock}            from "./Phase2a.t.sol";
import {MockRWADynamicOracle} from "./mocks/MockRWADynamicOracle.sol";
import {MockMerchantMoeRouter} from "./mocks/MockMerchantMoeRouter.sol";
import {UsdyAdapter}          from "../src/UsdyAdapter.sol";

/**
 * @title Phase2b Tests
 * @notice Covers tasks 2.4–2.6:
 *   2.4 – DEX-spot depeg guard in validateRebalance (UsdyAllocationBlocked)
 *   2.5 – deRisk path calls AgentBenchmark
 *   2.6 – AgentBenchmark ledger (recordDecision, updateOutcome, navAtDecision)
 */
contract Phase2bTest is Test {
    // ── Roles ─────────────────────────────────────────────────────────────────

    address admin     = makeAddr("admin");
    address allocator = makeAddr("allocator");
    address guardian  = makeAddr("guardian");

    // ── Contracts ─────────────────────────────────────────────────────────────

    ERC20Mock             usdc;
    ERC20Mock             usdy;
    MockRWADynamicOracle  oracle;
    MockMerchantMoeRouter router;
    UsdyAdapter           usdyAdapter;
    Guardrails            gr;
    YieldVault            vault;
    AgentBenchmark        bm;

    uint256 constant NAV      = 1e18;      // $1.00 USDC per USDY (1:1 for simple math)
    uint256 constant DEPOSIT  = 100_000e6; // $100k USDC

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.warp(1_000_000); // ensure block.timestamp >> 0 so staleness checks work

        usdc   = new ERC20Mock("USD Coin", "USDC", 6);
        usdy   = new ERC20Mock("Ondo USDY", "USDY", 18);
        oracle = new MockRWADynamicOracle(NAV, block.timestamp + 365 days);
        router = new MockMerchantMoeRouter();
        // 1:1 NAV: USDC (6-dec) → USDY (18-dec) requires ×1e12; reverse requires ÷1e12.
        router.setRate(address(usdc), address(usdy), 1e12, 1);
        router.setRate(address(usdy), address(usdc), 1, 1e12);

        // Deploy vault with generous TVL cap to accommodate tests
        Guardrails.Config memory cfg;
        cfg.maxWeightBps           = [uint16(10_000), uint16(9_000), uint16(6_000), uint16(10_000)];
        cfg.minIdleBps             = 200;
        cfg.minInstantLiquidityBps = 1_500;
        cfg.maxSlippageBps         = 200; // 2% slippage for test
        cfg.maxRebalanceMoveBps    = 10_000;
        cfg.minRebalanceInterval   = 0; // disable frequency cap for tests
        cfg.tvlCap                 = 10_000_000e6; // $10M
        cfg.perTxDepositCap        = 1_000_000e6;  // $1M
        cfg.addStrategyTimelock    = 0;
        cfg.pegWarnBps             = 30;
        cfg.pegBlockBps            = 50;
        cfg.pegDeRiskBps           = 100;
        cfg.oracleMaxAge           = 100_800;
        cfg.oracleRangeEndBuffer   = 86_400;

        gr = new Guardrails(admin);
        vm.prank(admin);
        gr.setConfig(cfg);

        vault = new YieldVault(address(usdc), admin, address(gr));

        usdyAdapter = new UsdyAdapter(
            address(router),
            address(usdc),
            address(usdy),
            address(oracle),
            address(vault),
            200, // 2%
            1,   // default bin step
            2    // LB version
        );

        bm = new AgentBenchmark(address(vault), admin);

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN, guardian);
        vault.addStrategy(2, address(usdyAdapter)); // USDY bucket
        vault.activateStrategy(2);
        vault.setBenchmark(address(bm));
        vm.stopPrank();

        vm.prank(admin);
        bm.grantRole(Roles.ALLOCATOR, allocator);

        // Fund router with USDY output tokens
        usdy.mint(address(router), 1_000_000e18);

        // User deposits USDC
        usdc.mint(address(this), DEPOSIT);
        usdc.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, address(this));

        // Fund router with USDC for USDY→USDC swaps
        usdc.mint(address(router), DEPOSIT);
    }

    // ── 2.4: DEX-spot depeg guard ─────────────────────────────────────────────

    function test_RebalanceBlockedWhenDexSpotDepeg() public {
        // Target: move 30% to USDY
        uint16[4] memory target = [uint16(4_000), 0, 6_000, 0];
        bytes[] memory sd = new bytes[](3);

        // DEX spot is 1% below NAV (pegDeRiskBps = 100 bps = exactly at derisk threshold)
        uint256 depeggedSpot = (NAV * 99) / 100; // 1% below

        vm.prank(allocator);
        vm.expectRevert(
            abi.encodeWithSelector(YieldVault.GuardrailsRejected.selector, Guardrails.UsdyAllocationBlocked.selector)
        );
        vault.rebalance(target, sd, "ipfs://test", bytes32(0), depeggedSpot);
    }

    function test_RebalanceAllowedWhenDexSpotNormal() public {
        // NAV spot matches oracle exactly → should pass
        uint16[4] memory target = [uint16(4_000), 0, 6_000, 0];
        bytes[] memory sd = new bytes[](3);

        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://normal", bytes32(0), NAV);
    }

    function test_RebalancePassesWhenDexSpotZero() public {
        // usdyDexSpotUsdc=0 disables the guard
        uint16[4] memory target = [uint16(4_000), 0, 6_000, 0];
        bytes[] memory sd = new bytes[](3);

        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://no-spot", bytes32(0), 0);
    }

    function test_RebalanceBlockOnlyWhenIncreasingUsdyWeight() public {
        // First move 30% to USDY with good spot
        uint16[4] memory toUsdy = [uint16(4_000), 0, 6_000, 0];
        bytes[] memory sd = new bytes[](3);
        vm.prank(allocator);
        vault.rebalance(toUsdy, sd, "ipfs://alloc", bytes32(0), NAV);

        // Now DEX depegs slightly (warn level, not block level)
        uint256 warnSpot = (NAV * 9_975) / 10_000; // 0.25% below — above warn (30bps), below block (50bps)
        uint16[4] memory reduce = [uint16(7_000), 0, 3_000, 0]; // REDUCE USDY: allowed
        vm.prank(allocator);
        vault.rebalance(reduce, sd, "ipfs://reduce", bytes32(0), warnSpot);
    }

    // ── 2.6: AgentBenchmark ledger ────────────────────────────────────────────

    function test_BenchmarkRecordsDecisionOnRebalance() public {
        uint16[4] memory target = [uint16(4_000), 0, 6_000, 0];
        bytes[] memory sd = new bytes[](3);

        vm.prank(allocator);
        uint256 did = vault.rebalance(target, sd, "ipfs://bm1", keccak256("rationale"), NAV);

        assertEq(bm.decisionCount(), 1);
        assertEq(bm.navAtDecision(did), NAV);
    }

    function test_BenchmarkRecordsMultipleDecisions() public {
        uint16[4] memory t1 = [uint16(4_000), 0, 6_000, 0];
        uint16[4] memory t2 = [uint16(10_000), 0, 0, 0];
        bytes[] memory sd = new bytes[](3);

        vm.prank(allocator);
        uint256 d1 = vault.rebalance(t1, sd, "ipfs://d1", bytes32(0), NAV);

        // Warp past interval
        vm.warp(block.timestamp + 2 hours);

        vm.prank(allocator);
        uint256 d2 = vault.rebalance(t2, sd, "ipfs://d2", bytes32(0), NAV);

        assertEq(bm.decisionCount(), 2);
        assertEq(d2, d1 + 1);
    }

    function test_BenchmarkUpdateOutcome() public {
        uint16[4] memory target = [uint16(4_000), 0, 6_000, 0];
        bytes[] memory sd = new bytes[](3);

        vm.prank(allocator);
        uint256 did = vault.rebalance(target, sd, "ipfs://bm2", bytes32(0), NAV);

        IAgentBenchmark.Outcome memory o = IAgentBenchmark.Outcome({
            realizedYieldBps:    120,
            drawdownAvoidedUsdc: 5000e6,
            passiveDeltaBps:     -30,
            measuredAt:          uint64(block.timestamp)
        });

        vm.prank(allocator);
        bm.updateOutcome(did, o);

        IAgentBenchmark.Outcome memory stored = bm.outcomeOf(did);
        assertEq(stored.realizedYieldBps, 120);
        assertEq(stored.drawdownAvoidedUsdc, 5000e6);
        assertEq(stored.passiveDeltaBps, -30);
        assertEq(stored.measuredAt, uint64(block.timestamp));
    }

    function test_BenchmarkUpdateOutcomeOnlyAllocator() public {
        uint16[4] memory target = [uint16(4_000), 0, 6_000, 0];
        bytes[] memory sd = new bytes[](3);

        vm.prank(allocator);
        uint256 did = vault.rebalance(target, sd, "ipfs://bm3", bytes32(0), NAV);

        IAgentBenchmark.Outcome memory o = IAgentBenchmark.Outcome({
            realizedYieldBps:    50,
            drawdownAvoidedUsdc: 0,
            passiveDeltaBps:     50,
            measuredAt:          uint64(block.timestamp)
        });

        vm.expectRevert();
        bm.updateOutcome(did, o);
    }

    function test_BenchmarkDecisionNotFoundReverts() public {
        IAgentBenchmark.Outcome memory o = IAgentBenchmark.Outcome({
            realizedYieldBps:    0,
            drawdownAvoidedUsdc: 0,
            passiveDeltaBps:     0,
            measuredAt:          uint64(block.timestamp)
        });

        vm.prank(allocator);
        vm.expectRevert(AgentBenchmark.DecisionNotFound.selector);
        bm.updateOutcome(999, o);
    }

    function test_BenchmarkRecordsDeRiskDecision() public {
        // First alloc USDY
        uint16[4] memory target = [uint16(4_000), 0, 6_000, 0];
        bytes[] memory sd = new bytes[](3);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://pre", bytes32(0), NAV);

        // Trip the depeg guard so allocator can de-risk
        oracle.setPrice(NAV * 98 / 100); // 2% drop → nav itself drops
        // Make the deRisk guard fire by setting a stale range end in the past
        oracle.setRange(1, block.timestamp - 1); // range expired → forceDeRisk = true

        uint256 bmCountBefore = bm.decisionCount();

        bytes[] memory dsd = new bytes[](3);
        vm.prank(allocator);
        vault.deRisk(0, dsd, "depeg detected", keccak256("evidence"));

        assertEq(bm.decisionCount(), bmCountBefore + 1);
    }

    // ── 2.6: setBenchmark ────────────────────────────────────────────────────

    function test_SetBenchmarkOnlyAdmin() public {
        vm.expectRevert();
        vault.setBenchmark(address(0));
    }

    function test_SetBenchmarkClearsLedger() public {
        vm.prank(admin);
        vault.setBenchmark(address(0));

        // Rebalance should not revert even with no benchmark
        uint16[4] memory target = [uint16(4_000), 0, 6_000, 0];
        bytes[] memory sd = new bytes[](3);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://no-bm", bytes32(0), NAV);
    }

    // ── AgentBenchmark: OnlyVault ──────────────────────────────────────────────

    function test_BenchmarkOnlyVaultCanRecord() public {
        vm.expectRevert(AgentBenchmark.OnlyVault.selector);
        bm.recordDecision(1, bytes32(0), "uri", 1e18);
    }
}
