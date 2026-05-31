// Mantle chain config (§4 — Mantle-only). Wraps viem's built-in chain defs and
// applies env-overridable RPC endpoints. Mainnet 5000 · testnet (Sepolia) 5003.

import { defineChain } from "viem";
import { mantle, mantleSepoliaTestnet } from "viem/chains";
import { MANTLE_MAINNET_CHAIN_ID, MANTLE_TESTNET_CHAIN_ID } from "@sentinel/shared";

const MAINNET_RPC = import.meta.env.VITE_MANTLE_RPC_URL || "https://rpc.mantle.xyz";
const TESTNET_RPC = import.meta.env.VITE_MANTLE_TESTNET_RPC_URL || "https://rpc.sepolia.mantle.xyz";

export const mantleMainnet = defineChain({
  ...mantle,
  id: MANTLE_MAINNET_CHAIN_ID,
  rpcUrls: { default: { http: [MAINNET_RPC] } },
});

export const mantleTestnet = defineChain({
  ...mantleSepoliaTestnet,
  id: MANTLE_TESTNET_CHAIN_ID,
  rpcUrls: { default: { http: [TESTNET_RPC] } },
});

// Sentinel runs Mantle-only — these are the sole supported chains.
export const supportedChains = [mantleMainnet, mantleTestnet] as const;

export const DEFAULT_CHAIN =
  import.meta.env.VITE_DEFAULT_CHAIN === "testnet" ? mantleTestnet : mantleMainnet;
