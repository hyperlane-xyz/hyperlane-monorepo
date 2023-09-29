// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractOptimisticIsm} from "./AbstractOptimisticIsm.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";

contract StaticOptimisticIsm is AbstractOptimisticIsm {
    // ============ Public Functions ============

    /**
     * @notice Returns the set of watchers responsible for verifying _message
     * and the number of watchers that can declare an ISM fraudulent
     * @dev Hard baked into contract, so we're assuming that watchers will not change nor threshold
     * @return watchers The array of watcher addresses
     * @return threshold The number of watchers needed to declare something fraudulent
     */
    function watchersAndThreshold()
        public
        view
        virtual
        override
        returns (address[] memory, uint8)
    {
        return abi.decode(MetaProxy.metadata(), (address[], uint8));
    }
}
