// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Phase1b.t.sol — Unit tests for tasks 1.5-1.6 (no fork required)
 *
 * Fork tests for AaveV3Adapter against live Mantle are in ForkPhase1b.t.sol.
 *
 * Covers:
 *   1.5  AaveV3Adapter interface contract (constructor, access control, errors)
 *   1.6  rebalance() + withdraw queue
 *         - guardrail-validated rebalance moves funds idle <-> adapter
 *         - withdraw queue drains idle first, then adapters
 *         - guardrail-violating rebalance reverts with typed error
 *         - deRisk() unwinds USDY adapter (guardian path, no oracle check)
 *         - large withdraw served from idle + adapter combined
 */

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Roles}               from "../src/Roles.sol";
import {Guardrails}          from "../src/Guardrails.sol";
import {YieldVault}          from "../src/YieldVault.sol";
import {AaveV3Adapter}       from "../src/AaveV3Adapter.sol";
import {MockStrategyAdapter} from "./mocks/MockStrategyAdapter.sol";

// ── Minimal MockUSDC (same as Phase1.t.sol) ───────────────────────────────────

contract MockUSDC2 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint8 public constant DECIMALS = 6;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    // forceApprove compatibility (OZ SafeERC20 calls approve directly on known ERC20s)
    function decimals() external pure returns (uint8) { return DECIMALS; }
    function totalSupply() external pure returns (uint256) { return 0; }
    function name() external pure returns (string memory) { return "USD Coin"; }
    function symbol() external pure returns (string memory) { return "USDC"; }
}

// ── Test harness ──────────────────────────────────────────────────────────────

