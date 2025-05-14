// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {DomainRoutingMailbox} from "../contracts/DomainRoutingMailbox.sol";
import {IMailbox} from "../contracts/interfaces/IMailbox.sol";

contract DeployDomainRoutingMailbox is Script {
    function run()
        external
        returns (address deployedDomainRoutingMailboxAddress)
    {
        // --- Configuration (Read from environment variables) ---
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        // Address of the default Mailbox implementation
        address defaultMailboxAddress = vm.envAddress(
            "DEFAULT_MAILBOX_ADDRESS"
        );
        require(
            defaultMailboxAddress != address(0),
            "DeployDomainRoutingMailbox: Set DEFAULT_MAILBOX_ADDRESS env var"
        );

        // Optional: Owner address (defaults to deployer if not provided)
        address ownerAddress = vm.envOr("OWNER_ADDRESS", deployerAddress);

        console.log("--- Deploying DomainRoutingMailbox ---");
        console.log("Deployer Address:", deployerAddress);
        console.log("Default Mailbox Address:", defaultMailboxAddress);
        console.log("Owner Address:", ownerAddress);
        console.log("----------------------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // --- 1. Deploy DomainRoutingMailbox ---
        // First deploy the contract
        DomainRoutingMailbox domainRoutingMailbox = new DomainRoutingMailbox();
        deployedDomainRoutingMailboxAddress = address(domainRoutingMailbox);
        console.log(
            "DomainRoutingMailbox deployed at:",
            deployedDomainRoutingMailboxAddress
        );

        // --- 2. Initialize contract ---
        // Initialize with owner and default mailbox
        domainRoutingMailbox.initialize(ownerAddress, defaultMailboxAddress);
        console.log(
            "Initialized DomainRoutingMailbox with owner:",
            ownerAddress
        );
        console.log("Default mailbox set to:", defaultMailboxAddress);

        vm.stopBroadcast();

        // --- Post-Deployment Info ---
        console.log("----------------------------------------");
        console.log("Deployment Summary:");
        console.log(
            "  DomainRoutingMailbox Address:",
            deployedDomainRoutingMailboxAddress
        );
        console.log("  Default Mailbox:", defaultMailboxAddress);
        console.log("  Owner:", ownerAddress);
        console.log("----------------------------------------");
        console.log(
            "To configure domain-specific mailboxes, use a separate script."
        );
        console.log("----------------------------------------");

        return deployedDomainRoutingMailboxAddress;
    }
}
