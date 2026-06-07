// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Phase1.t.sol — Unit tests for tasks 1.1-1.4 (no fork required)
 *
 * Covers:
 *   1.1  Roles & access control (ADMIN/ALLOCATOR/GUARDIAN, pause, kill)
 *   1.2  Guardrails validation helpers (validateRebalance, evaluateUsdyRisk)
 *   1.3  YieldVault ERC-4626 skeleton (deposit/withdraw, totalAssets, share math)
 *   1.4  Strategy adapter interface + registry (mock adapter, timelock)
 */

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Roles } from "../src/Roles.sol";
import { Guardrails } from "../src/Guardrails.sol";
import { YieldVault } from "../src/YieldVault.sol";
import { MockStrategyAdapter } from "./mocks/MockStrategyAdapter.sol";

// Minimal ERC-20 for testing (no fork needed).
contract MockUSDC is Test {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint8 public constant decimals = 6;
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }
}

contract Phase1Test is Test {
    address internal admin = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian = makeAddr("guardian");
    address internal user = makeAddr("user");
    address internal user2 = makeAddr("user2");
    address internal attacker = makeAddr("attacker");

    MockUSDC internal usdc;
    Guardrails internal gr;
    YieldVault internal vault;
    MockStrategyAdapter internal mockAdapter;

    uint256 constant USDC_1K = 1_000e6;
    uint256 constant USDC_10K = 10_000e6;
    uint256 constant USDC_50K = 50_000e6;

    function setUp() public {
        usdc = new MockUSDC();
        gr = new Guardrails(admin);
        vault = new YieldVault(address(usdc), admin, address(gr));
        mockAdapter = new MockStrategyAdapter(address(usdc));

        // Grant roles
        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN, guardian);
        vm.stopPrank();

        // Fund users
        usdc.mint(user, USDC_50K);
        usdc.mint(user2, USDC_10K);
    }

    // =========================================================================
    // Task 1.1 — Roles & access control
    // =========================================================================

    function test_RolesGranted() public view {
        assertTrue(vault.hasRole(Roles.ADMIN, admin));
        assertTrue(vault.hasRole(Roles.ALLOCATOR, allocator));
        assertTrue(vault.hasRole(Roles.GUARDIAN, guardian));
        assertFalse(vault.hasRole(Roles.ADMIN, attacker));
    }

    function test_PausePreventsDeposit() public {
        vm.prank(guardian);
        vault.pause();

        vm.startPrank(user);
        usdc.approve(address(vault), USDC_1K);
        vm.expectRevert();
        vault.deposit(USDC_1K, user);
        vm.stopPrank();
    }

    function test_UnpauseRestoresDeposit() public {
        vm.prank(guardian);
        vault.pause();

        vm.prank(guardian);
        vault.unpause();

        vm.startPrank(user);
        usdc.approve(address(vault), USDC_1K);
        vault.deposit(USDC_1K, user);
        vm.stopPrank();
        assertGt(vault.balanceOf(user), 0);
    }

    function test_OnlyGuardianCanPause() public {
        vm.expectRevert();
        vm.prank(attacker);
        vault.pause();
    }

    function test_KillSwitchBlocksDeposit() public {
        vm.prank(guardian);
        vault.kill();
        assertTrue(vault.isKilled());

        // kill no longer auto-pauses; the Killed error fires in deposit()
        vm.startPrank(user);
        usdc.approve(address(vault), USDC_1K);
        vm.expectRevert(YieldVault.Killed.selector);
        vault.deposit(USDC_1K, user);
        vm.stopPrank();
    }

    function test_KillSwitchAllowsWithdraw() public {
        // Deposit first
        vm.startPrank(user);
        usdc.approve(address(vault), USDC_1K);
        vault.deposit(USDC_1K, user);
        vm.stopPrank();

        // Kill
        vm.prank(guardian);
        vault.kill();

        // Withdraw should still work (just ERC4626 redeem — no rebalance)
        vm.startPrank(user);
        uint256 shares = vault.balanceOf(user);
        vault.redeem(shares, user, user);
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), USDC_50K); // got back what they put in
    }

    function test_OnlyGuardianCanKill() public {
        vm.expectRevert();
        vm.prank(attacker);
        vault.kill();
    }

    // =========================================================================
    // Task 1.2 — Guardrails validation
    // =========================================================================

    function test_ValidRebalancePassesGuardrails() public view {
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);

        // Pre: already mostly deployed. Post: small rebalance well within 50% move cap.
        uint16[4] memory pre;
        pre[0] = 3_500;
        pre[1] = 4_500;
        pre[2] = 2_000;
        pre[3] = 0;
        uint16[4] memory post;
        post[0] = 3_000;
        post[1] = 5_000;
        post[2] = 2_000;
        post[3] = 0;
        // Move = (|3500-3000| + |4500-5000| + 0 + 0) / 2 = 500 bps — within 5000 cap

        (bool ok, bytes4 reason) = gr.validateRebalance(pre, post, s);
        assertTrue(ok, _bytes4ToString(reason));
    }

    function test_GuardrailsRejectWeightSumNot10000() public view {
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);
        uint16[4] memory pre;
        pre[0] = 10_000;
        uint16[4] memory post; // sums to 8000
        post[0] = 5_000;
        post[1] = 3_000;

        (bool ok, bytes4 reason) = gr.validateRebalance(pre, post, s);
        assertFalse(ok);
        assertEq(reason, Guardrails.WeightsSumNot10000.selector);
    }

    function test_GuardrailsRejectExceedUsdyCap() public view {
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);
        uint16[4] memory pre;
        pre[0] = 10_000;
        // 70% USDY exceeds 60% cap
        uint16[4] memory post;
        post[0] = 2_000;
        post[1] = 1_000;
        post[2] = 7_000;
        post[3] = 0;

        (bool ok, bytes4 reason) = gr.validateRebalance(pre, post, s);
        assertFalse(ok);
        assertEq(reason, Guardrails.WeightExceedsCap.selector);
    }

    function test_GuardrailsRejectBelowIdleBuffer() public view {
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);
        uint16[4] memory pre;
        pre[0] = 10_000;
        // 1% idle < 2% minimum
        uint16[4] memory post;
        post[0] = 100;
        post[1] = 9_000;
        post[2] = 900;
        post[3] = 0;

        (bool ok, bytes4 reason) = gr.validateRebalance(pre, post, s);
        assertFalse(ok);
        assertEq(reason, Guardrails.IdleBufferTooLow.selector);
    }

    function test_GuardrailsRejectRebalanceIntervalTooSoon() public {
        vm.warp(10_000); // ensure block.timestamp > 3600
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);
        s.lastRebalanceAt = uint64(block.timestamp - 100); // only 100s ago, need 3600s

        uint16[4] memory pre;
        pre[0] = 10_000;
        uint16[4] memory post;
        post[0] = 3_000;
        post[1] = 5_000;
        post[2] = 2_000;
        post[3] = 0;

        (bool ok, bytes4 reason) = gr.validateRebalance(pre, post, s);
        assertFalse(ok);
        assertEq(reason, Guardrails.RebalanceIntervalNotElapsed.selector);
    }

    function test_GuardrailsRejectMoveTooLarge() public view {
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);

        uint16[4] memory pre;
        pre[0] = 10_000;
        // Move 90% of TVL from idle to Aave — exceeds 50% maxRebalanceMoveBps
        uint16[4] memory post;
        post[0] = 1_000;
        post[1] = 8_000;
        post[2] = 1_000;
        post[3] = 0;

        (bool ok, bytes4 reason) = gr.validateRebalance(pre, post, s);
        assertFalse(ok);
        assertEq(reason, Guardrails.RebalanceMoveTooLarge.selector);
    }

    function test_UsdyRiskNormal() public view {
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);
        (bool blockNew, bool forceDeRisk, uint8 level) = gr.evaluateUsdyRisk(s);
        assertFalse(blockNew);
        assertFalse(forceDeRisk);
        assertEq(level, 0);
    }

    function test_UsdyRiskDepegCaution() public view {
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);
        // 40 bps deviation: pegWarn(30) <= 40 < pegBlock(50)
        s.usdyDexSpot = s.usdyOracleNav * (10_000 - 40) / 10_000;
        (bool blockNew, bool forceDeRisk, uint8 level) = gr.evaluateUsdyRisk(s);
        assertFalse(blockNew);
        assertFalse(forceDeRisk);
        assertEq(level, 1); // CAUTION
    }

    function test_UsdyRiskDepegBlock() public view {
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);
        // 60 bps: pegBlock(50) <= 60 < pegDeRisk(100)
        s.usdyDexSpot = s.usdyOracleNav * (10_000 - 60) / 10_000;
        (bool blockNew, bool forceDeRisk, uint8 level) = gr.evaluateUsdyRisk(s);
        assertTrue(blockNew);
        assertFalse(forceDeRisk);
        assertEq(level, 1); // CAUTION, blocked
    }

    function test_UsdyRiskDepegForceDeRisk() public view {
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);
        // 150 bps >= pegDeRisk(100)
        s.usdyDexSpot = s.usdyOracleNav * (10_000 - 150) / 10_000;
        (bool blockNew, bool forceDeRisk, uint8 level) = gr.evaluateUsdyRisk(s);
        assertTrue(blockNew);
        assertTrue(forceDeRisk);
        assertEq(level, 2); // DERISK
    }

    function test_UsdyRiskOracleStale() public {
        vm.warp(10_000);
        Guardrails.MarketState memory s = _normalMarket(USDC_10K);
        s.oracleRangeEnd = uint64(block.timestamp - 1); // past range end
        (bool blockNew, bool forceDeRisk, uint8 level) = gr.evaluateUsdyRisk(s);
        assertTrue(blockNew);
        assertTrue(forceDeRisk);
        assertEq(level, 2);
    }

    function test_OnlyAdminCanSetGuardrailsConfig() public {
        Guardrails.Config memory c = gr.config();

        vm.expectRevert();
        vm.prank(attacker);
        gr.setConfig(c);

        // Admin can update
        vm.prank(admin);
        gr.setConfig(c); // no change, just verify no revert
    }

    // =========================================================================
    // Task 1.3 — YieldVault ERC-4626 skeleton
    // =========================================================================

    function test_DepositMintsShares() public {
        vm.startPrank(user);
        usdc.approve(address(vault), USDC_1K);
        uint256 shares = vault.deposit(USDC_1K, user);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(vault.balanceOf(user), shares);
        assertEq(vault.totalAssets(), USDC_1K);
    }

    function test_DepositExceedPerTxCap() public {
        vm.startPrank(user);
        usdc.approve(address(vault), USDC_50K);
        vm.expectRevert(YieldVault.DepositCapExceeded.selector);
        vault.deposit(USDC_10K + 1, user); // just over $10k cap
        vm.stopPrank();
    }

    function test_DepositExceedTvlCap() public {
        // Fill vault to cap
        vm.startPrank(user);
        usdc.approve(address(vault), USDC_50K);
        for (uint256 i = 0; i < 5; i++) {
            vault.deposit(USDC_10K, user);
        }
        vm.stopPrank();

        // One more should fail (TVL = $50k, any more = over cap)
        usdc.mint(user2, USDC_1K);
        vm.startPrank(user2);
        usdc.approve(address(vault), USDC_1K);
        vm.expectRevert(YieldVault.TvlCapExceeded.selector);
        vault.deposit(USDC_1K, user2);
        vm.stopPrank();
    }

    function test_RedeemBurnsShares() public {
        vm.startPrank(user);
        usdc.approve(address(vault), USDC_1K);
        uint256 shares = vault.deposit(USDC_1K, user);

        uint256 balBefore = usdc.balanceOf(user);
        vault.redeem(shares, user, user);
        vm.stopPrank();

        assertEq(vault.balanceOf(user), 0);
        assertEq(usdc.balanceOf(user) - balBefore, USDC_1K);
    }

    function test_SharePriceNonDecreasing() public {
        // price = 1:1 at start
        vm.startPrank(user);
        usdc.approve(address(vault), USDC_1K);
        vault.deposit(USDC_1K, user);
        vm.stopPrank();

        uint256 price0 = vault.convertToAssets(1e6);

        // Second depositor
        vm.startPrank(user2);
        usdc.approve(address(vault), USDC_1K);
        vault.deposit(USDC_1K, user2);
        vm.stopPrank();

        uint256 price1 = vault.convertToAssets(1e6);
        assertGe(price1, price0, "share price decreased");
    }

    function test_TotalAssetsTracksIdle() public {
        assertEq(vault.totalAssets(), 0);

        vm.startPrank(user);
        usdc.approve(address(vault), USDC_1K);
        vault.deposit(USDC_1K, user);
        vm.stopPrank();

        assertEq(vault.totalAssets(), USDC_1K);
    }

    // =========================================================================
    // Task 1.4 — Strategy adapter interface + registry
    // =========================================================================

    function test_AdapterTimelock() public {
        vm.prank(admin);
        vault.addStrategy(1, address(mockAdapter)); // bucket 1 = AAVE

        // Can't activate before timelock
        vm.expectRevert(abi.encodeWithSelector(YieldVault.TimelockNotElapsed.selector, 1));
        vm.prank(admin);
        vault.activateStrategy(1);
    }

    function test_AdapterActivateAfterTimelock() public {
        vm.prank(admin);
        vault.addStrategy(1, address(mockAdapter));

        // Warp past 2-day timelock
        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(admin);
        vault.activateStrategy(1);

        assertEq(address(vault.adapters(1)), address(mockAdapter));
    }

    function test_TotalAssetsIncludesAdapter() public {
        // Activate adapter
        vm.prank(admin);
        vault.addStrategy(1, address(mockAdapter));
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(1);

        // Deposit into vault
        vm.startPrank(user);
        usdc.approve(address(vault), USDC_1K);
        vault.deposit(USDC_1K, user);
        vm.stopPrank();

        // Simulate adapter holding funds directly (as if rebalance moved funds)
        usdc.mint(address(mockAdapter), 500e6);
        vm.prank(address(vault));
        // The mock adapter tracks deposited separately — fund it via its deposit()
        // For the totalAssets check we mint directly to vault to keep things simple
        // and just confirm adapter.totalAssets() flows into vault.totalAssets()

        // Give mock adapter some balance via direct deposit
        usdc.mint(user, 500e6);
        vm.startPrank(user);
        usdc.approve(address(mockAdapter), 500e6);
        mockAdapter.deposit(500e6, "");
        vm.stopPrank();

        assertEq(vault.totalAssets(), USDC_1K + 500e6);
    }

    function test_MockAdapterDepositWithdraw() public {
        usdc.mint(address(this), USDC_1K);
        usdc.approve(address(mockAdapter), USDC_1K);

        uint256 deployed = mockAdapter.deposit(USDC_1K, "");
        assertEq(deployed, USDC_1K);
        assertEq(mockAdapter.totalAssets(), USDC_1K);
        assertEq(mockAdapter.maxWithdrawable(), USDC_1K);

        uint256 out = mockAdapter.withdraw(USDC_1K, USDC_1K, address(this), "");
        assertEq(out, USDC_1K);
        assertEq(mockAdapter.totalAssets(), 0);
    }

    function test_MockAdapterYieldAccrual() public {
        usdc.mint(address(this), USDC_1K);
        usdc.approve(address(mockAdapter), USDC_1K);
        mockAdapter.deposit(USDC_1K, "");

        // Simulate 5% yield
        mockAdapter.setYieldBps(500);
        assertEq(mockAdapter.totalAssets(), USDC_1K + (USDC_1K * 500 / 10_000));
    }

    function test_EmergencyExitRequiresKill() public {
        // Activate adapter
        vm.prank(admin);
        vault.addStrategy(1, address(mockAdapter));
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(1);

        // emergencyExit without kill should revert
        vm.prank(guardian);
        vm.expectRevert(YieldVault.NotKilled.selector);
        vault.emergencyExit(1, 0, "");
    }

    function test_EmergencyExitAfterKill() public {
        // Activate adapter and put funds in it
        vm.prank(admin);
        vault.addStrategy(1, address(mockAdapter));
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(1);

        usdc.mint(address(mockAdapter), USDC_1K);
        // Hack: directly set adapter deposited via deposit call
        usdc.mint(user, USDC_1K);
        vm.startPrank(user);
        usdc.approve(address(mockAdapter), USDC_1K);
        mockAdapter.deposit(USDC_1K, "");
        vm.stopPrank();

        vm.prank(guardian);
        vault.kill();

        uint256 vaultBalBefore = usdc.balanceOf(address(vault));
        vm.prank(guardian);
        vault.emergencyExit(1, 0, "");
        // Funds moved from adapter to vault
        assertGt(usdc.balanceOf(address(vault)), vaultBalBefore);
    }

    function test_RemoveStrategyRequiresEmptyAdapter() public {
        // Activate adapter
        vm.prank(admin);
        vault.addStrategy(1, address(mockAdapter));
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(1);

        // Give adapter some assets
        usdc.mint(user, 100e6);
        vm.startPrank(user);
        usdc.approve(address(mockAdapter), 100e6);
        mockAdapter.deposit(100e6, "");
        vm.stopPrank();

        // Should revert — adapter has assets
        vm.expectRevert();
        vm.prank(admin);
        vault.removeStrategy(1);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _normalMarket(uint256 tvl) internal view returns (Guardrails.MarketState memory s) {
        uint256 nav = 1.05e18; // ~$1.05 USDY NAV
        s = Guardrails.MarketState({
            usdyOracleNav: nav,
            usdyDexSpot: nav, // no deviation
            oracleUpdatedAt: uint64(block.timestamp),
            oracleRangeEnd: uint64(block.timestamp + 7 days),
            aaveWithdrawable: tvl * 50 / 100, // 50% of TVL withdrawable from Aave
            totalAssets: tvl,
            lastRebalanceAt: 0 // first rebalance
        });
    }

    function _bytes4ToString(bytes4 b) internal pure returns (string memory) {
        bytes memory result = new bytes(10);
        result[0] = "0";
        result[1] = "x";
        for (uint256 i = 0; i < 4; i++) {
            result[2 + i * 2] = _nibble(uint8(b[i]) >> 4);
            result[3 + i * 2] = _nibble(uint8(b[i]) & 0xf);
        }
        return string(result);
    }

    function _nibble(uint8 n) internal pure returns (bytes1) {
        return n < 10 ? bytes1(n + 48) : bytes1(n + 87);
    }
}
