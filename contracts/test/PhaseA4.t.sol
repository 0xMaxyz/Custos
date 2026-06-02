// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title PhaseA4.t.sol — ERC-8183 verifiable de-risk jobs (task A4.2, offline)
 *
 * Run:  forge test --no-match-contract 'Fork' --match-contract PhaseA4Test -vv
 *
 * Proves the ROADMAP A4.2 thesis on-chain: each de-risk is an ERC-8183 escrowed Job
 * whose Evaluator is the deterministic guardrail check. A guardrail-justified de-risk
 * settles to the provider and writes ERC-8004 reputation; an unjustified one is
 * rejected and the client is refunded. The escrow is never in the vault custody path.
 */

import { Test } from "forge-std/Test.sol";

import { Roles } from "../src/Roles.sol";
import { Guardrails } from "../src/Guardrails.sol";
import { SentinelJobEscrow } from "../src/SentinelJobEscrow.sol";
import { SentinelDeRiskEvaluator } from "../src/SentinelDeRiskEvaluator.sol";
import { SentinelIdentityRegistry } from "../src/SentinelIdentityRegistry.sol";
import { SentinelReputationRegistry } from "../src/SentinelReputationRegistry.sol";
import { UsdyAdapter } from "../src/UsdyAdapter.sol";
import { IERC8183 } from "../src/interfaces/IERC8183.sol";
import { MockRWADynamicOracle } from "./mocks/MockRWADynamicOracle.sol";

contract ERC20Mock {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
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
}

