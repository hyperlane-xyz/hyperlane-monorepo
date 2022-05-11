// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {TypeCasts} from "./TypeCasts.sol";

// if body is 0 bytes, message is only 1 word long
struct MessageFingerprint {
    bytes28 sender;
    uint32 origin;
}

// 1 word long
struct MessageHeader {
    bytes28 recipient;
    uint32 destination;
}

// if body is 0 bytes, message is only 2 words long
struct MessageType {
    MessageHeader header;
    MessageFingerprint fingerprint;
    bytes body;  // do this last to avoid unnecessary padding
}

/**
 * @title Message Library
 * @author Celo Labs Inc.
 * @notice Library for formatted messages used by Outbox and Replica.
 **/
library Message {
    /**
     * @notice Returns leaf of formatted message with provided fields.
     * @param _message Message to serialize to bytes
     * @param _leafIndex Address of sender as bytes32
     * @return Leaf (hash) of formatted message
     **/
    function messageHash(MessageType calldata _message, uint256 _leafIndex)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encodePacked(
                    _leafIndex,
                    _message.header.recipient,
                    _message.header.destination,
                    _message.fingerprint.sender,
                    _message.fingerprint.origin,
                    _message.body // do this last to avoid unnecessary padding
                )
            );
    }

    function messageHash(MessageHeader calldata _header, uint256 _leafIndex, uint32 origin, bytes calldata body) internal view returns (bytes32) {
        return 
            keccak256(
                abi.encodePacked(
                    _leafIndex,
                    _header.recipient,
                    _header.destination,
                    TypeCasts.addressToBytes28(msg.sender),
                    origin,
                    body
                )
            );
    }

    /// @notice Returns message recipient field as an address
    function senderAddress(MessageFingerprint calldata _fingerprint)
        internal
        pure
        returns (address)
    {
        return TypeCasts.bytes28ToAddress(_fingerprint.sender);
    }

    /// @notice Returns message recipient field as an address
    function senderAddress(MessageType calldata _message)
        internal
        pure
        returns (address)
    {
        return senderAddress(_message.fingerprint);
    }

    /// @notice Returns message recipient field as an address
    function recipientAddress(MessageHeader calldata _header)
        internal
        pure
        returns (address)
    {
        return TypeCasts.bytes28ToAddress(_header.recipient);
    }

    /// @notice Returns message recipient field as an address
    function recipientAddress(MessageType calldata _message)
        internal
        pure
        returns (address)
    {
        return recipientAddress(_message.header);
    }

    function leaf(MessageType calldata _message, uint256 _leafIndex)
        internal
        pure
        returns (bytes32)
    {
        return messageHash(_message, _leafIndex);
    }
}
