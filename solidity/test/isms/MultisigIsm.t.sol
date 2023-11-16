// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {IMultisigIsm} from "../../contracts/interfaces/isms/IMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {StaticMerkleRootMultisigIsmFactory, StaticMessageIdMultisigIsmFactory} from "../../contracts/isms/multisig/StaticMultisigIsm.sol";
import {MerkleRootMultisigIsmMetadata} from "../../contracts/isms/libs/MerkleRootMultisigIsmMetadata.sol";
import {CheckpointLib} from "../../contracts/libs/CheckpointLib.sol";
import {StaticThresholdAddressSetFactory} from "../../contracts/libs/StaticAddressSetFactory.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MerkleTreeHook} from "../../contracts/hooks/MerkleTreeHook.sol";
import {TestMerkleTreeHook} from "../../contracts/test/TestMerkleTreeHook.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {ThresholdTestUtils} from "./IsmTestUtils.sol";

/// @notice since we removed merkle tree from the mailbox, we need to include the MerkleTreeHook in the test
abstract contract AbstractMultisigIsmTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 constant ORIGIN = 11;
    StaticThresholdAddressSetFactory factory;
    IMultisigIsm ism;
    TestMerkleTreeHook internal merkleTreeHook;
    TestPostDispatchHook internal noopHook;
    TestMailbox mailbox;

    function metadataPrefix(
        bytes memory message
    ) internal view virtual returns (bytes memory);

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory message
    ) internal returns (bytes memory) {
        uint32 domain = mailbox.localDomain();
        uint256[] memory keys = addValidators(m, n, seed);
        uint256[] memory signers = ThresholdTestUtils.choose(m, keys, seed);

        (bytes32 root, uint32 index) = merkleTreeHook.latestCheckpoint();
        bytes32 messageId = message.id();
        bytes32 digest = CheckpointLib.digest(
            domain,
            address(merkleTreeHook).addressToBytes32(),
            root,
            index,
            messageId
        );
        bytes memory metadata = metadataPrefix(message);
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
        bytes memory message = mailbox.buildOutboundMessage(
            destination,
            recipient,
            body
        );
        merkleTreeHook.insert(message.id());
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

        // changing single byte in metadata should fail signature verification
        uint256 index = uint256(seed) % metadata.length;
        metadata[index] = ~metadata[index];
        assertFalse(ism.verify(metadata, message));
    }
}

contract MerkleRootMultisigIsmTest is AbstractMultisigIsmTest {
    using TypeCasts for address;
    using Message for bytes;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();
        factory = new StaticMerkleRootMultisigIsmFactory();
        mailbox.setDefaultHook(address(merkleTreeHook));
        mailbox.setRequiredHook(address(noopHook));
    }

    // TODO: test merkleIndex != signedIndex
    function metadataPrefix(
        bytes memory message
    ) internal view override returns (bytes memory) {
        uint32 checkpointIndex = uint32(merkleTreeHook.count() - 1);
        return
            abi.encodePacked(
                address(merkleTreeHook).addressToBytes32(),
                checkpointIndex,
                message.id(),
                merkleTreeHook.proof(),
                checkpointIndex
            );
    }
}

contract MessageIdMultisigIsmTest is AbstractMultisigIsmTest {
    using TypeCasts for address;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();

        factory = new StaticMessageIdMultisigIsmFactory();
        mailbox.setDefaultHook(address(merkleTreeHook));
        mailbox.setRequiredHook(address(noopHook));
    }

    function metadataPrefix(
        bytes memory
    ) internal view override returns (bytes memory) {
        (bytes32 root, uint32 index) = merkleTreeHook.latestCheckpoint();
        return
            abi.encodePacked(
                address(merkleTreeHook).addressToBytes32(),
                root,
                index
            );
    }
}
