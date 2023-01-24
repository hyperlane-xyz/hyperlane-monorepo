// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

library CallLib {
    struct Call {
        address to;
        bytes data;
    }

    function _multicall(address to, bytes[] memory calls) internal {
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            Address.functionCall(to, calls[i]);
            unchecked {
                ++i;
            }
        }
    }

    function _multicall(Call[] memory calls) internal {
        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            Address.functionCall(calls[i].to, calls[i].data);
            unchecked {
                ++i;
            }
        }
    }

    function _multicallAndResolve(Call[] memory calls, bytes[] memory callbacks)
        internal
        returns (bytes[] memory resolveCalls)
    {
        // reuse memory
        resolveCalls = callbacks;

        uint256 i = 0;
        uint256 len = calls.length;
        while (i < len) {
            bytes memory returnData = Address.functionCall(
                calls[i].to,
                calls[i].data
            );
            resolveCalls[i] = bytes.concat(callbacks[i], returnData);
            unchecked {
                ++i;
            }
        }
    }
}
