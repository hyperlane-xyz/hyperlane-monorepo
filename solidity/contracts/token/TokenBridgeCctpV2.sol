// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenBridgeCctpBase} from "./TokenBridgeCctpBase.sol";
import {TypedMemView} from "./../libs/TypedMemView.sol";
import {Message} from "./../libs/Message.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {CctpMessageV2, BurnMessageV2} from "../libs/CctpMessageV2.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMessageHandlerV2} from "../interfaces/cctp/IMessageHandlerV2.sol";
import {ITokenMessengerV2} from "../interfaces/cctp/ITokenMessengerV2.sol";
import {IMessageTransmitterV2} from "../interfaces/cctp/IMessageTransmitterV2.sol";

// TokenMessage.metadata := null
uint256 constant CCTP_TOKEN_BRIDGE_MESSAGE_LEN = TokenMessage.METADATA_OFFSET;

// @dev Supports only CCTP V2
contract TokenBridgeCctpV2 is TokenBridgeCctpBase, IMessageHandlerV2 {
    using CctpMessageV2 for bytes29;
    using BurnMessageV2 for bytes29;
    using TypedMemView for bytes29;

    using Message for bytes;
    using TypeCasts for bytes32;

    // see https://developers.circle.com/cctp/cctp-finality-and-fees#defined-finality-thresholds
    uint32 public immutable minFinalityThreshold;
    uint256 public immutable maxFeeBps;

    constructor(
        address _erc20,
        address _mailbox,
        IMessageTransmitterV2 _messageTransmitter,
        ITokenMessengerV2 _tokenMessenger,
        uint256 _maxFeeBps,
        uint32 _minFinalityThreshold
    )
        TokenBridgeCctpBase(
            _erc20,
            _mailbox,
            _messageTransmitter,
            _tokenMessenger
        )
    {
        maxFeeBps = _maxFeeBps;
        minFinalityThreshold = _minFinalityThreshold;
    }

    function _getCCTPVersion() internal pure override returns (uint32) {
        return 1;
    }

    function _getCircleRecipient(
        bytes29 cctpMessage
    ) internal pure override returns (address) {
        return cctpMessage._getRecipient().bytes32ToAddress();
    }

    function _getCircleNonce(
        bytes29 cctpMessage
    ) internal pure override returns (bytes32) {
        return cctpMessage._getNonce();
    }

    function _getCircleSource(
        bytes29 cctpMessage
    ) internal pure override returns (uint32) {
        return cctpMessage._getSourceDomain();
    }

    function _validateTokenMessageLength(
        bytes memory tokenMessage
    ) internal pure {
        require(
            tokenMessage.length == CCTP_TOKEN_BRIDGE_MESSAGE_LEN,
            "Invalid message length"
        );
    }

    function _validateTokenMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal pure override {
        bytes29 burnMessage = cctpMessage._getMessageBody();
        burnMessage._validateBurnMessageFormat();

        bytes32 circleBurnSender = burnMessage._getMessageSender();
        require(
            circleBurnSender == hyperlaneMessage.sender(),
            "Invalid burn sender"
        );

        bytes calldata tokenMessage = hyperlaneMessage.body();
        _validateTokenMessageLength(tokenMessage);

        require(
            TokenMessage.amount(tokenMessage) == burnMessage._getAmount(),
            "Invalid mint amount"
        );

        require(
            TokenMessage.recipient(tokenMessage) ==
                burnMessage._getMintRecipient(),
            "Invalid mint recipient"
        );
    }

    function _validateHookMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal view override {
        bytes32 circleSender = cctpMessage._getSender();
        require(
            circleSender == _mustHaveRemoteRouter(hyperlaneMessage.origin()),
            "Invalid circle sender"
        );

        bytes32 circleMessageId = cctpMessage._getMessageBody().index(0, 32);
        require(circleMessageId == hyperlaneMessage.id(), "Invalid message id");
    }

    // @inheritdoc IMessageHandlerV2
    function handleReceiveFinalizedMessage(
        uint32 /*sourceDomain*/,
        bytes32 /*sender*/,
        uint32 /*finalityThresholdExecuted*/,
        bytes calldata /*messageBody*/
    ) external pure override returns (bool) {
        return true;
    }

    // @inheritdoc IMessageHandlerV2
    function handleReceiveUnfinalizedMessage(
        uint32 /*sourceDomain*/,
        bytes32 /*sender*/,
        uint32 /*finalityThresholdExecuted*/,
        bytes calldata /*messageBody*/
    ) external pure override returns (bool) {
        return true;
    }

    function _sendMessageIdToIsm(
        uint32 destinationDomain,
        bytes32 ism,
        bytes32 messageId
    ) internal override {
        IMessageTransmitterV2(address(messageTransmitter)).sendMessage(
            destinationDomain,
            ism,
            ism,
            minFinalityThreshold,
            abi.encode(messageId)
        );
    }

    // TODO: this fee amount goes to Circle, not the configured fee recipient
    function _feeAmount(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) internal view override returns (uint256 feeAmount) {
        return (amount * maxFeeBps) / 10_000;
    }

    // TODO: Consider deduping with v1
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable virtual override returns (bytes32 messageId) {
        uint256 burnAmount = _amount +
            _feeAmount(_destination, _recipient, _amount);

        _transferFromSender(burnAmount);

        uint32 circleDomain = hyperlaneDomainToCircleDomain(_destination);

        ITokenMessengerV2(address(tokenMessenger)).depositForBurn(
            burnAmount,
            circleDomain,
            _recipient,
            address(wrappedToken),
            bytes32(0), // allow anyone to relay
            maxFeeBps,
            minFinalityThreshold
        );

        bytes memory _message = TokenMessage.format(_recipient, burnAmount);
        _validateTokenMessageLength(_message);

        // effects
        emit SentTransferRemote(_destination, _recipient, _amount);

        // interactions
        // TODO: Consider flattening with GasRouter
        messageId = _GasRouter_dispatch(
            _destination,
            msg.value,
            _message,
            address(hook)
        );
    }
}
