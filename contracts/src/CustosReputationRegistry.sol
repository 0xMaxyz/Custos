// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { Roles } from "./Roles.sol";
import { IReputationRegistry } from "./interfaces/IERC8004.sol";
import { IIdentityRegistry } from "./interfaces/IERC8004.sol";

/**
 * @title CustosReputationRegistry
 * @notice Minimal ERC-8004 ReputationRegistry equivalent — an append-only,
 *         access-gated log of structured outcome signals for a registered agent.
 *         Deployed only when the canonical 0x8004 singleton is absent.
 *
 * Custos publishes each decision's realized outcome here (e.g. the passive-USDY
 * baseline delta) so the agent's track record is permanent and verifiable. Writes
 * are gated to the REPORTER role (granted to the keeper/vault that computes
 * outcomes); reads are open. Feedback is never mutated or deleted — only appended.
 *
 * The target `agentId` must exist in the linked IdentityRegistry, so feedback can
 * never accrue to a phantom identity.
 */
contract CustosReputationRegistry is IReputationRegistry, AccessControl {
    // ── Roles ─────────────────────────────────────────────────────────────────

    /// @notice May append feedback. Granted to the outcome-reporting keeper.
    bytes32 public constant REPORTER = keccak256("REPORTER");

    // ── Errors ────────────────────────────────────────────────────────────────

    error UnknownAgent(uint256 agentId);
    error ZeroAddress();

    // ── Types ─────────────────────────────────────────────────────────────────

    struct Feedback {
        address reporter; // who appended it
        bytes32 tag; // caller-defined topic
        int256 score; // signed score (e.g. outperformance bps)
        string uri; // evidence URI (IPFS)
        uint64 at; // block timestamp
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice IdentityRegistry the agent ids are validated against.
    IIdentityRegistry public immutable IDENTITY;

    /// @dev agentId => append-only feedback log.
    mapping(uint256 => Feedback[]) private _feedback;

    // ── Events ────────────────────────────────────────────────────────────────

    event FeedbackAppended(
        uint256 indexed agentId,
        uint256 indexed index,
        address indexed reporter,
        bytes32 tag,
        int256 score,
        string uri
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param identity  Linked IdentityRegistry (validates agent ids exist).
     * @param admin     Granted DEFAULT_ADMIN_ROLE + ADMIN (can grant REPORTER).
     */
    constructor(address identity, address admin) {
        if (identity == address(0) || admin == address(0)) revert ZeroAddress();
        IDENTITY = IIdentityRegistry(identity);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN, admin);
    }

    // ── IReputationRegistry ───────────────────────────────────────────────────

    /// @inheritdoc IReputationRegistry
    function appendFeedback(uint256 agentId, bytes32 tag, int256 score, string calldata uri)
        external
        override
        onlyRole(REPORTER)
    {
        // Reverts if the agent id was never registered (tokenURI on a missing id reverts).
        try IDENTITY.tokenURI(agentId) returns (string memory) {
        // exists
        }
        catch {
            revert UnknownAgent(agentId);
        }

        uint256 index = _feedback[agentId].length;
        _feedback[agentId]
        .push(
            Feedback({
                reporter: msg.sender, tag: tag, score: score, uri: uri, at: uint64(block.timestamp)
            })
        );
        emit FeedbackAppended(agentId, index, msg.sender, tag, score, uri);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Number of feedback entries recorded for `agentId`.
    function feedbackCount(uint256 agentId) external view returns (uint256) {
        return _feedback[agentId].length;
    }

    /// @notice The feedback entry at `index` for `agentId`.
    function feedbackAt(uint256 agentId, uint256 index) external view returns (Feedback memory) {
        return _feedback[agentId][index];
    }
}
