/**
 * Guardrail USDY peg-threshold tool (ADMIN, dev/demo utility).
 *
 * Why this exists: on Mantle the USDY DEX pools are razor-thin (~$1.5k total), so the
 * DEX spot for 1 USDY sits structurally OFF the Ondo oracle NAV. The on-chain depeg
 * guard (`Guardrails._evaluateUsdyRisk`) blocks any NEW USDY allocation once that
 * deviation reaches `pegBlockBps` (default 0.50%) — which means a fresh vault can't be
 * seeded into USDY at all, regardless of trade size. This tool lets an ADMIN:
 *
 *   1. MEASURE the live deviation (same NAV + unit DEX spot the guard compares) and
 *      print the exact thresholds needed to let a USDY rebalance through.
 *   2. QUEUE a config that loosens ONLY the three peg thresholds (every other guardrail
 *      param is read from the live config and copied verbatim), behind the 1-hour
 *      timelock.
 *   3. ACTIVATE it once the timelock elapses, then re-tighten (queue the original
 *      values back) afterwards.
 *
 * SAFETY: loosening `pegDeRiskBps` is the real cost — while loosened, the autonomous
 * guard won't auto-exit USDY until deviation exceeds the new (higher) threshold. The
 * GUARDIAN can still force a de-risk at any time. Keep the window short and restore the
 * tight values as soon as the seed rebalance is done. This is a deliberate, timelocked
 * ADMIN action — it does NOT let the agent loosen risk at runtime.
 *
 * Inputs (env, same .env the agent uses): MANTLE_RPC_URL, GUARDRAILS_ADDRESS,
 * ONEDELTA_API_KEY (for `measure`), and an ADMIN signer — ADMIN_PRIVATE_KEY (preferred)
 * or ALLOCATOR_PRIVATE_KEY (only if that key also holds Roles.ADMIN).
 *
 * Usage (from the `agent/` dir):
 *   pnpm guardrail:peg measure [--usdy <bps>]          # read-only; default --usdy 3000 (30%)
 *   pnpm guardrail:peg status                           # current + pending peg thresholds
 *   pnpm guardrail:peg queue --peg-block <bps> --peg-derisk <bps> [--peg-warn <bps>]
 *   pnpm guardrail:peg queue --auto [--buffer <bps>]    # measure + queue recommended (asks --yes)
 *   pnpm guardrail:peg activate                         # after the 1h timelock
 *   pnpm guardrail:peg cancel                           # drop a queued (wrong) change
 *
 * Common flags: --env <path> (default ../.env), --yes (skip the confirm on writes).
 *
 * Exit code: 0 on success, 1 on any failure.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createWalletClient,
  getAddress,
  keccak256,
  toBytes,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../config.js";
import { assertChainId, makeClients, makeTransport, mantle } from "../chain/clients.js";
import { buildPipeline } from "../pipeline.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../.."); // agent/src/scripts → repo root

// Roles.ADMIN === keccak256("ADMIN") (contracts/src/Roles.sol).
const ADMIN_ROLE = keccak256(toBytes("ADMIN"));

const BPS_MAX = 65_535; // uint16 ceiling for the threshold fields

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

// ── Guardrails ABI (config struct shared by read + write) ────────────────────

const configComponents = [
  { name: "maxWeightBps", type: "uint16[4]" },
  { name: "minIdleBps", type: "uint16" },
  { name: "minInstantLiquidityBps", type: "uint16" },
  { name: "maxUsdyNotionalUsdc", type: "uint256" },
  { name: "maxSlippageBps", type: "uint16" },
  { name: "maxRebalanceMoveBps", type: "uint16" },
  { name: "minRebalanceInterval", type: "uint32" },
  { name: "tvlCap", type: "uint256" },
  { name: "perTxDepositCap", type: "uint256" },
  { name: "addStrategyTimelock", type: "uint32" },
  { name: "pegWarnBps", type: "uint16" },
  { name: "pegBlockBps", type: "uint16" },
  { name: "pegDeRiskBps", type: "uint16" },
  { name: "oracleMaxAge", type: "uint32" },
  { name: "oracleRangeEndBuffer", type: "uint32" },
] as const;

const guardrailsAbi = [
  { name: "config", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "tuple", components: configComponents }] },
  {
    name: "pendingConfig",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "cfg", type: "tuple", components: configComponents },
      { name: "exists", type: "bool" },
      { name: "unlocksAt", type: "uint256" },
    ],
  },
  { name: "queueConfig", type: "function", stateMutability: "nonpayable", inputs: [{ name: "newConfig", type: "tuple", components: configComponents }], outputs: [] },
  { name: "activateConfig", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "cancelConfig", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "hasRole", type: "function", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ name: "", type: "bool" }] },
] as const;

/** Full guardrail config, normalized to plain JS values (numbers for uintN≤48, bigint for uint256). */
export interface GuardrailConfig {
  maxWeightBps: readonly [number, number, number, number];
  minIdleBps: number;
  minInstantLiquidityBps: number;
  maxUsdyNotionalUsdc: bigint;
  maxSlippageBps: number;
  maxRebalanceMoveBps: number;
  minRebalanceInterval: number;
  tvlCap: bigint;
  perTxDepositCap: bigint;
  addStrategyTimelock: number;
  pegWarnBps: number;
  pegBlockBps: number;
  pegDeRiskBps: number;
  oracleMaxAge: number;
  oracleRangeEndBuffer: number;
}

