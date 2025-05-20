// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import {FallbackDomainRecipientRoutingHook} from "../contracts/hooks/routing/FallbackDomainRecipientRoutingHook.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract DeployFallbackDomainRecipientRoutingHook is Script {
    function run() external returns (address hookAddress) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);
        address mailbox = vm.envAddress("LOCAL_MAILBOX_ADDRESS");
        address fallbackHook = vm.envAddress("FALLBACK_HOOK_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        console.log("Deploying FallbackDomainRecipientRoutingHook...");
        FallbackDomainRecipientRoutingHook hook = new FallbackDomainRecipientRoutingHook(
                mailbox,
                deployerAddress,
                fallbackHook
            );
        console.log(
            "FallbackDomainRecipientRoutingHook deployed at:",
            address(hook)
        );

        vm.stopBroadcast();

        hookAddress = address(hook);
        return hookAddress;
    }
}
