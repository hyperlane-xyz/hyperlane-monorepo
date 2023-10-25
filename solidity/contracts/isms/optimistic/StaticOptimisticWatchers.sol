// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============


import {MetaProxy} from "../../libs/MetaProxy.sol";

/**
 * @title StaticAggregationIsm
 * @notice Manages per-domain m-of-n ISM sets that are used to verify
 * interchain messages.
 */
contract StaticOptimisticWatchers {
    // ============ Public Functions ============

    /**
     * @notice Returns the set of ISMs responsible for verifying _message
     * and the number of ISMs that must verify
     * @dev Can change based on the content of _message
     * @return modules The array of ISM addresses
     * @return threshold The number of ISMs needed to verify
     */
    function watchersAndThreshold(bytes calldata)
        public
        view
        returns (address[] memory, uint8)
    {
        return abi.decode(MetaProxy.metadata(), (address[], uint8));
    }
}
