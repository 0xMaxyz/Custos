// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Deploy - Custos full deployment script (task 5.1)
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
 *   INITIAL_TIMELOCK_SECONDS - (mainnet, optional) bootstrap addStrategyTimelock for the
 *                            guarded-launch window (>= 1h MIN_TIMELOCK floor; 0/unset = 2d default)
 *   ADMIN_ADDRESS          - final admin (DEFAULT_ADMIN_ROLE + ADMIN) recipient. On mainnet
 *                            (chainId 5000) this MUST be set and != deployer: the deployer
 *                            EOA hands off all admin roles then renounces its own (H4). On
 *                            non-mainnet chains it is optional (unset = deployer keeps admin).
 *   ALLOCATOR_ADDRESS      - ALLOCATOR role recipient (hot key, may == deployer for test)
 *   GUARDIAN_ADDRESS       - GUARDIAN role recipient (optional, may == deployer)
 *   TESTNET_USDC           - (testnet only) USDC address; mainnet is hard-coded
 *   TESTNET_USDY           - (testnet only) USDY address (deploy mock if blank)
 *   TESTNET_USDY_ORACLE    - (testnet only) oracle address (deploy mock if blank)
 *   TESTNET_AAVE_POOL      - (testnet only) Aave pool address (skip adapter if blank)
 *   TESTNET_AUSDC          - (testnet only) aUSDC token (skip adapter if blank)
 */

import { Script, console2 } from "forge-std/Script.sol";

import { Roles } from "../src/Roles.sol";
import { Guardrails } from "../src/Guardrails.sol";
import { YieldVault } from "../src/YieldVault.sol";
import { AaveV3Adapter } from "../src/AaveV3Adapter.sol";
import { UsdyAdapter } from "../src/UsdyAdapter.sol";
import { AusdAdapter } from "../src/AusdAdapter.sol";
import { AgentBenchmark } from "../src/AgentBenchmark.sol";

import { Addresses } from "./helpers/Addresses.sol";
import { IPoolAddressesProvider } from "./helpers/IPoolAddressesProvider.sol";
import { IAaveV3Pool, ReserveData } from "../src/interfaces/IAaveV3Pool.sol";

