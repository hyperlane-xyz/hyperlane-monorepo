// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {DomainRoutingHook} from "../contracts/hooks/routing/DomainRoutingHook.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract DeployDomainRoutingHook is Script {
    function run() external returns (address deployedRoutingHookAddress) {
        // --- Configuration (Read from environment variables) ---
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        // Address of the Mailbox contract on THIS chain
        address localMailboxAddress = vm.envAddress("LOCAL_MAILBOX_ADDRESS");
        require(
            localMailboxAddress != address(0),
            "DeployDomainRoutingHook: Set LOCAL_MAILBOX_ADDRESS env var"
        );

        console.log("--- Deploying DomainRoutingHook ---");
        console.log("Deployer Address:", deployerAddress);
        console.log("Local Mailbox Address:", localMailboxAddress);
        console.log("-------------------------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // --- Deploy DomainRoutingHook ---
        // The constructor takes the local mailbox address and owner address
        DomainRoutingHook routingHook = new DomainRoutingHook(
            localMailboxAddress,
            deployerAddress
        );
        deployedRoutingHookAddress = address(routingHook);
        console.log(
            "DomainRoutingHook deployed at:",
            deployedRoutingHookAddress
        );

        vm.stopBroadcast();

        // --- Post-Deployment Info ---
        console.log("-----------------------------------------");
        console.log("Deployment Summary:");
        console.log("  DomainRoutingHook Address:", deployedRoutingHookAddress);
        console.log("  Local Mailbox:", localMailboxAddress);
        console.log("  Owner:", deployerAddress);
        console.log(
            "  Note: Use the setHook or setHooks functions to configure routes for specific destination domains."
        );
        console.log("-----------------------------------------");

        return deployedRoutingHookAddress;
    }
}
