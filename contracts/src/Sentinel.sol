// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Sentinel scaffold marker
/// @notice Placeholder so the Foundry project compiles before Phase 1 lands the
///         real `YieldVault`, adapters, and `Guardrails`. Carries the canonical
///         chain id as a compile-time sanity anchor.
library Sentinel {
    /// @dev Mantle mainnet chain id.
    uint256 internal constant MANTLE_CHAIN_ID = 5000;
}
