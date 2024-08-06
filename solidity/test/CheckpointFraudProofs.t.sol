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

    TestMailbox mailbox;
    TestMerkleTreeHook merkleTreeHook;

    bytes32[] leaves = [
        bytes32(abi.encode("0xc0ffee")),
        bytes32(abi.encode("0xdeadbeef")),
        bytes32(abi.encode("0xfeedface"))
    ];

    Checkpoint latestCheckpoint;
    CheckpointFraudProofs cfp;

    function setUp() public {
        mailbox = new TestMailbox(localDomain);
        cfp = new CheckpointFraudProofs();

        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        bytes32 merkleBytes = address(merkleTreeHook).addressToBytes32();

        for (uint256 i = 0; i < leaves.length; i++) {
            bytes32 leaf = leaves[i];
            merkleTreeHook.insert(leaf);
            (bytes32 root, uint32 index) = merkleTreeHook.latestCheckpoint();
            latestCheckpoint = Checkpoint(
                localDomain,
                merkleBytes,
                root,
                index,
                leaf
            );
        }
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
