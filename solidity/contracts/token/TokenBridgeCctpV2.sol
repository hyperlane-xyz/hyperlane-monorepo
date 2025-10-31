// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenBridgeCctpBase} from "./TokenBridgeCctpBase.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";
import {TypedMemView} from "./../libs/TypedMemView.sol";
import {Message} from "./../libs/Message.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {CctpMessageV2, BurnMessageV2} from "../libs/CctpMessageV2.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMessageHandlerV2} from "../interfaces/cctp/IMessageHandlerV2.sol";
import {ITokenMessengerV2} from "../interfaces/cctp/ITokenMessengerV2.sol";
import {IMessageTransmitterV2} from "../interfaces/cctp/IMessageTransmitterV2.sol";

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
        require(_maxFeeBps < 10_000, "maxFeeBps must be less than 100%");
        maxFeeBps = _maxFeeBps;
        minFinalityThreshold = _minFinalityThreshold;
    }

    // ============ TokenRouter overrides ============

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to indicate v2 fees.
     *
     * Hyperlane uses a "minimum amount out" approach where users specify the exact amount
     * they want the recipient to receive on the destination chain. This provides a better
     * UX by guaranteeing predictable outcomes regardless of underlying bridge fee structures.
     *
     * However, some underlying bridges like CCTP charge fees as a percentage of the input
     * amount (amountIn), not the output amount. This requires "reversing" the fee calculation:
     * we need to determine what input amount (after fees are deducted) will result in the
     * desired output amount reaching the recipient.
     *
     * The formula solves for the fee needed such that after Circle takes their percentage,
     * the recipient receives exactly `amount`:
     *
     *   (amount + fee) * (10_000 - maxFeeBps) / 10_000 = amount
     *
     * Solving for fee:
     *   fee = (amount * maxFeeBps) / (10_000 - maxFeeBps)
     *
     * Example: If amount = 100 USDC and maxFeeBps = 10 (0.1%):
     *   fee = (100 * 10) / (10_000 - 10) = 1000 / 9990 ≈ 0.1001 USDC
     *   We deposit 100.1001 USDC, Circle takes 0.1001 USDC, recipient gets exactly 100 USDC.
     */
    function _externalFeeAmount(
        uint32,
        bytes32,
        uint256 amount
    ) internal view override returns (uint256 feeAmount) {
        return (amount * maxFeeBps) / (10_000 - maxFeeBps);
    }

    function _getCCTPVersion() internal pure override returns (uint32) {
        return 1;
    }

    function _getCircleRecipient(
        bytes29 cctpMessage
    ) internal pure override returns (address) {
        return cctpMessage._getRecipient().bytes32ToAddress();
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
        bytes32 circleMessageId = cctpMessage._getMessageBody().index(0, 32);
        require(circleMessageId == hyperlaneMessage.id(), "Invalid message id");
    }

    // @inheritdoc IMessageHandlerV2
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 /*finalityThresholdExecuted*/,
        bytes calldata messageBody
    ) external override returns (bool) {
        return
            _receiveMessageId(
                sourceDomain,
                sender,
                abi.decode(messageBody, (bytes32))
            );
    }

    // @inheritdoc IMessageHandlerV2
    function handleReceiveUnfinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 /*finalityThresholdExecuted*/,
        bytes calldata messageBody
    ) external override returns (bool) {
        return
            _receiveMessageId(
                sourceDomain,
                sender,
                abi.decode(messageBody, (bytes32))
            );
    }

    function _sendMessageIdToIsm(
        uint32 destinationDomain,
        bytes32 ism,
        bytes32 messageId
    ) internal override {
        IMessageTransmitterV2(address(messageTransmitter)).sendMessage(
            destinationDomain,
            ism,
            bytes32(0), // allow anyone to relay
            minFinalityThreshold,
            abi.encode(messageId)
        );
    }

    function _bridgeViaCircle(
        uint32 circleDomain,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _maxFee
    ) internal override {
        ITokenMessengerV2(address(tokenMessenger)).depositForBurn(
            _amount,
            circleDomain,
            _recipient,
            address(wrappedToken),
            bytes32(0), // allow anyone to relay
            _maxFee,
            minFinalityThreshold
        );
    }
}
