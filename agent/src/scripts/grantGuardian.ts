/**
 * Grant the GUARDIAN role on the vault (ADMIN utility, dev/demo).
 *
 * The demo hero (`demo:derisk`) signs the on-chain `deRisk()` with a GUARDIAN key, so
 * that key must hold `Roles.GUARDIAN` first. GUARDIAN's role-admin is DEFAULT_ADMIN_ROLE,
 * so the signer here must hold DEFAULT_ADMIN_ROLE on the vault (verified before sending).
 *
 * Inputs (env, same .env the agent uses): MANTLE_RPC_URL, VAULT_ADDRESS (or the committed
 * deployment), and ADMIN_PRIVATE_KEY — the DEFAULT_ADMIN_ROLE holder.
 *
 * Usage (from the `agent/` dir):
 *   pnpm guardian:grant                 # grant GUARDIAN to the deployer address (default)
 *   pnpm guardian:grant --to 0xabc…     # grant GUARDIAN to a specific address
 *   pnpm guardian:grant --env ../.env
 *
 * Exit code: 0 on success (or already-granted), 1 on any failure.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createWalletClient, getAddress, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getDeployment, MANTLE_MAINNET_CHAIN_ID } from "@custos/shared";

import { loadConfig } from "../config.js";
import { assertChainId, makeClients, makeTransport, mantle } from "../chain/clients.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../.."); // agent/src/scripts → repo root

// Roles.GUARDIAN === keccak256("GUARDIAN"); DEFAULT_ADMIN_ROLE === 0x00 (OZ AccessControl).
const GUARDIAN_ROLE = keccak256(toBytes("GUARDIAN"));
const DEFAULT_ADMIN_ROLE = `0x${"0".repeat(64)}` as const;

// Deployer address (not in @custos/shared DeploymentAddresses; from deployments/5000.json).
const DEPLOYER = "0x77bD2F1cBcccdca1e63ca1B687E8b5d73710b0Ef";

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

const accessControlAbi = [
  { name: "hasRole", type: "function", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { name: "grantRole", type: "function", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
] as const;

function parseArgs(argv: string[]): { to: `0x${string}`; envPath: string } {
  let to = DEPLOYER;
  let envPath = resolve(REPO_ROOT, ".env");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--to") to = argv[++i] ?? to;
    else if (argv[i] === "--env") envPath = resolve(process.cwd(), argv[++i] ?? "");
    else fail(`unexpected argument "${argv[i]}"`);
  }
  return { to: getAddress(to), envPath };
}

async function main(): Promise<void> {
  const { to, envPath } = parseArgs(process.argv.slice(2));
  try {
    process.loadEnvFile(envPath);
  } catch {
    fail(`could not read env file: ${envPath}\n  Pass one with --env ../.env`);
  }

  const config = loadConfig();
  const vault = getAddress(config.vaultAddress ?? getDeployment(MANTLE_MAINNET_CHAIN_ID).vault);
  if (vault === "0x0000000000000000000000000000000000000000") fail("VAULT_ADDRESS unresolved");

  const { publicClient } = makeClients(config);
  await assertChainId(publicClient);

  // Already granted? Then we're done.
  const already = (await publicClient.readContract({ address: vault, abi: accessControlAbi, functionName: "hasRole", args: [GUARDIAN_ROLE, to] })) as boolean;
  if (already) {
    process.stdout.write(`✓ ${to} already holds GUARDIAN on ${vault} — nothing to do.\n`);
    return;
  }

  const key = (process.env.ADMIN_PRIVATE_KEY || "").trim();
  if (!key) fail("ADMIN_PRIVATE_KEY is required (the DEFAULT_ADMIN_ROLE holder that can grant GUARDIAN)");
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);

  // The signer must hold DEFAULT_ADMIN_ROLE (GUARDIAN's role-admin), else grantRole reverts.
  const isAdmin = (await publicClient.readContract({ address: vault, abi: accessControlAbi, functionName: "hasRole", args: [DEFAULT_ADMIN_ROLE, account.address] })) as boolean;
  if (!isAdmin) fail(`signer ${account.address} does not hold DEFAULT_ADMIN_ROLE on ${vault} — it cannot grant GUARDIAN`);

  const walletClient = createWalletClient({ account, chain: mantle, transport: makeTransport(config.mantleRpcUrl) });

  process.stdout.write(`Vault    : ${vault}\nAdmin    : ${account.address}\nGrantee  : ${to}\nRole     : GUARDIAN (${GUARDIAN_ROLE})\n\nSending grantRole…\n`);
  const hash = await walletClient.writeContract({ address: vault, abi: accessControlAbi, functionName: "grantRole", args: [GUARDIAN_ROLE, to], chain: mantle, account });
  process.stdout.write(`  tx: ${hash}\n  waiting for receipt…\n`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: config.txReceiptTimeoutMs });
  if (receipt.status === "reverted") fail(`grantRole reverted on-chain (tx ${hash})`);

  const ok = (await publicClient.readContract({ address: vault, abi: accessControlAbi, functionName: "hasRole", args: [GUARDIAN_ROLE, to] })) as boolean;
  if (!ok) fail("tx mined but hasRole(GUARDIAN, grantee) is still false — unexpected");
  process.stdout.write(`\n✓ GUARDIAN granted to ${to} (tx ${hash}).\n  Set GUARDIAN_PRIVATE_KEY to that address's key for demo:derisk.\n`);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
}
