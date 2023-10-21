// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {OptimisticISM} from "../../contracts/isms/optimistic/OptimisticISM.sol";

import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";

contract OptimisticISMTest is Test {
    OptimisticISM ism;
    MockISM submodule;

    uint64 public constant FRAUD_WINDOW = 100;

    bytes metadata = abi.encodePacked("metadata");
    bytes message = abi.encodePacked("message");

    function setUp() public {
        submodule = new MockISM();
        ism = new OptimisticISM(submodule, FRAUD_WINDOW);
    }

    function testModuleType() public {
        assertEq(
            ism.moduleType(),
            uint8(IInterchainSecurityModule.Types.OPTIMISTIC),
            "module type should be optimistic"
        );
    }

    function testPreVerify() public {
        assertTrue(ism.preVerify(metadata, message), "should be verified");
        // console2.log(ism.messages(keccak256(abi.encode(metadata, message))).timestamp);

        assertEq(
            ism.getMessage(keccak256(abi.encode(metadata, message))).timestamp,
            block.timestamp + FRAUD_WINDOW
        );
        assertEq(
            ism
                .getMessage(keccak256(abi.encode(metadata, message)))
                .checkingSubmodule,
            address(submodule)
        );
    }

    function testSuccessfulVerify() public {
        console2.log("time now ", block.timestamp);
        assertTrue(ism.preVerify(metadata, message), "should be pre-verified");

        assertEq(
            ism.getMessage(keccak256(abi.encode(metadata, message))).timestamp,
            block.timestamp + FRAUD_WINDOW
        );
        assertEq(
            ism
                .getMessage(keccak256(abi.encode(metadata, message)))
                .checkingSubmodule,
            address(submodule)
        );

        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        console2.log("time now 2", block.timestamp);

        assertTrue(ism.verify(metadata, message), "should be verified");
    }

    function testFraudWindowNotPassedVerify() public {
        assertTrue(ism.preVerify(metadata, message));
        assertFalse(ism.verify(metadata, message));
    }

    function testFraudulentSubmoduleVerify() public {
        assertTrue(ism.preVerify(metadata, message));

        ism.addWatcher(address(this));
        ism.markFraudulent(address(submodule));

        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        assertFalse(ism.verify(metadata, message));
    }
}

contract MockISM is IInterchainSecurityModule {
    function moduleType() external view returns (uint8) {
        return uint8(Types.OPTIMISTIC);
    }

    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool)
    {
        return true;
    }
}
