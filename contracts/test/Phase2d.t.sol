// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Phase2d.t.sol — Unit tests for task 2.7 (mUSD leg of UsdyAdapter, offline)
 *
 * Run:  forge test --no-match-contract 'Fork' --match-contract Phase2dTest -vv
 *
 * Covers ROADMAP 2.7 — "the RWA core can be entered/exited as USDY *or* mUSD
 * interchangeably", converting USDY ↔ mUSD via the Ondo mUSD wrap/unwrap converter:
 *   - totalAssets() values USDY (oracle NAV) + mUSD ($1 face), and is CONSERVED
 *     across a conversion (the 2.7 "totalAssets stable across the conversion" test).
 *   - convertToMusd / convertToUsdy round-trip; access-gated to the vault.
 *   - enter via mUSD (deposit USDC→USDY, then wrap), exit unwinds mUSD → USDC ≥ minOut.
 *   - YieldVault.convertRwaLeg ALLOCATOR passthrough (production wiring).
 *
 * Decimals: USDC 6, USDY 18, mUSD 18, NAV 18-dec USDC-per-USDY.
 *   USDY value (6-dec) = usdyBal × nav / 1e30 ; mUSD value (6-dec) = musdBal / 1e12.
 *   wrap(u)   → mUSD = u × nav / 1e18 ; unwrap(m) → USDY = m × 1e18 / nav (oracle-priced).
 */

import {Test, console2} from "forge-std/Test.sol";
import {IERC20}         from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Roles}        from "../src/Roles.sol";
import {Guardrails}   from "../src/Guardrails.sol";
import {YieldVault}   from "../src/YieldVault.sol";
import {UsdyAdapter}  from "../src/UsdyAdapter.sol";
import {IUsdyAdapter} from "../src/interfaces/IUsdyAdapter.sol";
import {AggregatorSwapLib} from "../src/AggregatorSwapLib.sol";

import {MockRWADynamicOracle} from "./mocks/MockRWADynamicOracle.sol";
import {MockAggregatorRouter} from "./mocks/MockAggregatorRouter.sol";
import {MockMusd}             from "./mocks/MockMusd.sol";

// ── Minimal ERC-20 with mint (USDC + USDY) ────────────────────────────────────

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

