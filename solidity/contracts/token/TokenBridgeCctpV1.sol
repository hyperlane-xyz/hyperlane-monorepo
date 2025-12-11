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
        if (circleBurnSender != hyperlaneMessage.sender())
            revert InvalidBurnSender();

        bytes calldata tokenMessage = hyperlaneMessage.body();

        if (TokenMessage.amount(tokenMessage) != burnMessage._getAmount())
            revert InvalidMintAmount();

        if (
            TokenMessage.recipient(tokenMessage) !=
            burnMessage._getMintRecipient()
        ) revert InvalidMintRecipient();
    }

    function _validateHookMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal pure override {
        bytes32 circleMessageId = cctpMessage._messageBody().index(0, 32);
        if (circleMessageId != hyperlaneMessage.id()) revert InvalidMessageId();
    }

    /// @inheritdoc IMessageHandler
    function handleReceiveMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata body
    ) external override returns (bool) {
        return
            _receiveMessageId({
                circleSource: sourceDomain,
                circleSender: sender,
                messageId: abi.decode(body, (bytes32))
            });
    }

    function _sendMessageIdToIsm(
        uint32 destinationDomain,
        bytes32 ism,
        bytes32 messageId
    ) internal override {
        IMessageTransmitter(messageTransmitter).sendMessage({
            destinationDomain: destinationDomain,
            recipient: ism,
            messageBody: abi.encode(messageId)
        });
    }

    function _bridgeViaCircle(
        uint32 circleDomain,
        bytes32 _recipient,
        uint256 _amount,
        // not used for CCTP V1
        uint256 /*_maxFee*/,
        bytes32 /*_ism*/
    ) internal override {
        ITokenMessengerV1(address(tokenMessenger)).depositForBurn({
            amount: _amount,
            destinationDomain: circleDomain,
            mintRecipient: _recipient,
            burnToken: address(wrappedToken)
        });
    }
}
