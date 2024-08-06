// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import "../contracts/libs/TypeCasts.sol";
import "../contracts/test/TestMailbox.sol";
import "../contracts/CheckpointFraudProofs.sol";
import "../contracts/test/TestMerkleTreeHook.sol";
import "../contracts/test/TestPostDispatchHook.sol";

contract CheckpointFraudProofsTest is Test {
    using TypeCasts for address;

    uint32 localDomain = 1000;
    uint32 remoteDomain = 2000;
    uint256 msgCount = 65;

    TestMerkleTreeHook merkleTreeHook;
    TestPostDispatchHook postDispatchHook;
    Checkpoint latestCheckpoint;
    CheckpointFraudProofs cfp;

    function setUp() public {
        TestMailbox mailbox = new TestMailbox(localDomain);

        postDispatchHook = new TestPostDispatchHook();
        mailbox.setRequiredHook(address(postDispatchHook));

        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        mailbox.setDefaultHook(address(merkleTreeHook));
        bytes32 merkleBytes = address(merkleTreeHook).addressToBytes32();

        bytes memory msgBody = bytes("0xc0ffee");

        for (uint256 i = 0; i < msgCount; i++) {
            bytes32 messageId = mailbox.dispatch(
                remoteDomain,
                bytes32(0),
                msgBody
            );
            (bytes32 root, uint32 index) = merkleTreeHook.latestCheckpoint();
            latestCheckpoint = Checkpoint(
                localDomain,
                merkleBytes,
                root,
                index,
                messageId
            );
        }

        cfp = new CheckpointFraudProofs();
    }

    function test_isLocal() public {
        assertTrue(cfp.isLocal(latestCheckpoint));
        Checkpoint memory checkpoint = latestCheckpoint;
        checkpoint.origin = remoteDomain;
        assertFalse(cfp.isLocal(checkpoint));
    }

    function test_isPremature() public {
        assertFalse(cfp.isPremature(latestCheckpoint));
        Checkpoint memory checkpoint = latestCheckpoint;
        checkpoint.index += 1;
        assertTrue(cfp.isPremature(checkpoint));
    }

    function test_RevertWhenNotLocal_isPremature() public {
        Checkpoint memory checkpoint = latestCheckpoint;
        checkpoint.origin = remoteDomain;
        vm.expectRevert("must be local checkpoint");
        cfp.isPremature(checkpoint);
    }

    function test_isFraudulentMessageId() public {
        bytes32[32] memory proof = merkleTreeHook.proof();
        cfp.storeLatestCheckpoint(address(merkleTreeHook));
        assertFalse(
            cfp.isFraudulentMessageId(
                latestCheckpoint,
                proof,
                latestCheckpoint.messageId
            )
        );

        Checkpoint memory checkpoint = latestCheckpoint;
        bytes32 actualMessageId = checkpoint.messageId;
        checkpoint.messageId = ~checkpoint.messageId;
        assertTrue(
            cfp.isFraudulentMessageId(checkpoint, proof, actualMessageId)
        );
    }

    function test_RevertWhenNotStored_isFraudulentMessageId() public {
        bytes32[32] memory proof = merkleTreeHook.proof();
        vm.expectRevert("message must be member of stored checkpoint");
        cfp.isFraudulentMessageId(
            latestCheckpoint,
            proof,
            latestCheckpoint.messageId
        );
    }

    function test_RevertWhenNotLocal_isFraudulentMessageId() public {
        bytes32[32] memory proof = merkleTreeHook.proof();
        Checkpoint memory checkpoint = latestCheckpoint;
        checkpoint.origin = remoteDomain;
        vm.expectRevert("must be local checkpoint");
        cfp.isFraudulentMessageId(
            checkpoint,
            proof,
            latestCheckpoint.messageId
        );
    }

    function test_IsFraudulentRoot() public {
        bytes32[32] memory proof = merkleTreeHook.proof();

        cfp.storeLatestCheckpoint(address(merkleTreeHook));
        assertFalse(cfp.isFraudulentRoot(latestCheckpoint, proof));

        Checkpoint memory checkpoint = latestCheckpoint;
        checkpoint.root = ~checkpoint.root;
        assertTrue(cfp.isFraudulentRoot(checkpoint, proof));
    }

    function test_RevertWhenNotStored_isFraudulentRoot() public {
        bytes32[32] memory proof = merkleTreeHook.proof();
        vm.expectRevert("message must be member of stored checkpoint");
        cfp.isFraudulentRoot(latestCheckpoint, proof);
    }

    function test_RevertWhenNotLocal_isFraudulentRoot() public {
        bytes32[32] memory proof = merkleTreeHook.proof();
        Checkpoint memory checkpoint = latestCheckpoint;
        checkpoint.origin = remoteDomain;
        vm.expectRevert("must be local checkpoint");
        cfp.isFraudulentRoot(checkpoint, proof);
    }
}
