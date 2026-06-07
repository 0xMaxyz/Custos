// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IERC8183 } from "./interfaces/IERC8183.sol";

/**
 * @title CustosJobEscrow
 * @notice ERC-8183 verifiable-job escrow (ROADMAP A4.2). Each Job escrows a budget in
 *         a single immutable settlement asset (USDC); the Client funds it, the Provider
 *         submits a deliverable, and the Evaluator attests completion (pays the provider)
 *         or rejection (refunds the client). Used to model each de-risk as a verifiable,
 *         guardrail-gated Job — the deterministic guardrail check is the Evaluator (see
 *         CustosDeRiskEvaluator), so a de-risk only "settles" when guardrails justify it.
 *
 * This contract is NOT in the vault custody path: it escrows a small per-job bounty, never
 * user deposits. The on-chain Guardrails remain the sole authority over vault funds; this
 * layer only produces a verifiable, reputation-feeding record of risk calls.
 */
contract CustosJobEscrow is IERC8183, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error BadExpiry();
    error UnknownJob(uint256 jobId);
    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error WrongStatus(JobStatus expected, JobStatus actual);
    error BudgetUnset();
    error NotExpired();

    // ── State ──────────────────────────────────────────────────────────────────

    /// @notice The single settlement asset budgets are escrowed in (e.g. USDC).
    IERC20 public immutable ASSET;

    /// @notice Last created job id (ids start at 1; 0 = none).
    uint256 public lastJobId;

    mapping(uint256 => Job) private _jobs;

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address asset) {
        if (asset == address(0)) revert ZeroAddress();
        ASSET = IERC20(asset);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    /// @inheritdoc IERC8183
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external override returns (uint256 jobId) {
        if (provider == address(0) || evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp) revert BadExpiry();

        jobId = ++lastJobId;
        Job storage j = _jobs[jobId];
        j.client = msg.sender;
        j.provider = provider;
        j.evaluator = evaluator;
        j.expiredAt = expiredAt;
        j.description = description;
        j.hook = hook;
        j.status = JobStatus.Open;

        emit JobCreated(jobId, msg.sender, provider, evaluator, description);
    }

    /// @inheritdoc IERC8183
    /// @dev Client-only, before funding (status Open).
    function setProvider(uint256 jobId, address provider) external override {
        if (provider == address(0)) revert ZeroAddress();
        Job storage j = _job(jobId);
        _onlyClient(j);
        _requireStatus(j, JobStatus.Open);
        j.provider = provider;
        emit ProviderSet(jobId, provider);
    }

    /// @inheritdoc IERC8183
    /// @dev Client-only, before funding (status Open). `optParams` reserved.
    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external override {
        Job storage j = _job(jobId);
        _onlyClient(j);
        _requireStatus(j, JobStatus.Open);
        j.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    /// @inheritdoc IERC8183
    /// @dev Client funds the agreed budget (Open → Funded). Pulls `budget` of ASSET.
    function fund(uint256 jobId, bytes calldata) external override nonReentrant {
        Job storage j = _job(jobId);
        _onlyClient(j);
        _requireStatus(j, JobStatus.Open);
        // provider is guaranteed non-zero by createJob + setProvider.
        if (j.budget == 0) revert BudgetUnset();

        j.status = JobStatus.Funded;
        ASSET.safeTransferFrom(msg.sender, address(this), j.budget);
        emit JobFunded(jobId, j.budget);
    }

    /// @inheritdoc IERC8183
    /// @dev Provider submits the deliverable (Funded → Submitted).
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external override {
        Job storage j = _job(jobId);
        if (msg.sender != j.provider) revert NotProvider();
        _requireStatus(j, JobStatus.Funded);
        j.deliverable = deliverable;
        j.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, deliverable);
    }

    /// @inheritdoc IERC8183
    /// @dev Evaluator completes a submitted job (Submitted → Completed) → pays provider.
    function complete(uint256 jobId, bytes32 reason, bytes calldata)
        external
        override
        nonReentrant
    {
        Job storage j = _job(jobId);
        if (msg.sender != j.evaluator) revert NotEvaluator();
        _requireStatus(j, JobStatus.Submitted);

        j.status = JobStatus.Completed;
        uint256 amount = j.budget;
        address provider = j.provider;
        emit JobCompleted(jobId, reason);
        if (amount > 0) {
            ASSET.safeTransfer(provider, amount);
            emit PaymentReleased(jobId, provider, amount);
        }
    }

    /// @inheritdoc IERC8183
    /// @dev Reject a job. Client may reject while Open (no funds); Evaluator may reject
    ///      while Funded or Submitted → client refunded.
    function reject(uint256 jobId, bytes32 reason, bytes calldata) external override nonReentrant {
        Job storage j = _job(jobId);

        if (j.status == JobStatus.Open) {
            _onlyClient(j);
            j.status = JobStatus.Rejected;
            emit JobRejected(jobId, reason);
            return;
        }

        if (j.status == JobStatus.Funded || j.status == JobStatus.Submitted) {
            if (msg.sender != j.evaluator) revert NotEvaluator();
            j.status = JobStatus.Rejected;
            uint256 amount = j.budget;
            address client = j.client;
            emit JobRejected(jobId, reason);
            if (amount > 0) {
                ASSET.safeTransfer(client, amount);
                emit Refunded(jobId, client, amount);
            }
            return;
        }

        revert WrongStatus(JobStatus.Submitted, j.status);
    }

    /// @inheritdoc IERC8183
    /// @dev Anyone may reclaim a funded-but-unsettled job's budget for the client once
    ///      it has expired (Funded/Submitted → Expired).
    function claimRefund(uint256 jobId) external override nonReentrant {
        Job storage j = _job(jobId);
        if (j.status != JobStatus.Funded && j.status != JobStatus.Submitted) {
            revert WrongStatus(JobStatus.Funded, j.status);
        }
        if (block.timestamp < j.expiredAt) revert NotExpired();

        j.status = JobStatus.Expired;
        uint256 amount = j.budget;
        address client = j.client;
        emit JobExpired(jobId);
        if (amount > 0) {
            ASSET.safeTransfer(client, amount);
            emit Refunded(jobId, client, amount);
        }
    }

    /// @inheritdoc IERC8183
    function getJob(uint256 jobId) external view override returns (Job memory) {
        return _job(jobId);
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    function _job(uint256 jobId) private view returns (Job storage j) {
        j = _jobs[jobId];
        if (j.client == address(0)) revert UnknownJob(jobId);
    }

    function _onlyClient(Job storage j) private view {
        if (msg.sender != j.client) revert NotClient();
    }

    function _requireStatus(Job storage j, JobStatus expected) private view {
        if (j.status != expected) revert WrongStatus(expected, j.status);
    }
}
