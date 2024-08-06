// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Mailbox} from "../Mailbox.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";

contract TestMailbox is Mailbox {
    using TypeCasts for bytes32;

    constructor(uint32 _localDomain) Mailbox(_localDomain) {
        _transferOwnership(msg.sender);
    }

    function testHandle(
        uint32 _origin,
        bytes32 _sender,
        bytes32 _recipient,
        bytes calldata _body
    ) external {
        IMessageRecipient(_recipient.bytes32ToAddress()).handle(
            _origin,
            _sender,
            _body
        );
    }

    function buildOutboundMessage(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata body
    ) external view returns (bytes memory) {
        return _buildMessage(destinationDomain, recipientAddress, body);
    }

    function buildInboundMessage(
        uint32 originDomain,
        bytes32 recipientAddress,
        bytes32 senderAddress,
        bytes calldata body
    ) external view returns (bytes memory) {
        return
            Message.formatMessage(
                VERSION,
                nonce,
                originDomain,
                senderAddress,
                localDomain,
                recipientAddress,
                body
            );
    }

    function updateLatestDispatchedId(bytes32 _id) external {
        latestDispatchedId = _id;
    }
}
