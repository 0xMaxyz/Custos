// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title ActivateStrategies — Activate queued adapters after the timelock elapses
 *        on mainnet (task 5.2). Run ~48h after Deploy.s.sol on mainnet.
 *
 * Usage:
 *   forge script script/ActivateStrategies.s.sol --rpc-url $MANTLE_RPC_URL \
 *     --private-key $DEPLOYER_PRIVATE_KEY --broadcast -vvv
 */

import {Script, console2} from "forge-std/Script.sol";
import {YieldVault}        from "../src/YieldVault.sol";

contract ActivateStrategies is Script {
    function run() external {
        uint256 key   = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");

        YieldVault vault = YieldVault(vaultAddr);

        vm.startBroadcast(key);
        // Bucket 1 = AAVE, Bucket 2 = USDY
        try vault.activateStrategy(1) {
            console2.log("Bucket 1 (AAVE) activated");
        } catch {
            // Custom errors (TimelockNotElapsed, NothingToWithdraw) land here too.
            console2.log("Bucket 1 skip: timelock not elapsed or no pending adapter");
        }
        try vault.activateStrategy(2) {
            console2.log("Bucket 2 (USDY) activated");
        } catch {
            console2.log("Bucket 2 skip: timelock not elapsed or no pending adapter");
        }
        vm.stopBroadcast();
    }
}
