// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {FallbackDomainRoutingHook} from "../contracts/hooks/routing/FallbackDomainRoutingHook.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract DeployFallbackDomainRoutingHook is Script {
    function run() external returns (address deployedRoutingHookAddress) {
        // --- Configuration (Read from environment variables) ---
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        // Address of the Mailbox contract on THIS chain
        address localMailboxAddress = vm.envAddress("LOCAL_MAILBOX_ADDRESS");
        require(
            localMailboxAddress != address(0),
            "DeployFallbackDomainRoutingHook: Set LOCAL_MAILBOX_ADDRESS env var"
        );

        // Address of the default hook to use as fallback
        address defaultHookAddress = vm.envAddress("DEFAULT_HOOK_ADDRESS");
        require(
            defaultHookAddress != address(0),
            "DeployFallbackDomainRoutingHook: Set DEFAULT_HOOK_ADDRESS env var"
        );

        console.log("--- Deploying FallbackDomainRoutingHook ---");
        console.log("Deployer Address:", deployerAddress);
        console.log("Local Mailbox Address:", localMailboxAddress);
        console.log("Default Hook Address:", defaultHookAddress);
        console.log("-------------------------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // --- Deploy FallbackDomainRoutingHook ---
        // The constructor takes the local mailbox address, owner address, and fallback hook address
        FallbackDomainRoutingHook routingHook = new FallbackDomainRoutingHook(
            localMailboxAddress,
            deployerAddress,
            defaultHookAddress
        );
        deployedRoutingHookAddress = address(routingHook);
        console.log(
            "FallbackDomainRoutingHook deployed at:",
            deployedRoutingHookAddress
        );

        vm.stopBroadcast();

        // --- Post-Deployment Info ---
        console.log("-----------------------------------------");
        console.log("Deployment Summary:");
        console.log(
            "  FallbackDomainRoutingHook Address:",
            deployedRoutingHookAddress
        );
        console.log("  Local Mailbox:", localMailboxAddress);
        console.log("  Owner:", deployerAddress);
        console.log("  Default Fallback Hook:", defaultHookAddress);
        console.log(
            "  Note: Use the setHook or setHooks functions to configure routes for specific destination domains."
        );
        console.log("-----------------------------------------");

        return deployedRoutingHookAddress;
    }
}
