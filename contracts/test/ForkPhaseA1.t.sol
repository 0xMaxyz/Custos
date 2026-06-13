// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title ForkPhaseA1.t.sol — Fork tests for task A1.1 (AUSD adapter)
 *
 * Run with a live Mantle fork:
 *   forge test --fork-url $MANTLE_RPC_URL --match-contract ForkPhaseA1Test -vv
 *
 * Verifies the pieces that depend on **live on-chain state but not on a live swap**:
 *   - AUSD + USDC + pinned Odos router exist on-chain (extcodesize) with the
 *     expected token decimals.
 *   - AusdAdapter constructs against the pinned aggregator + live tokens, registers
 *     in bucket 3, and values an empty position at 0.
 *
 * NOTE — why there is no live USDC→AUSD swap here:
 *   AUSD execution routes through the same single pinned DEX **aggregator** (Odos on
 *   Mantle) as USDY: the adapter runs aggregator calldata and enforces a balance-delta
 *   minOut. Reproducing that on a fork requires the aggregator's signed route calldata
 *   for the exact fork block, which can't be fetched deterministically in Foundry. The
 *   swap execution path (deposit/withdraw/emergency, minOut enforcement, pinned-recipient
 *   safety) is fully covered by the offline mock suite in AusdAdapter.t.sol; the
 *   off-chain route fetch is covered by the agent's 1delta client tests. This fork suite
 *   covers only the live token/router presence + construction gates (same caveat as
 *   ForkPhase2a.t.sol for USDY).
 */

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { Roles } from "../src/Roles.sol";
import { Guardrails } from "../src/Guardrails.sol";
import { YieldVault } from "../src/YieldVault.sol";
import { AusdAdapter } from "../src/AusdAdapter.sol";

contract ForkPhaseA1Test is Test {
    // ── Mantle mainnet — verified addresses ───────────────────────────────────

    // USDC: verified via Phase 0.3 gate (Fork.t.sol::testAddressesHaveCode)
    address internal constant USDC = 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9;

    // AUSD: Agora USD — verified via Fork.t.sol Phase 0.3 gate.
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;

    // Odos V2 router on Mantle — the single pinned aggregator the adapter executes
    // against (shared with UsdyAdapter). MUST be re-verified on-chain (Phase 0.3
    // gate) before any deployment; only used for construction here (no live swap).
    address internal constant ODOS_ROUTER = 0xD9F4e85489aDCD0bAF0Cd63b4231c6af58c26745;

    // ── Actors ────────────────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");
    address internal allocator = makeAddr("allocator");
    address internal guardian = makeAddr("guardian");

    // ── Contracts ─────────────────────────────────────────────────────────────

    Guardrails internal gr;
    YieldVault internal vault;
    AusdAdapter internal adapter;

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        gr = new Guardrails(admin);
        vault = new YieldVault(USDC, admin, address(gr));

        adapter = new AusdAdapter(
            ODOS_ROUTER,
            USDC,
            AUSD,
            address(vault),
            50 // maxSlippageBps
        );

        vm.startPrank(admin);
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN, guardian);
        vault.addStrategy(3, address(adapter)); // bucket 3 = AUSD
        vm.stopPrank();

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(admin);
        vault.activateStrategy(3);
    }

    // ── Live token + router presence ─────────────────────────────────────────

    function testForkAusdAndRouterHaveCode() public view {
        assertGt(_codeSize(USDC), 0, "USDC has no code");
        assertGt(_codeSize(AUSD), 0, "AUSD has no code");
        assertGt(_codeSize(ODOS_ROUTER), 0, "Odos router has no code");
        console2.log("[A1.1] USDC/AUSD/Odos all present on-chain");
    }

    function testForkAusdDecimals() public view {
        // AUSD and USDC are both 6-decimal stablecoins (1:1 face accounting depends on this).
        assertEq(IERC20Metadata(USDC).decimals(), 6, "USDC not 6-dec");
        assertEq(IERC20Metadata(AUSD).decimals(), 6, "AUSD not 6-dec");
        console2.log("[A1.1] AUSD decimals:", IERC20Metadata(AUSD).decimals());
    }

    // ── Construction + empty-position valuation ───────────────────────────────

    function testForkAdapterWiring() public view {
        assertEq(adapter.underlying(), USDC, "underlying should be USDC");
        assertEq(adapter.AUSD(), AUSD, "AUSD address mismatch");
        assertEq(adapter.AGGREGATOR(), ODOS_ROUTER, "aggregator should be pinned Odos");
        assertEq(address(vault.adapters(3)), address(adapter), "adapter not registered in bucket 3");
    }

    function testForkEmptyPositionValuation() public view {
        // No AUSD held → totalAssets and maxWithdrawable are both 0 and equal.
        assertEq(adapter.totalAssets(), 0, "empty adapter should value at 0");
        assertEq(adapter.maxWithdrawable(), adapter.totalAssets(), "mw should equal totalAssets");
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _codeSize(address a) internal view returns (uint256 sz) {
        assembly { sz := extcodesize(a) }
    }
}
