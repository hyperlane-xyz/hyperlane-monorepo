// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {IMultisigIsm} from "../../contracts/interfaces/isms/IMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {StaticMerkleRootMultisigIsmFactory} from "../../contracts/isms/multisig/StaticMultisigIsmFactory.sol";
import {StaticMessageIdMultisigIsmFactory} from "../../contracts/isms/multisig/StaticMultisigIsmFactory.sol";
import {MerkleRootMultisigIsmMetadata} from "../../contracts/libs/isms/MerkleRootMultisigIsmMetadata.sol";
import {CheckpointLib} from "../../contracts/libs/CheckpointLib.sol";
import {StaticMOfNAddressSetFactory} from "../../contracts/libs/StaticMOfNAddressSetFactory.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MOfNTestUtils} from "./IsmTestUtils.sol";

abstract contract AbstractMultisigIsmTest is Test {
    using Message for bytes;

    uint32 constant ORIGIN = 11;
    StaticMOfNAddressSetFactory factory;
    IMultisigIsm ism;
    TestMailbox mailbox;

    function metadataPrefix(bytes memory message)
        internal
        view
        virtual
        returns (bytes memory);

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory message
    ) internal returns (bytes memory) {
        uint32 domain = mailbox.localDomain();
        uint256[] memory keys = addValidators(m, n, seed);
        uint256[] memory signers = MOfNTestUtils.choose(m, keys, seed);
        bytes32 mailboxAsBytes32 = TypeCasts.addressToBytes32(address(mailbox));
        bytes32 checkpointRoot = mailbox.root();
        uint32 checkpointIndex = uint32(mailbox.count() - 1);
        bytes32 messageId = message.id();
        bytes32 digest = CheckpointLib.digest(
            domain,
            mailboxAsBytes32,
            checkpointRoot,
            checkpointIndex,
            messageId
        );
        bytes memory metadata = abi.encodePacked(
            mailboxAsBytes32,
            metadataPrefix(message)
        );
        for (uint256 i = 0; i < m; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[i], digest);
            metadata = abi.encodePacked(metadata, r, s, v);
        }
        return metadata;
    }

    function addValidators(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) internal returns (uint256[] memory) {
        uint256[] memory keys = new uint256[](n);
        address[] memory addresses = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 key = uint256(keccak256(abi.encode(seed, i)));
            keys[i] = key;
            addresses[i] = vm.addr(key);
        }
        ism = IMultisigIsm(factory.deploy(addresses, m));
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

    function testVerify(
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
        assertTrue(ism.verify(metadata, message));
    }

    function testFailVerify(
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

        // changing single bit in metadata should fail signature verification
        metadata[metadata.length - 1] = ~metadata[metadata.length - 1];
        ism.verify(metadata, message);
    }
}

contract MerkleRootMultisigIsmTest is AbstractMultisigIsmTest {
    using Message for bytes;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN);
        factory = new StaticMerkleRootMultisigIsmFactory();
    }

    function metadataPrefix(bytes memory message)
        internal
        view
        override
        returns (bytes memory)
    {
        uint32 checkpointIndex = uint32(mailbox.count() - 1);
        return abi.encodePacked(checkpointIndex, message.id(), mailbox.proof());
    }
}

contract MessageIdMultisigIsmTest is AbstractMultisigIsmTest {
    using Message for bytes;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN);
        factory = new StaticMessageIdMultisigIsmFactory();
    }

    function metadataPrefix(bytes memory)
        internal
        view
        override
        returns (bytes memory)
    {
        return abi.encodePacked(mailbox.root());
    }
}
