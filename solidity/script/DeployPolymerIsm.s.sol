// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19; // Use a recent version

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {PolymerISM} from "../contracts/isms/PolymerIsm.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

contract DeployPolymerIsm is Script {
    function run() external returns (address polymerIsmAddress) {
        // --- Configuration (Read from environment variables) ---

        // Address of the ICrossL2ProverV2 contract on THIS (destination) chain
        address polymerProverAddress = vm.envAddress("POLYMER_PROVER_ADDRESS");
        require(
            polymerProverAddress != address(0),
            "DeployPolymerIsm: Set POLYMER_PROVER_ADDRESS env var"
        );

        // Address of the Mailbox contract proxy deployed on the ORIGIN chain
        address originMailboxAddress = vm.envAddress("ORIGIN_MAILBOX_ADDRESS");
        require(
            originMailboxAddress != address(0),
            "DeployPolymerIsm: Set ORIGIN_MAILBOX_ADDRESS env var"
        );

        // Deployer's private key (for this destination chain)
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        console.log("--- Deploying PolymerISM ---");
        console.log("Destination Chain RPC:", vm.envString("RPC_URL"));
        console.log("Deployer Address:", deployerAddress);
        console.log("Using Polymer Prover Address:", polymerProverAddress);
        console.log("Using Origin Mailbox Address:", originMailboxAddress);
        console.log("-----------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // --- Deploy PolymerISM ---
        console.log("Deploying PolymerISM contract...");
        PolymerISM polymerIsm = new PolymerISM(
            polymerProverAddress,
            originMailboxAddress
        );
        console.log("PolymerISM deployed at:", address(polymerIsm));

        vm.stopBroadcast();

        // --- Post-Deployment Info ---
        console.log("-----------------------------------------");
        console.log("Deployment Summary:");
        console.log("  PolymerISM Address:", address(polymerIsm));
        console.log(
            "  Configured Polymer Prover:",
            address(polymerIsm.polymerProver())
        );
        console.log("  Configured Origin Mailbox:", polymerIsm.originMailbox());
        console.log("-----------------------------------------");
        console.log(
            "Recipient contracts on this chain wishing to use this ISM for messages from:",
            originMailboxAddress
        );
        console.log("Should return:", address(polymerIsm));
        console.log("from their interchainSecurityModule() function.");

        polymerIsmAddress = address(polymerIsm);
        return polymerIsmAddress;
    }
}
