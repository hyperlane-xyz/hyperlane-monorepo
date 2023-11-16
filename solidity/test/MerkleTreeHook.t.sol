// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test, console} from "forge-std/Test.sol";

import {Message} from "../contracts/libs/Message.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {TestMerkleTreeHook} from "../contracts/test/TestMerkleTreeHook.sol";
import {TestMailbox} from "../contracts/test/TestMailbox.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract MerkleTreeHookTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    TestMailbox internal mailbox;
    TestMerkleTreeHook internal hook;

    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 22;
    address internal constant RECIPIENT = address(0xdeadbeef);
    uint256 internal MSG_COUNT = 3;
    bytes[3] internal testMessage;
    bytes32[3] internal expectedRoots = [
        bytes32(
            0x10df2f89cb24ed6078fc3949b4870e94a7e32e40e8d8c6b7bd74ccc2c933d760
        ),
        bytes32(
            0x080ef1c2cd394de78363ecb0a466c934b57de4abb5604a0684e571990eb7b073
        ),
        bytes32(
            0xbf78ad252da524f1e733aa6b83514dd83225676b5828f888f01487108f8f7cc7
        )
    ];

    event InsertedIntoTree(bytes32 messageId, uint32 index);

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN);
        hook = new TestMerkleTreeHook(address(mailbox));

        for (uint256 i = 0; i < MSG_COUNT; i++) {
            testMessage[i] = mailbox.buildOutboundMessage(
                DESTINATION,
                RECIPIENT.addressToBytes32(),
                abi.encodePacked(i)
            );
        }
    }

    function testPostDispatch_emit() public {
        for (uint32 i = 0; i < MSG_COUNT; i++) {
            bytes memory currMessage = testMessage[i];
            mailbox.updateLatestDispatchedId(currMessage.id());

            vm.expectEmit(false, false, false, true);
            emit InsertedIntoTree(currMessage.id(), i);
            hook.postDispatch("", currMessage);

            assertEq(hook.count(), i + 1);
            assertEq(hook.root(), expectedRoots[i]);
        }
    }

    function testQuoteDispatch() public {
        for (uint256 i = 0; i < MSG_COUNT; i++) {
            bytes memory currMessage = testMessage[i];

            assertEq(hook.quoteDispatch("", currMessage), 0);
        }
    }

    function testHookType() public {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.MERKLE_TREE));
    }
}
