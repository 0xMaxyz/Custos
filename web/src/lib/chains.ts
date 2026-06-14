// Mantle chain config (§4 — Mantle-only). Wraps viem's built-in chain defs and
// applies env-overridable RPC endpoints. Mainnet 5000 · testnet (Sepolia) 5003.

import { defineChain } from "viem";
import { mantle, mantleSepoliaTestnet } from "viem/chains";
import { MANTLE_MAINNET_CHAIN_ID, MANTLE_TESTNET_CHAIN_ID, getDeployment } from "@custos/shared";

// A pool of public Mantle RPCs. The app fans these out through a viem `fallback`
// transport (see providers.tsx) so a single rate-limited endpoint (429) fails over to
// the next instead of stalling reads — the browser-side analogue of the agent's RPC
// rotation, minus the premium endpoint. Override/extend with a comma-separated
// VITE_MANTLE_RPC_URL (its entries are tried first).
const DEFAULT_MAINNET_RPCS = [
  "https://rpc.mantle.xyz",
  "https://mantle-rpc.publicnode.com",
  "https://mantle.drpc.org",
  "https://1rpc.io/mantle",
];

function parseRpcList(env: string | undefined, fallbacks: string[]): string[] {
  const fromEnv = (env ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  // Env entries first (operator preference), then the public pool, de-duplicated.
  return [...new Set([...fromEnv, ...fallbacks])];
}

export const MAINNET_RPCS = parseRpcList(import.meta.env.VITE_MANTLE_RPC_URL, DEFAULT_MAINNET_RPCS);
export const TESTNET_RPCS = parseRpcList(import.meta.env.VITE_MANTLE_TESTNET_RPC_URL, ["https://rpc.sepolia.mantle.xyz"]);

export const mantleMainnet = defineChain({
  ...mantle,
  id: MANTLE_MAINNET_CHAIN_ID,
  rpcUrls: { default: { http: MAINNET_RPCS } },
});

export const mantleTestnet = defineChain({
  ...mantleSepoliaTestnet,
  id: MANTLE_TESTNET_CHAIN_ID,
  rpcUrls: { default: { http: TESTNET_RPCS } },
});

const hasDeploy = (id: number) => (getDeployment(id).vault?.length ?? 0) > 2;

// Default to the chain that actually has a Custos deployment so the app reads
// live out of the box: an explicit VITE_DEFAULT_CHAIN wins, otherwise prefer
// mainnet once it's deployed, else the testnet deploy, else mainnet.
export const DEFAULT_CHAIN =
  import.meta.env.VITE_DEFAULT_CHAIN === "testnet" ? mantleTestnet
  : import.meta.env.VITE_DEFAULT_CHAIN === "mantle" ? mantleMainnet
  : hasDeploy(MANTLE_MAINNET_CHAIN_ID) ? mantleMainnet
  : hasDeploy(MANTLE_TESTNET_CHAIN_ID) ? mantleTestnet
  : mantleMainnet;

// Custos runs Mantle-only. The default (deployed) chain is listed first so it's
// the wagmi default for disconnected reads; the set is unchanged.
export const supportedChains =
  DEFAULT_CHAIN.id === mantleMainnet.id
    ? ([mantleMainnet, mantleTestnet] as const)
    : ([mantleTestnet, mantleMainnet] as const);
