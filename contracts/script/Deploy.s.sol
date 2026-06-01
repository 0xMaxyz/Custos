// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Deploy - Sentinel full deployment script (task 5.1)
 *
 * Deploys on Mantle mainnet (5000) or Mantle testnet (5003):
 *   Guardrails → YieldVault → AaveV3Adapter → UsdyAdapter → AgentBenchmark
 *
 * Usage (mainnet):
 *   forge script script/Deploy.s.sol --rpc-url $MANTLE_RPC_URL \
 *     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify \
 *     --etherscan-api-key $MANTLESCAN_API_KEY -vvv
 *
 * Usage (testnet, skip-verify):
 *   forge script script/Deploy.s.sol --rpc-url $MANTLE_TESTNET_RPC_URL \
 *     --private-key $DEPLOYER_PRIVATE_KEY --broadcast -vvv
 *
 * After broadcast, copy the printed JSON into deployments/<chainId>.json and
 * update packages/shared/src/deployments.ts.
 *
 * Environment variables read:
 *   DEPLOYER_PRIVATE_KEY   - deployer / initial admin
 *   ALLOCATOR_ADDRESS      - ALLOCATOR role recipient (hot key, may == deployer for test)
 *   GUARDIAN_ADDRESS       - GUARDIAN role recipient (optional, may == deployer)
 *   TESTNET_USDC           - (testnet only) USDC address; mainnet is hard-coded
 *   TESTNET_USDY           - (testnet only) USDY address (deploy mock if blank)
 *   TESTNET_USDY_ORACLE    - (testnet only) oracle address (deploy mock if blank)
 *   TESTNET_AAVE_POOL      - (testnet only) Aave pool address (skip adapter if blank)
 *   TESTNET_AUSDC          - (testnet only) aUSDC token (skip adapter if blank)
 */

import {Script, console2} from "forge-std/Script.sol";

import {Roles}         from "../src/Roles.sol";
import {Guardrails}    from "../src/Guardrails.sol";
import {YieldVault}    from "../src/YieldVault.sol";
import {AaveV3Adapter} from "../src/AaveV3Adapter.sol";
import {UsdyAdapter}   from "../src/UsdyAdapter.sol";
import {AusdAdapter}   from "../src/AusdAdapter.sol";
import {AgentBenchmark} from "../src/AgentBenchmark.sol";

import {Addresses}               from "./helpers/Addresses.sol";
import {IPoolAddressesProvider}  from "./helpers/IPoolAddressesProvider.sol";
import {IAaveV3Pool, ReserveData} from "../src/interfaces/IAaveV3Pool.sol";

