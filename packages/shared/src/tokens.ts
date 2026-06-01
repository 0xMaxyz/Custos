import type { Address } from "./types.js";

/**
 * Mantle mainnet (chainId 5000) token metadata for the buckets we use.
 *
 * Addresses + decimals extracted from the 1delta curated Mantle token list:
 * https://github.com/1delta-DAO/token-lists/raw/refs/heads/main/5000.json
 *
 * NOTE: a separate "aUSD" (Aurelius USD, 18 decimals) exists on Mantle — that is
 * NOT our safety asset. Our AUSD is Agora's, at 0x0000…012a (6 decimals).
 */
export interface TokenInfo {
  readonly symbol: string;
  readonly name: string;
  readonly address: Address;
  readonly decimals: number;
}

export const TOKENS = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
    decimals: 6,
  },
  USDY: {
    symbol: "USDY",
    name: "Ondo U.S. Dollar Yield",
    address: "0x5bE26527e817998A7206475496fDE1E68957c5A6",
    decimals: 18,
  },
  AUSD: {
    symbol: "AUSD",
    name: "AUSD (Agora)",
    address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
    decimals: 6,
  },
  WMNT: {
    symbol: "WMNT",
    name: "Wrapped Mantle",
    address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
    decimals: 18,
  },
  MUSD: {
    symbol: "MUSD",
    name: "Mantle USD",
    address: "0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3",
    decimals: 18,
  },
} as const satisfies Record<string, TokenInfo>;

export type TokenSymbol = keyof typeof TOKENS;
