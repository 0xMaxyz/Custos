// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Phase2a.t.sol — Unit tests for tasks 2.1–2.3 (offline, no fork)
 *
 * Run:  forge test --no-match-contract 'Fork' --match-contract Phase2aTest -vv
 *
 * Covers:
 *  2.1  AggregatorSwapLib — pinned-router exec + balance-delta minOut (via UsdyAdapter)
 *  2.2  USDY oracle valuation — totalAssets(), oracleData(), staleness guard
 *  2.3  UsdyAdapter — access control, deposit, withdraw, emergencyWithdrawAll
 *       YieldVault._buildMarketState — reads USDY oracle via IUsdyAdapter
 *
 * Math notes (all amounts):
 *   USDC: 6 decimals  USDY: 18 decimals  Oracle NAV: 18-dec USDC-per-USDY
 *   NAV = 1e18  →  1 USDC = 1 USDY  →  usdcToUsdy = usdcAmt × 1e12
 *   totalAssets = usdyBal × nav / 1e30  =  usdyBal × 1e18 / 1e30  =  usdyBal / 1e12
 *
 * MockRouter rates (NAV = 1e18):
 *   USDC→USDY: amountOut = amountIn × 1e12 / 1   (num=1e12, denom=1)
 *   USDY→USDC: amountOut = amountIn × 1   / 1e12 (num=1,    denom=1e12)
 */

import {Test, console2} from "forge-std/Test.sol";
import {IERC20}         from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Roles}        from "../src/Roles.sol";
import {Guardrails}   from "../src/Guardrails.sol";
import {YieldVault}   from "../src/YieldVault.sol";
import {UsdyAdapter}      from "../src/UsdyAdapter.sol";
import {IUsdyAdapter}     from "../src/interfaces/IUsdyAdapter.sol";
import {AggregatorSwapLib} from "../src/AggregatorSwapLib.sol";

import {MockRWADynamicOracle}  from "./mocks/MockRWADynamicOracle.sol";
import {MockAggregatorRouter}  from "./mocks/MockAggregatorRouter.sol";
import {MockStrategyAdapter}   from "./mocks/MockStrategyAdapter.sol";

// ── Minimal ERC-20 with mint (used for USDC and USDY in tests) ────────────────

