// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {IMailbox} from "../interfaces/IMailbox.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {TypeCasts} from "../vault/libs/TypeCasts.sol";

/**
 * @title MockMailbox
 * @notice Realistic mock of Hyperlane Mailbox supporting cross-chain message dispatch,
 * automated or manual message delivery, fee quoting, and delivery tracking.
 */
contract MockMailbox is IMailbox {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    uint32 public override localDomain;
    uint256 public defaultQuoteFee = 0;
    uint256 public nonceCounter = 0;

    struct OutboundMessage {
        bytes32 messageId;
        uint32 originDomain;
        bytes32 sender;
        uint32 destinationDomain;
        bytes32 recipient;
        bytes body;
        bool delivered;
    }

    OutboundMessage[] public dispatchedMessages;
    mapping(bytes32 => bool) public override delivered;
    mapping(uint32 => address) public remoteMailboxes;

    bool public autoRelay = false;

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    function setAutoRelay(bool _autoRelay) external {
        autoRelay = _autoRelay;
    }

    function setRemoteMailbox(uint32 _domain, address _remoteMailbox) external {
        remoteMailboxes[_domain] = _remoteMailbox;
    }

    function setDefaultQuoteFee(uint256 _fee) external {
        defaultQuoteFee = _fee;
    }

    function quoteDispatch(
        uint32 /* _destinationDomain */,
        bytes32 /* _recipientAddress */,
        bytes calldata /* _messageBody */
    ) external view override returns (uint256 fee) {
        return defaultQuoteFee;
    }

    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external payable override returns (bytes32 messageId) {
        require(msg.value >= defaultQuoteFee, "Insufficient fee provided");

        nonceCounter++;
        messageId = keccak256(
            abi.encodePacked(
                localDomain,
                _destinationDomain,
                msg.sender,
                _recipientAddress,
                nonceCounter,
                _messageBody
            )
        );

        dispatchedMessages.push(
            OutboundMessage({
                messageId: messageId,
                originDomain: localDomain,
                sender: msg.sender.addressToBytes32(),
                destinationDomain: _destinationDomain,
                recipient: _recipientAddress,
                body: _messageBody,
                delivered: false
            })
        );

        emit Dispatch(msg.sender, _destinationDomain, _recipientAddress, _messageBody);
        emit DispatchId(messageId);

        if (autoRelay) {
            _deliverDirect(dispatchedMessages.length - 1);
        }

        return messageId;
    }

    function deliverMessage(uint256 index) external {
        require(index < dispatchedMessages.length, "Invalid message index");
        OutboundMessage storage msgData = dispatchedMessages[index];
        require(!msgData.delivered, "Message already delivered");

        address remoteMb = remoteMailboxes[msgData.destinationDomain];
        if (remoteMb != address(0) && remoteMb != address(this)) {
            MockMailbox(remoteMb).receiveFromRemote(
                msgData.messageId,
                msgData.originDomain,
                msgData.sender,
                msgData.recipient,
                msgData.body
            );
        } else {
            address recipientAddr = msgData.recipient.bytes32ToAddress();
            IMessageRecipient(recipientAddr).handle(
                msgData.originDomain,
                msgData.sender,
                msgData.body
            );
        }

        msgData.delivered = true;
        delivered[msgData.messageId] = true;
        emit Process(msgData.originDomain, msgData.sender, msgData.recipient.bytes32ToAddress());
        emit ProcessId(msgData.messageId);
    }

    function receiveFromRemote(
        bytes32 messageId,
        uint32 originDomain,
        bytes32 sender,
        bytes32 recipient,
        bytes calldata body
    ) external {
        address recipientAddr = recipient.bytes32ToAddress();
        delivered[messageId] = true;

        IMessageRecipient(recipientAddr).handle(
            originDomain,
            sender,
            body
        );

        emit Process(originDomain, sender, recipientAddr);
        emit ProcessId(messageId);
    }

    function _deliverDirect(uint256 index) internal {
        OutboundMessage storage msgData = dispatchedMessages[index];
        address remoteMb = remoteMailboxes[msgData.destinationDomain];

        if (remoteMb != address(0) && remoteMb != address(this)) {
            MockMailbox(remoteMb).receiveFromRemote(
                msgData.messageId,
                msgData.originDomain,
                msgData.sender,
                msgData.recipient,
                msgData.body
            );
        } else {
            address recipientAddr = msgData.recipient.bytes32ToAddress();
            IMessageRecipient(recipientAddr).handle(
                msgData.originDomain,
                msgData.sender,
                msgData.body
            );
        }

        msgData.delivered = true;
        delivered[msgData.messageId] = true;
    }

    function relayAll() external {
        for (uint256 i = 0; i < dispatchedMessages.length; i++) {
            if (!dispatchedMessages[i].delivered) {
                this.deliverMessage(i);
            }
        }
    }

    function getDispatchedCount() external view returns (uint256) {
        return dispatchedMessages.length;
    }
}
