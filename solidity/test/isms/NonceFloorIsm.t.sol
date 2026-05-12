// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {NonceFloorIsm} from "../../contracts/isms/NonceFloorIsm.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {MessageUtils} from "./IsmTestUtils.sol";

contract NonceFloorIsmTest is Test {
    NonceFloorIsm ism;

    uint32 constant ORIGIN = 1983;
    uint32 constant FLOOR = 1092;
    uint32 constant OTHER_ORIGIN = 1;

    function setUp() public {
        uint32[] memory origins = new uint32[](1);
        origins[0] = ORIGIN;
        uint32[] memory floors = new uint32[](1);
        floors[0] = FLOOR;
        ism = new NonceFloorIsm(origins, floors);
    }

    function _message(
        uint32 origin,
        uint32 nonce
    ) internal pure returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                0,
                nonce,
                origin,
                bytes32(0),
                0,
                bytes32(0),
                ""
            );
    }

    function test_moduleType() public view {
        assertEq(ism.moduleType(), uint8(IInterchainSecurityModule.Types.NULL));
    }

    function test_nonceFloor() public view {
        assertEq(ism.nonceFloors(ORIGIN), FLOOR);
    }

    function test_verify_rejectsAtFloor() public view {
        assertFalse(ism.verify("", _message(ORIGIN, FLOOR)));
    }

    function test_verify_rejectsBelowFloor() public view {
        assertFalse(ism.verify("", _message(ORIGIN, 0)));
        assertFalse(ism.verify("", _message(ORIGIN, 1)));
        assertFalse(ism.verify("", _message(ORIGIN, FLOOR - 1)));
    }

    function test_verify_acceptsAboveFloor() public view {
        assertTrue(ism.verify("", _message(ORIGIN, FLOOR + 1)));
        assertTrue(ism.verify("", _message(ORIGIN, FLOOR + 100)));
        assertTrue(ism.verify("", _message(ORIGIN, type(uint32).max)));
    }

    function test_verify_acceptsUnknownOrigin() public view {
        assertTrue(ism.verify("", _message(OTHER_ORIGIN, 0)));
        assertTrue(ism.verify("", _message(OTHER_ORIGIN, 1)));
    }

    function test_constructor_lengthMismatch() public {
        uint32[] memory origins = new uint32[](1);
        origins[0] = ORIGIN;
        uint32[] memory floors = new uint32[](0);
        vm.expectRevert("length mismatch");
        new NonceFloorIsm(origins, floors);
    }

    function test_constructor_zeroFloor() public {
        uint32[] memory origins = new uint32[](1);
        origins[0] = 999;
        uint32[] memory floors = new uint32[](1);
        floors[0] = 0;
        vm.expectRevert("floor must be > 0");
        new NonceFloorIsm(origins, floors);
    }

    function test_constructor_duplicateOrigin() public {
        uint32[] memory origins = new uint32[](2);
        origins[0] = ORIGIN;
        origins[1] = ORIGIN;
        uint32[] memory floors = new uint32[](2);
        floors[0] = 100;
        floors[1] = 200;
        vm.expectRevert("floor already set");
        new NonceFloorIsm(origins, floors);
    }

    function test_constructor_multipleOrigins() public {
        uint32[] memory origins = new uint32[](2);
        origins[0] = ORIGIN;
        origins[1] = OTHER_ORIGIN;
        uint32[] memory floors = new uint32[](2);
        floors[0] = 1092;
        floors[1] = 500;
        NonceFloorIsm multi = new NonceFloorIsm(origins, floors);

        assertEq(multi.nonceFloors(ORIGIN), 1092);
        assertEq(multi.nonceFloors(OTHER_ORIGIN), 500);

        assertFalse(multi.verify("", _message(ORIGIN, 1092)));
        assertFalse(multi.verify("", _message(OTHER_ORIGIN, 500)));

        assertTrue(multi.verify("", _message(ORIGIN, 1093)));
        assertTrue(multi.verify("", _message(OTHER_ORIGIN, 501)));
    }

    function test_constructor_emitsEvents() public {
        uint32[] memory origins = new uint32[](1);
        origins[0] = ORIGIN;
        uint32[] memory floors = new uint32[](1);
        floors[0] = FLOOR;

        vm.expectEmit(true, false, false, true);
        emit NonceFloorIsm.NonceFloorSet(ORIGIN, FLOOR);
        new NonceFloorIsm(origins, floors);
    }

    function testFuzz_verify(uint32 nonce) public view {
        if (nonce <= FLOOR) {
            assertFalse(ism.verify("", _message(ORIGIN, nonce)));
        } else {
            assertTrue(ism.verify("", _message(ORIGIN, nonce)));
        }
    }
}
