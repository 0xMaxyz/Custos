// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title IERC8183 — Agentic Commerce (verifiable escrowed jobs)
 * @notice Subset of the draft ERC-8183 standard (Virtuals + EF dAI) that Custos
 *         uses to model each de-risk as a verifiable, escrowed Job: a Client funds a
 *         budget, a Provider performs the work and submits a deliverable, and a single
 *         trusted Evaluator attests completion or rejection. Outcomes feed ERC-8004
 *         reputation (see CustosDeRiskEvaluator).
 *
 * State machine (per the spec):
 *   Open      → Funded     (client funds the agreed budget)
 *   Open      → Rejected   (client rejects)
 *   Funded    → Submitted  (provider submits the deliverable)
 *   Funded    → Rejected   (evaluator rejects)               → client refunded
 *   Funded    → Expired    (anyone, after expiry)            → client refunded
 *   Submitted → Completed  (evaluator completes)             → provider paid
 *   Submitted → Rejected   (evaluator rejects)               → client refunded
 *   Submitted → Expired    (anyone, after expiry)            → client refunded
 */
interface IERC8183 {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        address client;
        address provider;
        address evaluator;
        uint256 budget; // escrowed amount in the contract's settlement asset
        uint256 expiredAt; // unix ts after which the client can reclaim the budget
        bytes32 deliverable; // provider's submitted work reference (e.g. decisionURI hash)
        JobStatus status;
        string description;
        address hook; // optional extension hook (reserved; not invoked here)
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    function setProvider(uint256 jobId, address provider) external;

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;

    function fund(uint256 jobId, bytes calldata optParams) external;

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    function claimRefund(uint256 jobId) external;

    function getJob(uint256 jobId) external view returns (Job memory);

    // ── Events ─────────────────────────────────────────────────────────────────

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        string description
    );
    event ProviderSet(uint256 indexed jobId, address provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, uint256 budget);
    event JobSubmitted(uint256 indexed jobId, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, bytes32 reason);
    event JobRejected(uint256 indexed jobId, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed to, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed to, uint256 amount);
}
