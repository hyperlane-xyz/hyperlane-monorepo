// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "forge-std/console2.sol";

import {IOptimisticIsm} from "../../contracts/interfaces/isms/IOptimisticIsm.sol";
import {OptimisticIsmFactory} from "../../contracts/isms/optimistic/OptimisticIsmFactory.sol";
import {AggregationIsmMetadata} from "../../contracts/libs/isms/AggregationIsmMetadata.sol";
import {MOfNTestUtils} from "./MOfNTestUtils.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";

contract TestIsm {
    bytes public requiredMetadata;

    constructor(bytes memory _requiredMetadata) {
        setRequiredMetadata(_requiredMetadata);
    }

    function setRequiredMetadata(bytes memory _requiredMetadata) public {
        requiredMetadata = _requiredMetadata;
    }

    function verify(bytes calldata _metadata, bytes calldata)
        external
        view
        returns (bool)
    {
        return keccak256(_metadata) == keccak256(requiredMetadata);
    }
}

contract OptimisticIsmTest is Test {
    uint32 constant ORIGIN = 11;
    OptimisticIsmFactory factory;
    IOptimisticIsm ism;
    TestMailbox mailbox;

    function setUp() public {
        factory = new OptimisticIsmFactory();
        mailbox = new TestMailbox(ORIGIN);
    }

    function addWatchers(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private returns (uint256[] memory) {
        uint256[] memory keys = new uint256[](n);
        address[] memory addresses = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 key = uint256(keccak256(abi.encode(seed, i)));
            keys[i] = key;
            addresses[i] = vm.addr(key);
        }
        ism = IOptimisticIsm(factory.deploy(addresses, m));
        return keys;
    }

    function deployIsms(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) internal returns (address[] memory) {
        bytes32 randomness = seed;
        address[] memory isms = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            randomness = keccak256(abi.encode(randomness));
            TestIsm subIsm = new TestIsm(abi.encode(randomness));
            isms[i] = address(subIsm);
        }
        ism = IOptimisticIsm(factory.deploy(isms, m));
        return isms;
    }

    function getMessage(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body
    ) internal returns (bytes memory) {
        uint8 version = mailbox.VERSION();
        uint32 origin = mailbox.localDomain();
        bytes32 sender = TypeCasts.addressToBytes32(address(this));
        uint32 nonce = mailbox.count();
        mailbox.dispatch(destination, recipient, body);
        bytes memory message = Message.formatMessage(
            version,
            nonce,
            origin,
            sender,
            destination,
            recipient,
            body
        );
        return message;
    }

    // function getMetadata(uint8 m, bytes32 seed)
    //     private
    //     view
    //     returns (bytes memory)
    // {
    //     (address[] memory choices, ) = ism.modulesAndThreshold("");
    //     address[] memory chosen = MOfNTestUtils.choose(m, choices, seed);
    //     bytes memory offsets;
    //     uint32 start = 8 * uint32(choices.length);
    //     bytes memory metametadata;
    //     for (uint256 i = 0; i < choices.length; i++) {
    //         bool included = false;
    //         for (uint256 j = 0; j < chosen.length; j++) {
    //             included = included || choices[i] == chosen[j];
    //         }
    //         if (included) {
    //             bytes memory requiredMetadata = TestIsm(choices[i])
    //                 .requiredMetadata();
    //             uint32 end = start + uint32(requiredMetadata.length);
    //             uint64 offset = (uint64(start) << 32) | uint64(end);
    //             offsets = bytes.concat(offsets, abi.encodePacked(offset));
    //             start = end;
    //             metametadata = abi.encodePacked(metametadata, requiredMetadata);
    //         } else {
    //             uint64 offset = 0;
    //             offsets = bytes.concat(offsets, abi.encodePacked(offset));
    //         }
    //     }
    //     return abi.encodePacked(offsets, metametadata);
    // }

    // function testCheckPreVErify(uint8 n, bytes32 seed) public {
    //     // Threshold is set to 1 as we only need one ISM to verify
    //     uint8 m = 1;
    //     vm.assume(0 < n && n < 10 && seed != 0x0); // NOTE: Was not working with zero address seed. But why?
    //     deployIsms(m, n, seed);

    //     bytes memory metadata = getMetadata(m, seed);
    //     assertTrue(ism.verify(metadata, ""));
    // }

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory message
    ) private returns (bytes memory) {
        uint32 domain = mailbox.localDomain();
        uint256[] memory keys = addWatchers(m, n, seed);
        uint256[] memory signers = MOfNTestUtils.choose(m, keys, seed);

        bytes32 digest = keccak256(message);
        bytes memory metadata; // Initialize the metadata variable

        for (uint256 i = 0; i < signers.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[i], digest);
            metadata = abi.encodePacked(metadata, r, s, v);
        }
        return metadata;
    }

    function testVerifyFailWithMOfNWatcherSigs(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        bytes memory message = getMessage(destination, recipient, body);
        bytes memory metadata = getMetadata(m, n, seed, message);
        vm.expectRevert(bytes("!fraud"));
        ism.verify(metadata, message);
    }
}
