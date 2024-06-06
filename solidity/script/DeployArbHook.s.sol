// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {ArbL2ToL1Hook} from "../../contracts/hooks/ArbL2ToL1Hook.sol";
import {ArbL2ToL1Ism} from "../../contracts/isms/hook/ArbL2ToL1Ism.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

contract DeployArbHook is Script {
    uint256 deployerPrivateKey;

    ArbL2ToL1Hook hook;
    ArbL2ToL1Ism ism;

    uint32 constant L1_DOMAIN = 11155111;
    address constant L1_MAILBOX = 0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766;
    address constant L1_BRIDGE = 0x38f918D0E9F1b721EDaA41302E399fa1B79333a9;

    address constant ARBSYS = 0x0000000000000000000000000000000000000064;
    address constant L2_MAILBOX = 0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8;
    address constant L2_HOOK = 0xB057Fb841027a8554521DcCdeC3c3474CaC99AB5;

    function deployIsm() external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        ism = new ArbL2ToL1Ism(L1_BRIDGE, TypeCasts.addressToBytes32(L2_HOOK));

        TestRecipient testRecipient = new TestRecipient();
        testRecipient.setInterchainSecurityModule(address(ism));

        vm.stopBroadcast();
    }

    function deployHook() external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        hook = new ArbL2ToL1Hook(
            L2_MAILBOX,
            L1_DOMAIN,
            TypeCasts.addressToBytes32(L1_MAILBOX),
            ARBSYS
        );

        vm.stopBroadcast();
    }
}
