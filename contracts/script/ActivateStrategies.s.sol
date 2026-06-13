// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title ActivateStrategies — Activate queued adapters after the add-strategy
 *        timelock elapses (task 5.2). TESTNET / dev only: on mainnet the deployer
 *        renounces ADMIN at the end of Deploy.s.sol (H4), so activation must be
 *        executed from the Safe instead — see docs/deploy.md §3.4.
 *
 * Usage (testnet, ~1h after Deploy.s.sol):
 *   forge script script/ActivateStrategies.s.sol --rpc-url $MANTLE_TESTNET_RPC_URL \
 *     --private-key $DEPLOYER_PRIVATE_KEY --broadcast -vvv
 */

import { Script, console2 } from "forge-std/Script.sol";
import { YieldVault } from "../src/YieldVault.sol";

contract ActivateStrategies is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
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
