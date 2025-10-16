// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenBridgeCctpBase} from "./TokenBridgeCctpBase.sol";
import {TypedMemView} from "./../libs/TypedMemView.sol";
import {Message} from "./../libs/Message.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {CctpMessageV1, BurnMessageV1} from "../libs/CctpMessageV1.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMessageHandler} from "../interfaces/cctp/IMessageHandler.sol";
import {ITokenMessengerV1} from "../interfaces/cctp/ITokenMessenger.sol";
import {IMessageTransmitter} from "../interfaces/cctp/IMessageTransmitter.sol";

// @dev Supports only CCTP V1
contract TokenBridgeCctpV1 is TokenBridgeCctpBase, IMessageHandler {
    using CctpMessageV1 for bytes29;
    using BurnMessageV1 for bytes29;
    using TypedMemView for bytes29;

    using Message for bytes;
    using TypeCasts for bytes32;

    constructor(
        address _erc20,
        address _mailbox,
        IMessageTransmitter _messageTransmitter,
        ITokenMessengerV1 _tokenMessenger
    )
        TokenBridgeCctpBase(
            _erc20,
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
    ) internal pure override returns (address) {
        return cctpMessage._recipient().bytes32ToAddress();
    }

    function _validateTokenMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal pure override {
        bytes29 burnMessage = cctpMessage._messageBody();
        burnMessage._validateBurnMessageFormat();

        bytes32 circleBurnSender = burnMessage._getMessageSender();
        require(
            circleBurnSender == hyperlaneMessage.sender(),
            "Invalid burn sender"
        );

        bytes calldata tokenMessage = hyperlaneMessage.body();

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
    ) internal pure override {
        bytes32 circleMessageId = cctpMessage._messageBody().index(0, 32);
        require(circleMessageId == hyperlaneMessage.id(), "Invalid message id");
    }

    /// @inheritdoc IMessageHandler
    function handleReceiveMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata body
    ) external override returns (bool) {
        _authenticateCircleSender(sourceDomain, sender);
        preVerifyMessage(_messageId(body), 0);
        return true;
    }

    function _messageId(bytes calldata body) internal pure returns (bytes32) {
        return bytes32(body[0:32]);
    }

    function _sendMessageIdToIsm(
        uint32 destinationDomain,
        bytes32 ism,
        bytes32 messageId
    ) internal override {
        IMessageTransmitter(messageTransmitter).sendMessage(
            destinationDomain,
            ism,
            abi.encode(messageId)
        );
    }

    function _bridgeViaCircle(
        uint32 circleDomain,
        bytes32 _recipient,
        uint256 _amount
    ) internal override {
        ITokenMessengerV1(address(tokenMessenger)).depositForBurn(
            _amount,
            circleDomain,
            _recipient,
            address(wrappedToken)
        );
    }
}
