// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "./TypeCasts.sol";

/**
 * @title Message Library
 * @author Celo Labs Inc.
 * @notice Library for formatted messages used by Outbox and Replica.
 **/
library Message {
    /**
     * @notice Returns formatted (packed) message with provided fields
     * @param _originDomain Domain of home chain
     * @param _sender Address of sender as bytes32
     * @param _destinationDomain Domain of destination chain
     * @param _recipient Address of recipient on destination chain as bytes32
     * @param _messageBody Raw bytes of message body
     * @return Formatted message
     **/
    function formatMessage(
        uint32 _originDomain,
        bytes32 _sender,
        uint32 _destinationDomain,
        bytes32 _recipient,
        bytes memory _messageBody
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                _originDomain,
                _sender,
                _destinationDomain,
                _recipient,
                _messageBody
            );
    }

    /**
     * @notice Returns leaf of formatted message with provided fields.
     * @param _origin Domain of home chain
     * @param _sender Address of sender as bytes32
     * @param _destination Domain of destination chain
     * @param _recipient Address of recipient on destination chain as bytes32
     * @param _body Raw bytes of message body
     * @param _leafIndex Index of the message in the tree
     * @return Leaf (hash) of formatted message
     **/
    function messageHash(
        uint32 _origin,
        bytes32 _sender,
        uint32 _destination,
        bytes32 _recipient,
        bytes memory _body,
        uint256 _leafIndex
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    formatMessage(
                        _origin,
                        _sender,
                        _destination,
                        _recipient,
                        _body
                    ),
                    _leafIndex
                )
            );
    }

    /// @notice Returns message's origin field
    function origin(bytes calldata _message) internal pure returns (uint32) {
        return uint32(bytes4(_message[0:4]));
    }

    /// @notice Returns message's sender field
    function sender(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[4:36]);
    }

    /// @notice Returns message's destination field
    function destination(bytes calldata _message)
        internal
        pure
        returns (uint32)
    {
        return uint32(bytes4(_message[36:40]));
    }

    /// @notice Returns message's recipient field as bytes32
    function recipient(bytes calldata _message)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(_message[40:72]);
    }

    /// @notice Returns message's body field
    function body(bytes calldata _message)
        internal
        pure
        returns (bytes memory)
    {
        return _message[72:];
    }

    /// @notice Returns message's recipient field as an address
    function recipientAddress(bytes calldata _message)
        internal
        pure
        returns (address)
    {
        return TypeCasts.bytes32ToAddress(recipient(_message));
    }

    function leaf(bytes calldata _message, uint256 _leafIndex)
        internal
        pure
        returns (bytes32)
    {
        return
            messageHash(
                origin(_message),
                sender(_message),
                destination(_message),
                recipient(_message),
                body(_message),
                _leafIndex
            );
    }
}
