// SPDX-License-Identifier: MIT
// Custos — AI risk-guardian real-yield account on Mantle.
pragma solidity 0.8.35;

/**
 * @title Roles
 * @notice Canonical role identifiers shared by YieldVault and Guardrails.
 *
 * Role hierarchy:
 *   ADMIN     — set guardrail config, add/remove strategies (timelocked), grant roles.
 *   ALLOCATOR — rebalance + deRisk within guardrails (agent hot key).
 *   GUARDIAN  — pause, unpause, deRisk, kill (no allocation power).
 *
 * DEFAULT_ADMIN_ROLE (from OZ AccessControl) bootstraps ADMIN at construction.
 */
library Roles {
    bytes32 internal constant ADMIN = keccak256("ADMIN");
    bytes32 internal constant ALLOCATOR = keccak256("ALLOCATOR");
    bytes32 internal constant GUARDIAN = keccak256("GUARDIAN");
}
