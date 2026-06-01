import type { Address, AddressRecord } from "./types.js";

export const MANTLE_MAINNET_CHAIN_ID = 5000 as const;
export const MANTLE_TESTNET_CHAIN_ID = 5003 as const;

/**
 * ERC-8004 Trustless Agents registries — verified present on Mantle.
 * Source: https://github.com/erc-8004/erc-8004-contracts
 *
 * These are deployed singletons, so Sentinel registers against them rather than
 * deploying its own. Re-confirm `extcodesize > 0` once the Mantle RPC host is
 * allowlisted in the execution environment (Phase 0.3 gate).
 */
export const ERC8004 = {
  mainnet: {
    identityRegistry: {
      address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      provenance: "source:erc-8004/erc-8004-contracts",
    },
    reputationRegistry: {
      address: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      provenance: "source:erc-8004/erc-8004-contracts",
    },
  },
  testnet: {
    identityRegistry: {
      address: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      provenance: "source:erc-8004/erc-8004-contracts",
    },
    reputationRegistry: {
      address: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      provenance: "source:erc-8004/erc-8004-contracts",
    },
  },
} as const satisfies Record<string, Record<string, AddressRecord>>;

/**
 * Protocol addresses to resolve + verify during the Phase 0.3 on-chain gate.
 * Left as `null` until confirmed against a live Mantle fork — DO NOT guess.
 */
export const PROTOCOLS: Record<string, Address | null> = {
  // Aave v3 on Mantle
  aaveV3Pool: null,
  aaveV3PoolDataProvider: null,
  aUSDC: null,
  // Ondo USDY pricing
  usdyRWADynamicOracle: null,
  // Ondo Token Converter for USDY <-> mUSD (the two on-chain forms of the RWA leg)
  ondoTokenConverter: null,
  // DEX routers for USDC<->USDY, USDC<->mUSD, USDC<->AUSD, USDY<->WMNT
  dexRouterUsdy: null,
  dexRouterAusd: null,
};
