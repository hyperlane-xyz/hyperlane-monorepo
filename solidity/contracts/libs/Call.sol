// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

library CallLib {
    struct StaticCall {
        address to;
        bytes data;
    }

    struct Call {
        address to;
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
        return Address.functionCallWithValue(_call.to, _call.data, _call.value);
    }

    function staticcall(StaticCall memory _call)
        internal
        view
        returns (bytes memory)
    {
        return Address.functionStaticCall(_call.to, _call.data);
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

    function multicallto(bytes[] memory calls, address target) internal {
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            Address.functionCall(target, calls[i]);
            unchecked {
                ++i;
            }
        }
    }

    function build(
        address to,
        uint256 value,
        bytes memory data
    ) internal pure returns (Call memory) {
        return Call({to: to, value: value, data: data});
    }

    function build(address to, bytes memory data)
        internal
        pure
        returns (StaticCall memory)
    {
        return StaticCall({to: to, data: data});
    }

    function build(
        address to,
        bytes memory data,
        bytes memory callback
    ) internal pure returns (StaticCallWithCallback memory) {
        return
            StaticCallWithCallback({
                callback: callback,
                _call: build(to, data)
            });
    }
}
