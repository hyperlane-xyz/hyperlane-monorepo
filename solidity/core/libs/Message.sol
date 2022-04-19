// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "@summa-tx/memview-sol/contracts/TypedMemView.sol";

import {TypeCasts} from "./TypeCasts.sol";

/**
 * @title Message Library
 * @author Celo Labs Inc.
 * @notice Library for formatted messages used by Outbox and Replica.
 **/
library Message {
    using TypedMemView for bytes;
    using TypedMemView for bytes29;

    // Number of bytes in formatted message before `body` field
    uint256 internal constant PREFIX_LENGTH = 72;

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
    function origin(bytes29 _message) internal pure returns (uint32) {
        return uint32(_message.indexUint(0, 4));
    }

    /// @notice Returns message's sender field
    function sender(bytes29 _message) internal pure returns (bytes32) {
        return _message.index(4, 32);
    }

    /// @notice Returns message's destination field
    function destination(bytes29 _message) internal pure returns (uint32) {
        return uint32(_message.indexUint(36, 4));
    }

    /// @notice Returns message's recipient field as bytes32
    function recipient(bytes29 _message) internal pure returns (bytes32) {
        return _message.index(40, 32);
    }

    /// @notice Returns message's recipient field as an address
    function recipientAddress(bytes29 _message)
        internal
        pure
        returns (address)
    {
        return TypeCasts.bytes32ToAddress(recipient(_message));
    }

    /// @notice Returns message's body field as bytes29 (refer to TypedMemView library for details on bytes29 type)
    function body(bytes29 _message) internal pure returns (bytes29) {
        return _message.slice(PREFIX_LENGTH, _message.len() - PREFIX_LENGTH, 0);
    }

    function leaf(bytes29 _message, uint256 _leafIndex)
        internal
        view
        returns (bytes32)
    {
        return
            messageHash(
                origin(_message),
                sender(_message),
                destination(_message),
                recipient(_message),
                TypedMemView.clone(body(_message)),
                _leafIndex
            );
    }
}
