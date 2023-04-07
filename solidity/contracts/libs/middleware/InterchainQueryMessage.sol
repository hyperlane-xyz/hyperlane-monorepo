// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {CallLib} from "../Call.sol";

/**
 * Format of message:
 * [   0: 32] Sender address
 * [  32: 64] Message type (left padded with zeroes)
 * [  64:???] Encoded call array
 */
library InterchainQueryMessage {
    uint256 private constant SENDER_OFFSET = 0;
    uint256 private constant TYPE_OFFSET = 32;
    uint256 private constant CALLS_OFFSET = 64;

    enum MessageType {
        QUERY,
        RESPONSE
    }

    /**
     * @notice Parses and returns the query sender from the provided message
     * @param _message The interchain query message
     * @return The query sender as bytes32
     */
    function sender(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[SENDER_OFFSET:TYPE_OFFSET]);
    }

    /**
     * @notice Parses and returns the message type from the provided message
     * @param _message The interchain query message
     * @return The message type (query or response)
     */
    function messageType(bytes calldata _message)
        internal
        pure
        returns (MessageType)
    {
        // left padded with zeroes
        return MessageType(uint8(bytes1(_message[CALLS_OFFSET - 1])));
    }

    /**
     * @notice Returns formatted InterchainQueryMessage, type == QUERY
     * @param _sender The query sender as bytes32
     * @param _calls The sequence of queries to make, with the corresponding
     * response callbacks
     * @return Formatted message body
     */
    function encode(
        bytes32 _sender,
        CallLib.StaticCallWithCallback[] calldata _calls
    ) internal pure returns (bytes memory) {
        return abi.encode(_sender, MessageType.QUERY, _calls);
    }

    /**
     * @notice Returns formatted InterchainQueryMessage, type == QUERY
     * @param _sender The query sender as bytes32
     * @param _to The address of the contract to query
     * @param _data The calldata encoding the query
     * @param _callback The calldata of the callback that will be made on the sender.
     * The return value of the query will be appended.
     * @return Formatted message body
     */
    function encode(
        bytes32 _sender,
        address _to,
        bytes memory _data,
        bytes memory _callback
    ) internal pure returns (bytes memory) {
        CallLib.StaticCallWithCallback[]
            memory _calls = new CallLib.StaticCallWithCallback[](1);
        _calls[0] = CallLib.build(_to, _data, _callback);
        return abi.encode(_sender, MessageType.QUERY, _calls);
    }

    /**
     * @notice Parses and returns the calls and callbacks from the message
     * @param _message The interchain query message, type == QUERY
     * @return _calls The sequence of queries to make with the corresponding
     * response callbacks
     */
    function callsWithCallbacks(bytes calldata _message)
        internal
        pure
        returns (CallLib.StaticCallWithCallback[] memory _calls)
    {
        assert(messageType(_message) == MessageType.QUERY);
        (, , _calls) = abi.decode(
            _message,
            (bytes32, MessageType, CallLib.StaticCallWithCallback[])
        );
    }

    /**
     * @notice Returns formatted InterchainQueryMessage, type == RESPONSE
     * @param _sender The query sender as bytes32
     * @param _calls The sequence of callbacks to make
     * @return Formatted message body
     */
    function encode(bytes32 _sender, bytes[] memory _calls)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(_sender, MessageType.RESPONSE, _calls);
    }

    /**
     * @notice Parses and returns the callbacks from the message
     * @param _message The interchain query message, type == RESPONSE
     * @return _calls The sequence of callbacks to make
     */
    function rawCalls(bytes calldata _message)
        internal
        pure
        returns (bytes[] memory _calls)
    {
        assert(messageType(_message) == MessageType.RESPONSE);
        (, , _calls) = abi.decode(_message, (bytes32, MessageType, bytes[]));
    }
}
