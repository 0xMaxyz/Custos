// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title ForkPhase2a.t.sol — Fork tests for tasks 2.1–2.3 (USDY adapter)
 *
 * Run with a live Mantle fork:
 *   forge test --fork-url $MANTLE_RPC_URL --match-contract ForkPhase2aTest -vv
 *
 * Verifies the pieces that depend on **live on-chain state but not on a live swap**:
 *   2.2  RWADynamicOracle — getPrice() returns plausible NAV; range probe is safe.
 *   2.3  UsdyAdapter — constructs against the pinned aggregator + live oracle,
 *         values an empty position at 0, and is not on the USDY blocklist.
 *
 * NOTE — why there is no live USDC→USDY swap here:
 *   USDY execution now routes through a single pinned DEX **aggregator** (Odos on
 *   Mantle): the adapter runs aggregator calldata and enforces a balance-delta
 *   minOut. Reproducing that on a fork requires the aggregator's signed route
 *   calldata for the exact fork block, which can't be fetched deterministically in
 *   Foundry. The swap execution path (deposit/withdraw/emergency, minOut enforcement,
 *   pinned-recipient safety) is fully covered by the offline mock suite in
 *   Phase2a.t.sol; the off-chain route fetch is covered by the agent's 1delta
 *   client tests. This fork suite covers only the live oracle + blocklist gates.
 */

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Roles } from "../src/Roles.sol";
import { Guardrails } from "../src/Guardrails.sol";
import { YieldVault } from "../src/YieldVault.sol";
import { UsdyAdapter } from "../src/UsdyAdapter.sol";
import { IUsdyAdapter } from "../src/interfaces/IUsdyAdapter.sol";
import { IRWADynamicOracle } from "../src/interfaces/IRWADynamicOracle.sol";

contract ForkPhase2aTest is Test {
    // ── Mantle mainnet — verified addresses ───────────────────────────────────

    // USDC: verified via Phase 0.3 gate (Fork.t.sol::testAddressesHaveCode)
    address internal constant USDC = 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9;

    // USDY: Ondo Finance — verified via 1delta curated list + Fork.t.sol
    address internal constant USDY = 0x5bE26527e817998A7206475496fDE1E68957c5A6;

    // mUSD: Ondo's rebasing $1 form of USDY + the wrap/unwrap converter. Verified
    // on-chain in ForkPhase2d.t.sol (usdy()==USDY, oracle()==RWADynamicOracle).
    address internal constant MUSD = 0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3;

    // Odos V2 router on Mantle — the single pinned aggregator the adapter executes
    // against. MUST be re-verified on-chain (Phase 0.3 gate) before any deployment;
    // only used for construction here (no live swap is performed in this suite).
    address internal constant ODOS_ROUTER = 0xD9F4e85489aDCD0bAF0Cd63b4231c6af58c26745;

    // USDY oracle: Ondo Redemption Price Oracle on Mantle. USDY.oracle() reverts,
    // so we use the documented constant (Ondo docs / Phase 0.3 gate). Exposes
    // getPrice(); currentRange() is not implemented (adapter handles via try/catch).
    address internal constant USDY_ORACLE = 0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f;

    // ── Actors ────────────────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian = makeAddr("guardian");
    address internal user = makeAddr("user");

    // ── Contracts ─────────────────────────────────────────────────────────────

    Guardrails internal gr;
    YieldVault internal vault;
    UsdyAdapter internal adapter;

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        // Sanity: the documented Ondo oracle must have code and answer getPrice().
        uint256 sz;
        assembly { sz := extcodesize(USDY_ORACLE) }
        require(sz > 0, "USDY oracle has no code at documented address");
        console2.log("[2a] USDY oracle:", USDY_ORACLE);

        gr = new Guardrails(admin);
        vault = new YieldVault(USDC, admin, address(gr));

        adapter = new UsdyAdapter(
            ODOS_ROUTER,
            USDC,
            USDY,
            MUSD,
            USDY_ORACLE,
            address(vault),
            50 // maxSlippageBps
        );

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN, guardian);
        vault.addStrategy(2, address(adapter)); // bucket 2 = USDY
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(2);
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

    // ── Task 2.3 — Empty-position valuation ───────────────────────────────────

    function testForkEmptyPositionValuation() public view {
        // No USDY held → totalAssets and maxWithdrawable are both 0 and equal.
        assertEq(adapter.totalAssets(), 0, "empty adapter should value at 0");
        assertEq(adapter.maxWithdrawable(), adapter.totalAssets(), "mw should equal totalAssets");
    }

    // ── Task 2.3 — Blocklist check (Phase 0.5 gate, adapter-specific) ─────────

    /// @notice Verifies that neither the vault nor the UsdyAdapter is on the USDY
    ///         blocklist at test time. A blocked address would cause all USDY swaps
    ///         to revert silently. This gate must pass before activating the adapter
    ///         in any deployment (mainnet or testnet).
    function testForkUsdyAdapterNotBlocklisted() public view {
        _assertNotBlocked(address(vault), "vault");
        _assertNotBlocked(address(adapter), "adapter");
    }

    function _assertNotBlocked(address target, string memory label) internal view {
        (bool ok, bytes memory data) =
            USDY.staticcall(abi.encodeWithSignature("isBlocked(address)", target));
        if (ok && data.length == 32) {
            bool blocked = abi.decode(data, (bool));
            assertFalse(blocked, string.concat("USDY blocklist: ", label, " is blocked"));
            console2.log(string.concat("[0.5] USDY.isBlocked(", label, "):"), blocked);
        } else {
            console2.log(
                string.concat(
                    "[0.5] USDY.isBlocked not accessible for ",
                    label,
                    " (transfer test covers this)"
                )
            );
        }
    }
}
