// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import {DomainRecipientRoutingHook} from "../contracts/hooks/routing/DomainRecipientRoutingHook.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract DeployFallbackDomainRecipientRoutingHook is Script {
    function run() external returns (address hookAddress) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);
        address mailbox = vm.envAddress("LOCAL_MAILBOX_ADDRESS");
        address fallbackHook = vm.envAddress("FALLBACK_HOOK_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        console.log("Deploying DomainRecipientRoutingHook...");
        DomainRecipientRoutingHook hook = new DomainRecipientRoutingHook(
            mailbox,
            deployerAddress
        );
        console.log("DomainRecipientRoutingHook deployed at:", address(hook));

        // Set the fallback hook for all domains/recipients
        console.log("Setting fallback hook...");
        hook.setHook(0, address(0), fallbackHook);
        console.log("Fallback hook set to:", fallbackHook);

        vm.stopBroadcast();

        hookAddress = address(hook);
        return hookAddress;
    }
}
