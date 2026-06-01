// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { Roles } from "./Roles.sol";
import { Guardrails } from "./Guardrails.sol";
import { IERC8183 } from "./interfaces/IERC8183.sol";
import { IReputationRegistry } from "./interfaces/IERC8004.sol";

/**
 * @title SentinelDeRiskEvaluator
 * @notice The ERC-8183 **Evaluator** for de-risk Jobs (ROADMAP A4.2): the deterministic
 *         on-chain guardrail check decides whether a submitted de-risk Job settles. A Job
 *         is `complete`d (provider paid) only if `Guardrails.evaluateUsdyRisk` confirms the
 *         de-risk was justified (depeg/oracle guard tripped); otherwise it is `reject`ed
 *         (client refunded). On completion it writes the outcome to the ERC-8004
 *         ReputationRegistry, so the agent accrues a verifiable risk-call record.
 *
 *         This encodes the project thesis on-chain: LLM proposes → deterministic validator
 *         checks → guardrails are the final authority. The Evaluator never moves vault
 *         funds; it only releases/refuses an escrowed Job bounty and feeds reputation.
 *
 * Trust note: the caller (KEEPER, the agent hot key) supplies the `MarketState` — the same
 * snapshot the vault's `deRisk` path uses (oracle NAV read on-chain off the adapter, DEX
 * spot supplied off-chain). The guardrail evaluation of that state is fully deterministic.
 */
contract SentinelDeRiskEvaluator is AccessControl {
    // ── Roles ──────────────────────────────────────────────────────────────────

    /// @notice May submit a market snapshot for evaluation (the agent keeper).
    bytes32 public constant KEEPER = keccak256("KEEPER");

    /// @notice Reputation tag for de-risk outcomes.
    bytes32 public constant DERISK_TAG = bytes32("DERISK");

    // ── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotDeRiskJustified();

    // ── Events ─────────────────────────────────────────────────────────────────

    event JobEvaluated(
        address indexed escrow,
        uint256 indexed jobId,
        bool completed,
        uint8 riskLevel,
        int256 outcomeScore
    );

    // ── Immutables ─────────────────────────────────────────────────────────────

    Guardrails public immutable GUARDRAILS;
    IReputationRegistry public immutable REPUTATION;
    /// @notice ERC-8004 agent id whose reputation accrues de-risk outcomes.
    uint256 public immutable AGENT_ID;

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address guardrails, address reputation, uint256 agentId, address admin) {
        if (guardrails == address(0) || reputation == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        GUARDRAILS = Guardrails(guardrails);
        REPUTATION = IReputationRegistry(reputation);
        AGENT_ID = agentId;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN, admin);
        _grantRole(KEEPER, admin);
    }

    // ── Evaluation ─────────────────────────────────────────────────────────────

    /**
     * @notice Evaluate a submitted de-risk Job against the deterministic guardrail.
     *         Completes the Job (provider paid + reputation written) iff the guardrail
     *         says the de-risk was forced; otherwise rejects it (client refunded).
     * @param escrow       The ERC-8183 escrow holding the Job.
     * @param jobId        Job to evaluate (must be Submitted, with this contract as evaluator).
     * @param s            Market snapshot the guardrail evaluates (keeper-supplied).
     * @param outcomeScore Signed outcome metric recorded to reputation on completion
     *                     (e.g. drawdown-avoided bps); ignored on rejection.
     * @param feedbackUri  IPFS evidence URI bound to the reputation entry.
     * @param reason       Short on-chain reason recorded on the Job.
     * @return completed   True if the Job settled to the provider; false if rejected.
     */
    function evaluate(
        IERC8183 escrow,
        uint256 jobId,
        Guardrails.MarketState calldata s,
        int256 outcomeScore,
        string calldata feedbackUri,
        bytes32 reason
    ) external onlyRole(KEEPER) returns (bool completed) {
        (, bool forceDeRisk, uint8 riskLevel) = GUARDRAILS.evaluateUsdyRisk(s);

        if (forceDeRisk) {
            escrow.complete(jobId, reason, "");
            REPUTATION.appendFeedback(AGENT_ID, DERISK_TAG, outcomeScore, feedbackUri);
            completed = true;
        } else {
            escrow.reject(jobId, reason, "");
            completed = false;
        }

        emit JobEvaluated(address(escrow), jobId, completed, riskLevel, outcomeScore);
    }

    /// @notice Pure view of whether a snapshot would justify completing a de-risk Job.
    function wouldComplete(Guardrails.MarketState calldata s) external view returns (bool) {
        (, bool forceDeRisk,) = GUARDRAILS.evaluateUsdyRisk(s);
        return forceDeRisk;
    }
}
