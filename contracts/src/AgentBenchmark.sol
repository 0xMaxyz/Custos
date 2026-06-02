// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {Roles}           from "./Roles.sol";
import {IAgentBenchmark} from "./interfaces/IAgentBenchmark.sol";

/**
 * @title AgentBenchmark
 * @notice Immutable on-chain ledger of agent decisions, realized outcomes, and
 *         the passive-USDY baseline delta.
 *
 * The "Turing Test on-chain": for each decision the agent snaps the current
 * USDY oracle NAV. After the fact, the ALLOCATOR writes `updateOutcome` with:
 *   - `realizedYieldBps`    — agent's yield since prior decision
 *   - `drawdownAvoidedUsdc` — loss avoided on de-risk events
 *   - `passiveDeltaBps`     — how many bps better/worse than a passive 100%-USDY
 *     holder (positive = Custos protected, negative = missed yield)
 *
 * Only the YieldVault may call `recordDecision`; only ALLOCATOR may call
 * `updateOutcome` (or a designated keeper granted ALLOCATOR).
 */
contract AgentBenchmark is IAgentBenchmark, AccessControl {
    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyVault();
    error DecisionNotFound();
    error OutcomeAlreadySet();

    // ── State ─────────────────────────────────────────────────────────────────

    address public immutable VAULT;

    /// @notice Monotonic count of recorded decisions (mirrors vault decisionCount).
    uint256 public override decisionCount;

    /// @dev oracle NAV snapshot at the time each decision was recorded.
    mapping(uint256 => uint256) private _navAtDecision;

    /// @dev full outcome records (written by ALLOCATOR post-facto).
    mapping(uint256 => Outcome) private _outcomes;

    /// @dev whether a decision id has been recorded.
    mapping(uint256 => bool) private _recorded;

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param vault  YieldVault address (sole permitted caller of recordDecision).
     * @param admin  Address granted ADMIN + DEFAULT_ADMIN_ROLE (also grants ALLOCATOR).
     */
    constructor(address vault, address admin) {
        VAULT = vault;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN, admin);
    }

    // ── IAgentBenchmark ───────────────────────────────────────────────────────

    /// @inheritdoc IAgentBenchmark
    function recordDecision(
        uint256 decisionId,
        bytes32 rationaleHash,
        string  calldata decisionURI,
        uint256 usdyNavAtDecision
    ) external override {
        if (msg.sender != VAULT) revert OnlyVault();
        _recorded[decisionId] = true;
        _navAtDecision[decisionId] = usdyNavAtDecision;
        decisionCount++;
        emit DecisionRecorded(decisionId, rationaleHash, decisionURI, usdyNavAtDecision);
    }

    /// @inheritdoc IAgentBenchmark
    function updateOutcome(uint256 decisionId, Outcome calldata o)
        external
        override
        onlyRole(Roles.ALLOCATOR)
    {
        if (!_recorded[decisionId]) revert DecisionNotFound();
        if (_outcomes[decisionId].measuredAt != 0) revert OutcomeAlreadySet();
        _outcomes[decisionId] = o;
        emit OutcomeUpdated(decisionId, o.realizedYieldBps, o.drawdownAvoidedUsdc, o.passiveDeltaBps);
    }

    /// @inheritdoc IAgentBenchmark
    function outcomeOf(uint256 decisionId) external view override returns (Outcome memory) {
        return _outcomes[decisionId];
    }

    /// @inheritdoc IAgentBenchmark
    function navAtDecision(uint256 decisionId) external view override returns (uint256) {
        return _navAtDecision[decisionId];
    }

}
