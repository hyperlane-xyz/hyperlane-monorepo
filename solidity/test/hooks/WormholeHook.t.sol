// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {WormholeHook} from "../../contracts/hooks/WormholeHook.sol";
import {IWormhole} from "../../contracts/interfaces/IWormhole.sol";
import {MockWormhole} from "./MockWormhole.sol";

contract WormholeHookTest is Test {
    using TypeCasts for address;
    using MessageUtils for bytes;

    uint32 internal constant ORIGIN_DOMAIN = 1;
    uint32 internal constant DESTINATION_DOMAIN = 2;
    uint8 internal constant CONSISTENCY_LEVEL = 200;
    uint256 internal constant MESSAGE_FEE = 0.01 ether;

    TestMailbox internal mailbox;
    TestRecipient internal recipient;
    MockWormhole internal wormhole;
    WormholeHook internal hook;
    bytes32 internal ism = address(0xbeef).addressToBytes32();

    bytes internal encodedMessage;
    bytes32 internal messageId;
    bytes internal metadata;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN_DOMAIN);
        recipient = new TestRecipient();
        wormhole = new MockWormhole(MESSAGE_FEE, uint16(0));
        hook = new WormholeHook(
            address(wormhole),
            CONSISTENCY_LEVEL,
            address(mailbox),
            DESTINATION_DOMAIN,
            ism
        );

        encodedMessage = _encodeMessage();
        messageId = Message.id(encodedMessage);
        metadata = StandardHookMetadata.formatMetadata(0, 0, address(this), "");
    }

    receive() external payable {}

    function test_constructor_revertsWhen_zeroWormhole() public {
        vm.expectRevert("WormholeHook: invalid wormhole");
        new WormholeHook(
            address(0),
            CONSISTENCY_LEVEL,
            address(mailbox),
            DESTINATION_DOMAIN,
            ism
        );
    }

    function test_immutables() public view {
        assertEq(address(hook.wormhole()), address(wormhole));
        assertEq(hook.consistencyLevel(), CONSISTENCY_LEVEL);
        assertEq(hook.destinationDomain(), DESTINATION_DOMAIN);
        assertEq(hook.ism(), ism);
    }

    function test_quoteDispatch_returnsMessageFee() public view {
        assertEq(hook.quoteDispatch(metadata, encodedMessage), MESSAGE_FEE);
    }

    function test_postDispatch_publishesMessageId() public {
        mailbox.updateLatestDispatchedId(messageId);

        hook.postDispatch{value: MESSAGE_FEE}(metadata, encodedMessage);

        assertEq(wormhole.lastNonce(), 0);
        assertEq(wormhole.lastConsistencyLevel(), CONSISTENCY_LEVEL);
        assertEq(wormhole.lastValue(), MESSAGE_FEE);
        // payload is abi.encode(messageId)
        assertEq(
            abi.decode(wormhole.lastPayload(), (bytes32)),
            messageId,
            "payload must be the hyperlane message id"
        );
    }

    function test_postDispatch_refundsExcess() public {
        mailbox.updateLatestDispatchedId(messageId);

        uint256 balanceBefore = address(this).balance;
        uint256 sent = MESSAGE_FEE + 1 ether;
        hook.postDispatch{value: sent}(metadata, encodedMessage);

        // only the message fee is consumed; the rest is refunded
        assertEq(address(this).balance, balanceBefore - MESSAGE_FEE);
        assertEq(address(hook).balance, 0);
    }

    function test_postDispatch_revertsWhen_notLatestDispatched() public {
        vm.expectRevert(
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );
        hook.postDispatch{value: MESSAGE_FEE}(metadata, encodedMessage);
    }

    function test_postDispatch_revertsWhen_wrongDestination() public {
        bytes memory wrongDest = MessageUtils.formatMessage(
            1,
            0,
            ORIGIN_DOMAIN,
            address(this).addressToBytes32(),
            DESTINATION_DOMAIN + 1,
            address(recipient).addressToBytes32(),
            "body"
        );
        mailbox.updateLatestDispatchedId(Message.id(wrongDest));

        vm.expectRevert(
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        hook.postDispatch{value: MESSAGE_FEE}(metadata, wrongDest);
    }

    function _encodeMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                1,
                0,
                ORIGIN_DOMAIN,
                address(this).addressToBytes32(),
                DESTINATION_DOMAIN,
                address(recipient).addressToBytes32(),
                "body"
            );
    }
}
