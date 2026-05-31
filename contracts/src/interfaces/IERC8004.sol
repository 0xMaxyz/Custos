// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IERC8004 — Trustless Agents registry subset (the part Sentinel uses)
 * @notice ERC-8004 defines on-chain registries that give an autonomous agent a
 *         verifiable identity (an ERC-721 token whose `tokenURI` resolves to the
 *         agent card) plus an append-only reputation surface.
 *
 * On Mantle the canonical 0x8004… singletons may already be deployed (see
 * packages/shared addresses + the Phase-0.3 presence gate). When they are, Sentinel
 * registers against them; when they are not, it deploys the minimal equivalents in
 * this repo (`SentinelIdentityRegistry`, `SentinelReputationRegistry`), which
 * implement these same interfaces. SPEC.md §2.5 is the source of truth.
 */

/**
 * @notice Identity registry: an ERC-721 + URIStorage where each agent is a token
 *         and `tokenURI(agentId)` returns the agent-card URI (IPFS JSON).
 */
interface IIdentityRegistry {
    /// @notice Mint a new agent identity owned by the caller, pointing at `agentURI`.
    /// @return agentId The newly minted token id.
    function register(string calldata agentURI) external returns (uint256 agentId);

    /// @notice Update the agent-card URI for `agentId`. Caller must own the token.
    function setAgentURI(uint256 agentId, string calldata agentURI) external;

    /// @notice The agent-card URI for `agentId` (ERC-721 Metadata `tokenURI`).
    function tokenURI(uint256 agentId) external view returns (string memory);
}

/**
 * @notice Reputation registry: an append-only, access-gated log of structured
 *         outcome/feedback signals for an agent. Sentinel uses it to publish each
 *         decision's realized outcome (e.g. passive-baseline delta) as a permanent,
 *         verifiable track record.
 */
interface IReputationRegistry {
    /// @notice Append a structured, immutable feedback/outcome signal for an agent.
    /// @param agentId Identity-registry token id the feedback is about.
    /// @param tag     Caller-defined topic (e.g. keccak256("DERISK")).
    /// @param score   Signed score (e.g. outperformance in bps; may be negative).
    /// @param uri     Evidence URI (IPFS) backing the signal.
    function appendFeedback(uint256 agentId, bytes32 tag, int256 score, string calldata uri)
        external;
}
