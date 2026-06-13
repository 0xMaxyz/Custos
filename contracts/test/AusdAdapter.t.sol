// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title AusdAdapter.t.sol — Unit tests for task A1.1 (offline, no fork)
 *
 * Run:  forge test --no-match-contract 'Fork' --match-contract AusdAdapterTest -vv
 *
 * Covers:
 *  - AusdAdapter face-value accounting — totalAssets()/maxWithdrawable() (1:1 USDC)
 *  - deposit: pull USDC, swap to AUSD via pinned aggregator, balance-delta minOut
 *  - withdraw / emergencyWithdrawAll: swap AUSD→USDC, minOut floor
 *  - access control (onlyVault), zero-amount guards, fail-closed (empty/evil calldata)
 *  - YieldVault integration: de-risk routes USDC into AUSD bucket (3)
 *
 * Math notes: USDC and AUSD are both 6-dec stablecoins, so swap rate is 1:1.
 *   MockRouter rate USDC↔AUSD: num=1, denom=1 (amountOut == amountIn).
 */

import { Test, console2 } from "forge-std/Test.sol";

import { Roles } from "../src/Roles.sol";
import { Guardrails } from "../src/Guardrails.sol";
import { YieldVault } from "../src/YieldVault.sol";
import { AusdAdapter } from "../src/AusdAdapter.sol";
import { UsdyAdapter } from "../src/UsdyAdapter.sol";
import { AggregatorSwapLib } from "../src/AggregatorSwapLib.sol";

import { MockAggregatorRouter } from "./mocks/MockAggregatorRouter.sol";
import { MockRWADynamicOracle } from "./mocks/MockRWADynamicOracle.sol";

// ── Minimal ERC-20 with mint (mirrors Phase2a.t.sol ERC20Mock) ────────────────