// ── Pure peg math (unit-testable) ────────────────────────────────────────────

/** Integer bps deviation between the DEX spot and oracle NAV (both 18-dec). */
export function deviationBps(navUsdc: bigint, spotUsdc: bigint): number {
  if (navUsdc <= 0n) throw new Error("oracle NAV unavailable (<= 0)");
  const diff = spotUsdc > navUsdc ? spotUsdc - navUsdc : navUsdc - spotUsdc;
  return Number((diff * 10_000n) / navUsdc);
}

export interface PegRecommendation {
  deviationBps: number;
  pegWarnBps: number;
  pegBlockBps: number;
  pegDeRiskBps: number;
}

/**
 * Recommend peg thresholds that let new USDY through at the measured deviation, with a
 * safety buffer (the unit spot drifts between measure and activate). The guard blocks
 * when deviation ≥ pegBlockBps, so pegBlock must sit ABOVE the deviation; pegDeRisk
 * must be ≥ pegBlock (validator invariant), and pegWarn ≤ pegBlock.
 */
export function recommendPegThresholds(args: {
  navUsdc: bigint;
  spotUsdc: bigint;
  currentWarnBps: number;
  bufferBps: number;
}): PegRecommendation {
  const dev = deviationBps(args.navUsdc, args.spotUsdc);
  // +1 because integer division floors the deviation; then the operator buffer.
  const pegBlockBps = Math.min(BPS_MAX, dev + 1 + args.bufferBps);
  const pegDeRiskBps = Math.min(BPS_MAX, pegBlockBps + args.bufferBps);
  const pegWarnBps = Math.min(args.currentWarnBps, pegBlockBps);
  return { deviationBps: dev, pegWarnBps, pegBlockBps, pegDeRiskBps };
}

