// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

contract MockInbox {
    using TypeCasts for bytes32;

    struct PendingMessage {
        uint32 originDomain;
        bytes32 sender;
        bytes32 recipient;
        bytes messageBody;
    }

    mapping(uint256 => PendingMessage) pendingMessages;
    uint256 totalMessages = 0;
    uint256 messageProcessed = 0;

    function addPendingMessage(
        uint32 _originDomain,
        bytes32 _sender,
        bytes32 _recipient,
        bytes memory _messageBody
    ) external {
        pendingMessages[totalMessages] = PendingMessage(
            _originDomain,
            _sender,
            _recipient,
            _messageBody
        );
        totalMessages += 1;
    }

    function processNextPendingMessage() public {
        PendingMessage memory pendingMessage = pendingMessages[
            messageProcessed
        ];

        address recipient = pendingMessage.recipient.bytes32ToAddress();

        IMessageRecipient(recipient).handle(
            // This is completely arbitrary and consumers should not rely
            // on domain handling in the mock mailbox contracts.
            pendingMessage.originDomain,
            pendingMessage.sender,
            pendingMessage.messageBody
        );
        messageProcessed += 1;
    }
}
