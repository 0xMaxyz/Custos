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
    // The oracle is read ONCE per snapshot and feeds both the NAV/range fields and
    // the USDY-implied APY (previously two independent oracle reads — see #2). The
    // Ondo oracle has no updatedAt; rely on rangeEnd for staleness.
    oracle: async () => {
      const { navUsdc, rangeEnd } = await readUsdyOracle(clients.publicClient, oracleAddr);
      return { navUsdc, rangeEnd, updatedAt: 0, impliedApyBps: apySampler.sample(navUsdc) };
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

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  // Round 1 — vault-level reads with no inter-dependencies, aggregated into one
  // Multicall3 `eth_call`: TVL, idle USDC, and the three bucket adapter addresses.
  const [totalAssets, idle, aaveAdapter, usdyAdapter, ausdAdapter] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: vault, abi: yieldVaultAbi, functionName: "totalAssets" },
      { address: getAddress(TOKENS.USDC.address), abi: erc20Abi, functionName: "balanceOf", args: [vault] },
      { address: vault, abi: yieldVaultAbi, functionName: "adapters", args: [BigInt(Bucket.AAVE)] },
      { address: vault, abi: yieldVaultAbi, functionName: "adapters", args: [BigInt(Bucket.USDY)] },
      { address: vault, abi: yieldVaultAbi, functionName: "adapters", args: [BigInt(Bucket.AUSD)] },
    ] as const,
  });

  // Per-bucket adapter values (bucket 0 = idle has no adapter).
  const bucketValues: Record<Bucket, bigint> = {
    [Bucket.IDLE]: idle,
    [Bucket.AAVE]: 0n,
    [Bucket.USDY]: 0n,
    [Bucket.AUSD]: 0n,
  };
  let aaveWithdrawable = 0n;

  // Round 2 — per-adapter reads (depend on the round-1 adapter addresses), again
  // batched into a single Multicall3 call. Skip buckets with no adapter set.
  const round2: { tag: "aaveTotal" | "aaveWithdraw" | "usdyTotal" | "ausdTotal"; address: `0x${string}` }[] = [];
  if (aaveAdapter !== ZERO_ADDRESS) {
    round2.push({ tag: "aaveTotal", address: aaveAdapter });
    round2.push({ tag: "aaveWithdraw", address: aaveAdapter });
  }
  if (usdyAdapter !== ZERO_ADDRESS) round2.push({ tag: "usdyTotal", address: usdyAdapter });
  if (ausdAdapter !== ZERO_ADDRESS) round2.push({ tag: "ausdTotal", address: ausdAdapter });

  if (round2.length > 0) {
    const results = await client.multicall({
      allowFailure: false,
      contracts: round2.map((r) => ({
        address: r.address,
        abi: strategyAdapterAbi,
        functionName: r.tag === "aaveWithdraw" ? "maxWithdrawable" : "totalAssets",
      })),
    });
    round2.forEach((r, i) => {
      const value = results[i] as bigint;
      if (r.tag === "aaveTotal") bucketValues[Bucket.AAVE] = value;
      else if (r.tag === "aaveWithdraw") aaveWithdrawable = value;
      else if (r.tag === "usdyTotal") bucketValues[Bucket.USDY] = value;
      else if (r.tag === "ausdTotal") bucketValues[Bucket.AUSD] = value;
    });
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
