// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message, MessageType, MessageHeader} from "../../libs/Message.sol";

contract TestMessage {
    using Message for MessageType;
    using Message for MessageHeader;

    function body(MessageType calldata _message)
        external
        pure
        returns (bytes calldata)
    {
        return _message.body;
    }

    function origin(MessageType calldata _message) external pure returns (uint32) {
        return _message.fingerprint.origin;
    }

    function sender(MessageType calldata _message) external pure returns (bytes32) {
        return _message.fingerprint.sender;
    }

    function destination(MessageType calldata _message)
        external
        pure
        returns (uint32)
    {
        return _message.header.destination;
    }

    function recipient(MessageType calldata _message)
        external
        pure
        returns (bytes32)
    {
        return _message.header.recipient;
    }

    function recipientAddress(MessageType calldata _message)
        external
        pure
        returns (address)
    {
        return _message.header.recipientAddress();
    }

    function leaf(MessageType calldata _message, uint256 _leafIndex)
        external
        pure
        returns (bytes32)
    {
        return _message.leaf(_leafIndex);
    }
}
