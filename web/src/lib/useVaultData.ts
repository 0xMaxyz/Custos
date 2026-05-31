// Vault data seam (ROADMAP 4.4).
//
// DEFERRED: live on-chain reads require a deployed Sentinel vault address on
// Mantle testnet, which does not exist yet (Phase 1 deploy is pending). Until
// then this hook returns the canonical typed fixtures so the dashboard renders
// an accurate *shape*. When the vault ships, swap the body for wagmi
// `useReadContract` calls (TVL, share price, blended APY, bucket weights) keyed
// off `VITE_VAULT_ADDRESS` — the consumer components do not change.

import { vault, position, baseline, type VaultState, type PositionState } from "./data";

export interface VaultData {
  vault: VaultState;
  position: PositionState;
  baseline: typeof baseline;
  /** true once reads come from chain; false while served from fixtures. */
  isLive: boolean;
}

export function useVaultData(): VaultData {
  // TODO(phase-1-deploy): replace with useReadContract once VITE_VAULT_ADDRESS is set.
  return { vault, position, baseline, isLive: false };
}
