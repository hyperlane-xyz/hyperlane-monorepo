// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {AbstractMessageIdAuthHook} from "../../contracts/hooks/libs/AbstractMessageIdAuthHook.sol";

abstract contract ExternalBridgeTest is Test {
    using TypeCasts for address;
    using MessageUtils for bytes;

    uint8 internal constant HYPERLANE_VERSION = 1;
    uint32 internal ORIGIN_DOMAIN;
    uint32 internal DESTINATION_DOMAIN;
    uint256 internal GAS_QUOTE;
    bytes internal unauthorizedHookError;
    TestMailbox internal originMailbox;
    TestMailbox internal destinationMailbox;
    TestRecipient internal testRecipient;

    AbstractMessageIdAuthHook internal hook;
    AbstractMessageIdAuthorizedIsm internal ism;

    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal testMetadata =
        StandardHookMetadata.overrideRefundAddress(address(this));
    bytes internal encodedMessage;
    bytes32 internal messageId;

    function setUp() public virtual {
        testRecipient = new TestRecipient();
        encodedMessage = _encodeTestMessage();
        messageId = Message.id(encodedMessage);
    }

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                HYPERLANE_VERSION,
                uint32(0),
                ORIGIN_DOMAIN,
                TypeCasts.addressToBytes32(address(this)),
                DESTINATION_DOMAIN,
                TypeCasts.addressToBytes32(address(testRecipient)),
                testMessage
            );
    }

    function _encodeHookData(
        bytes32 _messageId
    ) internal pure returns (bytes memory) {
        return
            abi.encodeCall(
                AbstractMessageIdAuthorizedIsm.verifyMessageId,
                (_messageId)
            );
    }

    function test_postDispatch_revertWhen_chainIDNotSupported() public {
        bytes memory message = MessageUtils.formatMessage(
            0,
            uint32(0),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            2, // wrong domain
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );

        originMailbox.updateLatestDispatchedId(Message.id(message));
        vm.expectRevert(
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        hook.postDispatch(testMetadata, message);
    }

    function test_postDispatch_revertWhen_notLastDispatchedMessage() public {
        vm.expectRevert(
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );
        hook.postDispatch(testMetadata, encodedMessage);
    }

    function test_postDispatch() public {
        bytes memory encodedHookData = _encodeHookData(messageId);
        originMailbox.updateLatestDispatchedId(messageId);
        _expectOriginExternalBridgeCall(encodedHookData);

        hook.postDispatch{value: GAS_QUOTE}(testMetadata, encodedMessage);
    }

    function test_verifyMessageId_asyncCall() public {
        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );
        _externalBridgeDestinationCall(encodedHookData, 0);

        assertTrue(ism.isVerified(encodedMessage));
    }

    function test_verifyMessageId_externalBridgeCall() public {
        bytes memory externalCalldata = _encodeExternalDestinationBridgeCall(
            address(hook),
            address(ism),
            0,
            messageId
        );

        ism.verify(externalCalldata, encodedMessage);
        assertTrue(ism.isVerified(encodedMessage));
    }

    function test_verify_revertWhen_invalidMetadata() public {
        vm.expectRevert();
        ism.verify(new bytes(0), encodedMessage);
    }

    function test_verify_msgValue_asyncCall() public {
        bytes memory encodedHookData = _encodeHookData(messageId);
        _externalBridgeDestinationCall(encodedHookData, 1 ether);

        assertTrue(ism.verify(new bytes(0), encodedMessage));
        assertEq(address(testRecipient).balance, 1 ether);
    }

    function test_verify_msgValue_externalBridgeCall() public {
        bytes memory externalCalldata = _encodeExternalDestinationBridgeCall(
            address(hook),
            address(ism),
            1 ether,
            messageId
        );

        ism.verify(externalCalldata, encodedMessage);
        assertEq(address(testRecipient).balance, 1 ether);
    }

    function test_verify_revertsWhen_invalidIsm() public {
        bytes memory externalCalldata = _encodeExternalDestinationBridgeCall(
            address(hook),
            address(this),
            0,
            messageId
        );

        vm.expectRevert();
        ism.verify(externalCalldata, encodedMessage);
    }

    function test_verify_revertsWhen_notAuthorizedHook() public {
        bytes memory externalCalldata = _encodeExternalDestinationBridgeCall(
            address(this),
            address(ism),
            1 ether,
            messageId
        );

        _setExternalOriginSender(address(this));

        vm.expectRevert(unauthorizedHookError);
        assertFalse(ism.verify(externalCalldata, encodedMessage));

        vm.expectRevert(); // evmRevert
        _externalBridgeDestinationCall(externalCalldata, 0);
        assertEq(ism.isVerified(encodedMessage), false);
    }

    function _expectOriginExternalBridgeCall(
        bytes memory _encodedHookData
    ) internal virtual;

    function _externalBridgeDestinationCall(
        bytes memory _encodedHookData,
        uint256 _msgValue
    ) internal virtual;

    function _encodeExternalDestinationBridgeCall(
        address _from,
        address _to,
        uint256 _msgValue,
        bytes32 _messageId
    ) internal virtual returns (bytes memory);

    function _setExternalOriginSender(address _sender) internal virtual {}
}
