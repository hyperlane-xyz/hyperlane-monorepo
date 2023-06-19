// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "../../lib/forge-std/src/Test.sol";

import {SimpleOptimisticIsm} from "../../contracts/isms/optimistic/SimpleOptimisticIsm.sol";
import {SimpleOptimisticIsmFactory} from "../../contracts/isms/optimistic/SimpleOptimisticIsmFactory.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {MessageUtils, TestIsm} from "./IsmTestUtils.sol";

contract SimpleOptimisticIsmTest is Test {
    address constant nonOwner = 0xCAfEcAfeCAfECaFeCaFecaFecaFECafECafeCaFe;
    SimpleOptimisticIsm ism;
    event ModuleSet(IInterchainSecurityModule module);
    event FraudWindowSet(uint fraudWindow);
    event FraudCountSet(uint8 fraudCountTreshold);

    function setUp() public {
        ism = new SimpleOptimisticIsm();
        ism.initialize(address(this));
    }

    function deployTestIsm(
        bytes32 requiredMetadata
    ) internal returns (TestIsm) {
        TestIsm testIsm = new TestIsm(abi.encode(requiredMetadata));
        ism.set(testIsm);
        return testIsm;
    }

    function testSetFraudWindow(uint _fraudWindow) public {
        deployTestIsm(bytes32(0));
        vm.expectEmit(true, false, false, true);
        emit FraudWindowSet(_fraudWindow);
        ism.setFraudWindow(_fraudWindow);
        assertEq(ism.fraudWindow(), _fraudWindow);
    }

    function testSetFraudCountTreshold(uint8 _fraudCountTreshold) public {
        deployTestIsm(bytes32(0));
        vm.expectEmit(true, false, false, true);
        emit FraudCountSet(_fraudCountTreshold);
        ism.setFraudCountTreshold(_fraudCountTreshold);
        assertEq(ism.fraudCountTreshold(), _fraudCountTreshold);
    }

    function testSet() public {
        TestIsm _ism = deployTestIsm(bytes32(0));
        vm.expectEmit(true, false, false, true);
        emit ModuleSet(_ism);
        ism.set(_ism);
        assertEq(address(ism.module()), address(_ism));
    }

    function testResetState(
        uint8 _fraudCountTreshold,
        uint _fraudWindow
    ) public {
        vm.assume(_fraudWindow < type(uint).max - 12);
        TestIsm _ism = deployTestIsm(bytes32(0));
        ism.setFraudWindow(_fraudWindow);
        ism.setFraudCountTreshold(_fraudCountTreshold);
        ism.set(_ism);
        assertEq(
            address(ism.module()),
            address(_ism),
            "ism module not updated"
        );
        assertEq(ism.fraudWindow(), _fraudWindow, "wrong fraud window");
        assertEq(
            ism.fraudWindowExpire(),
            block.number + _fraudWindow,
            "wrong fraudwindowexpire"
        );
        assertEq(
            ism.fraudCountTreshold(),
            _fraudCountTreshold,
            "wrong fraud count treshold"
        );
        vm.roll(12);
        ism.set(_ism);
        assertEq(
            address(ism.module()),
            address(_ism),
            "ism module disappeared"
        );
        assertEq(
            ism.fraudWindowExpire(),
            block.number + _fraudWindow,
            "fraud window not reset"
        );
        assertEq(ism.fraudCount(), 0, "fraud count not reset");
    }

    function testIsFraudWindwExpired(
        uint _fraudWindow,
        uint _rollBlock
    ) public {
        vm.assume(_rollBlock > 0);
        vm.assume(_fraudWindow > 0);
        vm.assume(_fraudWindow < type(uint).max - _rollBlock);
        TestIsm _ism = deployTestIsm(bytes32(0));
        ism.setFraudWindow(_fraudWindow);
        ism.set(_ism);
        assertEq(ism.fraudWindow(), _fraudWindow, "wrong fraud window");
        assertEq(
            ism.fraudWindowExpire(),
            block.number + _fraudWindow,
            "wrong fraudwindowexpire"
        );
        assertEq(ism.isFraudWindowExpired(), false, "fraud window expired");
        vm.roll(_fraudWindow + _rollBlock + 1);
        assertEq(
            ism.isFraudWindowExpired(),
            true,
            "fraud window shoulld have expired"
        );
    }

    function testFactory(
        uint _fraudWindow,
        uint8 _fraudCountTreshold,
        address[] calldata _watchers,
        uint _rollBlock
    ) public {
        vm.assume(_fraudWindow > 0);
        vm.assume(_fraudWindow < type(uint).max - _rollBlock);
        TestIsm _ism = deployTestIsm(bytes32(0));
        SimpleOptimisticIsmFactory ismFactory = new SimpleOptimisticIsmFactory();
        SimpleOptimisticIsm simple = ismFactory.deploy(
            _ism,
            _fraudWindow,
            _fraudCountTreshold,
            _watchers
        );
        assertEq(simple.fraudWindow(), _fraudWindow, "wrong fraud window");
        assertEq(
            simple.fraudWindowExpire(),
            block.number + _fraudWindow,
            "wrong fraudwindowexpire"
        );
        assertEq(simple.isFraudWindowExpired(), false, "fraud window expired");
    }

    function testSetNonOwner(IInterchainSecurityModule _ism) public {
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        ism.set(_ism);
    }
}