/** Validate a peg triplet against the Guardrails._requireValidConfig invariants. */
export function assertValidPegTriplet(warn: number, block: number, derisk: number): void {
  for (const [name, v] of [["peg-warn", warn], ["peg-block", block], ["peg-derisk", derisk]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > BPS_MAX) throw new Error(`${name} must be an integer 0..${BPS_MAX} bps (got ${v})`);
  }
  if (warn > block) throw new Error(`peg-warn (${warn}) must be ≤ peg-block (${block})`);
  if (block > derisk) throw new Error(`peg-block (${block}) must be ≤ peg-derisk (${derisk})`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function fixed18(v: bigint): string {
  return (Number(v) / 1e18).toFixed(6);
}

function normalizeConfig(raw: Record<string, unknown>): GuardrailConfig {
  const mw = raw.maxWeightBps as readonly bigint[] | readonly number[];
  const n = (x: unknown): number => Number(x);
  return {
    maxWeightBps: [n(mw[0]), n(mw[1]), n(mw[2]), n(mw[3])] as const,
    minIdleBps: n(raw.minIdleBps),
    minInstantLiquidityBps: n(raw.minInstantLiquidityBps),
    maxUsdyNotionalUsdc: BigInt(raw.maxUsdyNotionalUsdc as bigint),
    maxSlippageBps: n(raw.maxSlippageBps),
    maxRebalanceMoveBps: n(raw.maxRebalanceMoveBps),
    minRebalanceInterval: n(raw.minRebalanceInterval),
    tvlCap: BigInt(raw.tvlCap as bigint),
    perTxDepositCap: BigInt(raw.perTxDepositCap as bigint),
    addStrategyTimelock: n(raw.addStrategyTimelock),
    pegWarnBps: n(raw.pegWarnBps),
    pegBlockBps: n(raw.pegBlockBps),
    pegDeRiskBps: n(raw.pegDeRiskBps),
    oracleMaxAge: n(raw.oracleMaxAge),
    oracleRangeEndBuffer: n(raw.oracleRangeEndBuffer),
  };
}

async function readConfig(publicClient: PublicClient, guardrails: `0x${string}`): Promise<GuardrailConfig> {
  const raw = (await publicClient.readContract({ address: guardrails, abi: guardrailsAbi, functionName: "config" })) as Record<string, unknown>;
  return normalizeConfig(raw);
}

async function readPending(
  publicClient: PublicClient,
  guardrails: `0x${string}`,
): Promise<{ cfg: GuardrailConfig; exists: boolean; unlocksAt: number }> {
  const [cfg, exists, unlocksAt] = (await publicClient.readContract({
    address: guardrails,
    abi: guardrailsAbi,
    functionName: "pendingConfig",
  })) as unknown as [Record<string, unknown>, boolean, bigint];
  return { cfg: normalizeConfig(cfg), exists, unlocksAt: Number(unlocksAt) };
}

/** ADMIN signer: ADMIN_PRIVATE_KEY preferred, else ALLOCATOR_PRIVATE_KEY. */
function makeAdminWallet(rpcUrl: string): { walletClient: WalletClient; account: Account } {
  const key = (process.env.ADMIN_PRIVATE_KEY || process.env.ALLOCATOR_PRIVATE_KEY || "").trim();
  if (!key) fail("an ADMIN signer is required — set ADMIN_PRIVATE_KEY (or ALLOCATOR_PRIVATE_KEY if it holds Roles.ADMIN)");
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: mantle, transport: makeTransport(rpcUrl) });
  return { walletClient, account };
}

async function requireAdmin(publicClient: PublicClient, guardrails: `0x${string}`, account: Account): Promise<void> {
  const ok = (await publicClient.readContract({
    address: guardrails,
    abi: guardrailsAbi,
    functionName: "hasRole",
    args: [ADMIN_ROLE, account.address],
  })) as boolean;
  if (!ok) fail(`signer ${account.address} does not hold Roles.ADMIN on Guardrails ${guardrails}`);
}

function restoreHint(cfg: GuardrailConfig): string {
  return `pnpm guardrail:peg queue --peg-warn ${cfg.pegWarnBps} --peg-block ${cfg.pegBlockBps} --peg-derisk ${cfg.pegDeRiskBps}`;
}

