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
    function leaf(bytes calldata _message, uint256 _leafIndex)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(_message, _leafIndex));
    }

    /**
     * @notice Decode raw message bytes into structured message fields.
     * @dev Efficiently slices calldata into structured message fields.
     * @param _message Raw bytes of message contents.
     * @return origin Domain of home chain
     * @return sender Address of sender as bytes32
     * @return destination Domain of destination chain
     * @return recipient Address of recipient on destination chain as bytes32
     * @return body Raw bytes of message body
     */
    function destructure(bytes calldata _message)
        internal
        pure
        returns (
            uint32 origin,
            bytes32 sender,
            uint32 destination,
            bytes32 recipient,
            bytes calldata body
        )
    {
        return (
            uint32(bytes4(_message[0:4])),
            bytes32(_message[4:36]),
            uint32(bytes4(_message[36:40])),
            bytes32(_message[40:72]),
            bytes(_message[72:])
        );
    }

    /**
     * @notice Decode raw message bytes into structured message fields.
     * @dev Efficiently slices calldata into structured message fields.
     * @param _message Raw bytes of message contents.
     * @return origin Domain of home chain
     * @return sender Address of sender as address (bytes20)
     * @return destination Domain of destination chain
     * @return recipient Address of recipient on destination chain as address (bytes20)
     * @return body Raw bytes of message body
     */
    function destructureAddresses(bytes calldata _message)
        internal
        pure
        returns (
            uint32,
            address,
            uint32,
            address,
            bytes calldata
        )
    {
        (
            uint32 _origin,
            bytes32 _sender,
            uint32 destination,
            bytes32 _recipient,
            bytes calldata body
        ) = destructure(_message);
        return (
            _origin,
            _sender.bytes32ToAddress(),
            destination,
            _recipient.bytes32ToAddress(),
            body
        );
    }
}
