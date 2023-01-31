// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Call} from "./Call.sol";

/*
 * @title OwnableMulticall
 * @dev Allows only only address to execute calls to other contracts
 */
contract OwnableMulticall is OwnableUpgradeable {
    constructor() {
        _transferOwnership(msg.sender);
    }

    function initialize() external initializer {
        _transferOwnership(msg.sender);
    }

    function proxyCalls(Call[] calldata calls) external onlyOwner {
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

    function _call(Call[] memory calls, bytes[] memory callbacks)
        internal
        returns (bytes[] memory resolveCalls)
    {
        resolveCalls = new bytes[](callbacks.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory returnData) = calls[i].to.call(
                calls[i].data
            );
            require(success, "Multicall: call failed");
            resolveCalls[i] = bytes.concat(callbacks[i], returnData);
        }
    }

    function proxyCallBatch(address to, bytes[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; i += 1) {
            (bool success, bytes memory returnData) = to.call(calls[i]);
            if (!success) {
                assembly {
                    revert(add(returnData, 32), returnData)
                }
            }
        }
    }
}
