// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {OwnableMOfNSet} from "../contracts/libs/OwnableMOfNSet.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract OwnableMOfNSetTest is Test {
    using TypeCasts for address;
    event ValueAdded(
        uint32 indexed domain,
        address indexed value,
        uint256 length
    );
    event ValueRemoved(
        uint32 indexed domain,
        address indexed value,
        uint256 length
    );
    event ThresholdSet(uint32 indexed domain, uint8 threshold);
    event CommitmentUpdated(uint32 indexed domain, bytes32 commitment);

    OwnableMOfNSet set;

    function setUp() public {
        set = new OwnableMOfNSet();
    }

    function testAdd(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        vm.expectEmit(true, true, true, true, address(set));
        emit ValueAdded(domain, value, 1);
        vm.expectEmit(true, true, false, true, address(set));
        bytes32 commitment = keccak256(abi.encodePacked(uint8(0), [value]));
        emit CommitmentUpdated(domain, commitment);
        set.add(domain, value);
    }

    function testAddTwice(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        set.add(domain, value);
        vm.expectRevert(bytes("contained"));
        set.add(domain, value);
    }

    function testAddZero(uint32 domain) public {
        vm.expectRevert(bytes("zero address"));
        set.add(domain, address(0));
    }

    function testAddNonowner(
        uint32 domain,
        address value,
        address newOwner
    ) public {
        vm.assume(newOwner != address(0x0) && newOwner != set.owner());
        set.transferOwnership(newOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        set.add(domain, value);
    }

    function testAddMany(uint8 numDomains, uint8 numValues) public {
        vm.assume(numDomains < 32 && numValues < 32);
        uint32 firstDomain = 100_000;
        address firstValue = 0x3b2949fFFa5DC0bb41492AeBd12A89B286339858;
        uint32[] memory domains = new uint32[](numDomains);
        address[][] memory values = new address[][](numDomains);
        for (uint32 i = 0; i < numDomains; i++) {
            uint32 domain = firstDomain + i;
            domains[i] = domain;
            values[i] = new address[](numValues);
            for (uint8 j = 0; j < numValues; j++) {
                address value = address(uint160(firstValue) + j);
                values[i][j] = value;
                vm.expectEmit(true, true, true, true, address(set));
                emit ValueAdded(domain, value, j + 1);
            }
            bytes32 commitment = keccak256(
                abi.encodePacked(uint8(0), values[i])
            );
            vm.expectEmit(true, true, true, true, address(set));
            emit CommitmentUpdated(domain, commitment);
        }
        set.addMany(domains, values);
    }

    function testRemove(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        set.add(domain, value);
        vm.expectEmit(true, true, true, true, address(set));
        emit ValueRemoved(domain, value, 0);
        address[] memory emptySet = new address[](0);
        bytes32 commitment = keccak256(abi.encodePacked(uint8(0), emptySet));
        vm.expectEmit(true, true, false, true, address(set));
        emit CommitmentUpdated(domain, commitment);
        set.remove(domain, value);
    }

    function testRemoveUncontained(uint32 domain, address value) public {
        vm.expectRevert(bytes("!contained"));
        set.remove(domain, value);
    }

    function testRemoveBelowThreshold(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        set.add(domain, value);
        set.setThreshold(domain, 1);
        vm.expectRevert(bytes("reduce threshold"));
        set.remove(domain, value);
    }

    function testRemoveNonowner(
        uint32 domain,
        address value,
        address newOwner
    ) public {
        vm.assume(newOwner != address(0x0) && newOwner != set.owner());
        set.transferOwnership(newOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        set.remove(domain, value);
    }

    function testSetThreshold(uint32 domain, address value) public {
        uint8 threshold = 1;
        vm.assume(value != address(0));
        set.add(domain, value);
        vm.expectEmit(true, true, false, true, address(set));
        emit ThresholdSet(domain, threshold);
        vm.expectEmit(true, true, false, true, address(set));
        bytes32 commitment = keccak256(
            abi.encodePacked(uint8(threshold), [value])
        );
        emit CommitmentUpdated(domain, commitment);
        set.setThreshold(domain, threshold);
    }

    function testSetThresholdZero(uint32 domain, address value) public {
        vm.assume(value != address(0));
        set.add(domain, value);
        vm.expectRevert(bytes("!range"));
        set.setThreshold(domain, 0);
    }

    function testSetThresholdTooHigh(uint32 domain, address value) public {
        vm.assume(value != address(0));
        set.add(domain, value);
        vm.expectRevert(bytes("!range"));
        set.setThreshold(domain, 2);
    }

    function testSetThresholdNonowner(
        uint32 domain,
        uint8 threshold,
        address newOwner
    ) public {
        vm.assume(newOwner != address(0x0) && newOwner != set.owner());
        set.transferOwnership(newOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        set.setThreshold(domain, threshold);
    }

    function testSetThresholds(uint32[] memory domains, address value) public {
        vm.assume(value != address(0));
        uint8 threshold = 1;
        uint8[] memory thresholds = new uint8[](domains.length);
        // `domains` could contain repeats
        bool[] memory skip = new bool[](domains.length);
        for (uint256 i = 0; i < domains.length; i++) {
            thresholds[i] = threshold;
            if (set.contains(domains[i], value)) {
                skip[i] = true;
            } else {
                set.add(domains[i], value);
            }
        }
        for (uint256 i = 0; i < domains.length; i++) {
            if (skip[i]) continue;
            vm.expectEmit(true, true, false, true, address(set));
            emit ThresholdSet(domains[i], threshold);
            bytes32 commitment = keccak256(
                abi.encodePacked(uint8(threshold), [value])
            );
            emit CommitmentUpdated(domains[i], commitment);
        }
        set.setThresholds(domains, thresholds);
    }

    function testContains(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        assertFalse(set.contains(domain, value));
        set.add(domain, value);
        assertTrue(set.contains(domain, value));
        set.remove(domain, value);
        assertFalse(set.contains(domain, value));
    }

    function testLength(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        assertEq(set.length(domain), 0);
        set.add(domain, value);
        assertEq(set.length(domain), 1);
    }

    function testThreshold(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        assertEq(set.threshold(domain), 0);
        set.add(domain, value);
        set.setThreshold(domain, 1);
        assertEq(set.threshold(domain), 1);
    }

    function testValuesAndThreshold(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        (address[] memory values, uint8 threshold) = set.valuesAndThreshold(
            domain
        );
        address[] memory emptySet = new address[](0);
        assertEq(abi.encodePacked(values), abi.encodePacked(emptySet));
        assertEq(threshold, 0);

        set.add(domain, value);
        set.setThreshold(domain, 1);
        (values, threshold) = set.valuesAndThreshold(domain);
        address[] memory nonEmptySet = new address[](1);
        nonEmptySet[0] = value;
        assertEq(abi.encodePacked(values), abi.encodePacked(nonEmptySet));
        assertEq(threshold, 1);
    }

    function testSetMatches(
        uint32 domain,
        address firstValue,
        uint8 numValues,
        uint8 threshold
    ) public {
        vm.assume(0 < threshold && threshold <= numValues);
        vm.assume(numValues < uint160(firstValue) && numValues < 32);
        bytes memory packedValues;
        for (uint32 i = 0; i < numValues; i++) {
            address value = address(uint160(firstValue) - i);
            packedValues = abi.encodePacked(
                packedValues,
                value.addressToBytes32()
            );
            set.add(domain, value);
        }
        set.setThreshold(domain, threshold);
        assertTrue(set.setMatches(domain, threshold, packedValues));
    }
}
