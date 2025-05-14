// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {DomainRoutingMailbox} from "../contracts/DomainRoutingMailbox.sol";

contract ConfigureDomainRoutingMailbox is Script {
    function run() external {
        // --- Configuration (Read from environment variables) ---
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        // Address of the DomainRoutingMailbox to configure
        address domainRoutingMailboxAddress = vm.envAddress(
            "DOMAIN_ROUTING_MAILBOX_ADDRESS"
        );
        require(
            domainRoutingMailboxAddress != address(0),
            "ConfigureDomainRoutingMailbox: Set DOMAIN_ROUTING_MAILBOX_ADDRESS env var"
        );

        // Domain to be configured
        uint32 domainId = uint32(vm.envUint("DOMAIN_ID"));
        require(
            domainId > 0,
            "ConfigureDomainRoutingMailbox: Set DOMAIN_ID env var"
        );

        // Mailbox address for the domain
        address mailboxAddress = vm.envAddress("DOMAIN_MAILBOX_ADDRESS");
        require(
            mailboxAddress != address(0),
            "ConfigureDomainRoutingMailbox: Set DOMAIN_MAILBOX_ADDRESS env var"
        );

        console.log("--- Configuring DomainRoutingMailbox ---");
        console.log("Deployer Address:", deployerAddress);
        console.log(
            "DomainRoutingMailbox Address:",
            domainRoutingMailboxAddress
        );
        console.log("Domain ID to Configure:", domainId);
        console.log("Mailbox Address for Domain:", mailboxAddress);
        console.log("----------------------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // Get the contract instance
        DomainRoutingMailbox domainRoutingMailbox = DomainRoutingMailbox(
            domainRoutingMailboxAddress
        );

        // Configure the domain mapping
        domainRoutingMailbox.setDomainMailbox(domainId, mailboxAddress);
        console.log(
            "Successfully set Domain",
            domainId,
            "to Mailbox",
            mailboxAddress
        );

        vm.stopBroadcast();

        console.log("----------------------------------------");
        console.log("Domain Routing Configuration Complete");
        console.log("----------------------------------------");
    }
}
