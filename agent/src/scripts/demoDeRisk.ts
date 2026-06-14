/**
 * Demo hero de-risk (docs/demo.md, Step 4 — the on-camera event).
 *
 * Runs the SAME evidence → LLM verdict as `demo:derisk-dryrun`, and when the model
 * returns a clamped `deRisk: true` citing a trusted source, submits a REAL on-chain
 * `deRisk()` (kind=1) — the verifiable autonomous defense the video is about.
 *
 * Why a GUARDIAN key (not the ALLOCATOR): `deRisk()` called by the ALLOCATOR requires
 * the on-chain depeg/oracle guard to have tripped (`forceDeRisk`), else it reverts
 * with `DeRiskConditionNotMet`. In the demo the market is calm — the only signal is
 * the off-chain threat document the AI read, which the chain cannot independently
 * verify, so it refuses to stamp an ALLOCATOR move as kind=1. The GUARDIAN role is the
 * sanctioned discretionary escape hatch (Roles.sol: "GUARDIAN — pause, unpause, deRisk,
 * kill"): it may de-risk on judgment without a breach, recording a true `kind=1`
 * de-risk (red "De-risking" status, a "De-risk" Activity entry, the `DeRisked` event,
 * benchmark anchoring) — on calm mainnet, no fork, no pool nudge.
 *
 * HONEST FRAMING (state this on camera): the triggering document is synthetic. The
 * evidence fetch, the AI judgment, the on-chain guardrail validation, and the
 * resulting on-chain de-risk are all real. The de-risk is guardian-signed on the
 * agent's AI recommendation.
 *
 * Inputs (env, same .env the agent uses):
 *   MANTLE_RPC_URL, VAULT_ADDRESS, GUARDIAN_PRIVATE_KEY,
 *   ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL/ANTHROPIC_MODEL for z.ai GLM),
 *   DEMO_DERISK_EVIDENCE_URL, ONEDELTA_API_KEY (USDY→USDC route),
 *   IPFS_API_URL/IPFS_PINNING_JWT (so the decision bundle is resolvable on-camera).
 *
 * Usage (from the `agent/` dir):
 *   pnpm demo:derisk            # judge + (if de-risk) send the on-chain deRisk()
 *   pnpm demo:derisk --dry      # full rehearsal: verdict + swap build + pin, but DON'T send
 *   pnpm demo:derisk --env ../.env
 *
 * Exit code: 0 on a confirmed de-risk (or a clean --dry), non-zero otherwise.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createWalletClient,
  getAddress,
  keccak256,
  toBytes,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Bucket, MAX_SLIPPAGE_BPS, PROTOCOLS, TOKENS } from "@custos/shared";

import { loadConfig } from "../config.js";
import { assertChainId, makeClients, makeTransport, mantle } from "../chain/clients.js";
import { yieldVaultAbi, yieldVaultWriteAbi } from "../chain/abis.js";
import { buildPipeline } from "../pipeline.js";
import { assess } from "../risk/engine.js";
import { buildLLMInput } from "../llm/signals.js";
import { AnthropicClient } from "../llm/anthropic.js";
import { buildEvidenceFetcher, CURATED_EVIDENCE_SOURCES } from "../llm/evidence.js";
import { pinRationale, type RationaleBundle } from "../executor/ipfs.js";
import { OneDeltaClient } from "../data/oneDelta.js";
import { extractDecisionId } from "../executor/index.js";
import type { RiskSignal, WeightsBps, MarketSnapshot } from "../types.js";

// Match `demoDeRiskDryRun.ts`: default to z.ai's Anthropic-compatible GLM endpoint (what
// the demo runs on); ANTHROPIC_BASE_URL / ANTHROPIC_MODEL still override. Using the same
// model as the dry-run means a dry-run PASS predicts a PASS here.
const DEMO_BASE_URL = "https://api.z.ai/api/anthropic";
const DEMO_MODEL = "GLM-4.6V";

// keccak256("GUARDIAN") — Roles.GUARDIAN (contracts/src/Roles.sol). The signer must
// hold this role for a calm-market de-risk to be accepted (bypasses forceDeRisk).
const GUARDIAN_ROLE = keccak256(toBytes("GUARDIAN")) as `0x${string}`;

// De-risk into IDLE (USDC) — instantly liquid, and the only slot that needs swap
// calldata. Mirrors the executor's `_sendDeRisk` (toBucket=0).
const TO_BUCKET_IDLE = 0;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../.."); // agent/src/scripts → repo root

const hasRoleAbi = [
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function out(s: string): void {
  process.stdout.write(s);
}
function fail(message: string): never {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(1);
}

interface Args {
  envPath: string;
  dry: boolean;
}

function parseArgs(argv: string[]): Args {
  let envArg: string | undefined;
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env") envArg = argv[++i];
    else if (a === "--dry" || a === "--dry-run") dry = true;
  }
  const envPath = envArg ? resolve(process.cwd(), envArg) : resolve(REPO_ROOT, ".env");
  return { envPath, dry };
}

/**
 * Build the 4-slot `swapData` for a full USDY→USDC de-risk — only slot 2 (the USDY
 * adapter) is populated, mirroring the executor's `_buildSwapData` withdraw path and
 * the contract's `_unwindUsdyToAusd(toBucket=IDLE)`. Fail-closed: a quote/router
 * mismatch throws so we never sign calldata that would revert on-chain.
 */
