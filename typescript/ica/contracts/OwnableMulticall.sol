// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

struct Call {
    address to;
    bytes data;
}

// equivalent to function pointer
struct Callback {
    address to;
    bytes4 selector;
}

/*
 * @title OwnableMulticall
 * @dev Allows only only address to execute calls to other contracts
 */
contract OwnableMulticall is OwnableUpgradeable {
    constructor() {
        _transferOwnership(msg.sender);
    }

    function proxyCalls(Call[] calldata calls) external onlyOwner {
        _proxyCalls(calls);
    }

    function _call(Call[] memory calls, Callback[] memory callbacks)
        internal
        returns (Call[] memory resolvedCalls)
    {
        bool success = false;
        bytes memory returnData;
        for (uint256 i = 0; i < calls.length; i++) {
            (success, returnData) = calls[i].to.call(calls[i].data);
            require(success, "Multicall aggregate: call failed");
            resolvedCalls[i] = Call({
                to: callbacks[i].to,
                data: bytes.concat(callbacks[i].selector, returnData)
            });
        }
    }

    function _proxyCalls(Call[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; i += 1) {
            (bool success, bytes memory returnData) = calls[i].to.call(
                calls[i].data
            );
            if (!success) {
                assembly {
                    revert(add(returnData, 32), returnData)
                }
            }
        }
    }
}