contract Deploy is Script {

    // ── Outputs printed after deploy ──────────────────────────────────────────

    Guardrails    public guardrails;
    YieldVault    public vault;
    AaveV3Adapter public aaveAdapter;
    UsdyAdapter   public usdyAdapter;
    AusdAdapter   public ausdAdapter;
    AgentBenchmark public benchmark;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address allocator   = vm.envOr("ALLOCATOR_ADDRESS", deployer);
        address guardian    = vm.envOr("GUARDIAN_ADDRESS",  deployer);

        bool isMainnet = block.chainid == 5000;
        console2.log("=== Sentinel deploy ===");
        console2.log("Chain:", block.chainid, isMainnet ? "(mainnet)" : "(testnet)");
        console2.log("Deployer:", deployer);
        console2.log("Allocator:", allocator);
        console2.log("Guardian:", guardian);

        // ── Resolve token + protocol addresses ────────────────────────────────
        address usdc;
        address usdy;
        address usdyOracle;
        address usdyRouter;
        address ausd;
        address aavePool;
        address aUsdc;

        if (isMainnet) {
            usdc       = Addresses.MAINNET_USDC;
            usdy       = Addresses.MAINNET_USDY;
            usdyOracle = Addresses.MAINNET_USDY_ORACLE;
            usdyRouter = Addresses.MAINNET_USDY_ROUTER;
            ausd       = Addresses.MAINNET_AUSD;

            // Resolve Aave pool + aUSDC from the PoolAddressesProvider.
            IPoolAddressesProvider provider =
                IPoolAddressesProvider(Addresses.MAINNET_AAVE_PROVIDER);
            aavePool = provider.getPool();
            ReserveData memory rd = IAaveV3Pool(aavePool).getReserveData(usdc);
            aUsdc = rd.aTokenAddress;
            console2.log("Aave pool:", aavePool);
            console2.log("aUSDC:", aUsdc);
        } else {
            // Testnet: read from env; deployer must supply mocks or real testnet tokens.
            usdc       = vm.envOr("TESTNET_USDC",        address(0));
            usdy       = vm.envOr("TESTNET_USDY",        address(0));
            usdyOracle = vm.envOr("TESTNET_USDY_ORACLE", address(0));
            usdyRouter = vm.envOr("TESTNET_USDY_ROUTER", address(0));
            ausd       = vm.envOr("TESTNET_AUSD",         address(0));
            aavePool   = vm.envOr("TESTNET_AAVE_POOL",   address(0));
            aUsdc      = vm.envOr("TESTNET_AUSDC",        address(0));

            require(usdc != address(0), "TESTNET_USDC not set");
        }

        console2.log("USDC:", usdc);
        console2.log("USDY:", usdy);

        vm.startBroadcast(deployerKey);

        // ── 1. Guardrails ─────────────────────────────────────────────────────
        guardrails = new Guardrails(deployer);
        console2.log("Guardrails:", address(guardrails));

        // On testnet, zero the add-strategy timelock so the deploy can queue AND
        // activate adapters in a single broadcast (no time to warp on a live RPC).
        // Mainnet keeps the 2-day default; adapters are activated later via
        // ActivateStrategies.s.sol once the timelock elapses.
        if (!isMainnet) {
            Guardrails.Config memory cfg = guardrails.config();
            cfg.addStrategyTimelock = 0;
            guardrails.setConfig(cfg);
            console2.log("Testnet: addStrategyTimelock set to 0");
        }

        // ── 2. YieldVault ─────────────────────────────────────────────────────
        vault = new YieldVault(usdc, deployer, address(guardrails));
        console2.log("YieldVault:", address(vault));

        // ── 3. AgentBenchmark ─────────────────────────────────────────────────
        benchmark = new AgentBenchmark(address(vault), deployer);
        vault.setBenchmark(address(benchmark));
        console2.log("AgentBenchmark:", address(benchmark));

        // ── 4. AaveV3Adapter (skip if no pool address) ────────────────────────
        if (aavePool != address(0) && aUsdc != address(0)) {
            aaveAdapter = new AaveV3Adapter(aavePool, usdc, aUsdc, address(vault));
            console2.log("AaveV3Adapter:", address(aaveAdapter));

            // Queue adapter in vault bucket 1 (AAVE). Testnet: zero timelock.
            vault.addStrategy(1, address(aaveAdapter));
            if (!isMainnet) {
                // Timelock was zeroed above for testnet, so activate immediately.
                vault.activateStrategy(1);
            }
            console2.log("AaveV3Adapter queued in bucket 1", isMainnet ? "(awaiting timelock)" : "(activated)");
        } else {
            console2.log("AaveV3Adapter SKIPPED - no Aave pool address");
        }

        // ── 5. UsdyAdapter (skip if no USDY / oracle) ────────────────────────
        if (usdy != address(0) && usdyOracle != address(0) && usdyRouter != address(0)) {
            usdyAdapter = new UsdyAdapter(
                usdyRouter,
                usdc,
                usdy,
                usdyOracle,
                address(vault),
                50  // 0.5% max slippage — mirrors MAX_SLIPPAGE_BPS in packages/shared/guardrails.ts
            );
            console2.log("UsdyAdapter:", address(usdyAdapter));

            vault.addStrategy(2, address(usdyAdapter));
            if (!isMainnet) {
                vault.activateStrategy(2);
            }
            console2.log("UsdyAdapter queued in bucket 2", isMainnet ? "(awaiting timelock)" : "(activated)");
        } else {
            console2.log("UsdyAdapter SKIPPED - missing USDY/oracle/router address");
        }

        // ── 5b. AusdAdapter (safety bucket; skip if no AUSD / router) ─────────
        // AUSD swaps run through the same pinned Odos aggregator as USDY.
        if (ausd != address(0) && usdyRouter != address(0)) {
            ausdAdapter = new AusdAdapter(
                usdyRouter,
                usdc,
                ausd,
                address(vault),
                50  // 0.5% max slippage — mirrors MAX_SLIPPAGE_BPS in packages/shared/guardrails.ts
            );
            console2.log("AusdAdapter:", address(ausdAdapter));

            vault.addStrategy(3, address(ausdAdapter));
            if (!isMainnet) {
                vault.activateStrategy(3);
            }
            console2.log("AusdAdapter queued in bucket 3", isMainnet ? "(awaiting timelock)" : "(activated)");
        } else {
            console2.log("AusdAdapter SKIPPED - missing AUSD/router address");
        }

        // ── 6. Roles ──────────────────────────────────────────────────────────
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN,  guardian);
        console2.log("ALLOCATOR granted to:", allocator);
        console2.log("GUARDIAN granted to:", guardian);

        vm.stopBroadcast();

        // ── Summary JSON (copy to deployments/<chainId>.json) ─────────────────
        console2.log("");
        console2.log("=== Deployment summary (paste into deployments/%s.json) ===", block.chainid);
        console2.log("{");
        console2.log('  "chainId": %s,', block.chainid);
        console2.log('  "guardrails": "%s",', address(guardrails));
        console2.log('  "vault": "%s",', address(vault));
        console2.log('  "benchmark": "%s",', address(benchmark));
        if (address(aaveAdapter) != address(0)) {
            console2.log('  "aaveAdapter": "%s",', address(aaveAdapter));
        }
        if (address(usdyAdapter) != address(0)) {
            console2.log('  "usdyAdapter": "%s",', address(usdyAdapter));
        }
        if (address(ausdAdapter) != address(0)) {
            console2.log('  "ausdAdapter": "%s",', address(ausdAdapter));
        }
        console2.log('  "deployer": "%s"', deployer);
        console2.log("}");
    }
}
