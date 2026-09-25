// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {OPL2ToL1Hook} from "../../contracts/hooks/OPL2ToL1Hook.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {ICrossDomainMessenger} from "../../contracts/interfaces/optimism/ICrossDomainMessenger.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockOptimismMessenger} from "../../contracts/mock/MockOptimism.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

contract OPL2ToL1HookTest is Test {
    using TypeCasts for address;

    uint32 internal constant ORIGIN_DOMAIN = 10;
    uint32 internal constant DESTINATION_DOMAIN = 1;
    uint256 internal constant MSG_VALUE = 1 ether;

    TestMailbox internal mailbox;
    MockOptimismMessenger internal messenger;
    TestPostDispatchHook internal childHook;
    OPL2ToL1Hook internal hook;
    bytes internal message;
    bool internal reenterOnRefund;
    bool internal replayBlocked;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN_DOMAIN);
        messenger = new MockOptimismMessenger();
        childHook = new TestPostDispatchHook();
        hook = new OPL2ToL1Hook(
            address(mailbox),
            DESTINATION_DOMAIN,
            address(0xBEEF).addressToBytes32(),
            address(messenger),
            address(childHook)
        );
        message = mailbox.buildOutboundMessage(
            DESTINATION_DOMAIN,
            address(new TestRecipient()).addressToBytes32(),
            "test"
        );
    }

    function test_postDispatch_revertWhen_valueMessageReplayedWithoutValue()
        public
    {
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            MSG_VALUE,
            0,
            address(this),
            ""
        );
        bytes32 messageId = Message.id(message);
        bytes memory payload = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (messageId, MSG_VALUE)
        );
        mailbox.updateLatestDispatchedId(messageId);
        vm.deal(address(this), MSG_VALUE);
        vm.expectCall(
            address(messenger),
            MSG_VALUE,
            abi.encodeCall(
                ICrossDomainMessenger.sendMessage,
                (address(0xBEEF), payload, hook.MIN_GAS_LIMIT())
            )
        );

        hook.postDispatch{value: MSG_VALUE}(metadata, message);

        assertTrue(childHook.messageDispatched(messageId));
        assertEq(address(messenger).balance, MSG_VALUE);

        vm.expectRevert("AbstractMessageIdAuthHook: message already processed");
        hook.postDispatch("", message);
        assertEq(address(messenger).balance, MSG_VALUE);
    }

    function test_postDispatch_allowsNextMessage() public {
        bytes32 messageId = Message.id(message);
        mailbox.updateLatestDispatchedId(messageId);
        hook.postDispatch("", message);

        bytes memory nextMessage = mailbox.buildOutboundMessage(
            DESTINATION_DOMAIN,
            address(new TestRecipient()).addressToBytes32(),
            "next message"
        );
        bytes32 nextMessageId = Message.id(nextMessage);
        mailbox.updateLatestDispatchedId(nextMessageId);
        hook.postDispatch("", nextMessage);

        assertTrue(childHook.messageDispatched(messageId));
        assertTrue(childHook.messageDispatched(nextMessageId));
    }

    function test_postDispatch_blocksReentrantReplayFromRefund() public {
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            MSG_VALUE,
            0,
            address(this),
            ""
        );
        bytes32 messageId = Message.id(message);
        mailbox.updateLatestDispatchedId(messageId);
        vm.deal(address(this), MSG_VALUE + 1);
        reenterOnRefund = true;

        hook.postDispatch{value: MSG_VALUE + 1}(metadata, message);

        assertTrue(replayBlocked);
        assertEq(address(messenger).balance, MSG_VALUE);
    }

    function test_postDispatch_allowsRetryAfterBridgeRevert() public {
        bytes memory callData = abi.encodeWithSelector(
            ICrossDomainMessenger.sendMessage.selector
        );
        mailbox.updateLatestDispatchedId(Message.id(message));
        vm.mockCallRevert(address(messenger), callData, "bridge unavailable");

        vm.expectRevert("bridge unavailable");
        hook.postDispatch("", message);

        vm.clearMockedCalls();
        hook.postDispatch("", message);
    }

    receive() external payable {
        if (!reenterOnRefund) return;
        reenterOnRefund = false;

        try hook.postDispatch("", message) {
            revert("replay succeeded");
        } catch Error(string memory reason) {
            assertEq(
                reason,
                "AbstractMessageIdAuthHook: message already processed"
            );
            replayBlocked = true;
        }
    }
}
