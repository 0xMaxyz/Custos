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
 * Entries still `null` await confirmation against a live Mantle fork — DO NOT guess.
 *
 * Addresses below carry a source but NOT yet a "verified @ block N" tag: they are
 * recorded from official docs and used by the fork tests, but the on-chain
 * extcodesize/ABI gate must run (needs Mantle RPC) before they are considered
 * verified. Once a fork run confirms them, replace the source note with
 * `// verified @ block N`.
 */
export const PROTOCOLS: Record<string, Address | null> = {
  // Aave v3 on Mantle — PoolAddressesProvider (resolves Pool + DataProvider).
  // NOTE: 0xa97684... is the Polygon provider (empty on Mantle); the line below
  // is Mantle's. source: aave.com/docs/resources/addresses
  aaveV3PoolAddressesProvider: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
  // Resolved from the provider on a live fork (Pool.getReserveData(USDC).aToken).
  aaveV3Pool: null,
  aaveV3PoolDataProvider: null,
  aUSDC: null,
  // Ondo USDY Redemption Price Oracle — exposes getPrice() (18-dec NAV).
  // currentRange() is NOT implemented on this deployment; UsdyAdapter handles
  // that via try/catch. source: Ondo docs / Phase 0.3 gate
  usdyRWADynamicOracle: "0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f",
  // DEX router for USDC<->USDY (Merchant Moe LB Router v2).
  // source: docs.merchantmoe.com/developer-resources/contract-addresses
  dexRouterUsdy: "0xeaEE7EE68874218c3558b40063c42B82D3E7232a",
  dexRouterAusd: null,
};
