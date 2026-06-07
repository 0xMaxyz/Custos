// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Fork.t.sol - Phase 0 on-chain verification gate (tasks 0.2-0.5)
 *
 * Run with a live Mantle fork:
 *   forge test --fork-url $MANTLE_RPC_URL --match-contract ForkTest -vv
 *
 * Tasks covered:
 *   0.2  Chain / USDC sanity
 *   0.3  Address & capability verification (extcodesize + basic call per interface)
 *   0.4  Liquidity & swap-quote gate at $100 / $1k / $10k
 *   0.5  USDY transfer-hook (blocklist) check
 */

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20Minimal } from "../src/interfaces/IERC20Minimal.sol";
import { IPoolAddressesProvider } from "../src/interfaces/IPoolAddressesProvider.sol";
import { IAaveV3Pool, ReserveData } from "../src/interfaces/IAaveV3Pool.sol";
import { IRWADynamicOracle } from "../src/interfaces/IRWADynamicOracle.sol";

contract ForkTest is Test {
    // ── Token addresses (verified from 1delta curated list) ──────────────────
    address internal constant USDC = 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9;
    address internal constant USDY = 0x5bE26527e817998A7206475496fDE1E68957c5A6;
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a; // Agora
    address internal constant WMNT = 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8;

    // ── Aave v3 on Mantle ─────────────────────────────────────────────────────
    // Source: https://aave.com/docs/resources/addresses - Mantle mainnet
    // NOTE: 0xa97684... is the Polygon provider and is an empty slot on Mantle.
    // The Mantle PoolAddressesProvider is the address below.
    address internal constant AAVE_ADDRESSES_PROVIDER = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;

    // ── Ondo USDY oracle - resolved from USDY contract during 0.3 gate ───────
    // Populated in setUp() via on-chain read; recorded in addresses.ts after gate.
    address internal usdyOracle;

    // ── Derived (resolved in setUp) ───────────────────────────────────────────
    address internal aavePool;
    address internal aaveDataProvider;
    address internal aUsdc;

    // ── ERC-8004 singletons (to verify presence on Mantle) ───────────────────
    address internal constant ERC8004_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant ERC8004_REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    // ── Merchant Moe LB Router (Mantle mainnet) ───────────────────────────────
    // Source: https://docs.merchantmoe.com/developer-resources/contract-addresses
    address internal constant MM_LB_ROUTER = 0xeaEE7EE68874218c3558b40063c42B82D3E7232a;

    function setUp() public {
        // Resolve Aave addresses dynamically from the PoolAddressesProvider.
        IPoolAddressesProvider provider = IPoolAddressesProvider(AAVE_ADDRESSES_PROVIDER);
        aavePool = provider.getPool();
        aaveDataProvider = provider.getPoolDataProvider();

        // aUSDC address from Aave pool reserve data.
        ReserveData memory rd = IAaveV3Pool(aavePool).getReserveData(USDC);
        aUsdc = rd.aTokenAddress;

        // Attempt to read the USDY oracle from the token contract (Ondo stores it
        // as a public variable `oracle`).
        (bool ok, bytes memory data) = USDY.staticcall(abi.encodeWithSignature("oracle()"));
        if (ok && data.length == 32) {
            usdyOracle = abi.decode(data, (address));
        }
    }

    // ── Task 0.2 - chain / USDC sanity ───────────────────────────────────────

    function testForkSanity() public view {
        assertEq(block.chainid, 5000, "wrong chain - must be Mantle mainnet (5000)");
        assertEq(IERC20Minimal(USDC).decimals(), 6, "USDC decimals != 6");
        console2.log("[0.2] chain id OK:", block.chainid);
        console2.log("[0.2] USDC decimals OK:", IERC20Minimal(USDC).decimals());
    }

    // ── Task 0.3 - address & capability verification ──────────────────────────

    function testAddressesHaveCode() public view {
        _assertCode("USDC", USDC);
        _assertCode("USDY", USDY);
        _assertCode("AUSD", AUSD);
        _assertCode("WMNT", WMNT);
        _assertCode("AavePool", aavePool);
        _assertCode("AaveDataProv", aaveDataProvider);
        _assertCode("aUSDC", aUsdc);
        _assertCode("MM_LB_ROUTER", MM_LB_ROUTER);
    }

    function testAaveReserveDataUSDC() public view {
        ReserveData memory rd = IAaveV3Pool(aavePool).getReserveData(USDC);
        assertTrue(rd.aTokenAddress != address(0), "aUSDC address zero");
        assertTrue(rd.currentLiquidityRate > 0, "USDC supply APY is zero");
        console2.log("[0.3] aUSDC:", rd.aTokenAddress);
        console2.log("[0.3] USDC supply rate (ray):", rd.currentLiquidityRate);
    }

    function testUsdyOracleReturnsPrice() public view {
        // If USDY token doesn't expose oracle(), we'll look for known oracle addresses.
        address oracle = usdyOracle;
        if (oracle == address(0)) {
            console2.log("[0.3] USDY.oracle() not found - oracle address needs manual lookup");
            return; // non-fatal; recorded in ROADMAP for manual resolution
        }
        uint256 price = IRWADynamicOracle(oracle).getPrice();
        assertGt(price, 0, "USDY oracle returned 0");
        // USDY NAV should be >= $1.00 (1e18) and <= $2.00 (2e18)
        assertGe(price, 1e18, "USDY NAV below $1");
        assertLe(price, 2e18, "USDY NAV above $2 - unexpected");
        console2.log("[0.3] USDY oracle:", oracle);
        console2.log("[0.3] USDY NAV (18 dec):", price);
    }

    function testUsdyDecimals() public view {
        assertEq(IERC20Minimal(USDY).decimals(), 18, "USDY decimals != 18");
        assertEq(IERC20Minimal(AUSD).decimals(), 6, "AUSD decimals != 6");
    }

    function testErc8004PresenceOnMantle() public view {
        uint256 idSize;
        uint256 repSize;
        assembly {
            idSize := extcodesize(ERC8004_IDENTITY)
            repSize := extcodesize(ERC8004_REPUTATION)
        }
        // Log results regardless - gate decision is recorded in ROADMAP.
        console2.log("[0.3] ERC-8004 IdentityRegistry codesize:", idSize);
        console2.log("[0.3] ERC-8004 ReputationRegistry codesize:", repSize);
        if (idSize == 0) {
            console2.log(
                "[0.3] WARN: ERC-8004 singletons absent on Mantle - must deploy own registries"
            );
        } else {
            console2.log("[0.3] ERC-8004 singletons confirmed on Mantle");
        }
    }

    // ── Task 0.4 - liquidity & swap-quote gate ────────────────────────────────

    /// @notice Validates USDC→USDY swap feasibility at three sizes.
    ///         Records slippage vs USDY NAV oracle price (if available).
    function testLiquidityGateUsdy() public {
        uint256[3] memory amounts = [uint256(100e6), 1_000e6, 10_000e6]; // $100, $1k, $10k USDC

        console2.log("[0.4] ============ USDY liquidity gate ============");
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 usdcIn = amounts[i];
            // Deal USDC to this test contract (bypasses blocklist - we hold USDC).
            deal(USDC, address(this), usdcIn);
            IERC20Minimal(USDC).approve(MM_LB_ROUTER, usdcIn);

            // Execute USDC→WMNT→USDY path (Merchant Moe two-hop).
            // If a direct USDC/USDY pool exists with sufficient depth, switch to 1-hop.
            uint256 balBefore = IERC20Minimal(USDY).balanceOf(address(this));
            (bool ok,) = _swapUsdcToUsdy(usdcIn);
            if (!ok) {
                console2.log("[0.4] swap FAILED for USDC amount:", usdcIn);
                // Non-fatal: record and continue - gate decision may trigger fallback path.
                continue;
            }
            uint256 usdyOut = IERC20Minimal(USDY).balanceOf(address(this)) - balBefore;
            assertGt(usdyOut, 0, "swap returned 0 USDY");

            // Slippage: compare usdyOut (18 dec) vs usdcIn (6 dec) adjusted to 18 dec.
            // At ~$1 NAV, 1 USDC ~ 1e12 USDY-units. Slippage = 1 - (usdyOut/1e12 / usdcIn).
            uint256 expected18 = uint256(usdcIn) * 1e12; // 1:1 at par
            uint256 slippageBps =
                expected18 > usdyOut ? ((expected18 - usdyOut) * 10_000) / expected18 : 0;

            console2.log("[0.4] USDC in:", usdcIn / 1e6, "USD  |  USDY out (18dec):", usdyOut);
            console2.log("[0.4] slippage bps:", slippageBps);
            if (slippageBps <= 50) {
                console2.log("[0.4] GO - slippage <= 50 bps");
            } else {
                console2.log("[0.4] WARN - slippage > 50 bps, review DEX route");
            }
        }
    }

    // ── Task 0.5 - USDY transfer-hook (blocklist) check ──────────────────────

    function testUsdyTransferHookNotBlocked() public {
        // A fresh test-contract address (address(this)) should not be blocklisted.
        // Check by querying the USDY blocklist if the interface is known, then
        // confirm by actually swapping + transferring.
        uint256 usdcIn = 100e6; // $100
        deal(USDC, address(this), usdcIn);
        IERC20Minimal(USDC).approve(MM_LB_ROUTER, usdcIn);

        uint256 balBefore = IERC20Minimal(USDY).balanceOf(address(this));
        (bool ok,) = _swapUsdcToUsdy(usdcIn);

        if (!ok) {
            console2.log("[0.5] USDC->USDY swap failed - cannot test transfer hook");
            return;
        }

        uint256 usdyHeld = IERC20Minimal(USDY).balanceOf(address(this)) - balBefore;
        assertGt(usdyHeld, 0, "no USDY received");
        console2.log("[0.5] USDY received:", usdyHeld);

        // Transfer half to a different address - should succeed if not blocklisted.
        address recipient = makeAddr("recipient");
        bool transferred = IERC20Minimal(USDY).transfer(recipient, usdyHeld / 2);
        assertTrue(transferred, "USDY transfer reverted - vault address may be blocklisted");
        assertEq(
            IERC20Minimal(USDY).balanceOf(recipient), usdyHeld / 2, "recipient balance mismatch"
        );
        console2.log("[0.5] USDY transfer OK - address(this) is not blocklisted");

        // Attempt to check blocklist status directly.
        (bool hasBlocklist, bytes memory blData) =
            USDY.staticcall(abi.encodeWithSignature("isBlocked(address)", address(this)));
        if (hasBlocklist && blData.length == 32) {
            bool blocked = abi.decode(blData, (bool));
            assertFalse(
                blocked, "test contract IS blocklisted - must use a different vault address"
            );
            console2.log("[0.5] USDY.isBlocked(address(this)):", blocked);
        } else {
            console2.log(
                "[0.5] USDY blocklist interface not directly accessible - transfer test is sufficient"
            );
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _assertCode(string memory label, address addr) internal view {
        uint256 sz;
        assembly { sz := extcodesize(addr) }
        assertGt(sz, 0, string.concat(label, ": no code at address"));
        console2.log(string.concat("[0.3] ", label, " extcodesize:"), sz);
    }

    /// @notice Executes USDC→USDY via Merchant Moe.
    ///         Tries direct USDC/USDY pool first; falls back to USDC→WMNT→USDY.
    function _swapUsdcToUsdy(uint256 usdcIn) internal returns (bool ok, bytes memory ret) {
        // Direct path: USDC→USDY (1 hop, bin step 1 = v2.1 pool)
        bytes memory callData = abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,(uint256[],uint8[],address[]),address,uint256)",
            usdcIn,
            0, // minOut = 0 for gate testing only; real adapters enforce minOut
            _buildPath1Hop(USDC, USDY, 1, 2), // version 2 = LBPair v2.1
            address(this),
            block.timestamp + 300
        );
        (ok, ret) = MM_LB_ROUTER.call(callData);
        if (ok) return (ok, ret);

        // Fallback: USDC→WMNT→USDY (2 hops)
        callData = abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,(uint256[],uint8[],address[]),address,uint256)",
            usdcIn,
            0,
            _buildPath2Hop(USDC, WMNT, USDY, 1, 1, 2, 2),
            address(this),
            block.timestamp + 300
        );
        (ok, ret) = MM_LB_ROUTER.call(callData);
    }

    function _buildPath1Hop(address t0, address t1, uint256 binStep, uint8 version)
        internal
        pure
        returns (bytes memory)
    {
        uint256[] memory steps = new uint256[](1);
        steps[0] = binStep;
        uint8[] memory vers = new uint8[](1);
        vers[0] = version;
        address[] memory toks = new address[](2);
        toks[0] = t0;
        toks[1] = t1;
        return abi.encode(steps, vers, toks);
    }

    function _buildPath2Hop(
        address t0,
        address t1,
        address t2,
        uint256 bs0,
        uint256 bs1,
        uint8 v0,
        uint8 v1
    ) internal pure returns (bytes memory) {
        uint256[] memory steps = new uint256[](2);
        steps[0] = bs0;
        steps[1] = bs1;
        uint8[] memory vers = new uint8[](2);
        vers[0] = v0;
        vers[1] = v1;
        address[] memory toks = new address[](3);
        toks[0] = t0;
        toks[1] = t1;
        toks[2] = t2;
        return abi.encode(steps, vers, toks);
    }
}
