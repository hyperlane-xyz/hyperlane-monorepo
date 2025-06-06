// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {DefaultFallbackRoutingIsm} from "../contracts/isms/routing/DefaultFallbackRoutingIsm.sol";
import {IInterchainSecurityModule} from "../contracts/interfaces/IInterchainSecurityModule.sol";

contract ConfigureDefaultFallbackRoutingIsm is Script {
    function run() external {
        // --- Configuration (Read from environment variables) ---
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        // Address of the DefaultFallbackRoutingIsm to configure
        address defaultFallbackRoutingIsmAddress = vm.envAddress(
            "DEFAULT_FALLBACK_ROUTING_ISM_ADDRESS"
        );
        require(
            defaultFallbackRoutingIsmAddress != address(0),
            "ConfigureDefaultFallbackRoutingIsm: Set DEFAULT_FALLBACK_ROUTING_ISM_ADDRESS env var"
        );

        // Origin domain to be configured
        uint32 originDomain = uint32(vm.envUint("ORIGIN_DOMAIN"));
        require(
            originDomain > 0,
            "ConfigureDefaultFallbackRoutingIsm: Set ORIGIN_DOMAIN env var"
        );

        // ISM address for the origin domain
        address ismAddress = vm.envAddress("ISM_ADDRESS");
        require(
            ismAddress != address(0),
            "ConfigureDefaultFallbackRoutingIsm: Set ISM_ADDRESS env var"
        );

        console.log("--- Configuring DefaultFallbackRoutingIsm ---");
        console.log("Deployer Address:", deployerAddress);
        console.log(
            "DefaultFallbackRoutingIsm Address:",
            defaultFallbackRoutingIsmAddress
        );
        console.log("Origin Domain to Configure:", originDomain);
        console.log("ISM Address for Origin:", ismAddress);
        console.log("---------------------------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // Get the contract instance
        DefaultFallbackRoutingIsm defaultFallbackRoutingIsm = DefaultFallbackRoutingIsm(
                defaultFallbackRoutingIsmAddress
            );

        // Configure the origin domain mapping
        defaultFallbackRoutingIsm.set(
            originDomain,
            IInterchainSecurityModule(ismAddress)
        );
        console.log(
            "Successfully set Origin Domain",
            originDomain,
            "to ISM",
            ismAddress
        );

        vm.stopBroadcast();

        console.log("---------------------------------------------");
        console.log("DefaultFallbackRoutingIsm Configuration Complete");
        console.log("---------------------------------------------");
    }
}
