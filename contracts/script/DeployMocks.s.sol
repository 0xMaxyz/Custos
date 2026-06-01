// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title DeployMocks - Deploy minimal ERC-20 mock tokens for Mantle testnet (task 5.1).
 *
 * Run before Deploy.s.sol on testnet when the target testnet has no USDC/USDY.
 * Prints addresses to set as TESTNET_USDC / TESTNET_USDY env vars.
 *
 * Usage:
 *   forge script script/DeployMocks.s.sol --rpc-url $MANTLE_TESTNET_RPC_URL \
 *     --private-key $DEPLOYER_PRIVATE_KEY --broadcast -vvv
 */

import {Script, console2} from "forge-std/Script.sol";
import {ERC20}            from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private _dec;
    constructor(string memory name_, string memory sym_, uint8 dec_) ERC20(name_, sym_) {
        _dec = dec_;
    }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// Minimal mock oracle returning a fixed $1.00 USDY NAV (18-dec).
contract MockUsdyOracle {
    function getPrice() external pure returns (uint256) { return 1e18; }
    /// Stub - UsdyAdapter calls this with a try/catch; reverting is fine here.
    function currentRange() external pure returns (uint256, uint256, uint256) {
        revert("MockUsdyOracle: no range");
    }
}

contract DeployMocks is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);

        vm.startBroadcast(key);

        MockERC20 usdc = new MockERC20("USD Coin (mock)", "USDC", 6);
        MockERC20 usdy = new MockERC20("Ondo US Dollar Yield (mock)", "USDY", 18);
        MockUsdyOracle oracle = new MockUsdyOracle();

        // Mint initial supply to deployer for smoke tests.
        usdc.mint(deployer, 1_000_000 * 1e6);  // $1M USDC
        usdy.mint(deployer, 500_000 * 1e18);   // 500k USDY

        vm.stopBroadcast();

        console2.log("=== Mock token deployment ===");
        console2.log("TESTNET_USDC=%s", address(usdc));
        console2.log("TESTNET_USDY=%s", address(usdy));
        console2.log("TESTNET_USDY_ORACLE=%s", address(oracle));
        console2.log("TESTNET_USDY_ROUTER=%s (set to any non-zero addr; swaps are mocked)", address(0));
        console2.log("TESTNET_AAVE_POOL=  (leave blank - AaveV3Adapter skipped on testnet without pool)");
    }
}
