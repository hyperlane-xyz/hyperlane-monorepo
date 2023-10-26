// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============


import {MetaProxy} from "../../libs/MetaProxy.sol";

/**
 * @title StaticOptimisticWatchers
 * @notice Manages per-domain m-of-n watchers that are used to indicate fraudulent submodules
 */
contract StaticOptimisticWatchers {
    // ============ Public Functions ============

    /**
     * @notice Returns the set of watchers responsible for marking submodules as fraudulent
     * and the number of watchers that must mark a submodule as fraudulent
     */
    function watchersAndThreshold(bytes calldata)
        public
        pure
        returns (address[] memory, uint8)
    {
        return abi.decode(MetaProxy.metadata(), (address[], uint8));
    }
}
