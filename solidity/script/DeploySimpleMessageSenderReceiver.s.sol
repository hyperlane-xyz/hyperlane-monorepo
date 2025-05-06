// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/test/SimpleMessageSenderReceiver.sol";
import "../contracts/interfaces/IMailbox.sol";
import "../contracts/interfaces/IInterchainSecurityModule.sol";

contract DeploySimpleMessageSenderReceiver is Script {
    function run() external returns (address deployedAddress) {
        // --- Configuration ---
        // These should be set in your environment variables or .env file
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address mailboxAddress = vm.envAddress("MAILBOX_ADDRESS"); // Address of the deployed Mailbox proxy
        address polymerIsmAddress = vm.envAddress("POLYMER_ISM_ADDRESS"); // Address of the deployed PolymerISM

        // --- Input Validation ---
        require(
            mailboxAddress != address(0),
            "MAILBOX_ADDRESS env var not set or invalid"
        );
        require(
            polymerIsmAddress != address(0),
            "POLYMER_ISM_ADDRESS env var not set or invalid"
        );

        vm.startBroadcast(deployerPrivateKey);

        // --- Deployment ---
        console.log("Deploying SimpleMessageSenderReceiver...");
        console.log("  Using Mailbox:", mailboxAddress);
        console.log("  Using PolymerISM:", polymerIsmAddress);

        SimpleMessageSenderReceiver instance = new SimpleMessageSenderReceiver(
            mailboxAddress,
            polymerIsmAddress
        );

        deployedAddress = address(instance);
        console.log(
            "SimpleMessageSenderReceiver deployed at:",
            deployedAddress
        );

        vm.stopBroadcast();

        // --- Post-Deployment Info ---
        console.log("-----------------------------------------");
        console.log("Deployment Summary:");
        console.log("  SimpleMessageSenderReceiver Address:", deployedAddress);
        console.log("-----------------------------------------");

        return deployedAddress;
    }
}
