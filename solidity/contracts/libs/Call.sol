// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

library CallLib {
    struct Call {
        address to;
        bytes data;
    }

    struct CallWithValue {
        Call _call;
        uint256 value;
    }

    struct CallWithCallback {
        Call _call;
        Call callback;
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

    // mutates callback
    function _call(CallWithCallback memory call)
        internal
        returns (Call memory callback)
    {
        bytes memory returnData = _call(call._call);
        call.callback.data = bytes.concat(call.callback.data, returnData);
        return call.callback;
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

    // mutates callbacks
    function multicall(CallWithCallback[] memory calls)
        internal
        returns (Call[] memory callbacks)
    {
        callbacks = new Call[](calls.length);
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            callbacks[i] = _call(calls[i]);
            unchecked {
                ++i;
            }
        }
    }
}
