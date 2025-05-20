// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import {DomainRecipientRoutingHook} from "../contracts/hooks/routing/DomainRecipientRoutingHook.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract ConfigureFallbackDomainRecipientRoutingHook is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Get hook address to configure
        address hookAddress = vm.envAddress("HOOK_ADDRESS");

        // Get mapping configuration from env vars
        uint32 destinationDomain = uint32(vm.envUint("DESTINATION_DOMAIN"));
        address recipient = vm.envAddress("RECIPIENT_ADDRESS");
        address targetHook = vm.envAddress("TARGET_HOOK_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        DomainRecipientRoutingHook routingHook = DomainRecipientRoutingHook(
            hookAddress
        );

        console.log(
            "Configuring FallbackDomainRecipientRoutingHook at:",
            hookAddress
        );
        console.log("Setting mapping for:");
        console.log("  Destination Domain:", destinationDomain);
        console.log("  Recipient Address:", recipient);
        console.log("  Target Hook Address:", targetHook);

        routingHook.setHook(destinationDomain, recipient, targetHook);

        vm.stopBroadcast();
    }
}
