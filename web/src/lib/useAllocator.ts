// Allocator-role seam for the manual rebalance panel (Agent page).
//
// Reads whether the connected account holds the on-chain ALLOCATOR role on the
// active chain's vault, plus the last-rebalance timestamp (for the 1-hour
// interval guardrail). Returns isAllocator:false whenever no vault is resolvable
// for the chain (fixtures / pre-deploy), so the panel simply never appears.

import { useReadContracts, useChainId } from "wagmi";
import { keccak256, toBytes } from "viem";
import { VAULT_ABI } from "./vaultAbi";
import { resolveDeployment } from "./deployment";

// Roles.ALLOCATOR === keccak256("ALLOCATOR") (contracts/src/Roles.sol).
export const ALLOCATOR_ROLE = keccak256(toBytes("ALLOCATOR"));

export interface AllocatorState {
  /** True when the connected account holds ALLOCATOR on the live vault. */
  isAllocator: boolean;
  /** Unix seconds of the last rebalance (0 if never / not live). */
  lastRebalanceAt: number;
  /** Whether a live vault is resolvable for the chain. */
  isLive: boolean;
}

export function useAllocator(account?: `0x${string}`): AllocatorState {
  const chainId = useChainId();
  const vault = resolveDeployment(chainId).vault || undefined;
  const enabled = Boolean(vault) && Boolean(account);

  const { data } = useReadContracts({
    contracts: [
      { address: vault, abi: VAULT_ABI, functionName: "hasRole", args: [ALLOCATOR_ROLE, account ?? "0x0000000000000000000000000000000000000000"], chainId },
      { address: vault, abi: VAULT_ABI, functionName: "lastRebalanceAt", chainId },
    ],
    query: { enabled, refetchInterval: enabled ? 30_000 : false },
  });

  const isAllocator = data?.[0]?.status === "success" ? Boolean(data[0].result) : false;
  const lastRebalanceAt = data?.[1]?.status === "success" ? Number(data[1].result as bigint) : 0;
  return { isAllocator, lastRebalanceAt, isLive: Boolean(vault) };
}
