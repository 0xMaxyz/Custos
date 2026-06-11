/**
 * IPFS pin smoke test (dev utility).
 *
 * Pins a tiny throwaway bundle through the real pinning path so a misconfigured
 * backend (wrong `IPFS_API_URL`, bad/expired `IPFS_PINNING_JWT` → HTTP 401) fails
 * loudly *here*, not silently mid-decision-cycle where the pin is fail-open.
 *
 * Usage (from the `agent/` dir):
 *   pnpm pin:smoke              # loads ../.env
 *   pnpm pin:smoke ../.env2     # loads a specific env file
 *
 * Exit code: 0 on a successful pin, 1 on any failure (so it's CI/script friendly).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Bucket } from "@custos/shared";
import { loadConfig } from "../config.js";
import { pinRationale, type RationaleBundle } from "../executor/ipfs.js";

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
    fail(`Could not read env file: ${envPath}\n  Pass a path, e.g. pnpm pin:smoke ../.env2`);
  }

  const config = loadConfig();

  // Surface which backend we're actually hitting before the network call.
  let backend: string;
  if (!config.ipfsApiUrl) {
    backend = "none (data: URI fallback — set IPFS_API_URL to test a real pin)";
  } else if (/(^|\.)pinata\.cloud$/i.test(new URL(config.ipfsApiUrl).hostname)) {
    backend = `Pinata (${config.ipfsApiUrl})`;
  } else {
    backend = `Kubo (${config.ipfsApiUrl})`;
  }
  process.stdout.write(`Env file:  ${envPath}\n`);
  process.stdout.write(`Backend:   ${backend}\n`);
  process.stdout.write(`Auth:      ${config.ipfsPinningJwt ? "Bearer JWT set" : "no JWT"}\n\n`);

  const bundle: RationaleBundle = {
    rationale: "Custos IPFS pin smoke test — safe to unpin.",
    signals: [],
    evidence: [],
    candidateWeightsBps: { [Bucket.IDLE]: 10_000, [Bucket.AAVE]: 0, [Bucket.USDY]: 0, [Bucket.AUSD]: 0 },
    riskLevel: "NORMAL",
    asOf: new Date().toISOString(),
  };

  const { uri, rationaleHash } = await pinRationale(bundle, config).catch((err: unknown) => {
    fail(`Pin failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  process.stdout.write(`✓ Pinned\n`);
  process.stdout.write(`  uri:           ${uri}\n`);
  process.stdout.write(`  rationaleHash: ${rationaleHash}\n`);
  if (uri.startsWith("ipfs://")) {
    process.stdout.write(`  gateway:       ${gatewayUrl(uri, config.ipfsGatewayUrl)}\n`);
  } else {
    process.stdout.write(`  note:          data: URI — no IPFS backend configured, nothing was pinned remotely.\n`);
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
