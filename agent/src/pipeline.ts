import { getAddress, type PublicClient } from "viem";
import { Bucket, PROTOCOLS, TOKENS } from "@custos/shared";

import type { AgentConfig } from "./config.js";
import { makeClients, type ChainClients } from "./chain/clients.js";
import { erc20Abi, strategyAdapterAbi, yieldVaultAbi } from "./chain/abis.js";
import { OneDeltaClient } from "./data/oneDelta.js";
import { readUsdyOracle } from "./data/readers.js";
import { ApySampler } from "./data/apySampler.js";
import { Snapshotter, type SnapshotSources } from "./data/snapshot.js";
import type { WeightsBps } from "./types.js";

/**
 * Composition root: wire viem clients + the 1delta client into concrete
 * {@link SnapshotSources}, then a {@link Snapshotter}. Pulls protocol addresses
 * from `packages/shared` so there is a single source of truth.
 *
 * Throws if a required address is unresolved (still `null` in shared), surfacing
 * the Phase-0 gate dependency explicitly rather than failing deep in a read.
 */

export interface Pipeline {
  readonly clients: ChainClients;
  readonly oneDelta: OneDeltaClient;
  readonly snapshotter: Snapshotter;
}

function requireAddress(value: string | null | undefined, name: string): `0x${string}` {
  if (value === null || value === undefined) {
    throw new Error(`address "${name}" is unresolved in @custos/shared (Phase-0 gate pending)`);
  }
  return getAddress(value);
}

export function buildPipeline(config: AgentConfig): Pipeline {
  const clients = makeClients(config);
  const oneDelta = new OneDeltaClient(config);
  const apySampler = new ApySampler();

  const oracleAddr = requireAddress(PROTOCOLS.usdyRWADynamicOracle, "usdyRWADynamicOracle");
  const vaultAddr = config.vaultAddress === undefined ? undefined : getAddress(config.vaultAddress);

  const sources: SnapshotSources = {
    oracle: async () => {
      const { navUsdc, rangeEnd } = await readUsdyOracle(clients.publicClient, oracleAddr);
      // The Ondo oracle has no updatedAt; rely on rangeEnd for staleness.
      return { navUsdc, rangeEnd, updatedAt: 0 };
    },
    usdyImpliedApyBps: async () => {
      const { navUsdc } = await readUsdyOracle(clients.publicClient, oracleAddr);
      return apySampler.sample(navUsdc);
    },
    aaveMarket: () => oneDelta.getAaveUsdcMarket(),
    usdyDexSpotUsdc: () => oneDelta.getUsdyDexSpotUsdc(),
    ausdBackingRatioBps: () => oneDelta.getAusdBackingRatioBps(),
    vaultState: () => readVaultState(clients.publicClient, vaultAddr),
  };

  const snapshotter = new Snapshotter(sources);
  return { clients, oneDelta, snapshotter };
}

/**
 * Read vault TVL, Aave-withdrawable, and current per-bucket weights. When no vault
 * is configured (read-only dev before deploy), returns an empty all-idle state.
 */
async function readVaultState(
  client: PublicClient,
  vault: `0x${string}` | undefined,
): Promise<{
  totalAssetsUsdc: bigint;
  aaveWithdrawableUsdc: bigint;
  currentWeightsBps: WeightsBps;
}> {
  if (vault === undefined) {
    return {
      totalAssetsUsdc: 0n,
      aaveWithdrawableUsdc: 0n,
      currentWeightsBps: {
        [Bucket.IDLE]: 10_000,
        [Bucket.AAVE]: 0,
        [Bucket.USDY]: 0,
        [Bucket.AUSD]: 0,
      },
    };
  }

  const totalAssets = await client.readContract({
    address: vault,
    abi: yieldVaultAbi,
    functionName: "totalAssets",
  });

  const idle = await client.readContract({
    address: getAddress(TOKENS.USDC.address),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [vault],
  });

  // Per-bucket adapter values (bucket 0 = idle has no adapter).
  const bucketValues: Record<Bucket, bigint> = {
    [Bucket.IDLE]: idle,
    [Bucket.AAVE]: 0n,
    [Bucket.USDY]: 0n,
    [Bucket.AUSD]: 0n,
  };
  let aaveWithdrawable = 0n;

  for (const bucket of [Bucket.AAVE, Bucket.USDY, Bucket.AUSD] as const) {
    const adapter = await client.readContract({
      address: vault,
      abi: yieldVaultAbi,
      functionName: "adapters",
      args: [BigInt(bucket)],
    });
    if (adapter === "0x0000000000000000000000000000000000000000") continue;

    bucketValues[bucket] = await client.readContract({
      address: adapter,
      abi: strategyAdapterAbi,
      functionName: "totalAssets",
    });
    if (bucket === Bucket.AAVE) {
      aaveWithdrawable = await client.readContract({
        address: adapter,
        abi: strategyAdapterAbi,
        functionName: "maxWithdrawable",
      });
    }
  }

  return {
    totalAssetsUsdc: totalAssets,
    aaveWithdrawableUsdc: aaveWithdrawable,
    currentWeightsBps: toWeightsBps(bucketValues, totalAssets),
  };
}

/** Convert per-bucket USDC values into bps weights, routing the remainder to IDLE. */
function toWeightsBps(values: Record<Bucket, bigint>, tvl: bigint): WeightsBps {
  if (tvl <= 0n) {
    return { [Bucket.IDLE]: 10_000, [Bucket.AAVE]: 0, [Bucket.USDY]: 0, [Bucket.AUSD]: 0 };
  }
  const w: WeightsBps = {
    [Bucket.IDLE]: Number((values[Bucket.IDLE] * 10_000n) / tvl),
    [Bucket.AAVE]: Number((values[Bucket.AAVE] * 10_000n) / tvl),
    [Bucket.USDY]: Number((values[Bucket.USDY] * 10_000n) / tvl),
    [Bucket.AUSD]: Number((values[Bucket.AUSD] * 10_000n) / tvl),
  };
  const drift = 10_000 - (w[Bucket.IDLE] + w[Bucket.AAVE] + w[Bucket.USDY] + w[Bucket.AUSD]);
  w[Bucket.IDLE] += drift;
  return w;
}
