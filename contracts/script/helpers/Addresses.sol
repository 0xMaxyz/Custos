// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title Addresses — Mantle mainnet + testnet protocol addresses.
 *
 * Mainnet addresses verified from Fork.t.sol Phase 0.3 gate and official docs.
 * Testnet (Mantle Sepolia, chainId 5003) token addresses are read from env
 * because test deployments vary; see Deploy.s.sol for resolution logic.
 */
library Addresses {
    // ── Mantle mainnet (chainId 5000) ─────────────────────────────────────────

    address internal constant MAINNET_USDC = 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9;
    address internal constant MAINNET_USDY = 0x5bE26527e817998A7206475496fDE1E68957c5A6;
    address internal constant MAINNET_AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    /// Ondo mUSD — rebasing $1 form of USDY + the wrap/unwrap "Ondo Token Converter".
    /// Verified on-chain: usdy()==MAINNET_USDY, oracle()==MAINNET_USDY_ORACLE, 18 dec.
    address internal constant MAINNET_MUSD = 0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3;

    /// Ondo USDY Redemption Price Oracle — getPrice() returns 18-dec NAV.
    address internal constant MAINNET_USDY_ORACLE = 0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f;
    /// Pinned 1delta swap executor for USDC<->USDY/AUSD swaps (UsdyAdapter/AusdAdapter).
    /// 1delta's /actions/swap routes every swap through this single contract; the adapter
    /// pre-approves it and runs its returned calldata under an oracle-derived balance-delta
    /// minOut (the executor's output is never trusted; output must land on the adapter).
    /// extcodesize = 1581 on Mantle mainnet (verified this review).
    address internal constant MAINNET_USDY_ROUTER = 0x5C019a146758287C614FE654CaEC1ba1CaF05F4E;
    /// Aave v3 PoolAddressesProvider; Pool + aUSDC resolved dynamically.
    address internal constant MAINNET_AAVE_PROVIDER = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;

    // ERC-8004 canonical singletons (present on Mantle mainnet).
    address internal constant MAINNET_ERC8004_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant MAINNET_ERC8004_REPUTATION =
        0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    // ── Mantle testnet / Mantle Sepolia (chainId 5003) ────────────────────────

    // Token addresses on Mantle Sepolia — resolved from env vars TESTNET_USDC etc.
    // Fallback: deploy mock tokens via DeployMocks.s.sol if no env var set.
    address internal constant TESTNET_ERC8004_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant TESTNET_ERC8004_REPUTATION =
        0x8004B663056A597Dffe9eCcC1965A193B7388713;
}
