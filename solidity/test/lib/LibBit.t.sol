// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {LibBit} from "../../contracts/libs/LibBit.sol";

contract LibBitTest is Test {
    using LibBit for uint256;

    uint256 testValue;
    uint256 MAX_INT =
        0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    function setUp() public {
        testValue = 0;
    }

    function testSetBit(uint8 index) public {
        testValue = testValue.setBit(index);
        assertEq(testValue, 2**index);
    }

    function testClearBit(uint8 index) public {
        testValue = MAX_INT;
        testValue = testValue.clearBit(index);
        assertEq(testValue + 2**index, MAX_INT);
    }

    function testIsBitSet(uint8 index) public {
        testValue = 2**index;
        assertTrue(testValue.isBitSet(index));
    }
}
