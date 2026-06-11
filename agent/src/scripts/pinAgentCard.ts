/**
 * Build + pin the ERC-8004 agent card (production utility, deploy.md step 4).
 *
 * Produces the `AGENT_CARD_URI` consumed by `contracts/script/RegisterIdentity.s.sol`.
 * The card publishes the x402 sell-side offer (`sells`) when one is configured, with
 * the payee resolved through the same identity binding the running agent uses
 * (identity/payee.ts) — so the pinned card and the live 402 challenge agree.
 *
 * Inputs (env):
 *   AGENT_API_URL          public base URL of the agent API (required; falls back
 *                          to VITE_AGENT_API_URL)
 *   AGENT_DASHBOARD_URL    optional public dashboard URL
 *   ALLOCATOR_ADDRESS      card `wallet` (falls back to deriving it from
 *                          ALLOCATOR_PRIVATE_KEY — keyless pinning works too)
 *   X402_PAY_TO / X402_ASSET / AGENT_ID  payee resolution, see identity/payee.ts
 *
 * Usage (from the `agent/` dir):
 *   pnpm card:pin              # loads ../.env
 *   pnpm card:pin ../.env2     # loads a specific env file
 *
 * Exit code: 0 on a successful pin, 1 on any failure. NOTE: re-run this (and
 * `setAgentURI`) whenever the payee/price changes — the pinned card is immutable.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../config.js";
import { makeClients } from "../chain/clients.js";
import { makeIdentityOwnerReader, resolveX402PayTo } from "../identity/payee.js";
import { pinAgentCard } from "../identity/agentCard.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../.."); // agent/src/scripts → repo root

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

/** Map an ipfs:// URI to an HTTPS gateway URL for a clickable check. */
function gatewayUrl(uri: string, gateway: string): string {
  const cid = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  return `${gateway.replace(/\/+$/, "")}/ipfs/${cid}`;
}

async function main(): Promise<void> {
  // Resolve the env file: explicit arg (relative to cwd) or repo-root `.env`.
  const arg = process.argv[2];
  const envPath = arg ? resolve(process.cwd(), arg) : resolve(REPO_ROOT, ".env");
  try {
    process.loadEnvFile(envPath);
  } catch {
    fail(`Could not read env file: ${envPath}\n  Pass a path, e.g. pnpm card:pin ../.env2`);
  }

  const config = loadConfig();

  const apiUrl = process.env.AGENT_API_URL || process.env.VITE_AGENT_API_URL;
  if (!apiUrl) fail("AGENT_API_URL (or VITE_AGENT_API_URL) is required — the card's `endpoints.api`");
  const dashboardUrl = process.env.AGENT_DASHBOARD_URL || undefined;

  // Card `wallet` = the ALLOCATOR (the key that signs decisions). Allow a plain
  // address so the card can be pinned from a machine that never holds the key.
  const wallet = config.allocatorAddress
    ? getAddress(config.allocatorAddress)
    : config.allocatorPrivateKey
      ? privateKeyToAccount(config.allocatorPrivateKey as `0x${string}`).address
      : fail("Set ALLOCATOR_ADDRESS (or ALLOCATOR_PRIVATE_KEY) — the card's `wallet`");

  // Resolve the x402 payee exactly as the running agent will (incl. the ALLOCATOR
  // guard), so the pinned `sells.payTo` and the live 402 challenge can't diverge.
  const payee = await resolveX402PayTo({
    config,
    readOwner:
      config.agentId !== undefined && config.x402Asset
        ? makeIdentityOwnerReader(makeClients(config).publicClient)
        : undefined,
    warn: (msg) => process.stderr.write(`! x402 payee: ${msg}\n`),
  });

  process.stdout.write(`Env file:  ${envPath}\n`);
  process.stdout.write(`Backend:   ${config.ipfsApiUrl ?? "none (data: URI fallback — set IPFS_API_URL to pin for real)"}\n`);
  process.stdout.write(
    payee.payTo
      ? `x402 sells: /risk-score → payTo ${payee.payTo} (source: ${payee.source})\n\n`
      : `x402 sells: none (set X402_ASSET + X402_PAY_TO or AGENT_ID to publish the offer)\n\n`,
  );

  const { uri, card } = await pinAgentCard(config, {
    wallet,
    apiUrl,
    ...(dashboardUrl ? { dashboardUrl } : {}),
    ...(payee.payTo ? { x402PayTo: payee.payTo } : {}),
  }).catch((err: unknown) => {
    fail(`Pin failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  process.stdout.write(`✓ Pinned agent card\n`);
  process.stdout.write(`  AGENT_CARD_URI=${uri}\n`);
  if (uri.startsWith("ipfs://")) {
    process.stdout.write(`  gateway:       ${gatewayUrl(uri, config.ipfsGatewayUrl)}\n`);
  } else {
    process.stdout.write(`  note:          data: URI — no IPFS backend configured, nothing was pinned remotely.\n`);
  }
  process.stdout.write(`  card:          ${JSON.stringify(card)}\n`);
  process.stdout.write(`\nNext: export AGENT_CARD_URI and run contracts/script/RegisterIdentity.s.sol\n`);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
