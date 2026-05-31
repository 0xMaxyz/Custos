// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title RegisterIdentity - Register the Sentinel agent in the ERC-8004 canonical
 *        Identity Registry and pin the agent card URI (task 4.1 / 5.2).
 *
 * Run after Deploy.s.sol. Reads VAULT_ADDRESS, AGENT_CARD_URI from env.
 *
 * Usage:
 *   forge script script/RegisterIdentity.s.sol --rpc-url $MANTLE_RPC_URL \
 *     --private-key $DEPLOYER_PRIVATE_KEY --broadcast -vvv
 *
 * After the tx, set AGENT_ID (printed below) in .env and deployments/<chainId>.json.
 */

import {Script, console2} from "forge-std/Script.sol";
import {Addresses}        from "./helpers/Addresses.sol";

interface ICanonicalIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function tokenURI(uint256 agentId) external view returns (string memory);
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract RegisterIdentity is Script {
    function run() external {
        uint256 key      = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);

        // Agent card URI - set by `agent/src/identity/agentCard.ts` pinAgentCard().
        // Can be an ipfs:// CID, a data: URI, or an https URL.
        string memory agentCardUri = vm.envOr("AGENT_CARD_URI", string(""));
        require(bytes(agentCardUri).length > 0, "AGENT_CARD_URI not set - run pinAgentCard() first");

        bool isMainnet = block.chainid == 5000;
        address registry = isMainnet
            ? Addresses.MAINNET_ERC8004_IDENTITY
            : Addresses.TESTNET_ERC8004_IDENTITY;

        console2.log("=== ERC-8004 identity registration ===");
        console2.log("Registry:", registry);
        console2.log("Owner (deployer):", deployer);
        console2.log("Agent card URI:", agentCardUri);

        vm.startBroadcast(key);
        uint256 agentId = ICanonicalIdentityRegistry(registry).register(agentCardUri);
        vm.stopBroadcast();

        string memory resolved = ICanonicalIdentityRegistry(registry).tokenURI(agentId);
        address owner          = ICanonicalIdentityRegistry(registry).ownerOf(agentId);

        console2.log("=== Registration successful ===");
        console2.log("AGENT_ID=%s", agentId);
        console2.log("tokenURI:", resolved);
        console2.log("owner:", owner);
        console2.log("Add AGENT_ID=%s to .env and deployments/%s.json", agentId, block.chainid);
    }
}
