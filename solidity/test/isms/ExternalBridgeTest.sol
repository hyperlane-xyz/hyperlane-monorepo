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
    uint32 internal constant ORIGIN_DOMAIN = 1;
    uint32 internal constant DESTINATION_DOMAIN = 2;
    uint256 internal constant MSG_VALUE = 1 ether;
    uint256 internal constant MAX_MSG_VALUE = 2 ** 255 - 1;
    uint256 internal GAS_QUOTE;

    TestMailbox internal originMailbox;
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

    /* ============ hook.quoteDispatch ============ */

    function test_quoteDispatch() public view {
        assertEq(hook.quoteDispatch(testMetadata, encodedMessage), GAS_QUOTE);
    }

    /* ============ Hook.postDispatch ============ */

    function test_postDispatch() public {
        bytes memory hookMetadata = testMetadata;
        bytes memory encodedHookData = _encodeHookData(messageId, 0);
        originMailbox.updateLatestDispatchedId(messageId);
        _expectOriginExternalBridgeCall(encodedHookData);

        uint256 quote = hook.quoteDispatch(testMetadata, encodedMessage);
        hook.postDispatch{value: quote}(testMetadata, encodedMessage);
    }

    function test_postDispatch_revertWhen_chainIDNotSupported() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            3,
            TypeCasts.addressToBytes32(address(this)),
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

    function test_postDispatch_revertWhen_tooMuchValue() public {
        vm.deal(address(this), uint256(MAX_MSG_VALUE + 1));
        bytes memory excessValueMetadata = StandardHookMetadata
            .overrideMsgValue(uint256(2 ** 255 + 1));

        originMailbox.updateLatestDispatchedId(messageId);
        vm.expectRevert(
            "AbstractMessageIdAuthHook: msgValue must be less than 2 ** 255"
        );
        hook.postDispatch(excessValueMetadata, encodedMessage);
    }

    function testFuzz_postDispatch_refundsExtraValue(
        uint256 extraValue
    ) public virtual {
        vm.assume(extraValue < MAX_MSG_VALUE);
        vm.deal(address(this), address(this).balance + extraValue);
        uint256 valueBefore = address(this).balance;

        bytes memory encodedHookData = _encodeHookData(messageId, 0);
        originMailbox.updateLatestDispatchedId(messageId);
        _expectOriginExternalBridgeCall(encodedHookData);

        uint256 quote = hook.quoteDispatch(testMetadata, encodedMessage);
        hook.postDispatch{value: quote + extraValue}(
            testMetadata,
            encodedMessage
        );

        assertEq(address(this).balance, valueBefore - quote);
    }

    function test_postDispatch_revertWhen_insufficientValue() public {
        originMailbox.updateLatestDispatchedId(messageId);

        uint256 quote = hook.quoteDispatch(testMetadata, encodedMessage);

        if (quote > 0) {
            vm.expectRevert();
            hook.postDispatch{value: quote - 1}(testMetadata, encodedMessage);
        }
    }

    /* ============ ISM.preVerifyMessage ============ */

    function test_preVerifyMessage_asyncCall() public {
        bytes memory encodedHookData = _encodeHookData(messageId, 0);
        _externalBridgeDestinationCall(encodedHookData, 0);

        assertTrue(ism.isVerified(encodedMessage));
    }

    function test_preVerifyMessage_externalBridgeCall() public virtual {
        bytes memory externalCalldata = _encodeExternalDestinationBridgeCall(
            address(hook),
            address(ism),
            0,
            messageId
        );

        assertTrue(ism.verify(externalCalldata, encodedMessage));
        assertTrue(ism.isVerified(encodedMessage));
    }

    /* ============ ISM.verify ============ */

    function test_verify_revertWhen_invalidMetadata() public virtual {
        vm.expectRevert();
        assertFalse(ism.verify(new bytes(0), encodedMessage));
    }

    function test_verify_msgValue_asyncCall() public virtual {
        bytes memory encodedHookData = _encodeHookData(messageId, MSG_VALUE);
        _externalBridgeDestinationCall(encodedHookData, MSG_VALUE);

        assertTrue(ism.verify(new bytes(0), encodedMessage));
        assertEq(address(testRecipient).balance, MSG_VALUE);
    }

    function test_verify_msgValue_externalBridgeCall() public virtual {
        bytes memory externalCalldata = _encodeExternalDestinationBridgeCall(
            address(hook),
            address(ism),
            MSG_VALUE,
            messageId
        );
        assertTrue(ism.verify(externalCalldata, encodedMessage));
        assertEq(address(testRecipient).balance, 1 ether);
    }

    function test_verify_revertsWhen_invalidIsm() public virtual {
        bytes memory externalCalldata = _encodeExternalDestinationBridgeCall(
            address(hook),
            address(hook),
            0,
            messageId
        );

        vm.expectRevert();
        assertFalse(ism.verify(externalCalldata, encodedMessage));
    }

    function test_verify_revertsWhen_notAuthorizedHook() public virtual {
        bytes memory unauthorizedHookErrorMsg = _setExternalOriginSender(
            address(this)
        );

        bytes memory externalCalldata = _encodeExternalDestinationBridgeCall(
            address(this),
            address(ism),
            0,
            messageId
        );

        // external call
        vm.expectRevert(unauthorizedHookErrorMsg);
        assertFalse(ism.verify(externalCalldata, encodedMessage));

        // async call vm.expectRevert(NotCrossChainCall.selector);
        vm.expectRevert();
        _externalBridgeDestinationCall(externalCalldata, 0);
        assertFalse(ism.isVerified(encodedMessage));
    }

    function test_verify_revertsWhen_incorrectMessageId() public virtual {
        bytes32 incorrectMessageId = keccak256("incorrect message id");
        bytes memory externalCalldata = _encodeExternalDestinationBridgeCall(
            address(hook),
            address(ism),
            0,
            incorrectMessageId
        );

        // external call
        vm.expectRevert();
        assertFalse(ism.verify(externalCalldata, encodedMessage));

        // async call - native bridges might have try catch block to prevent revert
        try
            this.externalBridgeDestinationCallWrapper(
                _encodeHookData(incorrectMessageId, 0),
                0
            )
        {} catch {}
        assertFalse(ism.isVerified(testMessage));
    }

    /// forge-config: default.fuzz.runs = 10
    function test_verify_valueAlreadyClaimed(uint256 _msgValue) public virtual {
        _msgValue = bound(_msgValue, 0, MAX_MSG_VALUE);
        _externalBridgeDestinationCall(
            _encodeHookData(messageId, _msgValue),
            _msgValue
        );

        bool verified = ism.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
        assertEq(address(ism).balance, 0);
        assertEq(address(testRecipient).balance, _msgValue);

        // send more value to the ISM
        vm.deal(address(ism), _msgValue);

        // verified still true
        verified = ism.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
        // value which was already sent
        assertEq(address(ism).balance, _msgValue);
        assertEq(address(testRecipient).balance, _msgValue);
    }

    function test_verify_override_msgValue() public virtual {
        bytes memory encodedHookData = _encodeHookData(messageId, MSG_VALUE);

        _externalBridgeDestinationCall(encodedHookData, MSG_VALUE);

        vm.expectRevert("AbstractMessageIdAuthorizedIsm: invalid msg.value");
        _externalBridgeDestinationCall(encodedHookData, 0);

        assertTrue(ism.verify(new bytes(0), encodedMessage));
        assertEq(address(testRecipient).balance, MSG_VALUE);
    }

    function test_verify_false_arbitraryCall() public virtual {
        bytes memory incorrectCalldata = _encodeExternalDestinationBridgeCall(
            address(hook),
            address(this),
            0,
            messageId
        );

        vm.expectRevert();
        ism.verify(incorrectCalldata, encodedMessage);
        assertFalse(ism.isVerified(encodedMessage));
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            originMailbox.buildOutboundMessage(
                DESTINATION_DOMAIN,
                TypeCasts.addressToBytes32(address(testRecipient)),
                testMessage
            );
    }

    function _encodeHookData(
        bytes32 _messageId,
        uint256 _msgValue
    ) internal pure returns (bytes memory) {
        return
            abi.encodeCall(
                AbstractMessageIdAuthorizedIsm.preVerifyMessage,
                (_messageId, _msgValue)
            );
    }

    // wrapper function needed for _externalBridgeDestinationCall because try catch cannot call an internal function
    function externalBridgeDestinationCallWrapper(
        bytes memory _encodedHookData,
        uint256 _msgValue
    ) external {
        _externalBridgeDestinationCall(_encodedHookData, _msgValue);
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

    function _setExternalOriginSender(
        address _sender
    ) internal virtual returns (bytes memory) {}

    receive() external payable {}

    // meant to be mock an arbitrary successful call made by the external bridge
    function preVerifyMessage(bytes32 /*messageId*/) public payable {}
}