contract ERC20Mock {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _sym, uint8 _dec) {
        name = _name;
        symbol = _sym;
        decimals = _dec;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amt;
        }
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function forceApprove(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

contract AusdAdapterTest is Test {
    // ── Actors ────────────────────────────────────────────────────────────────
    address internal admin = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian = makeAddr("guardian");
    address internal user = makeAddr("user");
    address internal rando = makeAddr("rando");

    // ── Contracts ─────────────────────────────────────────────────────────────
    ERC20Mock internal usdc;
    ERC20Mock internal ausd;
    MockAggregatorRouter internal router;
    Guardrails internal gr;
    YieldVault internal vault;
    AusdAdapter internal adapter;

    // ── Constants ─────────────────────────────────────────────────────────────
    uint256 constant DEPOSIT = 1_000e6; // $1k USDC; 1:1 → 1_000e6 AUSD

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.warp(100_000); // avoid underflow in guardrail interval check

        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        ausd = new ERC20Mock("Agora USD", "AUSD", 6);
        router = new MockAggregatorRouter();

        // Both 6-dec stablecoins → 1:1 swap (num=1, denom=1).
        router.setRate(address(usdc), address(ausd), 1, 1);
        router.setRate(address(ausd), address(usdc), 1, 1);

        gr = new Guardrails(admin);
        vault = new YieldVault(address(usdc), admin, address(gr));

        adapter = new AusdAdapter(
            address(router),
            address(usdc),
            address(ausd),
            address(vault),
            50 // maxSlippageBps (0.5%)
        );

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN, guardian);
        vault.addStrategy(3, address(adapter)); // AUSD = bucket 3
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(3);

        // Pre-fund router so it can pay out on swaps.
        usdc.mint(address(router), 100_000e6);
        ausd.mint(address(router), 100_000e6);
    }

    // ── Aggregator swap calldata helpers ─────────────────────────────────────
    function _buyAusd(uint256 usdcIn) internal view returns (bytes memory) {
        return abi.encodeCall(
            MockAggregatorRouter.swap, (address(usdc), address(ausd), usdcIn, address(adapter))
        );
    }

    function _sellAusd(uint256 ausdIn) internal view returns (bytes memory) {
        return abi.encodeCall(
            MockAggregatorRouter.swap, (address(ausd), address(usdc), ausdIn, address(adapter))
        );
    }

    // ── Accounting ────────────────────────────────────────────────────────────

    function test_TotalAssetsZeroWhenEmpty() public view {
        assertEq(adapter.totalAssets(), 0);
    }

    function test_TotalAssetsIsFaceValue() public {
        ausd.mint(address(adapter), DEPOSIT);
        assertEq(adapter.totalAssets(), DEPOSIT); // 1:1 face value
    }

    function test_MaxWithdrawableEqualsTotalAssets() public {
        ausd.mint(address(adapter), DEPOSIT);
        assertEq(adapter.maxWithdrawable(), adapter.totalAssets());
    }

    function test_UnderlyingIsUsdc() public view {
        assertEq(adapter.underlying(), address(usdc));
    }

    // ── Constructor guards ────────────────────────────────────────────────────

    function test_ConstructorRevertsZeroAddress() public {
        vm.expectRevert(AusdAdapter.ZeroAddress.selector);
        new AusdAdapter(address(0), address(usdc), address(ausd), address(vault), 50);
    }

    // ── Access control ──────────────────────────────────────────────────────

    function test_OnlyVaultCanDeposit() public {
        vm.prank(rando);
        vm.expectRevert(AusdAdapter.OnlyVault.selector);
        adapter.deposit(DEPOSIT, "");
    }

    function test_OnlyVaultCanWithdraw() public {
        vm.prank(rando);
        vm.expectRevert(AusdAdapter.OnlyVault.selector);
        adapter.withdraw(DEPOSIT, 0, rando, "");
    }

    function test_OnlyVaultCanEmergencyWithdrawAll() public {
        vm.prank(rando);
        vm.expectRevert(AusdAdapter.OnlyVault.selector);
        adapter.emergencyWithdrawAll(0, rando, "");
    }

    function test_DepositRevertsZeroAmount() public {
        vm.prank(address(vault));
        vm.expectRevert(AusdAdapter.ZeroAmount.selector);
        adapter.deposit(0, "");
    }

    function test_WithdrawRevertsZeroAmount() public {
        vm.prank(address(vault));
        vm.expectRevert(AusdAdapter.ZeroAmount.selector);
        adapter.withdraw(0, 0, address(vault), "");
    }

    // ── deposit ────────────────────────────────────────────────────────────────

    function test_DepositPullsUsdcAndSwapsToAusd() public {
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);

        vm.prank(address(vault));
        adapter.deposit(DEPOSIT, _buyAusd(DEPOSIT));

        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(ausd.balanceOf(address(adapter)), DEPOSIT); // 1:1
        assertEq(adapter.totalAssets(), DEPOSIT);
    }

    function test_DepositEnforcesMinAusdOutViaBalanceDelta() public {
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);

        // Aggregator underpays (returns half) — balance-delta minOut fails.
        router.setShouldUnderpay(true);
        vm.prank(address(vault));
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput
        adapter.deposit(DEPOSIT, _buyAusd(DEPOSIT));
    }

    function test_DepositRevertsEmptySwapData() public {
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);
        vm.prank(address(vault));
        vm.expectRevert(AggregatorSwapLib.EmptySwapData.selector);
        adapter.deposit(DEPOSIT, "");
    }

    function test_DepositRevertsWhenOutputPaidElsewhere() public {
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);
        // Calldata pays `rando`, not the adapter → measured delta is 0 → revert.
        bytes memory evil = abi.encodeCall(
            MockAggregatorRouter.swap, (address(usdc), address(ausd), DEPOSIT, rando)
        );
        vm.prank(address(vault));
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput
        adapter.deposit(DEPOSIT, evil);
    }

    // ── withdraw ───────────────────────────────────────────────────────────────

    function test_WithdrawSwapsAusdToUsdc() public {
        ausd.mint(address(adapter), DEPOSIT);

        uint256 vaultBefore = usdc.balanceOf(address(vault));
        vm.prank(address(vault));
        adapter.withdraw(DEPOSIT, 0, address(vault), _sellAusd(DEPOSIT));

        uint256 received = usdc.balanceOf(address(vault)) - vaultBefore;
        assertGe(received, DEPOSIT);
        console2.log("[A1.1] USDC received on withdraw:", received);
    }

    function test_WithdrawEnforcesMinOut() public {
        ausd.mint(address(adapter), DEPOSIT);
        router.setShouldUnderpay(true);
        vm.prank(address(vault));
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput
        adapter.withdraw(DEPOSIT, 0, address(vault), _sellAusd(DEPOSIT));
    }

    function test_WithdrawRespectsExplicitMinOut() public {
        ausd.mint(address(adapter), DEPOSIT);
        uint256 strictMinOut = DEPOSIT * 2; // unreachable
        vm.prank(address(vault));
        vm.expectRevert(); // AggregatorSwapLib.InsufficientOutput
        adapter.withdraw(DEPOSIT, strictMinOut, address(vault), _sellAusd(DEPOSIT));
    }

    // ── emergencyWithdrawAll ──────────────────────────────────────────────────

    function test_EmergencyWithdrawAllSellsAllAusd() public {
        ausd.mint(address(adapter), DEPOSIT);

        uint256 balBefore = usdc.balanceOf(address(vault));
        vm.prank(address(vault));
        adapter.emergencyWithdrawAll(0, address(vault), _sellAusd(DEPOSIT));

        assertEq(ausd.balanceOf(address(adapter)), 0);
        assertGt(usdc.balanceOf(address(vault)) - balBefore, 0);
    }

    function test_EmergencyWithdrawAllNoop_WhenEmpty() public {
        vm.prank(address(vault));
        uint256 out = adapter.emergencyWithdrawAll(0, address(vault), "");
        assertEq(out, 0);
    }

    // ── YieldVault integration: de-risk into AUSD bucket ──────────────────────

    function test_VaultRebalanceIntoAusdBucket() public {
        usdc.mint(user, DEPOSIT);
        vm.startPrank(user);
        usdc.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 hours); // clear rebalance-frequency gate

        // 50% idle (bucket 0), 50% AUSD (bucket 3) — exactly at the 5000 bps move cap.
        uint16[4] memory target;
        target[0] = 5_000;
        target[3] = 5_000;
        bytes[] memory sd = new bytes[](4);
        sd[3] = _buyAusd(DEPOSIT / 2);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://ausd-test", bytes32(0), 0);

        assertGt(ausd.balanceOf(address(adapter)), 0);
        assertApproxEqAbs(vault.totalAssets(), DEPOSIT, 1e6);
        console2.log("[A1.1] vault.totalAssets() after AUSD alloc:", vault.totalAssets());
        console2.log("[A1.1] adapter.totalAssets():", adapter.totalAssets());
    }

    /**
     * @notice de-risk routes USDY → USDC → AUSD safety bucket. Requires a live
     *         USDY adapter so there's something to unwind; we register a USDY
     *         adapter alongside AUSD and seed it, then deRisk(toBucket=AUSD).
     */
    function test_VaultDeRiskRoutesIntoAusdBucket() public {
        // Stand up a USDY adapter (bucket 2) so deRisk has a bucket to unwind.
        ERC20Mock usdy = new ERC20Mock("USDY", "USDY", 18);
        MockRWADynamicOracle oracle = new MockRWADynamicOracle(1e18, type(uint32).max);
        UsdyAdapter usdyAdapter = new UsdyAdapter(
            address(router),
            address(usdc),
            address(usdy),
            address(0),
            address(oracle),
            address(vault),
            50
        );
        // Router rates for USDY (18-dec) ↔ USDC (6-dec): 1:1 at NAV=1e18.
        router.setRate(address(usdc), address(usdy), 1e12, 1);
        router.setRate(address(usdy), address(usdc), 1, 1e12);
        usdy.mint(address(router), 100_000e18);

        vm.startPrank(admin);
        vault.addStrategy(2, address(usdyAdapter));
        vm.warp(block.timestamp + 2 days + 1);
        vault.activateStrategy(2);
        vm.stopPrank();

        // Deposit + rebalance 50% idle / 50% USDY.
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
        sd[2] = abi.encodeCall(
            MockAggregatorRouter.swap,
            (address(usdc), address(usdy), DEPOSIT / 2, address(usdyAdapter))
        );
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://pre-derisk", bytes32(0), 1e18);

        assertGt(usdy.balanceOf(address(usdyAdapter)), 0);

        // Guardian de-risks USDY → AUSD. swapData[2] sells USDY→USDC,
        // swapData[3] buys AUSD with the freed USDC.
        uint256 usdyHeld = usdy.balanceOf(address(usdyAdapter));
        bytes[] memory exit = new bytes[](4);
        exit[2] = abi.encodeCall(
            MockAggregatorRouter.swap,
            (address(usdy), address(usdc), usdyHeld, address(usdyAdapter))
        );
        exit[3] = _buyAusd(DEPOSIT / 2);
        vm.prank(guardian);
        vault.deRisk(3, exit, "depeg de-risk", bytes32("evidence"), 0);

        // USDY fully unwound; AUSD safety bucket now holds the freed funds.
        assertEq(usdy.balanceOf(address(usdyAdapter)), 0);
        assertGt(ausd.balanceOf(address(adapter)), 0);
        console2.log("[A1.1] AUSD bucket after de-risk:", adapter.totalAssets());
    }
}
