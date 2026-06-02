// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { Roles } from "./Roles.sol";
import { Guardrails } from "./Guardrails.sol";
import { IERC8183 } from "./interfaces/IERC8183.sol";
import { IUsdyAdapter } from "./interfaces/IUsdyAdapter.sol";
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
 * Trust model (mirrors `YieldVault.deRisk`): the keeper supplies ONLY the USDY/USDC DEX
 * spot; the **oracle NAV + range end are read on-chain** from the pinned `RWA_ADAPTER`
 * (`UsdyAdapter.oracleData()`), so the keeper cannot fake the NAV to force a settlement.
 * The guardrail evaluation of that snapshot is fully deterministic.
 */
contract SentinelDeRiskEvaluator is AccessControl {
    // ── Roles ──────────────────────────────────────────────────────────────────

    /// @notice May submit a DEX spot for evaluation (the agent keeper).
    bytes32 public constant KEEPER = keccak256("KEEPER");

    /// @notice Reputation tag for de-risk outcomes.
    bytes32 public constant DERISK_TAG = bytes32("DERISK");

    // ── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();

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
    /// @notice The USDY adapter whose `oracleData()` is the on-chain NAV source.
    IUsdyAdapter public immutable RWA_ADAPTER;
    /// @notice ERC-8004 agent id whose reputation accrues de-risk outcomes.
    uint256 public immutable AGENT_ID;

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address guardrails, address reputation, address rwaAdapter, uint256 agentId, address admin) {
        if (guardrails == address(0) || reputation == address(0) || rwaAdapter == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        GUARDRAILS = Guardrails(guardrails);
        REPUTATION = IReputationRegistry(reputation);
        RWA_ADAPTER = IUsdyAdapter(rwaAdapter);
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
     * @param escrow          The ERC-8183 escrow holding the Job.
     * @param jobId           Job to evaluate (must be Submitted, with this contract as evaluator).
     * @param usdyDexSpotUsdc Keeper-supplied USDY/USDC DEX spot (18-dec); the oracle NAV is
     *                        read on-chain from `RWA_ADAPTER`.
     * @param outcomeScore    Signed outcome metric recorded to reputation on completion
     *                        (e.g. drawdown-avoided bps); ignored on rejection.
     * @param feedbackUri     IPFS evidence URI bound to the reputation entry.
     * @param reason          Short on-chain reason recorded on the Job.
     * @return completed      True if the Job settled to the provider; false if rejected.
     */
    function evaluate(
        IERC8183 escrow,
        uint256 jobId,
        uint256 usdyDexSpotUsdc,
        int256 outcomeScore,
        string calldata feedbackUri,
        bytes32 reason
    ) external onlyRole(KEEPER) returns (bool completed) {
        (, bool forceDeRisk, uint8 riskLevel) =
            GUARDRAILS.evaluateUsdyRisk(_buildMarketState(usdyDexSpotUsdc));

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

    /// @notice View of whether the current on-chain NAV + the supplied DEX spot would
    ///         justify completing a de-risk Job.
    function wouldComplete(uint256 usdyDexSpotUsdc) external view returns (bool) {
        (, bool forceDeRisk,) = GUARDRAILS.evaluateUsdyRisk(_buildMarketState(usdyDexSpotUsdc));
        return forceDeRisk;
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    /// @dev Builds the peg/oracle snapshot evaluateUsdyRisk needs: NAV + range end read
    ///      on-chain from the adapter, DEX spot from the keeper. The remaining MarketState
    ///      fields aren't inputs to the depeg/staleness check (mirrors
    ///      `YieldVault._buildMarketState`, which also leaves `oracleUpdatedAt` = 0).
    function _buildMarketState(uint256 usdyDexSpotUsdc)
        internal
        view
        returns (Guardrails.MarketState memory s)
    {
        (uint256 nav, uint64 rangeEnd) = RWA_ADAPTER.oracleData();
        s.usdyOracleNav = nav;
        s.oracleRangeEnd = rangeEnd;
        s.usdyDexSpot = usdyDexSpotUsdc;
    }
}
