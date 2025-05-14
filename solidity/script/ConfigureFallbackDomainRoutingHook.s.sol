// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {FallbackDomainRoutingHook} from "../contracts/hooks/routing/FallbackDomainRoutingHook.sol";
import {DomainRoutingHook} from "../contracts/hooks/routing/DomainRoutingHook.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract ConfigureFallbackDomainRoutingHook is Script {
    function run() external {
        // --- Configuration (Read from environment variables) ---
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        // The address of the FallbackDomainRoutingHook contract to configure
        address fallbackDomainRoutingHookAddress = vm.envAddress(
            "FALLBACK_DOMAIN_ROUTING_HOOK_ADDRESS"
        );
        require(
            fallbackDomainRoutingHookAddress != address(0),
            "ConfigureFallbackDomainRoutingHook: Set FALLBACK_DOMAIN_ROUTING_HOOK_ADDRESS env var"
        );

        // The destination domain to configure (Base chain)
        uint32 destinationDomain = uint32(vm.envUint("DESTINATION_DOMAIN"));
        require(
            destinationDomain != 0,
            "ConfigureFallbackDomainRoutingHook: Set DESTINATION_DOMAIN env var"
        );

        // The address of the MockHook to use for the destination domain
        address mockHookAddress = vm.envAddress("MOCK_HOOK_ADDRESS");
        require(
            mockHookAddress != address(0),
            "ConfigureFallbackDomainRoutingHook: Set MOCK_HOOK_ADDRESS env var"
        );

        console.log("--- Configuring FallbackDomainRoutingHook ---");
        console.log("Deployer Address:", deployerAddress);
        console.log(
            "FallbackDomainRoutingHook Address:",
            fallbackDomainRoutingHookAddress
        );
        console.log("Destination Domain (Base chain):", destinationDomain);
        console.log("MockHook Address:", mockHookAddress);
        console.log("-------------------------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // Get an instance of the FallbackDomainRoutingHook contract
        FallbackDomainRoutingHook hook = FallbackDomainRoutingHook(
            fallbackDomainRoutingHookAddress
        );

        // Set the MockHook as the destination-specific hook for the Base chain
        hook.setHook(destinationDomain, mockHookAddress);

        vm.stopBroadcast();

        // --- Post-Configuration Info ---
        console.log("-----------------------------------------");
        console.log("Configuration Complete:");
        console.log(
            "  FallbackDomainRoutingHook:",
            fallbackDomainRoutingHookAddress
        );
        console.log("  Destination Domain (Base):", destinationDomain);
        console.log("  Configured Hook for Base:", mockHookAddress);

        // Verify the configuration - call hooks mapping to see the configured hook
        // (This is a view call, so it doesn't require broadcasting)
        address configuredHook = address(hook.hooks(destinationDomain));
        console.log(
            "  Verification - Configured Hook for Base:",
            configuredHook
        );
        console.log("  Fallback Hook:", address(hook.fallbackHook()));
        console.log("-----------------------------------------");
    }
}
