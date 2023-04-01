// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockMailbox.sol";
import "../contracts/mock/MockMailbox.sol";
import "../contracts/test/TestRecipient.sol";
import "../contracts/interfaces/IMailbox.sol";
import "../contracts/interfaces/IMailbox.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract MessagingTest is Test {
    MockMailbox originMailbox;
    MockMailbox remoteMailbox;

    TestRecipient receiver;

    uint32 originDomain = 1;
    uint32 remoteDomain = 2;

    function setUp() public {
        originMailbox = new MockMailbox(originDomain);
        remoteMailbox = new MockMailbox(remoteDomain);
        originMailbox.addRemoteMailbox(remoteDomain, remoteMailbox);

        receiver = new TestRecipient();
    }

    function testSendMessage(string calldata _message) public {
        originMailbox.dispatch(
            remoteDomain,
            TypeCasts.addressToBytes32(address(receiver)),
            bytes(_message)
        );
        remoteMailbox.processNextInboundMessage();
        assertEq(string(receiver.lastData()), _message);
    }
}
