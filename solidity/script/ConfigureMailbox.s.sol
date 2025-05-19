// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import {Mailbox} from "../contracts/Mailbox.sol";

contract ConfigureMailbox is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Get Mailbox address to configure
        address mailboxAddress = vm.envAddress("MAILBOX_ADDRESS");

        // Get new required hook address
        address requiredHookAddress = vm.envAddress("REQUIRED_HOOK_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        Mailbox mailbox = Mailbox(mailboxAddress);

        console.log("Configuring Mailbox at:", mailboxAddress);
        console.log("Setting required hook to:", requiredHookAddress);

        mailbox.setRequiredHook(requiredHookAddress);

        vm.stopBroadcast();
    }
}
