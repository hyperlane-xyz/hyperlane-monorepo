// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {Mailbox} from "../../contracts/Mailbox.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {ArbL2ToL1Hook} from "../../contracts/hooks/ArbL2ToL1Hook.sol";
import {ArbL2ToL1Ism} from "../../contracts/isms/hook/ArbL2ToL1Ism.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {TestIsm} from "../../contracts/test/TestIsm.sol";

contract DeployArbHook is Script {
    uint256 deployerPrivateKey;

    ArbL2ToL1Hook hook;
    ArbL2ToL1Ism ism;

    uint32 constant L1_DOMAIN = 11155111;
    address constant L1_MAILBOX = 0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766;
    address constant L1_BRIDGE = 0x38f918D0E9F1b721EDaA41302E399fa1B79333a9;
    address constant L1_OUTBOX = 0x65f07C7D521164a4d5DaC6eB8Fac8DA067A3B78F;
    address constant L1_ISM = 0x609558c93120adeC005B3D342bD3668c8aF51B3E;
    bytes32 TEST_RECIPIENT =
        0x00000000000000000000000017B49047111c19301FC7503edE306E1739D31bcD;

    address constant ARBSYS = 0x0000000000000000000000000000000000000064;
    address constant L2_MAILBOX = 0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8;
    address constant L2_HOOK = 0xa3AB7E6cE24E6293bD5320A53329Ef2f4DE73fCA;

    function deployIsm() external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        ism = new ArbL2ToL1Ism(L1_BRIDGE, L1_OUTBOX);

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
            TypeCasts.addressToBytes32(L1_ISM),
            ARBSYS
        );

        vm.stopBroadcast();
    }

    function deployTestRecipient() external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        TestIsm noopIsm = new TestIsm();
        noopIsm.setVerify(true);
        TestRecipient testRecipient = new TestRecipient();
        testRecipient.setInterchainSecurityModule(address(noopIsm));

        console.log("TestRecipient address: %s", address(testRecipient));

        vm.stopBroadcast();
    }

    function setAuthorizedHook() external {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        ism = ArbL2ToL1Ism(L1_ISM);
        ism.setAuthorizedHook(TypeCasts.addressToBytes32(L2_HOOK));

        vm.stopBroadcast();
    }

    function testSendMessage() public {
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        Mailbox l2Mailbox = Mailbox(L2_MAILBOX);
        // ArbL2ToL1Hook hooky = ArbL2ToL1Hook(L2_HOOK);
        hook = new ArbL2ToL1Hook(
            L2_MAILBOX,
            L1_DOMAIN,
            TypeCasts.addressToBytes32(L1_MAILBOX),
            ARBSYS
        );

        //     function dispatch(
        //     uint32 destinationDomain,
        //     bytes32 recipientAddress,
        //     bytes calldata messageBody,
        //     bytes calldata metadata,
        //     IPostDispatchHook hook
        // )
        bytes memory message = hex"c0ffee";
        bytes memory hookMetadata = abi.encodePacked("");
        l2Mailbox.dispatch{value: 1e15}(
            L1_DOMAIN,
            TEST_RECIPIENT,
            message,
            hookMetadata,
            hook
        );

        vm.stopBroadcast();
    }
}
