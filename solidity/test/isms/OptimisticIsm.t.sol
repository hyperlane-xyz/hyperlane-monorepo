// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {console} from "forge-std/console.sol";

import {IOptimisticIsm} from "../../contracts/interfaces/isms/IOptimisticIsm.sol";
import {OptimisticIsmFactory} from "../../contracts/isms/optimistic/OptimisticIsmFactory.sol";
import {OptimisticIsmMetadata} from "../../contracts/libs/isms/OptimisticIsmMetadata.sol";
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

    function deployIsm(bytes32 seed) internal returns (address) {
        bytes32 randomness = seed;
        address[] memory addresses = new address[](1);
        randomness = keccak256(abi.encode(randomness));
        TestIsm subIsm = new TestIsm(abi.encode(randomness));
        address ism_addr = address(subIsm);
        return ism_addr;
    }

    function addWatchersAndPreVerifyIsm(
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
        TestIsm subIsm = TestIsm(deployIsm(seed));
        ism = IOptimisticIsm(factory.deploy(addresses, m, address(subIsm)));
        return keys;
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

    function getPreVerifyMetadata(bytes32 seed) private returns (bytes memory) {
        bytes memory offsets;
        uint32 start = 8 * 2; // We store 2 ranges of metadata, preVerifyIsm and Watcher sigs
        bytes memory metametadata;

        // First, encode preVerifyIsm into metadata
        TestIsm subIsm = TestIsm(ism.getPreVerifyIsm(""));
        bytes memory requiredMetadata = subIsm.requiredMetadata();
        uint32 end = start + uint32(requiredMetadata.length);
        uint64 offset = (uint64(start) << 32) | uint64(end);
        offsets = abi.encodePacked(offset);
        start = end;
        metametadata = abi.encodePacked(metametadata, requiredMetadata);

        // Then, Encode offsets for the watcher signatures
        end = start + uint32(requiredMetadata.length);
        offset = (uint64(start) << 32) | uint64(end);
        offsets = bytes.concat(offsets, abi.encodePacked(offset));
        bytes memory metadata = abi.encodePacked(offsets, metametadata);

        return metadata;
    }

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory message
    ) private returns (bytes memory) {
        uint32 domain = mailbox.localDomain();
        uint256[] memory keys = addWatchersAndPreVerifyIsm(m, n, seed);
        uint256[] memory signers = MOfNTestUtils.choose(m, keys, seed);

        bytes32 digest = keccak256(message);

        bytes memory metadata = getPreVerifyMetadata(seed);

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

    function testPreVerify(
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
        assertTrue(ism.preVerify(metadata, message));
    }
}
