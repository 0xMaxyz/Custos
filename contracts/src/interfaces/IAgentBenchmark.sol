// SPDX-License-Identifier: MIT
// Custos — AI risk-guardian real-yield account on Mantle.
pragma solidity 0.8.28;

/**
 * @title IAgentBenchmark
 * @notice On-chain ledger of agent decisions, realized outcomes, and the
 *         passive-USDY baseline delta
 */
interface IAgentBenchmark {
    struct Outcome {
        int256 realizedYieldBps; // agent yield vs prior decision (bps)
        uint256 drawdownAvoidedUsdc; // estimated loss avoided on de-risk events (6-dec USDC)
        int256 passiveDeltaBps; // Custos outperformance vs 100%-USDY passive holder (bps)
        uint64 measuredAt; // unix timestamp of outcome measurement
    }

    /**
     * @notice Record a new agent decision.  Called by YieldVault.
     * @param decisionId         Monotonic id (from vault's decisionCount).
     * @param rationaleHash      keccak256 of the LLM rationale text.
     * @param decisionURI        IPFS URI of the rationale + evidence bundle.
     * @param usdyNavAtDecision  USDY oracle NAV (18-dec) at decision time —
     *                           used as passive-baseline snapshot.
     */
    function recordDecision(
        uint256 decisionId,
        bytes32 rationaleHash,
        string calldata decisionURI,
        uint256 usdyNavAtDecision
    ) external;

    /**
     * @notice Write realized outcome for a decision.  Called by ALLOCATOR/keeper.
     * @dev Append-only: callable once per decision. The implementation stamps
     *      `measuredAt` from `block.timestamp`; the caller-supplied `o.measuredAt`
     *      is ignored.
     */
    function updateOutcome(uint256 decisionId, Outcome calldata o) external;

    function decisionCount() external view returns (uint256);
    function outcomeOf(uint256 decisionId) external view returns (Outcome memory);
    function navAtDecision(uint256 decisionId) external view returns (uint256);

    event DecisionRecorded(
        uint256 indexed decisionId,
        bytes32 rationaleHash,
        string decisionURI,
        uint256 usdyNavAtDecision
    );
    event OutcomeUpdated(
        uint256 indexed decisionId,
        int256 realizedYieldBps,
        uint256 drawdownAvoidedUsdc,
        int256 passiveDeltaBps
    );
}
