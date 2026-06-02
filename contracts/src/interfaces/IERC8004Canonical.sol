// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IERC8004Canonical — the REAL deployed erc-8004 registry ABIs on Mantle
 * @notice These interfaces mirror the canonical Trustless Agents singletons live on
 *         Mantle (IdentityRegistry `0x8004A169…`, ReputationRegistry `0x8004BAa…`),
 *         generated from erc-8004/erc-8004-contracts. Custos registers against
 *         and reads from THESE in production (per SPEC §2.5 "if the singletons exist,
 *         call them"). The simplified `IERC8004.sol` interface + the `Custos*`
 *         registries are the fallback used only when the singletons are absent.
 *
 * Only the subset Custos actually calls is declared here (the registries also
 * expose full ERC-721, UUPS-upgrade, metadata, and agent-wallet surfaces).
 */

/**
 * @notice Canonical IdentityRegistry (ERC-721 + URIStorage, UUPS proxy).
 * @dev `register(string)` mints the next agent id to `msg.sender` and stores the
 *      agent-card URI. NOTE: it `_safeMint`s, so the caller must be able to receive
 *      an ERC-721 (an EOA is fine). A read-only `eth_call` (e.g. `cast call`) has
 *      `msg.sender == address(0)` and therefore reverts `ERC721InvalidReceiver`;
 *      use an actual transaction / `vm.prank` with a non-zero sender.
 */
interface ICanonicalIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata newURI) external;
    function tokenURI(uint256 agentId) external view returns (string memory);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/**
 * @notice Canonical ReputationRegistry — an open, client-keyed feedback ledger.
 * @dev Unlike the simplified `IReputationRegistry` (a single `appendFeedback`), the
 *      canonical model is permissionless: anyone (`clientAddress == msg.sender`) may
 *      `giveFeedback` about an agent, feedback is indexed per (agentId, client), and
 *      `getSummary` aggregates a signed value with decimals. Custos publishes each
 *      decision outcome (e.g. passive-baseline delta) via `giveFeedback`; `value` is
 *      the signed score, `valueDecimals` its fixed-point scale, `tag1`/`tag2` the
 *      topic (e.g. "DERISK"/"passiveDeltaBps"), and `feedbackURI`/`feedbackHash`
 *      bind the IPFS evidence.
 */
interface ICanonicalReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (
            int128 value,
            uint8 valueDecimals,
            string memory tag1,
            string memory tag2,
            bool isRevoked
        );

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function getIdentityRegistry() external view returns (address);
}
