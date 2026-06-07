// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";

import { Guardrails } from "../src/Guardrails.sol";
import { YieldVault } from "../src/YieldVault.sol";
import { Roles } from "../src/Roles.sol";
import { ERC20Mock } from "./Phase2a.t.sol";

/**
 * @title GovernanceTimelock.t.sol — H3
 * @notice The guardrail brain is the most sensitive surface, so Guardrails.setConfig
 *         and YieldVault.setGuardrails are timelocked (queue -> wait -> activate). A
 *         one-shot setConfig bootstraps the config at deploy, then seals.
 */
contract GovernanceTimelockTest is Test {
    Guardrails internal gr;
    YieldVault internal vault;
    ERC20Mock internal usdc;

    address internal admin = makeAddr("admin");
    address internal attacker = makeAddr("attacker");

    uint256 internal timelock; // = config().addStrategyTimelock (default 2 days)

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        gr = new Guardrails(admin);
        vault = new YieldVault(address(usdc), admin, address(gr));
        timelock = gr.config().addStrategyTimelock;
        assertGt(timelock, 0); // default 2 days — meaningful timelock
    }

    // ── Guardrails.setConfig one-shot + queue/activate ────────────────────────

    function _tweakedConfig() internal view returns (Guardrails.Config memory c) {
        c = gr.config();
        c.maxSlippageBps = 75; // a harmless change to detect application
    }

    function test_SetConfigBootstrapsThenSeals() public {
        // Precompute config args before pranking — argument evaluation makes its own
        // external (view) call that would otherwise consume the prank.
        Guardrails.Config memory c = _tweakedConfig();
        vm.prank(admin);
        gr.setConfig(c);
        assertEq(gr.config().maxSlippageBps, 75);

        // Sealed: a second instant setConfig reverts.
        vm.prank(admin);
        vm.expectRevert(Guardrails.AlreadyInitialized.selector);
        gr.setConfig(c);
    }

    function test_QueueActivateConfigAfterTimelock() public {
        Guardrails.Config memory sealCfg = gr.config();
        vm.prank(admin);
        gr.setConfig(sealCfg); // seal

        Guardrails.Config memory next = gr.config();
        next.maxSlippageBps = 90;
        vm.prank(admin);
        gr.queueConfig(next);

        // Too early.
        vm.prank(admin);
        vm.expectRevert(Guardrails.TimelockNotElapsed.selector);
        gr.activateConfig();

        // After the timelock.
        vm.warp(block.timestamp + timelock + 1);
        vm.prank(admin);
        gr.activateConfig();
        assertEq(gr.config().maxSlippageBps, 90);
    }

    function test_ActivateConfigRevertsWithoutPending() public {
        vm.prank(admin);
        vm.expectRevert(Guardrails.NoPendingChange.selector);
        gr.activateConfig();
    }

    function test_ConfigGovernanceIsAdminOnly() public {
        Guardrails.Config memory c = gr.config(); // precompute before expectRevert binds
        vm.startPrank(attacker);
        vm.expectRevert();
        gr.setConfig(c);
        vm.expectRevert();
        gr.queueConfig(c);
        vm.expectRevert();
        gr.activateConfig();
        vm.stopPrank();
    }

    // ── YieldVault.setGuardrails queue/activate ───────────────────────────────

    function test_QueueActivateGuardrailsAfterTimelock() public {
        Guardrails next = new Guardrails(admin);

        vm.prank(admin);
        vault.queueGuardrails(address(next));

        // Too early.
        vm.prank(admin);
        vm.expectRevert(YieldVault.GuardrailsTimelockNotElapsed.selector);
        vault.activateGuardrails();

        // After the timelock.
        vm.warp(block.timestamp + timelock + 1);
        vm.prank(admin);
        vault.activateGuardrails();
        assertEq(address(vault.guardrails()), address(next));
        assertEq(vault.pendingGuardrails(), address(0));
    }

    function test_ActivateGuardrailsRevertsWithoutPending() public {
        vm.prank(admin);
        vm.expectRevert(YieldVault.NoPendingGuardrails.selector);
        vault.activateGuardrails();
    }

    function test_GuardrailsGovernanceIsAdminOnly() public {
        Guardrails next = new Guardrails(admin);
        vm.startPrank(attacker);
        vm.expectRevert();
        vault.queueGuardrails(address(next));
        vm.expectRevert();
        vault.activateGuardrails();
        vm.stopPrank();
    }
}