contract ERC20Mock {
    string  public name;
    string  public symbol;
    uint8   public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _sym, uint8 _dec) {
        name = _name; symbol = _sym; decimals = _dec;
    }

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; totalSupply += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max)
            allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt; balanceOf[to] += amt; return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt; return true;
    }

    function forceApprove(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt; return true;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

contract Phase2aTest is Test {
    // ── Actors ────────────────────────────────────────────────────────────────
    address internal admin     = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian  = makeAddr("guardian");
    address internal user      = makeAddr("user");
    address internal rando     = makeAddr("rando");

    // ── Contracts ─────────────────────────────────────────────────────────────
    ERC20Mock              internal usdc;
    ERC20Mock              internal usdy;
    MockRWADynamicOracle   internal oracle;
    MockAggregatorRouter   internal router;
    Guardrails             internal gr;
    YieldVault             internal vault;
    UsdyAdapter            internal adapter;

    // ── Constants ─────────────────────────────────────────────────────────────
    uint256 constant NAV         = 1e18;          // 1:1 oracle price (simplifies math)
    uint256 constant ORACLE_END  = type(uint32).max; // far future — never stale in tests
    uint256 constant DEPOSIT     = 1_000e6;        // $1k USDC
    // At NAV=1e18: 1000e6 USDC → 1000e18 USDY, totalAssets of 1000e18 USDY = 1000e6 USDC
    uint256 constant USDY_EQUIV  = 1_000e18;       // USDY equivalent of DEPOSIT

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.warp(100_000); // avoid underflow in guardrail interval check

        usdc   = new ERC20Mock("USD Coin", "USDC", 6);
        usdy   = new ERC20Mock("USDY",     "USDY", 18);
        oracle = new MockRWADynamicOracle(NAV, ORACLE_END);
        router = new MockAggregatorRouter();

        // Exchange rates: NAV=1e18 → 1 USDC ↔ 1 USDY (adjusted for decimals)
        // USDC(6dec) → USDY(18dec): multiply by 1e12
        router.setRate(address(usdc), address(usdy), 1e12, 1);
        // USDY(18dec) → USDC(6dec): divide by 1e12
        router.setRate(address(usdy), address(usdc), 1, 1e12);

        gr    = new Guardrails(admin);
        vault = new YieldVault(address(usdc), admin, address(gr));

        adapter = new UsdyAdapter(
            address(router),
            address(usdc),
            address(usdy),
            address(0),   // mUSD leg disabled here; exercised in Phase2d.t.sol
            address(oracle),
            address(vault),
            50    // maxSlippageBps (0.5%)
        );

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN,  guardian);
        vault.addStrategy(2, address(adapter)); // USDY = bucket 2
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(2);

        // Pre-fund router so it can pay out on swaps.
        usdc.mint(address(router), 100_000e6);
        usdy.mint(address(router), 100_000e18);
    }

    // ── Aggregator swap calldata helpers (mirrors what the off-chain agent builds) ─
    /// USDC→USDY aggregator calldata paying the adapter.
    function _buyUsdy(uint256 usdcIn) internal view returns (bytes memory) {
        return abi.encodeCall(
            MockAggregatorRouter.swap, (address(usdc), address(usdy), usdcIn, address(adapter))
        );
    }
    /// USDY→USDC aggregator calldata paying the adapter.
    function _sellUsdy(uint256 usdyIn) internal view returns (bytes memory) {
        return abi.encodeCall(
            MockAggregatorRouter.swap, (address(usdy), address(usdc), usdyIn, address(adapter))
        );
    }

    // ── Task 2.2 — USDY oracle valuation ─────────────────────────────────────

    function test_TotalAssetsZeroWhenEmpty() public view {
        assertEq(adapter.totalAssets(), 0);
    }

    function test_TotalAssetsReflectsOracleNav() public {
        usdy.mint(address(adapter), USDY_EQUIV); // 1000e18 USDY
        // totalAssets = 1000e18 * 1e18 / 1e30 = 1000e6
        assertEq(adapter.totalAssets(), DEPOSIT);
    }

    function test_TotalAssetsZeroWhenOracleReverts() public {
        usdy.mint(address(adapter), USDY_EQUIV);
        oracle.setShouldRevert(true);
        assertEq(adapter.totalAssets(), 0); // graceful degradation
    }

    function test_OracleDataReturnsNavAndRangeEnd() public view {
        (uint256 nav, uint64 rangeEnd) = adapter.oracleData();
        assertEq(nav, NAV);
        assertEq(rangeEnd, uint64(ORACLE_END));
    }

    function test_MaxWithdrawableEqualsTotalAssets() public {
        usdy.mint(address(adapter), USDY_EQUIV);
        assertEq(adapter.maxWithdrawable(), adapter.totalAssets());
    }

    function test_DepositRevertsOracleStale() public {
        // Trip the oracle: set range end to past
        oracle.setRange(0, block.timestamp - 1);
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);
        vm.prank(address(vault));
        vm.expectRevert(UsdyAdapter.OracleStale.selector);
        adapter.deposit(DEPOSIT, "");
    }

    function test_WithdrawRevertsOracleStale() public {
        usdy.mint(address(adapter), USDY_EQUIV);
        oracle.setRange(0, block.timestamp - 1);
        vm.prank(address(vault));
        vm.expectRevert(UsdyAdapter.OracleStale.selector);
        adapter.withdraw(DEPOSIT, 0, address(vault), "");
    }

    // ── Task 2.3 — UsdyAdapter access control ────────────────────────────────

    function test_OnlyVaultCanDeposit() public {
        vm.prank(rando);
        vm.expectRevert(UsdyAdapter.OnlyVault.selector);
        adapter.deposit(DEPOSIT, "");
    }

    function test_OnlyVaultCanWithdraw() public {
        vm.prank(rando);
        vm.expectRevert(UsdyAdapter.OnlyVault.selector);
        adapter.withdraw(DEPOSIT, 0, rando, "");
    }

    function test_OnlyVaultCanEmergencyWithdrawAll() public {
        vm.prank(rando);
        vm.expectRevert(UsdyAdapter.OnlyVault.selector);
        adapter.emergencyWithdrawAll(0, rando, "");
    }

    function test_DepositRevertsZeroAmount() public {
        vm.prank(address(vault));
        vm.expectRevert(UsdyAdapter.ZeroAmount.selector);
        adapter.deposit(0, "");
    }

    function test_WithdrawRevertsZeroAmount() public {
        vm.prank(address(vault));
        vm.expectRevert(UsdyAdapter.ZeroAmount.selector);
        adapter.withdraw(0, 0, address(vault), "");
    }

    // ── Task 2.3 — deposit ────────────────────────────────────────────────────

    function test_DepositPullsUsdcAndSwapsToUsdy() public {
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);

        vm.prank(address(vault));
        adapter.deposit(DEPOSIT, _buyUsdy(DEPOSIT));

        // Vault's USDC is gone; adapter now holds USDY (via aggregator).
        assertEq(usdc.balanceOf(address(vault)), 0);
        // Aggregator sends USDY to adapter: 1000e6 * 1e12 / 1 = 1000e18
        assertEq(usdy.balanceOf(address(adapter)), USDY_EQUIV);
        // totalAssets = 1000e18 * 1e18 / 1e30 = 1000e6
        assertEq(adapter.totalAssets(), DEPOSIT);
    }

    function test_DepositEnforcesMinUsdyOutViaBalanceDelta() public {
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);

        // Aggregator underpays (returns half) — adapter's balance-delta minOut fails.
        router.setShouldUnderpay(true);
        // minUsdy = USDY_EQUIV * 9950/10000 = 995e18; received 500e18 → revert.
        vm.prank(address(vault));
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput (selector-only match unavailable for errors with args)
        adapter.deposit(DEPOSIT, _buyUsdy(DEPOSIT));
    }

    function test_DepositRevertsEmptySwapData() public {
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);
        // No aggregator route supplied → fail-closed (no on-chain default exists).
        vm.prank(address(vault));
        vm.expectRevert(AggregatorSwapLib.EmptySwapData.selector);
        adapter.deposit(DEPOSIT, "");
    }

    function test_DepositRevertsWhenOutputPaidElsewhere() public {
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);
        // Calldata pays `rando`, not the adapter → measured delta is 0 → revert.
        bytes memory evil =
            abi.encodeCall(MockAggregatorRouter.swap, (address(usdc), address(usdy), DEPOSIT, rando));
        vm.prank(address(vault));
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput (selector-only match unavailable for errors with args)
        adapter.deposit(DEPOSIT, evil);
    }

    // ── Task 2.3 — withdraw ───────────────────────────────────────────────────

    function test_WithdrawSwapsUsdyToUsdc() public {
        // Pre-load adapter with USDY.
        usdy.mint(address(adapter), USDY_EQUIV);
        // Also approve router for USDY (adapter already pre-approved in constructor).

        uint256 vaultBefore = usdc.balanceOf(address(vault));
        vm.prank(address(vault));
        // Sell the full USDY balance → 1000e18 * 1 / 1e12 = 1000e6 USDC.
        adapter.withdraw(DEPOSIT, 0, address(vault), _sellUsdy(USDY_EQUIV));

        uint256 received = usdc.balanceOf(address(vault)) - vaultBefore;
        // Realized USDC must be ≥ DEPOSIT (minOut floor enforced by balance delta).
        assertGe(received, DEPOSIT);
        console2.log("[2.3] USDC received on withdraw:", received);
    }

    function test_WithdrawEnforcesMinOut() public {
        usdy.mint(address(adapter), USDY_EQUIV);
        router.setShouldUnderpay(true);

        vm.prank(address(vault));
        // minOut = DEPOSIT; aggregator underpays (500e6 < 1000e6) → revert.
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput (selector-only match unavailable for errors with args)
        adapter.withdraw(DEPOSIT, 0, address(vault), _sellUsdy(USDY_EQUIV));
    }

    function test_WithdrawRespectsExplicitMinOut() public {
        usdy.mint(address(adapter), USDY_EQUIV);
        // Request more than the route can deliver — should revert.
        uint256 strictMinOut = DEPOSIT * 2; // unreachable: route yields 1000e6
        vm.prank(address(vault));
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput (selector-only match unavailable for errors with args)
        adapter.withdraw(DEPOSIT, strictMinOut, address(vault), _sellUsdy(USDY_EQUIV));
    }

    // ── Task 2.3 — emergencyWithdrawAll ──────────────────────────────────────

    function test_EmergencyWithdrawAllSellsAllUsdy() public {
        usdy.mint(address(adapter), USDY_EQUIV);

        uint256 balBefore = usdc.balanceOf(address(vault));
        vm.prank(address(vault));
        adapter.emergencyWithdrawAll(0, address(vault), _sellUsdy(USDY_EQUIV));

        assertEq(usdy.balanceOf(address(adapter)), 0);
        assertGt(usdc.balanceOf(address(vault)) - balBefore, 0);
    }

    function test_EmergencyWithdrawAllNoop_WhenEmpty() public {
        // No USDY held → early-return before any swap, so empty calldata is fine.
        vm.prank(address(vault));
        uint256 out = adapter.emergencyWithdrawAll(0, address(vault), "");
        assertEq(out, 0);
    }

    // ── YieldVault integration — _buildMarketState reads USDY oracle ──────────

    function test_VaultMarketStateIncludesUsdyOracle() public {
        // Give vault some USDC so rebalance has TVL.
        usdc.mint(user, DEPOSIT);
        vm.startPrank(user);
        usdc.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        // For the vault's rebalance to fire we need a 2h gap (frequency check).
        vm.warp(block.timestamp + 2 hours);

        // Pre-fund router so the swap succeeds.
        usdc.mint(address(router), 100_000e6);
        usdy.mint(address(router), 100_000e18);

        // Rebalance: 50% idle (bucket 0), 50% USDY (bucket 2).
        // Max move = 50% of TVL — exactly at the 5000 bps cap.
        uint16[4] memory target; target[0] = 5_000; target[2] = 5_000;
        bytes[] memory sd = new bytes[](4);
        sd[2] = _buyUsdy(DEPOSIT / 2); // 50% of $1k TVL → buy $500 of USDY
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://phase2a-test", bytes32(0), NAV);

        // USDY adapter should now hold USDY.
        assertGt(usdy.balanceOf(address(adapter)), 0);
        // Vault totalAssets = idle USDC + adapter USDY valued at oracle price.
        assertApproxEqAbs(vault.totalAssets(), DEPOSIT, 1e6);
        console2.log("[2.2] vault.totalAssets() after USDY alloc:", vault.totalAssets());
        console2.log("[2.2] adapter.totalAssets():", adapter.totalAssets());
    }

    function test_VaultDeRiskExitsUsdyBucket() public {
        // Set up: deposit + rebalance into USDY.
        usdc.mint(user, DEPOSIT);
        vm.startPrank(user);
        usdc.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 hours);
        uint16[4] memory target; target[0] = 5_000; target[2] = 5_000;
        bytes[] memory sd = new bytes[](4);
        sd[2] = _buyUsdy(DEPOSIT / 2);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://pre-derisk", bytes32(0), NAV);

        uint256 usdyBefore = usdy.balanceOf(address(adapter));
        assertGt(usdyBefore, 0);

        // Guardian triggers deRisk (no oracle condition required for guardian).
        // Supply aggregator calldata to unwind the full USDY balance.
        bytes[] memory exit = new bytes[](4);
        exit[2] = _sellUsdy(usdyBefore);
        vm.prank(guardian);
        vault.deRisk(0, exit, "test de-risk", bytes32("evidence"), 0);

        // USDY bucket should be empty; USDC back in vault.
        assertEq(usdy.balanceOf(address(adapter)), 0);
        assertGt(usdc.balanceOf(address(vault)), 0);
        console2.log("[2.5] vault idle USDC after deRisk:", usdc.balanceOf(address(vault)));
    }

    function test_DeRiskRevertsWhenSwapUnderpaysBelowFloor() public {
        // C2 regression: de-risk must enforce an oracle-derived USDC floor, not
        // minOut=0. Seed the USDY bucket (deposit $1k, rebalance 50% into USDY).
        usdc.mint(user, DEPOSIT);
        vm.startPrank(user);
        usdc.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 hours);
        uint16[4] memory target; target[0] = 5_000; target[2] = 5_000;
        bytes[] memory sd = new bytes[](4);
        sd[2] = _buyUsdy(DEPOSIT / 2);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://pre-derisk", bytes32(0), NAV);

        uint256 usdyBefore = usdy.balanceOf(address(adapter));
        assertGt(usdyBefore, 0);

        // Aggregator underpays (pays half): realized ~250e6 < the oracle floor
        // (500e6 × 99.5% = 497.5e6). Pre-fix this ran with minOut=0 and SUCCEEDED
        // with the USDY unsold; the floor now makes it fail closed.
        router.setShouldUnderpay(true);
        bytes[] memory exit = new bytes[](4);
        exit[2] = _sellUsdy(usdyBefore);
        vm.prank(guardian);
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput (selector-only match unavailable for errors with args)
        vault.deRisk(0, exit, "underpay", bytes32("evidence"), 0);
    }

    function test_DeRiskSpotAwareFloorCompletesDuringDepeg() public {
        // C2 regression: a depeg is the scenario de-risk exists for, so the floor
        // must track the agent-supplied DEX spot (min(NAV, spot)) rather than NAV
        // alone — otherwise it would wrongly block the exit. Seed the USDY bucket.
        usdc.mint(user, DEPOSIT);
        vm.startPrank(user);
        usdc.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 hours);
        uint16[4] memory target; target[0] = 5_000; target[2] = 5_000;
        bytes[] memory sd = new bytes[](4);
        sd[2] = _buyUsdy(DEPOSIT / 2);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://pre-derisk", bytes32(0), NAV);

        uint256 usdyBefore = usdy.balanceOf(address(adapter)); // 500e18
        bytes[] memory exit = new bytes[](4);
        exit[2] = _sellUsdy(usdyBefore);

        // Depeg: oracle NAV stays 1.00 but the DEX now pays only 0.99 → realized 495e6.
        router.setRate(address(usdy), address(usdc), 99, 100e12);

        // A NAV-only floor (spot=0 → 497.5e6) would WRONGLY revert during the depeg…
        vm.prank(guardian);
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput: realized 495e6 < 497.5e6 NAV floor
        vault.deRisk(0, exit, "nav-floor", bytes32("evidence"), 0);

        // …but the spot-aware floor (spot=0.99e18 → 495e6 × 99.5% = 492.525e6) clears,
        // so the de-risk completes and the USDY bucket is fully exited.
        vm.prank(guardian);
        vault.deRisk(0, exit, "spot-floor", bytes32("evidence"), 0.99e18);
        assertEq(usdy.balanceOf(address(adapter)), 0);
        assertGt(usdc.balanceOf(address(vault)), 0);
    }

    function test_DeRiskAllocatorBlockedWithoutOracleCondition() public {
        // Allocator cannot deRisk if oracle hasn't tripped.
        usdc.mint(user, DEPOSIT);
        vm.startPrank(user);
        usdc.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        bytes[] memory sd = new bytes[](4);
        vm.prank(allocator);
        vm.expectRevert(YieldVault.DeRiskConditionNotMet.selector);
        vault.deRisk(0, sd, "premature", bytes32(0), 0);
    }

    // ── M1 — removeStrategy uses a balance-based presence check ────────────────

    function test_RemoveStrategyBlockedWhenUsdyHeldDuringOracleOutage() public {
        // Adapter holds USDY; oracle is down so totalAssets() reads 0 (the M1 orphan
        // risk: a value-based guard would let admin remove the adapter and strand USDY).
        usdy.mint(address(adapter), USDY_EQUIV);
        oracle.setShouldRevert(true);
        assertEq(adapter.totalAssets(), 0); // valuation degrades to 0…
        assertTrue(adapter.hasAssets()); // …but the position is still there.

        vm.prank(admin);
        vm.expectRevert(YieldVault.AdapterStillHasAssets.selector);
        vault.removeStrategy(2);
    }

    function test_RemoveStrategySucceedsWhenAdapterEmpty() public {
        assertFalse(adapter.hasAssets());
        vm.prank(admin);
        vault.removeStrategy(2);
        assertEq(address(vault.adapters(2)), address(0));
    }
}
