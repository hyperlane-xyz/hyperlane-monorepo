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

// TokenMessage.metadata := uint8 cctpNonce
uint256 constant CCTP_TOKEN_BRIDGE_MESSAGE_LEN = TokenMessage.METADATA_OFFSET +
    8;

// @dev Supports only CCTP V2
contract TokenBridgeCctpV2 is TokenBridgeCctpBase, IMessageHandlerV2 {
    using CctpMessageV2 for bytes29;
    using BurnMessageV2 for bytes29;
    using TypedMemView for bytes29;

    using Message for bytes;
    using TypeCasts for bytes32;

    // default to FAST
    // see https://developers.circle.com/cctp/cctp-finality-and-fees#defined-finality-thresholds
    uint32 constant MIN_FINALITY_THRESHOLD = 1000;

    uint256 constant MAX_FEE_BPS = 1;

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
        return 1;
    }

    function _getCircleRecipient(
        bytes29 cctpMessage
    ) internal view override returns (address) {
        return cctpMessage._getRecipient().bytes32ToAddress();
    }

    function _getCircleNonce(
        bytes29 cctpMessage
    ) internal view override returns (bytes32) {
        return cctpMessage._getNonce();
    }

    function _getCircleSource(
        bytes29 cctpMessage
    ) internal view override returns (uint32) {
        return cctpMessage._getSourceDomain();
    }

    function _validateTokenMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal view override {
        bytes29 burnMessage = cctpMessage._getMessageBody();
        burnMessage._validateBurnMessageFormat();

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
    ) internal view override {
        bytes32 circleSender = cctpMessage._getSender();
        require(
            circleSender == _mustHaveRemoteRouter(hyperlaneMessage.origin()),
            "Invalid circle sender"
        );

        bytes32 circleMessageId = cctpMessage._getMessageBody().index(0, 32);
        require(circleMessageId == hyperlaneMessage.id(), "Invalid message id");
    }

    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool) {
        return true;
    }

    /**
     * @notice Handles an incoming unfinalized message from an IReceiverV2
     * @dev Unfinalized messages have finality threshold values less than 2000
     * @param sourceDomain The source domain of the message
     * @param sender The sender of the message
     * @param finalityThresholdExecuted The finality threshold at which the message was attested to
     * @param messageBody The raw bytes of the message body
     * @return success True, if successful; false, if not.
     */
    function handleReceiveUnfinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool) {
        return true;
    }

    function _sendCircleMessage(
        uint32 destinationDomain,
        bytes32 recipientAndCaller,
        bytes memory messageBody
    ) internal override {
        IMessageTransmitterV2(messageTransmitter).sendMessage(
            destinationDomain,
            recipientAndCaller,
            recipientAndCaller,
            MIN_FINALITY_THRESHOLD,
            messageBody
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
        // TODO: quote the fee
        uint256 fastFee = (amount * MAX_FEE_BPS) / 10_000;
        dispatchValue = _chargeSender(destination, recipient, amount + fastFee);

        uint32 circleDomain = hyperlaneDomainToCircleDomain(destination);

        ITokenMessengerV2(tokenMessenger).depositForBurn(
            amount,
            circleDomain,
            recipient,
            address(wrappedToken),
            bytes32(0), // allow anyone to relay
            MAX_FEE_BPS,
            MIN_FINALITY_THRESHOLD
        );

        message = TokenMessage.format(recipient, _outboundAmount(amount));
    }
}