function printPegRow(label: string, cfg: Pick<GuardrailConfig, "pegWarnBps" | "pegBlockBps" | "pegDeRiskBps">): void {
  process.stdout.write(
    `  ${label.padEnd(9)} warn ${String(cfg.pegWarnBps).padStart(5)} (${pct(cfg.pegWarnBps)})  block ${String(cfg.pegBlockBps).padStart(5)} (${pct(cfg.pegBlockBps)})  derisk ${String(cfg.pegDeRiskBps).padStart(5)} (${pct(cfg.pegDeRiskBps)})\n`,
  );
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

export interface PegArgs {
  cmd: "measure" | "status" | "queue" | "activate" | "cancel";
  envPath: string;
  yes: boolean;
  auto: boolean;
  bufferBps: number;
  usdyBps: number;
  pegWarn?: number;
  pegBlock?: number;
  pegDeRisk?: number;
}

export function parseArgs(argv: string[]): PegArgs {
  const cmd = (argv[0] ?? "measure") as PegArgs["cmd"];
  if (!["measure", "status", "queue", "activate", "cancel"].includes(cmd)) {
    throw new Error(`unknown command "${cmd}" — want one of: measure | status | queue | activate | cancel`);
  }
  const out: PegArgs = { cmd, envPath: resolve(REPO_ROOT, ".env"), yes: false, auto: false, bufferBps: 50, usdyBps: 3_000 };
  const intFlag = (raw: string | undefined, name: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new Error(`${name} expects an integer (got "${raw}")`);
    return n;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--env": out.envPath = resolve(process.cwd(), argv[++i] ?? ""); break;
      case "--yes": case "-y": out.yes = true; break;
      case "--auto": out.auto = true; break;
      case "--buffer": out.bufferBps = intFlag(argv[++i], "--buffer"); break;
      case "--usdy": out.usdyBps = intFlag(argv[++i], "--usdy"); break;
      case "--peg-warn": out.pegWarn = intFlag(argv[++i], "--peg-warn"); break;
      case "--peg-block": out.pegBlock = intFlag(argv[++i], "--peg-block"); break;
      case "--peg-derisk": out.pegDeRisk = intFlag(argv[++i], "--peg-derisk"); break;
      default: throw new Error(`unexpected argument "${a}"`);
    }
  }
  return out;
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdMeasure(args: PegArgs): Promise<PegRecommendation> {
  const config = loadConfig();
  if (!config.guardrailsAddress) fail("GUARDRAILS_ADDRESS is required");
  const { publicClient } = makeClients(config);
  await assertChainId(publicClient);
  const guardrails = getAddress(config.guardrailsAddress);

  const cfg = await readConfig(publicClient, guardrails);

  process.stdout.write("Snapshotting USDY oracle NAV + DEX spot (the values the depeg guard compares)…\n");
  const { snapshotter } = buildPipeline(config);
  const snap = await snapshotter.snapshot();
  const nav = snap.usdyOracleNavUsdc;
  const spot = snap.usdyDexSpotUsdc;

  process.stdout.write(`\nGuardrails: ${guardrails}\n`);
  process.stdout.write(`TVL:        ${(Number(snap.totalAssetsUsdc) / 1e6).toFixed(2)} USDC\n`);
  process.stdout.write(`Oracle NAV: ${fixed18(nav)} USDC/USDY\n`);
  process.stdout.write(`DEX spot:   ${fixed18(spot)} USDC/USDY (unit quote)\n`);

  if (nav <= 0n) fail("oracle NAV is 0 — cannot measure deviation (oracle down?)");
  if (spot <= 0n) {
    process.stdout.write("\n! DEX spot is 0 — the on-chain guard would revert UsdySpotRequired, not UsdyAllocationBlocked.\n");
    fail("no DEX spot available — check ONEDELTA_API_KEY / 1delta route, then re-run.");
  }

  const rec = recommendPegThresholds({ navUsdc: nav, spotUsdc: spot, currentWarnBps: cfg.pegWarnBps, bufferBps: args.bufferBps });

  process.stdout.write(`\nMeasured deviation: ${rec.deviationBps} bps (${pct(rec.deviationBps)})\n\n`);
  printPegRow("current:", cfg);
  const blockedNow = rec.deviationBps >= cfg.pegBlockBps;
  process.stdout.write(`  → new USDY is ${blockedNow ? "BLOCKED" : "allowed"} at the current pegBlock (${pct(cfg.pegBlockBps)}).\n\n`);

  // Notional sanity check for the intended target.
  const postNotional = (BigInt(args.usdyBps) * snap.totalAssetsUsdc) / 10_000n;
  if (cfg.maxUsdyNotionalUsdc > 0n && postNotional > cfg.maxUsdyNotionalUsdc) {
    process.stdout.write(`! Heads up: ${args.usdyBps} bps USDY = ${(Number(postNotional) / 1e6).toFixed(2)} USDC exceeds the $${(Number(cfg.maxUsdyNotionalUsdc) / 1e6).toLocaleString()} notional cap — that's a separate guardrail.\n\n`);
  }

  process.stdout.write(`Recommended (deviation + ${args.bufferBps} bps buffer):\n`);
  printPegRow("new:", rec);
  process.stdout.write(`\nTo queue (1h timelock):\n  pnpm guardrail:peg queue --peg-warn ${rec.pegWarnBps} --peg-block ${rec.pegBlockBps} --peg-derisk ${rec.pegDeRiskBps}\n`);
  process.stdout.write(`Or:\n  pnpm guardrail:peg queue --auto --buffer ${args.bufferBps} --yes\n`);
  process.stdout.write(`\nAfter the seed rebalance, RESTORE the tight values:\n  ${restoreHint(cfg)}\n`);
  process.stdout.write(`\n⚠ Raising pegDeRisk weakens the autonomous auto-de-risk while loosened. The GUARDIAN can still force a de-risk. Re-tighten ASAP.\n`);
  return rec;
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  if (!config.guardrailsAddress) fail("GUARDRAILS_ADDRESS is required");
  const { publicClient } = makeClients(config);
  await assertChainId(publicClient);
  const guardrails = getAddress(config.guardrailsAddress);

  const [cfg, pending] = await Promise.all([readConfig(publicClient, guardrails), readPending(publicClient, guardrails)]);
  process.stdout.write(`Guardrails: ${guardrails}\n`);
  process.stdout.write(`Timelock:   ${cfg.addStrategyTimelock}s (${(cfg.addStrategyTimelock / 3600).toFixed(2)}h)\n\n`);
  printPegRow("current:", cfg);
  if (!pending.exists) {
    process.stdout.write("\nNo pending config change queued.\n");
    return;
  }
  printPegRow("pending:", pending.cfg);
  const now = Math.floor(Date.now() / 1000);
  const remaining = pending.unlocksAt - now;
  if (remaining > 0) {
    process.stdout.write(`\nUnlocks in ${Math.ceil(remaining / 60)} min (at ${new Date(pending.unlocksAt * 1000).toISOString()}). Run: pnpm guardrail:peg activate\n`);
  } else {
    process.stdout.write(`\nTimelock elapsed — ready to activate: pnpm guardrail:peg activate\n`);
  }
}

async function cmdQueue(args: PegArgs): Promise<void> {
  const config = loadConfig();
  if (!config.guardrailsAddress) fail("GUARDRAILS_ADDRESS is required");
  const { publicClient } = makeClients(config);
  await assertChainId(publicClient);
  const guardrails = getAddress(config.guardrailsAddress);

  const current = await readConfig(publicClient, guardrails);

  let warn: number, block: number, derisk: number;
  if (args.auto) {
    const { snapshotter } = buildPipeline(config);
    const snap = await snapshotter.snapshot();
    const rec = recommendPegThresholds({ navUsdc: snap.usdyOracleNavUsdc, spotUsdc: snap.usdyDexSpotUsdc, currentWarnBps: current.pegWarnBps, bufferBps: args.bufferBps });
    ({ pegWarnBps: warn, pegBlockBps: block, pegDeRiskBps: derisk } = rec);
    process.stdout.write(`Auto: measured deviation ${rec.deviationBps} bps → block ${block} / derisk ${derisk} / warn ${warn}.\n`);
  } else {
    if (args.pegBlock === undefined || args.pegDeRisk === undefined) {
      fail("queue needs --peg-block <bps> and --peg-derisk <bps> (or --auto). See `measure`.");
    }
    block = args.pegBlock;
    derisk = args.pegDeRisk;
    warn = args.pegWarn ?? Math.min(current.pegWarnBps, block);
  }
  assertValidPegTriplet(warn, block, derisk);

  const newConfig: GuardrailConfig = { ...current, pegWarnBps: warn, pegBlockBps: block, pegDeRiskBps: derisk };

  process.stdout.write(`\nGuardrails: ${guardrails}\n`);
  printPegRow("current:", current);
  printPegRow("new:", newConfig);
  process.stdout.write(`\nThis queues a config change behind the ${(current.addStrategyTimelock / 3600).toFixed(2)}h timelock. Only the peg thresholds change.\n`);
  process.stdout.write(`Restore later with:\n  ${restoreHint(current)}\n`);

  if (!args.yes) fail("dry-run — re-run with --yes to send the queueConfig tx.");

  const { walletClient, account } = makeAdminWallet(config.mantleRpcUrl);
  await requireAdmin(publicClient, guardrails, account);

  process.stdout.write("\nSending queueConfig…\n");
  const hash = await walletClient.writeContract({
    address: guardrails,
    abi: guardrailsAbi,
    functionName: "queueConfig",
    args: [newConfig],
    chain: mantle,
    account,
  });
  process.stdout.write(`  tx: ${hash}\n  waiting for receipt…\n`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: config.txReceiptTimeoutMs });
  if (receipt.status === "reverted") fail(`queueConfig reverted on-chain (tx ${hash})`);

  const pending = await readPending(publicClient, guardrails);
  process.stdout.write(`\n✓ Queued. Unlocks at ${new Date(pending.unlocksAt * 1000).toISOString()} (~${Math.ceil((pending.unlocksAt - Math.floor(Date.now() / 1000)) / 60)} min).\n`);
  process.stdout.write(`  Then: pnpm guardrail:peg activate\n`);
}

