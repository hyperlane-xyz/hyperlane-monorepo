// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TestIsm} from "./IsmTestUtils.sol";
import {OptimisticISM} from "../../contracts/isms/optimistic/OptimisticISM.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {IOptimisticIsm} from "../../contracts/interfaces/isms/IOptimisticIsm.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {StaticOptimisticWatchersFactory} from "../../contracts/isms/optimistic/StaticOptimisticWatchersFactory.sol";

contract OptimisticISMTest is Test {
    using Message for bytes; 

    OptimisticISM ism;
    MockSubmodule submodule;
    StaticOptimisticWatchersFactory factory;

    uint64 internal constant FRAUD_WINDOW = 100;
    uint8 internal INIT_THRESHOLD = 1;

    bytes internal METADATA1 = abi.encodePacked("metadata1");
    bytes internal MESSAGE1 = abi.encodePacked("message1");

    bytes internal METADATA2 = abi.encodePacked("metadata2");
    bytes internal MESSAGE2 = abi.encodePacked("message2");
 
    address internal ALICE = address(bytes20("alice"));
    address internal BOB = address(bytes20("bob"));

    event PreVerified(bytes32 id);
    event SetFraudWindow(uint64 indexed fraudWindow);
    event SetSubmodule(IInterchainSecurityModule indexed submodule);

    function getWatcherSet(uint256 numberOfWatchers) internal pure returns(address[] memory) {
        address[] memory watchers = new address[](numberOfWatchers);
        for (uint160 i = 0; i < numberOfWatchers; i++) {
            watchers[i] = address(uint160(i + 1000)); // seed so as to not use precompile addresses
        }
        return watchers;
    }

    function deployContracts(address[] memory watcherSet) internal {
        factory = new StaticOptimisticWatchersFactory();
        submodule = new MockSubmodule(METADATA1);
        ism = new OptimisticISM(submodule, FRAUD_WINDOW, factory.deploy(watcherSet, INIT_THRESHOLD));
    }

    function setUp() public {
        address[] memory watchers = getWatcherSet(INIT_THRESHOLD);
        deployContracts(watchers);
    }

    function test_ModuleType() public {
        assertEq(
            ism.moduleType(),
            uint8(IInterchainSecurityModule.Types.OPTIMISTIC),
            "module type should be optimistic"
        );
    }

    function test_PreVerify() public {
        assertEq(ism.getMessage(MESSAGE1.id()).timestamp, 0);
        assertEq(ism.getMessage(MESSAGE1.id()).checkingSubmodule, address(0));
        
        // now pre-verify the message and check that it is present in the mapping
        vm.expectEmit();
        emit PreVerified(MESSAGE1.id());
        assertTrue(ism.preVerify(METADATA1,MESSAGE1));
        
        assertEq(
            ism.getMessage(MESSAGE1.id()).timestamp,
            uint64(block.timestamp)
        );
        assertEq(
            ism
                .getMessage(MESSAGE1.id())
                .checkingSubmodule,
            address(submodule)
        );

        // non-preverified message should not be present in mapping
        assertEq(ism.getMessage(MESSAGE2.id()).timestamp, 0);
        assertEq(ism.getMessage(MESSAGE2.id()).checkingSubmodule, address(0));
    }

    function test_VerifySuccessful() public {
        assertTrue(ism.preVerify(METADATA1,MESSAGE1));

        assertEq(
            ism.getMessage(MESSAGE1.id()).timestamp,
            uint64(block.timestamp)
        );
        assertEq(
            ism
                .getMessage(MESSAGE1.id())
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

    function test_VerifyFraudulentSubmoduleAboveThreshold() public {
        assertTrue(ism.preVerify(METADATA1,MESSAGE1));

        vm.prank(getWatcherSet(1)[0]);
        ism.markFraudulent(submodule);

        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        // one of the watchers has marked the submodule as fraudulent
        // threshold is 1, so the message should be marked as fraudulent
        assertFalse(ism.verify(METADATA1,MESSAGE1));
    }

    function test_VerifyFraudulentSubmoduleBelowThreshold() public {
        deployContracts(getWatcherSet(2));
        
        assertTrue(ism.preVerify(METADATA1,MESSAGE1));

        vm.prank(getWatcherSet(1)[0]);
        ism.markFraudulent(submodule);

        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        // one of the watchers has marked the submodule as fraudulent
        // threshold is 1, so the message is not fradualent
        assertFalse(ism.verify(METADATA1,MESSAGE1));
    }

    function test_MarkFraudulantOnlyWatcherCanSetSubmoduleAsFraud() public {
        vm.expectRevert(IOptimisticIsm.OnlyWatcher.selector);
        vm.prank(address(0x01));
        ism.markFraudulent(submodule);

        // watcher can mark submodule as fraudulent
        vm.prank(getWatcherSet(1)[0]);
        ism.markFraudulent(submodule);
    }

    function test_MarkFraudulantCantMarkFradulantTwice() public {
        vm.prank(getWatcherSet(1)[0]);
        ism.markFraudulent(submodule);
        vm.prank(getWatcherSet(1)[0]);
        vm.expectRevert(IOptimisticIsm.AlreadyMarkedFraudulent.selector);
        ism.markFraudulent(submodule);
    }

    function test_SetFraudWindow() public {
        assertEq(ism.fraudWindow(), FRAUD_WINDOW);

        vm.expectEmit();
        emit SetFraudWindow(FRAUD_WINDOW + 1);
        ism.setFraudWindow(FRAUD_WINDOW + 1);
        assertEq(ism.fraudWindow(), FRAUD_WINDOW + 1);
    }

    function test_SetSubmodule() public {
        vm.expectEmit();
        emit SetSubmodule(submodule);
        ism.setSubmodule(submodule);
        
        address badSub = address(new BadMockSubmodule(METADATA1));
        vm.expectRevert(IOptimisticIsm.InvalidSubmodule.selector);
        ism.setSubmodule(IInterchainSecurityModule(badSub));
    }
}

contract MockSubmodule is TestIsm {
    constructor(bytes memory _requiredMetadata) TestIsm(_requiredMetadata) {}

    function moduleType() external override pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.OPTIMISTIC);
    }
}

contract BadMockSubmodule is TestIsm {
    constructor(bytes memory _requiredMetadata) TestIsm(_requiredMetadata) {}

    function moduleType() external override pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.LEGACY_MULTISIG);
    }
}