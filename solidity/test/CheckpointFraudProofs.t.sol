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
            mailbox.dispatch(2000, bytes32(0), msgBody);
        }

        cfp = new CheckpointFraudProofs();
    }

    function testIsPremature() public {
        (bytes32 root, uint32 index) = mailbox.latestCheckpoint();

        Checkpoint memory checkpoint = Checkpoint(
            localDomain,
            mailboxBytes,
            root,
            index,
            bytes32(0)
        );
        assertFalse(cfp.isPremature(checkpoint));
        checkpoint.index += 1;
        assertTrue(cfp.isPremature(checkpoint));
    }
}