contract Phase2dTest is Test {
    address internal admin     = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian  = makeAddr("guardian");
    address internal user      = makeAddr("user");
    address internal rando     = makeAddr("rando");

    ERC20Mock            internal usdc;
    ERC20Mock            internal usdy;
    MockRWADynamicOracle internal oracle;
    MockAggregatorRouter internal router;
    MockMusd             internal musd;
    Guardrails           internal gr;
    YieldVault           internal vault;
    UsdyAdapter          internal adapter;

    uint256 constant NAV        = 1e18;            // 1:1 oracle price for the base flow
    uint256 constant ORACLE_END = type(uint32).max;
    uint256 constant DEPOSIT    = 1_000e6;          // $1k USDC
    uint256 constant USDY_EQUIV = 1_000e18;         // USDY equivalent at NAV=1e18

    function setUp() public {
        vm.warp(100_000);

        usdc   = new ERC20Mock("USD Coin", "USDC", 6);
        usdy   = new ERC20Mock("USDY",     "USDY", 18);
        oracle = new MockRWADynamicOracle(NAV, ORACLE_END);
        router = new MockAggregatorRouter();
        musd   = new MockMusd(address(usdy), address(oracle));

        // Aggregator rates at NAV=1e18 (1 USDC ↔ 1 USDY ↔ 1 mUSD, decimal-adjusted).
        router.setRate(address(usdc), address(usdy), 1e12, 1);     // USDC(6)→USDY(18)
        router.setRate(address(usdy), address(usdc), 1, 1e12);     // USDY(18)→USDC(6)
        router.setRate(address(musd), address(usdc), 1, 1e12);     // mUSD(18,$1)→USDC(6)

        gr    = new Guardrails(admin);
        vault = new YieldVault(address(usdc), admin, address(gr));

        adapter = new UsdyAdapter(
            address(router),
            address(usdc),
            address(usdy),
            address(musd),
            address(oracle),
            address(vault),
            50 // maxSlippageBps (0.5%)
        );

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN,  guardian);
        vault.addStrategy(2, address(adapter));
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(2);

        // Pre-fund the aggregator so it can pay out swaps.
        usdc.mint(address(router), 1_000_000e6);
        usdy.mint(address(router), 1_000_000e18);
    }

    // ── swapData helpers ──────────────────────────────────────────────────────
    function _buyUsdy(uint256 usdcIn) internal view returns (bytes memory) {
        return abi.encodeCall(MockAggregatorRouter.swap, (address(usdc), address(usdy), usdcIn, address(adapter)));
    }
    function _sellMusd(uint256 musdIn) internal view returns (bytes memory) {
        return abi.encodeCall(MockAggregatorRouter.swap, (address(musd), address(usdc), musdIn, address(adapter)));
    }

    /// Put `usdyAmount` of USDY into the adapter (as if a deposit had swapped into it).
    function _seedUsdy(uint256 usdyAmount) internal {
        usdy.mint(address(adapter), usdyAmount);
    }

    /// Put ~`musdTarget` of mUSD into the adapter by wrapping freshly-seeded USDY
    /// through the real converter (so MockMusd holds the USDY backing for unwraps).
    function _seedMusd(uint256 musdTarget) internal {
        uint256 nav = oracle.getPrice();
        uint256 usdyNeeded = (musdTarget * 1e18) / nav;
        _seedUsdy(usdyNeeded);
        vm.prank(address(vault));
        adapter.convertToMusd(usdyNeeded, 0);
    }

    // ── totalAssets values both legs ──────────────────────────────────────────

    function test_TotalAssetsValuesMusdAtFace() public {
        // 1000 mUSD ($1 each) → $1000 = 1000e6 USDC.
        _seedMusd(1_000e18);
        assertEq(adapter.totalAssets(), 1_000e6);
    }

    function test_TotalAssetsValuesBothLegs() public {
        _seedUsdy(500e18);     // $500 USDY at NAV=1
        _seedMusd(500e18);     // $500 mUSD at face
        assertEq(adapter.totalAssets(), 1_000e6);
    }

    function test_MaxWithdrawableTracksBothLegs() public {
        _seedUsdy(400e18);
        _seedMusd(600e18);
        assertEq(adapter.maxWithdrawable(), adapter.totalAssets());
        assertEq(adapter.maxWithdrawable(), 1_000e6);
    }

    // ── convert: USDY → mUSD, totalAssets conserved ───────────────────────────

    function test_ConvertUsdyToMusd_TotalAssetsStable() public {
        _seedUsdy(USDY_EQUIV);
        uint256 taBefore = adapter.totalAssets();
        assertEq(taBefore, DEPOSIT);

        vm.prank(address(vault));
        uint256 musdOut = adapter.convertToMusd(USDY_EQUIV, 0);

        assertEq(musdOut, 1_000e18, "mUSD out at NAV=1");
        assertEq(IERC20(address(usdy)).balanceOf(address(adapter)), 0, "USDY fully wrapped");
        assertEq(IERC20(address(musd)).balanceOf(address(adapter)), 1_000e18, "adapter holds mUSD");
        assertEq(adapter.totalAssets(), taBefore, "totalAssets stable across wrap");
    }

    function test_ConvertRoundTrip_UsdyMusdUsdy() public {
        _seedUsdy(USDY_EQUIV);
        uint256 taStart = adapter.totalAssets();

        vm.prank(address(vault));
        adapter.convertToMusd(USDY_EQUIV, 0);
        assertEq(adapter.totalAssets(), taStart, "stable after wrap");

        uint256 musdBal = IERC20(address(musd)).balanceOf(address(adapter));
        vm.prank(address(vault));
        uint256 usdyOut = adapter.convertToUsdy(musdBal, 0);

        assertEq(usdyOut, USDY_EQUIV, "round-trips back to original USDY");
        assertEq(IERC20(address(musd)).balanceOf(address(adapter)), 0, "mUSD fully unwrapped");
        assertEq(adapter.totalAssets(), taStart, "totalAssets stable across full round-trip");
    }

    function test_Convert_StableAtNonUnitNav() public {
        // NAV = $1.25 — exercise the oracle-priced conversion with clean division.
        oracle.setPrice(1.25e18);
        _seedUsdy(1_000e18);                  // $1250 at NAV 1.25
        uint256 taBefore = adapter.totalAssets();
        assertEq(taBefore, 1_250e6);

        vm.prank(address(vault));
        uint256 musdOut = adapter.convertToMusd(1_000e18, 0);
        assertEq(musdOut, 1_250e18, "1000 USDY x 1.25 = 1250 mUSD");
        assertEq(adapter.totalAssets(), taBefore, "stable: 1250 mUSD face == 1250 USDC");

        vm.prank(address(vault));
        uint256 usdyOut = adapter.convertToUsdy(1_250e18, 0);
        assertEq(usdyOut, 1_000e18, "1250 mUSD / 1.25 = 1000 USDY");
        assertEq(adapter.totalAssets(), taBefore, "stable across the full non-unit round-trip");
    }

    // ── enter via mUSD / exit from mUSD ────────────────────────────────────────

    function test_EnterViaMusd_DepositThenWrap() public {
        // Enter the RWA core with USDC, then hold it as mUSD.
        usdc.mint(address(vault), DEPOSIT);
        vm.prank(address(vault));
        usdc.approve(address(adapter), DEPOSIT);
        vm.prank(address(vault));
        adapter.deposit(DEPOSIT, _buyUsdy(DEPOSIT));      // USDC → USDY
        assertEq(IERC20(address(usdy)).balanceOf(address(adapter)), USDY_EQUIV);

        vm.prank(address(vault));
        adapter.convertToMusd(USDY_EQUIV, 0);             // USDY → mUSD

        // The RWA position is now held as mUSD and valued correctly.
        assertEq(IERC20(address(usdy)).balanceOf(address(adapter)), 0);
        assertEq(IERC20(address(musd)).balanceOf(address(adapter)), 1_000e18);
        assertEq(adapter.totalAssets(), DEPOSIT);
    }

    function test_ExitFromMusd_EmergencyWithdrawAll() public {
        // Hold the position as mUSD, then unwind to USDC via the aggregator.
        _seedMusd(1_000e18);

        uint256 vaultBefore = usdc.balanceOf(address(vault));
        vm.prank(address(vault));
        uint256 out = adapter.emergencyWithdrawAll(DEPOSIT, address(vault), _sellMusd(1_000e18));

        assertGe(out, DEPOSIT, "USDC out >= minOut");
        assertEq(IERC20(address(musd)).balanceOf(address(adapter)), 0, "mUSD sold");
        assertEq(usdc.balanceOf(address(vault)) - vaultBefore, out);
    }

    function test_ExitFromMusd_WithdrawSellsMusd() public {
        _seedMusd(1_000e18);
        uint256 vaultBefore = usdc.balanceOf(address(vault));

        vm.prank(address(vault));
        uint256 out = adapter.withdraw(DEPOSIT, 0, address(vault), _sellMusd(1_000e18));

        assertGe(out, DEPOSIT);
        assertEq(usdc.balanceOf(address(vault)) - vaultBefore, out);
    }

    // ── access control / config guards ─────────────────────────────────────────

    function test_ConvertToMusd_OnlyVault() public {
        _seedUsdy(USDY_EQUIV);
        vm.prank(rando);
        vm.expectRevert(UsdyAdapter.OnlyVault.selector);
        adapter.convertToMusd(USDY_EQUIV, 0);
    }

    function test_ConvertToUsdy_OnlyVault() public {
        // onlyVault modifier fires before any balance read, so no mUSD seed needed.
        vm.prank(rando);
        vm.expectRevert(UsdyAdapter.OnlyVault.selector);
        adapter.convertToUsdy(1_000e18, 0);
    }

    function test_Convert_RevertsZeroAmount() public {
        vm.prank(address(vault));
        vm.expectRevert(UsdyAdapter.ZeroAmount.selector);
        adapter.convertToMusd(0, 0);
        vm.prank(address(vault));
        vm.expectRevert(UsdyAdapter.ZeroAmount.selector);
        adapter.convertToUsdy(0, 0);
    }

    function test_Convert_RevertsOracleStale() public {
        _seedUsdy(USDY_EQUIV);
        oracle.setRange(0, block.timestamp - 1);
        vm.prank(address(vault));
        vm.expectRevert(UsdyAdapter.OracleStale.selector);
        adapter.convertToMusd(USDY_EQUIV, 0);
    }

    function test_Convert_EnforcesExplicitMinOut() public {
        _seedUsdy(USDY_EQUIV);
        // Demand more mUSD than the oracle-priced conversion can deliver → revert.
        vm.prank(address(vault));
        vm.expectRevert(); // InsufficientConverterOutput (error w/ args: selector-only match unavailable)
        adapter.convertToMusd(USDY_EQUIV, 1_001e18);
    }

    function test_Convert_RevertsWhenMusdNotConfigured() public {
        // A USDY-only adapter (mUSD leg disabled) must reject conversions.
        UsdyAdapter usdyOnly = new UsdyAdapter(
            address(router), address(usdc), address(usdy), address(0), address(oracle), address(vault), 50
        );
        vm.prank(address(vault));
        vm.expectRevert(UsdyAdapter.MusdNotConfigured.selector);
        usdyOnly.convertToMusd(1e18, 0);
    }

    // ── YieldVault.convertRwaLeg passthrough (ALLOCATOR) ───────────────────────

    function test_VaultConvertRwaLeg_RoundTrip() public {
        // Deposit + rebalance 50/50 idle/USDY so the adapter holds USDY.
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
        vault.rebalance(target, sd, "ipfs://2d", bytes32(0), NAV);

        uint256 usdyHeld = IERC20(address(usdy)).balanceOf(address(adapter));
        assertGt(usdyHeld, 0);
        uint256 taBefore = vault.totalAssets();

        // ALLOCATOR converts the RWA leg USDY → mUSD (exposure-neutral).
        vm.prank(allocator);
        uint256 musdOut = vault.convertRwaLeg(true, usdyHeld, 0);
        assertGt(musdOut, 0);
        assertEq(IERC20(address(usdy)).balanceOf(address(adapter)), 0, "USDY wrapped to mUSD");
        assertEq(IERC20(address(musd)).balanceOf(address(adapter)), musdOut, "vault adapter holds mUSD");
        assertApproxEqAbs(vault.totalAssets(), taBefore, 1, "vault TVL stable across convert");

        // And back: mUSD → USDY.
        vm.prank(allocator);
        vault.convertRwaLeg(false, musdOut, 0);
        assertEq(IERC20(address(musd)).balanceOf(address(adapter)), 0, "mUSD unwrapped");
        assertApproxEqAbs(vault.totalAssets(), taBefore, 1, "vault TVL stable after round-trip");
    }

    function test_VaultConvertRwaLeg_OnlyAllocator() public {
        _seedUsdy(USDY_EQUIV);
        vm.prank(rando);
        vm.expectRevert();
        vault.convertRwaLeg(true, USDY_EQUIV, 0);
    }

    function test_VaultConvertRwaLeg_RevertsWhenKilled() public {
        _seedUsdy(USDY_EQUIV);
        vm.prank(guardian);
        vault.kill();
        vm.prank(allocator);
        vm.expectRevert(YieldVault.Killed.selector);
        vault.convertRwaLeg(true, USDY_EQUIV, 0);
    }
}
