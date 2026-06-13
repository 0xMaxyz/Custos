// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title Custos scaffold marker
/// @notice Placeholder so the Foundry project compiles before Phase 1 lands the
///         real `YieldVault`, adapters, and `Guardrails`. Carries the canonical
///         chain id as a compile-time sanity anchor.
library Custos {
    /// @dev Mantle mainnet chain id.
    uint256 internal constant MANTLE_CHAIN_ID = 5000;
}
