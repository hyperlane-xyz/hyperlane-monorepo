// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {CallLib} from "../Call.sol";

/**
 * Format of metadata:
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

    function sender(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[SENDER_OFFSET:TYPE_OFFSET]);
    }

    function messageType(bytes calldata _message)
        internal
        pure
        returns (MessageType)
    {
        // left padded with zeroes
        return MessageType(uint8(bytes1(_message[CALLS_OFFSET - 1])));
    }

    function format(
        CallLib.StaticCallWithCallback[] calldata _calls,
        bytes32 _sender
    ) internal pure returns (bytes memory) {
        return abi.encode(_sender, MessageType.QUERY, _calls);
    }

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

    function format(bytes[] memory _calls, bytes32 _sender)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(_sender, MessageType.RESPONSE, _calls);
    }

    function rawCalls(bytes calldata _message)
        internal
        pure
        returns (bytes[] memory _calls)
    {
        assert(messageType(_message) == MessageType.RESPONSE);
        (, , _calls) = abi.decode(_message, (bytes32, MessageType, bytes[]));
    }
}
