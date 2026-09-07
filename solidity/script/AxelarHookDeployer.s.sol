// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {AxelarHook} from "../contracts/hooks/AxelarHook.sol";
import {AxelarIsm} from "../contracts/isms/hook/AxelarIsm.sol";

/**
 * @title AxelarHookDeployer
 * @notice Helper deployment script for the Axelar Hook + ISM testnet demo.
 * @dev Deployment is necessarily two-sided (ISM on the destination chain, hook
 * on the origin chain), so each step is a separate entrypoint driven by env
 * vars. See `RUNBOOK_testnet_demo.md` for the full walkthrough.
 *
 * Steps:
 *  1. `deployIsm`            on the DESTINATION chain.
 *  2. `deployHook`           on the ORIGIN chain (needs the ISM address).
 *  3. `setAuthorizedHook`    on the DESTINATION chain (needs the hook address).
 */
contract AxelarHookDeployer is Script {
    function deployIsm() external {
        address axelarGateway = vm.envAddress("AXELAR_GATEWAY");
        string memory originChain = vm.envString("AXELAR_ORIGIN_CHAIN");

        vm.startBroadcast();
        AxelarIsm ism = new AxelarIsm(axelarGateway, originChain);
        vm.stopBroadcast();

        console.log("AxelarIsm deployed at:", address(ism));
    }

    function deployHook() external {
        address mailbox = vm.envAddress("HYP_MAILBOX");
        uint32 destinationDomain = uint32(vm.envUint("HYP_DESTINATION_DOMAIN"));
        address ism = vm.envAddress("AXELAR_ISM");
        address axelarGateway = vm.envAddress("AXELAR_GATEWAY");
        address axelarGasService = vm.envAddress("AXELAR_GAS_SERVICE");
        string memory destinationChain = vm.envString(
            "AXELAR_DESTINATION_CHAIN"
        );

        vm.startBroadcast();
        AxelarHook hook = new AxelarHook(
            mailbox,
            destinationDomain,
            TypeCasts.addressToBytes32(ism),
            axelarGateway,
            axelarGasService,
            destinationChain
        );
        vm.stopBroadcast();

        console.log("AxelarHook deployed at:", address(hook));
    }

    function setAuthorizedHook() external {
        address ism = vm.envAddress("AXELAR_ISM");
        address hook = vm.envAddress("AXELAR_HOOK");

        vm.startBroadcast();
        AxelarIsm(ism).setAuthorizedHook(TypeCasts.addressToBytes32(hook));
        vm.stopBroadcast();

        console.log("AxelarIsm authorized hook set to:", hook);
    }
}
