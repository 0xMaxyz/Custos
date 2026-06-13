// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title IERC8004 — Trustless Agents registry subset
 * @notice ERC-8004 defines on-chain registries that give an autonomous agent a
 *         verifiable identity (an ERC-721 token whose `tokenURI` resolves to the
 *         agent card) plus an append-only reputation surface.
 *
 * On Mantle the canonical 0x8004… singletons ARE deployed (confirmed by the
 * Phase-0.3 presence gate; see packages/shared addresses), so per SPEC §2.5 the
 * production path calls them — see `IERC8004Canonical.sol` for their real ABIs and
 * `ForkPhase4a.t.sol` for the on-chain register/feedback proof. The `Custos*`
 * registries in this repo implement *this* simplified interface and are the
 * FALLBACK, used only when the singletons are absent (e.g. a bare testnet).
 *
 * ⚠ ABI CAVEAT (why this is a separate, simpler interface):
 *   - Identity: the canonical IdentityRegistry's `register(string)` / `setAgentURI`
 *     / `tokenURI` ARE compatible with this subset. (An EOA `register` via
 *     read-only `cast call` reverts `ERC721InvalidReceiver` only because eth_call
 *     has `msg.sender == address(0)` and `_safeMint` rejects the zero receiver — a
 *     real transaction works, as the fork test shows.)
 *   - Reputation: the canonical ReputationRegistry is a richer, permissionless,
 *     client-keyed ledger — `giveFeedback(...)` / `readFeedback` / `getSummary`,
 *     NOT this single `appendFeedback`. `CustosReputationRegistry` is therefore a
 *     simplified, role-gated stand-in for fallback deployments only; production
 *     reputation writes go through `ICanonicalReputationRegistry.giveFeedback`.
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
 *         outcome/feedback signals for an agent. Custos uses it to publish each
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