contract PhaseA4Test is Test {
    address internal admin = makeAddr("admin");
    address internal client = makeAddr("client");
    address internal provider = makeAddr("provider"); // the agent
    address internal keeper = makeAddr("keeper");
    address internal rando = makeAddr("rando");

    ERC20Mock internal usdc;
    Guardrails internal gr;
    SentinelIdentityRegistry internal identity;
    SentinelReputationRegistry internal reputation;
    SentinelJobEscrow internal escrow;
    SentinelDeRiskEvaluator internal evaluator;
    MockRWADynamicOracle internal oracle;
    UsdyAdapter internal usdyAdapter;

    uint256 internal agentId;
    uint256 constant BUDGET = 100e6; // $100 bounty
    bytes32 constant DELIVERABLE = keccak256("ipfs://decision-bundle");
    // Keeper-supplied DEX spots vs the on-chain NAV ($1). 0.98 = 200 bps below NAV
    // (past the 100 bps de-risk threshold); 1.00 = on peg.
    uint256 constant DEPEG_SPOT = 0.98e18;
    uint256 constant HEALTHY_SPOT = 1e18;

    function setUp() public {
        vm.warp(1_000_000);

        usdc = new ERC20Mock();
        gr = new Guardrails(admin);
        identity = new SentinelIdentityRegistry();
        reputation = new SentinelReputationRegistry(address(identity), admin);

        // Register the agent identity (id = 1) from an EOA (a contract recipient
        // would need onERC721Received).
        vm.prank(admin);
        agentId = identity.register("ipfs://agent-card");

        escrow = new SentinelJobEscrow(address(usdc));

        // On-chain NAV source for the evaluator: a USDY adapter over a mock oracle
        // (NAV = $1). The keeper supplies only the DEX spot — it cannot fake the NAV.
        ERC20Mock usdy = new ERC20Mock();
        oracle = new MockRWADynamicOracle(1e18, type(uint32).max);
        usdyAdapter = new UsdyAdapter(
            makeAddr("aggregator"), address(usdc), address(usdy), address(0), address(oracle), makeAddr("usdyVault"), 50
        );
        evaluator = new SentinelDeRiskEvaluator(
            address(gr), address(reputation), address(usdyAdapter), agentId, admin
        );

        // Wire roles: the evaluator may write reputation; the keeper may evaluate.
        vm.startPrank(admin);
        reputation.grantRole(reputation.REPORTER(), address(evaluator));
        evaluator.grantRole(evaluator.KEEPER(), keeper);
        vm.stopPrank();

        usdc.mint(client, BUDGET);
    }

    /// Create → set budget → fund → submit a de-risk Job, returning its id.
    function _openFundedSubmittedJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.createJob(
            provider, address(evaluator), block.timestamp + 1 days, "de-risk USDY -> AUSD", address(0)
        );
        vm.prank(client);
        escrow.setBudget(jobId, BUDGET, "");
        vm.startPrank(client);
        usdc.approve(address(escrow), BUDGET);
        escrow.fund(jobId, "");
        vm.stopPrank();
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
    }

    // ── Happy path: guardrail-justified de-risk settles + writes reputation ──────

    function test_DeRiskJustified_SettlesAndWritesReputation() public {
        uint256 jobId = _openFundedSubmittedJob();
        assertEq(usdc.balanceOf(address(escrow)), BUDGET, "budget escrowed");

        vm.prank(keeper);
        bool completed = evaluator.evaluate(escrow, jobId, DEPEG_SPOT, 610, "ipfs://evidence", "depeg-200bps");

        assertTrue(completed, "guardrail justified -> completed");
        assertEq(uint8(escrow.getJob(jobId).status), uint8(IERC8183.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET, "provider paid the bounty");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");

        // Reputation: one DERISK entry with the supplied outcome score.
        assertEq(reputation.feedbackCount(agentId), 1, "one reputation entry");
        SentinelReputationRegistry.Feedback memory f = reputation.feedbackAt(agentId, 0);
        assertEq(f.tag, evaluator.DERISK_TAG());
        assertEq(f.score, int256(610));
        assertEq(f.reporter, address(evaluator));
    }

    // ── Guardrail-violating: not justified → rejected + client refunded ──────────

    function test_NotJustified_RejectsAndRefunds() public {
        uint256 jobId = _openFundedSubmittedJob();

        vm.prank(keeper);
        bool completed = evaluator.evaluate(escrow, jobId, HEALTHY_SPOT, 0, "ipfs://evidence", "on-peg");

        assertFalse(completed, "no de-risk justified -> rejected");
        assertEq(uint8(escrow.getJob(jobId).status), uint8(IERC8183.JobStatus.Rejected));
        assertEq(usdc.balanceOf(client), BUDGET, "client refunded");
        assertEq(usdc.balanceOf(provider), 0, "provider NOT paid");
        assertEq(reputation.feedbackCount(agentId), 0, "no reputation entry on rejection");
    }

    function test_WouldComplete_View() public view {
        assertTrue(evaluator.wouldComplete(DEPEG_SPOT));
        assertFalse(evaluator.wouldComplete(HEALTHY_SPOT));
    }

    // ── Expiry refund ────────────────────────────────────────────────────────────

    function test_ClaimRefund_AfterExpiry() public {
        uint256 jobId = _openFundedSubmittedJob();
        // Anyone can trigger the refund once expired.
        vm.warp(block.timestamp + 2 days);
        vm.prank(rando);
        escrow.claimRefund(jobId);

        assertEq(uint8(escrow.getJob(jobId).status), uint8(IERC8183.JobStatus.Expired));
        assertEq(usdc.balanceOf(client), BUDGET, "client refunded on expiry");
    }

    function test_ClaimRefund_RevertsBeforeExpiry() public {
        uint256 jobId = _openFundedSubmittedJob();
        vm.expectRevert(SentinelJobEscrow.NotExpired.selector);
        escrow.claimRefund(jobId);
    }

    // ── Reject-while-open by client (no funds) ───────────────────────────────────

    function test_RejectWhileOpen_ByClient() public {
        vm.prank(client);
        uint256 jobId =
            escrow.createJob(provider, address(evaluator), block.timestamp + 1 days, "draft", address(0));
        vm.prank(client);
        escrow.reject(jobId, "withdrawn", "");
        assertEq(uint8(escrow.getJob(jobId).status), uint8(IERC8183.JobStatus.Rejected));
    }

    // ── Access control + state-machine guards ────────────────────────────────────

    function test_OnlyClientCanFundAndSetBudget() public {
        vm.prank(client);
        uint256 jobId =
            escrow.createJob(provider, address(evaluator), block.timestamp + 1 days, "j", address(0));

        vm.prank(rando);
        vm.expectRevert(SentinelJobEscrow.NotClient.selector);
        escrow.setBudget(jobId, BUDGET, "");

        vm.prank(client);
        escrow.setBudget(jobId, BUDGET, "");
        vm.prank(rando);
        vm.expectRevert(SentinelJobEscrow.NotClient.selector);
        escrow.fund(jobId, "");
    }

    function test_OnlyProviderCanSubmit() public {
        vm.prank(client);
        uint256 jobId =
            escrow.createJob(provider, address(evaluator), block.timestamp + 1 days, "j", address(0));
        vm.prank(client);
        escrow.setBudget(jobId, BUDGET, "");
        vm.startPrank(client);
        usdc.approve(address(escrow), BUDGET);
        escrow.fund(jobId, "");
        vm.stopPrank();

        vm.prank(rando);
        vm.expectRevert(SentinelJobEscrow.NotProvider.selector);
        escrow.submit(jobId, DELIVERABLE, "");
    }

    function test_SubmitBeforeFundReverts() public {
        vm.prank(client);
        uint256 jobId =
            escrow.createJob(provider, address(evaluator), block.timestamp + 1 days, "j", address(0));
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                SentinelJobEscrow.WrongStatus.selector, IERC8183.JobStatus.Funded, IERC8183.JobStatus.Open
            )
        );
        escrow.submit(jobId, DELIVERABLE, "");
    }

    function test_OnlyEvaluatorCanComplete() public {
        uint256 jobId = _openFundedSubmittedJob();
        // Even the provider cannot self-complete; only the registered evaluator.
        vm.prank(provider);
        vm.expectRevert(SentinelJobEscrow.NotEvaluator.selector);
        escrow.complete(jobId, "x", "");
    }

    function test_OnlyKeeperCanEvaluate() public {
        uint256 jobId = _openFundedSubmittedJob();
        vm.prank(rando);
        vm.expectRevert(); // AccessControlUnauthorizedAccount
        evaluator.evaluate(escrow, jobId, DEPEG_SPOT, 0, "ipfs://e", "r");
    }

    function test_CreateJobRevertsBadExpiry() public {
        vm.prank(client);
        vm.expectRevert(SentinelJobEscrow.BadExpiry.selector);
        escrow.createJob(provider, address(evaluator), block.timestamp, "j", address(0));
    }

    function test_CreateJobRevertsZeroProvider() public {
        vm.prank(client);
        vm.expectRevert(SentinelJobEscrow.ZeroAddress.selector);
        escrow.createJob(address(0), address(evaluator), block.timestamp + 1 days, "j", address(0));
    }

    function test_SetProviderRevertsZeroAddress() public {
        vm.prank(client);
        uint256 jobId =
            escrow.createJob(provider, address(evaluator), block.timestamp + 1 days, "j", address(0));
        vm.prank(client);
        vm.expectRevert(SentinelJobEscrow.ZeroAddress.selector);
        escrow.setProvider(jobId, address(0));
    }
}
