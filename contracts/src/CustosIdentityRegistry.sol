// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {
    ERC721URIStorage
} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

import { IIdentityRegistry } from "./interfaces/IERC8004.sol";

/**
 * @title CustosIdentityRegistry
 * @notice Minimal ERC-8004 IdentityRegistry equivalent — deployed only when the
 *         canonical 0x8004 singleton is absent on the target chain (Phase-0.3 gate).
 *
 * Each agent identity is an ERC-721 token whose `tokenURI` resolves to the agent
 * card (IPFS JSON). `register` mints the next sequential id to the caller; only the
 * token owner may later update its URI. Ids start at 1 so 0 can mean "unregistered".
 *
 * Intentionally tiny: no enumeration, no royalties, no pause. The registry is a
 * naming/identity surface, never part of the custody path.
 */
contract CustosIdentityRegistry is ERC721URIStorage, IIdentityRegistry {
    // ── Errors ────────────────────────────────────────────────────────────────

    error NotAgentOwner(uint256 agentId, address caller);

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Last minted agent id (also the running total). First id is 1.
    uint256 public lastAgentId;

    // ── Events ────────────────────────────────────────────────────────────────

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI);
    event AgentURIUpdated(uint256 indexed agentId, string agentURI);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() ERC721("Custos Agent Identity", "CUSTOS-ID") { }

    // ── IIdentityRegistry ─────────────────────────────────────────────────────

    /// @inheritdoc IIdentityRegistry
    function register(string calldata agentURI) external override returns (uint256 agentId) {
        agentId = ++lastAgentId;
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        emit AgentRegistered(agentId, msg.sender, agentURI);
    }

    /// @inheritdoc IIdentityRegistry
    function setAgentURI(uint256 agentId, string calldata agentURI) external override {
        // ownerOf reverts if the token does not exist, covering the unregistered case.
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        _setTokenURI(agentId, agentURI);
        emit AgentURIUpdated(agentId, agentURI);
    }

    /// @inheritdoc IIdentityRegistry
    function tokenURI(uint256 agentId)
        public
        view
        override(ERC721URIStorage, IIdentityRegistry)
        returns (string memory)
    {
        return super.tokenURI(agentId);
    }
}
