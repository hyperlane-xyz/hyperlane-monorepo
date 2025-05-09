// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {DefaultFallbackRoutingIsm} from "../contracts/isms/routing/DefaultFallbackRoutingIsm.sol";
import {IInterchainSecurityModule} from "../contracts/interfaces/IInterchainSecurityModule.sol";

contract DeployDefaultFallbackRoutingIsm is Script {
    function run() external returns (address deployedRoutingIsmAddress) {
        // --- Configuration (Read from environment variables) ---
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        // Address of the Mailbox contract on THIS chain (for fallback mechanism)
        address localMailboxAddress = vm.envAddress("LOCAL_MAILBOX_ADDRESS");
        require(
            localMailboxAddress != address(0),
            "DeployDefaultFallbackRoutingIsm: Set LOCAL_MAILBOX_ADDRESS env var"
        );

        // The domain ID of the remote chain for which we are setting a specific PolymerISM route
        uint32 remoteOriginDomainId = uint32(
            vm.envUint("REMOTE_ORIGIN_DOMAIN_ID")
        );
        require(
            remoteOriginDomainId != 0,
            "DeployDefaultFallbackRoutingIsm: Set REMOTE_ORIGIN_DOMAIN_ID env var"
        );

        // The address of the PolymerISM (deployed on THIS chain) that verifies messages FROM the remoteOriginDomainId
        address polymerIsmForRemoteOrigin = vm.envAddress(
            "POLYMER_ISM_FOR_REMOTE_ORIGIN_ADDRESS"
        );
        require(
            polymerIsmForRemoteOrigin != address(0),
            "DeployDefaultFallbackRoutingIsm: Set POLYMER_ISM_FOR_REMOTE_ORIGIN_ADDRESS env var"
        );

        console.log("--- Deploying DefaultFallbackRoutingIsm ---");
        console.log("Deployer Address:", deployerAddress);
        console.log("Local Mailbox (for fallback):", localMailboxAddress);
        console.log(
            "Configuring route for remote origin domain:",
            remoteOriginDomainId
        );
        console.log("  Using PolymerISM at:", polymerIsmForRemoteOrigin);
        console.log("-------------------------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // --- 1. Deploy DefaultFallbackRoutingIsm ---
        // The constructor takes the local mailbox address.
        DefaultFallbackRoutingIsm routingIsm = new DefaultFallbackRoutingIsm(
            localMailboxAddress
        );
        deployedRoutingIsmAddress = address(routingIsm);
        console.log(
            "DefaultFallbackRoutingIsm deployed at:",
            deployedRoutingIsmAddress
        );

        // --- 2. Initialize Ownership and Configure Route ---
        // DefaultFallbackRoutingIsm inherits from DomainRoutingIsm, which is OwnableUpgradeable.
        // We need to initialize it to set the owner, then the owner can set routes.
        routingIsm.initialize(deployerAddress); // Sets deployerAddress as the owner
        console.log(
            "Initialized DefaultFallbackRoutingIsm ownership to deployer:",
            deployerAddress
        );

        // Now, set the specific route for the remoteOriginDomainId to use the designated PolymerISM.
        routingIsm.set(
            remoteOriginDomainId,
            IInterchainSecurityModule(polymerIsmForRemoteOrigin)
        );
        console.log(
            "Route configured: Messages from domain",
            remoteOriginDomainId,
            "will use ISM",
            polymerIsmForRemoteOrigin
        );

        vm.stopBroadcast();

        // --- Post-Deployment Info ---
        console.log("-----------------------------------------");
        console.log("Deployment Summary:");
        console.log(
            "  DefaultFallbackRoutingIsm Address:",
            deployedRoutingIsmAddress
        );
        console.log("  Local Mailbox for fallback:", localMailboxAddress);
        console.log(
            "  Explicit route configured for domain:",
            remoteOriginDomainId
        );
        console.log("    -> Using PolymerISM:", polymerIsmForRemoteOrigin);
        console.log(
            "  Messages from other domains will use Mailbox's default ISM."
        );
        console.log("-----------------------------------------");

        return deployedRoutingIsmAddress;
    }
}
