// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IMusd — Ondo mUSD (Mantle USD) wrap/unwrap converter
 * @notice mUSD is the rebasing ($1-pegged) form of USDY. The conversion between
 *         the two on-chain forms of the Ondo RWA core (USDY ↔ mUSD) is performed
 *         by `wrap`/`unwrap` hosted on the mUSD token contract ITSELF — there is no
 *         separate "Token Converter" contract (the ROADMAP's "Ondo Token Converter"
 *         is this contract).
 *
 * On-chain verification (Mantle mainnet 5000, see ForkPhase2d.t.sol):
 *   - mUSD  = 0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3 (proxy → impl
 *             0x907D8399d13cee098cEf486a8427933aaC7E6271), 18 decimals.
 *   - mUSD.usdy()   == USDY  (0x5bE26527e817998A7206475496fDE1E68957c5A6)
 *   - mUSD.oracle() == RWADynamicOracle (0xA96abbe61AfEdEB0D14a20440Ae7100D9aB4882f)
 *   - wrap(uint256)   selector 0xea598cb0 — pulls USDY via transferFrom (caller MUST
 *     approve mUSD first; probe reverts "ERC20: insufficient allowance" otherwise),
 *     mints mUSD ≈ usdyAmount × NAV / 1e18.
 *   - unwrap(uint256) selector 0xde0e9a3e — burns the caller's mUSD (probe reverts
 *     "BURN_AMOUNT_EXCEEDS_BALANCE" with no balance), returns USDY ≈ musdAmount × 1e18 / NAV.
 *
 * Conversion is oracle-priced (the same `RWADynamicOracle` USDY accounting uses), so
 * it is value-neutral and slippage-free apart from rounding — there is NO DEX
 * liquidity involved. Callers should still enforce an oracle-derived `minOut` on the
 * realized balance delta (the return value is intentionally NOT relied upon).
 *
 * @dev Return values are intentionally omitted: the deployed contract's exact return
 *      type is not relied upon. Callers measure the actual balance delta instead,
 *      consistent with AGENTS.md §2.1 (never trust a venue's self-reported output).
 */
interface IMusd {
    /// @notice Convert `usdyAmount` of USDY into mUSD. Caller must have approved mUSD
    ///         to spend `usdyAmount` USDY. Minted mUSD is sent to the caller.
    function wrap(uint256 usdyAmount) external;

    /// @notice Convert `musdAmount` of the caller's mUSD back into USDY. Burns mUSD
    ///         from the caller and sends the unwrapped USDY to the caller.
    function unwrap(uint256 musdAmount) external;

    /// @notice The USDY token this mUSD wraps.
    function usdy() external view returns (address);

    /// @notice The RWADynamicOracle used to price the USDY ↔ mUSD conversion.
    function oracle() external view returns (address);
}
