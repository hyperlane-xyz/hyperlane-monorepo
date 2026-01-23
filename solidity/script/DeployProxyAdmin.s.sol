// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

/**
 * @title DeployProxyAdmin
 * @notice Deploys a ProxyAdmin and transfers ownership to specified address
 *
 * Environment variables:
 *   NEW_OWNER - Address to transfer ownership to (required)
 *
 * Usage:
 *   NEW_OWNER=0x... forge script script/DeployProxyAdmin.s.sol --rpc-url $ETH_RPC_URL --broadcast --private-key $PK
 */
contract DeployProxyAdmin is Script {
    function run() external {
        address newOwner = vm.envAddress("NEW_OWNER");

        vm.startBroadcast();

        ProxyAdmin proxyAdmin = new ProxyAdmin();
        proxyAdmin.transferOwnership(newOwner);

        vm.stopBroadcast();

        // Verify ownership and bytecode
        require(proxyAdmin.owner() == newOwner, "Ownership transfer failed");

        // Verify deployed bytecode matches expected ProxyAdmin runtime bytecode
        bytes memory expectedBytecode = type(ProxyAdmin).runtimeCode;
        bytes memory deployedBytecode = address(proxyAdmin).code;
        require(
            keccak256(deployedBytecode) == keccak256(expectedBytecode),
            "Bytecode mismatch"
        );

        console.log("ProxyAdmin deployed at:", address(proxyAdmin));
        console.log("ProxyAdmin owner:", proxyAdmin.owner());
    }
}
