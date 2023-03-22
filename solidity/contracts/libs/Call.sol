// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {TypeCasts} from "./TypeCasts.sol";

library CallLib {
    struct StaticCall {
        // supporting non EVM targets
        bytes32 to;
        bytes data;
    }

    struct Call {
        // supporting non EVM targets
        bytes32 to;
        uint256 value;
        bytes data;
    }

    struct StaticCallWithCallback {
        StaticCall _call;
        bytes callback;
    }

    function call(Call memory _call)
        internal
        returns (bytes memory returnData)
    {
        return
            Address.functionCallWithValue(
                TypeCasts.bytes32ToAddress(_call.to),
                _call.data,
                _call.value
            );
    }

    function staticcall(StaticCall memory _call)
        private
        view
        returns (bytes memory)
    {
        return
            Address.functionStaticCall(
                TypeCasts.bytes32ToAddress(_call.to),
                _call.data
            );
    }

    function staticcall(StaticCallWithCallback memory _call)
        internal
        view
        returns (bytes memory callback)
    {
        return bytes.concat(_call.callback, staticcall(_call._call));
    }

    function multicall(Call[] memory calls) internal {
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            call(calls[i]);
            unchecked {
                ++i;
            }
        }
    }

    function multistaticcall(StaticCallWithCallback[] memory _calls)
        internal
        view
        returns (bytes[] memory)
    {
        uint256 i = 0;
        uint256 len = _calls.length;
        bytes[] memory callbacks = new bytes[](len);
        while (i < len) {
            callbacks[i] = staticcall(_calls[i]);
            unchecked {
                ++i;
            }
        }
        return callbacks;
    }

    function multicallto(address to, bytes[] memory calls) internal {
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            Address.functionCall(to, calls[i]);
            unchecked {
                ++i;
            }
        }
    }

    function build(bytes32 to, bytes memory data)
        internal
        pure
        returns (StaticCall memory)
    {
        return StaticCall(to, data);
    }

    function build(address to, bytes memory data)
        internal
        pure
        returns (StaticCall memory)
    {
        return build(TypeCasts.addressToBytes32(to), data);
    }

    function build(
        bytes32 to,
        uint256 value,
        bytes memory data
    ) internal pure returns (Call memory) {
        return Call(to, value, data);
    }

    function build(
        address to,
        uint256 value,
        bytes memory data
    ) internal pure returns (Call memory) {
        return Call(TypeCasts.addressToBytes32(to), value, data);
    }

    function build(
        bytes32 to,
        bytes memory data,
        bytes memory callback
    ) internal pure returns (StaticCallWithCallback memory) {
        return StaticCallWithCallback(build(to, data), callback);
    }

    function build(
        address to,
        bytes memory data,
        bytes memory callback
    ) internal pure returns (StaticCallWithCallback memory) {
        return StaticCallWithCallback(build(to, data), callback);
    }
}
