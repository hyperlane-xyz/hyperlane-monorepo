// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {Checkpoint, CheckpointLib} from "../contracts/libs/CheckpointLib.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {IOnchainCheckpointStorage, SignedCheckpoint} from "../contracts/interfaces/IOnchainCheckpointStorage.sol";
import {OnchainCheckpointStorage} from "../contracts/OnchainCheckpointStorage.sol";

contract OnchainCheckpointStorageTest is Test {
    using TypeCasts for address;

    event CheckpointWritten(
        address indexed validator,
        uint32 indexed index,
        bytes32 root,
        bytes32 messageId
    );

    event LatestIndexUpdated(address indexed validator, uint32 indexed index);

    OnchainCheckpointStorage checkpointStorage;
    uint256 validatorKey1 = 1;
    uint256 validatorKey2 = 2;
    address validator1;
    address validator2;

    function setUp() public {
        checkpointStorage = new OnchainCheckpointStorage();
        validator1 = vm.addr(validatorKey1);
        validator2 = vm.addr(validatorKey2);
    }

    function signCheckpoint(
        uint256 privateKey,
        Checkpoint memory checkpoint
    ) internal pure returns (bytes memory) {
        bytes32 digest = CheckpointLib.digest(checkpoint);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function testWriteCheckpoint() public {
        Checkpoint memory checkpoint = Checkpoint({
            origin: 11155111,
            merkleTree: address(0x123).addressToBytes32(),
            root: keccak256("root-10"),
            index: 10,
            messageId: keccak256("message-10")
        });

        bytes memory signature = signCheckpoint(validatorKey1, checkpoint);

        vm.expectEmit(true, true, false, true, address(checkpointStorage));
        emit LatestIndexUpdated(validator1, 10);

        vm.expectEmit(true, true, false, true, address(checkpointStorage));
        emit CheckpointWritten(
            validator1,
            10,
            checkpoint.root,
            checkpoint.messageId
        );

        address recovered = checkpointStorage.writeCheckpoint(
            checkpoint,
            signature
        );
        assertEq(recovered, validator1);

        (uint32 latestIdx, bool exists) = checkpointStorage.getLatestIndex(
            validator1
        );
        assertTrue(exists);
        assertEq(latestIdx, 10);

        assertTrue(checkpointStorage.hasCheckpoint(validator1, 10));
        assertFalse(checkpointStorage.hasCheckpoint(validator1, 11));

        (
            Checkpoint memory storedCheckpoint,
            bytes memory storedSig
        ) = checkpointStorage.getCheckpoint(validator1, 10);
        assertEq(storedCheckpoint.origin, checkpoint.origin);
        assertEq(storedCheckpoint.merkleTree, checkpoint.merkleTree);
        assertEq(storedCheckpoint.root, checkpoint.root);
        assertEq(storedCheckpoint.index, checkpoint.index);
        assertEq(storedCheckpoint.messageId, checkpoint.messageId);
        assertEq(storedSig, signature);
    }

    function testWriteSignedCheckpointStruct() public {
        Checkpoint memory checkpoint = Checkpoint({
            origin: 1,
            merkleTree: address(0xABC).addressToBytes32(),
            root: keccak256("root-1"),
            index: 1,
            messageId: keccak256("message-1")
        });

        bytes memory signature = signCheckpoint(validatorKey1, checkpoint);
        SignedCheckpoint memory signedCheckpoint = SignedCheckpoint({
            checkpoint: checkpoint,
            signature: signature
        });

        address recovered = checkpointStorage.writeCheckpoint(signedCheckpoint);
        assertEq(recovered, validator1);
        assertTrue(checkpointStorage.hasCheckpoint(validator1, 1));
    }

    function testMonotonicLatestIndex() public {
        Checkpoint memory checkpoint1 = Checkpoint({
            origin: 1,
            merkleTree: address(0xABC).addressToBytes32(),
            root: keccak256("root-20"),
            index: 20,
            messageId: keccak256("message-20")
        });
        bytes memory sig1 = signCheckpoint(validatorKey1, checkpoint1);
        checkpointStorage.writeCheckpoint(checkpoint1, sig1);

        (uint32 latestAfterFirst, ) = checkpointStorage.getLatestIndex(
            validator1
        );
        assertEq(latestAfterFirst, 20);

        Checkpoint memory checkpoint2 = Checkpoint({
            origin: 1,
            merkleTree: address(0xABC).addressToBytes32(),
            root: keccak256("root-5"),
            index: 5,
            messageId: keccak256("message-5")
        });
        bytes memory sig2 = signCheckpoint(validatorKey1, checkpoint2);
        checkpointStorage.writeCheckpoint(checkpoint2, sig2);

        (uint32 latestAfterSecond, ) = checkpointStorage.getLatestIndex(
            validator1
        );
        assertEq(latestAfterSecond, 20);
        assertTrue(checkpointStorage.hasCheckpoint(validator1, 5));
        assertTrue(checkpointStorage.hasCheckpoint(validator1, 20));
    }

    function testPerValidatorLatestIndex() public {
        Checkpoint memory checkpoint1 = Checkpoint({
            origin: 1,
            merkleTree: address(0xABC).addressToBytes32(),
            root: keccak256("root-val1"),
            index: 50,
            messageId: keccak256("message-val1")
        });
        bytes memory sig1 = signCheckpoint(validatorKey1, checkpoint1);
        checkpointStorage.writeCheckpoint(checkpoint1, sig1);

        Checkpoint memory checkpoint2 = Checkpoint({
            origin: 1,
            merkleTree: address(0xABC).addressToBytes32(),
            root: keccak256("root-val2"),
            index: 12,
            messageId: keccak256("message-val2")
        });
        bytes memory sig2 = signCheckpoint(validatorKey2, checkpoint2);
        checkpointStorage.writeCheckpoint(checkpoint2, sig2);

        (uint32 val1Latest, bool val1Exists) = checkpointStorage.getLatestIndex(
            validator1
        );
        (uint32 val2Latest, bool val2Exists) = checkpointStorage.getLatestIndex(
            validator2
        );

        assertTrue(val1Exists);
        assertEq(val1Latest, 50);

        assertTrue(val2Exists);
        assertEq(val2Latest, 12);
    }

    function testRevertSignatureLength() public {
        Checkpoint memory checkpoint = Checkpoint({
            origin: 1,
            merkleTree: address(0xABC).addressToBytes32(),
            root: keccak256("root"),
            index: 1,
            messageId: keccak256("message")
        });

        bytes memory invalidSig = hex"123456";
        vm.expectRevert("!siglen");
        checkpointStorage.writeCheckpoint(checkpoint, invalidSig);
    }

    function testMetadataAndReorgStatus() public {
        string memory metadata = "https://validator.example.com";
        vm.prank(validator1);
        checkpointStorage.writeMetadata(metadata);
        assertEq(checkpointStorage.getMetadata(validator1), metadata);

        bytes memory reorgData = hex"cafebabe";
        vm.prank(validator1);
        checkpointStorage.writeReorgStatus(reorgData);
        assertEq(checkpointStorage.getReorgStatus(validator1), reorgData);
    }

    function testUpdateLatestIndex() public {
        vm.prank(validator1);
        checkpointStorage.updateLatestIndex(100);
        (uint32 latest, bool exists) = checkpointStorage.getLatestIndex(
            validator1
        );
        assertTrue(exists);
        assertEq(latest, 100);

        vm.prank(validator1);
        checkpointStorage.updateLatestIndex(50);
        (uint32 latestAfterLower, ) = checkpointStorage.getLatestIndex(
            validator1
        );
        assertEq(latestAfterLower, 100);
    }
}
