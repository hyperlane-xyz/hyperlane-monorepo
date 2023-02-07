// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {CallLib} from "../libs/Call.sol";

/**
 * Format of metadata:
 * [   0: 32] Sender address
 * [   32:64] Call type (left padded with zeroes)
 * [  64:???] Encoded call array
 */
library InterchainCallMessage {
    uint256 private constant SENDER_OFFSET = 0;
    uint256 private constant TYPE_OFFSET = 32;
    uint256 private constant CALLS_OFFSET = 64;

    enum CallType {
        CALL,
        STATIC_CALL,
        STATIC_CALL_WITH_CALLBACK,
        RAW_CALLDATA
    }

    function sender(bytes calldata _message) internal pure returns (bytes32) {
        return bytes32(_message[SENDER_OFFSET:TYPE_OFFSET]);
    }

    function calltype(bytes calldata _message)
        internal
        pure
        returns (CallType)
    {
        // left padded with zeroes
        return CallType(uint8(bytes1(_message[CALLS_OFFSET - 1])));
    }

    function format(CallLib.Call[] calldata _calls, bytes32 _sender)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(_sender, CallType.CALL, _calls);
    }

    function calls(bytes calldata _message)
        internal
        pure
        returns (CallLib.Call[] memory _calls)
    {
        assert(calltype(_message) == CallType.CALL);
        (, , _calls) = abi.decode(
            _message,
            (bytes32, CallType, CallLib.Call[])
        );
    }

    function format(CallLib.StaticCall[] calldata _calls, bytes32 _sender)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(_sender, CallType.STATIC_CALL, _calls);
    }

    function staticCalls(bytes calldata _message)
        internal
        pure
        returns (CallLib.StaticCall[] memory _calls)
    {
        assert(calltype(_message) == CallType.STATIC_CALL);
        (, , _calls) = abi.decode(
            _message,
            (bytes32, CallType, CallLib.StaticCall[])
        );
    }

    function format(
        CallLib.StaticCallWithCallback[] calldata _calls,
        bytes32 _sender
    ) internal pure returns (bytes memory) {
        return abi.encode(_sender, CallType.STATIC_CALL_WITH_CALLBACK, _calls);
    }

    function callsWithCallbacks(bytes calldata _message)
        internal
        pure
        returns (CallLib.StaticCallWithCallback[] memory _calls)
    {
        assert(calltype(_message) == CallType.STATIC_CALL_WITH_CALLBACK);
        (, , _calls) = abi.decode(
            _message,
            (bytes32, CallType, CallLib.StaticCallWithCallback[])
        );
    }

    function format(bytes[] memory _calls, bytes32 _sender)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(_sender, CallType.RAW_CALLDATA, _calls);
    }

    function rawCalls(bytes calldata _message)
        internal
        pure
        returns (bytes[] memory _calls)
    {
        assert(calltype(_message) == CallType.RAW_CALLDATA);
        (, , _calls) = abi.decode(_message, (bytes32, CallType, bytes[]));
    }
}
