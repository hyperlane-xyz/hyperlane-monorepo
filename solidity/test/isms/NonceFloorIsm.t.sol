// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {NonceFloorIsm} from "../../contracts/isms/NonceFloorIsm.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {MessageUtils} from "./IsmTestUtils.sol";

contract NonceFloorIsmTest is Test {
    NonceFloorIsm ism;

    uint32 constant FLOOR = 1092;

    function setUp() public {
        ism = new NonceFloorIsm(FLOOR);
    }

    function _message(uint32 nonce) internal pure returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                0,
                nonce,
                0,
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
        assertEq(ism.nonceFloor(), FLOOR);
    }

    function test_verify_rejectsAtFloor() public view {
        assertFalse(ism.verify("", _message(FLOOR)));
    }

    function test_verify_rejectsBelowFloor() public view {
        assertFalse(ism.verify("", _message(0)));
        assertFalse(ism.verify("", _message(1)));
        assertFalse(ism.verify("", _message(FLOOR - 1)));
    }

    function test_verify_acceptsAboveFloor() public view {
        assertTrue(ism.verify("", _message(FLOOR + 1)));
        assertTrue(ism.verify("", _message(FLOOR + 100)));
        assertTrue(ism.verify("", _message(type(uint32).max)));
    }

    function test_constructor_zeroFloor() public {
        vm.expectRevert("floor must be > 0");
        new NonceFloorIsm(0);
    }

    function testFuzz_verify(uint32 nonce) public view {
        if (nonce <= FLOOR) {
            assertFalse(ism.verify("", _message(nonce)));
        } else {
            assertTrue(ism.verify("", _message(nonce)));
        }
    }
}