contract Deploy is Script {
    // ── Outputs printed after deploy ──────────────────────────────────────────

    Guardrails public guardrails;
    YieldVault public vault;
    AaveV3Adapter public aaveAdapter;
    UsdyAdapter public usdyAdapter;
    AusdAdapter public ausdAdapter;
    AgentBenchmark public benchmark;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address allocator = vm.envOr("ALLOCATOR_ADDRESS", deployer);
        address guardian = vm.envOr("GUARDIAN_ADDRESS", deployer);

        bool isMainnet = block.chainid == 5000;

        console2.log("=== Custos deploy ===");
        console2.log("Chain:", block.chainid, isMainnet ? "(mainnet)" : "(testnet)");
        console2.log("Deployer:", deployer);
        console2.log("Allocator:", allocator);
        console2.log("Guardian:", guardian);

        // ── Resolve token + protocol addresses ────────────────────────────────
        address usdc;
        address usdy;
        address musd;
        address usdyOracle;
        address usdyRouter;
        address ausd;
        address aavePool;
        address aUsdc;

        if (isMainnet) {
            usdc = Addresses.MAINNET_USDC;
            usdy = Addresses.MAINNET_USDY;
            musd = Addresses.MAINNET_MUSD;
            usdyOracle = Addresses.MAINNET_USDY_ORACLE;
            usdyRouter = Addresses.MAINNET_USDY_ROUTER;
            ausd = Addresses.MAINNET_AUSD;

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
            usdc = vm.envOr("TESTNET_USDC", address(0));
            usdy = vm.envOr("TESTNET_USDY", address(0));
            musd = vm.envOr("TESTNET_MUSD", address(0));
            usdyOracle = vm.envOr("TESTNET_USDY_ORACLE", address(0));
            usdyRouter = vm.envOr("TESTNET_USDY_ROUTER", address(0));
            ausd = vm.envOr("TESTNET_AUSD", address(0));
            aavePool = vm.envOr("TESTNET_AAVE_POOL", address(0));
            aUsdc = vm.envOr("TESTNET_AUSDC", address(0));

            require(usdc != address(0), "TESTNET_USDC not set");
        }

        console2.log("USDC:", usdc);
        console2.log("USDY:", usdy);

        vm.startBroadcast(deployerKey);

        // ── 1. Guardrails ─────────────────────────────────────────────────────
        guardrails = new Guardrails(deployer);
        console2.log("Guardrails:", address(guardrails));

        // One-shot config bootstrap (H3): setConfig applies instantly the first time and
        // then seals — every later change is timelocked via queueConfig/activateConfig.
        // Always call it once here to consume that window at deploy. On testnet, shorten
        // the add-strategy timelock to the MIN_TIMELOCK floor (M5: it can no longer be 0)
        // so adapters can be activated ~1h after deploy via ActivateStrategies.s.sol;
        // mainnet keeps the 2-day default. Adapters are queued here, activated later.
        Guardrails.Config memory cfg = guardrails.config();
        if (!isMainnet) {
            cfg.addStrategyTimelock = guardrails.MIN_TIMELOCK();
            console2.log("Testnet: addStrategyTimelock set to MIN_TIMELOCK (1h)");
        } else {
            // v1 guarded launch (see docs/deploy.md): optionally bootstrap with a shorter
            // timelock (>= MIN_TIMELOCK floor) for the mainnet shakeout window, then queue
            // a raise back to 48h once smoke tests pass. Unset/0 keeps the 2-day default.
            uint256 initialTimelock = vm.envOr("INITIAL_TIMELOCK_SECONDS", uint256(0));
            if (initialTimelock != 0) {
                require(
                    initialTimelock >= guardrails.MIN_TIMELOCK(),
                    "INITIAL_TIMELOCK_SECONDS below MIN_TIMELOCK"
                );
                require(initialTimelock <= type(uint32).max, "INITIAL_TIMELOCK_SECONDS too large");
                cfg.addStrategyTimelock = uint32(initialTimelock);
                console2.log("Mainnet: addStrategyTimelock bootstrapped to", initialTimelock);
            }
        }
        guardrails.setConfig(cfg);

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

            // Queue adapter in vault bucket 1 (AAVE). Activated later via
            // ActivateStrategies.s.sol once the add-strategy timelock elapses (M5: the
            // timelock floor means it can no longer be activated in this same broadcast).
            vault.addStrategy(1, address(aaveAdapter));
            console2.log("AaveV3Adapter queued in bucket 1 (awaiting timelock)");
        } else {
            console2.log("AaveV3Adapter SKIPPED - no Aave pool address");
        }

        // ── 5. UsdyAdapter (skip if no USDY / oracle) ────────────────────────
        if (usdy != address(0) && usdyOracle != address(0) && usdyRouter != address(0)) {
            // mUSD (the Ondo wrap/unwrap converter leg) is optional: address(0)
            // deploys a USDY-only adapter. Mainnet always wires it; testnet only if
            // TESTNET_MUSD is set.
            usdyAdapter = new UsdyAdapter(
                usdyRouter,
                usdc,
                usdy,
                musd,
                usdyOracle,
                address(vault),
                50 // 0.5% max slippage — mirrors MAX_SLIPPAGE_BPS in packages/shared/guardrails.ts
            );
            console2.log("UsdyAdapter:", address(usdyAdapter));
            console2.log("  mUSD leg:", musd == address(0) ? address(0) : musd);

            vault.addStrategy(2, address(usdyAdapter));
            console2.log("UsdyAdapter queued in bucket 2 (awaiting timelock)");
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
                50 // 0.5% max slippage — mirrors MAX_SLIPPAGE_BPS in packages/shared/guardrails.ts
            );
            console2.log("AusdAdapter:", address(ausdAdapter));

            vault.addStrategy(3, address(ausdAdapter));
            console2.log("AusdAdapter queued in bucket 3 (awaiting timelock)");
        } else {
            console2.log("AusdAdapter SKIPPED - missing AUSD/router address");
        }

        // ── 6. Roles ──────────────────────────────────────────────────────────
        vault.grantRole(Roles.ALLOCATOR, allocator);
        vault.grantRole(Roles.GUARDIAN, guardian);
        console2.log("ALLOCATOR granted to:", allocator);
        console2.log("GUARDIAN granted to:", guardian);

        // 7. Admin handoff (H4). MUST run after all deployer-privileged setup above
        // (setConfig bootstrap, addStrategy/activateStrategy, ALLOCATOR/GUARDIAN grants) so
        // nothing the deployer still needs runs after it renounces. The target ADMIN_ADDRESS
        // is read + validated inside _maybeHandoffAdmin (kept out of run() to bound stack).
        _maybeHandoffAdmin(deployer, isMainnet);

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

    /**
     * @notice Read + validate ADMIN_ADDRESS and hand off admin if a distinct target is set
     *         (H4). On mainnet ADMIN_ADDRESS is required and must differ from the deployer.
     *         Off mainnet, an unset/zero or self address simply skips the handoff (the
     *         deployer keeps admin for dev ergonomics). Kept separate from run() so the env
     *         read + local do not inflate run() stack depth.
     */
    function _maybeHandoffAdmin(address deployer, bool isMainnet) internal {
        address adminAddress = vm.envOr("ADMIN_ADDRESS", address(0));
        if (isMainnet) {
            require(adminAddress != address(0), "ADMIN_ADDRESS must be set on mainnet");
            require(adminAddress != deployer, "ADMIN_ADDRESS must differ from deployer on mainnet");
        }
        if (adminAddress == address(0) || adminAddress == deployer) {
            console2.log("Admin handoff SKIPPED - deployer retains admin (non-mainnet)");
            return;
        }
        _handoffAdmin(adminAddress, deployer);
        console2.log("Admin handed off to:", adminAddress);
        console2.log("Deployer admin roles renounced");
    }

    /**
     * @notice Grant DEFAULT_ADMIN_ROLE + ADMIN on every admin-bearing contract to newAdmin,
     *         then renounce the deployer's own roles (H4). Runs inside the active broadcast.
     *         Each constructor granted exactly DEFAULT_ADMIN_ROLE + ADMIN to the deployer.
     *         Per contract: grant new admin first, then renounce deployer ADMIN, then
     *         DEFAULT_ADMIN_ROLE last (it governs grants/renounces).
     */
    function _handoffAdmin(address newAdmin, address deployer) internal {
        bytes32 defaultAdmin = guardrails.DEFAULT_ADMIN_ROLE();

        guardrails.grantRole(defaultAdmin, newAdmin);
        guardrails.grantRole(Roles.ADMIN, newAdmin);
        guardrails.renounceRole(Roles.ADMIN, deployer);
        guardrails.renounceRole(defaultAdmin, deployer);

        vault.grantRole(defaultAdmin, newAdmin);
        vault.grantRole(Roles.ADMIN, newAdmin);
        vault.renounceRole(Roles.ADMIN, deployer);
        vault.renounceRole(defaultAdmin, deployer);

        benchmark.grantRole(defaultAdmin, newAdmin);
        benchmark.grantRole(Roles.ADMIN, newAdmin);
        benchmark.renounceRole(Roles.ADMIN, deployer);
        benchmark.renounceRole(defaultAdmin, deployer);
    }
}
