// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {OptimisticISM} from "../../contracts/isms/optimistic/OptimisticISM.sol";
import {TestIsm} from "./IsmTestUtils.sol";

import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {IOptimisticIsm} from "../../contracts/interfaces/isms/IOptimisticIsm.sol";

contract OptimisticISMTest is Test {
    OptimisticISM ism;
    TestIsm submodule;

    uint64 internal constant FRAUD_WINDOW = 100;
    uint256 internal INIT_THRESHOLD = 1;

    bytes internal METADATA1 = abi.encodePacked("metadata1");
    bytes internal MESSAGE1 = abi.encodePacked("message1");

    bytes internal METADATA2 = abi.encodePacked("metadata2");
    bytes internal MESSAGE2 = abi.encodePacked("message2");

    address internal ALICE = address(bytes20("alice"));
    address internal BOB = address(bytes20("bob"));

    function createWatcherSet(uint256 numberOfWatchers) internal pure returns(address[] memory) {
        address[] memory watchers = new address[](numberOfWatchers);
        for (uint256 i = 0; i < numberOfWatchers; i++) {
            watchers[i] = address(bytes20(bytes32(abi.encodePacked(i, "watcher"))));
        }
        return watchers;
    }

    function setUp() public {
        address[] memory watchers = new address[](1);
        watchers[0] = address(this);
        
        submodule = new TestIsm(METADATA1);
        ism = new OptimisticISM(submodule, FRAUD_WINDOW);
        ism.initialize(watchers, uint8(INIT_THRESHOLD));
    }

    function test_ModuleType() public {
        assertEq(
            ism.moduleType(),
            uint8(IInterchainSecurityModule.Types.OPTIMISTIC),
            "module type should be optimistic"
        );
    }

    function test_PreVerify() public {
        assertEq(ism.getMessage(keccak256(abi.encode(METADATA1,METADATA1))).timestamp, 0);
        assertEq(ism.getMessage(keccak256(abi.encode(METADATA1,METADATA1))).checkingSubmodule, address(0));
        
        // now pre-verify the message and check that it is present in the mapping
        assertTrue(ism.preVerify(METADATA1,MESSAGE1));
        
        assertEq(
            ism.getMessage(keccak256(abi.encode(METADATA1,MESSAGE1))).timestamp,
            block.timestamp + FRAUD_WINDOW
        );
        assertEq(
            ism
                .getMessage(keccak256(abi.encode(METADATA1,MESSAGE1)))
                .checkingSubmodule,
            address(submodule)
        );

        // non-preverified message should not be present in mapping
        assertEq(ism.getMessage(keccak256(abi.encode(METADATA2,MESSAGE2))).timestamp, 0);
        assertEq(ism.getMessage(keccak256(abi.encode(METADATA2,MESSAGE2))).checkingSubmodule, address(0));
    }

    function test_SuccessfulVerify() public {
        assertTrue(ism.preVerify(METADATA1,MESSAGE1));

        assertEq(
            ism.getMessage(keccak256(abi.encode(METADATA1,MESSAGE1))).timestamp,
            block.timestamp + FRAUD_WINDOW
        );
        assertEq(
            ism
                .getMessage(keccak256(abi.encode(METADATA1,MESSAGE1)))
                .checkingSubmodule,
            address(submodule)
        );

        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        assertTrue(ism.verify(METADATA1,MESSAGE1));
    }

    function test_VerifyFraudWindowNotPassed() public {
        assertTrue(ism.preVerify(METADATA1,MESSAGE1));
        assertFalse(ism.verify(METADATA1,MESSAGE1));
    }

    function test_VerifyFraudulentSubmodule() public {
        assertTrue(ism.preVerify(METADATA1,MESSAGE1));

        ism.markFraudulent(submodule);

        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        // one of the watchers has marked the submodule as fraudulent
        // threshold is 1, so the message should be marked as fraudulent
        assertFalse(ism.verify(METADATA1,MESSAGE1));


        submodule.setRequiredMetadata(METADATA2);
        assertTrue(ism.preVerify(METADATA2,MESSAGE2));
        
        address[] memory watchers = new address[](2);
        watchers[0] = ALICE;
        watchers[1] = address(this);

        ism.setNewStaticNofMWatchers(watchers, 2);
        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        assertTrue(ism.verify(METADATA2,MESSAGE2));
    }

    function test_MarkFraudulantOnlyWatcherCanSetSubmoduleAsFraud() public {
        vm.expectRevert(IOptimisticIsm.OnlyWatcherError.selector);
        vm.prank(address(0x01));
        ism.markFraudulent(submodule);

        // watcher (this address) can mark submodule as fraudulent
        ism.markFraudulent(submodule);
    }

    function test_MarkFraudulantCantMarkFradulantTwice() public {
        ism.markFraudulent(submodule);
        vm.expectRevert();
        ism.markFraudulent(submodule);
    }
}