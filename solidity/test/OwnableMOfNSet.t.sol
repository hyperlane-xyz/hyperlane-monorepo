// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {OwnableMOfNSet} from "../contracts/libs/OwnableMOfNSet.sol";

contract ConcreteOwnableMOfNSet is OwnableMOfNSet {}

contract OwnableMOfNSetTest is Test {
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

    ConcreteOwnableMOfNSet set;

    function setUp() public {
        set = new ConcreteOwnableMOfNSet();
    }

    // addMany
    // setThresholds
    // setMatches

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

    function testContains(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        require(!set.contains(domain, value));
        set.add(domain, value);
        require(set.contains(domain, value));
        set.remove(domain, value);
        require(!set.contains(domain, value));
    }

    function testLength(uint32 domain, address value) public {
        vm.assume(value != address(0x0));
        require(set.length(domain) == 0);
        set.add(domain, value);
        require(set.length(domain) == 1);
    }
}
