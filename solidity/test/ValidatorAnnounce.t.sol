// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockMailbox.sol";
import "../contracts/ValidatorAnnounce.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {ValidatorAnnouncements} from "../contracts/libs/ValidatorAnnouncements.sol";

contract ValidatorAnnounceTest is Test {
    using TypeCasts for address;

    // TODO: dedup
    event ValidatorAnnouncement(
        address indexed validator,
        string storageLocation
    );

    MockMailbox mailbox;
    uint32 localDomain = 1;
    ValidatorAnnounce valAnnounce;

    function setUp() public {
        mailbox = new MockMailbox(localDomain);
        valAnnounce = new ValidatorAnnounce(address(mailbox));
    }

    function announce(uint256 privateKey, string memory storageLocation)
        internal
    {
        bytes32 digest = ValidatorAnnouncements.getAnnouncementDigest(
            address(mailbox),
            localDomain,
            storageLocation
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        address validator = vm.addr(privateKey);
        valAnnounce.announce(validator, storageLocation, signature);
    }

    function assertEqAddrArr(address[] memory a, address[] memory b) internal {
        bytes memory encodedA = abi.encodePacked(a);
        bytes memory encodedB = abi.encodePacked(b);
        assertEq(encodedA, encodedB);
    }

    function assertEqStrArrArr(string[][] memory a, string[][] memory b)
        internal
    {
        bytes memory encodedA = abi.encode(a);
        bytes memory encodedB = abi.encode(b);
        assertEq(encodedA, encodedB);
    }

    function testAnnounce() public {
        uint256 privateKey = 123456789;
        // Announce a first location
        address validator = vm.addr(privateKey);
        string memory storageLocation1 = "s3://test-bucket/us-east-1";
        vm.expectEmit(true, false, false, true, address(valAnnounce));
        emit ValidatorAnnouncement(validator, storageLocation1);
        announce(privateKey, storageLocation1);

        address[] memory expectedValidators = new address[](1);
        expectedValidators[0] = validator;
        assertEqAddrArr(
            valAnnounce.getAnnouncedValidators(),
            expectedValidators
        );

        string[][] memory expectedLocations1 = new string[][](1);
        string[] memory locations1 = new string[](1);
        locations1[0] = storageLocation1;
        expectedLocations1[0] = locations1;
        assertEqStrArrArr(
            valAnnounce.getAnnouncedStorageLocations(expectedValidators),
            expectedLocations1
        );

        // Shouldn't be able to announce the same location twice
        vm.expectRevert("replay");
        announce(privateKey, storageLocation1);

        // Announce a second location
        string memory storageLocation2 = "s3://test-bucket-2/us-east-1";
        vm.expectEmit(true, false, false, true, address(valAnnounce));
        emit ValidatorAnnouncement(validator, storageLocation2);
        announce(privateKey, storageLocation2);
        assertEqAddrArr(
            valAnnounce.getAnnouncedValidators(),
            expectedValidators
        );

        string[][] memory expectedLocations2 = new string[][](1);
        string[] memory locations2 = new string[](2);
        locations2[0] = storageLocation1;
        locations2[1] = storageLocation2;
        expectedLocations2[0] = locations2;
        assertEqStrArrArr(
            valAnnounce.getAnnouncedStorageLocations(expectedValidators),
            expectedLocations2
        );
    }
}
