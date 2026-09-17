// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {ReverseMappingLib} from "contracts/libs/ReverseMapping.sol";

contract ReverseMappingHarness {
    using ReverseMappingLib for ReverseMappingLib.Uint16ReverseMappingStorage;
    using ReverseMappingLib for ReverseMappingLib.Uint32ReverseMappingStorage;

    ReverseMappingLib.Uint16ReverseMappingStorage private routes16;
    ReverseMappingLib.Uint32ReverseMappingStorage private routes;

    function assign16(uint32 key, uint16 reverseKey) external {
        routes16.assign(key, reverseKey);
    }

    function remove16(uint32 key) external returns (uint16) {
        return routes16.remove(key);
    }

    function reverseKeyOf16(uint32 key) external view returns (uint16) {
        return routes16.reverseKeyOf(key);
    }

    function keyOf16(
        uint16 reverseKey
    ) external view returns (bool assigned, uint32 key) {
        ReverseMappingLib.ReverseEntry memory entry = routes16.keyOf(
            reverseKey
        );
        return (entry.assigned, entry.key);
    }

    function assign(uint32 key, uint32 reverseKey) external {
        routes.assign(key, reverseKey);
    }

    function remove(uint32 key) external returns (uint32) {
        return routes.remove(key);
    }

    function reverseKeyOf(uint32 key) external view returns (uint32) {
        return routes.reverseKeyOf(key);
    }

    function keyOf(
        uint32 reverseKey
    ) external view returns (bool assigned, uint32 key) {
        ReverseMappingLib.ReverseEntry memory entry = routes.keyOf(reverseKey);
        return (entry.assigned, entry.key);
    }
}

