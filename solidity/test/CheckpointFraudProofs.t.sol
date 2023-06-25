// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import "../contracts/test/TestMailbox.sol";
import "../contracts/CheckpointFraudProofs.sol";

contract CheckpointFraudProofsTest is Test {
    uint32 localDomain = 1000;
    uint256 msgCount = 65;

    TestMailbox mailbox;
    bytes32 mailboxBytes;
    Checkpoint latestCheckpoint;
    CheckpointFraudProofs cfp;

    function setUp() public {
        mailbox = new TestMailbox(localDomain);
        mailboxBytes = TypeCasts.addressToBytes32(address(mailbox));

        bytes memory msgBody = new bytes(5);
        msgBody[0] = 0xaa;
        msgBody[1] = 0xbb;
        msgBody[2] = 0xcc;
        msgBody[3] = 0xdd;
        msgBody[4] = 0xee;

        for (uint256 i = 0; i < msgCount; i++) {
            bytes32 messageId = mailbox.dispatch(2000, bytes32(0), msgBody);
            (bytes32 root, uint32 index) = mailbox.latestCheckpoint();
            latestCheckpoint = Checkpoint(
                localDomain,
                mailboxBytes,
                root,
                index,
                messageId
            );
        }

        cfp = new CheckpointFraudProofs();
    }

    function testIsPremature() public {
        Checkpoint memory checkpoint = latestCheckpoint;
        assertFalse(cfp.isPremature(checkpoint));
        checkpoint.index += 1;
        assertTrue(cfp.isPremature(checkpoint));
    }

    function testIsFraudulentMessageId() public {
        Checkpoint memory checkpoint = latestCheckpoint;

        bytes32[32] memory proof = mailbox.proof();

        vm.expectRevert("must prove against cached checkpoint");
        cfp.isFraudulentMessageId(checkpoint, proof, checkpoint.messageId);

        cfp.cacheCheckpoint(address(mailbox));
        assertFalse(
            cfp.isFraudulentMessageId(
                checkpoint,
                mailbox.proof(),
                checkpoint.messageId
            )
        );

        bytes32 actualMessageId = checkpoint.messageId;
        checkpoint.messageId = ~checkpoint.messageId;
        assertTrue(
            cfp.isFraudulentMessageId(
                checkpoint,
                mailbox.proof(),
                actualMessageId
            )
        );
    }
}
