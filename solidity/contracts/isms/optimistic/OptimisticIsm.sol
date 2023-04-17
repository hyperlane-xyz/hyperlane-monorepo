// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractAggregationIsm} from "../aggregation/AbstractAggregationIsm.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";

/**
 * @title OptimisticIsm
 * @notice Manages n per-domain ISM sets, any 1 of which is required
 * to verify interchain messages
 */
contract OptimisticIsm is AbstractAggregationIsm {
    // ============ Public Functions ============

    /**
     * @notice Returns the set of ISMs responsible for verifying _message
     * and the number of ISMs that must verify
     * @dev Can change based on the content of _message
     * @return modules The array of ISM addresses
     * @return threshold The number of ISMs needed to verify
     */
    function modulesAndThreshold(bytes calldata)
        public
        view
        virtual
        override
        returns (address[] memory, uint8)
    {
        return abi.decode(MetaProxy.metadata(), (address[], uint8));
    }
}
