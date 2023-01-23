// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

library CallLib {
    struct Call {
        address to;
        bytes data;
    }

    struct CallWithValue {
        uint256 value;
        Call _call;
    }

    struct CallWithCallback {
        Call _call;
        bytes callbackdata;
    }

    function _call(Call memory call) internal returns (bytes memory) {
        return Address.functionCall(call.to, call.data);
    }

    function _call(CallWithValue memory call) internal returns (bytes memory) {
        return
            Address.functionCallWithValue(
                call._call.to,
                call._call.data,
                call.value
            );
    }

    function _call(CallWithCallback memory call)
        internal
        returns (bytes memory)
    {
        return bytes.concat(call.callbackdata, _call(call._call));
    }

    function multicall(Call[] memory calls) internal {
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            _call(calls[i]);
            unchecked {
                ++i;
            }
        }
    }

    function multicall(CallWithValue[] memory calls) internal {
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            _call(calls[i]);
            unchecked {
                ++i;
            }
        }
    }

    function multicall(CallWithCallback[] memory calls)
        internal
        returns (bytes[] memory callbacks)
    {
        callbacks = new bytes[](calls.length);
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            callbacks[i] = _call(calls[i]);
            unchecked {
                ++i;
            }
        }
    }

    function multicall(address target, bytes[] memory calls) internal {
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            Address.functionCall(target, calls[i]);
            unchecked {
                ++i;
            }
        }
    }
}
