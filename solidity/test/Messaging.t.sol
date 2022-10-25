// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockOutbox.sol";
import "../contracts/mock/MockInbox.sol";
import "../contracts/test/TestRecipient.sol";
import "../interfaces/IInbox.sol";
import "../interfaces/IOutbox.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract MessagingTest is Test {
    MockOutbox outbox;
    MockInbox inbox;

    TestRecipient receiver;

    uint32 originDomain = 1;
    uint32 remoteDomain = 2;

    function setUp() public {
        inbox = new MockInbox();
        outbox = new MockOutbox(originDomain, address(inbox));

        receiver = new TestRecipient();
    }

    function testSendMessage(string calldata _message) public {
        outbox.dispatch(
            remoteDomain,
            TypeCasts.addressToBytes32(address(receiver)),
            bytes(_message)
        );
        inbox.processNextPendingMessage();
        assertEq(string(receiver.lastData()), _message);
    }
}
