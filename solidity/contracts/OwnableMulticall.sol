// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ External Imports ============

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Call, Result} from "./Call.sol";

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
        uint256 length = calls.length;
        for (uint256 i = 0; i < length; i += 1) {
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

    function _staticcall(Call[] memory calls, bytes[] memory callbacks)
        internal
        view
        returns (Result[] memory resolveCalls)
    {
        uint256 length = calls.length;
        resolveCalls = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            (bool success, bytes memory returnData) = calls[i].to.staticcall(
                calls[i].data
            );
            resolveCalls[i] = Result(
                success,
                bytes.concat(callbacks[i], returnData)
            );
        }
        return resolveCalls;
    }

    function proxyCallBatch(address to, bytes[] memory calls) internal {
        uint256 length = calls.length;
        for (uint256 i = 0; i < length; i += 1) {
            (bool success, bytes memory returnData) = to.call(calls[i]);
            if (!success) {
                assembly {
                    revert(add(returnData, 32), returnData)
                }
            }
        }
    }

    function resolveResults(address to, Result[] memory results) internal {
        for (uint256 i = 0; i < results.length; i += 1) {
            if (results[i].success) {
                (bool success, bytes memory returnData) = to.call(
                    results[i].data
                );
                if (!success) {
                    assembly {
                        revert(add(returnData, 32), returnData)
                    }
                }
            }
        }
    }
}
