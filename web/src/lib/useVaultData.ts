// Vault data seam (ROADMAP 4.4 / 5.1).
//
// Returns live on-chain reads when VITE_VAULT_ADDRESS is set; falls back to
// typed fixtures so the dashboard renders correctly before deploy. Consumer
// components are unchanged in either path.

import { useReadContracts } from "wagmi";
import { formatUnits }      from "viem";
import { vault as vaultFixture, position as posFixture, baseline, type VaultState, type PositionState } from "./data";
import { VAULT_ABI }        from "./vaultAbi";

const VAULT_ADDRESS = (import.meta.env.VITE_VAULT_ADDRESS ?? "") as `0x${string}`;
const isDeployed = VAULT_ADDRESS.length > 2;

export interface VaultData {
  vault: VaultState;
  position: PositionState;
  baseline: typeof baseline;
  /** true once reads come from chain; false while served from fixtures. */
  isLive: boolean;
}

export function useVaultData(account?: `0x${string}`): VaultData {
  const { data } = useReadContracts({
    contracts: [
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "totalAssets" },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "convertToAssets", args: [1_000_000n] },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "balanceOf", args: [account ?? "0x0000000000000000000000000000000000000000"] },
    ],
    query: {
      enabled: isDeployed,
      refetchInterval: isDeployed ? 15_000 : false,
    },
  });

  const tvlEntry     = data?.[0];
  const sharePxEntry = data?.[1];

  if (!isDeployed || !tvlEntry || !sharePxEntry || tvlEntry.status !== "success" || sharePxEntry.status !== "success") {
    return { vault: vaultFixture, position: posFixture, baseline, isLive: false };
  }

  const tvlRaw     = tvlEntry.result as bigint;
  const sharePxRaw = sharePxEntry.result as bigint; // assets per 1e6 shares

  const tvlUsdc    = formatUnits(tvlRaw, 6);
  // sharePxRaw = assets per 1e6 shares (i.e. price * 1e6). Use formatUnits to
  // keep bigint precision throughout rather than Number() lossy conversion.
  const sharePrice = formatUnits(sharePxRaw, 6);

  let positionShares = 0n;
  const balEntry = data[2];
  if (account && balEntry && balEntry.status === "success") {
    positionShares = balEntry.result as bigint;
  }
  const posValueRaw = positionShares > 0n
    ? (positionShares * sharePxRaw) / 1_000_000n
    : 0n;

  const liveVault: VaultState = {
    ...vaultFixture,
    tvlUsdc,
    sharePrice,
  };

  const livePosition: PositionState = {
    ...posFixture,
    shares: formatUnits(positionShares, 6),
    valueUsdc: formatUnits(posValueRaw, 6),
    sharePrice,
  };

  return { vault: liveVault, position: livePosition, baseline, isLive: true };
}
