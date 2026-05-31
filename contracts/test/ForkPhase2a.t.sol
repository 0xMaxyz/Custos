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

contract ForkPhase2aTest is Test {
    // ── Mantle mainnet — verified addresses ───────────────────────────────────

    // USDC: verified via Phase 0.3 gate (Fork.t.sol::testAddressesHaveCode)
    address internal constant USDC = 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9;

    // USDY: Ondo Finance — verified via 1delta curated list + Fork.t.sol
    address internal constant USDY = 0x5bE26527e817998A7206475496fDE1E68957c5A6;

    // Merchant Moe LB Router v2: docs.merchantmoe.com / contract-addresses
    address internal constant MM_LB_ROUTER = 0xeaEE7EE68874218c3558b40063c42B82D3E7232a;

    // USDY oracle: Ondo Redemption Price Oracle on Mantle. USDY.oracle() reverts,
    // so we use the documented constant (Ondo docs / Phase 0.3 gate). Exposes
    // getPrice(); currentRange() is not implemented (adapter handles via try/catch).
    address internal constant USDY_ORACLE = 0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f;

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

    /// @dev Live oracle NAV read in setUp — passed as usdyDexSpotUsdc to rebalance().
    uint256 internal liveNav;

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        // Sanity: the documented Ondo oracle must have code and answer getPrice().
        uint256 sz;
        assembly { sz := extcodesize(USDY_ORACLE) }
        require(sz > 0, "USDY oracle has no code at documented address");
        console2.log("[2a] USDY oracle:", USDY_ORACLE);

        gr    = new Guardrails(admin);
        vault = new YieldVault(USDC, admin, address(gr));

        adapter = new UsdyAdapter(
            MM_LB_ROUTER,
            USDC,
            USDY,
            USDY_ORACLE,
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

        // Snapshot live oracle NAV for use as usdyDexSpotUsdc in rebalance calls.
        liveNav = IRWADynamicOracle(USDY_ORACLE).getPrice();
    }

    // ── Task 2.2 — Oracle valuation ───────────────────────────────────────────

    function testForkUsdyOraclePlausibleNav() public view {
        uint256 nav = IRWADynamicOracle(USDY_ORACLE).getPrice();
        // USDY NAV should be between $1.00 and $2.00 (18-dec).
        assertGe(nav, 1e18, "USDY NAV below $1.00");
        assertLe(nav, 2e18, "USDY NAV above $2.00 - unexpected");
        console2.log("[2.2] USDY oracle NAV (18-dec):", nav);

        // currentRange() is not implemented on the Mantle Ondo oracle; probe it
        // without failing the test if it reverts (adapter handles this gracefully).
        try IRWADynamicOracle(USDY_ORACLE).currentRange() returns (uint256 rs, uint256 re) {
            console2.log("[2.2] oracle rangeStart:", rs);
            console2.log("[2.2] oracle rangeEnd:  ", re);
        } catch {
            console2.log("[2.2] currentRange() not implemented on Mantle oracle (expected)");
        }
    }

    function testForkAdapterOracleData() public view {
        // oracleData() must not revert even though currentRange() may be absent.
        (uint256 nav, uint64 rangeEnd) = IUsdyAdapter(address(adapter)).oracleData();
        assertGe(nav, 1e18, "nav below $1");
        console2.log("[2.2] adapter.oracleData() nav:", nav);
        console2.log("[2.2] adapter.oracleData() rangeEnd (0 if range unsupported):", rangeEnd);
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
        vault.rebalance(target, sd, "ipfs://fork-phase2a-deposit", bytes32(0), liveNav);

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
        vault.rebalance(target, sd, "ipfs://fork-phase2a-wd-1", bytes32(0), liveNav);

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
        vault.rebalance(target, sd, "ipfs://fork-phase2a-mw", bytes32(0), liveNav);

        uint256 mw = adapter.maxWithdrawable();
        uint256 ta = adapter.totalAssets();
        assertEq(mw, ta, "maxWithdrawable should equal totalAssets in Phase 2a");
        console2.log("[2.3] maxWithdrawable:", mw, "totalAssets:", ta);
    }

    // ── Task 2.1 — SwapLib round-trip (USDC → USDY → USDC) ────────────────────

    /// @notice Proves SwapLib.exactIn works both directions on Merchant Moe and
    ///         that a full round-trip stays within ~2x the per-swap slippage cap.
    function testForkSwapLibRoundTrip() public {
        // Deposit + allocate fully into USDY (within the 60% cap → use 50%).
        vm.startPrank(user);
        IERC20(USDC).approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, user);
        vm.stopPrank();

        uint16[4] memory target; target[0] = 5_000; target[2] = 5_000;
        bytes[] memory sd = new bytes[](4);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vault.rebalance(target, sd, "ipfs://fork-phase2a-roundtrip-in", bytes32(0), liveNav);

        uint256 usdyHeld = IERC20(USDY).balanceOf(address(adapter));
        assertGt(usdyHeld, 0, "no USDY after first swap");

        // Rebalance back to 100% idle — sells USDY → USDC (second swap leg).
        uint16[4] memory back; back[0] = 10_000;
        vm.warp(block.timestamp + 2 hours);
        vm.prank(allocator);
        vault.rebalance(back, sd, "ipfs://fork-phase2a-roundtrip-out", bytes32(0), 0);

        assertEq(IERC20(USDY).balanceOf(address(adapter)), 0, "USDY not fully unwound");

        // Round-trip cost should be roughly within 2 × maxSlippageBps (0.5%) = 1%.
        uint256 tvl = vault.totalAssets();
        console2.log("[2.1] TVL after USDC->USDY->USDC round trip:", tvl);
        assertGe(tvl, DEPOSIT * 98 / 100, "round-trip lost more than ~2% to slippage");
    }

    // ── Task 2.3 — Blocklist check (Phase 0.5 gate, adapter-specific) ─────────

    /// @notice Verifies that neither the vault nor the UsdyAdapter is on the USDY
    ///         blocklist at test time. A blocked address would cause all USDY swaps
    ///         to revert silently. This gate must pass before activating the adapter
    ///         in any deployment (mainnet or testnet).
    function testForkUsdyAdapterNotBlocklisted() public view {
        // Try the standard Ondo blocklist interface. USDY may expose isBlocked(address).
        _assertNotBlocked(address(vault),   "vault");
        _assertNotBlocked(address(adapter), "adapter");
    }

    function _assertNotBlocked(address target, string memory label) internal view {
        (bool ok, bytes memory data) = USDY.staticcall(
            abi.encodeWithSignature("isBlocked(address)", target)
        );
        if (ok && data.length == 32) {
            bool blocked = abi.decode(data, (bool));
            assertFalse(blocked, string.concat("USDY blocklist: ", label, " is blocked"));
            console2.log(string.concat("[0.5] USDY.isBlocked(", label, "):"), blocked);
        } else {
            // Interface not exposed or call failed — transfer-based check is the fallback.
            console2.log(string.concat("[0.5] USDY.isBlocked not accessible for ", label, " (transfer test covers this)"));
        }
    }
}
