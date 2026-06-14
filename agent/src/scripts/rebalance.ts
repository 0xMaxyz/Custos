/**
 * Manual ALLOCATOR rebalance (dev/testing utility).
 *
 * The autonomous agent only ever *maintains or reduces* the RWA position — its
 * deterministic engine anchors the USDY target to the CURRENT weight and never
 * grows an allocation from idle (engine.ts `desiredUsdy = current`). So a fresh
 * deposit sits as idle USDC forever unless an ALLOCATOR explicitly seeds a target
 * allocation. This script is that explicit seed: it signs a single `rebalance()`
 * with operator-chosen target weights, reusing the same snapshot + guardrail
 * validation + swap-building path as the live executor so it can never propose a
 * move the on-chain Guardrails would reject.
 *
 * Inputs (env): MANTLE_RPC_URL, ALLOCATOR_PRIVATE_KEY, VAULT_ADDRESS (+ ONEDELTA_API_KEY
 * only if a target moves USDY). Same `.env` the agent uses.
 *
 * Usage (from the `agent/` dir):
 *   pnpm rebalance <idle> <aave> <usdy> <ausd> [--reason "..."] [--env ../.env] [--force]
 *
 *   # Deploy ~80% of idle USDC into Aave (no swap, ideal first test):
 *   pnpm rebalance 2000 8000 0 0
 *
 *   # 20% idle / 40% Aave / 40% USDY (USDY leg needs ONEDELTA_API_KEY):
 *   pnpm rebalance 2000 4000 4000 0 --reason "seed RWA position"
 *
 * Weights are basis points (bps) for IDLE / AAVE / USDY / AUSD and must sum to 10000.
 * The script validates against the full TS guardrail mirror BEFORE signing and aborts
 * on any violation (pass --force to send anyway and let the chain be the judge).
 *
 * Exit code: 0 on a confirmed rebalance, 1 on any failure.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getAddress, keccak256, toBytes, type WalletClient } from "viem";
import { Bucket, MAX_SLIPPAGE_BPS, PROTOCOLS, TOKENS } from "@custos/shared";

import { loadConfig } from "../config.js";
import { assertChainId, makeClients } from "../chain/clients.js";
import { yieldVaultAbi, yieldVaultWriteAbi } from "../chain/abis.js";
import { buildPipeline } from "../pipeline.js";
import { assess } from "../risk/engine.js";
import { validateProposal, type ChainContext } from "../risk/validator.js";
import { OneDeltaClient } from "../data/oneDelta.js";
import { extractDecisionId } from "../executor/index.js";
import type { WeightsBps } from "../types.js";
import type { MarketSnapshot } from "../types.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../.."); // agent/src/scripts → repo root

const BUCKET_LABELS = ["IDLE", "AAVE", "USDY", "AUSD"] as const;

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

interface Args {
  weights: readonly [number, number, number, number];
  reason: string;
  envPath: string;
  force: boolean;
}

/** Parse the 4 positional bps weights plus the optional flags. */
function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let reason = "Manual ALLOCATOR rebalance";
  let envArg: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reason") reason = argv[++i] ?? reason;
    else if (a === "--env") envArg = argv[++i];
    else if (a === "--force") force = true;
    else positional.push(a as string);
  }

  if (positional.length !== 4) {
    fail(
      "expected 4 weight args (bps): <idle> <aave> <usdy> <ausd>\n" +
        "  e.g. pnpm rebalance 2000 8000 0 0   (20% idle / 80% Aave)",
    );
  }
  const nums = positional.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) fail(`invalid weight "${p}" — want an integer 0..10000 (bps)`);
    return n;
  });
  const sum = nums[0]! + nums[1]! + nums[2]! + nums[3]!;
  if (sum !== 10_000) fail(`weights must sum to 10000 bps (got ${sum})`);

  const envPath = envArg ? resolve(process.cwd(), envArg) : resolve(REPO_ROOT, ".env");
  return { weights: nums as [number, number, number, number] as Args["weights"], reason, envPath, force };
}

function toWeightsBps(w: readonly [number, number, number, number]): WeightsBps {
  return { [Bucket.IDLE]: w[0], [Bucket.AAVE]: w[1], [Bucket.USDY]: w[2], [Bucket.AUSD]: w[3] };
}

function pctRow(label: string, bps: number): string {
  return `  ${label.padEnd(5)} ${String(bps).padStart(5)} bps  (${(bps / 100).toFixed(2)}%)`;
}

/**
 * Build the 4-slot `swapData` for the rebalance, mirroring the on-chain
 * _executeRebalance routing: IDLE/AAVE need no swap; the USDY (slot 2) and AUSD
 * (slot 3) legs each carry 1delta calldata when their weight changes. Returns empty
 * bytes for any unchanged bucket. Fail-closed: any quote/router error throws so the
 * operator sees it rather than signing calldata that would revert on-chain.
 */
