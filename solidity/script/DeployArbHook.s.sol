// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {ArbL2ToL1Hook} from "../../contracts/hooks/ArbL2ToL1Hook.sol";
import {ArbL2ToL1Ism} from "../../contracts/isms/hook/ArbL2ToL1Ism.sol";

contract DeployArbHook is Script {
    uint256 deployerPrivateKey;

    ArbL2ToL1Hook hook;
    ArbL2ToL1Ism ism;

    uint32 constant L1_DOMAIN = 11155111;
    address constant OUTBOX = 0x65f07C7D521164a4d5DaC6eB8Fac8DA067A3B78F;
    address constant L1_ISM = 0xC021Ab036b2cA248D11147da5B568df4055bC746;

    address constant ARBSYS = 0x0000000000000000000000000000000000000064;
    address constant L2_MAILBOX = 0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8;
    address constant L2_HOOK = 0xFCc63b537e70652A280c4E7883C5BB5a1700e897;

    function deployIsm() external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        ism = new ArbL2ToL1Ism(OUTBOX);

        vm.stopBroadcast();
    }

    function deployHook() external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        hook = new ArbL2ToL1Hook(
            L2_MAILBOX,
            L1_DOMAIN,
            TypeCasts.addressToBytes32(L1_ISM),
            ARBSYS
        );

        vm.stopBroadcast();
    }

    function setAuthorizedHook() external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        ism = ArbL2ToL1Ism(L1_ISM);

        ism.setAuthorizedHook(TypeCasts.addressToBytes32(L2_HOOK));

        vm.stopBroadcast();
    }
}