contract Phase1bTest is Test {
    address internal admin     = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian  = makeAddr("guardian");
    address internal user      = makeAddr("user");
    address internal attacker  = makeAddr("attacker");

    MockUSDC2  internal usdc;
    Guardrails internal gr;
    YieldVault internal vault;

    MockStrategyAdapter internal aaveAdapter; // bucket 1
    MockStrategyAdapter internal usdyAdapter; // bucket 2

    uint256 constant USDC_1K  = 1_000e6;
    uint256 constant USDC_5K  = 5_000e6;
    uint256 constant USDC_10K = 10_000e6;

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        usdc = new MockUSDC2();
        gr   = new Guardrails(admin);
        vault = new YieldVault(address(usdc), admin, address(gr));
        aaveAdapter = new MockStrategyAdapter(address(usdc));
        usdyAdapter = new MockStrategyAdapter(address(usdc));

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN,  guardian);
        vm.stopPrank();

        usdc.mint(user, USDC_10K);

        // Activate AAVE adapter (bucket 1) with warp past timelock.
        vm.prank(admin);
        vault.addStrategy(1, address(aaveAdapter));
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(1);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Deposit `amount` USDC from `user` into the vault.
    function _deposit(uint256 amount) internal {
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();
    }

    /// Build a minimal valid rebalance call: pre is all-idle, target is
    /// `idleBps` idle + rest in AAVE.
    function _rebalance(uint16 idleBps, uint16 aaveBps) internal returns (uint256) {
        uint16[4] memory target;
        target[0] = idleBps;
        target[1] = aaveBps;
        bytes[] memory sd = new bytes[](4);
        vm.prank(allocator);
        return vault.rebalance(target, sd, "ipfs://test", keccak256("rationale"));
    }

    // ── Task 1.5 — AaveV3Adapter access control ───────────────────────────────
    // Deploy a real AaveV3Adapter with mock addresses (no fork needed for access checks).

    function _deployRealAdapter() internal returns (AaveV3Adapter) {
        // Use address(1) as pool/aUsdc placeholders — forceApprove only touches USDC.
        return new AaveV3Adapter(address(1), address(usdc), address(1), address(vault));
    }

    function test_AdapterOnlyVaultCanDeposit() public {
        AaveV3Adapter real = _deployRealAdapter();
        usdc.mint(address(this), USDC_1K);
        usdc.approve(address(real), USDC_1K);
        vm.expectRevert(AaveV3Adapter.OnlyVault.selector);
        vm.prank(attacker);
        real.deposit(USDC_1K, "");
    }

    function test_AdapterOnlyVaultCanWithdraw() public {
        AaveV3Adapter real = _deployRealAdapter();
        vm.expectRevert(AaveV3Adapter.OnlyVault.selector);
        vm.prank(attacker);
        real.withdraw(USDC_1K, 0, address(this), "");
    }

    function test_AdapterOnlyVaultCanEmergencyWithdraw() public {
        AaveV3Adapter real = _deployRealAdapter();
        vm.expectRevert(AaveV3Adapter.OnlyVault.selector);
        vm.prank(attacker);
        real.emergencyWithdrawAll(0, address(this), "");
    }

    // ── Task 1.6 — rebalance() ────────────────────────────────────────────────

    function test_RebalanceMovesFundsToAdapter() public {
        _deposit(USDC_10K);

        // Rebalance: 30% idle, 70% AAVE — valid (prev all-idle, move = 70% > 50% cap)
        // Use a smaller move: 50% idle, 50% AAVE (move = 50% exactly, at cap).
        uint16[4] memory target; target[0] = 5_000; target[1] = 5_000;
        bytes[] memory sd = new bytes[](4);

        vm.warp(block.timestamp + 2 hours); // past min interval
        vm.prank(allocator);
        uint256 did = vault.rebalance(target, sd, "ipfs://r1", bytes32(0));

        assertGt(did, 0);
        assertGt(aaveAdapter.totalAssets(), 0);
        assertEq(vault.totalAssets(), USDC_10K); // TVL unchanged
    }

    function test_RebalanceEmitsEvents() public {
        _deposit(USDC_10K);

        uint16[4] memory target; target[0] = 5_000; target[1] = 5_000;
        bytes[] memory sd = new bytes[](4);

        vm.warp(block.timestamp + 2 hours);
        vm.expectEmit(true, false, false, false);
        emit YieldVault.DecisionRecorded(1, 0, bytes32(0), "ipfs://r1");

        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://r1", bytes32(0));
    }

    function test_RebalanceGuardrailsRejectWeightSumNot10000() public {
        _deposit(USDC_10K);
        uint16[4] memory target; target[0] = 4_000; target[1] = 4_000; // sums 8000
        bytes[] memory sd = new bytes[](4);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vm.expectRevert(
            abi.encodeWithSelector(YieldVault.GuardrailsRejected.selector, Guardrails.WeightsSumNot10000.selector)
        );
        vault.rebalance(target, sd, "ipfs://bad", bytes32(0));
    }

    function test_RebalanceGuardrailsRejectTooSoon() public {
        _deposit(USDC_10K);

        uint16[4] memory target; target[0] = 5_000; target[1] = 5_000;
        bytes[] memory sd = new bytes[](4);

        // First rebalance at block.timestamp (interval 0 since lastRebalanceAt == 0).
        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://r1", bytes32(0));

        // Second rebalance immediately — should be rejected.
        vm.prank(allocator);
        vm.expectRevert(
            abi.encodeWithSelector(
                YieldVault.GuardrailsRejected.selector,
                Guardrails.RebalanceIntervalNotElapsed.selector
            )
        );
        vault.rebalance(target, sd, "ipfs://r2", bytes32(0));
    }

    function test_OnlyAllocatorCanRebalance() public {
        _deposit(USDC_10K);
        uint16[4] memory target; target[0] = 5_000; target[1] = 5_000;
        bytes[] memory sd = new bytes[](4);

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert();
        vm.prank(attacker);
        vault.rebalance(target, sd, "ipfs://bad", bytes32(0));
    }

    function test_PausedVaultBlocksRebalance() public {
        _deposit(USDC_10K);
        vm.prank(guardian);
        vault.pause();

        uint16[4] memory target; target[0] = 5_000; target[1] = 5_000;
        bytes[] memory sd = new bytes[](4);

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert();
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://bad", bytes32(0));
    }

    // ── Task 1.6 — withdraw queue ─────────────────────────────────────────────

    function test_WithdrawFromIdleOnly() public {
        _deposit(USDC_1K);
        // No rebalance — all funds are idle.
        vm.startPrank(user);
        uint256 balBefore = usdc.balanceOf(user);
        vault.withdraw(USDC_1K, user, user);
        vm.stopPrank();
        assertEq(usdc.balanceOf(user) - balBefore, USDC_1K);
    }

    function test_WithdrawPullsFromAdapterWhenIdleInsufficient() public {
        _deposit(USDC_10K);

        // Move 50% to adapter.
        uint16[4] memory target; target[0] = 5_000; target[1] = 5_000;
        bytes[] memory sd = new bytes[](4);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://r1", bytes32(0));

        // Verify: ~5k idle, ~5k in adapter.
        uint256 idle = usdc.balanceOf(address(vault));
        assertApproxEqAbs(idle, USDC_5K, 1e6);

        // Now withdraw 7k — needs idle (5k) + adapter (2k).
        uint256 balBefore = usdc.balanceOf(user);
        vm.startPrank(user);
        vault.withdraw(7_000e6, user, user);
        vm.stopPrank();

        assertApproxEqAbs(usdc.balanceOf(user) - balBefore, 7_000e6, 1e6);
        // Adapter should have ~3k remaining.
        assertApproxEqAbs(aaveAdapter.totalAssets(), 3_000e6, 1e6);
    }

    function test_WithdrawRevertsWhenInsufficientTotal() public {
        _deposit(USDC_1K);
        // Try to withdraw more than deposited.
        vm.startPrank(user);
        vm.expectRevert(YieldVault.InsufficientLiquidity.selector);
        vault.withdraw(USDC_5K, user, user);
        vm.stopPrank();
    }

    function test_RedeemFullBalance() public {
        _deposit(USDC_5K);

        vm.startPrank(user);
        uint256 shares = vault.balanceOf(user);
        uint256 balBefore = usdc.balanceOf(user);
        vault.redeem(shares, user, user);
        vm.stopPrank();

        assertEq(usdc.balanceOf(user) - balBefore, USDC_5K);
        assertEq(vault.totalSupply(), 0);
    }

    // ── Task 1.6 — deRisk() ───────────────────────────────────────────────────

    function test_GuardianCanDeRiskWithoutOracleCheck() public {
        // Activate USDY adapter (bucket 2).
        vm.prank(admin);
        vault.addStrategy(2, address(usdyAdapter));
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(2);

        // Put funds in USDY adapter directly (simulates prior rebalance).
        usdc.mint(address(usdyAdapter), USDC_1K);
        // Fund the adapter's internal accounting via deposit.
        usdc.mint(user, USDC_1K);
        vm.startPrank(user);
        usdc.approve(address(usdyAdapter), USDC_1K);
        usdyAdapter.deposit(USDC_1K, "");
        vm.stopPrank();

        assertGt(usdyAdapter.totalAssets(), 0);

        bytes[] memory sd = new bytes[](4);
        vm.prank(guardian);
        uint256 did = vault.deRisk(0, sd, "oracle stale", keccak256("evidence"));

        assertGt(did, 0);
        assertEq(usdyAdapter.totalAssets(), 0);
        // USDC returned to vault (idle).
        assertGt(usdc.balanceOf(address(vault)), 0);
    }

    function test_AllocatorDeRiskRequiresOracleCondition() public {
        bytes[] memory sd = new bytes[](4);
        // Market is normal, so allocator de-risk should fail.
        vm.prank(allocator);
        vm.expectRevert(YieldVault.DeRiskConditionNotMet.selector);
        vault.deRisk(0, sd, "test", bytes32(0));
    }

    function test_DeRiskInvalidToBucket() public {
        bytes[] memory sd = new bytes[](4);
        vm.prank(guardian);
        vm.expectRevert(YieldVault.InvalidToBucket.selector);
        vault.deRisk(1, sd, "bad bucket", bytes32(0)); // AAVE is not a valid safety bucket
    }
}