async function cmdActivate(args: PegArgs): Promise<void> {
  const config = loadConfig();
  if (!config.guardrailsAddress) fail("GUARDRAILS_ADDRESS is required");
  const { publicClient } = makeClients(config);
  await assertChainId(publicClient);
  const guardrails = getAddress(config.guardrailsAddress);

  const pending = await readPending(publicClient, guardrails);
  if (!pending.exists) fail("no pending config change to activate");
  const now = Math.floor(Date.now() / 1000);
  if (now < pending.unlocksAt) {
    fail(`timelock not elapsed — ${Math.ceil((pending.unlocksAt - now) / 60)} min remaining (unlocks ${new Date(pending.unlocksAt * 1000).toISOString()})`);
  }
  process.stdout.write("Pending config ready to activate:\n");
  printPegRow("pending:", pending.cfg);
  if (!args.yes) fail("dry-run — re-run with --yes to send the activateConfig tx.");

  const { walletClient, account } = makeAdminWallet(config.mantleRpcUrl);
  await requireAdmin(publicClient, guardrails, account);

  process.stdout.write("\nSending activateConfig…\n");
  const hash = await walletClient.writeContract({ address: guardrails, abi: guardrailsAbi, functionName: "activateConfig", chain: mantle, account });
  process.stdout.write(`  tx: ${hash}\n  waiting for receipt…\n`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: config.txReceiptTimeoutMs });
  if (receipt.status === "reverted") fail(`activateConfig reverted on-chain (tx ${hash})`);
  const cfg = await readConfig(publicClient, guardrails);
  process.stdout.write("\n✓ Activated. Live peg thresholds:\n");
  printPegRow("live:", cfg);
}

