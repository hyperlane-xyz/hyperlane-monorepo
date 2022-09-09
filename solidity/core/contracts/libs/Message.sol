// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "./TypeCasts.sol";

/**
 * @title Message Library
 * @author Celo Labs Inc.
 * @notice Library for formatted messages used by Outbox and Replica.
 **/
library Message {
    using TypeCasts for bytes32;

    /**
     * @notice Returns formatted (packed) message with provided fields
     * @dev This function should only be used in memory message construction.
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
        bytes calldata _messageBody
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
     * @dev hash of abi packed message and leaf index.
     * @param _message Raw bytes of message contents.
     * @param _leafIndex Index of the message in the tree
     * @return Leaf (hash) of formatted message
     */
    function hash(
        bytes calldata _message,
        uint256 _leafIndex,
        bytes32 _originMailbox,
        uint8 _version
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(_message, _leafIndex, _originMailbox, _version)
            );
    }

    function origin(bytes calldata _message) internal pure returns (uint32) {
        return uint32(bytes4(_message[0:4]));
    }

    function sender(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[4:36]);
    }

    function senderAddress(bytes calldata _message)
        internal
        pure
        returns (address)
    {
        return sender(_message).bytes32ToAddress();
    }

    function destination(bytes calldata _message)
        internal
        pure
        returns (uint32)
    {
        return uint32(bytes4(_message[36:40]));
    }

    function recipient(bytes calldata _message)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(_message[40:72]);
    }

    function recipientAddress(bytes calldata _message)
        internal
        pure
        returns (address)
    {
        return recipient(_message).bytes32ToAddress();
    }

    function body(bytes calldata _message)
        internal
        pure
        returns (bytes calldata)
    {
        return bytes(_message[72:]);
    }
}
