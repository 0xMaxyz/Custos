// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { Test } from "forge-std/Test.sol";

import { CustosIdentityRegistry } from "../src/CustosIdentityRegistry.sol";
import { CustosReputationRegistry } from "../src/CustosReputationRegistry.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title Phase4a Tests
 * @notice Covers tasks 4.1–4.2: ERC-8004 minimal identity + reputation registries.
 *   - register mints a sequential id whose tokenURI resolves to the agent card
 *   - only the token owner may update the agent URI
 *   - reputation feedback is writable only by REPORTER and only for known agents
 *   - feedback is append-only and readable
 */
contract Phase4aTest is Test {
    CustosIdentityRegistry identity;
    CustosReputationRegistry reputation;

    address admin = makeAddr("admin");
    address agent = makeAddr("agent"); // owns the identity NFT
    address reporter = makeAddr("reporter"); // writes outcomes
    address stranger = makeAddr("stranger");

    string constant CARD_URI = "ipfs://QmAgentCard";
    string constant CARD_URI2 = "ipfs://QmAgentCardV2";

    function setUp() public {
        identity = new CustosIdentityRegistry();
        reputation = new CustosReputationRegistry(address(identity), admin);

        bytes32 reporterRole = reputation.REPORTER();
        vm.prank(admin);
        reputation.grantRole(reporterRole, reporter);
    }

    // ── 4.1 identity ───────────────────────────────────────────────────────────

    function test_RegisterMintsSequentialIdsAndResolvesTokenURI() public {
        vm.prank(agent);
        uint256 id = identity.register(CARD_URI);

        assertEq(id, 1, "first id should be 1");
        assertEq(identity.lastAgentId(), 1);
        assertEq(identity.ownerOf(id), agent);
        assertEq(identity.tokenURI(id), CARD_URI);

        vm.prank(stranger);
        uint256 id2 = identity.register(CARD_URI2);
        assertEq(id2, 2, "ids are sequential");
        assertEq(identity.ownerOf(id2), stranger);
    }

    function test_OwnerCanUpdateAgentURI() public {
        vm.prank(agent);
        uint256 id = identity.register(CARD_URI);

        vm.prank(agent);
        identity.setAgentURI(id, CARD_URI2);
        assertEq(identity.tokenURI(id), CARD_URI2);
    }

    function test_NonOwnerCannotUpdateAgentURI() public {
        vm.prank(agent);
        uint256 id = identity.register(CARD_URI);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(CustosIdentityRegistry.NotAgentOwner.selector, id, stranger)
        );
        identity.setAgentURI(id, CARD_URI2);
    }

    function test_TokenURIRevertsForUnregisteredId() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, uint256(42))
        );
        identity.tokenURI(42);
    }

    // ── 4.2 reputation ───────────────────────────────────────────────────────────

    function test_ReporterCanAppendFeedbackForKnownAgent() public {
        vm.prank(agent);
        uint256 id = identity.register(CARD_URI);

        vm.prank(reporter);
        reputation.appendFeedback(id, keccak256("DERISK"), int256(125), "ipfs://QmOutcome");

        assertEq(reputation.feedbackCount(id), 1);
        CustosReputationRegistry.Feedback memory f = reputation.feedbackAt(id, 0);
        assertEq(f.reporter, reporter);
        assertEq(f.tag, keccak256("DERISK"));
        assertEq(f.score, int256(125));
        assertEq(f.uri, "ipfs://QmOutcome");
        assertEq(f.at, uint64(block.timestamp));
    }

    function test_FeedbackIsAppendOnlyAndOrdered() public {
        vm.prank(agent);
        uint256 id = identity.register(CARD_URI);

        vm.startPrank(reporter);
        reputation.appendFeedback(id, keccak256("YIELD"), int256(40), "ipfs://a");
        reputation.appendFeedback(id, keccak256("DERISK"), int256(-15), "ipfs://b");
        vm.stopPrank();

        assertEq(reputation.feedbackCount(id), 2);
        assertEq(reputation.feedbackAt(id, 0).score, int256(40));
        assertEq(reputation.feedbackAt(id, 1).score, int256(-15));
    }

    function test_NonReporterCannotAppendFeedback() public {
        vm.prank(agent);
        uint256 id = identity.register(CARD_URI);

        bytes32 reporterRole = reputation.REPORTER();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, reporterRole
            )
        );
        reputation.appendFeedback(id, keccak256("DERISK"), int256(1), "ipfs://x");
    }

    function test_CannotAppendFeedbackForUnknownAgent() public {
        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(CustosReputationRegistry.UnknownAgent.selector, uint256(999))
        );
        reputation.appendFeedback(999, keccak256("DERISK"), int256(1), "ipfs://x");
    }

    function test_ReputationLinksToIdentityRegistry() public view {
        assertEq(address(reputation.IDENTITY()), address(identity));
    }

    function test_ReputationConstructorRejectsZeroAddresses() public {
        vm.expectRevert(CustosReputationRegistry.ZeroAddress.selector);
        new CustosReputationRegistry(address(0), admin);

        vm.expectRevert(CustosReputationRegistry.ZeroAddress.selector);
        new CustosReputationRegistry(address(identity), address(0));
    }
}