async function buildSwapData(
  snapshot: MarketSnapshot,
  target: WeightsBps,
  vault: `0x${string}`,
  publicClient: ReturnType<typeof makeClients>["publicClient"],
  config: ReturnType<typeof loadConfig>,
): Promise<readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`]> {
  const empty = "0x" as const;
  const swapData: [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`] = [empty, empty, empty, empty];

  const oneDelta = new OneDeltaClient(config);
  const pinnedRouter = (PROTOCOLS.usdyAggregatorRouter as string).toLowerCase();

  // The two swap-bearing buckets and their token. USDY needs the oracle NAV to size a
  // withdraw (USDC value → USDY units); AUSD is a 6-dec $1 token valued 1:1 with USDC.
  const legs = [
    { bucket: Bucket.USDY, slot: 2 as const, token: TOKENS.USDY.address, navScaled: true },
    { bucket: Bucket.AUSD, slot: 3 as const, token: TOKENS.AUSD.address, navScaled: false },
  ];

  for (const leg of legs) {
    const current = snapshot.currentWeightsBps[leg.bucket];
    const final = target[leg.bucket];
    if (current === final) continue;

    const adapterAddress = (await publicClient.readContract({
      address: vault,
      abi: yieldVaultAbi,
      functionName: "adapters",
      args: [BigInt(leg.slot)],
    })) as `0x${string}`;

    let quote;
    if (final > current) {
      // USDC → token: amount = weight-delta × TVL.
      const usdcIn = (BigInt(final - current) * snapshot.totalAssetsUsdc) / 10_000n;
      quote = await oneDelta.getSwapQuote(TOKENS.USDC.address, leg.token, usdcIn, adapterAddress, MAX_SLIPPAGE_BPS);
    } else {
      // token → USDC: convert the USDC value into token base units.
      const usdcValue = (BigInt(current - final) * snapshot.totalAssetsUsdc) / 10_000n;
      const amountIn = leg.navScaled
        ? (usdcValue * 10n ** 30n) / snapshot.usdyOracleNavUsdc // 18-dec USDY via oracle NAV
        : usdcValue; // AUSD is 6-dec, 1:1
      quote = await oneDelta.getSwapQuote(leg.token, TOKENS.USDC.address, amountIn, adapterAddress, MAX_SLIPPAGE_BPS);
    }

    if (quote.router.toLowerCase() !== pinnedRouter) {
      throw new Error(`quote router mismatch: got ${quote.router}, expected pinned ${pinnedRouter}`);
    }
    swapData[leg.slot] = quote.calldata;
  }

  return swapData;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  try {
    process.loadEnvFile(args.envPath);
  } catch {
    fail(`could not read env file: ${args.envPath}\n  Pass one with --env ../.env`);
  }

  const config = loadConfig();
  if (!config.allocatorPrivateKey) fail("ALLOCATOR_PRIVATE_KEY is required to sign the rebalance");
  if (!config.vaultAddress) fail("VAULT_ADDRESS is required");

  const { publicClient, walletClient, allocatorAddress } = makeClients(config);
  if (!walletClient || !allocatorAddress) fail("could not build the ALLOCATOR wallet client");
  await assertChainId(publicClient);

  const vault = getAddress(config.vaultAddress);
  const target = toWeightsBps(args.weights);

  // Snapshot current state (TVL, current weights, USDY peg/oracle) — the same source
  // the live executor uses, so guardrail validation here matches the on-chain check.
  process.stdout.write("Snapshotting vault + market state…\n");
  const { snapshotter } = buildPipeline(config);
  const snapshot = await snapshotter.snapshot();
  const nowSec = Math.floor(Date.now() / 1000);

  const lastRebalanceAt = await publicClient.readContract({
    address: vault,
    abi: yieldVaultAbi,
    functionName: "lastRebalanceAt",
  });
  const ctx: ChainContext = { lastRebalanceAt: Number(lastRebalanceAt), nowSec };

  // Print the move.
  process.stdout.write(`\nVault:     ${vault}\n`);
  process.stdout.write(`Allocator: ${allocatorAddress}\n`);
  process.stdout.write(`TVL:       ${(Number(snapshot.totalAssetsUsdc) / 1e6).toFixed(2)} USDC\n\n`);
  process.stdout.write("Current → Target weights:\n");
  for (const b of [Bucket.IDLE, Bucket.AAVE, Bucket.USDY, Bucket.AUSD] as const) {
    const label = BUCKET_LABELS[b];
    process.stdout.write(
      `${pctRow(label, snapshot.currentWeightsBps[b])}  →  ${String(target[b]).padStart(5)} bps (${(target[b] / 100).toFixed(2)}%)\n`,
    );
  }

  // Validate against the full guardrail mirror before signing.
  const assessment = assess(snapshot, { nowSec });
  const validation = validateProposal(target, snapshot.currentWeightsBps, snapshot, assessment.maxUsdyWeightBpsAllowed, ctx);
  if (!validation.valid) {
    process.stdout.write(`\n! Guardrail validation failed: ${validation.errors.join(", ")}\n`);
    if (!args.force) {
      fail("aborting — fix the target (or pass --force to send anyway and let the chain decide)");
    }
    process.stdout.write("  --force set: sending anyway.\n");
  } else {
    process.stdout.write("\n✓ Passes the TS guardrail mirror.\n");
  }

  // Build swapData (USDY leg only) + the on-chain decision anchor.
  const swapData = await buildSwapData(snapshot, target, vault, publicClient, config).catch((err: unknown) =>
    fail(`swap-data build failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  const decisionURI = `manual:${args.reason}`;
  const rationaleHash = keccak256(toBytes(decisionURI));

  process.stdout.write("\nSending rebalance…\n");
  const hash = await walletClient.writeContract({
    address: vault,
    abi: yieldVaultWriteAbi,
    functionName: "rebalance",
    args: [args.weights, swapData, decisionURI, rationaleHash, snapshot.usdyDexSpotUsdc],
    chain: walletClient.chain,
    account: walletClient.account!,
  } as Parameters<WalletClient["writeContract"]>[0]);
  process.stdout.write(`  tx: ${hash}\n  waiting for receipt…\n`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: config.txReceiptTimeoutMs });
  if (receipt.status === "reverted") fail(`rebalance reverted on-chain (tx ${hash})`);

  const decisionId = extractDecisionId(receipt);
  process.stdout.write(`\n✓ Rebalance confirmed\n`);
  process.stdout.write(`  decisionId: ${decisionId ?? "(unknown)"}\n`);
  process.stdout.write(`  block:      ${receipt.blockNumber}\n`);
  process.stdout.write(`  tx:         ${hash}\n`);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
