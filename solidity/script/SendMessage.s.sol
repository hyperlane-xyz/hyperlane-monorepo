// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/test/SimpleMessageSenderReceiver.sol";

/**
 * @title SendMessage Script
 * @notice Sends a message using an already deployed SimpleMessageSenderReceiver contract.
 * @dev This script executes on the *origin* chain.
 */
contract SendMessage is Script {
    function run() external {
        // --- Configuration ---
        // These should be set in your environment variables or .env file
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        // Address of the SimpleMessageSenderReceiver contract on the *origin* chain (where this script runs)
        address senderContractAddress = vm.envAddress(
            "SENDER_CONTRACT_ADDRESS"
        );
        // Hyperlane Domain ID of the *destination* chain
        uint32 destinationDomain = uint32(vm.envUint("DESTINATION_DOMAIN"));
        // Address of the SimpleMessageSenderReceiver contract on the *destination* chain
        address recipientContractAddress = vm.envAddress(
            "RECIPIENT_CONTRACT_ADDRESS"
        );
        // The message content to send
        string memory messageContent = vm.envString("MESSAGE_CONTENT");

        // --- Input Validation ---
        require(deployerPrivateKey != 0, "PRIVATE_KEY env var not set");
        require(
            senderContractAddress != address(0),
            "SENDER_CONTRACT_ADDRESS env var not set or invalid"
        );
        require(
            destinationDomain != 0, // Assuming 0 is not a valid domain
            "DESTINATION_DOMAIN env var not set or invalid"
        );
        require(
            recipientContractAddress != address(0),
            "RECIPIENT_CONTRACT_ADDRESS env var not set or invalid"
        );
        require(
            bytes(messageContent).length > 0,
            "MESSAGE_CONTENT env var not set or empty"
        );

        vm.startBroadcast(deployerPrivateKey);

        // --- Interaction ---
        console.log(
            "Attempting to send message via SimpleMessageSenderReceiver..."
        );
        console.log("  Sender Contract (Origin):", senderContractAddress);
        console.log("  Destination Domain:", destinationDomain);
        console.log(
            "  Recipient Contract (Destination):",
            recipientContractAddress
        );
        console.log("  Message Content:", messageContent);

        // Get an instance of the deployed sender contract on the origin chain
        SimpleMessageSenderReceiver senderContract = SimpleMessageSenderReceiver(
                senderContractAddress
            );

        // Convert the message string to bytes
        bytes memory messageBodyBytes = bytes(messageContent);

        // Call the sendMessage function on the sender contract
        senderContract.sendMessage(
            destinationDomain,
            recipientContractAddress,
            messageBodyBytes
        );

        console.log("Message sending transaction broadcasted.");
        console.log(
            "Monitor the transaction and Hyperlane explorer for delivery status."
        );

        vm.stopBroadcast();

        // --- Post-Execution Info ---
        console.log("-----------------------------------------");
        console.log("Message Send Parameters:");
        console.log("  Origin Sender Contract:", senderContractAddress);
        console.log("  Destination Domain:", destinationDomain);
        console.log(
            "  Destination Recipient Contract:",
            recipientContractAddress
        );
        console.log("  Message Sent:", messageContent);
        console.log("-----------------------------------------");
    }
}