async function buildDeRiskSwapData(
  snapshot: MarketSnapshot,
  vault: `0x${string}`,
  publicClient: ReturnType<typeof makeClients>["publicClient"],
  config: ReturnType<typeof loadConfig>,
): Promise<readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`]> {
  const empty = "0x" as const;
  const swapData: [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`] = [empty, empty, empty, empty];

  const currentUsdy = snapshot.currentWeightsBps[Bucket.USDY];
  if (currentUsdy === 0) return swapData; // guarded by the caller; nothing to sell

  const adapterAddress = (await publicClient.readContract({
    address: vault,
    abi: yieldVaultAbi,
    functionName: "adapters",
    args: [2n], // adapters[2] = USDY bucket
  })) as `0x${string}`;

  const oneDelta = new OneDeltaClient(config);
  const pinnedRouter = (PROTOCOLS.usdyAggregatorRouter as string).toLowerCase();

  // Sell the FULL USDY position → USDC. Convert the USDC value of the position into
  // USDY base units via the oracle NAV (matches UsdyAdapter's on-chain math).
  const usdcValue = (BigInt(currentUsdy) * snapshot.totalAssetsUsdc) / 10_000n;
  const usdyIn = (usdcValue * 10n ** 30n) / snapshot.usdyOracleNavUsdc;
  const quote = await oneDelta.getSwapQuote(
    TOKENS.USDY.address,
    TOKENS.USDC.address,
    usdyIn,
    adapterAddress,
    MAX_SLIPPAGE_BPS,
  );
  if (quote.router.toLowerCase() !== pinnedRouter) {
    throw new Error(`quote router mismatch: got ${quote.router}, expected pinned ${pinnedRouter}`);
  }
  swapData[2] = quote.calldata;
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
  if (!config.vaultAddress) fail("VAULT_ADDRESS is required");
  if (!config.anthropicApiKey) fail("ANTHROPIC_API_KEY is required for the LLM judgment");
  if (!config.demoDeRiskEvidenceUrl) {
    fail("DEMO_DERISK_EVIDENCE_URL is required — point it at the staged evidence page");
  }
  const guardianKey = process.env.GUARDIAN_PRIVATE_KEY;
  if (!guardianKey || !/^0x[0-9a-fA-F]{64}$/.test(guardianKey)) {
    fail("GUARDIAN_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key (the signer must hold the GUARDIAN role)");
  }

  // Read client from the shared builder; build the GUARDIAN wallet separately so we
  // never reuse / require the ALLOCATOR hot key for this discretionary de-risk.
  const { publicClient } = makeClients(config);
  await assertChainId(publicClient); // O6: refuse to sign unless this RPC is Mantle mainnet

  const guardian = privateKeyToAccount(guardianKey as `0x${string}`);
  const walletClient: WalletClient = createWalletClient({
    account: guardian,
    chain: mantle,
    transport: makeTransport(config.mantleRpcUrl),
  });
  const vault = getAddress(config.vaultAddress);

  // Pre-flight: the signer MUST hold GUARDIAN, or the calm-market de-risk reverts.
  const isGuardian = (await publicClient.readContract({
    address: vault,
    abi: hasRoleAbi,
    functionName: "hasRole",
    args: [GUARDIAN_ROLE, guardian.address],
  })) as boolean;
  if (!isGuardian) {
    fail(
      `signer ${guardian.address} does NOT hold the GUARDIAN role on ${vault}.\n` +
        `  Grant it from the admin: vault.grantRole(${GUARDIAN_ROLE}, ${guardian.address})`,
    );
  }

  // 1. Snapshot real vault + market state (same source the live executor uses).
  out("Snapshotting vault + market state…\n");
  const { snapshotter } = buildPipeline(config);
  const snapshot = await snapshotter.snapshot();
  const nowSec = Math.floor(Date.now() / 1000);
  const assessment = assess(snapshot, { nowSec });

  const usdyBps = snapshot.currentWeightsBps[Bucket.USDY];
  if (usdyBps === 0) {
    fail("USDY weight is already 0 — nothing to de-risk. Seed a USDY position first (pnpm rebalance).");
  }
  const tvlUsdc = Number(snapshot.totalAssetsUsdc) / 1e6;
  const usdyValueUsdc = (tvlUsdc * usdyBps) / 10_000;

  out(`\nVault:    ${vault}\n`);
  out(`Guardian: ${guardian.address}\n`);
  out(`TVL:      ${tvlUsdc.toFixed(2)} USDC\n`);
  out(`USDY:     ${(usdyBps / 100).toFixed(2)}%  (~${usdyValueUsdc.toFixed(2)} USDC) → will rotate to 0 (USDC)\n`);

  // 2. Evidence → LLM judgment (mirrors demo:derisk-dryrun, against the REAL snapshot).
  const fetchEvidence = buildEvidenceFetcher(undefined, { demoEvidenceUrl: config.demoDeRiskEvidenceUrl });
  const evidence = await fetchEvidence();
  out(`\nFetched ${evidence.length} evidence item(s):\n`);
  for (const e of evidence) out(`  • [${e.id}] (${e.source}) ${e.summary}\n`);

  // Bail before spending an LLM call if the staged page fell back to the SPA shell
  // (Caddy try_files → index.html when the static file isn't deployed).
  const THREAT_KEYWORDS = ["usdy", "redemption", "depeg", "nav", "attestation", "reserve", "custodian"];
  const staged = evidence.find((e) => e.id === "ondo-usdy-attestation");
  if (!staged || !THREAT_KEYWORDS.some((k) => staged.summary.toLowerCase().includes(k))) {
    fail(
      "staged evidence missing or looks like the SPA fallback (no threat keywords).\n" +
        "  The page at DEMO_DERISK_EVIDENCE_URL probably isn't deployed — rebuild/redeploy web,\n" +
        "  or point the var at a locally-served copy of web/public/demo/derisk-evidence.html.",
    );
  }

  const llmConfig = {
    ...config,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? DEMO_BASE_URL,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? DEMO_MODEL,
  };
  out(`\nLLM: model=${llmConfig.anthropicModel} baseUrl=${llmConfig.anthropicBaseUrl}\n`);
  const llm = new AnthropicClient(llmConfig); // default retries — be resilient on camera

  const input = buildLLMInput(snapshot, assessment, evidence);
  let raw;
  try {
    raw = await llm.complete(input);
  } catch (err) {
    const status = (err as { status?: number }).status;
    fail(`LLM API call failed${status ? ` (HTTP ${status})` : ""}: ${err instanceof Error ? err.message : String(err)}`);
  }

  out("\nModel verdict:\n");
  out(`  deRisk=${raw.deRisk}  riskLevel=${raw.riskLevel}  confidence=${raw.confidence}\n`);
  out(`  rationale: ${raw.rationale}\n`);

  // Same de-risk gate as clampVerdict (signals.ts): a deRisk holds only if a cited
  // signal resolves to evidence from a trusted (curated) source (N2).
  const citedTrusted = raw.signals.some(
    (s) =>
      s.evidenceId !== undefined &&
      evidence.some((e) => e.id === s.evidenceId && CURATED_EVIDENCE_SOURCES.has(e.source)),
  );
  if (!(raw.deRisk === true && citedTrusted)) {
    fail(
      "model did not return a trusted, cited de-risk — NOT sending.\n" +
        "  Tune the staged document wording and re-check with `pnpm demo:derisk-dryrun`.",
    );
  }
  out("\n✓ AI judged a trusted, cited de-risk.\n");

  // 3. Pin the rationale bundle (the AI rationale + cited evidence the UI links to).
  const zeroUsdyWeights: WeightsBps = {
    [Bucket.IDLE]: snapshot.currentWeightsBps[Bucket.IDLE] + usdyBps,
    [Bucket.AAVE]: snapshot.currentWeightsBps[Bucket.AAVE],
    [Bucket.USDY]: 0,
    [Bucket.AUSD]: snapshot.currentWeightsBps[Bucket.AUSD],
  };
  const bundle: RationaleBundle = {
    rationale: raw.rationale,
    signals: raw.signals as RiskSignal[],
    evidence,
    candidateWeightsBps: zeroUsdyWeights,
    riskLevel: "DERISK",
    asOf: snapshot.asOf,
  };
  const { uri, rationaleHash } = await pinRationale(bundle, config);
  out(`\nDecision bundle: ${uri}\n`);
  if (!config.ipfsApiUrl) {
    out("  (no IPFS backend configured — bundle is an inline data: URI, not gateway-resolvable.\n");
    out("   Set IPFS_API_URL + IPFS_PINNING_JWT so the on-camera bundle link resolves.)\n");
  }

  // 4. Build the USDY→USDC swap calldata (fail-closed on any router/quote error).
  out("\nBuilding USDY→USDC route (1delta)…\n");
  const swapData = await buildDeRiskSwapData(snapshot, vault, publicClient, config).catch((err: unknown) =>
    fail(`swap-data build failed: ${err instanceof Error ? err.message : String(err)}`),
  );

  if (args.dry) {
    out("\n— DRY RUN — everything ready; not sending the tx.\n");
    out(`  Would call: deRisk(toBucket=${TO_BUCKET_IDLE}, swapData[2]=<USDY→USDC>, reason=${uri},\n`);
    out(`              evidenceHash=${rationaleHash}, usdyDexSpotUsdc=${snapshot.usdyDexSpotUsdc})\n`);
    process.exit(0);
  }

  // 5. Send the real, guardian-signed de-risk (kind=1).
  out("\nSending guardian deRisk()…\n");
  const hash = await walletClient.writeContract({
    address: vault,
    abi: yieldVaultWriteAbi,
    functionName: "deRisk",
    args: [TO_BUCKET_IDLE, swapData, uri, rationaleHash, snapshot.usdyDexSpotUsdc],
    chain: walletClient.chain,
    account: walletClient.account!,
  } as Parameters<WalletClient["writeContract"]>[0]);
  out(`  tx: ${hash}\n  waiting for receipt…\n`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: config.txReceiptTimeoutMs });
  if (receipt.status === "reverted") fail(`de-risk reverted on-chain (tx ${hash})`);

  const decisionId = extractDecisionId(receipt);
  out(`\n✓ De-risk confirmed (kind=1)\n`);
  out(`  decisionId: ${decisionId ?? "(unknown)"}\n`);
  out(`  block:      ${receipt.blockNumber}\n`);
  out(`  tx:         ${hash}\n`);
  out(`  mantlescan: https://mantlescan.xyz/tx/${hash}\n`);
}

// Only auto-run when invoked directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
}
