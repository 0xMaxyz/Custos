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
// (off-chain), not produced here; the dashboard overlays them from the agent's
// /snapshot via lib/vaultMetrics (the Insights radar uses the same source).

import { useReadContracts, useReadContract, useChainId, usePublicClient } from "wagmi";
import { useState, useEffect } from "react";
import { formatUnits }      from "viem";
import { vault as vaultFixture, position as posFixture, baseline as baselineFixture, walletUsdcBalance, type VaultState, type PositionState } from "./data";
import { VAULT_ABI, BENCHMARK_ABI, ADAPTER_ABI } from "./vaultAbi";
import { resolveDeployment, computeWeightsBps } from "./deployment";
import { getLogsPaged } from "./useGuardianData";

// Deployment block hint: scope getLogs (deposited cost-basis) to avoid a full-chain
// scan on mainnet. Shared with useGuardianData via the same env var.
const DEPLOY_BLOCK = BigInt(import.meta.env.VITE_VAULT_DEPLOY_BLOCK ?? "0");

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export interface VaultData {
  vault: VaultState;
  position: PositionState;
  baseline: typeof baselineFixture;
  /** Underlying ERC-20 (USDC) address — from vault.asset(); empty string before deploy. */
  usdcAddress: `0x${string}` | "";
  /** Connected wallet's USDC balance (6-dec, formatted); fixture when not live. */
  walletUsdc: string;
  /** true once reads come from chain; false while served from fixtures. */
  isLive: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const asBigInt = (v: unknown): bigint => (typeof v === "bigint" ? v : 0n);

/**
 * Human "USDC per whole share" from a `convertToAssets(1e18)` probe.
 *
 * The probe returns the assets (asset-decimals, raw) backing 1e18 RAW shares. Vault
 * shares are `shareDecimals`-dec (12 here = asset 6 + offset 6), so 1e18 raw is
 * 1e(18-shareDecimals) WHOLE shares — not one. Rescale to a single whole share
 * (`convertToAssets` is linear) before formatting, else the price reads
 * 1e(18-shareDecimals)x too high (e.g. $1,000,000 instead of $1.00 at 12-dec).
 */
export function sharePriceFromProbe(probeRaw: bigint, shareDecimals: number, assetDecimals = 6): string {
  const perWholeShareRaw = (probeRaw * (10n ** BigInt(shareDecimals))) / (10n ** 18n);
  return formatUnits(perWholeShareRaw, assetDecimals);
}

export function useVaultData(account?: `0x${string}`): VaultData {
  const chainId = useChainId();
  const dep = resolveDeployment(chainId);
  const VAULT_ADDRESS = dep.vault || undefined; // 0x… | undefined for wagmi reads
  const isDeployed = Boolean(VAULT_ADDRESS);

  // Step 1: vault core + metadata + kill switch.
  const { data: vaultData } = useReadContracts({
    contracts: [
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "totalAssets", chainId },
      // USDC backing 1e18 RAW shares — a fixed high-precision probe (convertToAssets
      // is linear). Rescaled by the on-chain decimals() to a per-whole-share price
      // below; shares are 12-dec (asset 6 + offset 6), so 1e18 raw ≠ one whole share.
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "convertToAssets", args: [10n ** 18n], chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "balanceOf", args: [account ?? ZERO], chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "asset", chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "benchmark", chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "isKilled", chainId },
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "decimals", chainId },
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
  const decimalsEntry  = vaultData?.[6];

  // Vault share decimals (12 = asset 6 + _decimalsOffset 6; the contract's
  // _decimalsOffset() returns 6). Read on-chain — never hardcoded — so share<->raw
  // conversions track the deployed token; 12 is only the pre-read fallback.
  const shareDecimals: number =
    decimalsEntry?.status === "success" ? Number(decimalsEntry.result as number) : 12;

  const usdcAddress: `0x${string}` | "" =
    usdcAddrEntry?.status === "success" ? (usdcAddrEntry.result as `0x${string}`) : "";

  const benchmarkAddress: `0x${string}` | "" =
    benchmarkEntry?.status === "success" && benchmarkEntry.result !== ZERO
      ? (benchmarkEntry.result as `0x${string}`)
      : "";

  // Connected wallet's USDC balance (depends on the resolved asset address).
  const walletUsdcRead = useReadContract({
    address: usdcAddress || undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account ?? ZERO],
    chainId,
    query: { enabled: isDeployed && usdcAddress.length > 2 && Boolean(account), refetchInterval: 15_000 },
  });
  const walletUsdc = walletUsdcRead.data !== undefined ? formatUnits(walletUsdcRead.data as bigint, 6) : "0.00";

  // Deposited cost-basis: the vault (plain ERC-4626) tracks shares, not principal,
  // so net deposited = Σ Deposit.assets − Σ Withdraw.assets for this account, read
  // from events. all-time yield is then currentValue − netDeposited. null until the
  // logs resolve (deposited then falls back to current value → yield 0).
  const client = usePublicClient();
  const [costBasisRaw, setCostBasisRaw] = useState<bigint | null>(null);
  useEffect(() => {
    if (!isDeployed || !VAULT_ADDRESS || !account || !client) {
      setCostBasisRaw(null);
      return;
    }
    let cancelled = false;
    const head = () => client.getBlockNumber();
    const sumAssets = (logs: { args: unknown }[]) =>
      logs.reduce((s, l) => s + (((l.args as { assets?: bigint }).assets) ?? 0n), 0n);
    Promise.all([
      getLogsPaged(head, ({ fromBlock, toBlock }) => client.getLogs({
        address: VAULT_ADDRESS,
        event: { type: "event", name: "Deposit", inputs: [
          { name: "sender", type: "address", indexed: true },
          { name: "owner",  type: "address", indexed: true },
          { name: "assets", type: "uint256", indexed: false },
          { name: "shares", type: "uint256", indexed: false },
        ] },
        args: { owner: account },
        fromBlock, toBlock,
      }), DEPLOY_BLOCK),
      getLogsPaged(head, ({ fromBlock, toBlock }) => client.getLogs({
        address: VAULT_ADDRESS,
        event: { type: "event", name: "Withdraw", inputs: [
          { name: "sender",   type: "address", indexed: true },
          { name: "receiver", type: "address", indexed: true },
          { name: "owner",    type: "address", indexed: true },
          { name: "assets",   type: "uint256", indexed: false },
          { name: "shares",   type: "uint256", indexed: false },
        ] },
        args: { owner: account },
        fromBlock, toBlock,
      }), DEPLOY_BLOCK),
    ]).then(([deposits, withdraws]) => {
      if (cancelled) return;
      const net = sumAssets(deposits) - sumAssets(withdraws);
      setCostBasisRaw(net > 0n ? net : 0n);
    }).catch(() => { if (!cancelled) setCostBasisRaw(null); });
    return () => { cancelled = true; };
  }, [client, VAULT_ADDRESS, isDeployed, account]);

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
    return { vault: vaultFixture, position: posFixture, baseline: baselineFixture, usdcAddress: "", walletUsdc: walletUsdcBalance, isLive: false };
  }

  const tvlRaw     = tvlEntry.result as bigint;
  const sharePxRaw = sharePxEntry.result as bigint;

  const tvlUsdc    = formatUnits(tvlRaw, 6);
  // sharePxRaw = convertToAssets(1e18); rescale to one whole share (see helper).
  const sharePrice = sharePriceFromProbe(sharePxRaw, shareDecimals);

  let positionShares = 0n;
  const balEntry = vaultData[2];
  if (account && balEntry && balEntry.status === "success") {
    positionShares = balEntry.result as bigint;
  }
  const posValueRaw = positionShares > 0n
    ? (positionShares * sharePxRaw) / (10n ** 18n)
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

  // Deposited basis from events; before the logs resolve, fall back to current value
  // (so yield reads 0 rather than the fixture's $142.50). all-time yield can be < 0.
  const depositedRaw = costBasisRaw ?? posValueRaw;
  const yieldRaw = posValueRaw - depositedRaw;
  const livePosition: PositionState = {
    ...posFixture,
    shares: formatUnits(positionShares, shareDecimals),
    valueUsdc: formatUnits(posValueRaw, 6),
    depositedUsdc: formatUnits(depositedRaw, 6),
    allTimeYieldUsdc: yieldRaw >= 0n ? formatUnits(yieldRaw, 6) : `-${formatUnits(-yieldRaw, 6)}`,
    sharePrice,
    shareDecimals,
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

  return { vault: liveVault, position: livePosition, baseline: liveBaseline, usdcAddress, walletUsdc, isLive: true };
}
