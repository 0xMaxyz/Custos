// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title AaveV3Adapter.t.sol — offline unit tests (no fork)
 *
 * Covers M3 (maxWithdrawable gates on reserve active/paused state) and the M1
 * hasAssets() presence check. Aave was previously fork-only; these use MockAaveV3Pool.
 *
 * Run: forge test --match-contract AaveV3AdapterTest -vv
 */

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AaveV3Adapter} from "../src/AaveV3Adapter.sol";
import {MockAaveV3Pool} from "./mocks/MockAaveV3Pool.sol";

// Mintable/burnable ERC-20 for USDC and the aToken.
contract MintBurnERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _sym, uint8 _dec) {
        name = _name;
        symbol = _sym;
        decimals = _dec;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function burn(address from, uint256 amt) external {
        balanceOf[from] -= amt;
        totalSupply -= amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }
}

contract AaveV3AdapterTest is Test {
    MintBurnERC20 internal usdc;
    MintBurnERC20 internal aUsdc;
    MockAaveV3Pool internal pool;
    AaveV3Adapter internal adapter;

    address internal vault = makeAddr("vault");

    uint256 constant SUPPLIED = 1_000e6; // adapter's aUSDC position
    uint256 constant LIQUIDITY = 5_000e6; // USDC held by the aToken (pool liquidity)

    function setUp() public {
        usdc = new MintBurnERC20("USD Coin", "USDC", 6);
        aUsdc = new MintBurnERC20("Aave USDC", "aUSDC", 6);
        pool = new MockAaveV3Pool(address(aUsdc));
        adapter = new AaveV3Adapter(address(pool), address(usdc), address(aUsdc), vault);

        // Adapter holds a supplied position; the aToken holds underlying liquidity.
        aUsdc.mint(address(adapter), SUPPLIED);
        usdc.mint(address(aUsdc), LIQUIDITY);
    }

    function test_MaxWithdrawable_ActiveNotPaused_ReturnsMin() public {
        pool.setFlags(true, false);
        // min(SUPPLIED, LIQUIDITY) = SUPPLIED (1000 < 5000).
        assertEq(adapter.maxWithdrawable(), SUPPLIED);
    }

    function test_MaxWithdrawable_LiquidityLimited() public {
        pool.setFlags(true, false);
        // Drain pool liquidity below the supplied position.
        vm.prank(address(aUsdc));
        usdc.transfer(address(0xdead), LIQUIDITY - 400e6); // leave 400e6
        assertEq(adapter.maxWithdrawable(), 400e6);
    }

    function test_MaxWithdrawable_ZeroWhenPaused() public {
        pool.setFlags(true, true);
        assertEq(adapter.maxWithdrawable(), 0);
    }

    function test_MaxWithdrawable_ZeroWhenInactive() public {
        pool.setFlags(false, false);
        assertEq(adapter.maxWithdrawable(), 0);
    }

    function test_HasAssets_TrueWhenHoldingAUsdc() public view {
        assertTrue(adapter.hasAssets());
    }

    function test_HasAssets_FalseWhenEmpty() public {
        aUsdc.burn(address(adapter), SUPPLIED);
        assertFalse(adapter.hasAssets());
    }
}
