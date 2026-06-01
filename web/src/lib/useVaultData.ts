// Vault data seam (ROADMAP 4.4 / 5.1).
//
// Returns live on-chain reads when VITE_VAULT_ADDRESS is set; falls back to
// typed fixtures so the dashboard renders correctly before deploy. Consumer
// components are unchanged in either path.
//
// Baseline (AgentBenchmark): reads decisionCount + latest outcomeOf from the
// benchmark contract (address from vault.benchmark()). Series arrays are
// fixture-backed until there is enough on-chain history to reconstruct them.

import { useReadContracts } from "wagmi";
import { formatUnits }      from "viem";
import { vault as vaultFixture, position as posFixture, baseline as baselineFixture, type VaultState, type PositionState } from "./data";
import { VAULT_ABI, BENCHMARK_ABI } from "./vaultAbi";

export const VAULT_ADDRESS = (import.meta.env.VITE_VAULT_ADDRESS ?? "") as `0x${string}`;
export const isDeployed = VAULT_ADDRESS.length > 2;

export interface VaultData {
  vault: VaultState;
  position: PositionState;
  baseline: typeof baselineFixture;
  /** Underlying ERC-20 (USDC) address — from vault.asset(); empty string before deploy. */
  usdcAddress: `0x${string}` | "";
  /** true once reads come from chain; false while served from fixtures. */
  isLive: boolean;
}

export function useVaultData(account?: `0x${string}`): VaultData {
  // Step 1: read vault core + metadata addresses.
  const { data: vaultData } = useReadContracts({
    contracts: [
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "totalAssets" },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "convertToAssets", args: [1_000_000n] },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "balanceOf", args: [account ?? "0x0000000000000000000000000000000000000000"] },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "asset" },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "benchmark" },
    ],
    query: {
      enabled: isDeployed,
      refetchInterval: isDeployed ? 15_000 : false,
    },
  });

  const tvlEntry       = vaultData?.[0];
  const sharePxEntry   = vaultData?.[1];
  const usdcAddrEntry  = vaultData?.[3];
  const benchmarkEntry = vaultData?.[4];

  const usdcAddress: `0x${string}` | "" =
    usdcAddrEntry?.status === "success" ? (usdcAddrEntry.result as `0x${string}`) : "";

  const benchmarkAddress: `0x${string}` | "" =
    benchmarkEntry?.status === "success" && benchmarkEntry.result !== "0x0000000000000000000000000000000000000000"
      ? (benchmarkEntry.result as `0x${string}`)
      : "";

  // Step 2: read benchmark decision count so we can fetch the latest outcome.
  const { data: bmCountData } = useReadContracts({
    contracts: benchmarkAddress
      ? [{ address: benchmarkAddress, abi: BENCHMARK_ABI, functionName: "decisionCount" }]
      : [],
    query: {
      enabled: isDeployed && benchmarkAddress.length > 2,
      refetchInterval: isDeployed ? 30_000 : false,
    },
  });

  const decisionCount = bmCountData?.[0]?.status === "success"
    ? Number(bmCountData[0].result as bigint)
    : 0;

  // Step 3: read the latest outcome (id = decisionCount - 1) when available.
  const latestOutcomeId = decisionCount > 0 ? BigInt(decisionCount - 1) : 0n;
  const { data: outcomeData } = useReadContracts({
    contracts: decisionCount > 0 && benchmarkAddress
      ? [{ address: benchmarkAddress, abi: BENCHMARK_ABI, functionName: "outcomeOf", args: [latestOutcomeId] }]
      : [],
    query: {
      enabled: isDeployed && decisionCount > 0 && benchmarkAddress.length > 2,
      refetchInterval: isDeployed ? 30_000 : false,
    },
  });

  if (!isDeployed || !tvlEntry || !sharePxEntry || tvlEntry.status !== "success" || sharePxEntry.status !== "success") {
    return { vault: vaultFixture, position: posFixture, baseline: baselineFixture, usdcAddress: "", isLive: false };
  }

  const tvlRaw     = tvlEntry.result as bigint;
  const sharePxRaw = sharePxEntry.result as bigint;

  const tvlUsdc    = formatUnits(tvlRaw, 6);
  const sharePrice = formatUnits(sharePxRaw, 6);

  let positionShares = 0n;
  const balEntry = vaultData[2];
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

  // Build live baseline from the latest on-chain outcome when available.
  // When on-chain data exists, clear sentinelSeries/passiveSeries so
  // computeBaseline() derives the headline delta from on-chain passiveDeltaBps
  // rather than from fixture series that would yield demo numbers (+0.48%).
  // Phase 5b will backfill the full series from benchmark history.
  let liveBaseline = baselineFixture;
  const rawOutcome = outcomeData?.[0];
  if (rawOutcome?.status === "success") {
    type RawOutcome = { realizedYieldBps: bigint; drawdownAvoidedUsdc: bigint; passiveDeltaBps: bigint; measuredAt: bigint };
    const o = rawOutcome.result as RawOutcome;
    liveBaseline = {
      ...baselineFixture,
      realizedYieldBps:    Number(o.realizedYieldBps),
      drawdownAvoidedUsdc: formatUnits(o.drawdownAvoidedUsdc, 6),
      passiveDeltaBps:     Number(o.passiveDeltaBps),
      measuredAt:          new Date(Number(o.measuredAt) * 1000).toISOString(),
      sinceDecisionId:     decisionCount > 0 ? decisionCount - 1 : 0,
      // Clear demo series so computeBaseline falls back to on-chain passiveDeltaBps.
      sentinelSeries: [],
      passiveSeries:  [],
    };
  }

  return { vault: liveVault, position: livePosition, baseline: liveBaseline, usdcAddress, isLive: true };
}