async function cmdCancel(args: PegArgs): Promise<void> {
  const config = loadConfig();
  if (!config.guardrailsAddress) fail("GUARDRAILS_ADDRESS is required");
  const { publicClient } = makeClients(config);
  await assertChainId(publicClient);
  const guardrails = getAddress(config.guardrailsAddress);

  const pending = await readPending(publicClient, guardrails);
  if (!pending.exists) fail("no pending config change to cancel");
  if (!args.yes) {
    printPegRow("pending:", pending.cfg);
    fail("dry-run — re-run with --yes to send the cancelConfig tx.");
  }
  const { walletClient, account } = makeAdminWallet(config.mantleRpcUrl);
  await requireAdmin(publicClient, guardrails, account);
  process.stdout.write("Sending cancelConfig…\n");
  const hash = await walletClient.writeContract({ address: guardrails, abi: guardrailsAbi, functionName: "cancelConfig", chain: mantle, account });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: config.txReceiptTimeoutMs });
  if (receipt.status === "reverted") fail(`cancelConfig reverted on-chain (tx ${hash})`);
  process.stdout.write(`\n✓ Cancelled pending config (tx ${hash}).\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    process.loadEnvFile(args.envPath);
  } catch {
    fail(`could not read env file: ${args.envPath}\n  Pass one with --env ../.env`);
  }

  switch (args.cmd) {
    case "measure": await cmdMeasure(args); break;
    case "status": await cmdStatus(); break;
    case "queue": await cmdQueue(args); break;
    case "activate": await cmdActivate(args); break;
    case "cancel": await cmdCancel(args); break;
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
}
