// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenBridgeCctpBase} from "./TokenBridgeCctpBase.sol";
import {TypedMemView} from "./../libs/TypedMemView.sol";
import {Message} from "./../libs/Message.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {CctpMessage, BurnMessage} from "../libs/CctpMessage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMessageHandler} from "../interfaces/cctp/IMessageHandler.sol";
import {ITokenMessenger} from "../interfaces/cctp/ITokenMessenger.sol";
import {IMessageTransmitter} from "../interfaces/cctp/IMessageTransmitter.sol";

// TokenMessage.metadata := uint8 cctpNonce
uint256 constant CCTP_TOKEN_BRIDGE_MESSAGE_LEN = TokenMessage.METADATA_OFFSET +
    8;

// @dev Supports only CCTP V1
contract TokenBridgeCctpV1 is TokenBridgeCctpBase, IMessageHandler {
    using CctpMessage for bytes29;
    using BurnMessage for bytes29;
    using TypedMemView for bytes29;

    using Message for bytes;
    using TypeCasts for bytes32;

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        address _messageTransmitter,
        address _tokenMessenger
    )
        TokenBridgeCctpBase(
            _erc20,
            _scale,
            _mailbox,
            _messageTransmitter,
            _tokenMessenger
        )
    {}

    function _getCCTPVersion() internal pure override returns (uint32) {
        return 0;
    }

    function _getCircleRecipient(
        bytes29 cctpMessage
    ) internal view override returns (address) {
        return cctpMessage._recipient().bytes32ToAddress();
    }

    function _getCircleNonce(
        bytes29 cctpMessage
    ) internal view override returns (bytes32) {
        bytes32 sourceAndNonceHash = keccak256(
            abi.encodePacked(cctpMessage._sourceDomain(), cctpMessage._nonce())
        );
        return sourceAndNonceHash;
    }

    function _validateTokenMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal view override {
        bytes29 burnMessage = cctpMessage._messageBody();
        burnMessage._validateBurnMessageFormat();

        bytes32 circleBurnSender = burnMessage._getMessageSender();
        require(
            circleBurnSender == hyperlaneMessage.sender(),
            "Invalid burn sender"
        );

        bytes calldata tokenMessage = hyperlaneMessage.body();
        _validateMessageLength(tokenMessage);

        require(
            uint64(bytes8(TokenMessage.metadata(tokenMessage))) ==
                cctpMessage._nonce(),
            "Invalid nonce"
        );

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
        bytes32 circleSender = cctpMessage._sender();
        require(
            circleSender == _mustHaveRemoteRouter(hyperlaneMessage.origin()),
            "Invalid circle sender"
        );

        bytes32 circleMessageId = cctpMessage._messageBody().index(0, 32);
        require(circleMessageId == hyperlaneMessage.id(), "Invalid message id");
    }

    /// @inheritdoc IMessageHandler
    function handleReceiveMessage(
        uint32 /*sourceDomain*/,
        bytes32 /*sender*/,
        bytes calldata /*body*/
    ) external override returns (bool) {
        require(
            msg.sender == address(messageTransmitter),
            "Invalid message transmitter"
        );
        return true;
    }

    function _sendCircleMessage(
        uint32 destinationDomain,
        bytes32 recipientAndCaller,
        bytes memory messageBody
    ) internal override {
        IMessageTransmitter(messageTransmitter).sendMessageWithCaller(
            destinationDomain,
            recipientAndCaller,
            recipientAndCaller,
            messageBody
        );
    }

    function _validateMessageLength(bytes memory _tokenMessage) internal pure {
        require(
            _tokenMessage.length == CCTP_TOKEN_BRIDGE_MESSAGE_LEN,
            "Invalid message body length"
        );
    }

    function _beforeDispatch(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    )
        internal
        virtual
        override
        returns (uint256 dispatchValue, bytes memory message)
    {
        dispatchValue = _chargeSender(destination, recipient, amount);

        uint32 circleDomain = hyperlaneDomainToCircleDomain(destination);

        uint64 nonce = ITokenMessenger(tokenMessenger).depositForBurn(
            amount,
            circleDomain,
            recipient,
            address(wrappedToken)
        );

        message = TokenMessage.format(
            recipient,
            _outboundAmount(amount),
            abi.encodePacked(nonce)
        );
        _validateMessageLength(message);
    }
}
