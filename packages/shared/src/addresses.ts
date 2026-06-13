import type { Address, AddressRecord } from "./types.js";

export const MANTLE_MAINNET_CHAIN_ID = 5000 as const;
export const MANTLE_TESTNET_CHAIN_ID = 5003 as const;

/**
 * ERC-8004 Trustless Agents registries — verified present on Mantle.
 * Source: https://github.com/erc-8004/erc-8004-contracts
 *
 * These are deployed singletons, so Custos registers against them rather than
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
  // TODO: upgrade to "verified @ block N" once fork-tests CI job confirms
  //       extcodesize > 0 and getPrice() returns a plausible NAV.
  usdyRWADynamicOracle: "0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f",
  // Ondo Token Converter for USDY <-> mUSD (the two on-chain forms of the RWA
  // leg). VERIFIED: the "converter" is the mUSD token contract ITSELF — it hosts
  // wrap(uint256) (USDY->mUSD) and unwrap(uint256) (mUSD->USDY); there is no
  // separate converter contract. So this equals TOKENS.MUSD.address.
  // On-chain checks (Mantle 5000, ForkPhase2d.t.sol): code present; 18 decimals;
  // mUSD.usdy() == TOKENS.USDY.address; mUSD.oracle() == usdyRWADynamicOracle;
  // a USDY->mUSD->USDY round-trip is value-neutral at oracle NAV.
  // TODO: stamp "verified @ block N" once the Phase-0 fork gate runs in CI.
  ondoTokenConverter: "0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3",
  // Pinned 1delta swap executor used by UsdyAdapter for USDC<->USDY swaps. 1delta's
  // /actions/swap endpoint routes every swap through this single contract; the adapter
  // pre-approves it and runs its returned calldata under an oracle-derived balance-delta
  // minOut. Must equal the adapter's on-chain immutable AGGREGATOR.
  // extcodesize = 1581 on Mantle mainnet (verified this review).
  usdyAggregatorRouter: "0x5C019a146758287C614FE654CaEC1ba1CaF05F4E",
  // AUSD swaps (AusdAdapter) reuse the same pinned 1delta executor as USDY — there is no
  // separate AUSD router. Kept as an explicit alias rather than null so callers don't
  // read it as "AUSD routing not wired".
  dexRouterAusd: "0x5C019a146758287C614FE654CaEC1ba1CaF05F4E",
};
