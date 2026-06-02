// Vault data seam (ROADMAP 4.4 / 5.1).
//
// Reads LIVE on-chain by default: the vault address is resolved from the active
// chain via @custos/shared (resolveDeployment), so a deployed chain needs no
// env. Falls back to typed fixtures only when no vault is resolvable for the
// chain (e.g. mainnet before deploy) or VITE_DEMO_MODE=true. Consumers unchanged.
//
// Live fields: totalAssets (TVL), share price, the caller's position, the
// allocation donut (idle + each adapter's totalAssets), kill-switch, and the
// latest AgentBenchmark outcome. APY/peg/oracle figures are agent-computed
// (off-chain) and remain fixture-backed here — the Insights radar serves those
// live from the agent's /snapshot.

import { useReadContracts, useReadContract, useChainId } from "wagmi";
import { formatUnits }      from "viem";
import { vault as vaultFixture, position as posFixture, baseline as baselineFixture, type VaultState, type PositionState } from "./data";
import { VAULT_ABI, BENCHMARK_ABI, ADAPTER_ABI } from "./vaultAbi";
import { resolveDeployment, computeWeightsBps } from "./deployment";

export interface VaultData {
  vault: VaultState;
  position: PositionState;
  baseline: typeof baselineFixture;
  /** Underlying ERC-20 (USDC) address — from vault.asset(); empty string before deploy. */
  usdcAddress: `0x${string}` | "";
  /** true once reads come from chain; false while served from fixtures. */
  isLive: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const asBigInt = (v: unknown): bigint => (typeof v === "bigint" ? v : 0n);

export function useVaultData(account?: `0x${string}`): VaultData {
  const chainId = useChainId();
  const dep = resolveDeployment(chainId);
  const VAULT_ADDRESS = dep.vault || undefined; // 0x… | undefined for wagmi reads
  const isDeployed = Boolean(VAULT_ADDRESS);

  // Step 1: vault core + metadata + kill switch.
  const { data: vaultData } = useReadContracts({
    contracts: [
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "totalAssets", chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "convertToAssets", args: [1_000_000n], chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "balanceOf", args: [account ?? ZERO], chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "asset", chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "benchmark", chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "isKilled", chainId },
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
  const killedEntry    = vaultData?.[5];

  const usdcAddress: `0x${string}` | "" =
    usdcAddrEntry?.status === "success" ? (usdcAddrEntry.result as `0x${string}`) : "";

  const benchmarkAddress: `0x${string}` | "" =
    benchmarkEntry?.status === "success" && benchmarkEntry.result !== ZERO
      ? (benchmarkEntry.result as `0x${string}`)
      : "";

  // Step 2: per-bucket valuation for the allocation donut. Each adapter values
  // its bucket in USDC; idle is whatever TVL isn't held by an adapter.
  const aaveTA = useReadContract({
    address: dep.aaveAdapter || undefined, abi: ADAPTER_ABI, functionName: "totalAssets", chainId,
    query: { enabled: isDeployed && dep.aaveAdapter.length > 2, refetchInterval: 15_000 },
  });
  const usdyTA = useReadContract({
    address: dep.usdyAdapter || undefined, abi: ADAPTER_ABI, functionName: "totalAssets", chainId,
    query: { enabled: isDeployed && dep.usdyAdapter.length > 2, refetchInterval: 15_000 },
  });
  const ausdTA = useReadContract({
    address: dep.ausdAdapter || undefined, abi: ADAPTER_ABI, functionName: "totalAssets", chainId,
    query: { enabled: isDeployed && dep.ausdAdapter.length > 2, refetchInterval: 15_000 },
  });

  // Step 3: benchmark decision count -> latest outcome.
  const { data: bmCountData } = useReadContracts({
    contracts: benchmarkAddress
      ? [{ address: benchmarkAddress, abi: BENCHMARK_ABI, functionName: "decisionCount", chainId }]
      : [],
    query: {
      enabled: isDeployed && benchmarkAddress.length > 2,
      refetchInterval: isDeployed ? 30_000 : false,
    },
  });

  const decisionCount = bmCountData?.[0]?.status === "success"
    ? Number(bmCountData[0].result as bigint)
    : 0;

  const latestOutcomeId = decisionCount > 0 ? BigInt(decisionCount - 1) : 0n;
  const { data: outcomeData } = useReadContracts({
    contracts: decisionCount > 0 && benchmarkAddress
      ? [{ address: benchmarkAddress, abi: BENCHMARK_ABI, functionName: "outcomeOf", args: [latestOutcomeId], chainId }]
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

  // Live allocation: idle = TVL not held by any adapter (clamped at 0).
  const aave = asBigInt(aaveTA.data);
  const usdy = asBigInt(usdyTA.data);
  const ausd = asBigInt(ausdTA.data);
  const heldByAdapters = aave + usdy + ausd;
  const idle = tvlRaw > heldByAdapters ? tvlRaw - heldByAdapters : 0n;
  const weightsBps = computeWeightsBps({ idle, aave, usdy, ausd });

  const killed = killedEntry?.status === "success" ? Boolean(killedEntry.result) : vaultFixture.killed;

  const liveVault: VaultState = {
    ...vaultFixture,
    tvlUsdc,
    sharePrice,
    weightsBps,
    killed,
    // Instant liquidity = idle + the Aave floor (the synchronously-redeemable buckets).
    instantWithdrawableUsdc: formatUnits(idle + aave, 6),
  };

  const livePosition: PositionState = {
    ...posFixture,
    shares: formatUnits(positionShares, 6),
    valueUsdc: formatUnits(posValueRaw, 6),
    sharePrice,
  };

  // Build live baseline from the latest on-chain outcome when available.
  // In live mode with no on-chain history yet, start from a ZEROED baseline (not
  // the demo fixture) so a fresh/empty vault never shows fictional outperformance.
  // When an outcome exists we clear custosSeries/passiveSeries so computeBaseline()
  // derives the headline delta from on-chain passiveDeltaBps. Phase 5b backfills
  // the full series from benchmark history.
  let liveBaseline: typeof baselineFixture = {
    ...baselineFixture,
    passiveDeltaBps: 0,
    drawdownAvoidedUsdc: "0.00",
    realizedYieldBps: 0,
    sinceDecisionId: 0,
    custosSeries: [],
    passiveSeries: [],
  };
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
      custosSeries: [],
      passiveSeries:  [],
    };
  }

  return { vault: liveVault, position: livePosition, baseline: liveBaseline, usdcAddress, isLive: true };
}
