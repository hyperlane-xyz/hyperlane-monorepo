// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {CallLib} from "../libs/Call.sol";

// TODO: optimize call decoding with calldata slicing
library InterchainCallMessage {
    enum Type {
        DEFAULT,
        WITH_VALUE,
        WITH_CALLBACK,
        RAW_CALLDATA
    }

    function calltype(bytes calldata _message) internal pure returns (Type) {
        // left padded with zeroes
        return Type(uint8(bytes1(_message[31])));
    }

    function sender(bytes calldata _message) internal pure returns (address) {
        // left padded from 32-44 with zeroes
        return address(bytes20(_message[44:64]));
    }

    function format(CallLib.Call[] memory calls, address _sender)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(Type.DEFAULT, _sender, calls);
    }

    function defaultCalls(bytes calldata _message)
        internal
        pure
        returns (CallLib.Call[] memory decoded)
    {
        assert(calltype(_message) == Type.DEFAULT);
        (, , decoded) = abi.decode(_message, (Type, address, CallLib.Call[]));
    }

    function format(CallLib.CallWithValue[] memory calls, address _sender)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(Type.WITH_VALUE, _sender, calls);
    }

    function callsWithValue(bytes calldata _message)
        internal
        pure
        returns (CallLib.CallWithValue[] memory decoded)
    {
        assert(calltype(_message) == Type.WITH_VALUE);
        (, , decoded) = abi.decode(
            _message,
            (Type, address, CallLib.CallWithValue[])
        );
    }

    function format(CallLib.CallWithCallback[] memory calls, address _sender)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(Type.WITH_CALLBACK, _sender, calls);
    }

    function callsWithCallback(bytes calldata _message)
        internal
        pure
        returns (CallLib.CallWithCallback[] memory decoded)
    {
        assert(calltype(_message) == Type.WITH_CALLBACK);
        (, , decoded) = abi.decode(
            _message,
            (Type, address, CallLib.CallWithCallback[])
        );
    }

    function format(bytes[] memory calls, address _sender)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(Type.RAW_CALLDATA, _sender, calls);
    }

    function rawCalls(bytes calldata _message)
        internal
        pure
        returns (bytes[] memory decoded)
    {
        assert(calltype(_message) == Type.RAW_CALLDATA);
        (, , decoded) = abi.decode(_message, (Type, address, bytes[]));
    }
}
