// SPDX-License-Identifier: MIT
// Custos — AI risk-guardian real-yield account on Mantle.
pragma solidity 0.8.35;

/**
 * @title RedeployRwaAdapters — redeploy UsdyAdapter + AusdAdapter against the pinned
 *        1delta swap executor (Addresses.MAINNET_USDY_ROUTER) without touching the
 *        Guardrails / YieldVault / AgentBenchmark / AaveV3Adapter already live.
 *
 * Use when the pinned aggregator address changes (e.g. Odos v2 retired → 1delta
 * executor). Deploys the two new adapters and prints them; the admin then swaps them
 * into the vault out of band (removeStrategy → addStrategy → wait timelock →
 * activateStrategy), since those calls are ADMIN-only and the admin renounced from
 * the deployer at the end of Deploy.s.sol.
 *
 * Usage (mainnet):
 *   forge script script/RedeployRwaAdapters.s.sol --rpc-url $MANTLE_RPC_URL \
 *     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify \
 *     --etherscan-api-key $MANTLESCAN_API_KEY --gas-estimate-multiplier 300 --slow -vvv
 *
 * Env read: DEPLOYER_PRIVATE_KEY, VAULT_ADDRESS.
 */

import { Script, console2 } from "forge-std/Script.sol";

import { UsdyAdapter } from "../src/UsdyAdapter.sol";
import { AusdAdapter } from "../src/AusdAdapter.sol";
import { Addresses } from "./helpers/Addresses.sol";

contract RedeployRwaAdapters is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address vault = vm.envAddress("VAULT_ADDRESS");
        require(block.chainid == 5000, "mainnet only (chainId 5000)");
        require(vault != address(0), "VAULT_ADDRESS not set");

        address router = Addresses.MAINNET_USDY_ROUTER; // pinned 1delta executor

        console2.log("=== Redeploy RWA adapters ===");
        console2.log("Vault:", vault);
        console2.log("Pinned aggregator (1delta):", router);

        vm.startBroadcast(deployerKey);

        // 0.5% max slippage — mirrors MAX_SLIPPAGE_BPS in Deploy.s.sol / packages/shared.
        UsdyAdapter usdyAdapter = new UsdyAdapter(
            router,
            Addresses.MAINNET_USDC,
            Addresses.MAINNET_USDY,
            Addresses.MAINNET_MUSD,
            Addresses.MAINNET_USDY_ORACLE,
            vault,
            50
        );
        AusdAdapter ausdAdapter =
            new AusdAdapter(router, Addresses.MAINNET_USDC, Addresses.MAINNET_AUSD, vault, 50);

        vm.stopBroadcast();

        console2.log("New UsdyAdapter:", address(usdyAdapter));
        console2.log("New AusdAdapter:", address(ausdAdapter));
        console2.log("");
        console2.log("Next (ADMIN key only), then wait the add-strategy timelock and activate:");
        console2.log("  vault.removeStrategy(2); vault.removeStrategy(3)");
        console2.log("  vault.addStrategy(2, <UsdyAdapter>); vault.addStrategy(3, <AusdAdapter>)");
        console2.log("  vault.activateStrategy(2); vault.activateStrategy(3)");
    }
}
