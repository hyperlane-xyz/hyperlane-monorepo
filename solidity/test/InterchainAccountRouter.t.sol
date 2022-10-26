// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockOutbox.sol";
import "../contracts/mock/MockInbox.sol";
import "../contracts/AbacusConnectionManager.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import "../contracts/test/TestRecipient.sol";
import "../contracts/middleware/InterchainAccountRouter.sol";
import {OwnableMulticall, Call} from "../contracts/OwnableMulticall.sol";

contract InterchainAccountRouterTest is Test {
    MockOutbox outbox;
    MockInbox inbox;

    uint32 originDomain = 1;
    uint32 remoteDomain = 2;

    InterchainAccountRouter originRouter;
    InterchainAccountRouter remoteRouter;

    AbacusConnectionManager originManager;
    AbacusConnectionManager remoteManager;

    TestRecipient recipient;

    function setUp() public {
        inbox = new MockInbox();
        outbox = new MockOutbox(originDomain, address(inbox));

        originManager = new AbacusConnectionManager();
        remoteManager = new AbacusConnectionManager();

        originManager.setOutbox(address(outbox));
        remoteManager.enrollInbox(remoteDomain, address(inbox));

        recipient = new TestRecipient();

        originRouter = new InterchainAccountRouter();
        remoteRouter = new InterchainAccountRouter();

        originRouter.initialize(
            address(this),
            address(originManager),
            address(0)
        );
        remoteRouter.initialize(
            address(this),
            address(remoteManager),
            address(0)
        );

        originRouter.enrollRemoteRouter(
            remoteDomain,
            TypeCasts.addressToBytes32(address(remoteRouter))
        );
        remoteRouter.enrollRemoteRouter(
            originDomain,
            TypeCasts.addressToBytes32(address(originRouter))
        );
    }

    function testCall() public {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: address(recipient),
            data: abi.encodeCall(recipient.fooBar, (1, "Test"))
        });
        originRouter.dispatch(remoteDomain, calls);
        inbox.processNextPendingMessage();
        assertEq(recipient.lastCallMessage(), "Test");
    }
}
