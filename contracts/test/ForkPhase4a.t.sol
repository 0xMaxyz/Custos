// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title ForkPhase4a.t.sol — Fork tests for task 4.1 (canonical ERC-8004 path)
 *
 * Run against a live Mantle fork:
 *   forge test --fork-url $MANTLE_RPC_URL --match-contract ForkPhase4aTest -vv
 *
 * Proves the PRODUCTION registration path Custos uses: the canonical 0x8004
 * IdentityRegistry + ReputationRegistry singletons on Mantle (confirmed present by
 * the Phase-0.3 gate). Specifically:
 *   - register(agentURI) mints an agent id whose tokenURI round-trips, and the
 *     owner can setAgentURI (this also demonstrates why an EOA `cast call` reverts
 *     ERC721InvalidReceiver — eth_call has msg.sender == address(0); a real sender
 *     via vm.prank works);
 *   - giveFeedback writes a client-keyed feedback entry that readFeedback returns,
 *     and getSummary aggregates it — the canonical reputation surface.
 *
 * Skipped in CI (CI runs `--no-match-contract Fork`); requires a Mantle RPC.
 */

import { Test, console2 } from "forge-std/Test.sol";

import { ICanonicalIdentityRegistry } from "../src/interfaces/IERC8004Canonical.sol";
import { ICanonicalReputationRegistry } from "../src/interfaces/IERC8004Canonical.sol";

contract ForkPhase4aTest is Test {
    // ── Canonical ERC-8004 singletons on Mantle (packages/shared addresses) ───
    address internal constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    ICanonicalIdentityRegistry identity = ICanonicalIdentityRegistry(IDENTITY);
    ICanonicalReputationRegistry reputation = ICanonicalReputationRegistry(REPUTATION);

    // The agent's ALLOCATOR-style key that owns the identity + gives feedback.
    address internal agent = makeAddr("custosAgent");
    address internal client = makeAddr("feedbackClient");

    string internal constant CARD_URI = "ipfs://QmCustosAgentCard";
    string internal constant CARD_URI2 = "ipfs://QmCustosAgentCardV2";

    function setUp() public {
        // Guard: only meaningful on a fork where the singletons have code.
        uint256 idSz;
        uint256 repSz;
        assembly {
            idSz := extcodesize(IDENTITY)
            repSz := extcodesize(REPUTATION)
        }
        require(idSz > 0, "IdentityRegistry has no code - run with --fork-url $MANTLE_RPC_URL");
        require(repSz > 0, "ReputationRegistry has no code - run with --fork-url $MANTLE_RPC_URL");
        console2.log("[4.1] IdentityRegistry codesize:", idSz);
        console2.log("[4.1] ReputationRegistry codesize:", repSz);
    }

    // ── 4.1 — canonical identity register → tokenURI → setAgentURI ─────────────

    function testForkCanonicalRegisterResolvesTokenURI() public {
        vm.prank(agent);
        uint256 agentId = identity.register(CARD_URI);

        assertEq(identity.ownerOf(agentId), agent, "agent should own the minted id");
        assertEq(identity.tokenURI(agentId), CARD_URI, "tokenURI should resolve the card");
        console2.log("[4.1] registered agentId:", agentId);

        // The owner can rotate the card URI.
        vm.prank(agent);
        identity.setAgentURI(agentId, CARD_URI2);
        assertEq(identity.tokenURI(agentId), CARD_URI2, "owner can update agent URI");
    }

    function testForkCanonicalNonOwnerCannotSetURI() public {
        vm.prank(agent);
        uint256 agentId = identity.register(CARD_URI);

        // A different account must not be able to rewrite the card.
        vm.prank(client);
        vm.expectRevert();
        identity.setAgentURI(agentId, CARD_URI2);
    }

    // ── 4.1 — canonical reputation giveFeedback → readFeedback / getSummary ────

    function testForkCanonicalReputationWriteAndRead() public {
        vm.prank(agent);
        uint256 agentId = identity.register(CARD_URI);

        // Publish a decision outcome: +180 bps passive-baseline delta (2 decimals).
        int128 value = 180;
        uint8 decimals = 2;
        vm.prank(client);
        reputation.giveFeedback(
            agentId,
            value,
            decimals,
            "DERISK",
            "passiveDeltaBps",
            "https://agent.custos.example",
            "ipfs://QmOutcome",
            keccak256("ipfs://QmOutcome")
        );

        // The feedback is indexed per (agentId, client); the canonical registry is
        // 1-based (index 0 reverts "index must be > 0"), so the first entry is index 1.
        uint64 lastIndex = reputation.getLastIndex(agentId, client);
        assertEq(lastIndex, 1, "one feedback entry recorded for this client");

        (int128 readValue, uint8 readDecimals, string memory tag1,, bool isRevoked) =
            reputation.readFeedback(agentId, client, lastIndex);
        assertEq(readValue, value, "feedback value round-trips");
        assertEq(readDecimals, decimals, "feedback decimals round-trip");
        assertEq(tag1, "DERISK", "feedback tag round-trips");
        assertFalse(isRevoked, "fresh feedback is not revoked");

        // The summary aggregates this client's feedback for the tag pair.
        address[] memory clients = new address[](1);
        clients[0] = client;
        (uint64 count, int128 summaryValue,) =
            reputation.getSummary(agentId, clients, "DERISK", "passiveDeltaBps");
        assertEq(count, 1, "summary counts one entry");
        assertEq(summaryValue, value, "summary reflects the feedback value");
    }

    function testForkReputationLinksToCanonicalIdentity() public view {
        assertEq(
            reputation.getIdentityRegistry(),
            IDENTITY,
            "canonical reputation points at the canonical identity registry"
        );
    }
}