contract ReverseMappingTest is Test {
    ReverseMappingHarness internal routes;

    function setUp() public {
        routes = new ReverseMappingHarness();
    }

    function testUint32KeyZeroCanBeAssigned() public {
        routes.assign(0, 30101);

        assertEq(routes.reverseKeyOf(0), 30101);
        (bool assigned, uint32 key) = routes.keyOf(30101);
        assertTrue(assigned);
        assertEq(key, 0);
    }

    function testUint32SamePairCanBeAssignedAgain() public {
        routes.assign(42, 30101);
        routes.assign(42, 30101);

        assertEq(routes.reverseKeyOf(42), 30101);
        (bool assigned, uint32 key) = routes.keyOf(30101);
        assertTrue(assigned);
        assertEq(key, 42);
    }

    function testUint32RejectsZeroReverseKey() public {
        routes.assign(42, 30101);

        vm.expectRevert(ReverseMappingLib.ReverseKeyCannotBeZero.selector);
        routes.assign(42, 0);

        assertEq(routes.reverseKeyOf(42), 30101);
        (bool assigned, uint32 key) = routes.keyOf(30101);
        assertTrue(assigned);
        assertEq(key, 42);
    }

    function testUint32RejectsReverseKeyAssignedToAnotherKey() public {
        routes.assign(42, 30101);

        vm.expectRevert(
            abi.encodeWithSelector(
                ReverseMappingLib.ReverseKeyAssignedToAnotherKey.selector,
                30101,
                42
            )
        );
        routes.assign(43, 30101);
    }

    function testUint32ReassignmentClearsOldReverseMapping() public {
        routes.assign(0, 30101);
        routes.assign(0, 30102);

        assertEq(routes.reverseKeyOf(0), 30102);
        (bool oldReverseKeyAssigned, ) = routes.keyOf(30101);
        assertFalse(oldReverseKeyAssigned);
        (bool newReverseKeyAssigned, uint32 key) = routes.keyOf(30102);
        assertTrue(newReverseKeyAssigned);
        assertEq(key, 0);

        routes.assign(42, 30101);
        (oldReverseKeyAssigned, key) = routes.keyOf(30101);
        assertTrue(oldReverseKeyAssigned);
        assertEq(key, 42);

        assertEq(routes.remove(0), 30102);
        assertEq(routes.reverseKeyOf(42), 30101);
        (oldReverseKeyAssigned, key) = routes.keyOf(30101);
        assertTrue(oldReverseKeyAssigned);
        assertEq(key, 42);
    }

    function testUint32RejectsReassignmentToOccupiedReverseKeyWithoutChanges()
        public
    {
        routes.assign(42, 30101);
        routes.assign(43, 30102);

        vm.expectRevert(
            abi.encodeWithSelector(
                ReverseMappingLib.ReverseKeyAssignedToAnotherKey.selector,
                30102,
                43
            )
        );
        routes.assign(42, 30102);

        assertEq(routes.reverseKeyOf(42), 30101);
        assertEq(routes.reverseKeyOf(43), 30102);
        (bool assigned, uint32 key) = routes.keyOf(30101);
        assertTrue(assigned);
        assertEq(key, 42);
        (assigned, key) = routes.keyOf(30102);
        assertTrue(assigned);
        assertEq(key, 43);
    }

    function testUint32RemoveClearsBothDirectionsAndAllowsReassignment()
        public
    {
        routes.assign(0, 30101);
        assertEq(routes.remove(0), 30101);

        assertEq(routes.reverseKeyOf(0), 0);
        (bool assigned, uint32 key) = routes.keyOf(30101);
        assertFalse(assigned);
        assertEq(key, 0);

        routes.assign(42, 30101);
        (assigned, key) = routes.keyOf(30101);
        assertTrue(assigned);
        assertEq(key, 42);
    }

    function testUint32RemoveRejectsUnknownKey() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ReverseMappingLib.KeyNotAssigned.selector,
                42
            )
        );
        routes.remove(42);
    }

    function testFuzzUint32RoundTrip(uint32 key, uint32 reverseKey) public {
        vm.assume(reverseKey != 0);

        routes.assign(key, reverseKey);
        assertEq(routes.reverseKeyOf(key), reverseKey);
        (bool assigned, uint32 assignedKey) = routes.keyOf(reverseKey);
        assertTrue(assigned);
        assertEq(assignedKey, key);

        assertEq(routes.remove(key), reverseKey);
        assertEq(routes.reverseKeyOf(key), 0);
        (assigned, ) = routes.keyOf(reverseKey);
        assertFalse(assigned);
    }

    function testUint16KeyZeroReassignmentReleasesOldReverseKey() public {
        routes.assign16(0, 1);
        routes.assign16(0, type(uint16).max);

        assertEq(routes.reverseKeyOf16(0), type(uint16).max);
        (bool oldReverseKeyAssigned, ) = routes.keyOf16(1);
        assertFalse(oldReverseKeyAssigned);
        (bool newReverseKeyAssigned, uint32 key) = routes.keyOf16(
            type(uint16).max
        );
        assertTrue(newReverseKeyAssigned);
        assertEq(key, 0);

        routes.assign16(42, 1);
        assertEq(routes.remove16(0), type(uint16).max);
        assertEq(routes.reverseKeyOf16(42), 1);
    }

    function testUint16SamePairCanBeAssignedAgain() public {
        routes.assign16(42, 1);
        routes.assign16(42, 1);

        assertEq(routes.reverseKeyOf16(42), 1);
        (bool assigned, uint32 key) = routes.keyOf16(1);
        assertTrue(assigned);
        assertEq(key, 42);
    }

    function testUint16RejectsZeroReverseKeyWithoutChanges() public {
        routes.assign16(42, 1);

        vm.expectRevert(ReverseMappingLib.ReverseKeyCannotBeZero.selector);
        routes.assign16(42, 0);

        assertEq(routes.reverseKeyOf16(42), 1);
    }

    function testUint16RejectsOccupiedReverseKeyWithoutChanges() public {
        routes.assign16(42, 1);
        routes.assign16(43, 2);

        vm.expectRevert(
            abi.encodeWithSelector(
                ReverseMappingLib.ReverseKeyAssignedToAnotherKey.selector,
                2,
                43
            )
        );
        routes.assign16(42, 2);

        assertEq(routes.reverseKeyOf16(42), 1);
        assertEq(routes.reverseKeyOf16(43), 2);
        (bool assigned, uint32 key) = routes.keyOf16(1);
        assertTrue(assigned);
        assertEq(key, 42);
    }

    function testUint16RemoveRejectsUnknownKey() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ReverseMappingLib.KeyNotAssigned.selector,
                42
            )
        );
        routes.remove16(42);
    }

    function testFuzzUint16RoundTrip(uint32 key, uint16 reverseKey) public {
        vm.assume(reverseKey != 0);

        routes.assign16(key, reverseKey);
        assertEq(routes.reverseKeyOf16(key), reverseKey);
        (bool assigned, uint32 assignedKey) = routes.keyOf16(reverseKey);
        assertTrue(assigned);
        assertEq(assignedKey, key);

        assertEq(routes.remove16(key), reverseKey);
        assertEq(routes.reverseKeyOf16(key), 0);
        (assigned, ) = routes.keyOf16(reverseKey);
        assertFalse(assigned);
    }
}
